import {randomUUID} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {bad, fingerprint, writer, type ToolCall} from './workspace-core.js';
import {reportAllocation} from './report-allocation.js';
import {reportPlatforms} from './report-metrics.js';
import {guidedReportSources} from './report-sources.js';
import type {AllocationBudgets, AllocationDraft} from './report-source.js';
import {minimumUnitMicros} from './budget-units.js';

/**
 * ARC-01 (reporting, wave 4c round 6): the guided platforms' native budget drafts (each guided reporting's
 * allocationDraft, beside its allocation model), under the gateway of the platform's reports: the budget reader, the
 * source fields a binding keeps, the platform's own checks of a converted daily budget, its native update and its
 * wording. This module keeps the conversion, the shared checks, their order and refusals, the preview and draft records
 * and the source binding, and asks a draft only where it named the platform before.
 */
const drafts = guidedReportSources.flatMap(source =>
  source.guided?.allocation && source.guided.allocationDraft
    ? [
        {
          gateway: reportPlatforms[source.platform]!.gateway,
          preset: source.guided.allocation.preset,
          draft: source.guided.allocationDraft,
        },
      ]
    : [],
);
if (
  drafts.filter(entry => entry.draft.fallback).length !== 1 ||
  guidedReportSources.some(source => !source.guided?.allocation !== !source.guided?.allocationDraft)
)
  throw new Error('Every allocation model needs its native budget draft, and exactly one draft is the fallback.');
// A binding that names no gateway (one made before the other platforms qualified) is the fallback draft's, Google
// Ads', and so is a gateway no draft declares.
const fallback = drafts.find(entry => entry.draft.fallback)!;
/** The gateway of an allocation binding: its own, or the fallback draft's when it names none. */
export const allocationGateway = (binding: JsonObject): string => binding.gateway ?? fallback.gateway;
const draftOf = (gateway: unknown): AllocationDraft =>
  (drafts.find(entry => entry.gateway === gateway) ?? fallback).draft;
const decimal = (n: bigint) => {
  const tail = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return String(n / 1000000n) + (tail ? '.' + tail : '');
};
const micros = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
};
/**
 * An equal daily share of a period total, rounded down to `unit` micros, the smallest chargeable amount of the account
 * currency (WRT-07 Stage A). What rounding leaves out is the preview's residual; the floors are checked after it.
 */
export function roundedDaily(totalMicros: bigint, days: number, unit: bigint): bigint {
  const daily = totalMicros / BigInt(days);
  return (daily / unit) * unit;
}
/** DEC-02: below this share of its current daily budget over the evidence days, an entity is marked as under-spending. */
export const lowBudgetUtilization = 0.8;
/**
 * DEC-02 budget utilization: observed spend over the evidence days ÷ (current daily budget × days), six places,
 * truncated. Descriptive only: the budget in force during the evidence window may have differed from today's.
 */
