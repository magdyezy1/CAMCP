import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {snapTargetingWidens, normalSnapTargeting} from '../dist/src/snapchat-adsquad-targeting.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * PRV-06 A: targeting edits of Snapchat ad squads with 500 criteria or fewer. Until now the ad squad PATCH preserved
 * targeting ("needs a separate identity/targeting contract"), so routine optimisation (countries, ages, segments,
 * exclusions) needed Ads Manager or a rebuilt ad squad. One replace /targeting operation is now its own reviewed contract:
 * account, campaign, ad squad and segment reads; foreign, unlisted and unready segments, separated_types and no-op edits
 * refused; a per-dimension diff; spending confirmation always; widening an active ad squad forbidden under
 * allow_activation=false; read-back in any order and case. A synthetic Snapchat Marketing API answers; nothing leaves
 * the process.
 */
const gateway = 'snapchat_native_action',
  registry = new Registry(),
  actor = {tenantId: 'snap-targeting', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  ACCT = 'acct-target',
  action = 'snapchat_adsquad_patch';
const geo = (country_code, operation = 'INCLUDE', extra = {}) => ({country_code, operation, ...extra});
function fixture({mode, segmentsPaged = false} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64')),
    calls = [],
    sent = [];
  store.putConnection(
    owner,
    {
      id: 'snap',
      tenantId: actor.tenantId,
      gateway,
      accounts: [ACCT],
      writeAccounts: [ACCT],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const campaigns = {
    'camp-1': {ad_account_id: ACCT, status: 'ACTIVE', name: 'Campaign'},
    'camp-9': {ad_account_id: 'other-account', status: 'ACTIVE', name: 'Foreign'},
  };
  const squads = {
    'sq-active': {
      campaign_id: 'camp-1',
      status: 'ACTIVE',
      name: 'Gulf',
      targeting: {regulated_content: false, geos: [geo('sa'), geo('ae')]},
    },
    'sq-paused': {campaign_id: 'camp-1', status: 'PAUSED', name: 'Paused', targeting: {geos: [geo('sa')]}},
    'sq-shared': {
      campaign_id: 'camp-1',
      status: 'PAUSED',
      name: 'Shared audience',
      targeting: {geos: [geo('sa')], segments: [{segment_id: ['seg-foreign'], operation: 'INCLUDE'}]},
    },
    'sq-big': {campaign_id: 'camp-1', status: 'ACTIVE', name: 'Postcodes', targeting: {separated_types: ['GEO']}},
    'sq-locations': {
      campaign_id: 'camp-1',
      status: 'PAUSED',
      name: 'Radius',
      targeting: {geos: [geo('sa')], locations: [{circles: [{latitude: 24.7, longitude: 46.7, radius: 5}]}]},
    },
    'sq-archived': {campaign_id: 'camp-1', status: 'DELETED', name: 'Gone', targeting: {geos: [geo('sa')]}},
    'sq-elsewhere': {campaign_id: 'camp-2', status: 'PAUSED', name: 'Elsewhere', targeting: {geos: [geo('sa')]}},
    'sq-foreign': {campaign_id: 'camp-9', status: 'PAUSED', name: 'Foreign', targeting: {geos: [geo('sa')]}},
  };
  const segments = [
    {id: 'seg-own', ad_account_id: ACCT, name: 'Buyers', status: 'ACTIVE', targetable_status: 'READY'},
    {id: 'seg-exclude', ad_account_id: ACCT, name: 'Employees', status: 'ACTIVE', targetable_status: 'READY'},
    {id: 'seg-pending', ad_account_id: ACCT, name: 'New list', status: 'ACTIVE', targetable_status: 'NOT_READY'},
    {id: 'seg-foreign', ad_account_id: 'other-account', name: 'Shared', status: 'ACTIVE', targetable_status: 'READY'},
  ];
  const wrap = (collection, singular, entity) =>
    Response.json({request_status: 'SUCCESS', [collection]: [{sub_request_status: 'SUCCESS', [singular]: entity}]});
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init?.method ?? 'GET';
    calls.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1/adaccounts/' + ACCT) return wrap('adaccounts', 'adaccount', {id: ACCT});
    if (method === 'GET' && path === '/v1/adaccounts/' + ACCT + '/segments') {
      assert.equal(u.searchParams.get('limit'), '1000');
      const second = u.searchParams.get('cursor') === 'page-2';
      const rows = segmentsPaged ? (second ? segments.slice(2) : segments.slice(0, 2)) : segments;
      return Response.json({
        request_status: 'SUCCESS',
        segments: rows.map(s => ({sub_request_status: 'SUCCESS', segment: {...s, approximate_number_users: 1000}})),
        ...(segmentsPaged && !second
          ? {paging: {next_link: 'https://adsapi.snapchat.com' + path + '?cursor=page-2&limit=1000'}}
          : segmentsPaged === 'repeat'
            ? {paging: {next_link: 'https://adsapi.snapchat.com' + path + '?cursor=page-2&limit=1000'}}
            : {}),
      });
    }
    let m = /^\/v1\/campaigns\/([\w-]+)$/.exec(path);
    if (method === 'GET' && m && campaigns[m[1]]) return wrap('campaigns', 'campaign', {id: m[1], ...campaigns[m[1]]});
    m = /^\/v1\/adsquads\/([\w-]+)$/.exec(path);
    if (method === 'GET' && m && squads[m[1]]) {
      const squad = structuredClone(squads[m[1]]);
      // Snap answers in its own order and case, with telemetry beside the configuration.
      if (Array.isArray(squad.targeting.geos))
        squad.targeting.geos = [...squad.targeting.geos]
          .reverse()
          .map(g => ({...g, country_code: g.country_code.toUpperCase()}));
      return wrap('adsquads', 'adsquad', {id: m[1], ...squad, delivery_status: ['DELIVERING_' + calls.length]});
    }
    m = /^\/v1\/campaigns\/([\w-]+)\/adsquads\/([\w-]+)$/.exec(path);
    if (method === 'PATCH' && m) {
      assert.equal(new Headers(init.headers).get('content-type'), 'application/json-patch+json');
      const ops = JSON.parse(String(init.body));
      sent.push(ops);
      const squad = squads[m[2]];
      if (mode === 'error')
        return Response.json({
          request_status: 'ERROR',
          adsquads: [{sub_request_status: 'ERROR', sub_request_error_reason: 'Synthetic refusal'}],
        });
      if (mode !== 'ignore') {
        squad.targeting = structuredClone(ops[0].value);
        if (mode === 'drop') squad.targeting.segments = squad.targeting.segments.slice(0, 1);
        if (mode === 'defaults') squad.targeting.regulated_content = false;
      }
      return wrap('adsquads', 'adsquad', {id: m[2], ...squad});
    }
    throw new Error('Unexpected Snapchat request ' + method + ' ' + path);
  });
  // The account's own lists establish ownership of its campaigns and ad squads (Snapchat IDs are global).
  const connection = store.resolveConnection(actor, gateway, ACCT, 'snap');
  for (const id of ['camp-1', 'camp-9']) store.rememberResource(connection, ACCT, 'campaigns/' + id);
  for (const id of Object.keys(squads)) store.rememberResource(connection, ACCT, 'adsquads/' + id);
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (squad, value, {campaign = 'camp-1', ops} = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          account_id: ACCT,
          path_params: {campaign_id: campaign, ad_squad_id: squad},
          payload: ops ?? [{op: 'replace', path: '/targeting', value}],
        },
      },
      actor,
    );
  const execute = (p, extra = {spend_change_confirmed: true}) =>
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
    calls,
    sent,
    squads,
    segments,
    prepare,
    execute,
    verify,
    writes: () => sent.length,
    close: () => store.close(),
  };
}
const reviewed = p => {
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 1500));
  return p.data;
};

