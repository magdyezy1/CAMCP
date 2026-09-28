import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Google Ads conversion value rules and rule sets (v23, checked 2026-09-26). A set applies the first matching rule in
 * list order, so rule order is compared as sent; conditions are sets. Sets change value-based bidding.
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  actor = {tenantId: 'google-value-rules', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const rule = id => 'customers/123/conversionValueRules/' + id,
  set_ = id => 'customers/123/conversionValueRuleSets/' + id;
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const get = (o, key) => key.split('.').reduce((v, k) => v?.[camel(k)], o);
const put = (o, key, value) => {
  const keys = key.split('.').map(camel);
  let t = o;
  for (const k of keys.slice(0, -1)) t = t[k] ??= {};
  t[keys.at(-1)] = structuredClone(value);
};
function fixture({readBack} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 86).toString('base64')),
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
  const seed = (name, value) => records.set(name, {resourceName: name, ...value});
  seed(rule('901'), {
    action: {operation: 'MULTIPLY', value: 1.5},
    deviceCondition: {deviceTypes: ['MOBILE', 'TABLET']},
    status: 'ENABLED',
  });
  seed(rule('902'), {
    action: {operation: 'ADD', value: 10},
    geoLocationCondition: {geoTargetConstants: ['geoTargetConstants/2840'], geoMatchType: 'ANY'},
    status: 'ENABLED',
  });
  seed(rule('903'), {
    action: {operation: 'ADD', value: 4},
    audienceCondition: {userLists: ['customers/123/userLists/77']},
    status: 'ENABLED',
  });
  seed(rule('904'), {
    action: {operation: 'ADD', value: 2},
    deviceCondition: {deviceTypes: ['DESKTOP']},
    status: 'REMOVED',
  });
  seed(set_('950'), {
    conversionValueRules: [rule('901')],
    dimensions: ['DEVICE'],
    attachmentType: 'CUSTOMER',
    status: 'ENABLED',
  });
  seed('customers/123/campaigns/100', {
    name: 'Campaign',
    status: 'PAUSED',
    advertisingChannelType: 'SEARCH',
    campaignBudget: 'customers/123/campaignBudgets/50',
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
            const src = readBack ? readBack(structuredClone(r)) : r,
              p = {};
            for (const f of m[1].split(', ')) {
              const v = get(src, f.slice(entity.length + 1));
              if (v !== undefined && v !== '') put(p, f.slice(entity.length + 1), v);
            }
            return {[camel(entity)]: p};
          });
        return Response.json({...(rows.length ? {results: rows} : {}), fieldMask: m[1]});
      }
      writes.push({path, body});
      const kind = path.split('/').at(-1).replace(':mutate', '');
      const results = body.operations.map(op => {
        if (op.remove) {
          records.delete(op.remove);
          return {resourceName: op.remove};
        }
        if (op.update) {
          const r = records.get(op.update.resourceName);
          for (const f of op.updateMask.split(',')) r[f] = op.update[f];
          return {resourceName: r.resourceName};
        }
        const id = 'customers/123/' + kind + '/' + n++,
          c = structuredClone(op.create);
        // Google's read-back form: device and location lists in its own order.
        if (c.deviceCondition) c.deviceCondition.deviceTypes = [...c.deviceCondition.deviceTypes].reverse();
        records.set(id, {...c, resourceName: id, status: 'ENABLED'});
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
  const action = kind =>
    kind === 'sets'
      ? 'google_ads_v23_conversion_value_rule_set_mutate_conversion_value_rule_sets'
      : 'google_ads_v23_conversion_value_rule_mutate_conversion_value_rules';
  const prepare = (kind, operations) =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      arguments: {action: action(kind), account_id: '123', payload: {operations}},
    });
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
    prepare,
    execute,
    verify,
    mode: v => {
      mode = v;
    },
  };
}