export function budgetUtilization(observedSpend: string, dailyMicros: bigint, days: number) {
  const [whole, fraction = ''] = observedSpend.split('.'),
    spendNano = BigInt(whole!) * 1000000000n + BigInt(fraction.padEnd(9, '0').slice(0, 9)),
    capacityNano = dailyMicros * 1000n * BigInt(days);
  if (capacityNano <= 0n) return {budget_utilization: null, low_budget_utilization: null};
  const ppm = (spendNano * 1000000n) / capacityNano,
    tail = (ppm % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return {
    budget_utilization: String(ppm / 1000000n) + (tail ? '.' + tail : ''),
    low_budget_utilization: ppm < BigInt(lowBudgetUtilization * 1000000),
  };
}

async function budgets(
  store: Store,
  call: ToolCall,
  actor: Actor,
  source: JsonObject,
  ids: string[],
  pricing = true,
  // DEC-02: the evidence period, given only by the preview, for Google's Search budget-lost impression share.
  window?: {since: string; until: string},
): Promise<AllocationBudgets> {
  return draftOf(source.gateway).budgets(store, call, actor, source, ids, pricing, window);
}

function draft(binding: JsonObject, previewId: string) {
  const plan = draftOf(binding.gateway),
    targetGateway = allocationGateway(binding);
  return {
    action: 'create',
    name: 'Allocation budget draft',
    idempotency_key: 'allocation-' + previewId,
    allocation_preview_id: previewId,
    allocation_preview_hash: fingerprint(binding),
    confirmed: true,
    brief:
      'Source report ' +
      binding.report_id +
      '; model ' +
      binding.model_fingerprint +
      // DEC-02: where the efficiency factors came from.
      (binding.options?.factor_source?.kind === 'calibration'
        ? '; efficiency factors from retained calibration ' + binding.options.factor_source.evidence_fingerprint
        : '; efficiency factors declared by the operator') +
      '. Equal daily conversion over a comparable ' +
      binding.period_days +
      (plan.averageDaily
        ? '-day period. Average daily budgets remain in effect until separately changed; this draft sets no end date. Every step still needs native review, spending acknowledgement and read-back.'
        : '-day period. Daily budgets remain in effect until separately changed; this draft sets no end date. Every step still needs native review, spending acknowledgement and read-back.'),
    steps: binding.targets.map((t: JsonObject, i: number) => ({
      id: 'allocation-' + (i + 1),
      kind: 'write',
      gateway: targetGateway,
      connection_id: binding.connection_id,
      account_id: binding.account_id,
      expected_currency: binding.currency,
      depends_on: [],
      description:
        plan.entity +
        (t.entity_id ?? t.campaign_id) +
        (plan.owner?.(t) ?? '') +
        (plan.averageDaily ? ': average daily budget ' : ': daily budget ') +
        decimal(BigInt(t.daily_budget_micros)) +
        ' ' +
        binding.currency +
        (plan.nativeAmount?.(t) ?? ''),
      arguments: plan.step(binding, t),
    })),
  };
}

/** Stored atomically by the campaign creator, so a crash cannot leave an unbound allocation draft. */
export function allocationCreationBinding(store: Store, actor: Actor, input: JsonObject, steps: JsonObject[]) {
  if (input.allocation_preview_id === undefined && input.allocation_preview_hash === undefined) return undefined;
  const p = store.document(actor.tenantId, 'allocation_preview', String(input.allocation_preview_id)),
    b = p.binding;
  if (
    input.confirmed !== true ||
    p.user_id !== actor.userId ||
    p.session_id !== (store.sessionIdentity(actor) ?? null) ||
    p.expires_at <= Date.now() ||
    p.preview_hash !== input.allocation_preview_hash ||
    p.preview_hash !== fingerprint(b)
  )
    bad("Use this session's current confirmed allocation preview.", 'ALLOCATION_PREVIEW_CHANGED');
  sourceCurrent(store, actor, b);
  const expected = draft(b, p.id),
    clean = (s: JsonObject) =>
      Object.fromEntries(
        [
          'id',
          'kind',
          'gateway',
          'connection_id',
          'account_id',
          'arguments',
          'depends_on',
          'description',
          'expected_currency',
        ].map(k => [k, s[k]]),
      );
  if (
    input.idempotency_key !== expected.idempotency_key ||
    input.name !== expected.name ||
    input.brief !== expected.brief ||
    fingerprint(steps.map(clean)) !== fingerprint(expected.steps.map(clean))
  )
    bad('The draft differs from the exact allocation preview.', 'ALLOCATION_PLAN_CHANGED');
  return {...b, preview_id: p.id};
}
function sourceCurrent(store: Store, actor: Actor, b: JsonObject) {
  const report = store.document(actor.tenantId, 'decision_report', b.report_id);
  const selectedGateway = allocationGateway(b);
  store.resolveConnection(actor, selectedGateway, b.account_id, b.connection_id);
  if (
    report.revision !== b.report_revision ||
    report.source_hash !== b.source_hash ||
    report.gateway !== selectedGateway ||
    report.account_id !== b.account_id ||
    report.connection_id !== b.connection_id ||
    // The source fields only the platform binds (Snapchat's parent campaign).
    !!draftOf(selectedGateway).sourceChanged?.(report, b)
  )
    bad('The allocation source changed. Model and preview a new draft.', 'ALLOCATION_SOURCE_CHANGED');
  const modeled = reportAllocation(report, b.options); // Recheck age, completeness and evidence eligibility immediately before use.
  if (
    modeled.model_fingerprint !== b.model_fingerprint ||
    (b.modeled_allocations_hash !== undefined && fingerprint(modeled.allocations) !== b.modeled_allocations_hash)
  )
    bad('The allocation source changed. Model and preview a new draft.', 'ALLOCATION_SOURCE_CHANGED');
}

export async function previewAllocationPlan(
  store: Store,
  call: ToolCall,
  actor: Actor,
  report: JsonObject,
  input: JsonObject,
) {
  writer(store, actor);
  // A draft qualifies the evidence of its platform's allocation model, under the gateway of the platform's reports.
  const qualified = drafts.find(entry => entry.gateway === report.gateway && entry.preset === report.preset);
  if (!qualified)
    bad(
      'Native allocation drafts qualify Google dedicated campaign budgets, LinkedIn independent campaign daily budgets, Meta campaign or single-ad-set daily budgets and Snapchat ad-squad daily budgets. Other budget modes need their separate native planning flow.',
      'ALLOCATION_PLAN_UNQUALIFIED',
    );
  const plan = qualified.draft;
  if (input.conversion !== 'equal_daily')
    bad(
      'Explicitly choose equal_daily conversion. Period totals are not native daily budgets.',
      'ALLOCATION_CONVERSION_REQUIRED',
    );
  const modeled = reportAllocation(report, input.options ?? {});
  const source = {
    gateway: report.gateway,
    account_id: report.account_id,
    connection_id: report.connection_id,
    currency: modeled.currency,
    timezone: modeled.semantics.timezone,
    // The source fields the platform binds: LinkedIn's API version, Snapchat's parent campaign.
    ...plan.source?.(report),
  };
  // The smallest amount the account currency can be charged (WRT-07 Stage A): 10000 micros for USD, 1000000 for JPY
  // and CLP, 1000 for KWD. A daily budget that is not a multiple of it is refused by the provider.
  let unit = minimumUnitMicros(modeled.currency);
  if (unit === undefined)
    bad(
      'The report names no ISO currency, so daily budgets cannot be rounded to an amount the account can be charged.',
      'ALLOCATION_PRECISION',
    );
  // DEC-02: a platform that counts budgets in whole minor units of a pinned per-currency offset (Meta) refuses a
  // currency without one before any read. A daily amount is a whole number of those units and of the ISO minor unit.
  const offset = plan.minorUnits?.(modeled.currency);
  if (offset !== undefined && 1000000n / BigInt(offset) > unit!) unit = 1000000n / BigInt(offset);
  const native = await budgets(
    store,
    call,
    actor,
    source,
    modeled.allocations.map((r: JsonObject) => r.entity_id),
    true,
    {since: modeled.semantics.date_from, until: modeled.semantics.date_to},
  );
  const targets = modeled.allocations.map((r: JsonObject) => {
    const n = native.targets.find(n => (n.entity_id ?? n.campaign_id) === r.entity_id)!,
      total = micros(r.proposed_budget),
      daily = roundedDaily(total, modeled.period.days, unit!);
    if (daily <= 0n || daily > BigInt(Number.MAX_SAFE_INTEGER))
      bad(
        'Every converted daily budget must be positive and within the exact allocation precision limit.',
        'ALLOCATION_PRECISION',
      );
    // The platform's own checks of the converted amount: LinkedIn's stated daily limits, Snapchat's minimum.
    plan.daily?.(daily, {entity_id: r.entity_id, currency: modeled.currency, limits: native.daily_budget_limits});
    if (daily === BigInt(n.amount_micros))
      bad(
        'The allocation contains an unchanged daily budget; adjust the modeled selection before creating a plan.',
        'ALLOCATION_UNCHANGED',
      );
    // The floor is checked again after rounding down to the chargeable unit.
    if (daily * BigInt(modeled.period.days) < micros(r.minimum))
      bad(
        'Rounding this allocation down to the smallest amount of the account currency per day would fall below a selected period floor. Adjust the model bounds.',
        'ALLOCATION_PRECISION',
      );
    return {
      ...n,
      // The platform's native name of the target (LinkedIn's current campaign name), else the report's.
      name: plan.name?.(n) || r.name,
      period_budget: r.proposed_budget,
      current_daily_budget: decimal(BigInt(n.amount_micros)),
      current_daily_budget_micros: n.amount_micros,
      daily_budget_micros: String(daily),
      daily_budget: decimal(daily),
      represented_period_budget: decimal(daily * BigInt(modeled.period.days)),
      rounding_residual: decimal(total - daily * BigInt(modeled.period.days)),
      minimum_unit_micros: String(unit),
      ...(offset !== undefined ? {daily_budget_native: String((daily * BigInt(offset)) / 1000000n)} : {}),
      ...budgetUtilization(r.observed_spend, BigInt(n.amount_micros), modeled.period.days),
      // DEC-02: Google Search budget-lost impression share over the evidence period (descriptive, never a gate).
      ...(native.search_budget_lost
        ? {
            search_budget_lost_impression_share:
              native.search_budget_lost.status === 'read'
                ? (native.search_budget_lost.campaigns[r.entity_id] ?? {status: 'not_reported'})
                : {status: 'unavailable'},
          }
        : {}),
    };
  });
  const binding = {
    ...source,
    gateway: report.gateway,
    report_id: report.id,
    report_revision: report.revision,
    source_hash: report.source_hash,
    model_fingerprint: modeled.model_fingerprint,
    modeled_allocations_hash: fingerprint(modeled.allocations),
    options: input.options,
    period_days: modeled.period.days,
    conversion: 'equal_daily',
    targets,
    ...(native.source_references ? {native_source_references: native.source_references} : {}),
    ...(native.daily_budget_limits ? {daily_budget_limits: native.daily_budget_limits} : {}),
    ...(native.search_budget_lost?.reference
      ? {indicator_source_references: [native.search_budget_lost.reference]}
      : {}),
  };
  sourceCurrent(store, actor, binding);
  return store.transaction(() => {
    // Expired previews go first (their declared expiry, src/document-kinds.ts).
    const previews = store.repo('allocation_preview', actor.tenantId);
    previews.purgeExpired(Date.now());
    if (previews.count() >= 100)
      bad('At most 100 current allocation previews may be retained.', 'ALLOCATION_PREVIEW_LIMIT');
    const id = randomUUID(),
      preview_hash = fingerprint(binding),
      expires_at = Date.now() + 10 * 60000;
    store.putDocument(actor.tenantId, 'allocation_preview', id, {
      binding,
      preview_hash,
      expires_at,
      user_id: actor.userId,
      session_id: store.sessionIdentity(actor) ?? null,
    });
    return {
      record_kind: 'allocation_preview',
      preview_id: id,
      preview_hash,
      expires_at,
      ...binding,
      advertising_writes: 0,
      meaning: plan.meaning,
    };
  });
}

export async function createAllocationPlan(
  store: Store,
  call: ToolCall,
  actor: Actor,
  report: JsonObject,
  input: JsonObject,
  createDraft?: (plan: JsonObject, actor: Actor) => Promise<JsonObject>,
) {
  writer(store, actor);
  if (input.confirmed !== true)
    bad('Confirm this exact conversion before creating its unapproved draft.', 'CONFIRMATION_REQUIRED');
  const p = store.document(actor.tenantId, 'allocation_preview', String(input.preview_id)),
    b = p.binding;
  if (
    p.user_id !== actor.userId ||
    p.session_id !== (store.sessionIdentity(actor) ?? null) ||
    p.preview_hash !== input.preview_hash ||
    p.preview_hash !== fingerprint(b) ||
    b.report_id !== report.id
  )
    bad("Choose this session's exact allocation preview.", 'ALLOCATION_PREVIEW_CHANGED');
  const result = (id: string) => ({
    record_kind: 'allocation_plan',
    id,
    state: store.document(actor.tenantId, 'campaign_run', id).state,
    website_path: '/campaigns?id=' + encodeURIComponent(id),
    next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id}},
    advertising_writes: 0,
    approval_required: true,
  });
  if (p.plan_id) return result(p.plan_id);
  if (p.expires_at <= Date.now())
    bad('The preview expired. Read current budgets and preview again.', 'ALLOCATION_PREVIEW_EXPIRED');
  const key = 'allocation-plan:' + actor.tenantId + ':' + p.id,
    owner = randomUUID();
  if (!store.acquireLock(key, owner, 90000))
    bad('This draft is already being created. Inspect or retry its original preview.', 'ALLOCATION_PLAN_BUSY');
  try {
    sourceCurrent(store, actor, b);
    const current = await budgets(
      store,
      call,
      actor,
      b,
      b.targets.map((t: JsonObject) => t.entity_id ?? t.campaign_id),
      // The preview already priced LinkedIn's daily limits: one pricing read per draft.
      false,
    );
    if (
      current.targets.some(
        n =>
          n.native_signature !==
          b.targets.find((t: JsonObject) => (t.entity_id ?? t.campaign_id) === (n.entity_id ?? n.campaign_id))
            ?.native_signature,
      )
    )
      bad(
        'A native budget changed since preview. Inspect a new preview before creating the draft.',
        'ALLOCATION_BUDGET_CHANGED',
      );
    sourceCurrent(store, actor, b);
    if (p.expires_at <= Date.now() || !store.renewLock(key, owner, 90000))
      bad('Draft creation lost its current preview.', 'ALLOCATION_PREVIEW_EXPIRED');
    if (!createDraft) bad('The local draft engine is unavailable.', 'ALLOCATION_PLAN_UNAVAILABLE');
    const created = await createDraft(draft(b, p.id), actor);
    if (!created.success)
      bad(created.error?.message ?? 'The draft could not be created.', created.error?.code ?? 'ALLOCATION_PLAN_FAILED');
    const run = store.document(actor.tenantId, 'campaign_run', created.data.id);
    if (run.allocation?.preview_id !== p.id)
      bad('The draft is missing its original allocation binding.', 'ALLOCATION_PLAN_CHANGED');
    store.putDocument(actor.tenantId, 'allocation_preview', p.id, {...p, plan_id: run.id});
    store.assertActorActive(actor);
    sourceCurrent(store, actor, b);
    store.appendAudit(actor.tenantId, 'allocation/' + p.id, {
      event: 'allocation_draft_created',
      report_id: report.id,
      plan_id: run.id,
      model_fingerprint: b.model_fingerprint,
    });
    return result(run.id);
  } finally {
    store.releaseLock(key, owner);
  }
}

