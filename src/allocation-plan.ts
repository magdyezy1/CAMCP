import {randomUUID} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {bad, fingerprint, writer, type ToolCall} from './workspace-core.js';
import {reportAllocation} from './report-allocation.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {normalizeAccount} from './scope.js';

const gateway = 'google_ads_native_action';
const decimal = (n: bigint) => {
  const tail = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return String(n / 1000000n) + (tail ? '.' + tail : '');
};
const micros = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
};

async function budgets(store: Store, call: ToolCall, actor: Actor, source: JsonObject, ids: string[]) {
  const account = normalizeAccount(gateway, source.account_id);
  store.assertActorActive(actor);
  store.resolveConnection(actor, gateway, account, source.connection_id);
  const query =
    'SELECT customer.id, customer.currency_code, customer.time_zone, campaign.id, campaign.resource_name, campaign.status, campaign.campaign_budget, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count, campaign_budget.period, campaign_budget.status FROM campaign WHERE campaign.id IN (' +
    ids.join(',') +
    ') ORDER BY campaign.id';
  const bound = new ReportCollectionBudget(undefined, fingerprint({account, ids}), () => {}, {
    requests: 5,
    rows: 51,
    elapsed_ms: 60000,
    bytes: 1024 * 1024,
  });
  let response: JsonObject;
  try {
    response = await bound.run(() =>
      call(
        gateway,
        {
          action: 'google_ads_v23_google_ads_search',
          account_id: account,
          connection_id: source.connection_id,
          payload: {query},
          aggregate_pages: false,
          dry_run: false,
        },
        actor,
      ),
    );
  } finally {
    bound.close();
  }
  store.assertActorActive(actor);
  store.resolveConnection(actor, gateway, account, source.connection_id);
  if (!response.success)
    bad(
      response.error?.message ?? 'Current campaign budgets could not be read.',
      response.error?.code ?? 'ALLOCATION_BUDGET_UNAVAILABLE',
    );
  const data = response.data?.data,
    rows = data?.results;
  if (
    !Array.isArray(rows) ||
    rows.length !== ids.length ||
    response.data.truncated ||
    data.nextPageToken ||
    data.next_page_token
  )
    bad('Retain one complete current budget row per selected campaign.', 'ALLOCATION_BUDGET_CHANGED');
  const seen = new Set(),
    resources = new Set();
  return rows.map((row: JsonObject) => {
    const c = row.campaign,
      b = row.campaignBudget,
      u = row.customer;
    // ProtoJSON may omit a false scalar. Required non-default period, count, identity and currency stay explicit.
    if (
      !c ||
      !b ||
      !u ||
      !ids.includes(c.id) ||
      seen.has(c.id) ||
      u.id !== account ||
      u.currencyCode !== source.currency ||
      u.timeZone !== source.timezone ||
      c.resourceName !== 'customers/' + account + '/campaigns/' + c.id ||
      !['ENABLED', 'PAUSED'].includes(c.status) ||
      typeof b.resourceName !== 'string' ||
      !new RegExp('^customers/' + account + '/campaignBudgets/[0-9]+$').test(b.resourceName) ||
      c.campaignBudget !== b.resourceName ||
      resources.has(b.resourceName) ||
      b.explicitlyShared === true ||
      (b.explicitlyShared !== undefined && b.explicitlyShared !== false) ||
      String(b.referenceCount) !== '1' ||
      b.period !== 'DAILY' ||
      b.status !== 'ENABLED' ||
      typeof b.amountMicros !== 'string' ||
      !/^\d+$/.test(b.amountMicros) ||
      BigInt(b.amountMicros) <= 0n ||
      BigInt(b.amountMicros) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      bad(
        'Use current, dedicated daily budgets in the report account, currency and timezone. Shared, lifetime, removed or ambiguous budgets need their own native review.',
        'ALLOCATION_BUDGET_CHANGED',
      );
    seen.add(c.id);
    resources.add(b.resourceName);
    const state = {
      campaign_id: c.id,
      campaign_resource: c.resourceName,
      campaign_status: c.status,
      budget_resource: b.resourceName,
      amount_micros: b.amountMicros,
      currency: u.currencyCode,
      timezone: u.timeZone,
      period: b.period,
      reference_count: 1,
      explicitly_shared: false,
    };
    return {...state, native_signature: fingerprint(state)};
  });
}

function draft(binding: JsonObject, previewId: string) {
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
      '. Equal daily conversion over a comparable ' +
      binding.period_days +
      '-day period. Average daily budgets remain in effect until separately changed; this draft sets no end date. Every step still needs native review, spending acknowledgement and read-back.',
    steps: binding.targets.map((t: JsonObject, i: number) => ({
      id: 'allocation-' + (i + 1),
      kind: 'write',
      gateway,
      connection_id: binding.connection_id,
      account_id: binding.account_id,
      expected_currency: binding.currency,
      depends_on: [],
      description:
        'Campaign ' +
        t.campaign_id +
        ': average daily budget ' +
        decimal(BigInt(t.daily_budget_micros)) +
        ' ' +
        binding.currency,
      arguments: {
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
  store.resolveConnection(actor, gateway, b.account_id, b.connection_id);
  if (
    report.revision !== b.report_revision ||
    report.source_hash !== b.source_hash ||
    report.gateway !== gateway ||
    report.account_id !== b.account_id ||
    report.connection_id !== b.connection_id
  )
    bad('The allocation source changed. Model and preview a new draft.', 'ALLOCATION_SOURCE_CHANGED');
  reportAllocation(report, b.options); // Recheck age, completeness and evidence eligibility immediately before use.
}

export async function previewAllocationPlan(
  store: Store,
  call: ToolCall,
  actor: Actor,
  report: JsonObject,
  input: JsonObject,
) {
  writer(store, actor);
  if (report.gateway !== gateway || report.preset !== 'google_campaign')
    bad(
      'Native allocation drafts currently qualify only Google campaign daily budgets. Other providers retain the downloaded proposal and their separate native planning flow.',
      'ALLOCATION_PLAN_UNQUALIFIED',
    );
  if (input.conversion !== 'equal_daily')
    bad(
      'Explicitly choose equal_daily conversion. Period totals are not native daily budgets.',
      'ALLOCATION_CONVERSION_REQUIRED',
    );
  const modeled = reportAllocation(report, input.options ?? {});
  const source = {
    account_id: report.account_id,
    connection_id: report.connection_id,
    currency: modeled.currency,
    timezone: modeled.semantics.timezone,
  };
  const native = await budgets(
    store,
    call,
    actor,
    source,
    modeled.allocations.map((r: JsonObject) => r.entity_id),
  );
  const targets = modeled.allocations.map((r: JsonObject) => {
    const n = native.find(n => n.campaign_id === r.entity_id)!,
      total = micros(r.proposed_budget),
      daily = total / BigInt(modeled.period.days);
    if (daily <= 0n || daily > BigInt(Number.MAX_SAFE_INTEGER))
      bad(
        'Every converted daily budget must be positive and within the native review integer limit.',
        'ALLOCATION_PRECISION',
      );
    if (daily === BigInt(n.amount_micros))
      bad(
        'The allocation contains an unchanged daily budget; adjust the modeled selection before creating a plan.',
        'ALLOCATION_UNCHANGED',
      );
    if (daily * BigInt(modeled.period.days) < micros(r.minimum))
      bad(
        'Rounding this allocation to daily micros would fall below a selected period floor. Adjust the model bounds.',
        'ALLOCATION_PRECISION',
      );
    return {
      ...n,
      name: r.name,
      period_budget: r.proposed_budget,
      current_daily_budget: decimal(BigInt(n.amount_micros)),
      current_daily_budget_micros: n.amount_micros,
      daily_budget_micros: String(daily),
      daily_budget: decimal(daily),
      represented_period_budget: decimal(daily * BigInt(modeled.period.days)),
      rounding_residual: decimal(total - daily * BigInt(modeled.period.days)),
    };
  });
  const binding = {
    ...source,
    gateway,
    report_id: report.id,
    report_revision: report.revision,
    source_hash: report.source_hash,
    model_fingerprint: modeled.model_fingerprint,
    options: input.options,
    period_days: modeled.period.days,
    conversion: 'equal_daily',
    targets,
  };
  sourceCurrent(store, actor, binding);
  return store.transaction(() => {
    store.db
      .prepare(
        "DELETE FROM documents WHERE tenant_id=? AND kind='allocation_preview' AND json_extract(data,'$.expires_at')<?",
      )
      .run(actor.tenantId, Date.now());
    if (store.documents(actor.tenantId, 'allocation_preview').length >= 100)
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
      meaning:
        'Preview only. Daily amounts round down to whole micros; residuals are shown. These are ongoing average daily budgets, not a scheduled period spending cap. Creating a draft does not approve or execute it.',
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
      b.targets.map((t: JsonObject) => t.campaign_id),
    );
    if (
      current.some(
        n =>
          n.native_signature !== b.targets.find((t: JsonObject) => t.campaign_id === n.campaign_id)?.native_signature,
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
    step.gateway !== gateway ||
    step.account_id !== b.account_id ||
    step.connection_id !== b.connection_id ||
    step.expected_currency !== b.currency
  )
    bad(
      'This step no longer matches its allocation proposal. Create a new source-bound draft.',
      'ALLOCATION_PLAN_CHANGED',
    );
  const current = await budgets(store, call, actor, b, [target.campaign_id]);
  sourceCurrent(store, actor, b);
  const latest = store.document(actor.tenantId, 'campaign_run', run.id);
  if (latest.revision !== run.revision || latest.state === 'cancelled')
    bad('The campaign plan changed during the budget check. Refresh it before continuing.', 'REVISION_CONFLICT');
  if (current[0]!.native_signature !== target.native_signature)
    bad(
      'The campaign budget or its ownership changed after the allocation preview. Create a fresh preview; no write was submitted.',
      'ALLOCATION_BUDGET_CHANGED',
    );
}
