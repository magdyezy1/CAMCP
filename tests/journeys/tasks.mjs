// The B15 evaluation tasks (tests/journeys/b15-tasks.json) as deterministic runs. Each task runs twice in a fresh
// synthetic workspace:
//   reference — the shortest correct sequence of calls, scripted: proves the job can be done and sets its call count;
//   guided    — a client that knows only the task's first call and then follows the next calls AMCP offers. Its metrics
//               measure how far AMCP's own guidance carries a client (B15: correct next actions, fewer calls).
// External AI clients run the same prompts; their sanitized transcripts are measured by the same metric code.
import fs from 'node:fs';
import {metaConnection, otherConnection, evaluationDestination, offeredNextCall} from './harness.mjs';
import {openHandoff} from './journeys.mjs';

export const taskFile = new URL('./b15-tasks.json', import.meta.url);
export const taskSet = JSON.parse(fs.readFileSync(taskFile, 'utf8'));

const step = (account = '123', connection = metaConnection) => ({
  id: 'campaign',
  kind: 'write',
  gateway: 'meta_native_action',
  connection_id: connection,
  account_id: account,
  description: 'Create the paused traffic campaign',
  arguments: {
    action: 'meta_campaign_create',
    payload: {
      name: 'Evaluation campaign',
      objective: 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    },
  },
});
const createArguments = (name, planStep = step()) => ({
  action: 'create',
  name,
  brief: 'A paused traffic campaign for the evaluation task.',
  steps: [planStep],
});
const capture = complete => ({
  action: 'capture_preset',
  preset: 'meta_ad',
  account_id: '123',
  connection_id: metaConnection,
  result_action_type: 'offsite_conversion.fb_pixel_purchase',
  attribution_windows: ['7d_click'],
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: '2026-09-01',
    date_to: '2026-09-01',
    source_name: 'Evaluation evidence',
    complete,
  },
});
/** Setup calls go straight to the service: they prepare the scenario and are not part of the measured transcript. */
const direct = async (f, tool, args) => {
  const result = await f.service.call(tool, args, f.actor);
  if (!result.success) throw Error('Scenario setup failed: ' + tool + ' ' + args.action + ' ' + result.error?.code);
  return result;
};

/** Scenario setups. Each returns the identifiers the task's prompt and calls refer to. */
export const scenarios = {
  async two_clients() {
    return {};
  },
  async draft_plan(f) {
    return {plan: (await direct(f, 'amcp_campaign', createArguments('Draft for review'))).data.id};
  },
  async uncertain_step(f) {
    const plan = (await direct(f, 'amcp_campaign', createArguments('Timed-out plan'))).data.id,
      review = (await direct(f, 'amcp_campaign', {action: 'prepare_next', id: plan})).data.review;
    f.providers.state.lost = true;
    await direct(f, 'amcp_campaign', {
      action: 'execute_next',
      id: plan,
      review_id: review.review_id,
      idempotency_key: review.idempotency_key,
      confirmed: true,
    });
    f.providers.state.lost = false;
    return {plan, mutations: f.providers.state.mutations};
  },
  async incomplete_report(f) {
    return {report: (await direct(f, 'amcp_reporting', capture(false))).data.id};
  },
  async verified_asset(f) {
    const scope = {gateway: 'meta_native_action', connection_id: metaConnection, account_id: '123'};
    f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-1', {
      ...scope,
      platform: 'meta',
      review_id: 'asset-1',
      name: 'Launch image',
      media_id: 'hash-1',
      sha256: 'a'.repeat(64),
    });
    return {asset: 'asset-1'};
  },
  async failed_export(f) {
    const snapshot = f.snapshot();
    f.providers.state.sheetsRefusal = true;
    const queued = await direct(f, 'amcp_reporting_overview', {
      action: 'export',
      report_id: snapshot,
      destination_id: evaluationDestination,
      confirmed: true,
    });
    await f.work();
    f.providers.state.sheetsRefusal = false;
    return {snapshot, export: queued.data.id};
  },
  async two_client_plans(f) {
    const a = (await direct(f, 'amcp_campaign', createArguments('Client A plan'))).data.id,
      b = (await direct(f, 'amcp_campaign', createArguments('Client B plan', step('789', otherConnection)))).data.id;
    return {a, b};
  },
};

/** The first call of each task, from its scenario's identifiers. */
const entries = {
  T1: () => ({
    action: 'capabilities',
    workflow_id: 'recipe:meta_website_traffic',
    connection_id: metaConnection,
    account_id: '123',
  }),
  T2: () => createArguments('Eligible traffic plan'),
  T3: ctx => ({action: 'prepare_next', id: ctx.plan}),
  T4: () => ({action: 'operations', state: 'attention'}),
  T5: ctx => ({action: 'analyze', id: ctx.report}),
  T6: () => ({action: 'library', search: 'launch'}),
  H1: ctx => ({action: 'export_status', id: ctx.export}),
  H2: () => ({action: 'operations', connection_id: otherConnection}),
};

