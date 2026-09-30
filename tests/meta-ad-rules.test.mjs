import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Meta automated rules, unblocked by the owner on 2026-09-30. Meta's Ad Rules Engine references (read 2026-09-30):
 * create POST act_{id}/adrules_library; update POST /{ad_rule_id} ("provide all fields"; status alone needs no spec);
 * delete DELETE /{ad_rule_id}; change_spec limit "acts as an upper limit" for increases.
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  actor = {tenantId: 'meta-ad-rules', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture({policy = {enforcement: 'block', max_budget_native: 20000}} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 49).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  if (policy) saveSpendPolicy(store, owner, {gateway, account_id: '123', confirmed: true, policy});
  const objects = new Map([
    ['201', {id: '201', account_id: '123', name: 'Riyadh', status: 'ACTIVE', daily_budget: '5000', bid_amount: '200'}],
    ['202', {id: '202', account_id: '123', name: 'Jeddah', status: 'PAUSED', daily_budget: '3000', bid_amount: '150'}],
    ['301', {id: '301', account_id: '123', name: 'Brand', status: 'ACTIVE', daily_budget: '20000'}],
    ['999', {id: '999', account_id: '456', name: 'Elsewhere', status: 'ACTIVE', daily_budget: '1000'}],
  ]);
  const rules = new Map([
    [
      '701',
      {
        id: '701',
        account_id: '123',
        name: 'Pause costly',
        status: 'DISABLED',
        evaluation_spec: {
          evaluation_type: 'SCHEDULE',
          filters: [
            {field: 'entity_type', value: 'ADSET', operator: 'EQUAL'},
            {field: 'id', value: ['201'], operator: 'IN'},
            {field: 'time_preset', value: 'LAST_7_DAYS', operator: 'EQUAL'},
          ],
        },
        execution_spec: {
          execution_type: 'CHANGE_BUDGET',
          execution_options: [
            {field: 'change_spec', value: {amount: 20, unit: 'PERCENTAGE', limit: 9000}, operator: 'EQUAL'},
          ],
        },
        schedule_spec: {schedule_type: 'DAILY'},
      },
    ],
    ['709', {id: '709', account_id: '456', name: 'Foreign', status: 'ENABLED'}],
  ]);
  const calls = [];
  let writes = 0;
  const gone = () =>
    Response.json({error: {message: 'Unsupported get request.', code: 100, error_subcode: 33}}, {status: 400});
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      const raw = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      const b = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => {
          try {
            return [k, JSON.parse(v)];
          } catch {
            return [k, v];
          }
        }),
      );
      calls.push({method, path, query: Object.fromEntries(u.searchParams), body: b});
      if (method === 'GET') {
        if (path === '/v26.0/act_123') return Response.json({id: 'act_123', account_id: '123', currency: 'SAR'});
        const m = /^\/v26\.0\/(\d+)$/.exec(path);
        if (m && objects.has(m[1])) return Response.json(objects.get(m[1]));
        // Meta reads IDs back as numbers inside specs.
        if (m && rules.has(m[1])) {
          const r = structuredClone(rules.get(m[1]));
          for (const f of r.evaluation_spec?.filters ?? []) if (f.field === 'id') f.value = f.value.map(Number);
          return Response.json(r);
        }
        return gone();
      }
      writes++;
      if (method === 'POST' && path === '/v26.0/act_123/adrules_library') {
        const id = String(710 + writes);
        rules.set(id, {id, account_id: '123', ...b});
        return Response.json({id});
      }
      const m = /^\/v26\.0\/(\d+)$/.exec(path);
      if (method === 'POST' && m && rules.has(m[1])) {
        Object.assign(rules.get(m[1]), b);
        return Response.json({success: true});
      }
      if (method === 'DELETE' && m && rules.has(m[1])) {
        rules.delete(m[1]);
        return Response.json({success: true});
      }
      throw Error('Unexpected write ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (action, params, payload) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', params, ...(payload ? {payload} : {})}},
      actor,
    );
  const create = payload => prepare('meta_ad_account_id_adrules_library_create', {ad_account_id: '123'}, payload);
  const update = (id, payload) => prepare('meta_ad_rule_id_update', {ad_rule_id: id}, payload);
  const remove = id => prepare('meta_ad_rule_id_delete', {ad_rule_id: id});
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, rules, create, update, remove, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code, pattern) => {
  assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 900));
  if (pattern) assert.match(r.error.message, pattern);
};
const scheduled = (filters, execution, schedule = {schedule_type: 'DAILY'}) => ({
  name: 'Rule',
  status: 'ENABLED',
  evaluation_spec: {evaluation_type: 'SCHEDULE', filters},
  execution_spec: execution,
  schedule_spec: schedule,
});
const pause = scheduled(
  [
    {field: 'entity_type', value: 'ADSET', operator: 'EQUAL'},
    {field: 'time_preset', value: 'LAST_7_DAYS', operator: 'EQUAL'},
    {field: 'cost_per_mobile_app_install', value: 300, operator: 'GREATER_THAN'},
  ],
  {execution_type: 'PAUSE'},
);
const raise = (limit = 9000, ids = ['201', '202']) =>
  scheduled(
    [
      {field: 'entity_type', value: 'ADSET', operator: 'EQUAL'},
      {field: 'id', value: ids, operator: 'IN'},
      {field: 'time_preset', value: 'LAST_7_DAYS', operator: 'EQUAL'},
    ],
    {
      execution_type: 'CHANGE_BUDGET',
      execution_options: [
        {field: 'change_spec', value: {amount: 20, unit: 'PERCENTAGE', limit}, operator: 'EQUAL'},
        {field: 'execution_count_limit', value: 3, operator: 'EQUAL'},
      ],
    },
  );

