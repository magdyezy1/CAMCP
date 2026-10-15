import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import {audit, bad, fingerprint, optional, read} from './workspace-core.js';
import {reportAllocation} from './report-allocation.js';
import {planRight} from './campaign-inventory.js';
import {zonedMidnight} from './workflows.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

/**
 * DEC-02 outcome review: after a verified allocation execution, what the same entities did over the next comparable
 * closed period, beside what the proposal modeled. Observational only: no forecast accuracy and no causal claim.
 *
 * Outcome window (owner decision P6, the ticket's proposed rule): the plan's reference length (`period_days`), starting
 * on the first account-local day after the last budget step was verified by read-back, so the new budgets were in force
 * all day. The window is complete once its last day has ended in the account time zone; nothing is read before then.
 * The capture repeats the proposal's own guided preset on the same login, account, currency, time zone, attribution and
 * result definition, declared complete only because the window has closed. A provider that has not finalized the window
 * yet (Snapchat) refuses the capture, and the background review tries again later.
 */
export const allocationOutcomeKind = 'allocation_outcome';
/** The guided presets an allocation plan can come from (allocation-plan.ts). */
const qualifiedPresets = ['google_campaign', 'meta_campaign', 'linkedin_campaign', 'snapchat_adsquad'];
/** Outcome records kept per workspace; the oldest finished ones are removed first (pending reviews are kept). */
export const allocationOutcomeLimit = 500;
/** Automatic attempts after the window closed, and the delay before each retry. */
const retryDelays = [3600000, 3 * 3600000, 6 * 3600000, 12 * 3600000, 24 * 3600000, 24 * 3600000];
/**
 * Refusals a later attempt can clear: a provider that has not finalized the window, a window that has not closed in
 * the account time zone yet, a busy review or a rate limit.
 */
const retryCodes = [
  'REPORT_INCOMPLETE',
  'ALLOCATION_OUTCOME_NOT_DUE',
  'ALLOCATION_OUTCOME_BUSY',
  'PLATFORM_RATE_LIMIT',
];
const day = 86400000;
const scale = 1000000000n;

export const allocationOutcomeLimitations = Object.freeze([
  'Observational comparison: realized conversions in the outcome window beside the range the proposal modeled under its own assumptions. It does not show that the budget change caused any difference, and it is not a measure of forecast accuracy.',
  'Seasonality, auctions, creatives, tracking and attribution can differ between the evidence period and the outcome window; nothing here adjusts for them.',
  'Values are as the provider reported them when the outcome was captured; conversions attributed later are not included.',
  'Spend can differ from the proposed budget. The spend-conditioned range applies the same assumptions to the spend that occurred.',
]);
const missingRowsLimitation =
  'At least one entity has no reported rows in the outcome window, so its result stays unknown.';
const partialDaysLimitation =
  'At least one entity has rows on fewer days than the outcome window; days without rows are not counted as zero.';
const calibrationMeaning =
  'The outcome capture is retained guided evidence: a new proposal can use it, and calibrate_allocation can when it covers 14–31 closed days. The realized factor is where realized conversions fell on the efficiency scale the proposal used (1.0 is the evidence period’s conversions per unit of spend).';

const dateText = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => dateText(Date.parse(date + 'T00:00:00Z') + days * day);
/** The calendar date of an instant in `timezone`. */
function localDate(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at),
    part = (type: string) => parts.find(p => p.type === type)!.value;
  return part('year') + '-' + part('month') + '-' + part('day');
}
/**
 * The instant `date` has ended in `timezone`: its next local midnight. Where a transition skips that midnight, noon UTC
 * of the next day is used, by which time the date has ended in every time zone.
 */
function closesAt(date: string, timezone: string) {
  const next = addDays(date, 1);
  try {
    return zonedMidnight(next, timezone, true);
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'AMBIGUOUS_DATE_BOUNDARY') return Date.parse(next + 'T12:00:00Z');
    throw e;
  }
}

