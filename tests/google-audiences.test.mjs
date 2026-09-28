import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {googleAudienceCanonical} from '../dist/src/google-audiences.js';

/**
 * Google Ads audiences (v23 Audience in the pinned Discovery document; GAQL field reference checked 2026-09-26):
 * customer-scoped audience signals built from demographic dimensions and customer-owned segments. Read-back may
 * reorder repeated messages and omits false booleans, so both sides are compared in canonical form.
 */
const gateway = 'google_ads_native_action',
  actor = {tenantId: 'google-audiences', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const key = Buffer.alloc(32, 67).toString('base64'),
  GOOGLE = '99999999-9999-4999-8999-999999999999';
const list = id => ({userList: {userList: 'customers/123/userLists/' + id}});
const audience = (extra = {}) => ({
  name: 'Buyers signal',
  description: 'Past buyers aged 25-54',
  dimensions: [
    {
      audienceSegments: {
        segments: [list('77'), {customAudience: {customAudience: 'customers/123/customAudiences/88'}}],
      },
    },
    {
      age: {
        ageRanges: [
          {minAge: 25, maxAge: 34},
          {minAge: 35, maxAge: 54},
        ],
        includeUndetermined: false,
      },
    },
    {gender: {genders: ['FEMALE', 'MALE']}},
  ],
  exclusionDimension: {exclusions: [list('78')]},
  ...extra,
});
function fixture({readBack} = {}) {
  const store = new Store(':memory:', key),
    connection = {
      id: GOOGLE,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const records = new Map(),
    requests = [],
    writes = [];
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      const path = new URL(String(raw)).pathname,
        body = JSON.parse(String(init.body ?? '{}'));
      requests.push(path);
      if (path.endsWith('googleAds:search')) {
        if (/FROM customer /.test(body.query))
          return Response.json({
            results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}],
            fieldMask: 'customer.id',
          });
        const names = [...body.query.matchAll(/'(customers\/123\/audiences\/\d+)'/g)].map(m => m[1]);
        return Response.json({
          results: names
            .filter(n => records.has(n))
            .map(n => ({audience: readBack ? readBack(records.get(n)) : records.get(n)})),
          fieldMask: 'audience.resource_name',
        });
      }
      assert.equal(path, '/v25/customers/123/audiences:mutate');
      writes.push(path);
      const results = body.operations.map(op => {
        const name = op.update?.resourceName ?? 'customers/123/audiences/' + (500 + records.size);
        if (op.update) {
          const r = records.get(name);
          for (const f of op.updateMask.split(',')) r[f] = op.update[f];
        } else records.set(name, {resourceName: name, ...op.create, status: 'ENABLED', scope: 'CUSTOMER'});
        return {resourceName: name};
      });
      return Response.json({results});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = operations =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: GOOGLE,
      arguments: {action: 'google_ads_v23_audience_mutate_audiences', account_id: '123', payload: {operations}},
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
  return {store, records, requests, writes, call, prepare, execute, verify};
}

