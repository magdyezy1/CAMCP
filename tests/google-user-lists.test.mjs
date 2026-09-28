import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Rule-based Google Ads user lists (v23, checked 2026-09-26). Google reads 64-bit numbers back as strings, fills the
 * OR_OF_ANDS default, may reorder operands and moves prepopulation from REQUESTED to FINISHED.
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  actor = {tenantId: 'google-user-lists', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const name = id => 'customers/123/userLists/' + id;
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const get = (o, key) => key.split('.').reduce((v, k) => v?.[camel(k)], o);
const set = (o, key, value) => {
  const keys = key.split('.').map(camel);
  let t = o;
  for (const k of keys.slice(0, -1)) t = t[k] ??= {};
  t[keys.at(-1)] = structuredClone(value);
};
const url = (value, operator = 'CONTAINS') => ({name: 'url__', stringRuleItem: {operator, value}});
const operand = (items, days = 30) => ({rule: {ruleItemGroups: [{ruleItems: items}]}, lookbackWindowDays: days});
const list = (extra = {}, rules = {}) => ({
  name: 'Cart abandoners',
  description: 'Visited the cart, did not buy',
  membershipStatus: 'OPEN',
  ruleBasedUserList: {
    prepopulationStatus: 'REQUESTED',
    flexibleRuleUserList: {
      inclusiveRuleOperator: 'OR',
      inclusiveOperands: [
        operand([url('/cart')], 30),
        operand(
          [
            url('/checkout', 'STARTS_WITH'),
            {name: 'basket_value', numberRuleItem: {operator: 'GREATER_THAN', value: 50}},
          ],
          14,
        ),
      ],
      exclusiveOperands: [operand([url('/thank-you')], 30)],
      ...rules,
    },
  },
  ...extra,
});
function fixture({readBack} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 84).toString('base64')),
    records = new Map(),
    requests = [],
    writes = [];
  let n = 500,
    mode = '';
  const connection = {
    id: 'google',
    tenantId: actor.tenantId,
    gateway,
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  store.putConnection(owner, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  records.set(name('77'), {
    resourceName: name('77'),
    name: 'Existing visitors',
    membershipStatus: 'OPEN',
    type: 'RULE_BASED',
    readOnly: false,
    ruleBasedUserList: {
      flexibleRuleUserList: {
        inclusiveRuleOperator: 'AND',
        inclusiveOperands: [
          {
            rule: {ruleType: 'OR_OF_ANDS', ruleItemGroups: [{ruleItems: [url('example.com')]}]},
            lookbackWindowDays: '30',
          },
        ],
      },
    },
  });
  records.set(name('78'), {
    resourceName: name('78'),
    name: 'Shared list',
    membershipStatus: 'OPEN',
    type: 'RULE_BASED',
    readOnly: true,
  });
  records.set(name('79'), {
    resourceName: name('79'),
    name: 'Customer file',
    membershipStatus: 'OPEN',
    type: 'CRM_BASED',
    readOnly: false,
  });
  const transport = new NativeTransport(
    async (raw, init) => {
      const path = new URL(String(raw)).pathname,
        body = JSON.parse(String(init?.body));
      requests.push(path);
      if (path.endsWith('googleAds:search')) {
        const m = /^SELECT (.+) FROM ([a-z_]+)/.exec(body.query),
          entity = m[2];
        if (entity === 'customer')
          return Response.json({
            results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}],
            fieldMask: m[1],
          });
        const rows = [...body.query.matchAll(/'(customers\/[^']+)'/g)]
          .map(x => records.get(x[1]))
          .filter(Boolean)
          .map(r => {
            const p = {};
            for (const f of m[1].split(', ')) {
              const v = get(readBack ? readBack(structuredClone(r)) : r, f.slice(entity.length + 1));
              if (v !== undefined && v !== '') set(p, f.slice(entity.length + 1), v);
            }
            return {[camel(entity)]: p};
          });
        return Response.json({...(rows.length ? {results: rows} : {}), fieldMask: m[1]});
      }
      assert.equal(path, '/v25/customers/123/userLists:mutate');
      writes.push(body);
      const results = body.operations.map(op => {
        if (op.update) {
          const r = records.get(op.update.resourceName);
          for (const f of op.updateMask.split(',')) r[f] = op.update[f];
          return {resourceName: r.resourceName};
        }
        const id = name(String(n++)),
          c = structuredClone(op.create),
          f = c.ruleBasedUserList.flexibleRuleUserList;
        // Google's own read-back form: 64-bit numbers as strings, the default rule type, its own order, prepopulation finished.
        for (const k of ['inclusiveOperands', 'exclusiveOperands'])
          if (f[k])
            f[k] = f[k]
              .map(o => ({
                ...o,
                lookbackWindowDays: String(o.lookbackWindowDays),
                rule: {ruleType: 'OR_OF_ANDS', ...o.rule},
              }))
              .reverse();
        if (c.ruleBasedUserList.prepopulationStatus) c.ruleBasedUserList.prepopulationStatus = 'FINISHED';
        records.set(id, {...c, resourceName: id, type: 'RULE_BASED', readOnly: false});
        return {resourceName: id};
      });
      if (mode === 'lost') throw new Error('Synthetic response lost after the provider mutation');
      return Response.json({results});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool, input) => service.call(tool, input, actor);
  const args = (operations, action = 'google_ads_v23_user_list_mutate_user_lists') => ({
    action,
    account_id: '123',
    payload: {operations},
  });
  const prepare = (operations, action) =>
    call('amcp_write', {action: 'prepare', gateway, arguments: args(operations, action)});
  const execute = (p, extra = {}) =>
    call('amcp_write', {
      action: 'execute',
      review_id: p.data.review_id,
      idempotency_key: p.data.idempotency_key,
      confirmed: true,
      ...extra,
    });
  const verify = p => call('amcp_campaign', {action: 'verify', review_id: p.data.review_id});
  return {
    store,
    records,
    requests,
    writes,
    call,
    args,
    prepare,
    execute,
    verify,
    mode: v => {
      mode = v;
    },
  };
}

