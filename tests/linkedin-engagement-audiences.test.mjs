import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * LinkedIn engagement retargeting audiences (Engagement Retargeting and DMP Segments pages, li-lms-2026-09, read
 * 2026-09-30): DMP segments of type USER with an engagement source platform, and their engagement rules.
 */
const registry = new Registry(),
  gateway = 'linkedin_native_action';
const actor = {tenantId: 'linkedin-engagement', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const actions = {
  create: 'linkedin_rest_dmp_segments_post',
  update: 'linkedin_rest_dmp_segments_segment_id_post',
  remove: 'linkedin_rest_dmp_segments_segment_id_delete',
  removeMany: 'linkedin_rest_dmp_segments_delete',
  addRules: 'linkedin_rest_dmp_segments_segment_id_engagement_rules_post',
  removeRule: 'linkedin_rest_dmp_segments_segment_id_engagement_rules_engagement_rule_id_delete',
  removeRules: 'linkedin_rest_dmp_segments_segment_id_engagement_rules_delete',
};
const acct = 'urn:li:sponsoredAccount:507',
  camp = id => 'urn:li:sponsoredCampaign:' + id,
  trigger = (type, t) => 'urn:li:dmpEngagementTrigger:(urn:li:dmpEngagementSourceType:' + type + ',' + t + ')',
  span = days => ({timeSpan: {duration: days, unit: 'DAY'}});
const video = (campaign, days = 90, t = 'FIRST_QUARTILE') => ({
  engagementSource: camp(campaign),
  engagementTrigger: trigger('VIDEO_ADS', t),
  timeFrame: span(days),
});
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 95).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'li',
      tenantId: actor.tenantId,
      gateway,
      enabled: true,
      accounts: ['507'],
      writeAccounts: ['507'],
      scopes: ['rw_ads'],
      label: 'Synthetic LinkedIn',
    },
    {accessToken: 'synthetic'},
  );
  const campaigns = new Map([
    [31, {status: 'ACTIVE', name: 'Video launch', targetingCriteria: {include: {and: []}}}],
    [32, {status: 'PAUSED', name: 'Video teaser', targetingCriteria: {include: {and: []}}}],
    [
      33,
      {
        status: 'ACTIVE',
        name: 'Retargeting',
        targetingCriteria: {
          include: {and: [{or: {'urn:li:adTargetingFacet:audienceMatchingSegments': ['urn:li:adSegment:9002']}}]},
        },
      },
    ],
  ]);
  const segment = (id, platform, extra = {}) => ({
    account: acct,
    name: 'Segment ' + id,
    type: 'USER',
    sourcePlatform: platform,
    destinations: [
      {destination: 'LINKEDIN', status: 'READY', destinationSegmentId: 'urn:li:adSegment:' + (9000 + id - 100)},
    ],
    ...extra,
  });
  const segments = new Map([
    [100, segment(100, 'VIDEO_ADS')],
    [101, segment(101, 'VIDEO_ADS')],
    [102, segment(102, 'VIDEO_ADS')],
    [103, segment(103, 'LIST_UPLOAD')],
    [104, segment(104, 'VIDEO_ADS', {account: 'urn:li:sponsoredAccount:999'})],
  ]);
  const rules = new Map([
    [100, [{id: 5001, ...video(31)}]],
    [101, []],
    [102, []],
  ]);
  let nextSegment = 200,
    nextRule = 6000,
    writes = 0;
  const calls = [];
  const notFound = () => Response.json({status: 404, serviceErrorCode: 100, message: 'Not found'}, {status: 404});
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET',
      headers = new Headers(init?.headers);
    calls.push({method, path: url.pathname, search: url.search});
    assert.equal(headers.get('x-restli-protocol-version'), '2.0.0');
    if (method === 'GET' && url.pathname === '/rest/adAccounts/507') return Response.json({id: 507, status: 'ACTIVE'});
    if (method === 'GET' && url.pathname === '/rest/adAccounts/507/adCampaigns') {
      assert.equal(url.searchParams.get('q'), 'search');
      const rows = [...campaigns].map(([id, c]) => ({id, account: acct, ...c}));
      return Response.json({elements: rows, metadata: {}});
    }
    let m = /^\/rest\/adAccounts\/507\/adCampaigns\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && m)
      return campaigns.has(Number(m[1]))
        ? Response.json({id: Number(m[1]), account: acct, ...campaigns.get(Number(m[1]))})
        : notFound();
    m = /^\/rest\/dmpSegments\/(\d+)\/engagementRules$/.exec(url.pathname);
    if (method === 'GET' && m)
      return Response.json({
        elements: (rules.get(Number(m[1])) ?? []).map(r => ({...r, dmpSegmentId: Number(m[1])})),
        paging: {start: 0, count: 10},
      });
    if (method === 'POST' && m) {
      writes++;
      const b = JSON.parse(String(init.body)),
        list = b.elements ?? [b],
        made = list.map(r => ({id: nextRule++, ...r}));
      if (o.mode !== 'ignore') rules.set(Number(m[1]), [...(rules.get(Number(m[1])) ?? []), ...made]);
      if (b.elements) {
        assert.equal(headers.get('x-restli-method'), 'BATCH_CREATE');
        return Response.json({elements: made.map(r => ({id: String(r.id), status: 201}))});
      }
      return new Response(null, {status: 201, headers: {'x-restli-id': String(made[0].id)}});
    }
    if (method === 'DELETE' && m) {
      writes++;
      assert.equal(headers.get('x-restli-method'), 'BATCH_DELETE');
      const ids = /^List\((.*)\)$/.exec(url.searchParams.get('ids'))[1].split(',');
      if (o.mode !== 'ignore')
        rules.set(
          Number(m[1]),
          rules.get(Number(m[1])).filter(r => !ids.includes(String(r.id))),
        );
      return Response.json({results: Object.fromEntries(ids.map(id => [id, {status: 204}])), errors: {}});
    }
    m = /^\/rest\/dmpSegments\/(\d+)\/engagementRules\/(\d+)$/.exec(url.pathname);
    if (method === 'DELETE' && m) {
      writes++;
      if (o.mode !== 'ignore')
        rules.set(
          Number(m[1]),
          rules.get(Number(m[1])).filter(r => String(r.id) !== m[2]),
        );
      return new Response(null, {status: 204});
    }
    m = /^\/rest\/dmpSegments\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && m)
      return segments.has(Number(m[1])) ? Response.json({id: Number(m[1]), ...segments.get(Number(m[1]))}) : notFound();
    if (method === 'POST' && m) {
      writes++;
      assert.equal(headers.get('x-restli-method'), 'PARTIAL_UPDATE');
      if (o.mode !== 'ignore') Object.assign(segments.get(Number(m[1])), JSON.parse(String(init.body)).patch.$set);
      return new Response(null, {status: 204});
    }
    if (method === 'DELETE' && m) {
      writes++;
      if (o.mode !== 'ignore') segments.delete(Number(m[1]));
      return new Response(null, {status: 204});
    }
    if (method === 'POST' && url.pathname === '/rest/dmpSegments') {
      writes++;
      const b = JSON.parse(String(init.body)),
        id = nextSegment++;
      if (o.mode !== 'ignore')
        segments.set(id, {
          ...b,
          destinations: [
            {destination: 'LINKEDIN', status: 'BUILDING', destinationSegmentId: 'urn:li:adSegment:' + (9000 + id)},
          ],
        });
      return new Response(null, {status: 201, headers: {'x-restli-id': String(id)}});
    }
    if (method === 'DELETE' && url.pathname === '/rest/dmpSegments') {
      writes++;
      assert.equal(headers.get('x-restli-method'), 'BATCH_DELETE');
      const ids = /^List\((.*)\)$/.exec(url.searchParams.get('ids'))[1].split(',');
      if (o.mode !== 'ignore') for (const id of ids) segments.delete(Number(id));
      return Response.json({results: Object.fromEntries(ids.map(id => [id, {status: 204}])), errors: {}});
    }
    throw Error('Unexpected ' + method + ' ' + url.pathname);
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = args =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: {account_id: '507', ...args}}, actor);
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
  return {store, calls, segments, rules, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const newSegment = (extra = {}) => ({
  name: 'Video viewers',
  account: acct,
  type: 'USER',
  sourcePlatform: 'VIDEO_ADS',
  destinations: [{destination: 'LINKEDIN'}],
  ...extra,
});

test('an engagement segment is created, renamed and given rules from the account campaigns; each verifies and a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare({action: actions.create, payload: newSegment()}));
    assert.equal(p.data.creative_impact.scope, 'engagement_audience');
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    const r = ok(
      await f.prepare({
        action: actions.update,
        restli_method: 'PARTIAL_UPDATE',
        path_params: {segment_id: '200'},
        payload: {patch: {$set: {name: 'Video viewers, 90 days'}}},
      }),
    );
    ok(await f.execute(r));
    assert.equal(ok(await f.verify(r)).data.status, 'verified');
    const one = ok(await f.prepare({action: actions.addRules, path_params: {segment_id: '100'}, payload: video(32)}));
    assert.match(one.data.creative_impact.effect, /join the audience/);
    ok(await f.execute(one));
    assert.equal(ok(await f.verify(one)).data.status, 'verified');
    const many = ok(
      await f.prepare({
        action: actions.addRules,
        restli_method: 'BATCH_CREATE',
        path_params: {segment_id: '101'},
        payload: {elements: [video(31, 60, 'MIDPOINT'), video(32, 60, 'MIDPOINT')]},
      }),
    );
    ok(await f.execute(many));
    assert.equal(ok(await f.verify(many)).data.status, 'verified');
    assert.equal(f.rules.get(101).length, 2);
  } finally {
    f.store.close();
  }
});

