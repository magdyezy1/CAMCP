// PRV-07 B: Apple Ads planning reads of the pinned Platform API SDK revision: app search and lookup, app eligibility,
// product pages, impression share, search-term popularity and keyword suggestions. Each runs under the X-AP-Context ad
// account, refuses another account's resources and is classified as a native read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {appleActions, applePlanningReadMethods} from '../dist/src/apple-native.js';

const gateway = 'apple_ads_native_action',
  owner = {tenantId: 'apple-planning', userId: 'owner', role: 'admin'},
  reader = {...owner, userId: 'reader', role: 'reader'},
  models = JSON.parse(readFileSync('generated/apple-platform-v1-models.json', 'utf8'));
function fixture(t, respond) {
  const store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    owner,
    {
      id: 'apple',
      tenantId: owner.tenantId,
      gateway,
      accounts: ['77'],
      label: 'Synthetic Apple',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'synthetic-apple'},
  );
  const requests = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(String(raw));
      requests.push({
        url,
        method: init.method,
        context: new Headers(init.headers).get('X-AP-Context'),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(respond(url));
    }),
  );
  return {
    requests,
    read: (action, args = {}) => service.call(gateway, {action, account_id: '77', ...args}, reader),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data.data;
};

test('each planning read mirrors its pinned SDK method and is a native read in the ledger', () => {
  const ledger = actionContracts(new Registry());
  for (const [name, method] of Object.entries(applePlanningReadMethods)) {
    const action = appleActions.find(a => a.name === name),
      pinned = models.methods[method];
    assert.ok(action && pinned, name);
    assert.equal(action.method, pinned.method, name);
    assert.equal(action.raw.path.replace('{id}', '{x}'), pinned.path.replace(/\{\w+\}/, '{x}'), name);
    assert.equal(pinned.account_context, 'required', name);
    assert.equal(action.read_only, true, name);
    const row = ledger.find(r => r.gateway === gateway && r.action === name);
    assert.equal(row?.status, 'native_read', JSON.stringify(row));
  }
});

test('app search and lookup read under the selected ad account with bounded URL selectors', async t => {
  const f = fixture(t, url =>
    url.pathname === '/v1/search/apps'
      ? {result: [{adamId: 900001, appName: 'Synthetic App', developerName: 'Synthetic Developer'}]}
      : {result: {adamId: 900001, appName: 'Synthetic App', countryOrRegionCodes: ['US']}},
  );
  const found = ok(
    await f.read('apple_ads_v1_apps_search', {query: {query: 'synthetic', returnOwnedApps: 'true', limit: 20}}),
  );
  assert.equal(found.result[0].adamId, 900001);
  assert.equal(f.requests[0].url.searchParams.get('query'), 'synthetic');
  assert.equal(f.requests[0].url.searchParams.get('limit'), '20');
  assert.equal(f.requests[0].context, 'adAccountId=77;');
  const app = ok(await f.read('apple_ads_v1_app_get', {path_params: {id: '900001'}}));
  assert.equal(app.result.appName, 'Synthetic App');
  assert.equal(f.requests[1].url.pathname, '/v1/apps/900001');
  for (const query of [{limit: 1001}, {offset: -1}, {query: ''}, {returnOwnedApps: 'yes'}, {unknown: 'x'}]) {
    const r = await f.read('apple_ads_v1_apps_search', {query});
    assert.equal(r.success, false, JSON.stringify(query));
  }
  assert.equal(f.requests.length, 2);
});

test('eligibility, product pages, impression share, popularity and keyword suggestions post bounded JSON bodies', async t => {
  const f = fixture(t, url =>
    url.pathname === '/v1/insights/apps/impression-share/query'
      ? {result: {rows: [{metadata: {searchTerm: 'synthetic'}, insights: {lowImpressionShare: 0.1}}]}}
      : {result: [{id: 'row-1', adamId: 900001}]},
  );
  for (const [action, path] of [
    ['apple_ads_v1_app_eligibilities_query', '/v1/eligibilities/apps/query'],
    ['apple_ads_v1_product_pages_query', '/v1/product-pages/query'],
    ['apple_ads_v1_impression_share_query', '/v1/insights/apps/impression-share/query'],
    ['apple_ads_v1_search_term_popularity_query', '/v1/insights/apps/search-term-popularity/query'],
    ['apple_ads_v1_keyword_suggestions_query', '/v1/suggestions/keywords/query'],
  ]) {
    const payload = {adamId: 900001, countriesOrRegions: ['US']};
    ok(await f.read(action, {payload}));
    const sent = f.requests.at(-1);
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url.pathname, path);
    assert.deepEqual(sent.body, payload);
    assert.equal(sent.context, 'adAccountId=77;');
  }
  const oversized = await f.read('apple_ads_v1_keyword_suggestions_query', {payload: {seed: 'x'.repeat(70000)}});
  assert.equal(oversized.success, false);
  assert.equal(f.requests.length, 5);
});

test('another ad account is refused: in the selection before any request, and in a returned resource', async t => {
  const f = fixture(t, () => ({result: [{id: '1', adAccountId: '99'}]}));
  const outside = await f.read('apple_ads_v1_product_pages_query', {account_id: '99', payload: {}});
  assert.equal(outside.success, false);
  assert.equal(f.requests.length, 0);
  const leaked = await f.read('apple_ads_v1_product_pages_query', {payload: {}});
  assert.equal(leaked.success, false);
  assert.equal(leaked.error.code, 'ACCOUNT_SCOPE_MISMATCH');
  const g = fixture(t, () => ({result: {adamId: 900002}}));
  const other = await g.read('apple_ads_v1_app_get', {path_params: {id: '900001'}});
  assert.equal(other.success, false);
});