/** When every budget step of a completed allocation plan was verified by read-back: the last verification time. */
export function verifiedAllocationExecution(run: JsonObject): {executed_at: number} | {reason: string} {
  if (!run || typeof run !== 'object' || !run.allocation) return {reason: 'not_an_allocation_plan'};
  if (run.state !== 'complete') return {reason: 'plan_not_complete'};
  const steps: JsonObject[] = Array.isArray(run.steps) ? run.steps : [];
  if (
    !steps.length ||
    steps.some(
      s =>
        !s ||
        s.status !== 'verified' ||
        s.verification?.status !== 'verified' ||
        !Number.isSafeInteger(s.verification?.checked_at),
    )
  )
    return {reason: 'steps_not_verified'};
  return {executed_at: Math.max(...steps.map(s => s.verification.checked_at as number))};
}

/** The outcome window of an execution verified at `executedAt` (see the module comment). */
export function allocationOutcomeWindow(executedAt: number, periodDays: number, timezone: string) {
  if (!Number.isSafeInteger(periodDays) || periodDays < 1 || periodDays > 366)
    bad('The allocation plan names no valid reference period.', 'ALLOCATION_OUTCOME_UNQUALIFIED');
  const since = addDays(localDate(executedAt, timezone), 1),
    until = addDays(since, periodDays - 1);
  return {since, until, days: periodDays, timezone, due_at: closesAt(until, timezone)};
}

/** Nonnegative decimal text or number at nine places, rounded half to even (owner decision D10); null when unknown. */
function nine(value: unknown): bigint | null {
  const text =
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value.toFixed(12)
      : typeof value === 'string'
        ? value
        : null;
  const m = text === null ? null : /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const fraction = (m[2] ?? '').padEnd(10, '0'),
    kept = BigInt(m[1]! + fraction.slice(0, 9)),
    first = Number(fraction[9]),
    beyond = /[1-9]/.test(fraction.slice(10));
  return first > 5 || (first === 5 && (beyond || kept % 2n === 1n)) ? kept + 1n : kept;
}
/** n / d at nine places for n ≥ 0 and d > 0, rounded half to even. */
function divide(n: bigint, d: bigint): bigint {
  const q = n / d,
    r = n % d;
  return r * 2n > d || (r * 2n === d && q % 2n === 1n) ? q + 1n : q;
}
function text(n: bigint | null): string | null {
  if (n === null) return null;
  const fraction = (n % scale).toString().padStart(9, '0').replace(/0+$/, '');
  return (n / scale).toString() + (fraction ? '.' + fraction : '');
}
const position = (value: bigint | null, low: bigint | null, high: bigint | null) =>
  value === null || low === null || high === null
    ? 'unknown'
    : value < low
      ? 'below'
      : value > high
        ? 'above'
        : 'within';

/**
 * The proposal a plan was created from, recomputed as of the plan's creation (its evidence was current then) and
 * checked against the plan's bound model and allocation fingerprints, so the outcome is compared with exactly it.
 */