test('rules and segments are deleted and verify; a segment a live campaign targets is not deleted; owner deletion rules apply', async () => {
  const f = fixture();
  try {
    const rule = ok(
      await f.prepare({action: actions.removeRule, path_params: {segment_id: '100', engagement_rule_id: '5001'}}),
    );
    ok(await f.execute(rule));
    assert.equal(ok(await f.verify(rule)).data.status, 'verified');
    f.rules.set(101, [
      {id: 5101, ...video(31)},
      {id: 5102, ...video(32)},
    ]);
    const rules = ok(
      await f.prepare({
        action: actions.removeRules,
        restli_method: 'BATCH_DELETE',
        path_params: {segment_id: '101'},
        query: {ids: ['5101', '5102']},
      }),
    );
    ok(await f.execute(rules));
    assert.equal(ok(await f.verify(rules)).data.status, 'verified');
    const used = await f.prepare({action: actions.remove, path_params: {segment_id: '102'}});
    assert.equal(used.error?.code, 'INVALID_LINKEDIN_ENGAGEMENT_AUDIENCE');
    assert.match(used.error.message, /33/);
    const d = ok(await f.prepare({action: actions.remove, path_params: {segment_id: '101'}}));
    ok(await f.execute(d));
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    const many = ok(
      await f.prepare({action: actions.removeMany, restli_method: 'BATCH_DELETE', query: {ids: ['100']}}),
    );
    ok(await f.execute(many));
    assert.equal(ok(await f.verify(many)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, admin, {gateway, account_id: '507', confirmed: true, policy: {allow_deletion: false}});
    assert.equal(
      (await g.prepare({action: actions.remove, path_params: {segment_id: '101'}})).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
  } finally {
    g.store.close();
  }
});

test('malformed segments and rules are refused before any request', async () => {
  const f = fixture();
  try {
    const bad = [
      ['a list upload', {action: actions.create, payload: newSegment({sourcePlatform: 'LIST_UPLOAD'})}],
      ['a partner stream', {action: actions.create, payload: newSegment({sourcePlatform: 'PARTNER_API'})}],
      ['a company segment', {action: actions.create, payload: newSegment({type: 'COMPANY'})}],
      ['another account', {action: actions.create, payload: newSegment({account: 'urn:li:sponsoredAccount:999'})}],
      ['another destination', {action: actions.create, payload: newSegment({destinations: [{destination: 'OTHER'}]})}],
      ['an unknown field', {action: actions.create, payload: newSegment({inputCount: 5})}],
      [
        'a type change',
        {
          action: actions.update,
          restli_method: 'PARTIAL_UPDATE',
          path_params: {segment_id: '100'},
          payload: {patch: {$set: {type: 'COMPANY'}}},
        },
      ],
      [
        'an organization source',
        {
          action: actions.addRules,
          path_params: {segment_id: '100'},
          payload: {...video(31), engagementSource: 'urn:li:organization:5'},
        },
      ],
      [
        'an unknown trigger',
        {action: actions.addRules, path_params: {segment_id: '100'}, payload: video(31, 90, 'SKIPPED')},
      ],
      ['a 45-day lookback', {action: actions.addRules, path_params: {segment_id: '100'}, payload: video(31, 45)}],
      [
        'mixed lookbacks',
        {
          action: actions.addRules,
          restli_method: 'BATCH_CREATE',
          path_params: {segment_id: '101'},
          payload: {elements: [video(31, 60), video(32, 90)]},
        },
      ],
      [
        'a repeated source',
        {
          action: actions.addRules,
          restli_method: 'BATCH_CREATE',
          path_params: {segment_id: '101'},
          payload: {elements: [video(31), video(31)]},
        },
      ],
      [
        'a batch without BATCH_CREATE',
        {action: actions.addRules, path_params: {segment_id: '101'}, payload: {elements: [video(31)]}},
      ],
      ['a batch deletion without BATCH_DELETE', {action: actions.removeMany, query: {ids: ['100']}}],
      [
        'too many IDs',
        {
          action: actions.removeMany,
          restli_method: 'BATCH_DELETE',
          query: {ids: Array.from({length: 26}, (_, i) => String(300 + i))},
        },
      ],
    ];
    for (const [label, args] of bad)
      assert.equal((await f.prepare(args)).error?.code, 'INVALID_LINKEDIN_ENGAGEMENT_AUDIENCE', label);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('segments and rules that cannot take the change are refused after reading, without writes', async () => {
  const f = fixture();
  try {
    const cases = [
      [
        'a list upload segment',
        {
          action: actions.update,
          restli_method: 'PARTIAL_UPDATE',
          path_params: {segment_id: '103'},
          payload: {patch: {$set: {name: 'x'}}},
        },
        'INVALID_LINKEDIN_ENGAGEMENT_AUDIENCE',
      ],
      ['another account', {action: actions.remove, path_params: {segment_id: '104'}}, 'ACCOUNT_SCOPE_MISMATCH'],
      ['a missing segment', {action: actions.remove, path_params: {segment_id: '199'}}, 'STATE_NOT_FOUND'],
      [
        'a different trigger than the segment',
        {action: actions.addRules, path_params: {segment_id: '100'}, payload: video(32, 90, 'MIDPOINT')},
        'INVALID_LINKEDIN_ENGAGEMENT_AUDIENCE',
      ],
      [
        'a source already in the segment',
        {action: actions.addRules, path_params: {segment_id: '100'}, payload: video(31)},
        'INVALID_LINKEDIN_ENGAGEMENT_AUDIENCE',
      ],
      [
        'another source type',
        {
          action: actions.addRules,
          path_params: {segment_id: '101'},
          payload: {...video(31), engagementTrigger: trigger('LEAD_GEN_FORMS', 'VIEW_FORM')},
        },
        'INVALID_LINKEDIN_ENGAGEMENT_AUDIENCE',
      ],
      [
        'a campaign of another account',
        {action: actions.addRules, path_params: {segment_id: '101'}, payload: video(39)},
        'STATE_NOT_FOUND',
      ],
      [
        'a missing rule',
        {action: actions.removeRule, path_params: {segment_id: '100', engagement_rule_id: '7777'}},
        'STATE_NOT_FOUND',
      ],
      [
        'unchanged',
        {
          action: actions.update,
          restli_method: 'PARTIAL_UPDATE',
          path_params: {segment_id: '100'},
          payload: {patch: {$set: {name: 'Segment 100'}}},
        },
        'INVALID_LINKEDIN_ENGAGEMENT_AUDIENCE',
      ],
    ];
    for (const [label, args, code] of cases) assert.equal((await f.prepare(args)).error?.code, code, label);
    // A full page of rules may hide more: AMCP does not judge a segment on part of its rules.
    f.rules.set(
      102,
      Array.from({length: 100}, (_, i) => ({id: 7000 + i, ...video(400 + i)})),
    );
    assert.equal(
      (await f.prepare({action: actions.addRules, path_params: {segment_id: '102'}, payload: video(31)})).error?.code,
      'INCOMPLETE_STATE',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an ignored write is not verified, and the ledger lists the family', async () => {
  const f = fixture({mode: 'ignore'});
  try {
    const p = ok(await f.prepare({action: actions.addRules, path_params: {segment_id: '100'}, payload: video(32)}));
    ok(await f.execute(p));
    assert.notEqual((await f.verify(p)).data?.status, 'verified');
    const d = ok(await f.prepare({action: actions.remove, path_params: {segment_id: '101'}}));
    ok(await f.execute(d));
    assert.notEqual((await f.verify(d)).data?.status, 'verified');
  } finally {
    f.store.close();
  }
  const rows = actionContracts(registry);
  for (const action of Object.values(actions)) {
    const row = rows.find(r => r.gateway === gateway && r.action === action);
    assert.equal(row?.status, 'reviewed_write_family', action);
    assert.equal(row.family, 'linkedin_engagement_audiences', action);
  }
  for (const action of [
    'linkedin_rest_dmp_segments_segment_id_users_post',
    'linkedin_rest_dmp_segments_segment_id_companies_post',
  ])
    assert.equal(rows.find(r => r.gateway === gateway && r.action === action)?.status, 'blocked_write', action);
});
