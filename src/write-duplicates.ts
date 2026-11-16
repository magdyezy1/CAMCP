import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {sha256, stable} from './security.js';
import {normalizeAccount} from './scope.js';
import {optional} from './workspace-core.js';
import {openWriteClaims} from './job-repository.js';
import {operationOf} from './review-summary.js';
import {findCreated} from './write-reconciliation.js';
import {pendingUncertainMs, writeStatus} from './write-records.js';
import {fail} from './write-common.js';

/**
 * The guard against creating twice (R2.5 M2, L5-06; owner 2026-11-15: "fail closed on uncertain writes, then reconcile them
 * automatically"). A create whose response was lost may have made its object, and so may one still being sent, so preparing
 * the same create again could make a second one. At prepare, a create identical to one that is uncertain or still being sent
 * is refused (DUPLICATE_OF_UNCERTAIN_WRITE), naming the earlier review and the call that settles it; the override is the
 * `supersedes_review_id` that replaces one review. An identical create that completed in the last ten minutes is a warning,
 * not a refusal: the person may want two. Only a create can make a second object, so an update that repeats itself is never
 * held back.
 */
/** How long after an identical create completed a new prepare of it is warned. */
export const duplicateWarningMs = 10 * 60000;
/**
 * The keys that differ between two prepares of one request (a request id, a session, a client's own idempotency key): they
 * are not part of what the request does, so they do not tell two creates apart.
 */
const perPrepare = new Set(['request_id', 'requestId', 'session_id', 'sessionId', 'idempotency_key', 'idempotencyKey']);
const withoutPerPrepare = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutPerPrepare)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !perPrepare.has(key))
            .map(([key, v]) => [key, withoutPerPrepare(v)]),
        )
      : value;
/**
 * What makes two creates one request: the gateway, the account, the action, and the method, path, query and body the
 * action compiled to (a path carries the parent), without the keys that differ between two prepares. Not the person or the
 * connection: the same create from two members is the same create.
 */
export function requestIdentity(plan: CompiledRequest): string {
  return sha256(
    stable({
      gateway: plan.gateway,
      account: normalizeAccount(plan.gateway, plan.accountId ?? ''),
      action: plan.action,
      method: plan.method,
      path: plan.path,
      query: withoutPerPrepare(plan.query),
      body: withoutPerPrepare(plan.body),
    }),
  );
}
/** Whether the request creates objects: what the review summary calls a create, or a request that a created lookup can find. */
export const createsObjects = (plan: CompiledRequest): boolean =>
  operationOf(plan).operation === 'create' || findCreated(plan) !== undefined;

/** One earlier create of the same request: its state, and what the reader may be told of it. */
export interface EarlierCreate {
  state: 'executing' | 'uncertain' | 'complete';
  /** Set only for a reader who may read that review: its ID, when it was claimed and the call that settles it. */
  review_id?: string;
  claimed_at?: string;
  next_call?: JsonObject | null;
}
/** The earlier review the reader may read, with the call that moves it on; undefined for a colleague's. */
function readable(store: Store, actor: Actor, id: string): Pick<EarlierCreate, 'review_id' | 'next_call'> | undefined {
  try {
    return {review_id: id, next_call: (writeStatus(store, actor, id).next_call as JsonObject | null) ?? null};
  } catch {
    return undefined;
  }
}
/**
 * The earlier creates of the same request in the workspace: those unresolved (uncertain, or pending: still being sent) and
 * those that completed within ten minutes. A review that a replacement superseded holds nothing unresolved, and `replacing`
 * (the review a prepare says it replaces) is not an earlier create of the new one.
 */
export function earlierCreates(
  store: Store,
  actor: Actor,
  plan: CompiledRequest,
  replacing?: string,
  now = Date.now(),
): {unresolved: EarlierCreate[]; completed: EarlierCreate[]} {
  const identity = requestIdentity(plan),
    unresolved: EarlierCreate[] = [],
    completed: EarlierCreate[] = [];
  for (const claim of openWriteClaims(store, actor.tenantId, now - duplicateWarningMs)) {
    const id = String(claim.key),
      review = id === replacing ? undefined : optional(store, actor.tenantId, 'write_review', id);
    if (!review?.plan || requestIdentity(review.plan) !== identity) continue;
    if (optional(store, actor.tenantId, 'write_reconciliation', id)?.superseded_by) continue;
    const at = Number(claim.created_at);
    if (claim.state === 'complete') {
      // A create the provider reported as failed made nothing.
      let result: JsonObject = {};
      try {
        result = typeof claim.result === 'string' ? JSON.parse(claim.result) : {};
      } catch {}
      if (result.success === false) continue;
    }
    const state =
        claim.state === 'complete'
          ? 'complete'
          : claim.state === 'pending' && now - at < pendingUncertainMs
            ? 'executing'
            : 'uncertain',
      named = readable(store, actor, id);
    (state === 'complete' ? completed : unresolved).push({
      state,
      ...(named
        ? {
            review_id: named.review_id,
            claimed_at: new Date(at).toISOString(),
            ...(state === 'complete' ? {} : {next_call: named.next_call}),
          }
        : {}),
    });
  }
  return {unresolved, completed};
}
/** The refusal of a prepare that would repeat an unresolved create: it names the earlier review it may, and what to do. */
export function refuseRepeatedCreate(unresolved: EarlierCreate[]): never {
  const named = unresolved.find(u => u.review_id) ?? unresolved[0]!;
  fail(
    'DUPLICATE_OF_UNCERTAIN_WRITE',
    'An identical create is already uncertain or still being sent, so this one could make a second object. ' +
      (named.review_id
        ? 'Settle that review first (next_call): read its status, or reconcile it with read-only lookups. If it was not applied, prepare this request again with supersedes_review_id set to its review_id; if it was applied, accept that.'
        : 'It belongs to a colleague: ask them, or the workspace owner, to settle it. Nothing was prepared or sent.'),
    {
      earlier_state: named.state,
      ...(named.review_id
        ? {earlier_review_id: named.review_id, earlier_claimed_at: named.claimed_at, next_call: named.next_call}
        : {readable: false}),
      unresolved: unresolved.length,
    },
    409,
  );
}
/** The warning a prepare carries when an identical create completed in the last ten minutes. */
export function repeatedCreateWarning(completed: EarlierCreate[]): JsonObject {
  const named = completed.at(-1)!;
  return {
    earlier_state: named.state,
    ...(named.review_id ? {earlier_review_id: named.review_id, claimed_at: named.claimed_at} : {readable: false}),
    message:
      'An identical create completed in the last ten minutes. Executing this review makes a second object. Check with the user that two are wanted before it is executed.',
  };
}