function proposalOf(store: Store, tenant: string, run: JsonObject): {modeled: JsonObject; source: JsonObject} | string {
  const b = run.allocation,
    source = optional(store, tenant, 'decision_report', String(b.report_id));
  if (!source) return 'source_report_deleted';
  if (source.revision !== b.report_revision || source.source_hash !== b.source_hash) return 'source_report_changed';
  if (!qualifiedPresets.includes(source.preset)) return 'preset_unqualified';
  let modeled: JsonObject;
  try {
    modeled = reportAllocation(source, b.options ?? {}, Number(run.created_at));
  } catch (e) {
    if (e instanceof MirrorError) return 'proposal_not_reproducible';
    throw e;
  }
  if (
    modeled.model_fingerprint !== b.model_fingerprint ||
    (b.modeled_allocations_hash !== undefined && fingerprint(modeled.allocations) !== b.modeled_allocations_hash)
  )
    return 'proposal_not_reproducible';
  return {modeled, source};
}
/** What the outcome is compared with: the proposal's per-entity budgets, evidence totals and modeled range. */
function modeledSnapshot(modeled: JsonObject) {
  return {
    model_fingerprint: modeled.model_fingerprint,
    efficiency_low: modeled.assumptions.efficiency_low,
    efficiency_high: modeled.assumptions.efficiency_high,
    factor_provenance: modeled.assumptions.factor_provenance?.kind ?? 'declared',
    evidence_period: {date_from: modeled.semantics.date_from, date_to: modeled.semantics.date_to},
    total_budget: modeled.total_budget,
    entities: (modeled.allocations as JsonObject[]).map(a => ({
      entity_id: a.entity_id,
      name: a.name,
      observed_spend: a.observed_spend,
      observed_conversions: a.observed_conversions,
      proposed_budget: a.proposed_budget,
    })),
  };
}
/** The outcome record a client sees: never the sealed job authority. */
function view(doc: JsonObject, now = Date.now()): JsonObject {
  const {actor_binding: _binding, job_id: _job, revision: _revision, ...shown} = doc,
    due = doc.state === 'scheduled' && Number.isFinite(doc.due_at) && now >= doc.due_at;
  return {
    ...shown,
    record_kind: allocationOutcomeKind,
    state: due ? 'due' : doc.state,
    ...(due || doc.state === 'due'
      ? {next_call: {tool: 'amcp_reporting', arguments: {action: 'capture_allocation_outcome', id: doc.plan_id}}}
      : {}),
    network_requests: 0,
  };
}
/** Keeps at most allocationOutcomeLimit records: the oldest finished reviews are removed first. */
function bound(store: Store, tenant: string) {
  const rows = store.db
    .prepare(
      "SELECT id,json_extract(data,'$.state') AS state FROM documents WHERE tenant_id=? AND kind=? ORDER BY coalesce(json_extract(data,'$.updated_at'),0),id",
    )
    .all(tenant, allocationOutcomeKind) as JsonObject[];
  let excess = rows.length - (allocationOutcomeLimit - 1);
  for (const row of rows) {
    if (excess <= 0) break;
    if (!['complete', 'unavailable'].includes(row.state)) continue;
    store.deleteDocument(tenant, allocationOutcomeKind, String(row.id));
    excess--;
  }
  if (excess > 0)
    bad(
      'This workspace already has ' + allocationOutcomeLimit + ' pending allocation outcome reviews.',
      'ALLOCATION_OUTCOME_LIMIT',
    );
}

/**
 * Records the outcome review of a completed allocation plan once every budget step was verified, and queues it for
 * the moment its window closes (idempotent: an existing record is returned unchanged). A plan that does not qualify
 * records nothing; a proposal that can no longer be reproduced is recorded as unavailable with its reason.
 */
