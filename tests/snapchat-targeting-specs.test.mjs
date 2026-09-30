import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Snapchat ad squad targeting specs, Snap's Audience Targeting page, "Targeting Specs - Greater than 500 rows" (read
 * 2026-09-30): PUT /v1/adsquads/{ad_squad_id}/targeting_specs with {targeting_specs: [{id, type: "GEO", geos}]}, at most
 * 4,000 criteria; GET the same path reads it.
 */
const gateway = 'snapchat_native_action',
  registry = new Registry(),
  actor = {tenantId: 'snap-specs', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const ACCT = 'acct-specs',
  action = 'snapchat_adsquads_ad_squad_id_targeting_specs_update';
const postal = (codes, country = 'us') =>
  codes.map(c => ({country_code: country, postal_code: [c], operation: 'INCLUDE'}));
function fixture({mode} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 96).toString('base64')),
    calls = [];
  let writes = 0;
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
  const squads = {
    'sq-big': {campaign_id: 'camp-1', status: 'ACTIVE', name: 'Postcodes', targeting: {separated_types: ['GEO']}},
    'sq-small': {campaign_id: 'camp-1', status: 'ACTIVE', name: 'Countries', targeting: {geos: [{country_code: 'us'}]}},
    'sq-foreign': {campaign_id: 'camp-9', status: 'ACTIVE', name: 'Other', targeting: {separated_types: ['GEO']}},
    'sq-deleted': {campaign_id: 'camp-1', status: 'DELETED', name: 'Gone', targeting: {separated_types: ['GEO']}},
  };
  const campaigns = {
    'camp-1': {ad_account_id: ACCT, status: 'ACTIVE'},
    'camp-9': {ad_account_id: 'other', status: 'ACTIVE'},
  };
  const specs = {
    'sq-big': {
      id: 'spec-1',
      type: 'GEO',
      container_kind: 'AdSquads',
      container_id: 'sq-big',
      geos: postal(['20001', '20009']),
    },
    'sq-foreign': {id: 'spec-9', type: 'GEO', geos: postal(['10001'])},
    'sq-deleted': {id: 'spec-8', type: 'GEO', geos: postal(['10001'])},
  };
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init?.method ?? 'GET';
    calls.push({path, method});
    if (method === 'GET' && path === '/v1/adaccounts/' + ACCT)
      return Response.json({
        request_status: 'SUCCESS',
        adaccounts: [{sub_request_status: 'SUCCESS', adaccount: {id: ACCT}}],
      });
    let m = /^\/v1\/adsquads\/([\w-]+)$/.exec(path);
    if (method === 'GET' && m)
      return Response.json({
        request_status: 'SUCCESS',
        adsquads: [{sub_request_status: 'SUCCESS', adsquad: {id: m[1], ...squads[m[1]]}}],
      });
    m = /^\/v1\/campaigns\/([\w-]+)$/.exec(path);
    if (method === 'GET' && m)
      return Response.json({
        request_status: 'SUCCESS',
        campaigns: [{sub_request_status: 'SUCCESS', campaign: {id: m[1], ...campaigns[m[1]]}}],
      });
    m = /^\/v1\/adsquads\/([\w-]+)\/targeting_specs$/.exec(path);
    if (method === 'GET' && m)
      return Response.json({
        request_status: 'SUCCESS',
        targeting_specs: specs[m[1]] ? [{sub_request_status: 'SUCCESS', targeting_spec: specs[m[1]]}] : [],
      });
    if (method === 'PUT' && m) {
      writes++;
      const b = JSON.parse(String(init.body)),
        s = b.targeting_specs[0];
      // Snap may answer in upper case and another order.
      if (mode !== 'ignore')
        specs[m[1]] = {
          ...specs[m[1]],
          ...s,
          geos: [...s.geos].reverse().map(g => ({...g, country_code: g.country_code.toUpperCase()})),
        };
      return Response.json({
        request_status: 'SUCCESS',
        targeting_specs: [{sub_request_status: 'SUCCESS', targeting_spec: {...specs[m[1]], id: s.id}}],
      });
    }
    throw new Error('Unexpected ' + method + ' ' + path);
  });
  // The account's ad squad list establishes ownership of its ad squads (Snapchat IDs are global).
  const connection = store.resolveConnection(actor, gateway, ACCT, 'snap'),
    own = id => store.rememberResource(connection, ACCT, 'adsquads/' + id);
  for (const id of ['sq-big', 'sq-small', 'sq-deleted']) own(id);
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (squad, body) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: ACCT, params: {ad_squad_id: squad}, payload: body}},
      actor,
    );
  const execute = (p, extra = {}) =>
    service.call('amcp_write', {action: 'execute', review_id: p.data.review_id, confirmed: true, ...extra}, actor);
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, specs, prepare, execute, verify, own, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success ?? true, true, JSON.stringify(r).slice(0, 1500));
  assert.equal(r.error, undefined, JSON.stringify(r).slice(0, 1500));
  return r;
};
const body = (geos, id = 'spec-1') => ({targeting_specs: [{id, type: 'GEO', geos}]});

