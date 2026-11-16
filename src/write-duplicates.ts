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
 * those that completed within ten minutes. A review that a replacement superseded holds nothing unresolved, and the reviews in`n * `excluded` (the one a prepare says it replaces; at execute also the review itself) are not earlier creates of this one.
 */
export function earlierCreates(
  store: Store,
  actor: Actor,
  plan: CompiledRequest,
  excluded: readonly (string | undefined)[] = [],
  now = Date.now(),
): {unresolved: EarlierCreate[]; completed: EarlierCreate[]} {
  const identity = requestIdentity(plan),
    skip = new Set(excluded.filter((id): id is string => typeof id === 'string')),
    unresolved: EarlierCreate[] = [],
    completed: EarlierCreate[] = [];
  for (const claim of openWriteClaims(store, actor.tenantId, now - duplicateWarningMs)) {
    const id = String(claim.key),
      review = skip.has(id) ? undefined : optional(store, actor.tenantId, 'write_review', id);
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
export function refuseRepeatedCreate(unresolved: EarlierCreate[], extra: JsonObject = {}): never {
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
      ...extra,
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
/**
 * The guard again at execute (R2.5 M2, lead review S2-1), inside the transaction that takes the claim, so a refusal claims and sends
 * nothing and two executes cannot both pass. A review has a claim only from its execute on, so two identical creates prepared before
 * either was sent were invisible to the guard at prepare. A create is refused when an identical one is unresolved (the earlier review
 * is named, as at prepare), or completed in the last ten minutes when this review carried no warning for it: the person sees the
 * warning first, by preparing again (the refusal's own code, gain its call), and may still want two. The review that replaces an
 * uncertain write is excused for that one, as at prepare.
 */
export function assertCreateNotRepeated(
  store: Store,
  actor: Actor,
  plan: CompiledRequest,
  review: JsonObject,
  reviewId: string,
  again: JsonObject,
): void {
  if (!createsObjects(plan)) return;
  const {unresolved, completed} = earlierCreates(store, actor, plan, [reviewId, review.supersedes_uncertain]);
  if (unresolved.length) refuseRepeatedCreate(unresolved, {submission: 'not_sent'});
  if (completed.length && !review.duplicate_warning)
    fail(
      'DUPLICATE_OF_COMPLETED_WRITE',
      'An identical create completed after this review was prepared, so executing it would make a second object, and the person has not been shown that. Nothing was sent: prepare the request again (next_call); the new review carries the warning, and executing it makes the second object.',
      {...repeatedCreateWarning(completed), submission: 'not_sent', ...again},
      409,
    );
}
