import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport, TransportResult} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {ExecutionPolicy} from './preflight.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError, connectorReadOnly, readOnlyDeployment} from './errors.js';
import {failWithStatus, type StatusRefusal} from './family-kit.js';
import {independentlyReadOnly} from './execution-risk.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {nativeAuthority} from './native-authority.js';
import {familyOf, readThroughFamilies} from './reviewed-families.js';
import {verificationReads, normalize, differing, entity} from './verification-reads.js';
import {validateState} from './write-state.js';
import {normalizeSnapshot, reviewStateHash, reviewVolatile} from './review-state.js';
import {stateRead} from './write-snapshots.js';
import {fingerprint, optional} from './workspace-core.js';
// Each provider's created-resource lookups and named targets (ARC-01 phase B, wave 4c): its adapter's `writes` hooks.
import {providerHooks} from './provider-hooks.js';
import type {CreatedLookup, CreatedLookupContext, StateReadBuilder} from './provider-adapter.js';
import {ownsRecord} from './actor-identity.js';
import {mayResolve, pendingUncertainMs, reconciliationFreshMs, retainedReview, writeStatus} from './write-records.js';
import {object} from './write-common.js';
import {writeClaim} from './job-repository.js';

/**
 * Read-only reconciliation of an uncertain reviewed write (WRT-08 Stage B). A write whose response was lost may or
 * may not have been applied; AMCP never sends it again. `reconcile` reads the provider through the review's own
 * connection, guarded like every state read, in two rounds after a minimum delay, and classifies the write:
 *
 * - `appears_applied`: every target holds what was sent (an update or removal), or each created resource is found
 *   (a create, through its provider's created lookup, `findCreated`: Google Ads by name and parent, Meta by name and
 *   creation time or by the sets and feeds the review saw, TikTok by name, parent and creation window; R2.5 M2);
 * - `appears_not_applied`: no target holds it and the reviewed state is unchanged, or no created resource exists in a
 *   whole list;
 * - `indeterminate`: anything else (the reads disagree, the state moved elsewhere, no read contract, two matches, a match
 *   nothing dates, a list that is not whole).
 *
 * The classification is advisory and timestamped: a provider may still apply a request after the reads. Nothing is
 * sent and the idempotency key stays uncertain unless the user accepts "applied", which records the observed result as
 * the review's receipt (so `amcp_campaign verify` and a plan's `reconcile_step` can continue). A review found not
 * applied may be replaced by a new review that records `supersedes_uncertain`; the old one is never sent.
 *
 * The check is also the worker's (R2.5 M2, owner 2026-11-15: "fail closed on uncertain writes, then reconcile them
 * automatically"): every write that ends uncertain gets a job (src/write-reconcile-job.ts) that makes these same reads at its
 * claim time plus a minute, again under a cooldown until the write is classified (`automatic`). It changes nothing but the
 * stored classification, which `amcp_write status` and the operations page show. A prepare of a create identical to an
 * uncertain one is refused (src/write-duplicates.ts).
 */
const reconciliationKind = 'write_reconciliation';
// How long a reconciliation may be acted on (accepted, or replaced) before the provider must be read again: defined with
// the retained records (src/write-records.ts), whose status offers the call that acts on it.
export {reconciliationFreshMs};
const setting = (name: string, fallback: number, max: number) => {
  const raw = process.env[name],
    value = raw === undefined || raw === '' ? fallback : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= max ? value : fallback;
};
/** The minimum time after the write was claimed before its provider is read (AMCP_WRITE_RECONCILE_DELAY_MS). */
export const reconcileDelayMs = () => setting('AMCP_WRITE_RECONCILE_DELAY_MS', 60000, 3600000);
/** The pause between the two rounds of reads (AMCP_WRITE_RECONCILE_ROUND_MS). */
const roundPauseMs = () => setting('AMCP_WRITE_RECONCILE_ROUND_MS', 2000, 60000);
/**
 * The worker's own checks of an uncertain write (R2.5 M2, L5-05 and L3-13; owner 2026-11-15: "fail closed on uncertain
 * writes, then reconcile them automatically"): at most this many, each after an unsettled one under a growing cooldown.
 * The first runs at claim + AMCP_WRITE_RECONCILE_DELAY_MS; the last at about an hour and a quarter after it. A decided
 * write (observed applied, or observed not applied) ends them; the person's `reconcile` stays available after the last.
 */
