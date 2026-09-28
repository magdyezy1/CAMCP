import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Meta value rule sets (Marketing API "Value Rules", checked 2026-09-26): create, complete update and delete, checked
 * against the selected account's rule set list before and after.
 */
const gateway = 'meta_native_action',
  registry = new Registry();
const actor = {tenantId: 'meta-value-rules', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const crit = (type, values, types) => ({
  criteria_type: type,
  operator: 'CONTAINS',
  criteria_values: values,
  criteria_value_types: types ?? values.map(() => 'NONE'),
});
const rule = (name, sign, value, criterias, extra = {}) => ({
  name,
  adjust_sign: sign,
  adjust_value: value,
  criterias,
  ...extra,
});
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64')),
    c = {
      id: 'm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: [],
    };
  store.putConnection(owner, c, {accessToken: 'synthetic'});
  // Meta returns connections with paging cursors and lower-case gender values.
  let sets = [
    {
      id: '700',
      name: 'Core audiences',
      rules: [
        {
          id: '710',
          name: 'Young men',
          adjust_sign: 'INCREASE',
          adjust_value: 20,
          status: 'ACTIVE',
          criterias: [
            {
              id: '711',
              criteria_type: 'AGE',
              operator: 'CONTAINS',
              criteria_values: ['18-24'],
              criteria_value_types: ['NONE'],
            },
            {
              id: '712',
              criteria_type: 'GENDER',
              operator: 'CONTAINS',
              criteria_values: ['male'],
              criteria_value_types: ['NONE'],
            },
          ],
        },
      ],
    },
  ];
  let next = 800,
    writes = 0,
    reads = 0,
    mode = '';
  const calls = [];
  const edge = list => ({data: list, paging: {cursors: {before: 'b' + reads, after: 'a' + reads}}});
  const shown = () =>
    sets.map(s => ({id: s.id, name: s.name, rules: edge(s.rules.map(r => ({...r, criterias: edge(r.criterias)})))}));
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init.method;
      calls.push({path: u.pathname, method, query: Object.fromEntries(u.searchParams)});
      if (method === 'GET') {
        reads++;
        if (u.pathname === '/v25.0/act_123/value_rule_set')
          return Response.json({
            ...edge(shown()),
            ...(mode === 'paged'
              ? {paging: {next: 'https://graph.facebook.com/v25.0/act_123/value_rule_set?after=x'}}
              : {}),
          });
        throw new Error('Unexpected read ' + u.pathname);
      }
      writes++;
      const body = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      const withIds = list =>
        JSON.parse(list).map(r => ({
          ...r,
          id: r.id ?? String(next++),
          status: 'ACTIVE',
          criterias: r.criterias.map(x => ({
            ...x,
            id: x.id ?? String(next++),
            criteria_values:
              x.criteria_type === 'GENDER' ? x.criteria_values.map(v => v.toLowerCase()) : x.criteria_values,
          })),
        }));
      if (u.pathname === '/v25.0/act_123/value_rule_set') {
        const id = String(next++);
        sets.push({id, name: body.name, rules: withIds(body.rules)});
        return Response.json({id});
      }
      const del = /^\/v25\.0\/(\d+)\/delete_rule_set$/.exec(u.pathname);
      if (del) {
        sets = sets.filter(s => s.id !== del[1]);
        return Response.json({success: true});
      }
      const upd = /^\/v25\.0\/(\d+)$/.exec(u.pathname);
      if (upd) {
        const s = sets.find(x => x.id === upd[1]);
        s.name = body.name;
        s.rules = withIds(body.rules);
        return Response.json(mode === 'no_success' ? {} : {success: true});
      }
      throw new Error('Unexpected write ' + u.pathname);
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
  const prepare = (action, payload, params = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action, account_id: '123', params, ...(payload === undefined ? {} : {payload})},
      },
      actor,
    );
  const create = payload => prepare('meta_ad_account_id_value_rule_set_create', payload);
  const update = (id, payload) => prepare('meta_value_rule_set_id_update', payload, {value_rule_set_id: id});
  const remove = id => prepare('meta_value_rule_set_id_delete_rule_set_create', undefined, {value_rule_set_id: id});
  const list = () =>
    service.call(
      gateway,
      {
        action: 'meta_ad_account_id_value_rule_set_get',
        account_id: '123',
        params: {fields: 'id,name,rules{id,name,adjust_sign,adjust_value,status,criterias}'},
      },
      actor,
    );
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
  return {
    store,
    c,
    calls,
    create,
    update,
    remove,
    list,
    execute,
    verify,
    sets: () => sets,
    setSets: s => {
      sets = s;
    },
    writes: () => writes,
    mode: m => {
      mode = m;
    },
  };
}
const newSet = () => ({
  name: 'Placement and value',
  rules: [
    rule('Reels up', 'INCREASE', 30, [crit('PLACEMENT', ['IG_REELS', 'FB_REELS'])]),
    rule('Low value down', 'DECREASE', 25, [crit('AUDIENCE_LABEL', ['LOW_VALUE'])]),
    rule('UK and Alberta', 'INCREASE', 15, [crit('LOCATION', ['GB', '527'], ['LOCATION_COUNTRY', 'LOCATION_REGION'])]),
  ],
});

