import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ScopeGuard} from '../src/scope.js';
import {metaAdLibraryRead} from '../src/meta-ad-library.js';
import {actionContracts} from '../src/action-contracts.js';
import type {CompiledRequest, Connection, JsonObject} from '../src/types.js';

const registry = new Registry(),
  actor = {tenantId: 'archive', userId: 'reader', role: 'reader' as const},
  owner = {...actor, role: 'admin' as const},
  key = Buffer.alloc(32, 37).toString('base64');
const ad = (id: string) => ({
  id,
  page_id: '77',
  page_name: 'Example public Page',
  ad_creative_bodies: ['Public ad text'],
  publisher_platforms: ['FACEBOOK'],
  ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=' + id + '&access_token=synthetic-secret',
});
function fixture() {
  const store = new Store(':memory:', key),
    calls: JsonObject[] = [],
    c: Connection = {
      id: 'c',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      label: 'Library login',
      enabled: true,
      scopes: [],
    };
  store.putConnection(owner, c, {accessToken: 'synthetic-token'});
  let mode = 'success',
    returned = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url));
      calls.push({url: u.href, method: init!.method});
      assert.equal(u.origin, 'https://graph.facebook.com');
      assert.equal(u.pathname, '/v26.0/ads_archive');
      assert.equal(init!.method, 'GET');
      assert.equal(u.searchParams.get('ad_type'), 'ALL');
      assert.equal(u.searchParams.get('ad_active_status'), 'ACTIVE');
      assert.ok(!u.searchParams.has('access_token'));
      const limit = Number(u.searchParams.get('limit'));
      returned++;
      if (mode === 'disconnect') store.putConnection(owner, {...c, enabled: false}, {accessToken: 'synthetic-token'});
      if (mode === 'error') return Response.json({error: {message: 'Synthetic not approved'}});
      if (mode === 'errors') return Response.json({data: [], errors: []});
      if (mode === 'malformed') return Response.json({});
      if (mode === 'invalid_row') return Response.json({data: [{id: 12, page_id: '77', page_name: 'Page'}]});
      if (mode === 'huge') return Response.json({data: [{...ad('1'), page_name: 'x'.repeat(4 * 1024 * 1024)}]});
      if (mode === 'large_cache') return Response.json({data: [{...ad('1'), page_name: 'x'.repeat(3 * 1024 * 1024)}]});
      if (mode === 'bad_paging') return Response.json({data: [], paging: {next: 0}});
      if (mode === 'partial_paging') return Response.json({data: [], paging: {incomplete: true}});
      if (mode === 'null_paging') return Response.json({data: [], paging: null});
      if (mode === 'partial') return Response.json({data: [ad('1')], paging: {next: 'https://example.com/private'}});
      if (mode === 'loop')
        return Response.json({
          data: [ad(String(returned))],
          paging: {cursors: {after: 'repeat'}, next: 'https://example.com/?access_token=synthetic-secret'},
        });
      if (mode === 'duplicate') return Response.json({data: [ad('1'), ad('1')]});
      if (mode === 'oversized')
        return Response.json({data: Array.from({length: limit + 1}, (_, i) => ad(String(i + 1)))});
      if (mode === 'limit')
        return Response.json({
          data: Array.from({length: limit}, (_, i) => ad(String(i + 1))),
          paging: {cursors: {after: 'next'}, next: 'https://example.com/?access_token=synthetic-secret'},
        });
      if (mode === 'pages' || mode === 'max_pages') {
        return Response.json({
          data: [ad(String(returned))],
          ...(mode === 'max_pages' || !u.searchParams.has('after')
            ? {
                paging: {
                  cursors: {after: String(returned)},
                  next: 'https://example.com/private?access_token=synthetic-secret',
                },
              }
            : {}),
        });
      }
      return Response.json({data: mode === 'empty' ? [] : [ad('1')]});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1000,
  );
  const service = new MirrorService(registry, store, transport),
    search = (args: JsonObject = {search_term: 'Example'}, a = actor) =>
      service.call('amcp_native_action', {operation: 'search_ads_library', arguments: args}, a);
  return {store, c, calls, service, search, setMode: (v: string) => (mode = v)};
}
test('Meta Ad Library maps the compatibility media filter, strips credential URLs and labels API coverage', async () => {
  for (const type of ['ALL', 'IMAGE', 'VIDEO', 'MEME']) {
    const f = fixture();
    try {
      const r = await f.search({search_term: 'صناعة Example', country: 'SA', ad_type: type});
      assert.equal(r.success, true, JSON.stringify(r));
      const u = new URL(f.calls[0]!.url);
      assert.equal(u.searchParams.get('media_type'), type);
      assert.deepEqual(JSON.parse(u.searchParams.get('ad_reached_countries')!), ['SA']);
      assert.equal(r.data.ads[0].library_url, 'https://www.facebook.com/ads/library/?id=1');
      assert.equal(r.data.complete, true);
      assert.equal(r.data.cached, false);
      assert.match(r.data.coverage, /not a complete inventory/);
      assert.match(r.data.interpretation, /do not establish performance/);
      assert.ok(r.meta.untrusted_provider_content);
      assert.ok(!JSON.stringify(r).includes('synthetic-secret'));
      assert.ok(!JSON.stringify(f.store.audit(actor.tenantId)).includes('synthetic-secret'));
    } finally {
      f.store.close();
    }
  }
});
test('Meta public archive follows bounded cursors on the fixed origin and exposes requested truncation', async () => {
  const f = fixture();
  try {
    f.setMode('pages');
    const r = await f.search();
    assert.equal(r.success, true);
    assert.equal(r.data.pages, 2);
    assert.equal(r.data.ads.length, 2);
    assert.ok(f.calls.every(c => c.url.startsWith('https://graph.facebook.com/v26.0/ads_archive?')));
    assert.ok(f.calls.every(c => !c.url.includes('access_token')));
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    g.setMode('limit');
    const r = await g.search({search_term: 'Example', limit: 2});
    assert.equal(r.success, true);
    assert.equal(r.data.count, 2);
    assert.equal(r.data.complete, false);
    assert.equal(r.data.has_more, true);
    assert.equal(r.data.incomplete_reason, 'requested_result_limit');
    assert.equal(g.calls.length, 1);
    assert.equal(r.data.paging, undefined);
    assert.equal(r.data.cursors, undefined);
    assert.ok(!JSON.stringify(r).includes('synthetic-secret'));
  } finally {
    g.store.close();
  }
});
test('Meta empty archive results preserve coverage uncertainty', async () => {
  const f = fixture();
  try {
    f.setMode('empty');
    const r = await f.search();
    assert.equal(r.success, true);
    assert.deepEqual(r.data.ads, []);
    assert.equal(r.data.complete, true);
    assert.match(r.data.coverage, /Empty results do not establish/);
  } finally {
    f.store.close();
  }
});
test('Meta archive cache uses the exact query and expires after fifteen minutes', async t => {
  const f = fixture();
  try {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const r = await f.search();
    assert.equal(r.success, true);
    assert.equal((await f.search()).data.cached, true);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.search({search_term: 'Example', country: 'GB'})).data.cached, false);
    assert.equal(f.calls.length, 2);
    now += 900001;
    assert.equal((await f.search()).data.cached, false);
    assert.equal(f.calls.length, 3);
  } finally {
    f.store.close();
  }
});
test('Meta archive invalidates cached entries after a backwards wall-clock jump', async t => {
  const f = fixture();
  try {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    await f.search();
    now -= 1000;
    assert.equal((await f.search()).data.cached, false);
    assert.equal(f.calls.length, 2);
  } finally {
    f.store.close();
  }
});
test('Meta archive cache evicts entries by both count and total bytes', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 129; i++) assert.equal((await f.search({search_term: 'Entry ' + i})).success, true);
    assert.equal((await f.search({search_term: 'Entry 128'})).data.cached, true);
    assert.equal((await f.search({search_term: 'Entry 0'})).data.cached, false);
    assert.equal(f.calls.length, 130);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    g.setMode('large_cache');
    for (let i = 0; i < 6; i++) assert.equal((await g.search({search_term: 'Large ' + i})).success, true);
    assert.equal((await g.search({search_term: 'Large 5'})).data.cached, true);
    assert.equal((await g.search({search_term: 'Large 0'})).data.cached, false);
    assert.equal(g.calls.length, 7);
  } finally {
    g.store.close();
  }
});
test('Meta archive cache never crosses tenant or connection and checks revocation before cache', async () => {
  const f = fixture();
  try {
    await f.search();
    f.store.putConnection(owner, {...f.c, id: 'c2', isDefault: true}, {accessToken: 'other-synthetic'});
    const r = await f.search();
    assert.equal(r.data.connection_id, 'c2');
    assert.equal(r.data.cached, false);
    assert.equal(f.calls.length, 2);
    f.store.putConnection(owner, {...f.c, enabled: false}, {accessToken: 'synthetic'});
    f.store.putConnection(owner, {...f.c, id: 'c2', enabled: false}, {accessToken: 'synthetic'});
    assert.equal((await f.search()).error.code, 'CONNECTION_REQUIRED');
    const other = {...actor, tenantId: 'other'};
    assert.equal((await f.search({search_term: 'Example'}, other)).error.code, 'CONNECTION_REQUIRED');
    assert.equal(f.calls.length, 2);
  } finally {
    f.store.close();
  }
});
test('Meta archive selection fails when connections are ambiguous and revocation aborts an in-flight read', async () => {
  const f = fixture();
  try {
    f.store.putConnection(owner, {...f.c, id: 'c2'}, {accessToken: 'other-synthetic'});
    assert.equal((await f.search()).error.code, 'AMBIGUOUS_CONNECTION');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    g.setMode('disconnect');
    assert.equal((await g.search()).error.code, 'CONNECTION_REQUIRED');
    assert.equal(g.calls.length, 1);
  } finally {
    g.store.close();
  }
});
test('Meta archive validates tighter native text limits instead of truncating captured 200-character inputs', async () => {
  const f = fixture();
  try {
    for (const input of [
      {search_term: 'x'.repeat(101)},
      {search_term: '  '},
      {search_term: 'bad\ntext'},
      {search_term: 'x', country: 'ZZ'},
      {search_term: 'x', ad_type: 'POLITICAL_AND_ISSUE_ADS'},
      {search_term: 'x', limit: 0},
      {search_term: 'x', limit: 101},
      {search_term: 'x', url: 'https://example.com'},
    ])
      assert.equal((await f.search(input)).success, false, JSON.stringify(input));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('Meta archive partial, duplicate, failed and oversized results are never cached as successful empty searches', async () => {
  for (const mode of [
    'error',
    'errors',
    'malformed',
    'invalid_row',
    'partial',
    'loop',
    'duplicate',
    'oversized',
    'huge',
    'max_pages',
    'bad_paging',
    'partial_paging',
    'null_paging',
  ]) {
    const f = fixture();
    try {
      f.setMode(mode);
      const r = await f.search({search_term: 'Example', limit: 100});
      assert.equal(r.success, false, mode);
      if (mode === 'max_pages') assert.equal(f.calls.length, 25);
      f.setMode('success');
      const success = await f.search();
      assert.equal(success.success, true, mode);
      assert.equal(success.data.cached, false);
    } finally {
      f.store.close();
    }
  }
});
test('Meta archive scope exception cannot authorize another Graph route, method, origin or token query', async () => {
  const f = fixture();
  try {
    const plan: CompiledRequest = {
      gateway: 'meta_native_action',
      action: 'AMCP_META_AD_LIBRARY_READ',
      method: 'GET',
      path: '/v26.0/ads_archive',
      origin: 'https://graph.facebook.com',
      query: {
        search_terms: 'Example',
        ad_reached_countries: ['US'],
        ad_type: 'ALL',
        media_type: 'ALL',
        ad_active_status: 'ACTIVE',
        fields:
          'id,page_id,page_name,ad_creation_time,ad_delivery_start_time,ad_delivery_stop_time,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_captions,ad_creative_link_descriptions,publisher_platforms',
        limit: 25,
      },
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'test',
      warnings: [],
    };
    assert.equal(metaAdLibraryRead(plan), true);
    assert.equal(new ScopeGuard(registry, f.store).authorize(plan, f.c), 'public_ad_library');
    for (const p of [
      {...plan, path: '/v26.0/me'},
      {...plan, method: 'POST'},
      {...plan, origin: 'https://example.com'},
      {...plan, body: {}},
      {...plan, query: {...plan.query, access_token: 'synthetic'}},
      {...plan, headers: {'X-HTTP-Method-Override': 'POST'}},
    ]) {
      assert.equal(metaAdLibraryRead(p), false);
      assert.throws(() => new ScopeGuard(registry, f.store).authorize(p, f.c));
    }
  } finally {
    f.store.close();
  }
});
test('Meta archive workflow is explicitly inventoried with its own implementation evidence', () => {
  const row = actionContracts(registry).find(
    r => r.gateway === 'amcp_native_action' && r.operation === 'search_ads_library',
  );
  assert.equal(row?.status, 'local_workflow');
  assert.equal(row.implementation, 'src/meta-ad-library.ts');
  assert.equal(row.live_qualification, 'unverified');
});
test('the public research guide example executes against the exact scoped archive fixture', async () => {
  const examples = JSON.parse(
    fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).public_read_workflows;
  assert.equal(examples.length, 1);
  const f = fixture();
  try {
    for (const example of examples) {
      const out = await f.service.call(example.gateway, example.arguments, actor);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.query.country, 'GB');
      assert.equal(out.data.query.media_type, 'VIDEO');
      assert.match(out.data.coverage, /not a complete inventory/);
    }
  } finally {
    f.store.close();
  }
});
