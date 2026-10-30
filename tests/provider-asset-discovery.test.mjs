import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {AssetDiscovery} from '../dist/server/asset-discovery.js';
import {platforms} from '../dist/server/platform-oauth.js';
import {providerLogin, registeredProviderLogins} from '../dist/src/provider-logins.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {writePathModules} from '../dist/tools/guidance-coverage.js';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';

// ARC-01 phase B, the server discovery configurations: AssetDiscovery.discover (server/asset-discovery.ts, 693 lines)
// branched on each website platform's ID. Each provider's reads are now the discovery of its website login steps
// (src/<provider>-login.ts, registered in src/provider-logins.ts); the stage keeps the platform and kind checks, the
// login checks around every request, the page rules, the asset rules, the walk beneath parents, each kind's failure
// group and the order of the groups. The behaviour of each step is pinned by the discovery suites
// (tests/website-discovery-authority.test.ts, tests/connection-management.test.mjs,
// tests/measurement-discovery-metadata.test.mjs, ...); these cases pin the seam.

const master = Buffer.alloc(32, 37).toString('base64'),
  owner = {tenantId: 'discovery-seam', userId: 'owner', role: 'admin'};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

test('the discovery stage names no gateway, branches on no platform and imports no provider module', () => {
  const source = fs.readFileSync(new URL('../server/asset-discovery.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/);
  assert.doesNotMatch(source, /\bp\.id\s*[!=]==/);
  const edges = [...runtimeGraph(process.cwd()).get('server/asset-discovery.ts')];
  assert.deepEqual(
    edges.filter(id => isProviderModule(id) && !providerRegistries.includes(id)),
    [],
    'the stage consults the provider login registry instead',
  );
  assert.ok(edges.includes('src/provider-logins.ts'));
});

test('every website platform declares its discovery, frozen, with one entry point', () => {
  for (const p of platforms) {
    const discovery = providerLogin(p.gateway)?.discovery;
    assert.ok(discovery, p.id + ' declares its discovery');
    assert.ok(Object.isFrozen(discovery), p.id);
    assert.equal(typeof (discovery.kind ?? discovery.all), 'function', p.id);
    assert.ok(!(discovery.kind && discovery.all), p.id + ' has one entry point');
  }
  const declaring = key =>
    registeredProviderLogins
      .filter(l => l.discovery?.[key])
      .map(l => l.gateway)
      .sort();
  // Only Business Profile discovers every selected kind in one bounded pass.
  assert.deepEqual(declaring('all'), ['google_business_native_action']);
  // LinkedIn's version headers and start/count paging, and Reddit's cursor-only next links, are their own.
  assert.deepEqual(declaring('headers'), ['linkedin_native_action']);
  assert.deepEqual(declaring('nextStart'), ['linkedin_native_action']);
  assert.deepEqual(declaring('nextLink'), ['reddit_native_action']);
  // The registry lists the website platforms, in their order: a gateway without a platform has no login steps.
  assert.deepEqual(
    registeredProviderLogins.map(l => l.gateway),
    platforms.map(p => p.gateway),
  );
});

test('the reviewed-write path never loads the website login steps, and the provider hooks carry none', () => {
  // The guidance coverage holds every refusal of the reviewed-write path (tools/guidance-coverage.ts): discovery and
  // OAuth refusals are the website's, so neither the login registry nor a provider's login module is on that path.
  const modules = writePathModules('src');
  assert.ok(modules.includes('provider-hooks.ts'));
  assert.deepEqual(
    modules.filter(file => file === 'provider-logins.ts' || file.endsWith('-login.ts')),
    [],
  );
  for (const hooks of registeredProviderHooks)
    for (const key of ['discovery', 'oauth']) assert.equal(hooks[key], undefined, hooks.gateway + ' ' + key);
});
function fixture(connection, fetcher) {
  const store = new Store(':memory:', master);
  store.putConnection(owner, connection, {accessToken: 'synthetic-access'});
  return {store, discovery: new AssetDiscovery(store, fetcher)};
}

test('the stage keeps its page rules for a provider’s step: a next link that leaves the listing is refused', async () => {
  const connection = {
    id: 'li-pages',
    tenantId: owner.tenantId,
    gateway: 'linkedin_native_action',
    accounts: [],
    enabled: false,
    label: 'LinkedIn login',
    scopes: ['r_ads'],
    isDefault: true,
  };
  const sent = [];
  const {store, discovery} = fixture(connection, async (url, init) => {
    const u = new URL(String(url));
    sent.push({path: u.pathname, version: new Headers(init?.headers).get('linkedin-version')});
    return json({
      elements: [{account: 'urn:li:sponsoredAccount:1', role: 'VIEWER'}],
      paging: {start: 0, count: 1, links: [{rel: 'next', href: '/rest/otherFinder?start=1'}]},
    });
  });
  try {
    const group = (await discovery.sync(connection)).groups[0];
    assert.equal(group.complete, false);
    assert.equal(group.diagnostics[0].code, 'UNSAFE_PAGINATION');
    // The step's request carried the adapter's version header; nothing followed the refused link.
    assert.deepEqual(
      sent.map(s => s.path),
      ['/rest/adAccountUsers'],
    );
    assert.match(sent[0].version, /^\d{6}$/);
  } finally {
    store.close();
  }
});

test('LinkedIn’s start/count paging is its own: the next page starts where its count says, and a repeat is refused', async () => {
  const connection = {
    id: 'li-offsets',
    tenantId: owner.tenantId,
    gateway: 'linkedin_native_action',
    accounts: [],
    enabled: false,
    label: 'LinkedIn login',
    scopes: ['r_ads'],
    isDefault: true,
  };
  const starts = [];
  const {store, discovery} = fixture(connection, async url => {
    const u = new URL(String(url));
    if (u.pathname !== '/rest/adAccountUsers') return json({}, 404);
    starts.push(u.searchParams.get('start'));
    // The provider answers start 0 forever: the stage refuses the repeated offset after one advance.
    return json({
      elements: [{account: 'urn:li:sponsoredAccount:' + (starts.length + 1)}],
      paging: {start: 0, count: 1},
    });
  });
  try {
    const group = (await discovery.sync(connection)).groups[0];
    assert.deepEqual(starts, ['0', '1']);
    assert.equal(group.complete, false);
    assert.equal(group.diagnostics[0].code, 'PAGINATION_LOOP');
  } finally {
    store.close();
  }
});

test('Reddit’s next links may change only their cursor; the walk beneath businesses says what it leaves out', async () => {
  const connection = {
    id: 'reddit-walk',
    tenantId: owner.tenantId,
    gateway: 'reddit_native_action',
    accounts: [],
    enabled: false,
    label: 'Reddit login',
    scopes: ['adsread'],
    userAgent: 'AMCP/0.1.0 (synthetic)',
    isDefault: true,
  };
  let filterChange = false;
  const {store, discovery} = fixture(connection, async url => {
    const u = new URL(String(url));
    if (u.pathname === '/api/v3/me/businesses') return json({data: [{id: 'biz_1'}]});
    if (u.pathname === '/api/v3/businesses/biz_1/ad_accounts')
      return filterChange && !u.searchParams.has('after')
        ? json({
            data: [{id: 'a2_one', business_id: 'biz_1', name: 'One'}],
            pagination: {next_url: u.origin + u.pathname + '?after=c1&status=ACTIVE'},
          })
        : json({data: [{id: 'a2_one', business_id: 'biz_1', name: 'One', currency: 'USD'}]});
    return json({}, 404);
  });
  try {
    const complete = (await discovery.sync(connection)).groups[0];
    assert.equal(complete.complete, true);
    assert.deepEqual(
      complete.assets.map(a => [a.id, a.name, a.parentId, a.currency]),
      [['a2_one', 'One', 'biz_1', 'USD']],
    );
    assert.deepEqual(
      complete.diagnostics.map(d => d.code),
      ['DISCOVERY_COVERAGE'],
    );
    // A next link that adds a filter is Reddit's refusal, kept as the parent's diagnostic.
    filterChange = true;
    const refused = (await discovery.sync(connection)).groups[0];
    assert.equal(refused.complete, false);
    assert.equal(refused.diagnostics[0].parent_id, 'biz_1');
    assert.equal(refused.diagnostics[0].code, 'UNSAFE_PAGINATION');
    assert.match(refused.diagnostics[0].message, /Reddit pagination changed filters/);
  } finally {
    store.close();
  }
});

test('the walk beneath DV360 partners keeps the readable partners’ advertisers and refuses a foreign one', async () => {
  const connection = {
    id: 'dv360-walk',
    tenantId: owner.tenantId,
    gateway: 'dv360_native_action',
    accounts: [],
    enabled: false,
    label: 'DV360 login',
    scopes: ['https://www.googleapis.com/auth/display-video'],
    isDefault: true,
  };
  let partners = [{partnerId: '10'}, {partnerId: '20'}];
  const {store, discovery} = fixture(connection, async url => {
    const u = new URL(String(url));
    if (u.pathname === '/v4/partners') return json({partners});
    if (u.pathname === '/v4/advertisers' && u.searchParams.get('partnerId') === '10')
      return json({
        advertisers: [
          {
            advertiserId: '101',
            partnerId: '10',
            displayName: 'Advertiser 101',
            generalConfig: {currencyCode: 'EUR', timeZone: 'Europe/Paris'},
            entityStatus: 'ENTITY_STATUS_ACTIVE',
          },
        ],
      });
    // Partner 20 lists an advertiser of another partner.
    return json({advertisers: [{advertiserId: '999', partnerId: '30'}]});
  });
  try {
    const group = (await discovery.sync(connection)).groups[0];
    assert.equal(group.complete, false);
    assert.deepEqual(
      group.assets.map(a => [a.id, a.name, a.parentId, a.currency, a.timezone, a.status]),
      [['101', 'Advertiser 101', '10', 'EUR', 'Europe/Paris', 'ENTITY_STATUS_ACTIVE']],
    );
    assert.deepEqual(
      group.diagnostics.map(d => [d.parent_id, d.code]),
      [['20', 'ASSET_ID_INVALID']],
    );
    // A partner named twice is refused for the whole kind.
    partners = [{partnerId: '10'}, {partnerId: '10'}];
    const repeated = (await discovery.sync(connection)).groups[0];
    assert.equal(repeated.complete, false);
    assert.equal(repeated.diagnostics[0].code, 'ASSET_ID_INVALID');
    assert.deepEqual(repeated.assets, []);
  } finally {
    store.close();
  }
});