test('geo add and remove: the countries of an active ad squad change with spending confirmation, a per-criterion diff and an order-tolerant read-back', async t => {
  const f = fixture();
  t.after(f.close);
  const value = {regulated_content: false, geos: [geo('sa'), geo('kw')]};
  const p = await f.prepare('sq-active', value),
    impact = reviewed(p).creative_impact;
  assert.equal(impact.scope, 'adsquad_targeting');
  assert.deepEqual(impact.adsquad, {id: 'sq-active', name: 'Gulf', status: 'ACTIVE', campaign_id: 'camp-1'});
  assert.deepEqual(impact.changes.geos, {added: ['INCLUDE kw'], removed: ['INCLUDE ae'], kept: 1});
  assert.deepEqual(impact.unchanged, ['regulated_content']);
  assert.deepEqual(impact.criteria, {before: 2, after: 2, limit: 500});
  assert.equal(impact.widens_audience, true);
  assert.match(impact.effect, /delivery changes at once/);
  assert.equal(p.data.execute_requirements.spend_change_confirmed, true);
  assert.ok(!f.calls.some(c => c.includes('/segments')), 'no segment is named, so no segment list is read');
  assertRefused(await f.execute(p, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: f.writes});
  const done = await f.execute(p);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1500));
  assert.deepEqual(f.sent, [[{op: 'replace', path: '/targeting', value}]], 'the reviewed operation is sent unchanged');
  // Snap reads the targeting back in another order and in upper case: still the reviewed targeting.
  const v = await f.verify(p);
  assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 1500));
  assert.deepEqual(v.data.checks[0].changed_fields, []);
  assert.equal((await f.execute(p)).data.replayed, true);
  assert.equal(f.writes(), 1);
  // Removing a location while one stays included narrows the audience.
  assert.equal(
    snapTargetingWidens(normalSnapTargeting({geos: [geo('sa'), geo('ae')]}), normalSnapTargeting({geos: [geo('sa')]})),
    false,
  );
});

