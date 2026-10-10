import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const mode = process.argv[2] ?? 'accepted';
const actor = {tenantId: 'plan', userId: 'operator', role: 'operator'};
const store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64'));
store.putConnection(
  {...actor, role: 'admin'},
  {
    id: 'meta-c',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['ads_management'],
  },
  {accessToken: 'synthetic'},
);
const log = [];
let account = {id: 'act_123', currency: 'USD', account_status: 1, name: 'Synthetic account', timezone_name: 'UTC'};
const created = {};
const service = new MirrorService(
  new Registry(),
  store,
  new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      method = init?.method ?? 'GET';
    log.push(method + ' ' + u.pathname + u.search.slice(0, 120) + (init?.body ? ' BODY ' + String(init.body).slice(0, 200) : ''));
    if (method === 'GET') {
      const id = u.pathname.split('/').at(-1);
      if (created[id]) return Response.json(created[id]);
      return Response.json(account);
    }
    if (mode === 'uncertain') return new Response('{"error":{"message":"synthetic"}}', {status: 500});
    if (mode === 'lost') throw new TypeError('fetch failed');
    const body = Object.fromEntries(
      [...new URLSearchParams(String(init.body))].map(([k, v]) => {
        try {
          return [k, /^[[{]|^(true|false)$/.test(v) ? JSON.parse(v) : v];
        } catch {
          return [k, v];
        }
      }),
    );
    const record = {id: '238000000000001', ...body, account_id: '123'};
    created[record.id] = record;
    return Response.json({id: record.id});
  }),
  undefined,
  {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
);
const call = (tool, input) => service.call(tool, input, actor);
const plan = await call('amcp_campaign', {
  action: 'create',
  name: 'Synthetic plan',
  brief: 'Paused traffic campaign',
  steps: [
    {
      id: 'campaign',
      kind: 'write',
      gateway: 'meta_native_action',
      connection_id: 'meta-c',
      account_id: '123',
      arguments: {
        action: 'meta_campaign_create',
        payload: {
          name: 'Synthetic campaign',
          objective: 'OUTCOME_TRAFFIC',
          status: 'PAUSED',
          special_ad_categories: [],
          is_adset_budget_sharing_enabled: false,
        },
      },
    },
  ],
});
console.log('plan', plan.success, plan.data?.id, JSON.stringify(plan.error ?? {}).slice(0, 300));
const id = plan.data.id;
const prep = await call('amcp_campaign', {action: 'prepare_next', id, detail: 'full'});
console.log('prepare', prep.success, JSON.stringify(prep.data?.review?.execute_requirements ?? prep.error).slice(0, 600));
if (mode === 'refused') account = {...account, account_status: 2};
const r = prep.data.review;
const out = await call('amcp_campaign', {
  action: 'execute_next',
  id,
  review_id: r.review_id,
  idempotency_key: r.idempotency_key,
  confirmed: true,
  ...(r.execute_requirements?.spend_change_confirmed ? {spend_change_confirmed: true} : {}),
});
console.log('execute', out.success, JSON.stringify(out.data ?? out.error).slice(0, 1500));
const after = await call('amcp_campaign', {action: 'get', id});
console.log('after', JSON.stringify(after.data).slice(0, 1500));
console.log(log.join('\n'));
store.close();
