import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport, TransportResult} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {ExecutionPolicy} from './preflight.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError, connectorReadOnly, readOnlyDeployment} from './errors.js';
import {independentlyReadOnly} from './execution-risk.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {nativeAuthority} from './native-authority.js';
import {familyOf, readThroughFamilies} from './reviewed-families.js';
import {verificationReads, normalize, differing, entity} from './verification-reads.js';
import {validateState} from './write-state.js';
import {normalizeSnapshot, reviewStateHash} from './review-state.js';
import {stateRead} from './write-snapshots.js';
import {googleAdsCustomers} from './google-version.js';
import {fingerprint, optional} from './workspace-core.js';
import {ownsRecord} from './actor-identity.js';
import {pendingUncertainMs, retainedReview, writeStatus} from './write-records.js';
import {object} from './write-common.js';

/**
 * Read-only reconciliation of an uncertain reviewed write (WRT-08 Stage B). A write whose response was lost may or
 * may not have been applied; AMCP never sends it again. `reconcile` reads the provider through the review's own
 * connection, guarded like every state read, in two rounds after a minimum delay, and classifies the write:
 *
 * - `appears_applied`: every target holds what was sent (an update or removal), or each created resource is found
 *   (a create, through a family's `findCreated` lookup: Google Ads by name, Meta by name and creation time);
 * - `appears_not_applied`: no target holds it and the reviewed state is unchanged, or no created resource exists;
 * - `indeterminate`: anything else (the reads disagree, the state moved elsewhere, no read contract).
 *
 * The classification is advisory and timestamped: a provider may still apply a request after the reads. Nothing is
 * sent and the idempotency key stays uncertain unless the user accepts "applied", which records the observed result as
 * the review's receipt (so `amcp_campaign verify` and a plan's `reconcile_step` can continue). A review found not
 * applied may be replaced by a new review that records `supersedes_uncertain`; the old one is never sent.
 */
const reconciliationKind = 'write_reconciliation';
/** How long a reconciliation may be acted on (accepted, or replaced) before the provider must be read again. */
export const reconciliationFreshMs = 15 * 60000;
const setting = (name: string, fallback: number, max: number) => {
  const raw = process.env[name],
    value = raw === undefined || raw === '' ? fallback : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= max ? value : fallback;
};
/** The minimum time after the write was claimed before its provider is read (AMCP_WRITE_RECONCILE_DELAY_MS). */
export const reconcileDelayMs = () => setting('AMCP_WRITE_RECONCILE_DELAY_MS', 60000, 3600000);
/** The pause between the two rounds of reads (AMCP_WRITE_RECONCILE_ROUND_MS). */
const roundPauseMs = () => setting('AMCP_WRITE_RECONCILE_ROUND_MS', 2000, 60000);