test('segment include and exclude: an owned, ready segment is included and another excluded, each named in the review', async t => {
  const f = fixture({segmentsPaged: true});
  t.after(f.close);
  const value = {
    geos: [geo('sa')],
    segments: [
      {segment_id: ['seg-own'], operation: 'INCLUDE'},
      {segment_id: ['seg-exclude'], operation: 'EXCLUDE'},
    ],
  };
  const impact = reviewed(await f.prepare('sq-paused', value)).creative_impact;
  assert.deepEqual(impact.changes.segments, {
    added: ['EXCLUDE segment_id seg-exclude', 'INCLUDE segment_id seg-own'],
    removed: [],
    kept: 0,
  });
  assert.deepEqual(
    impact.segments.map(s => [s.id, s.owned, s.targetable_status, s.added]),
    [
      ['seg-exclude', true, 'READY', true],
      ['seg-own', true, 'READY', true],
    ],
  );
  // Both pages of the account's segment list were read: the second named neither segment.
  assert.equal(f.calls.filter(c => c.endsWith('/segments')).length, 2);
  assert.doesNotMatch(impact.effect, /delivery changes at once/, 'a paused ad squad does not serve');
});

test('a foreign, unlisted or unready segment is refused before anything is sent; one the ad squad already targets is kept (regression)', async t => {
  for (const [segment, reason] of [
    ['seg-foreign', 'foreign'],
    ['seg-missing', 'not_listed'],
    ['seg-pending', 'not_targetable'],
  ]) {
    const f = fixture();
    t.after(f.close);
    const refused = await f.prepare('sq-paused', {
      geos: [geo('sa')],
      segments: [{segment_id: [segment], operation: 'INCLUDE'}],
    });
    assertRefused(refused, 'SNAPCHAT_SEGMENT_UNAVAILABLE', {writes: f.writes});
    assert.deepEqual([refused.error.details.segment_id, refused.error.details.reason], [segment, reason]);
  }
  const f = fixture();
  t.after(f.close);
  // Excluding a segment that is not ready yet narrows nothing it does not already narrow: it is reviewable.
  reviewed(
    await f.prepare('sq-paused', {geos: [geo('sa')], segments: [{segment_id: ['seg-pending'], operation: 'EXCLUDE'}]}),
  );
  // An audience shared from another account that the ad squad already targets is kept as it is, and shown as not owned.
  const kept = reviewed(
    await f.prepare('sq-shared', {
      geos: [geo('sa'), geo('qa')],
      segments: [{segment_id: ['seg-foreign'], operation: 'INCLUDE'}],
    }),
  ).creative_impact;
  assert.deepEqual(kept.segments, [
    {id: 'seg-foreign', name: 'Shared', owned: false, targetable_status: 'READY', added: false},
  ]);
  assert.deepEqual(kept.unchanged, ['segments']);
});