export const reconcileMaxAttempts = 6;
const reconcileCooldownMinutes = [2, 5, 10, 20, 30];
/** The pause after unsettled automatic check number `attempt` (1-based) before the next one. */
export const reconcileCooldownMs = (attempt: number) =>
  reconcileCooldownMinutes[Math.min(Math.max(attempt, 1), reconcileCooldownMinutes.length) - 1]! * 60000;
/** The most batches of reads one observation of a create makes: the first, and a page after it for each list that says more follows. */
const createdLookupPages = 10;
/** A classification that settles what a person is asked next: accept it as applied, or prepare a replacement. */
const decisive = (classification: unknown) =>
  classification === 'appears_applied' || classification === 'appears_not_applied';

/**
 * What the worker records when it cannot check an uncertain write as the person who executed it, because their access, the
 * account or the login is gone, or the check itself is refused: nothing was read, and the check is not tried again. The
 * person's own `reconcile`, or another administrator's, still works. A decided check, or a replacement, is left as it is.
 */
export function recordStoppedCheck(
  store: Store,
  tenant: string,
  reviewId: string,
  attempt: number,
  reason: string,
  code: string,
) {
  const existing = optional(store, tenant, reconciliationKind, reviewId);
  if (existing && (decisive(existing.classification) || existing.superseded_by)) return;
  const at = Date.now(),
    reconciliationId = randomUUID();
  store.putDocument(tenant, reconciliationKind, reviewId, {
    review_id: reviewId,
    reconciliation_id: reconciliationId,
    classification: 'indeterminate',
    reason,
    read_error: code,
    contract: null,
    rounds: 0,
    automatic: true,
    attempts: attempt,
    checks_exhausted: true,
    checked_at: at,
    updated_at: at,
    user_id: null,
  });
  store.appendAudit(tenant, reviewId, {
    event: 'write_reconciliation_stopped',
    review_id: reviewId,
    reconciliation_id: reconciliationId,
    reason,
    code,
    automatic: true,
    attempts: attempt,
  });
}

type Read = (request: CompiledRequest) => Promise<TransportResult>;
// What a provider's lookup of a create returns is the provider contract's (src/provider-adapter.ts); this import path
// keeps the type.
export type {CreatedLookup, CreatedLookupContext};
/**
 * The created-resource lookups, by the write's provider (its adapter's `writes.createdLookup`: Google Ads, Meta and
 * TikTok), whose reads are built as the review builds every state read. `context` is what the review froze and when the
 * write was claimed; a caller with neither (a test of one lookup) gets none and the present time.
 */
export function findCreated(
  plan: CompiledRequest,
  context: CreatedLookupContext = {state: [], claimedAt: Date.now()},
): CreatedLookup | undefined {
  const read: StateReadBuilder = (path, query = {}, body, method = 'GET') => stateRead(plan, path, query, body, method);
  return providerHooks(plan.gateway)?.writes?.createdLookup?.(plan, read, context);
}
/**
 * For an update or removal whose targets the request names, the receipt the provider would have returned, so the
 * verification read contract names what to read and what to expect: its provider's (`writes.namedTargets`: Google
 * Ads' operations, a Meta node edit). Undefined for a create (its identifiers are the provider's to assign), for a
 * family that verifies through its own receipt and for a provider without one.
 */
export function namedTargets(plan: CompiledRequest): JsonObject | undefined {
  const family = familyOf(plan);
  if (family?.verify || family?.verification) return undefined;
  return providerHooks(plan.gateway)?.writes?.namedTargets?.(plan);
}
/** A provider failure of a reconciliation read leaves the answer indeterminate; an authority failure is raised. */
const providerFailure = (e: unknown) =>
  e instanceof MirrorError &&
  (typeof e.details.http_status === 'number' ||
    /^(?:UPSTREAM_|PLATFORM_|PROVIDER_|CIRCUIT_OPEN$|TENANT_RATE_LIMIT$|STATE_UNAVAILABLE$|STATE_INCOMPLETE$)/.test(
      e.code,
    ));