export function scheduleAllocationOutcome(store: Store, actor: Actor, run: JsonObject): JsonObject | undefined {
  const execution = verifiedAllocationExecution(run);
  if (!('executed_at' in execution)) return undefined;
  return store.transaction(() => {
    const existing = optional(store, actor.tenantId, allocationOutcomeKind, run.id);
    if (existing) return existing;
    const b = run.allocation,
      now = Date.now(),
      base = {
        version: 1,
        plan_id: run.id,
        report_id: b.report_id,
        gateway: b.gateway ?? 'google_ads_native_action',
        account_id: b.account_id,
        connection_id: b.connection_id,
        currency: b.currency,
        model_fingerprint: b.model_fingerprint,
        executed_at: execution.executed_at,
        window_rule: 'next_comparable_closed_period',
        created_at: now,
        updated_at: now,
      };
    const proposal = proposalOf(store, actor.tenantId, run);
    let doc: JsonObject;
    if (typeof proposal === 'string') doc = {...base, state: 'unavailable', reason: proposal};
    else {
      const window = allocationOutcomeWindow(execution.executed_at, b.period_days, b.timezone);
      let binding: string | null = null;
      try {
        // The background review runs as the person whose verified execution completed the plan.
        binding = store.bindJobActor(actor, 'allocation-outcome:' + run.id);
      } catch (e) {
        if (!(e instanceof MirrorError) || e.code !== 'ENCRYPTION_REQUIRED') throw e;
      }
      doc = {
        ...base,
        state: 'scheduled',
        preset: proposal.source.preset,
        entity_kind: proposal.modeled.entity_kind,
        ...(proposal.modeled.parent_campaign_id ? {parent_campaign_id: proposal.modeled.parent_campaign_id} : {}),
        window: {since: window.since, until: window.until, days: window.days, timezone: window.timezone},
        due_at: window.due_at,
        modeled: modeledSnapshot(proposal.modeled),
        automatic: binding !== null,
        attempts: 0,
        actor_binding: binding,
      };
    }
    bound(store, actor.tenantId);
    store.putDocument(actor.tenantId, allocationOutcomeKind, run.id, doc);
    if (doc.state === 'scheduled' && doc.automatic) {
      const job = store.enqueue(actor.tenantId, allocationOutcomeKind, {plan_id: run.id}, doc.due_at);
      store.putDocument(actor.tenantId, allocationOutcomeKind, run.id, {...doc, job_id: job});
    }
    audit(store, actor, 'allocation_outcome_scheduled', {
      plan_id: run.id,
      state: doc.state,
      due_at: doc.due_at ?? null,
      ...(doc.reason ? {reason: doc.reason} : {}),
    });
    return store.document(actor.tenantId, allocationOutcomeKind, run.id);
  });
}
/** The campaign runner's hook: never lets outcome bookkeeping fail the save of a plan. */
export function scheduleAllocationOutcomeQuietly(store: Store, actor: Actor, run: JsonObject) {
  if (!run?.allocation || run.state !== 'complete') return;
  try {
    scheduleAllocationOutcome(store, actor, run);
  } catch (e) {
    store.appendAudit(actor.tenantId, randomUUID(), {
      event: 'allocation_outcome_schedule_failed',
      actor: actor.userId,
      plan_id: run.id,
      code: e instanceof MirrorError ? e.code : 'SCHEDULE_FAILED',
    });
  }
}

/** The plan, readable by this actor and still within its current account access. */
function accessiblePlan(store: Store, actor: Actor, planId: string) {
  const run = read(store, actor, 'campaign_run', planId);
  if (!planRight(store, actor, run, 'view')) bad('Campaign plan belongs to another actor.', 'FORBIDDEN');
  if (!run.allocation)
    bad('This campaign plan did not come from an allocation proposal.', 'ALLOCATION_OUTCOME_UNQUALIFIED');
  const b = run.allocation;
  store.resolveConnection(actor, b.gateway ?? 'google_ads_native_action', b.account_id, b.connection_id);
  return run;
}
/** `allocation_outcome`: the review's window, state and, once captured, its results. No provider request. */
export function allocationOutcomeView(store: Store, actor: Actor, planId: string): JsonObject {
  const run = accessiblePlan(store, actor, planId),
    doc =
      optional(store, actor.tenantId, allocationOutcomeKind, run.id) ?? scheduleAllocationOutcome(store, actor, run);
  if (doc) return view(doc);
  const execution = verifiedAllocationExecution(run);
  return {
    record_kind: allocationOutcomeKind,
    plan_id: run.id,
    state: 'not_scheduled',
    reason: 'reason' in execution ? execution.reason : 'not_recorded',
    meaning:
      'The outcome review is scheduled once every budget step of the plan has been executed and verified by read-back.',
    network_requests: 0,
  };
}