test('separated_types, a no-op, unqualified current targeting, another campaign or account and a deleted ad squad are refused after reading', async t => {
  const f = fixture();
  t.after(f.close);
  const big = await f.prepare('sq-big', {geos: [geo('us')]});
  assertRefused(big, 'INVALID_SNAPCHAT_TARGETING', {writes: f.writes});
  assert.equal(big.error.details.next_action, 'snapchat_adsquads_ad_squad_id_targeting_specs_update');
  assert.deepEqual(big.error.details.separated_types, ['GEO']);
  // The same targeting in another order and case changes nothing.
  const same = await f.prepare('sq-active', {regulated_content: false, geos: [geo('AE'), geo('SA')]});
  assertRefused(same, 'INVALID_SNAPCHAT_TARGETING', {writes: f.writes, message: /already has this targeting/});
  const radius = await f.prepare('sq-locations', {geos: [geo('sa'), geo('ae')]});
  assertRefused(radius, 'INVALID_SNAPCHAT_TARGETING', {writes: f.writes});
  assert.deepEqual(
    radius.error.details.unqualified_keys,
    ['locations'],
    'a radius the review cannot keep is never dropped',
  );
  assertRefused(await f.prepare('sq-archived', {geos: [geo('ae')]}), 'INVALID_SNAPCHAT_TARGETING', {writes: f.writes});
  assertRefused(await f.prepare('sq-elsewhere', {geos: [geo('ae')]}), 'STATE_TARGET_MISMATCH', {writes: f.writes});
  assertRefused(await f.prepare('sq-foreign', {geos: [geo('ae')]}, {campaign: 'camp-9'}), 'ACCOUNT_SCOPE_MISMATCH', {
    writes: f.writes,
  });
  assert.equal(f.writes(), 0);
});

test('malformed targeting and mixed operations are refused before any request', async t => {
  const f = fixture();
  t.after(f.close);
  const many = Array.from({length: 501}, (_, i) => String(10000 + i));
  const cases = [
    ['an unknown dimension', {geos: [geo('sa')], locations: []}],
    ['separated_types in the request', {geos: [geo('sa')], separated_types: ['GEO']}],
    ['no locations', {regulated_content: false}],
    ['exclusions only', {geos: [geo('sa', 'EXCLUDE')]}],
    ['a location without its operation', {geos: [{country_code: 'sa'}]}],
    ['two lists in one location', {geos: [geo('us', 'INCLUDE', {region_id: ['5'], postal_code: ['1']})]}],
    ['a segment without its operation', {geos: [geo('sa')], segments: [{segment_id: ['seg-own']}]}],
    [
      'a segment both included and excluded',
      {
        geos: [geo('sa')],
        segments: [
          {segment_id: ['seg-own'], operation: 'INCLUDE'},
          {segment_id: ['seg-own'], operation: 'EXCLUDE'},
        ],
      },
    ],
    ['an undocumented demographics key', {geos: [geo('sa')], demographics: [{age_groups: ['18-20'], income: 'HIGH'}]}],
    ['an undocumented gender', {geos: [geo('sa')], demographics: [{gender: 'ALL'}]}],
    ['an undocumented age group', {geos: [geo('sa')], demographics: [{age_groups: ['18-99']}]}],
    ['an undocumented expansion option', {geos: [geo('sa')], auto_expansion_options: {lookalike: {enabled: true}}}],
    ['more than 500 criteria', {geos: [geo('us', 'INCLUDE', {postal_code: many})]}],
    ['not an object', 'sa'],
  ];
  for (const [label, value] of cases) {
    const refused = await f.prepare('sq-active', value);
    assert.equal(
      refused.error?.code,
      'INVALID_SNAPCHAT_TARGETING',
      label + ': ' + JSON.stringify(refused).slice(0, 400),
    );
    assertRefused(refused, 'INVALID_SNAPCHAT_TARGETING', {writes: f.writes});
  }
  // A targeting edit never rides along with another edit; add, remove and nested paths stay nested updates' refusals.
  for (const ops of [
    [
      {op: 'replace', path: '/targeting', value: {geos: [geo('sa')]}},
      {op: 'replace', path: '/name', value: 'Renamed'},
    ],
    [{op: 'add', path: '/targeting', value: {geos: [geo('sa')]}}],
    [{op: 'replace', path: '/targeting/geos/0', value: geo('sa')}],
  ])
    assertRefused(await f.prepare('sq-active', undefined, {ops}), 'INVALID_SNAPCHAT_UPDATE', {writes: f.writes});
  assertRefused(
    await f.prepare('sq-active', undefined, {
      ops: [{op: 'replace', path: '/targeting', value: {geos: [geo('sa')]}, from: '/x'}],
    }),
    'INVALID_SNAPCHAT_TARGETING',
    {writes: f.writes},
  );
  assert.deepEqual(f.calls, [], 'nothing was read or sent');
});

