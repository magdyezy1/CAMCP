import {evaluationFixture, metaConnection, otherConnection} from './journeys/harness.mjs';
const f = await evaluationFixture();
const N = Number(process.env.N ?? 1500);
const show = (label, r) => console.log('##', label, String(JSON.stringify(r)).slice(0, N));
const step = (account = '123', connection = metaConnection) => ({
  id: 'campaign',
  kind: 'write',
  gateway: 'meta_native_action',
  connection_id: connection,
  account_id: account,
  description: 'Create the paused campaign',
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
const mode = process.argv[2] ?? 'accepted';
if (mode === 'lost') f.meta.state.lost = true;
const plan = await f.call('amcp_campaign', {action: 'create', name: 'Eval', brief: 'Paused traffic', steps: [step()]});
show('create', plan);
const id = plan.data.id;
const prep = await f.call('amcp_campaign', {action: 'prepare_next', id});
show('prepare', prep);
if (mode === 'changed') f.meta.state.accountStatus = 2;
const r = prep.data.review ?? prep.data;
const ex = await f.call('amcp_campaign', {
  action: 'execute_next',
  id,
  review_id: r.review_id,
  idempotency_key: r.idempotency_key,
  confirmed: true,
});
show('execute', ex);
if (mode === 'lost') {
  f.meta.state.lost = false;
  const next = ex.data?.next_call ?? ex.meta?.workflow?.next_call;
  show('next', next);
  if (next) show('follow', await f.call(next.tool, next.arguments));
  for (const a of [{action: 'verify', id}, {action: 'reconcile_step', id, step_id: 'campaign'}, {action: 'recover_step', id, step_id: 'campaign'}]) show(a.action, await f.call('amcp_campaign', a));
}
show('get', await f.call('amcp_campaign', {action: 'get', id}));
show('ops', await f.call('amcp_workspace', {action: 'operations'}));
console.log(JSON.stringify(f.transcript.map(t => [t.tool, t.action, t.success, t.code, t.state, t.bytes, t.provider_requests, t.next_call, t.next_step, t.website_path])));
await f.close();