test('creating an unattached value rule set needs no spending confirmation, writes once and verifies', async () => {
  const f = fixture();
  try {
    const p = await f.create(newSet());
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'value_rule_set');
    assert.equal(impact.may_affect_serving, false);
    assert.equal(impact.sets_in_account, 1);
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 700));
    assert.equal(f.writes(), 1);
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 700));
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('a listed rule set is updated completely with confirmation, keeping rule and criteria IDs, and deleted with confirmation', async () => {
  const f = fixture();
  try {
    assert.equal((await f.list()).success, true);
    const body = {
      id: '700',
      name: 'Core audiences',
      rules: [
        rule(
          'Young men',
          'INCREASE',
          40,
          [crit('AGE', ['18-24', '25-34'], undefined), crit('GENDER', ['MALE'])].map((c, i) =>
            i === 0 ? {...c, id: '711'} : {...c, id: '712'},
          ),
          {id: '710', status: 'ACTIVE'},
        ),
        rule('iOS', 'INCREASE', 10, [crit('OS_TYPE', ['IOS'])]),
      ],
    };
    const u = await f.update('700', body);
    assert.equal(u.success, true, JSON.stringify(u).slice(0, 700));
    assert.equal(u.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(u)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(u, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(u)).data.status, 'verified');
    assert.equal(f.sets()[0].rules[0].id, '710');
    assert.equal(f.sets()[0].rules[0].adjust_value, 40);
    const d = await f.remove('700');
    assert.equal(d.success, true, JSON.stringify(d).slice(0, 500));
    assert.equal((await f.execute(d)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(d, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(d)).data.status, 'verified');
    assert.equal(f.sets().length, 0);
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('a full account, duplicate names, foreign rule and criteria IDs, no-op updates and unlisted sets are refused', async () => {
  const f = fixture();
  try {
    const dup = await f.create({...newSet(), name: 'core audiences'});
    assert.equal(dup.error?.code, 'CONFIGURATION_EXISTS');
    const unlisted = await f.update('700', {
      name: 'X',
      rules: [rule('A', 'INCREASE', 5, [crit('GENDER', ['FEMALE'])])],
    });
    assert.equal(unlisted.success, false);
    assert.match(unlisted.error.code, /RESOURCE_SCOPE_REQUIRED|ACCOUNT_SCOPE/);
    assert.equal((await f.list()).success, true);
    const foreignRule = await f.update('700', {
      name: 'Core audiences',
      rules: [rule('Young men', 'INCREASE', 20, [crit('AGE', ['18-24'])], {id: '999'})],
    });
    assert.equal(foreignRule.error?.code, 'STATE_NOT_FOUND', JSON.stringify(foreignRule).slice(0, 600));
    const foreignCriterion = await f.update('700', {
      name: 'Core audiences',
      rules: [rule('Young men', 'INCREASE', 20, [{...crit('AGE', ['18-24']), id: '999'}], {id: '710'})],
    });
    assert.equal(foreignCriterion.error?.code, 'STATE_NOT_FOUND', JSON.stringify(foreignCriterion).slice(0, 600));
    const retyped = await f.update('700', {
      name: 'Core audiences',
      rules: [rule('Young men', 'INCREASE', 20, [{...crit('AGE', ['18-24']), id: '712'}], {id: '710'})],
    });
    assert.equal(retyped.error?.code, 'INVALID_META_VALUE_RULE');
    assert.match(retyped.error.message, /is a GENDER criterion/);
    const same = await f.update('700', {
      name: 'Core audiences',
      rules: [
        rule(
          'Young men',
          'INCREASE',
          20,
          [
            {...crit('AGE', ['18-24']), id: '711'},
            {...crit('GENDER', ['MALE']), id: '712'},
          ],
          {id: '710'},
        ),
      ],
    });
    assert.equal(same.error?.code, 'INVALID_META_VALUE_RULE');
    assert.match(same.error.message, /does not change/);
    f.setSets(Array.from({length: 6}, (_, i) => ({id: String(900 + i), name: 'Set ' + i, rules: []})));
    const full = await f.create(newSet());
    assert.equal(full.error?.code, 'INVALID_META_VALUE_RULE');
    assert.match(full.error.message, /Meta allows 6/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('malformed rules and criteria fail locally without network requests', async () => {
  const one = r => ({name: 'Bad', rules: [r]});
  for (const [label, payload] of [
    ['increase over 1000%', one(rule('A', 'INCREASE', 1001, [crit('GENDER', ['MALE'])]))],
    ['decrease over 90%', one(rule('A', 'DECREASE', 91, [crit('GENDER', ['MALE'])]))],
    ['fractional percentage', one(rule('A', 'INCREASE', 12.5, [crit('GENDER', ['MALE'])]))],
    [
      'five criteria',
      one(
        rule('A', 'INCREASE', 5, [
          crit('AGE', ['18-24']),
          crit('GENDER', ['MALE']),
          crit('OS_TYPE', ['IOS']),
          crit('DEVICE_PLATFORM', ['MOBILE']),
          crit('PLACEMENT', ['FB_FEED']),
        ]),
      ),
    ],
    [
      'eleven rules',
      {
        name: 'Bad',
        rules: Array.from({length: 11}, (_, i) => rule('R' + i, 'INCREASE', 5, [crit('GENDER', ['MALE'])])),
      },
    ],
    ['DMA location', one(rule('A', 'INCREASE', 5, [crit('LOCATION', ['807'], ['LOCATION_DMA'])]))],
    ['65 as an upper age', one(rule('A', 'INCREASE', 5, [crit('AGE', ['18-65'])]))],
    ['unknown placement', one(rule('A', 'INCREASE', 5, [crit('PLACEMENT', ['THREADS_FEED'])]))],
    ['mismatched value types', one(rule('A', 'INCREASE', 5, [crit('GENDER', ['MALE', 'FEMALE'], ['NONE'])]))],
    ['same type twice', one(rule('A', 'INCREASE', 5, [crit('GENDER', ['MALE']), crit('GENDER', ['FEMALE'])]))],
    ['other operator', one(rule('A', 'INCREASE', 5, [{...crit('GENDER', ['MALE']), operator: 'EQUALS'}]))],
    ['rule id on create', one(rule('A', 'INCREASE', 5, [crit('GENDER', ['MALE'])], {id: '710'}))],
    [
      'duplicate rule names',
      {
        name: 'Bad',
        rules: [
          rule('A', 'INCREASE', 5, [crit('GENDER', ['MALE'])]),
          rule('a', 'DECREASE', 5, [crit('OS_TYPE', ['IOS'])]),
        ],
      },
    ],
  ]) {
    const f = fixture();
    try {
      const r = await f.create(payload);
      assert.equal(r.error?.code, 'INVALID_META_VALUE_RULE', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('owner policies: deletion is a removal, and edits and deletion change bidding; creation passes', async () => {
  const f = fixture();
  try {
    assert.equal((await f.list()).success, true);
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: false, allow_activation: true},
    });
    assert.equal((await f.remove('700')).error?.code, 'POLICY_DELETION_FORBIDDEN');
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: true, allow_activation: false},
    });
    assert.equal(
      (
        await f.update('700', {
          name: 'Core audiences',
          rules: [rule('Young men', 'INCREASE', 50, [{...crit('AGE', ['18-24']), id: '711'}], {id: '710'})],
        })
      ).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    assert.equal((await f.create(newSet())).success, true);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a paged list is never complete state, an update without success is not resubmitted, and later changes stop execution', async () => {
  {
    const f = fixture();
    try {
      f.mode('paged');
      const r = await f.create(newSet());
      assert.equal(r.error?.code, 'STATE_READ_FAILED', JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
  {
    const f = fixture();
    try {
      assert.equal((await f.list()).success, true);
      const u = await f.update('700', {
        name: 'Core audiences',
        rules: [rule('Young men', 'INCREASE', 50, [{...crit('AGE', ['18-24']), id: '711'}], {id: '710'})],
      });
      assert.equal(u.success, true);
      f.mode('no_success');
      assert.equal((await f.execute(u, {spend_change_confirmed: true})).success, false);
      assert.equal((await f.execute(u, {spend_change_confirmed: true})).data.replayed, true);
      assert.equal(f.writes(), 1);
      assert.equal((await f.verify(u)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const p = await f.create(newSet());
    assert.equal(p.success, true);
    f.setSets([...f.sets(), {id: '701', name: 'Added elsewhere', rules: []}]);
    assert.equal((await f.execute(p)).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