test('rule-based user list creation is a reviewed Google configuration under its action names', async () => {
  const f = fixture();
  try {
    for (const action of ['google_ads_v23_user_list_mutate_user_lists', 'CREATE_USER_LIST']) {
      const r = await f.call('amcp_write', {action: 'inspect', gateway, arguments: f.args([{create: list()}], action)});
      assert.equal(r.data.review_contract_supported, true, action + ' ' + JSON.stringify(r).slice(0, 400));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only open rule-based lists with explicit operators and lookback windows are accepted, before any request', async () => {
  const f = fixture();
  try {
    const flex = rules => list({}, rules),
      first = o => list({}, {inclusiveOperands: [o]});
    const cases = {
      'customer match': [
        {create: {name: 'Customers', membershipStatus: 'OPEN', crmBasedUserList: {uploadKeyType: 'CONTACT_INFO'}}},
        /Customer Match/,
      ],
      'lookalike': [
        {create: {name: 'Similar', membershipStatus: 'OPEN', lookalikeUserList: {seedUserListIds: ['77']}}},
        /lookalikeUserList/,
      ],
      'membership life span': [{create: list({membershipLifeSpan: 540})}, /membershipLifeSpan is ignored/],
      'removal': [{remove: name('77')}, /removal is not qualified/],
      'closed at creation': [{create: list({membershipStatus: 'CLOSED'})}, /OPEN/],
      'no lookback window': [
        {create: first({rule: {ruleItemGroups: [{ruleItems: [url('/cart')]}]}})},
        /lookbackWindowDays/,
      ],
      'lookback over 540 days': [{create: first(operand([url('/cart')], 541))}, /1-540 days/],
      'AND of ORs': [
        {
          create: first({
            rule: {ruleType: 'AND_OF_ORS', ruleItemGroups: [{ruleItems: [url('/cart')]}]},
            lookbackWindowDays: 30,
          }),
        },
        /OR_OF_ANDS/,
      ],
      'date value and offset': [
        {
          create: first(
            operand([{name: 'visit_date', dateRuleItem: {operator: 'AFTER', value: '2026-01-01', offsetInDays: '7'}}]),
          ),
        },
        /not both/,
      ],
      'quote in a URL rule': [{create: first(operand([url('/cart"')]))}, /quotes/],
      'digit first name': [
        {create: first(operand([{name: '1price', numberRuleItem: {operator: 'EQUALS', value: 1}}]))},
        /tag parameter name/,
      ],
      'text as number': [
        {create: first(operand([{name: 'price', numberRuleItem: {operator: 'EQUALS', value: '50'}}]))},
        /Discovery contract/,
        'INVALID_VENDOR_BODY',
      ],
      'no inclusive rules': [{create: flex({inclusiveOperands: []})}, /inclusiveOperands/],
      'no operator': [{create: flex({inclusiveRuleOperator: undefined})}, /AND or OR/],
      'finished prepopulation': [
        {create: list({ruleBasedUserList: {...list().ruleBasedUserList, prepopulationStatus: 'FINISHED'}})},
        /REQUESTED/,
      ],
    };
    // The Discovery schema refuses a wrong JSON type first; the user list contract refuses the rest.
    for (const [label, [op, message, code = 'INVALID_GOOGLE_USER_LIST']] of Object.entries(cases)) {
      const clean = JSON.parse(JSON.stringify(op)),
        r = await f.prepare([clean]);
      assert.equal(r.error?.code, code, label + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300));
      assert.match(r.error.message, message, label);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a list is created from the reviewed rules and verifies against Google read-back form', async () => {
  const f = fixture();
  try {
    const p = await f.prepare([{create: list()}]);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
    const impact = p.data.creative_impact;
    assert.equal(impact.may_affect_serving, false);
    assert.deepEqual(impact.lists[0].lookback_window_days, [30, 14]);
    assert.equal(impact.lists[0].exclusive_rules, 1);
    assert.match(impact.lists[0].prepopulation, /30 days/);
    const x = await f.execute(p);
    assert.equal(x.success, true, JSON.stringify(x).slice(0, 400));
    assert.equal(f.writes.length, 1);
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 800));
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('renaming needs no confirmation; closing a list needs spending confirmation; read-only and non-rule lists are not edited', async () => {
  const f = fixture();
  try {
    const rename = await f.prepare([{update: {resourceName: name('77'), name: 'Site visitors'}, updateMask: 'name'}]);
    assert.equal(rename.success, true, JSON.stringify(rename).slice(0, 400));
    assert.equal(rename.data.creative_impact.may_affect_serving, false);
    assert.equal((await f.execute(rename)).success, true);
    assert.equal((await f.verify(rename)).data.status, 'verified');
    const close = await f.prepare([
      {update: {resourceName: name('77'), membershipStatus: 'CLOSED'}, updateMask: 'membershipStatus'},
    ]);
    assert.equal(close.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(close)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(close, {spend_change_confirmed: true})).success, true);
    for (const id of ['78', '79']) {
      const r = await f.prepare([{update: {resourceName: name(id), name: 'Renamed'}, updateMask: 'name'}]);
      assert.equal(r.error?.code, 'INVALID_GOOGLE_USER_LIST', id + ' ' + JSON.stringify(r.error));
    }
    assert.equal(f.writes.length, 2);
  } finally {
    f.store.close();
  }
});

test('a changed rule read-back is inconclusive; a lost response is never resubmitted', async () => {
  const d = fixture({
    readBack: r => {
      const o = r.ruleBasedUserList?.flexibleRuleUserList?.inclusiveOperands;
      if (o?.[0]) o[0].lookbackWindowDays = '7';
      return r;
    },
  });
  try {
    const p = await d.prepare([{create: list()}]);
    assert.equal((await d.execute(p)).success, true);
    const v = await d.verify(p);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v).slice(0, 600));
  } finally {
    d.store.close();
  }
  const f = fixture();
  try {
    const p = await f.prepare([{create: list()}]);
    f.mode('lost');
    assert.equal((await f.execute(p)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.mode('');
    assert.equal((await f.execute(p)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});