type Read = (request: CompiledRequest) => Promise<TransportResult>;
/** What a family's lookup of a create returns: the created resources it found, in the order of the request's records. */
export interface CreatedLookup {
  reads: CompiledRequest[];
  /** Matches the responses of `reads` to the request's records; `complete` when the lookup saw everything it asked. */
  match(responses: TransportResult[], submittedAt: number): {found: JsonObject[]; expected: number; complete: boolean};
  /** The receipt a provider would have returned for these resources (what a plan's later steps reference). */
  receipt(found: JsonObject[]): JsonObject;
}
const gaqlText = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 255 && !/['\\\n\r]/.test(v);
const googleCreatable: Record<string, string> = {
  campaigns: 'campaign',
  campaignBudgets: 'campaign_budget',
  adGroups: 'ad_group',
  assetGroups: 'asset_group',
};
/**
 * Google Ads creates of named resources (campaigns, budgets, ad groups, asset groups): one bounded search by the frozen
 * names. Google refuses a duplicate name for these, so one match per name is the created resource.
 */
function googleCreated(plan: CompiledRequest): CreatedLookup | undefined {
  const kind = /\/([A-Za-z]+):mutate$/.exec(plan.path)?.[1],
    resource = kind ? googleCreatable[kind] : undefined,
    operations = object(plan.body).operations;
  if (!resource || !Array.isArray(operations) || !operations.length || operations.some(op => !object(op).create))
    return undefined;
  const names = operations.map(op => object(op).create.name);
  if (!names.every(gaqlText) || new Set(names).size !== names.length) return undefined;
  const id = normalizeAccount(plan.gateway, plan.accountId!);
  const query =
    'SELECT ' +
    resource +
    '.resource_name, ' +
    resource +
    '.name FROM ' +
    resource +
    ' WHERE ' +
    resource +
    '.name IN (' +
    names.map(n => "'" + n + "'").join(', ') +
    ') LIMIT 100';
  return {
    reads: [stateRead(plan, googleAdsCustomers + id + '/googleAds:search', {}, {query}, 'POST')],
    match(responses) {
      const rows = (normalize(object(responses[0]?.data).results ?? []) as JsonObject[]).map(r => object(r[resource]));
      const found = names.map(name => rows.filter(r => r.name === name));
      return {
        expected: names.length,
        complete: !object(responses[0]?.data).nextPageToken,
        found: found.every(list => list.length === 1)
          ? found.map((list, index) => ({index, id: list[0]!.resource_name, name: names[index]}))
          : found.flat().map(r => ({id: r.resource_name, name: r.name})),
      };
    },
    receipt: found => ({results: found.map(f => ({resourceName: f.id}))}),
  };
}
/** Meta campaign, ad set and ad creates: the account's edge filtered by the frozen name, created after the claim. */
function metaCreated(plan: CompiledRequest): CreatedLookup | undefined {
  const match = /^\/(v\d+\.\d+)\/(act_\d+)\/(campaigns|adsets|ads)$/.exec(plan.path),
    name = object(plan.body).name;
  if (!match || plan.method !== 'POST' || typeof name !== 'string' || !name || name.length > 400) return undefined;
  const read = stateRead(plan, '/' + match[1] + '/' + match[2] + '/' + match[3], {
    fields: 'id,name,created_time',
    filtering: JSON.stringify([{field: 'name', operator: 'EQUAL', value: name}]),
    limit: 25,
  });
  return {
    reads: [read],
    match(responses, submittedAt) {
      const data = object(responses[0]?.data),
        rows = (Array.isArray(data.data) ? data.data : []).map(object),
        // A clock skew allowance: the provider stamps creation after AMCP claimed the key.
        recent = rows.filter(r => r.name === name && Date.parse(String(r.created_time)) >= submittedAt - 120000);
      return {
        expected: 1,
        complete: !object(data.paging).next,
        found: recent.map((r, index) => ({index, id: String(r.id), name: r.name, created_time: r.created_time})),
      };
    },
    receipt: found => ({id: found[0]!.id}),
  };
}
/** The created-resource lookups, by family (first two families: Google Ads and Meta). */
export function findCreated(plan: CompiledRequest): CreatedLookup | undefined {
  if (plan.gateway === 'google_ads_native_action') return googleCreated(plan);
  if (plan.gateway === 'meta_native_action') return metaCreated(plan);
  return undefined;
}
/**
 * For an update or removal whose targets the request names, the receipt the provider would have returned, so the
 * verification read contract names what to read and what to expect. Undefined for a create (its identifiers are the
 * provider's to assign) and for a family that verifies through its own receipt.
 */
export function namedTargets(plan: CompiledRequest): JsonObject | undefined {
  const family = familyOf(plan);
  if (family?.verify || family?.verification) return undefined;
  const body = object(plan.body);
  if (plan.gateway === 'google_ads_native_action' && Array.isArray(body.operations) && body.operations.length) {
    const names = body.operations.map((op: JsonObject) => {
      const update = object(op.update);
      return op.create ? undefined : (op.remove ?? update.resourceName ?? update.resource_name);
    });
    return names.every((n: unknown) => typeof n === 'string')
      ? {success: true, data: {results: names.map((resourceName: string) => ({resourceName}))}}
      : undefined;
  }
  if (plan.gateway === 'meta_native_action' && plan.method === 'POST' && /\/\d+$/.test(plan.path))
    return {success: true, data: {id: plan.path.split('/').at(-1)}};
  return undefined;
}
/** A provider failure of a reconciliation read leaves the answer indeterminate; an authority failure is raised. */
const providerFailure = (e: unknown) =>
  e instanceof MirrorError &&
  (typeof e.details.http_status === 'number' ||
    /^(?:UPSTREAM_|PLATFORM_|PROVIDER_|CIRCUIT_OPEN$|TENANT_RATE_LIMIT$|STATE_UNAVAILABLE$|STATE_INCOMPLETE$)/.test(e.code));
function fail(code: string, message: string, details: JsonObject = {}, status = 409): never {
  throw new MirrorError(code, message, details, status);
}
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
    const claim = this.store.db
      .prepare('SELECT state,created_at FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, review.id) as JsonObject | undefined;
    const stalePending = claim?.state === 'pending' && Date.now() - Number(claim.created_at) >= pendingUncertainMs;
    if (claim?.state !== 'uncertain' && !stalePending)
      fail(
        'RECONCILIATION_UNAVAILABLE',
        'Only a write whose outcome is uncertain is reconciled; this one is ' +
          (writeStatus(this.store, actor, review.id).state as string) +
          '. Read its status (next_call).',
        {next_call: {tool: 'amcp_write', arguments: {action: 'status', review_id: review.id}}},
      );
    return {review, plan: review.plan as CompiledRequest, claimedAt: Number(claim!.created_at)};
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
    const lookup = findCreated(plan);
    if (lookup) {
      const responses: TransportResult[] = [];
      for (const request of lookup.reads) responses.push(await read(request));
      const {found, expected, complete} = lookup.match(responses, claimedAt);
      const all = found.length === expected && found.every((f, i) => f.index === i);
      return {
        contract: 'create',
        found: found.map(f => ({id: f.id, ...(f.created_time ? {created_time: f.created_time} : {})})),
        expected,
        complete,
        classification: all ? 'appears_applied' : !found.length && complete ? 'appears_not_applied' : 'indeterminate',
        ...(all ? {observed_ids: found.map(f => f.id), receipt_data: lookup.receipt(found)} : {}),
        reason: all ? 'created_found' : !found.length ? (complete ? 'not_found' : 'lookup_incomplete') : 'ambiguous',
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
      unchanged = reviewStateHash(now) === reviewStateHash(before);
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
      const actual = normalize(entity(item.read, object(response.data)));
      checks.push({id: item.id, matched: differing(normalize(item.expected), actual).length === 0});
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
        'The provider may still be applying this request. Reconcile again in ' +
          Math.ceil(wait / 1000) +
          ' seconds; nothing was read or sent.',
        {retry_after_ms: wait, next_call: {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: id}}},
      );
    const {read, count} = this.reader(actor, review),
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
      checkedAt = Date.now();
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
      ...(last.state_unchanged_since_review !== undefined
        ? {state_unchanged_since_review: last.state_unchanged_since_review}
        : {}),
      ...(classification === 'appears_applied' ? {observed_ids: last.observed_ids, receipt_data: last.receipt_data} : {}),
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
      gateway: plan.gateway,
      account_id: plan.accountId ?? null,
      connection_id: review.connection_id,
    });
    const {receipt_data: _receipt, user_id: _user, updated_at: _updated, ...shown} = record;
    return {
      record_kind: 'write_reconciliation',
      ...shown,
      checked_at: new Date(checkedAt).toISOString(),
      network_requests: count(),
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
      fail('RECONCILIATION_UNAVAILABLE', 'This write was already replaced by review ' + record.superseded_by + '.', {
        superseded_by: record.superseded_by,
      });
    if (record.classification !== classification)
      fail(
        'RECOVERY_NOT_SAFE',
        'The latest reconciliation found this write ' +
          String(record.classification).replaceAll('_', ' ') +
          ', not ' +
          classification.replaceAll('_', ' ') +
          '. Nothing was changed.',
        {classification: record.classification, ...again},
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
      id = review.id as string,
      record = this.latest(actor, id, 'appears_applied', input.reconciliation_id),
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
      const claim = this.store.db
        .prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?')
        .get(actor.tenantId, id) as JsonObject | undefined;
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