test('allow_activation=false refuses widening an active ad squad and allows narrowing it or widening a paused one', async t => {
  const f = fixture();
  t.after(f.close);
  saveSpendPolicy(f.store, owner, {gateway, account_id: ACCT, confirmed: true, policy: {allow_activation: false}});
  assertRefused(
    await f.prepare('sq-active', {regulated_content: false, geos: [geo('sa'), geo('ae'), geo('kw')]}),
    'POLICY_ACTIVATION_FORBIDDEN',
    {writes: f.writes},
  );
  // Fewer included countries, or an excluded segment, can only reach fewer people.
  const narrower = reviewed(await f.prepare('sq-active', {regulated_content: false, geos: [geo('sa')]}));
  assert.equal(narrower.creative_impact.widens_audience, false);
  reviewed(
    await f.prepare('sq-active', {
      regulated_content: false,
      geos: [geo('sa'), geo('ae')],
      segments: [{segment_id: ['seg-exclude'], operation: 'EXCLUDE'}],
    }),
  );
  reviewed(await f.prepare('sq-paused', {geos: [geo('sa'), geo('kw')]}));
  // The narrowing review still executes under the policy; the change is checked again at execute.
  const done = await f.execute({data: narrower});
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
  assert.equal(f.writes(), 1);
});

test('a targeting change between review and execute is STATE_CHANGED naming the targeting; nothing is sent', async t => {
  const f = fixture();
  t.after(f.close);
  const p = await f.prepare('sq-active', {regulated_content: false, geos: [geo('sa'), geo('kw')]});
  reviewed(p);
  f.squads['sq-active'].targeting.geos.push(geo('om'));
  const refused = await f.execute(p);
  assertRefused(refused, 'STATE_CHANGED', {writes: f.writes});
  assert.ok(
    refused.error.details.changed_fields.some(path => /targeting/.test(path)),
    JSON.stringify(refused.error.details),
  );
});

test('a read-back that differs is not verified, a key Snap adds by itself is reported, and a failed answer is never resent', async t => {
  const value = {
    geos: [geo('sa')],
    segments: [
      {segment_id: ['seg-own'], operation: 'INCLUDE'},
      {segment_id: ['seg-exclude'], operation: 'EXCLUDE'},
    ],
  };
  for (const mode of ['ignore', 'drop']) {
    const f = fixture({mode});
    t.after(f.close);
    const p = await f.prepare('sq-paused', value);
    reviewed(p);
    assert.equal((await f.execute(p)).success, true);
    const v = await f.verify(p);
    assert.equal(v.data.status, 'inconclusive', mode + ': ' + JSON.stringify(v).slice(0, 800));
    assert.ok(
      v.data.checks[0].changed_fields.some(path => path.startsWith('$["targeting"]')),
      mode,
    );
  }
  const f = fixture({mode: 'defaults'});
  t.after(f.close);
  const p = await f.prepare('sq-paused', value);
  reviewed(p);
  assert.equal((await f.execute(p)).success, true);
  const v = await f.verify(p);
  assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 800));
  assert.deepEqual(v.data.checks[0].provider_added, ['regulated_content']);
  const failed = fixture({mode: 'error'});
  t.after(failed.close);
  const q = await failed.prepare('sq-paused', value);
  reviewed(q);
  // Snapchat refused the ad squad: a provider error, and the claimed review is never sent again.
  assertRefused(await failed.execute(q), 'PLATFORM_ERROR');
  assertRefused(await failed.execute(q), 'WRITE_OUTCOME_UNCERTAIN');
  assert.equal(failed.writes(), 1, 'never sent again');
});

test('a repeated segment cursor is an incomplete state, and the ledger keeps the ad squad PATCH routes in snapchat_nested_updates', async t => {
  const f = fixture({segmentsPaged: 'repeat'});
  t.after(f.close);
  assertRefused(
    await f.prepare('sq-paused', {geos: [geo('sa')], segments: [{segment_id: ['seg-own'], operation: 'INCLUDE'}]}),
    'INCOMPLETE_STATE',
    {writes: f.writes},
  );
  const rows = actionContracts(registry).filter(
    r =>
      r.gateway === gateway && r.method === 'PATCH' && r.path === '/v1/campaigns/{campaign_id}/adsquads/{ad_squad_id}',
  );
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.family, 'snapchat_nested_updates', row.action);
    assert.ok(row.implementation.includes('src/snapchat-adsquad-targeting.ts'), row.implementation);
    assert.ok(row.tests.includes('tests/snapchat-adsquad-targeting.test.mjs'), row.action);
  }
});