test('a rule that pauses or notifies needs nothing more; it is read back', async () => {
  const f = fixture({policy: null});
  try {
    const p = ok(await f.create(pause));
    const impact = p.data.creative_impact;
    assert.equal(impact.raises_spend_or_delivery, false);
    assert.match(impact.acts_on, /including ones created later/);
    assert.match(impact.warning, /does not review each change it makes/);
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    const notify = ok(
      await f.create(
        scheduled(pause.evaluation_spec.filters, {
          execution_type: 'NOTIFICATION',
          execution_options: [{field: 'user_ids', value: ['1001'], operator: 'EQUAL'}],
        }),
      ),
    );
    ok(await f.execute(notify));
  } finally {
    f.store.close();
  }
});

test('a rule that raises budgets names its objects, carries a limit, needs a policy and confirmation', async () => {
  const bare = fixture({policy: null});
  try {
    refused(await bare.create(raise()), 'POLICY_REQUIRED');
  } finally {
    bare.store.close();
  }
  const f = fixture();
  try {
    const p = ok(await f.create(raise()));
    const impact = p.data.creative_impact;
    assert.equal(impact.raises_spend_or_delivery, true);
    assert.deepEqual(
      impact.worst_case.map(w => [w.id, w.key, w.before, w.after]),
      [
        ['201', 'daily_budget', 5000, 9000],
        ['202', 'daily_budget', 3000, 9000],
      ],
    );
    refused(await f.execute(p), 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    refused(await f.create(raise(25000)), 'POLICY_BUDGET_LIMIT');
    refused(await f.create(raise(9000, ['201', '999'])), 'STATE_TARGET_MISMATCH', /999/);
  } finally {
    f.store.close();
  }
});

test('shapes are refused before any request', async () => {
  const f = fixture();
  try {
    const noLimit = raise();
    noLimit.execution_spec.execution_options[0].value = {amount: 20, unit: 'PERCENTAGE'};
    const dynamicRaise = raise();
    dynamicRaise.evaluation_spec.filters = dynamicRaise.evaluation_spec.filters.filter(x => x.field !== 'id');
    const cases = [
      [{...pause, status: undefined}, /Name the status/],
      [{...pause, execution_spec: {execution_type: 'PING_ENDPOINT'}}, /AMCP runs no endpoint/],
      [noLimit, /needs change_spec.limit/],
      [dynamicRaise, /names the objects it acts on/],
      [
        scheduled([{field: 'time_preset', value: 'LAST_7_DAYS', operator: 'EQUAL'}], {execution_type: 'PAUSE'}),
        /entity_type or id filter/,
      ],
      [
        scheduled(
          pause.evaluation_spec.filters,
          {execution_type: 'PAUSE'},
          {schedule_type: 'CUSTOM', schedule: [{start_minute: 45}]},
        ),
        /multiple of 30/,
      ],
      [{...pause, evaluation_spec: {...pause.evaluation_spec, evaluation_type: 'TRIGGER'}}, /one trigger/],
      [
        {
          ...raise(),
          evaluation_spec: {
            evaluation_type: 'TRIGGER',
            trigger: {type: 'STATS_CHANGE', field: 'spent', value: 1000, operator: 'GREATER_THAN'},
            filters: raise().evaluation_spec.filters,
          },
          schedule_spec: undefined,
        },
        /runs only in SCHEDULE/,
      ],
      [{...pause, account_id: '123'}, /unqualified: account_id/],
    ];
    for (const [payload, pattern] of cases) {
      const r = await f.create(JSON.parse(JSON.stringify(payload)));
      refused(r, 'INVALID_META_AD_RULE', pattern);
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test("a rule is disabled, enabled with its objects bounded, and deleted through AMCP's mapped routes", async () => {
  const f = fixture();
  try {
    refused(await f.update('701', {status: 'DISABLED'}), 'INVALID_META_AD_RULE', /already DISABLED/);
    const on = ok(await f.update('701', {status: 'ENABLED'}));
    assert.equal(on.data.creative_impact.operation, 'enable');
    assert.deepEqual(
      on.data.creative_impact.worst_case.map(w => w.after),
      [9000],
    );
    ok(await f.execute(on, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(on)).data.status, 'verified');
    const off = ok(await f.update('701', {status: 'DISABLED'}));
    ok(await f.execute(off));
    refused(await f.update('709', {status: 'DISABLED'}), 'STATE_TARGET_MISMATCH');
    const d = ok(await f.remove('701'));
    assert.match(d.data.creative_impact.effect, /Changes it already made stay/);
    ok(await f.execute(d));
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    const rows = actionContracts(registry).filter(r => r.family === 'meta_ad_rules');
    assert.deepEqual(rows.map(r => r.action).sort(), [
      'meta_ad_account_id_adrules_library_create',
      'meta_ad_rule_id_delete',
      'meta_ad_rule_id_update',
    ]);
  } finally {
    f.store.close();
  }
});