/** The guided capture of the outcome window: the proposal's preset and measurement settings, other dates. */
function captureInput(source: JsonObject, window: JsonObject): JsonObject {
  const sem = source.semantics ?? {},
    request = source.source_request ?? {},
    input: JsonObject = {
      action: 'capture_preset',
      preset: source.preset,
      account_id: source.account_id,
      connection_id: source.connection_id,
      semantics: {
        currency: sem.currency,
        timezone: sem.timezone,
        date_from: window.since,
        date_to: window.until,
        attribution: sem.attribution,
        conversion_definition: sem.conversion_definition,
        source_name: ('Allocation outcome · ' + String(sem.source_name ?? source.preset)).slice(0, 200),
        complete: true,
      },
    };
  if (source.preset === 'meta_campaign')
    return {
      ...input,
      result_action_type: sem.conversion_definition,
      attribution_windows: request.query?.action_attribution_windows,
    };
  if (source.preset === 'snapchat_adsquad')
    return {
      ...input,
      campaign_id: request.path_params?.campaign_id,
      swipe_up_attribution_window: request.query?.swipe_up_attribution_window,
      view_attribution_window: request.query?.view_attribution_window,
    };
  return input;
}
/** Measurement settings the outcome must share with the proposal's evidence to be compared at all. */
function definitionChanges(source: JsonObject, outcome: JsonObject, doc: JsonObject) {
  return [
    ...['gateway', 'account_id', 'connection_id', 'preset'].filter(k => outcome[k] !== source[k]),
    ...['currency', 'timezone', 'attribution', 'conversion_definition'].filter(
      k => outcome.semantics?.[k] !== source.semantics?.[k],
    ),
    ...(doc.parent_campaign_id !== undefined &&
    outcome.source_request?.path_params?.campaign_id !== doc.parent_campaign_id
      ? ['parent_campaign_id']
      : []),
  ];
}
/** Realized spend and conversions per entity beside the modeled ranges, with totals (exact, nine places). */
function outcomeResult(doc: JsonObject, outcome: JsonObject) {
  const modeled = doc.modeled,
    low = nine(modeled.efficiency_low),
    high = nine(modeled.efficiency_high),
    rows: JsonObject[] = Array.isArray(outcome.rows) ? outcome.rows : [];
  let missing = false,
    partialDays = false;
  const sum = (values: (bigint | null)[]): bigint | null =>
    values.some(v => v === null) ? null : values.reduce<bigint>((n, v) => n + v!, 0n);
  const entities = (modeled.entities as JsonObject[]).map(e => {
    const own = rows.filter(r => String(r.entity_id) === String(e.entity_id)),
      days = new Set(own.map(r => r.date)).size,
      spend = own.length ? sum(own.map(r => nine(r.spend))) : null,
      conversions = own.length ? sum(own.map(r => nine(r.conversions))) : null,
      evidenceSpend = nine(e.observed_spend)!,
      evidenceConversions = nine(e.observed_conversions)!,
      proposed = nine(e.proposed_budget)!;
    if (!own.length) missing = true;
    else if (days < doc.window.days) partialDays = true;
    // Conversions the evidence period's efficiency gives for an amount of spend, times a factor.
    const at = (amount: bigint | null, factor: bigint | null) =>
      amount === null || factor === null ? null : divide(evidenceConversions * amount * factor, evidenceSpend * scale);
    const proposedLow = at(proposed, low),
      proposedHigh = at(proposed, high),
      realizedLow = at(spend, low),
      realizedHigh = at(spend, high),
      expected = at(spend, scale);
    return {
      entity_id: e.entity_id,
      name: e.name,
      days_with_rows: days,
      proposed_budget: text(proposed),
      realized_spend: text(spend),
      spend_to_proposed: spend === null || proposed === 0n ? null : text(divide(spend * scale, proposed)),
      realized_conversions: text(conversions),
      modeled_conversions_low: text(proposedLow),
      modeled_conversions_high: text(proposedHigh),
      position: position(conversions, proposedLow, proposedHigh),
      spend_conditioned_low: text(realizedLow),
      spend_conditioned_high: text(realizedHigh),
      spend_conditioned_position: position(conversions, realizedLow, realizedHigh),
      realized_factor:
        conversions === null || expected === null || expected === 0n
          ? null
          : text(divide(conversions * scale, expected)),
      exact: {proposed, spend, conversions, proposedLow, proposedHigh, realizedLow, realizedHigh, expected},
    };
  });
  const total = (key: string) => sum(entities.map(e => (e.exact as Record<string, bigint | null>)[key]!)),
    proposed = total('proposed'),
    spend = total('spend'),
    conversions = total('conversions'),
    proposedLow = total('proposedLow'),
    proposedHigh = total('proposedHigh'),
    realizedLow = total('realizedLow'),
    realizedHigh = total('realizedHigh'),
    expected = total('expected');
  return {
    entities: entities.map(({exact: _exact, ...e}) => e),
    totals: {
      entity_count: entities.length,
      proposed_budget: text(proposed),
      realized_spend: text(spend),
      spend_to_proposed: spend === null || !proposed ? null : text(divide(spend * scale, proposed)),
      realized_conversions: text(conversions),
      modeled_conversions_low: text(proposedLow),
      modeled_conversions_high: text(proposedHigh),
      position: position(conversions, proposedLow, proposedHigh),
      spend_conditioned_low: text(realizedLow),
      spend_conditioned_high: text(realizedHigh),
      spend_conditioned_position: position(conversions, realizedLow, realizedHigh),
      realized_factor:
        conversions === null || expected === null || expected === 0n
          ? null
          : text(divide(conversions * scale, expected)),
      basis: 'sums of the entity values',
    },
    limitations: [
      ...allocationOutcomeLimitations,
      ...(missing ? [missingRowsLimitation] : []),
      ...(partialDays ? [partialDaysLimitation] : []),
    ],
    rounding: 'nine decimal places, half to even',
  };
}