const fail: StatusRefusal = failWithStatus(409);
export class WriteReconciler {
  constructor(
    private store: Store,
    private registry: Registry,
    private transport: NativeTransport,
    private credentials: CredentialProvider,
    private policy: ExecutionPolicy,
  ) {}
  async call(input: JsonObject, actor: Actor): Promise<JsonObject> {
    if (input.accept_applied !== undefined) return this.accept(actor, input);
    if (input.reconciliation_id !== undefined)
      fail('INVALID_ARGUMENT', 'reconciliation_id goes with accept_applied=true.', {field: 'reconciliation_id'}, 400);
    return this.inspect(actor, input.review_id);
  }
  /** The uncertain review a reconciliation reads, or a refusal naming its current state. */
  private uncertain(actor: Actor, reviewId: unknown) {
    if (actor.role === 'reader') throw connectorReadOnly(actor);
    const {review, group} = retainedReview(this.store, actor, reviewId);
    if (group)
      fail('RECONCILIATION_UNAVAILABLE', 'Reconcile each part of a group by its own review_id; status lists them.', {
        next_call: {tool: 'amcp_write', arguments: {action: 'status', review_id: review.id}},
      });
    const claim = writeClaim(this.store, actor.tenantId, review.id);
    const stalePending = claim?.state === 'pending' && Date.now() - Number(claim.created_at) >= pendingUncertainMs;
    if (claim?.state !== 'uncertain' && !stalePending)
      fail(
        'RECONCILIATION_UNAVAILABLE',
        'Only a write whose outcome is uncertain is reconciled, and this one is not (state). Read its status (next_call).',
        {
          state: writeStatus(this.store, actor, review.id).state,
          next_call: {tool: 'amcp_write', arguments: {action: 'status', review_id: review.id}},
        },
      );
    return {review, plan: review.plan as CompiledRequest, claimedAt: Number(claim!.created_at)};
  }
  /** The uncertain review a check reads, or undefined once it is not uncertain any more (accepted, replaced) or is gone. */
  private stillUncertain(actor: Actor, reviewId: string) {
    try {
      return this.uncertain(actor, reviewId);
    } catch (e) {
      if (e instanceof MirrorError && ['RECONCILIATION_UNAVAILABLE', 'NOT_FOUND'].includes(e.code)) return undefined;
      throw e;
    }
  }
  /** One read-only request through the review's own connection, checked before, during and after (as state reads are). */
  private reader(actor: Actor, review: JsonObject): {read: Read; count: () => number} {
    const plan = review.plan as CompiledRequest;
    let count = 0;
    const read: Read = async request => {
      if (!independentlyReadOnly(request) || !request.readOnly)
        fail('RECONCILIATION_UNSUPPORTED', 'A reconciliation read must be independently read-only.', {}, 400);
      const access = (page: CompiledRequest) => {
        this.store.assertActorActive(actor);
        const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, review.connection_id);
        familyOf(plan)?.scope?.(current, false, plan);
        new ScopeGuard(this.registry, this.store).authorize(page, current);
        return current;
      };
      const c = access(request),
        auth = await this.credentials.get(c);
      access(request);
      return readThroughFamilies(request, async page => {
        const current = access(page),
          authority = nativeAuthority(this.store, this.registry, actor, page, current, auth);
        count++;
        const response = await this.transport.request(page, authority(), auth, undefined, {beforeAttempt: authority});
        authority();
        return response;
      });
    };
    return {read, count: () => count};
  }
  /** One round of observation: the targets' current values, the reviewed state, or the created resources. */
  private async observe(review: JsonObject, plan: CompiledRequest, read: Read, claimedAt: number): Promise<JsonObject> {
    const lookup = findCreated(plan, {state: Array.isArray(review.state) ? review.state : [], claimedAt});
    if (lookup) {
      const responses: TransportResult[] = [];
      // A list longer than its page is followed, up to createdLookupPages batches in all: a longer one is not whole, which
      // the lookup's `match` sees from the last answer, so it proves nothing absent.
      let next = lookup.reads;
      for (let batch = 0; next.length && batch < createdLookupPages; batch++) {
        for (const request of next) responses.push(await read(request));
        next = lookup.more?.(responses) ?? [];
      }
      const {found, expected, complete, undated = []} = lookup.match(responses, claimedAt);
      // Applied only when each record has its one dated match and nothing of that name is left that the lookup cannot tell
      // from an older object; absent only when the list was complete and holds nothing of that name at all (R2.5 M2).
      const all = found.length === expected && found.every((f, i) => f.index === i) && !undated.length;
      return {
        contract: 'create',
        found: found.map(f => ({id: f.id, ...(f.created_time ? {created_time: f.created_time} : {})})),
        ...(undated.length ? {undated: undated.map(u => ({id: u.id}))} : {}),
        expected,
        complete,
        classification: all
          ? 'appears_applied'
          : !found.length && !undated.length && complete
            ? 'appears_not_applied'
            : 'indeterminate',
        ...(all ? {observed_ids: found.map(f => f.id), receipt_data: lookup.receipt(found)} : {}),
        reason: all
          ? 'created_found'
          : found.length
            ? 'ambiguous'
            : undated.length
              ? 'undated_match'
              : complete
                ? 'not_found'
                : 'lookup_incomplete',
      };
    }
    const family = familyOf(plan),
      targets = namedTargets(plan);
    // The reviewed state, read again by the review's own reads, when no family reads its state its own way.
    let unchanged: boolean | undefined;
    if (!family?.state && Array.isArray(review.reads) && review.reads.length) {
      const now: unknown[] = [];
      for (const request of review.reads as CompiledRequest[]) {
        const response = await read(request);
        validateState(request, response);
        const own = family?.snapshotValue?.(plan, request, object(response.data));
        now.push(own !== undefined ? own : normalizeSnapshot(request, response.data));
      }
      const before = family?.stateAsRead
        ? review.state
        : (review.state as unknown[]).map((v, i) => normalizeSnapshot(review.reads[i], v));
      unchanged =
        reviewStateHash(now, reviewVolatile(plan.gateway)) === reviewStateHash(before, reviewVolatile(plan.gateway));
    }
    if (!targets)
      return {
        contract: 'none',
        classification: 'indeterminate',
        reason: 'no_read_contract',
        ...(unchanged !== undefined ? {state_unchanged_since_review: unchanged} : {}),
      };
    const items = verificationReads(plan, targets, this.registry, review.state),
      checks: JsonObject[] = [];
    for (const item of items) {
      if (!Object.keys(object(item.expected)).length) continue;
      const response = await read(item.read);
      validateState(item.read, response);
      const volatile = reviewVolatile(plan.gateway),
        actual = normalize(entity(item.read, object(response.data)), volatile);
      checks.push({id: item.id, matched: differing(normalize(item.expected, volatile), actual).length === 0});
    }
    const applied = checks.length > 0 && checks.every(c => c.matched === true);
    return {
      contract: 'update',
      targets: checks,
      ...(unchanged !== undefined ? {state_unchanged_since_review: unchanged} : {}),
      classification: applied
        ? 'appears_applied'
        : unchanged === true && checks.every(c => c.matched === false)
          ? 'appears_not_applied'
          : 'indeterminate',
      reason: applied
        ? 'targets_hold_request'
        : unchanged === true
          ? 'state_unchanged'
          : checks.length
            ? 'state_changed_otherwise'
            : 'no_read_contract',
      ...(applied ? {observed_ids: checks.map(c => c.id), receipt_data: targets.data} : {}),
    };
  }
  async inspect(actor: Actor, reviewId: unknown): Promise<JsonObject> {
    const {review, plan, claimedAt} = this.uncertain(actor, reviewId),
      id = review.id as string,
      wait = reconcileDelayMs() - (Date.now() - claimedAt);
    if (wait > 0)
      fail(
        'RECONCILIATION_TOO_EARLY',
        'The provider may still be applying this request. Reconcile again after retry_after_ms; nothing was read or sent.',
        {
          retry_after_ms: wait,
          retry_after_seconds: Math.ceil(wait / 1000),
          next_call: {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: id}},
        },
      );
    const {record, requests} = await this.check(actor, review, plan, claimedAt),
      classification = record.classification as string,
      reconciliationId = record.reconciliation_id as string;
    const {receipt_data: _receipt, user_id: _user, updated_at: _updated, ...shown} = record;
    return {
      record_kind: 'write_reconciliation',
      ...shown,
      checked_at: new Date(Number(record.checked_at)).toISOString(),
      network_requests: requests,
      mutation_requests: 0,
      suggested_reads: (Array.isArray(review.reads) ? review.reads : []).slice(0, 20).map((r: CompiledRequest) => ({
        method: r.method,
        path: r.path,
      })),
      meaning:
        'Advisory and timestamped: a provider may still apply a request after these reads. Nothing was sent, and the review stays uncertain until the user accepts an outcome.',
      next_call:
        classification === 'appears_applied'
          ? {
              tool: 'amcp_write',
              arguments: {action: 'reconcile', review_id: id, reconciliation_id: reconciliationId},
              add_after_user_approval: {accept_applied: true},
            }
          : classification === 'appears_not_applied' && review.prepare_input
            ? {
                tool: 'amcp_write',
                arguments: {action: 'prepare', ...review.prepare_input, supersedes_review_id: id},
                meaning:
                  'A new review of the same request that replaces this one; it is reviewed and approved like any other.',
              }
            : {
                tool: 'amcp_write',
                arguments: {action: 'reconcile', review_id: id},
                retry_after_ms: reconcileDelayMs() || 60000,
              },
      automatic_retry_of_mutation: false,
    };
  }
  /**
   * Two rounds of read-only observation of an uncertain write, stored as its latest reconciliation and audited; the person's
   * `reconcile` and the worker's check (`automatic`) both make it. A check by the worker also records which attempt it
   * was and, while it settled nothing, when the next one is due (or that the attempts ran out). Nothing is ever sent.
   */
  private async check(
    actor: Actor,
    review: JsonObject,
    plan: CompiledRequest,
    claimedAt: number,
    automatic?: {attempt: number},
  ): Promise<{record: JsonObject; requests: number}> {
    const id = review.id as string,
      {read, count} = this.reader(actor, review),
      rounds: JsonObject[] = [];
    let readError: string | undefined;
    try {
      for (let round = 0; round < 2; round++) {
        if (round) await pause(roundPauseMs());
        rounds.push(await this.observe(review, plan, read, claimedAt));
      }
    } catch (e) {
      if (!providerFailure(e)) throw e;
      readError = (e as MirrorError).code;
    }
    this.store.assertActorActive(actor);
    const consistent = rounds.length === 2 && fingerprint(rounds[0]) === fingerprint(rounds[1]),
      last = rounds.at(-1) ?? {},
      classification = consistent ? (last.classification as string) : 'indeterminate',
      reason = readError ? 'read_failed' : consistent ? last.reason : 'reads_disagree',
      reconciliationId = randomUUID(),
      checkedAt = Date.now(),
      next =
        automatic && !decisive(classification) && automatic.attempt < reconcileMaxAttempts
          ? checkedAt + reconcileCooldownMs(automatic.attempt)
          : undefined;
    const record = {
      review_id: id,
      reconciliation_id: reconciliationId,
      classification,
      reason,
      ...(readError ? {read_error: readError} : {}),
      contract: last.contract ?? null,
      rounds: rounds.length,
      ...(last.targets ? {targets: last.targets} : {}),
      ...(last.found ? {found: last.found, expected: last.expected} : {}),
      ...(last.undated ? {undated: last.undated} : {}),
      ...(last.state_unchanged_since_review !== undefined
        ? {state_unchanged_since_review: last.state_unchanged_since_review}
        : {}),
      ...(classification === 'appears_applied'
        ? {observed_ids: last.observed_ids, receipt_data: last.receipt_data}
        : {}),
      ...(automatic
        ? {
            automatic: true,
            attempts: automatic.attempt,
            ...(next !== undefined ? {next_check_at: next} : decisive(classification) ? {} : {checks_exhausted: true}),
          }
        : {}),
      checked_at: checkedAt,
      updated_at: checkedAt,
      user_id: actor.userId,
    };
    this.store.putDocument(actor.tenantId, reconciliationKind, id, record);
    this.store.appendAudit(actor.tenantId, id, {
      event: 'write_reconciliation_inspected',
      review_id: id,
      reconciliation_id: reconciliationId,
      classification,
      reason,
      ...(automatic ? {automatic: true, attempts: automatic.attempt} : {}),
      gateway: plan.gateway,
      account_id: plan.accountId ?? null,
      connection_id: review.connection_id,
    });
    return {record, requests: count()};
  }
  /**
   * The worker's check of an uncertain write (R2.5 M2): the same reads as `reconcile`, with no waiting here (the job was
   * queued for claim + AMCP_WRITE_RECONCILE_DELAY_MS) and no effect on the review. It records what it observed and, while
   * that is not decisive, when it looks again. A write that is no longer uncertain (accepted, replaced, gone), or whose
   * latest check is decisive and fresh, is left alone: nothing is read. Returns what the job needs to know.
   */
  async automatic(actor: Actor, reviewId: string, attempt: number): Promise<JsonObject> {
    const uncertain = this.stillUncertain(actor, reviewId);
    if (!uncertain) return {review_id: reviewId, status: 'settled', attempts: attempt};
    const {review, plan, claimedAt} = uncertain,
      existing = optional(this.store, actor.tenantId, reconciliationKind, reviewId);
    if (
      existing &&
      (existing.superseded_by ||
        (decisive(existing.classification) && Date.now() - Number(existing.checked_at) <= reconciliationFreshMs))
    )
      return {review_id: reviewId, status: 'settled', attempts: attempt, classification: existing.classification};
    const {record} = await this.check(actor, review, plan, claimedAt, {attempt}),
      next = typeof record.next_check_at === 'number' ? record.next_check_at : undefined;
    return {
      review_id: reviewId,
      status: decisive(record.classification) ? 'classified' : next !== undefined ? 'unsettled' : 'exhausted',
      classification: record.classification,
      reason: record.reason,
      attempts: attempt,
      ...(next !== undefined ? {retry_after_ms: Math.max(1000, next - Date.now())} : {}),
    };
  }
  /** The latest reconciliation of a review, fresh enough to act on, with the classification required. */
  private latest(actor: Actor, id: string, classification: string, reconciliationId?: unknown): JsonObject {
    const record = optional(this.store, actor.tenantId, reconciliationKind, id);
    const again = {next_call: {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: id}}};
    if (!record) fail('RECONCILIATION_REQUIRED', 'Reconcile this write first (next_call); nothing was changed.', again);
    if (reconciliationId !== undefined && record.reconciliation_id !== reconciliationId)
      fail(
        'RECONCILIATION_CHANGED',
        'A newer reconciliation of this write exists. Show the user its result and accept that one.',
        {reconciliation_id: record.reconciliation_id, ...again},
      );
    if (record.superseded_by)
      fail('RECONCILIATION_UNAVAILABLE', 'This write was already replaced by a new review (superseded_by).', {
        superseded_by: record.superseded_by,
      });
    if (record.classification !== classification)
      fail(
        'RECOVERY_NOT_SAFE',
        'The latest reconciliation found a different outcome (classification) than this action needs (required). Nothing was changed.',
        {classification: record.classification, required: classification, ...again},
      );
    if (Date.now() - Number(record.checked_at) > reconciliationFreshMs)
      fail(
        'RECONCILIATION_STALE',
        'This reconciliation is older than 15 minutes. Read the provider again (next_call) before acting on it.',
        again,
      );
    return record;
  }
  /**
   * The user accepts that an uncertain write was applied, as the latest reconciliation observed: its receipt becomes
   * the observed result (reconciled: true). A local change with audit; nothing is sent, and the key is never reset.
   */
  private accept(actor: Actor, input: JsonObject): JsonObject {
    if (!this.policy.allowWrites) throw readOnlyDeployment();
    if (input.accept_applied !== true)
      fail('INVALID_ARGUMENT', 'Set accept_applied: true once the user accepts the observed outcome.', {
        field: 'accept_applied',
      });
    if (typeof input.reconciliation_id !== 'string')
      fail('INVALID_ARGUMENT', 'Send the reconciliation_id the user saw.', {field: 'reconciliation_id'}, 400);
    const {review, plan} = this.uncertain(actor, input.review_id),
      id = review.id as string;
    // Accepting settles the outcome and lets dependent plan steps continue: no wider than execute (the preparing
    // credential or the same person), plus the workspace owner. Other administrators read and reconcile only.
    if (!mayResolve(this.store, actor, review))
      fail(
        'FORBIDDEN',
        'Only the person who prepared this write, or the workspace owner, accepts its outcome.',
        {next_call: {tool: 'amcp_write', arguments: {action: 'status', review_id: id}}},
        403,
      );
    const record = this.latest(actor, id, 'appears_applied', input.reconciliation_id),
      c = this.store.resolveConnection(actor, plan.gateway, plan.accountId, review.connection_id),
      at = Date.now();
    const outcome = {
      success: true,
      executed: true,
      outcome: 'reconciled',
      reconciled: true,
      reconciliation_id: record.reconciliation_id,
      reconciled_at: at,
      observed_ids: record.observed_ids,
      review_id: id,
      action: plan.action,
      fingerprint: review.fingerprint,
      data: record.receipt_data,
      verification: {
        status: 'not_queued',
        next_call: {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: id}},
      },
    };
    this.store.transaction(() => {
      const claim = writeClaim(this.store, actor.tenantId, id);
      if (!['uncertain', 'pending'].includes(String(claim?.state)))
        fail('RECONCILIATION_UNAVAILABLE', 'This write is no longer uncertain. Read its status.', {
          next_call: {tool: 'amcp_write', arguments: {action: 'status', review_id: id}},
        });
      new ScopeGuard(this.registry, this.store).observeCreated(plan, c, record.receipt_data);
      this.store.complete(actor.tenantId, id, outcome, {code: 'RECONCILED'});
      this.store.putDocument(actor.tenantId, reconciliationKind, id, {
        ...Object.fromEntries(Object.entries(record).filter(([k]) => !['id', 'revision'].includes(k))),
        accepted_at: at,
        accepted_by: actor.userId,
        updated_at: at,
      });
      this.store.appendAudit(actor.tenantId, id, {
        event: 'write_reconciled',
        review_id: id,
        reconciliation_id: record.reconciliation_id,
        observed_ids: record.observed_ids,
        actor: actor.userId,
        gateway: plan.gateway,
        account_id: plan.accountId ?? null,
        connection_id: review.connection_id,
      });
    });
    return writeStatus(this.store, actor, id);
  }
  /**
   * The uncertain review a new review replaces: the same person's, reconciled as not applied within 15 minutes, on the
   * same gateway, account and connection. Checked at prepare, before the new review is stored.
   */
  replaceable(actor: Actor, reviewId: unknown, plan: CompiledRequest, connectionId: string): string {
    const {review, plan: old} = this.uncertain(actor, reviewId),
      id = review.id as string;
    if (review.user_id !== actor.userId && !ownsRecord(actor, review))
      fail('FORBIDDEN', 'Only the person who prepared an uncertain write replaces it.', {}, 403);
    this.latest(actor, id, 'appears_not_applied');
    if (
      old.gateway !== plan.gateway ||
      review.connection_id !== connectionId ||
      normalizeAccount(old.gateway, old.accountId ?? '') !== normalizeAccount(plan.gateway, plan.accountId ?? '')
    )
      fail(
        'INVALID_ARGUMENT',
        'A replacement is prepared on the same gateway, account and connection as the write it replaces.',
        {field: 'supersedes_review_id'},
        400,
      );
    return id;
  }
  /** Records that `replacement` replaces the uncertain review `reviewId`; the old review is never sent. */
  supersede(actor: Actor, reviewId: string, replacement: string): void {
    const record = optional(this.store, actor.tenantId, reconciliationKind, reviewId)!,
      review = this.store.document(actor.tenantId, 'write_review', reviewId),
      at = Date.now();
    this.store.putDocument(actor.tenantId, reconciliationKind, reviewId, {
      ...Object.fromEntries(Object.entries(record).filter(([k]) => !['id', 'revision'].includes(k))),
      superseded_by: replacement,
      superseded_at: at,
      updated_at: at,
    });
    this.store.appendAudit(actor.tenantId, reviewId, {
      event: 'write_superseded_uncertain',
      review_id: reviewId,
      superseded_by: replacement,
      actor: actor.userId,
      gateway: review.plan.gateway,
      account_id: review.plan.accountId ?? null,
      connection_id: review.connection_id,
    });
  }
}