test('audience rules and customer-bound segments are enforced before any provider request', async () => {
  const f = fixture();
  try {
    const dims = d => audience({dimensions: d});
    const cases = {
      'asset group scope': audience({scope: 'ASSET_GROUP'}),
      'asset group': audience({assetGroup: 'customers/123/assetGroups/1'}),
      'no dimensions': audience({dimensions: undefined}),
      'empty dimensions': dims([]),
      'two kinds in one dimension': dims([{age: {ageRanges: [{minAge: 25}]}, gender: {genders: ['MALE']}}]),
      'unknown dimension': dims([{income: {incomeRanges: ['INCOME_RANGE_0_50']}}]),
      'repeated dimension type': dims([{gender: {genders: ['MALE']}}, {gender: {genders: ['FEMALE']}}]),
      'minimum age 20': dims([{age: {ageRanges: [{minAge: 20}]}}]),
      'maximum age 30': dims([{age: {ageRanges: [{minAge: 25, maxAge: 30}]}}]),
      'maximum below minimum': dims([{age: {ageRanges: [{minAge: 35, maxAge: 34}]}}]),
      'unknown gender': dims([{gender: {genders: ['OTHER']}}]),
      'duplicate income': dims([{householdIncome: {incomeRanges: ['INCOME_RANGE_90_UP', 'INCOME_RANGE_90_UP']}}]),
      'textual flag': dims([{parentalStatus: {parentalStatuses: ['PARENT'], includeUndetermined: 'yes'}}]),
      'segment of another customer': dims([
        {audienceSegments: {segments: [{userList: {userList: 'customers/999/userLists/77'}}]}},
      ]),
      'segment in wrong collection': dims([
        {audienceSegments: {segments: [{customAudience: {customAudience: 'customers/123/userLists/77'}}]}},
      ]),
      'segment with two members': dims([
        {audienceSegments: {segments: [{...list('77'), ...{lifeEvent: {lifeEvent: 'customers/123/lifeEvents/1'}}}]}},
      ]),
      'duplicate segment': dims([{audienceSegments: {segments: [list('77'), list('77')]}}]),
      'custom audience exclusion': audience({
        exclusionDimension: {exclusions: [{customAudience: {customAudience: 'customers/123/customAudiences/88'}}]},
      }),
    };
    // Layered refusals: the pinned Discovery schema (unknown fields, enums, types), the framework's required fields, then this contract.
    const codes = {};
    for (const [name, create] of Object.entries(cases)) {
      const r = await f.prepare([{create}]);
      assert.equal(r.success, false, name);
      codes[name] = r.error.code;
    }
    assert.deepEqual(Object.fromEntries(Object.entries(codes).filter(([, c]) => c !== 'INVALID_GOOGLE_AUDIENCE')), {
      'no dimensions': 'INVALID_CONFIGURATION_MUTATION',
      'unknown dimension': 'INVALID_VENDOR_BODY',
      'unknown gender': 'INVALID_VENDOR_BODY',
      'textual flag': 'INVALID_VENDOR_BODY',
      'custom audience exclusion': 'INVALID_VENDOR_BODY',
    });
    const removal = await f.prepare([{remove: 'customers/123/audiences/500'}]);
    assert.equal(removal.success, false, 'the audience service documents no remove');
    assert.equal(f.requests.length, 0, 'validation happens before any read or write');
  } finally {
    f.store.close();
  }
});

test('canonical form ignores order and omitted false defaults but keeps every value', () => {
  const sent = googleAudienceCanonical(audience());
  const read = googleAudienceCanonical({
    ...audience(),
    dimensions: [
      {gender: {genders: ['MALE', 'FEMALE']}},
      {
        age: {
          ageRanges: [
            {minAge: 35, maxAge: 54},
            {minAge: 25, maxAge: 34},
          ],
        },
      },
      {
        audienceSegments: {
          segments: [{customAudience: {customAudience: 'customers/123/customAudiences/88'}}, list('77')],
        },
      },
    ],
  });
  assert.deepEqual(read, sent);
  assert.notDeepEqual(
    googleAudienceCanonical(
      audience({dimensions: [{age: {ageRanges: [{minAge: 25, maxAge: 34}], includeUndetermined: true}}]}),
    ),
    googleAudienceCanonical(audience({dimensions: [{age: {ageRanges: [{minAge: 25, maxAge: 34}]}}]})),
    'a true flag is configuration',
  );
});

test('an audience created once verifies when Google reorders dimensions and omits false flags; an update needs spend confirmation', async () => {
  const reorder = r => ({
    ...r,
    dimensions: [...r.dimensions].reverse().map(d => (d.age ? {age: {ageRanges: [...d.age.ageRanges].reverse()}} : d)),
  });
  const f = fixture({readBack: reorder});
  try {
    const p = await f.prepare([{create: audience()}]);
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(
      p.data.creative_impact?.may_affect_serving ?? false,
      false,
      'a new audience is not attached to anything yet',
    );
    const done = await f.execute(p);
    assert.equal(done.success, true, JSON.stringify(done));
    const verified = await f.verify(p);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes.length, 1);
    const name = done.data.data.results[0].resourceName,
      u = await f.prepare([
        {update: {resourceName: name, dimensions: [{gender: {genders: ['FEMALE']}}]}, updateMask: 'dimensions'},
      ]);
    assert.equal(u.success, true, JSON.stringify(u));
    assert.equal(
      u.data.creative_impact.may_affect_serving,
      true,
      'an existing audience may already signal an asset group',
    );
    assert.equal((await f.execute(u)).error.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes.length, 1);
    assert.equal((await f.execute(u, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(u)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('an audience that reads back with another age range stays inconclusive', async () => {
  const f = fixture({
    readBack: r => ({
      ...r,
      dimensions: r.dimensions.map(d => (d.age ? {age: {ageRanges: [{minAge: 18, maxAge: 24}]}} : d)),
    }),
  });
  try {
    const p = await f.prepare([{create: audience()}]);
    await f.execute(p);
    const verified = await f.verify(p);
    assert.equal(verified.data.status, 'inconclusive', JSON.stringify(verified));
    assert.deepEqual(verified.data.checks[0].changed_fields, ['/dimensions']);
  } finally {
    f.store.close();
  }
});