/**
 * `capture_allocation_outcome`: once the outcome window has closed, captures the same entities with the proposal's
 * guided preset (provider reads, retained as ordinary evidence) and saves the comparison. Refused before the window
 * closes; an outcome already captured is returned unchanged.
 */
export async function captureAllocationOutcome(
  store: Store,
  actor: Actor,
  planId: string,
  capture: (input: JsonObject) => Promise<JsonObject>,
): Promise<JsonObject> {
  const run = accessiblePlan(store, actor, planId),
    doc =
      optional(store, actor.tenantId, allocationOutcomeKind, run.id) ?? scheduleAllocationOutcome(store, actor, run);
  if (!doc) {
    const execution = verifiedAllocationExecution(run);
    bad(
      'The outcome review starts after every budget step of this plan has been executed and verified by read-back.',
      'ALLOCATION_OUTCOME_NOT_READY',
      {reason: 'reason' in execution ? execution.reason : 'not_recorded'},
    );
  }
  if (doc.state === 'complete') return view(doc);
  if (doc.state === 'unavailable')
    bad(
      'This plan’s outcome cannot be compared with its proposal: the proposal or its evidence changed or is gone.',
      'ALLOCATION_OUTCOME_UNAVAILABLE',
      {reason: doc.reason ?? null},
    );
  const now = Date.now();
  // Never before the window has closed in the account time zone (both the stored instant and today's local date).
  if (!(now >= doc.due_at) || localDate(now, doc.window.timezone) <= doc.window.until)
    throw new MirrorError(
      'ALLOCATION_OUTCOME_NOT_DUE',
      'The outcome window has not closed yet. Nothing was read; the review runs after the window closes.',
      {window: doc.window, due_at: doc.due_at},
      409,
    );
  const key = 'allocation-outcome:' + actor.tenantId + ':' + run.id,
    owner = randomUUID();
  if (!store.acquireLock(key, owner, 300000))
    throw new MirrorError(
      'ALLOCATION_OUTCOME_BUSY',
      'This outcome is already being captured. Open it again in a few minutes.',
      {},
      409,
    );
  try {
    const source = optional(store, actor.tenantId, 'decision_report', String(doc.report_id));
    if (!source) {
      const unavailable = {...doc, state: 'unavailable', reason: 'source_report_deleted', updated_at: Date.now()};
      store.putDocument(actor.tenantId, allocationOutcomeKind, run.id, unavailable);
      return view(unavailable);
    }
    const captured = await capture(captureInput(source, doc.window));
    store.assertActorActive(actor);
    const outcome = read(store, actor, 'decision_report', String(captured.id)),
      latest = store.document(actor.tenantId, allocationOutcomeKind, run.id);
    if (latest.state === 'complete') return view(latest);
    const changed = definitionChanges(source, outcome, latest),
      base = {
        ...latest,
        outcome_report_id: outcome.id,
        outcome_source_hash: outcome.source_hash,
        outcome_captured_at: outcome.captured_at,
        updated_at: Date.now(),
      };
    const result: JsonObject = changed.length
      ? {...base, state: 'unavailable', reason: 'measurement_definition_changed', changed_fields: changed}
      : {
          ...base,
          state: 'complete',
          completed_at: Date.now(),
          ...outcomeResult(latest, outcome),
          calibration_evidence: {
            report_id: outcome.id,
            website_path: '/reports?id=' + encodeURIComponent(outcome.id),
            calibration_ready: latest.window.days >= 14 && latest.window.days <= 31,
            meaning: calibrationMeaning,
            ...(latest.window.days >= 14 && latest.window.days <= 31
              ? {
                  next_call: {
                    tool: 'amcp_reporting',
                    arguments: {
                      action: 'calibrate_allocation',
                      id: outcome.id,
                      ids: (latest.modeled.entities as JsonObject[]).slice(0, 20).map(e => e.entity_id),
                    },
                  },
                }
              : {}),
          },
        };
    store.assertActorActive(actor);
    store.putDocument(actor.tenantId, allocationOutcomeKind, run.id, result);
    audit(store, actor, 'allocation_outcome_captured', {
      plan_id: run.id,
      state: result.state,
      outcome_report_id: outcome.id,
      ...(result.reason ? {reason: result.reason} : {}),
    });
    return {...view(result), network_requests: captured.collection_usage?.requests ?? null};
  } finally {
    store.releaseLock(key, owner);
  }
}