/** The rest of each reference sequence after the entry call: the scripted shortest correct path. */
const references = {
  async T1(f) {
    return [
      await f.call('amcp_workspace', {
        action: 'check',
        gateway: 'meta_native_action',
        connection_id: metaConnection,
        account_id: '123',
        live: true,
      }),
    ];
  },
  async T2(f, ctx, entry) {
    return [await f.call('amcp_campaign', {action: 'preflight', id: entry.data.id})];
  },
  async T3() {
    return [];
  },
  async T4(f, ctx) {
    return [await f.call('amcp_campaign', {action: 'get', id: ctx.plan, step_id: 'campaign'})];
  },
  async T5() {
    return [];
  },
  async T6(f, ctx) {
    return [await f.call('amcp_media', {action: 'asset', asset_id: ctx.asset})];
  },
  async H1(f, ctx) {
    f.approve();
    const retried = await f.call('amcp_reporting_overview', {action: 'retry', id: ctx.export, confirmed: true});
    await f.work();
    return [retried, await f.call('amcp_reporting_overview', {action: 'export_status', id: ctx.export})];
  },
  async H2() {
    return [];
  },
};

/** Whether a task's goal is reached, from the responses the client received and the synthetic providers' state. */
const goals = {
  T1: (f, ctx, responses) =>
    responses.some(r => r.success && r.data?.account_id === '123' && r.data?.live_read === true),
  T2: (f, ctx, responses) =>
    f.providers.state.mutations === 0 &&
    responses.some(r => r.success && r.data?.state === 'draft' && r.data?.preflight?.status === 'ready'),
  T3: (f, ctx, responses) =>
    f.providers.state.mutations === 0 && responses.some(r => r.success && typeof r.data?.review?.review_id === 'string'),
  T4: (f, ctx, responses) =>
    f.providers.state.mutations === ctx.mutations &&
    responses.some(r => r.success && r.data?.view === 'step' && r.data?.step?.status === 'uncertain'),
  T5: (f, ctx, responses) =>
    responses.some(
      r =>
        r.success &&
        r.data?.eligible_for_action === false &&
        r.data?.recommendations?.some(item => item.type === 'data_quality'),
    ),
  T6: (f, ctx, responses) =>
    responses.some(r => r.success && r.data?.asset_id === ctx.asset && r.data?.usage_evidence && r.data?.reuse_call),
  H1: (f, ctx, responses) =>
    f.providers.state.tab.report === ctx.snapshot &&
    responses.some(r => r.success && r.data?.id === ctx.export && r.data?.outcome === 'complete'),
  H2: (f, ctx, responses) => {
    const listed = responses.findLast(r => r.success && Array.isArray(r.data?.operations))?.data.operations ?? [];
    return listed.some(item => item.id === ctx.b) && !listed.some(item => item.id === ctx.a);
  },
};
/** The object a task's website handoff must open. */
const handoffIds = {T2: (ctx, responses) => responses[0]?.data?.id, T3: ctx => ctx.plan, T4: ctx => ctx.plan, T6: ctx => ctx.asset};

/** The next call a response offers: its own, else the first one offered by an item it lists (a feed's rows). */
export function discoverNextCall(response) {
  const own = offeredNextCall(response);
  if (own) return own;
  const search = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 5) return undefined;
    if (
      value.next_call &&
      typeof value.next_call.tool === 'string' &&
      value.next_call.arguments &&
      typeof value.next_call.arguments === 'object'
    )
      return value.next_call;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = search(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return search(response?.data, 0);
}
/** A call that executes, confirms or saves on the person's behalf; a guided client follows it only with approval. */
export const needsApproval = call =>
  call.arguments.confirmed === true || /^(execute|save_|create_|delete|retry|approve|run)/.test(String(call.arguments.action ?? ''));

const handoffPath = responses => {
  for (const response of [...responses].reverse()) {
    const path = response?.meta?.workflow?.website_path ?? response?.data?.website_path;
    if (typeof path === 'string') return path;
  }
  return undefined;
};

/** Runs one task in one mode against a fresh fixture and returns its metrics inputs. */
export async function runTask(f, task, mode, {maxCalls = 8} = {}) {
  const ctx = await scenarios[task.scenario](f),
    goal = goals[task.id],
    responses = [];
  const entry = await f.call(task.entry.tool, entries[task.id](ctx));
  responses.push(entry);
  await f.work();
  if (mode === 'reference') responses.push(...(await references[task.id](f, ctx, entry)));
  else {
    let current = entry;
    while (f.transcript.length < maxCalls && !goal(f, ctx, responses)) {
      const next = discoverNextCall(current);
      if (!next || (needsApproval(next) && !task.approval_allowed)) break;
      if (needsApproval(next)) f.approve();
      current = await f.call(next.tool, next.arguments, {followed: true});
      responses.push(current);
      await f.work();
    }
  }
  const reached = goal(f, ctx, responses),
    // The handoff check is the evaluator opening the link; it is not one of the client's calls.
    measured = f.transcript.length;
  let handoff = null;
  if (task.handoff) handoff = reached && (await openHandoff(f, handoffPath(responses), handoffIds[task.id]?.(ctx, responses)));
  return {goalReached: reached, handoff, measured};
}
