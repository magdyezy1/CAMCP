import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * LinkedIn third-party tracking tags, Marketing API "Third-Party Tracking" (checked 2026-09-27): POST creates a DoubleClick
 * impression or click tag on a sponsored creative (201, x-restli-id) and DELETE removes it (204).
 */
const registry = new Registry(),
  gateway = 'linkedin_native_action',
  actor = {tenantId: 'third-party-test', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const actions = {
  create: 'linkedin_rest_third_party_tracking_tags_post',
  remove: 'linkedin_rest_third_party_tracking_tags_tracking_tag_id_delete',
};
const creative = id => 'urn:li:sponsoredCreative:' + id,
  acct = 'urn:li:sponsoredAccount:507';
const dcm =
  'https://serverside.doubleclick.net/ddm/trackimp/N8480.281152LINKEDINUS/B20690748.213458830;dc_trk_aid=512607074;dc_trk_cid=107409144;ord=[timestamp];dc_lat=;dc_rdid=;tag_for_child_directed_treatment=?';
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 96).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'li',
      tenantId: actor.tenantId,
      gateway,
      enabled: true,
      accounts: ['507'],
      writeAccounts: ['507'],
      scopes: o.scopes ?? ['rw_ads'],
      label: 'Synthetic LinkedIn',
    },
    {accessToken: 'synthetic'},
  );
  const creatives = {
    801: {
      id: creative(801),
      account: acct,
      campaign: 'urn:li:sponsoredCampaign:123',
      intendedStatus: 'ACTIVE',
      name: 'Launch',
    },
    802: {id: creative(802), account: 'urn:li:sponsoredAccount:999', intendedStatus: 'ACTIVE'},
    803: {id: creative(803), account: acct, intendedStatus: 'REMOVED'},
  };
  const tags = new Map([
    [
      15084,
      {id: 15084, account: acct, entity: creative(801), event: 'IMPRESSION', platform: 'DOUBLECLICK', trackingUrl: dcm},
    ],
    [
      15090,
      {
        id: 15090,
        account: 'urn:li:sponsoredAccount:999',
        entity: creative(802),
        event: 'CLICK',
        platform: 'DOUBLECLICK',
        trackingUrl: 'https://ad.doubleclick.net/ddm/clk/1',
      },
    ],
  ]);
  let next = 20000,
    writes = 0;
  const calls = [];
  const notFound = () => Response.json({status: 404, serviceErrorCode: 100, message: 'Not found'}, {status: 404});
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET',
      headers = new Headers(init?.headers);
    calls.push({method, path: url.pathname, query: Object.fromEntries(url.searchParams)});
    assert.equal(headers.get('x-restli-protocol-version'), '2.0.0');
    if (url.pathname === '/rest/thirdPartyTrackingTags') {
      if (method === 'GET') {
        assert.equal(url.searchParams.get('q'), 'creative');
        const c = url.searchParams.get('creative');
        const rows = [...tags.values()].filter(t => t.entity === c);
        return Response.json({elements: rows, paging: {count: 100, start: 0, total: rows.length, links: []}});
      }
      writes++;
      const b = JSON.parse(String(init.body)),
        id = next++;
      if (o.mode !== 'ignore') tags.set(id, {...b, id, account: acct});
      return new Response(null, {status: 201, headers: {'x-restli-id': String(o.mode === 'noid' ? '' : id)}});
    }
    const t = /^\/rest\/thirdPartyTrackingTags\/(\d+)$/.exec(url.pathname);
    if (t) {
      const id = Number(t[1]);
      if (method === 'GET')
        return tags.has(id)
          ? Response.json({...tags.get(id), changeTimeStamps: {created: 1, lastModified: 1}})
          : notFound();
      writes++;
      if (o.mode !== 'ignore') tags.delete(id);
      return new Response(null, {status: 204});
    }
    if (method === 'GET' && url.pathname === '/rest/adAccounts/507')
      return Response.json({id: 507, status: 'ACTIVE', currency: 'USD', name: 'Synthetic account'});
    const c = /^\/rest\/adAccounts\/507\/creatives\/(.+)$/.exec(url.pathname);
    if (method === 'GET' && c) {
      const urn = decodeURIComponent(c[1]),
        row = creatives[urn.split(':').at(-1)];
      return row ? Response.json(row) : notFound();
    }
    throw Error('Unexpected ' + method + ' ' + url.pathname);
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const create = payload =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action: actions.create, account_id: '507', payload}},
      actor,
    );
  const remove = id =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: actions.remove, account_id: '507', path_params: {tracking_tag_id: String(id)}},
      },
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, tags, create, remove, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const tag = (extra = {}) => ({
  entity: creative(801),
  event: 'CLICK',
  platform: 'DOUBLECLICK',
  trackingUrl: 'https://ad.doubleclick.net/ddm/clk/1;2;3',
  ...extra,
});