/**
 * The background review (job kind allocation_outcome): runs as the person whose verified execution completed the
 * plan, through the same capture_allocation_outcome action. A refusal that a later attempt can clear is retried with
 * growing delays; any other is recorded on the outcome, which an authorized member can still capture explicitly.
 */
export async function allocationOutcomeJob(
  store: Store,
  call: (tool: string, input: JsonObject, actor: Actor) => Promise<JsonObject>,
  tenant: string,
  input: JsonObject,
  leaseCheck: () => void,
) {
  const planId = String(input.plan_id ?? ''),
    doc = optional(store, tenant, allocationOutcomeKind, planId);
  if (!doc || !['scheduled', 'due'].includes(doc.state)) return {plan_id: planId, state: doc?.state ?? 'missing'};
  if (Date.now() < doc.due_at) {
    store.enqueue(tenant, allocationOutcomeKind, {plan_id: planId}, doc.due_at);
    return {plan_id: planId, state: 'scheduled'};
  }
  const failed = (error: JsonObject, retryAfter?: number) => {
    const latest = store.document(tenant, allocationOutcomeKind, planId),
      attempts = Number(latest.attempts ?? 0) + 1,
      retry =
        (error.retryable === true || retryCodes.includes(error.code)) && attempts <= retryDelays.length
          ? Date.now() + Math.max(retryDelays[attempts - 1]!, Number(retryAfter) || 0)
          : null;
    store.transaction(() => {
      store.putDocument(tenant, allocationOutcomeKind, planId, {
        ...latest,
        state: 'due',
        attempts,
        last_error: {code: String(error.code ?? 'ALLOCATION_OUTCOME_FAILED'), at: Date.now()},
        next_attempt_at: retry,
        updated_at: Date.now(),
      });
      if (retry !== null) store.enqueue(tenant, allocationOutcomeKind, {plan_id: planId}, retry);
    });
    return {plan_id: planId, state: 'due', code: error.code ?? null, next_attempt_at: retry};
  };
  let actor: Actor;
  try {
    actor = store.restoreJobActor(tenant, 'allocation-outcome:' + planId, doc.actor_binding);
  } catch (e) {
    return failed({code: e instanceof MirrorError ? e.code : 'JOB_REAUTHORIZATION_REQUIRED'});
  }
  store.bindActorCheck(actor, leaseCheck);
  const result = await call('amcp_reporting', {action: 'capture_allocation_outcome', id: planId}, actor);
  if (result.success) return {plan_id: planId, state: result.data?.state ?? 'complete'};
  return failed(result.error ?? {}, result.error?.details?.retry_after_ms);
}
