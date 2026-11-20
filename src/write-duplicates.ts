import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {sha256, stable} from './security.js';
import {lookupKey} from './created-agreement.js';
import {normalizeAccount} from './scope.js';
import {optional} from './workspace-core.js';
import {openWriteClaims} from './job-repository.js';
import {createsObjects, findCreated} from './write-reconciliation.js';
import {pendingUncertainMs, supersededBy, writeStatus} from './write-records.js';
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
/**
 * The identity a review is compared by (R2.5 M2, lead re-review 2, merge join 4): the one stored with it at prepare, computed from the
 * caller's request before anything could change its body, never the body of its stored plan. A provider's deduplication key (the
 * refusal package's `dedupeBody`) goes into the body before the review is stored and differs for every review, so an identity
 * recomputed from the stored plan would make two reviews of one request different. A review prepared before the identity was stored
 * has only its plan.
 */
export const identityOf = (review: JsonObject): string =>
  typeof review.request_identity === 'string' && review.request_identity
    ? review.request_identity
    : requestIdentity(review.plan);
// What a create is (the summary calls it one, or a lookup can find it) is the reconciler's, which reads the other creates' answers with it.
export {createsObjects};

/** One earlier create of the same request: its state, and what the reader may be told of it. */
export interface EarlierCreate {
  /** Its review ID, for the guard's own comparisons: never shown (a colleague's review is not named to the reader). */
  id: string;
  state: 'executing' | 'uncertain' | 'complete';
  /**
   * How it is alike: the same request, or only the same object (the kind, the parent and the name as the lookup compares them,
   * R2.5 M2 lead re-review N2). A create that differs in a field its provider does not echo makes the object the first one's lookup
   * finds, so while the first is unresolved the lookups could not tell what each made.
   */
  match: 'identical' | 'same_object';
  /**
   * Whether AMCP can look that create up by reading the provider (a created lookup exists for it). Where it cannot (Snapchat, X,
   * LinkedIn, Microsoft, Reddit, Smart+), reconcile only answers no_read_contract and a replacement needs a reconciliation that
   * found the write not applied, so the earlier create can never be settled by AMCP: only the person, at the provider.
   */
  checkable: boolean;
  /**
   * A create AMCP can look up (`checkable`) whose latest check settles nothing and will not: it found only an object nothing dates (a
   * Meta creative or catalog: `undated_match`, which can be neither accepted nor replaced), or its automatic checks ran out. The refusal
   * then adds the way out of a changed request (lead re-review 2, F2). Never shown as a field: the message carries it.
   */
  stuck: boolean;
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
 * What a create looks for (the keys of its lookup, `lookupKey`), within its provider and account: two creates whose keys meet are
 * looking for the same object. Empty where the create has no lookup, or one that compares by shape.
 */
function createdKeys(plan: CompiledRequest, context?: {state: unknown[]; claimedAt: number}): string[] {
  const account = normalizeAccount(plan.gateway, plan.accountId ?? '');
  return (findCreated(plan, context)?.keys ?? []).map(key => lookupKey(plan.gateway, account, key));
}
/**
 * The earlier creates of the same request in the workspace: those unresolved (uncertain, or pending: still being sent) and
 * those that completed within ten minutes. An unresolved create that looks for the same object is one too, whatever its request. A review that a replacement superseded holds nothing unresolved, and the reviews in
 * `excluded` (the one a prepare says it replaces; at execute also the review itself) are not earlier creates of this one. `identity` is
 * the identity of this request (the caller's at prepare, the one stored with the review at execute: `identityOf`), compared with the
 * stored identity of each earlier review.
 */
export function earlierCreates(
  store: Store,
  actor: Actor,
  plan: CompiledRequest,
  identity: string,
  excluded: readonly (string | undefined)[] = [],
  now = Date.now(),
): {unresolved: EarlierCreate[]; completed: EarlierCreate[]} {
  const mine = new Set(createdKeys(plan)),
    skip = new Set(excluded.filter((id): id is string => typeof id === 'string')),
    unresolved: EarlierCreate[] = [],
    completed: EarlierCreate[] = [];
  for (const claim of openWriteClaims(store, actor.tenantId, now - duplicateWarningMs)) {
    const id = String(claim.key),
      review = skip.has(id) ? undefined : optional(store, actor.tenantId, 'write_review', id);
    if (!review?.plan) continue;
    const identical = identityOf(review) === identity,
      // Only an unresolved create holds another back by its key: a completed one made its object, which the lookups leave out.
      comparable = !identical && claim.state !== 'complete' && mine.size > 0 && review.plan.gateway === plan.gateway;
    if (!identical && !comparable) continue;
    // A review that a replacement seals holds nothing unresolved, while that replacement stands (lead re-review N4): once it was rejected
    // or expired with no claim, the old create may have made its object, and it counts again. A replacement whose claim was only
    // released by a refusal before dispatch still stands: it executes again, and the old review stays out of its way. The seal is checked
    // before the lookup keys of the review's plan are built (lead re-review 2, F6): a sealed review stays uncertain for ever, and the guard
    // runs for every create, inside the write lock at execute.
    const checked = optional(store, actor.tenantId, 'write_reconciliation', id);
    if (supersededBy(store, actor.tenantId, checked, now)) continue;
    if (
      !identical &&
      !createdKeys(review.plan, {
        state: Array.isArray(review.state) ? review.state : [],
        claimedAt: Number(claim.created_at),
      }).some(key => mine.has(key))
    )
      continue;
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
      named = readable(store, actor, id),
      checkable = findCreated(review.plan) !== undefined;
    (state === 'complete' ? completed : unresolved).push({
      id,
      state,
      match: identical ? 'identical' : 'same_object',
      checkable,
      stuck: checkable && (checked?.reason === 'undated_match' || checked?.checks_exhausted === true),
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
  const named = unresolved.find(u => u.review_id) ?? unresolved[0]!,
    lead =
      named.match === 'identical'
        ? 'An identical create is already uncertain or still being sent, so this one could make a second object. '
        : 'A create of the same object (the same name under the same parent) is already uncertain or still being sent, and AMCP could not tell the object each of them made from the other’s, so this one could make a second object. ';
  fail(
    'DUPLICATE_OF_UNCERTAIN_WRITE',
    lead +
      (!named.checkable
        ? // Lead review S3-5: reconcile and a replacement cannot settle this kind of create, so the refusal does not ask for them.
          'AMCP cannot check that kind of create by reading the provider, so it cannot say whether it was applied, and a new review cannot replace it. Check the provider for the object. If it exists, use it and do not create it again; if it does not, change the request (its name, for example): a changed request is a new create and is not held back. Nothing was prepared or sent.'
        : named.review_id
          ? 'Settle that review first (next_call): read its status, or reconcile it with read-only lookups. If it was not applied, prepare this request again with supersedes_review_id set to its review_id; if it was applied, accept that.' +
            (named.stuck
              ? // Lead re-review 2, F2: its latest check found only an object nothing dates, or its checks ran out, so that path may not open.
                ' If its latest check found only an object nothing dates, or its automatic checks ran out, it cannot be settled that way: check the provider for the object yourself. If it exists, use it and do not create it again; if it does not, change the request (its name, for example): a changed request is a new create and is not held back. Nothing was prepared or sent.'
              : '')
          : // Lead re-review N10: only the person who prepared an uncertain write replaces it, and the workspace owner accepts one that was
            // applied (mayResolve), so the message does not send a member to the owner for a replacement the owner cannot make.
            'It belongs to a colleague. Only the person who prepared it can replace it, if it was not applied, and only they or the workspace owner can accept it, if it was applied: ask them. If that cannot be done, change the request (its name, for example): a changed request is a new create and is not held back. Nothing was prepared or sent.'),
    {
      earlier_state: named.state,
      earlier_match: named.match,
      earlier_checkable: named.checkable,
      ...(named.review_id
        ? {
            earlier_review_id: named.review_id,
            earlier_claimed_at: named.claimed_at,
            // Reconcile cannot settle what AMCP cannot look up: the status call shows the review, the person checks the provider.
            next_call: named.checkable
              ? named.next_call
              : {tool: 'amcp_write', arguments: {action: 'status', review_id: named.review_id}},
          }
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
 * warning first, by preparing again (the refusal's own code, with its call), and may still want two. The review that replaces an
 * uncertain write is excused for that one through its seal (a sealed review holds nothing unresolved: `earlierCreates`), which stands while
 * the replacement can still execute (unexpired, or holding a claim that is not rejected: lead re-review N4), so a replacement released by
 * a refusal before dispatch executes again after the cooldown; once the seal ended (rejected, expired) the replacement cannot execute.
 */
export function assertCreateNotRepeated(
  store: Store,
  actor: Actor,
  plan: CompiledRequest,
  review: JsonObject,
  reviewId: string,
  again: JsonObject,
): void {
  // A listing group tree replacement (remove plus create, Google Ads, R2.5 M3 round 2, S4-2) is no create here: its lookup needs the
  // state the review froze, which a removal of a node it has not read refuses, so `createsObjects` is false and the guard returns. It
  // needs none: the replacement names existing node IDs, so a second copy is refused by them (STATE_NOT_FOUND at prepare, STATE_CHANGED
  // at execute), or Google refuses it atomically. A tree of creates only keeps the guard, by identity and by a build's name anchors.
  if (!createsObjects(plan)) return;
  const {unresolved, completed} = earlierCreates(store, actor, plan, identityOf(review), [reviewId]);
  if (unresolved.length) refuseRepeatedCreate(unresolved, {submission: 'not_sent'});
  if (!completed.length) return;
  if (!review.duplicate_warning)
    fail(
      'DUPLICATE_OF_COMPLETED_WRITE',
      'An identical create completed after this review was prepared, so executing it would make a second object, and the person has not been shown that. Nothing was sent: prepare the request again (next_call); the new review carries the warning, and executing it makes the second object.',
      {...repeatedCreateWarning(completed), submission: 'not_sent', ...again},
      409,
    );
  // A warning covers the identical creates it named (lead re-review N9): one that completed since, which it did not name, makes another
  // object the person has not been shown. A twin that left the ten-minute window since is no reason to refuse. A review prepared before the
  // twins were recorded (`duplicate_twins`) covers the one its warning names, and nothing else.
  const warned = new Set<string>(
      Array.isArray(review.duplicate_twins)
        ? review.duplicate_twins.map(String)
        : [review.duplicate_warning.earlier_review_id].filter((id): id is string => typeof id === 'string'),
    ),
    unnamed = completed.filter(twin => !warned.has(twin.id));
  if (unnamed.length)
    fail(
      'DUPLICATE_OF_COMPLETED_WRITE',
      'Another identical create completed after this review was prepared, which its warning did not name, so executing it would make one more object, and the person has not been shown that. Nothing was sent: prepare the request again (next_call); the new review carries the warning for every such create, and executing it makes the extra object.',
      {...repeatedCreateWarning(unnamed), submission: 'not_sent', ...again},
      409,
    );
}