/** Applied only to unsent proposal-derived steps. Accepted/uncertain receipts always use original recovery. */
export async function assertAllocationStep(
  store: Store,
  call: ToolCall,
  actor: Actor,
  run: JsonObject,
  step: JsonObject,
) {
  const b = run.allocation;
  if (!b || step.status === 'executing') return;
  sourceCurrent(store, actor, b);
  const original = draft(b, b.preview_id).steps.find((s: JsonObject) => s.id === step.id),
    target = b.targets[run.steps.findIndex((s: JsonObject) => s.id === step.id)];
  if (
    !original ||
    !target ||
    fingerprint(step.arguments) !== fingerprint(original.arguments) ||
    step.gateway !== allocationGateway(b) ||
    step.account_id !== b.account_id ||
    step.connection_id !== b.connection_id ||
    step.expected_currency !== b.currency
  )
    bad(
      'This step no longer matches its allocation proposal. Create a new source-bound draft.',
      'ALLOCATION_PLAN_CHANGED',
    );
  const current = await budgets(store, call, actor, b, [target.entity_id ?? target.campaign_id]);
  sourceCurrent(store, actor, b);
  const latest = store.document(actor.tenantId, 'campaign_run', run.id);
  if (latest.revision !== run.revision || latest.state === 'cancelled')
    bad('The campaign plan changed during the budget check. Refresh it before continuing.', 'REVISION_CONFLICT');
  if (current.targets[0]!.native_signature !== target.native_signature)
    bad(
      'The campaign budget or its ownership changed after the allocation preview. Create a fresh preview; no write was submitted.',
      'ALLOCATION_BUDGET_CHANGED',
    );
}