test('the targeting spec of a large ad squad is replaced with spending confirmation and read back in any order and case', async () => {
  const f = fixture();
  const geos = [...postal(['20001', '20009', '20010']), {country_code: 'us', region_id: ['5'], operation: 'EXCLUDE'}];
  const p = ok(await f.prepare('sq-big', body(geos)));
  const impact = p.data.creative_impact;
  assert.equal(impact.scope, 'targeting_spec');
  assert.equal(impact.criteria.before, 2);
  assert.equal(impact.criteria.after, 4);
  assert.deepEqual(impact.entries, {added: 2, removed: 0, kept: 2});
  assert.match(impact.effect, /delivery changes at once/);
  assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
  ok(await f.execute(p, {spend_change_confirmed: true}));
  assert.equal(f.writes(), 1);
  assert.equal(ok(await f.verify(p)).data.status, 'verified');
});

test('malformed specs are refused before any request', async () => {
  const f = fixture();
  const cases = [
    ['two specs', {targeting_specs: [body(postal(['1'])).targeting_specs[0], body(postal(['2'])).targeting_specs[0]]}],
    ['another type', {targeting_specs: [{id: 'spec-1', type: 'INTERESTS', geos: postal(['1'])}]}],
    ['no geos', body([])],
    ['exclusions only', body([{country_code: 'us', operation: 'EXCLUDE'}])],
    [
      'two lists in one entry',
      body([{country_code: 'us', region_id: ['5'], postal_code: ['1'], operation: 'INCLUDE'}]),
    ],
    ['a bad country', body([{country_code: 'usa', operation: 'INCLUDE'}])],
    ['no operation', body([{country_code: 'us'}])],
    ['a repeated code', body([{country_code: 'us', postal_code: ['1', '1'], operation: 'INCLUDE'}])],
    [
      'more than 4,000 criteria',
      body([
        {
          country_code: 'us',
          postal_code: Array.from({length: 4001}, (_, i) => String(10000 + i)),
          operation: 'INCLUDE',
        },
      ]),
    ],
    ['an extra field', {targeting_specs: [{id: 'spec-1', type: 'GEO', geos: postal(['1']), demographics: []}]}],
  ];
  for (const [label, b] of cases)
    assert.equal((await f.prepare('sq-big', b)).error?.code, 'INVALID_SNAPCHAT_TARGETING_SPEC', label);
  assert.equal(f.writes(), 0);
  assert.equal(f.calls.length, 0);
});

test('ad squads without a spec, of another account, deleted, another spec ID or no change are refused after reading', async () => {
  const f = fixture();
  assert.equal((await f.prepare('sq-small', body(postal(['1'])))).error?.code, 'INVALID_SNAPCHAT_TARGETING_SPEC');
  // Another account's ad squad is not in this account's list, so the scope refuses it; were it owned by a stale
  // record, its campaign's account still refuses it.
  assert.equal((await f.prepare('sq-foreign', body(postal(['1']), 'spec-9'))).error?.code, 'RESOURCE_SCOPE_REQUIRED');
  f.own('sq-foreign');
  assert.equal((await f.prepare('sq-foreign', body(postal(['1']), 'spec-9'))).error?.code, 'ACCOUNT_SCOPE_MISMATCH');
  assert.equal(
    (await f.prepare('sq-deleted', body(postal(['1']), 'spec-8'))).error?.code,
    'INVALID_SNAPCHAT_TARGETING_SPEC',
  );
  assert.equal(
    (await f.prepare('sq-big', body(postal(['1']), 'spec-2'))).error?.code,
    'INVALID_SNAPCHAT_TARGETING_SPEC',
  );
  assert.equal(
    (await f.prepare('sq-big', body(postal(['20009', '20001']).map(g => ({...g, country_code: 'US'}))))).error?.code,
    'INVALID_SNAPCHAT_TARGETING_SPEC',
    'the same locations in another order and case',
  );
  assert.equal(f.writes(), 0);
});

test('an ignored update is not verified, and the ledger records the family', async () => {
  const f = fixture({mode: 'ignore'});
  const p = ok(await f.prepare('sq-big', body(postal(['30301']))));
  ok(await f.execute(p, {spend_change_confirmed: true}));
  assert.notEqual((await f.verify(p)).data?.status, 'verified');
  const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
  assert.equal(row?.status, 'reviewed_write_family');
  assert.equal(row.family, 'snapchat_targeting_specs');
});