test('a click tag is created once without spending confirmation and verifies by its x-restli-id; deleting a tag verifies that it is gone', async () => {
  const f = fixture();
  try {
    const p = ok(await f.create(tag())),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'third_party_tracking_tag');
    assert.equal(impact.may_affect_serving, false);
    assert.match(impact.effect, /double count clicks/);
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const d = ok(await f.remove(15084));
    assert.equal(d.data.creative_impact.before.event, 'IMPRESSION');
    ok(await f.execute(d));
    assert.equal(f.tags.has(15084), false);
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('malformed tags are refused before any request', async () => {
  const cases = [
    ['http URL', tag({trackingUrl: 'http://ad.doubleclick.net/x'})],
    ['URL with spaces', tag({trackingUrl: 'https://ad.doubleclick.net/a b'})],
    ['relative URL', tag({trackingUrl: '/ddm/clk'})],
    ['other platform', tag({platform: 'MOAT'})],
    ['view event', tag({event: 'VIEW'})],
    ['campaign entity', tag({entity: 'urn:li:sponsoredCampaign:123'})],
    ['read-only field', tag({account: acct})],
    [
      'missing URL',
      (() => {
        const {trackingUrl, ...b} = tag();
        return b;
      })(),
    ],
  ];
  for (const [label, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.create(payload);
      assert.equal(r.error?.code, 'INVALID_LINKEDIN_THIRD_PARTY_TAG', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('foreign and removed creatives, foreign tags and duplicates are refused after reading, without writes', async () => {
  const f = fixture();
  try {
    assert.equal((await f.create(tag({entity: creative(802)}))).error?.code, 'STATE_TARGET_MISMATCH');
    assert.match((await f.create(tag({entity: creative(803)}))).error?.message ?? '', /REMOVED/);
    assert.equal((await f.create(tag({event: 'IMPRESSION', trackingUrl: dcm}))).error?.code, 'CONFIGURATION_EXISTS');
    assert.equal((await f.remove(15090)).error?.code, 'STATE_TARGET_MISMATCH');
    assert.equal((await f.remove(99999)).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const reader = fixture({scopes: ['r_ads']});
  try {
    assert.equal((await reader.create(tag())).error?.code, 'INSUFFICIENT_SCOPE');
  } finally {
    reader.store.close();
  }
});

test('a creation without x-restli-id is a failure that is never resubmitted, and an ignored deletion is not verified', async () => {
  const noid = fixture({mode: 'noid'});
  try {
    const p = ok(await noid.create(tag()));
    assert.equal((await noid.execute(p)).success, false);
    assert.equal((await noid.execute(p)).success, false);
    assert.equal(noid.writes(), 1);
  } finally {
    noid.store.close();
  }
  const ignored = fixture({mode: 'ignore'});
  try {
    const p = ok(await ignored.remove(15084));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
});

test('the ledger lists both tracking tag writes in the family', () => {
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'linkedin_third_party_tracking', action);
  }
});
