import {randomUUID} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {bad, fingerprint, writer, type ToolCall} from './workspace-core.js';
import {reportAllocation} from './report-allocation.js';
import {googleAllocationBudgets} from './google-allocation-budgets.js';
import {snapchatAllocationBudgets} from './snapchat-allocation-budgets.js';
import {linkedinAllocationBudgets} from './linkedin-allocation-budgets.js';
import {metaAllocationBudgets} from './meta-allocation-budgets.js';
import {linkedinStoredVersion} from './linkedin-version.js';
import {currencyText, metaCurrencyOffset, minimumUnitMicros} from './budget-units.js';

const gateway = 'google_ads_native_action';
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
): Promise<{
  targets: JsonObject[];
  source_references?: JsonObject[];
  daily_budget_limits?: JsonObject;
  search_budget_lost?: JsonObject;
}> {
  if (source.gateway === 'snapchat_native_action') return snapchatAllocationBudgets(store, call, actor, source, ids);
  if (source.gateway === 'linkedin_native_action')
    return linkedinAllocationBudgets(store, call, actor, source, ids, pricing);
  if (source.gateway === 'meta_native_action') return metaAllocationBudgets(store, call, actor, source, ids);
  return googleAllocationBudgets(store, call, actor, source, ids, window);
}

function draft(binding: JsonObject, previewId: string) {
  const snap = binding.gateway === 'snapchat_native_action',
    linkedin = binding.gateway === 'linkedin_native_action',
    meta = binding.gateway === 'meta_native_action',
    targetGateway = binding.gateway ?? gateway;
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
      (snap || linkedin || meta
        ? '-day period. Daily budgets remain in effect until separately changed; this draft sets no end date. Every step still needs native review, spending acknowledgement and read-back.'
        : '-day period. Average daily budgets remain in effect until separately changed; this draft sets no end date. Every step still needs native review, spending acknowledgement and read-back.'),
    steps: binding.targets.map((t: JsonObject, i: number) => ({
      id: 'allocation-' + (i + 1),
      kind: 'write',
      gateway: targetGateway,
      connection_id: binding.connection_id,
      account_id: binding.account_id,
      expected_currency: binding.currency,
      depends_on: [],
      description:
        (snap ? 'Ad squad ' : 'Campaign ') +
        (t.entity_id ?? t.campaign_id) +
        (meta && t.budget_owner === 'ad_set' ? ' (ad set ' + t.adset_id + ')' : '') +
        (snap || linkedin || meta ? ': daily budget ' : ': average daily budget ') +
        decimal(BigInt(t.daily_budget_micros)) +
        ' ' +
        binding.currency +
        (meta ? ' (' + t.daily_budget_native + ' in Meta minor units)' : ''),
      arguments: meta
        ? // DEC-02: the budget owner's own reviewed Meta update; the amount is exact Meta minor units.
          t.budget_owner === 'ad_set'
          ? {
              action: 'meta_ad_set_id_update',
              path_params: {ad_set_id: t.adset_id},
              payload: {daily_budget: t.daily_budget_native},
            }
          : {
              action: 'meta_campaign_id_update',
              path_params: {campaign_id: t.campaign_id},
              payload: {daily_budget: t.daily_budget_native},
            }
        : snap
          ? {
              action: 'snapchat_adsquad_update',
              path_params: {campaign_id: binding.parent_campaign_id, ad_squad_id: t.entity_id},
              payload: [{op: 'replace', path: '/daily_budget_micro', value: Number(t.daily_budget_micros)}],
            }
          : linkedin
            ? {
                action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
                api_version: binding.api_version,
                restli_method: 'PARTIAL_UPDATE',
                path_params: {ad_account_id: binding.account_id, campaign_id: t.campaign_id},
                payload: {patch: {$set: {dailyBudget: {amount: t.daily_budget, currencyCode: binding.currency}}}},
              }
            : {
                action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
                payload: {
                  operations: [
                    {
                      update: {resource_name: t.budget_resource, amount_micros: t.daily_budget_micros},
                      update_mask: 'amount_micros',
                    },
                  ],
                  partial_failure: false,
                },
              },
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
  const selectedGateway = b.gateway ?? gateway;
  store.resolveConnection(actor, selectedGateway, b.account_id, b.connection_id);
  if (
    report.revision !== b.report_revision ||
    report.source_hash !== b.source_hash ||
    report.gateway !== selectedGateway ||
    report.account_id !== b.account_id ||
    report.connection_id !== b.connection_id ||
    (selectedGateway === 'snapchat_native_action' &&
      report.source_request?.path_params?.campaign_id !== b.parent_campaign_id)
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
  const snap = report.gateway === 'snapchat_native_action' && report.preset === 'snapchat_adsquad',
    linkedin = report.gateway === 'linkedin_native_action' && report.preset === 'linkedin_campaign',
    meta = report.gateway === 'meta_native_action' && report.preset === 'meta_campaign';
  if (!snap && !linkedin && !meta && (report.gateway !== gateway || report.preset !== 'google_campaign'))
    bad(
      'Native allocation drafts qualify Google dedicated campaign budgets, LinkedIn independent campaign daily budgets, Meta campaign or single-ad-set daily budgets and Snapchat ad-squad daily budgets. Other budget modes need their separate native planning flow.',
      'ALLOCATION_PLAN_UNQUALIFIED',
    );
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
    // A saved report's version is reused while reviewed; a sunset (or soon sunset) one moves to the current version.
    ...(linkedin ? {api_version: linkedinStoredVersion(report.source_request?.api_version)} : {}),
    ...(snap ? {parent_campaign_id: report.source_request.path_params.campaign_id} : {}),
  };
  // The smallest amount the account currency can be charged (WRT-07 Stage A): 10000 micros for USD, 1000000 for JPY
  // and CLP, 1000 for KWD. A daily budget that is not a multiple of it is refused by the provider.
  let unit = minimumUnitMicros(modeled.currency);
  if (unit === undefined)
    bad(
      'The report names no ISO currency, so daily budgets cannot be rounded to an amount the account can be charged.',
      'ALLOCATION_PRECISION',
    );
  // DEC-02: Meta counts budgets in whole minor units of its pinned per-currency offset; refused before any read without
  // one. A daily amount is a whole number of those units and of the ISO minor unit.
  const offset = meta ? metaCurrencyOffset(modeled.currency) : undefined;
  if (meta && offset === undefined)
    bad(
      'Meta budgets count in the account currency’s minor unit, and AMCP has no pinned Meta offset for this currency. Pin Meta’s currency table before converting an allocation; nothing was read or saved.',
      'ALLOCATION_PRECISION',
      {currency: modeled.currency},
    );
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
    const limits = native.daily_budget_limits;
    if (
      limits?.status === 'checked' &&
      (daily < BigInt(limits.min_micros) || (limits.max_micros !== null && daily > BigInt(limits.max_micros)))
    )
      bad(
        'A converted daily budget is outside the daily budget limits LinkedIn states for this account. Adjust the model bounds.',
        'ALLOCATION_BUDGET_LIMIT',
        {
          entity_id: r.entity_id,
          daily_budget: currencyText(daily, modeled.currency),
          minimum: limits.min,
          maximum: limits.max,
          currency: modeled.currency,
        },
      );
    if (snap && daily < 5000000n)
      bad(
        'Every Snapchat daily budget must meet the documented minimum of 5000000 native micros.',
        'ALLOCATION_PRECISION',
      );
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
      name: linkedin && n.campaign.name ? n.campaign.name : r.name,
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
    store.db
      .prepare(
        "DELETE FROM documents WHERE tenant_id=? AND kind='allocation_preview' AND json_extract(data,'$.expires_at')<?",
      )
      .run(actor.tenantId, Date.now());
    if (
      Number(
        store.db
          .prepare("SELECT COUNT(*) AS n FROM documents WHERE tenant_id=? AND kind='allocation_preview'")
          .get(actor.tenantId)?.n,
      ) >= 100
    )
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
      meaning: meta
        ? 'Preview only. Each Meta daily budget is set on its current owner: the campaign when it has a campaign daily budget, otherwise its one spending ad set. Amounts are whole Meta minor units of the account currency, rounded down; residuals are shown. Meta can spend up to 75% more than a daily budget on a day with better opportunities and at most seven times it over a calendar week. Daily budgets remain in effect until changed; this draft sets no end date and does not approve or execute any change.'
        : linkedin
          ? 'Preview only. LinkedIn native daily budgets use decimal account-currency amounts, rounded down to the smallest unit of the currency and checked against LinkedIn’s daily budget limits for the account when it states them. Rounding residuals are shown. Daily settings remain in effect until changed, and LinkedIn can charge up to 150% of a daily budget on a day with strong auction opportunities. Existing group caps are preserved. This draft sets no end date or automatic period spending cap, and does not approve or execute any change.'
          : binding.gateway === 'snapchat_native_action'
            ? 'Preview only. Daily amounts round down to the smallest unit of the account currency; residuals are shown. These are ongoing daily budgets, not a scheduled period spending cap. Creating a draft does not approve or execute it.'
            : 'Preview only. Daily amounts round down to the smallest unit of the account currency; residuals are shown. These are ongoing average daily budgets, not a scheduled period spending cap. Creating a draft does not approve or execute it.',
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
    step.gateway !== (b.gateway ?? gateway) ||
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