test('rules and rule sets are reviewed Google configuration routes', async () => {
  const f = fixture();
  try {
    for (const [kind, op] of [
      ['rules', {create: {action: {operation: 'ADD', value: 5}}}],
      ['sets', {create: {conversionValueRules: [rule('901')], dimensions: ['DEVICE'], attachmentType: 'CUSTOMER'}}],
    ]) {
      const r = await f.call('amcp_write', {
        action: 'inspect',
        gateway,
        arguments: {
          action:
            kind === 'sets'
              ? 'google_ads_v23_conversion_value_rule_set_mutate_conversion_value_rule_sets'
              : 'google_ads_v23_conversion_value_rule_mutate_conversion_value_rules',
          account_id: '123',
          payload: {operations: [op]},
        },
      });
      assert.equal(r.data.review_contract_supported, true, kind + ' ' + JSON.stringify(r).slice(0, 300));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only documented ADD and MULTIPLY rules with at most two conditions are accepted, before any request', async () => {
  const f = fixture();
  try {
    const device = {deviceTypes: ['MOBILE']},
      geo = {geoTargetConstants: ['geoTargetConstants/2840'], geoMatchType: 'ANY'},
      audience = {userLists: ['customers/123/userLists/77']};
    const cases = {
      'SET': [{action: {operation: 'SET', value: 10}}, /SET actions/],
      'zero ADD': [{action: {operation: 'ADD', value: 0}}, /positive/],
      'MULTIPLY above 10': [{action: {operation: 'MULTIPLY', value: 12}}, /0.5 to 10/],
      'MULTIPLY below 0.5': [{action: {operation: 'MULTIPLY', value: 0.4}}, /0.5 to 10/],
      'three conditions': [
        {
          action: {operation: 'ADD', value: 1},
          deviceCondition: device,
          geoLocationCondition: geo,
          audienceCondition: audience,
        },
        /at most two/,
      ],
      'itinerary': [
        {action: {operation: 'ADD', value: 1}, itineraryCondition: {travelLength: {minNights: 1}}},
        /allowlist-only/,
      ],
      'another customer audience': [
        {action: {operation: 'ADD', value: 1}, audienceCondition: {userLists: ['customers/999/userLists/77']}},
        /distinct resource names/,
      ],
      'geo without match type': [
        {action: {operation: 'ADD', value: 1}, geoLocationCondition: {geoTargetConstants: ['geoTargetConstants/2840']}},
        /geoMatchType/,
      ],
      'removed status': [{action: {operation: 'ADD', value: 1}, status: 'REMOVED'}, /ENABLED or PAUSED/],
    };
    for (const [label, [create, message]] of Object.entries(cases)) {
      const r = await f.prepare('rules', [{create}]);
      assert.equal(
        r.error?.code,
        'INVALID_GOOGLE_VALUE_RULE',
        label + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
      assert.match(r.error.message, message, label);
    }
    const sets = {
      'store categories': [
        {
          create: {
            conversionValueRules: [rule('901')],
            dimensions: ['DEVICE'],
            attachmentType: 'CUSTOMER',
            conversionActionCategories: ['STORE_VISIT'],
          },
        },
        /conversionActionCategories/,
      ],
      'NO_CONDITION': [
        {create: {conversionValueRules: [rule('901')], dimensions: ['NO_CONDITION'], attachmentType: 'CUSTOMER'}},
        /NO_CONDITION/,
      ],
      'three dimensions': [
        {
          create: {
            conversionValueRules: [rule('901')],
            dimensions: ['DEVICE', 'AUDIENCE', 'GEO_LOCATION'],
            attachmentType: 'CUSTOMER',
          },
        },
        /one or two/,
      ],
      'campaign set without campaign': [
        {create: {conversionValueRules: [rule('901')], dimensions: ['DEVICE'], attachmentType: 'CAMPAIGN'}},
        /exactly when/,
      ],
    };
    for (const [label, [op, message]] of Object.entries(sets)) {
      const r = await f.prepare('sets', [op]);
      assert.equal(
        r.error?.code,
        'INVALID_GOOGLE_VALUE_RULE',
        label + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
      assert.match(r.error.message, message, label);
    }
    const dims = await f.prepare('sets', [
      {update: {resourceName: set_('950'), dimensions: ['DEVICE', 'GEO_LOCATION']}, updateMask: 'dimensions'},
    ]);
    assert.equal(dims.error?.code, 'INVALID_CONFIGURATION_MUTATION');
    assert.match(dims.error.message, /Restate conversionValueRules/);
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a new rule needs no confirmation and verifies with conditions as sets; editing a rule needs spending confirmation', async () => {
  const f = fixture();
  try {
    const p = await f.prepare('rules', [
      {create: {action: {operation: 'MULTIPLY', value: 1.2}, deviceCondition: {deviceTypes: ['MOBILE', 'TABLET']}}},
    ]);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 400));
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.verify(p)).data.status, 'verified');
    const edit = await f.prepare('rules', [
      {update: {resourceName: rule('901'), action: {operation: 'MULTIPLY', value: 2}}, updateMask: 'action'},
    ]);
    assert.equal(edit.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(edit)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(edit, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(edit)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('a rule set reads its rules, keeps their order and needs every rule to fit its dimensions', async () => {
  const f = fixture();
  try {
    const create = {
      conversionValueRules: [rule('902'), rule('901')],
      dimensions: ['GEO_LOCATION', 'DEVICE'],
      attachmentType: 'CAMPAIGN',
      campaign: 'customers/123/campaigns/100',
    };
    const p = await f.prepare('sets', [{create}]);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 500));
    assert.deepEqual(p.data.creative_impact.items[0].rules_in_order, [rule('902'), rule('901')]);
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(p)).data.status, 'verified');
    for (const [op, code, message] of [
      [
        {create: {conversionValueRules: [rule('903')], dimensions: ['DEVICE'], attachmentType: 'CUSTOMER'}},
        'INVALID_GOOGLE_VALUE_RULE',
        /AUDIENCE conditions/,
      ],
      [
        {create: {conversionValueRules: [rule('904')], dimensions: ['DEVICE'], attachmentType: 'CUSTOMER'}},
        'INVALID_GOOGLE_VALUE_RULE',
        /is removed/,
      ],
      [
        {
          update: {resourceName: set_('950'), conversionValueRules: [rule('901'), rule('902')]},
          updateMask: 'conversionValueRules',
        },
        'INVALID_GOOGLE_VALUE_RULE',
        /GEO_LOCATION conditions/,
      ],
    ]) {
      const r = await f.prepare('sets', [op]);
      assert.equal(r.error?.code, code, JSON.stringify(r.error));
      assert.match(r.error.message, message);
    }
    const missing = await f.prepare('sets', [
      {create: {conversionValueRules: [rule('999')], dimensions: ['DEVICE'], attachmentType: 'CUSTOMER'}},
    ]);
    assert.notEqual(missing.success, true);
  } finally {
    f.store.close();
  }
});

test('a rule set read back in another order is inconclusive; removal needs confirmation; a lost response is never resubmitted', async () => {
  const d = fixture({
    readBack: r =>
      r.resourceName.includes('RuleSets') && Array.isArray(r.conversionValueRules)
        ? {...r, conversionValueRules: [...r.conversionValueRules].reverse()}
        : r,
  });
  try {
    const p = await d.prepare('sets', [
      {
        create: {
          conversionValueRules: [rule('902'), rule('901')],
          dimensions: ['GEO_LOCATION', 'DEVICE'],
          attachmentType: 'CUSTOMER',
        },
      },
    ]);
    assert.equal((await d.execute(p, {spend_change_confirmed: true})).success, true);
    const v = await d.verify(p);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v).slice(0, 600));
  } finally {
    d.store.close();
  }
  const f = fixture();
  try {
    const r = await f.prepare('sets', [{remove: set_('950')}]);
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 300));
    assert.equal((await f.execute(r)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    const p = await f.prepare('rules', [{create: {action: {operation: 'ADD', value: 3}}}]);
    f.mode('lost');
    assert.equal((await f.execute(p)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.mode('');
    assert.equal((await f.execute(p)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});
