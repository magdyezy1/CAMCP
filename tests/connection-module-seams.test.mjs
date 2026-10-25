import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';
import {accountKey, bindingKey} from '../dist/src/access-sets.js';
import {normalizeAccount} from '../dist/src/account-id.js';
import {providerAdapters} from '../dist/src/provider-adapters.js';
import {Store} from '../dist/src/store.js';

// ARC-01 phase B, the login and connection modules the website and the MCP service share: the provider facts they held
// (how an account ID compares, ...) are the provider adapters' (src/provider-adapters.ts) or their website login steps'
// (src/<provider>-login.ts), so these modules name no gateway. The behaviour of each is pinned by its suites
// (tests/client-access-sets.test.ts, tests/service.test.ts, ...); these cases pin the seams.

const graph = runtimeGraph(process.cwd());
const providerImports = file =>
  [...graph.get(file)].filter(id => isProviderModule(id) && !providerRegistries.includes(id)).sort();
const source = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const gatewayLiteral = /['"][a-z0-9_]+_native_action['"]/;

test('client access sets and connection resolution compare accounts in the adapters’ account form', () => {
  for (const file of ['src/access-sets.ts', 'src/store.ts'])
    assert.deepEqual(providerImports(file), [], file + ' imports no provider module');
  assert.doesNotMatch(source('src/access-sets.ts'), gatewayLiteral);
  // The comparison the access sets made before: Meta without act_, Google Ads without dashes, every other ID as given.
  const before = (gateway, id) => {
    const value = String(id);
    return gateway === 'meta_native_action'
      ? value.replace(/^act_/, '')
      : gateway === 'google_ads_native_action'
        ? value.replaceAll('-', '')
        : value;
  };
  const ids = ['act_123', '123-456-7890', 'act_12-3', 'customers/1-2', 123, '', 'ACT_9', '  7 '];
  for (const {gateway} of providerAdapters)
    for (const id of ids) {
      assert.equal(accountKey(gateway, id), before(gateway, id), gateway + ' ' + id);
      assert.equal(accountKey(gateway, id), normalizeAccount(gateway, id), gateway + ' ' + id);
    }
  for (const id of ids) assert.equal(accountKey('amcp_workspace', id), before('amcp_workspace', id));
  assert.equal(bindingKey('meta_native_action', 'c1', 'act_42'), 'meta_native_action\u0000c1\u000042');
  // Only Google Ads and Meta declare an account form of their own.
  assert.deepEqual(
    providerAdapters.filter(a => a.account?.normalize).map(a => a.gateway),
    ['google_ads_native_action', 'meta_native_action'],
  );
});

test('a connection resolves by an account in its display form, as before', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 53).toString('base64')),
    actor = {tenantId: 'account-forms', userId: 'owner', role: 'admin'};
  try {
    const login = (id, gateway, accounts) =>
      store.putConnection(
        actor,
        {id, tenantId: actor.tenantId, gateway, accounts, enabled: true, label: id, scopes: []},
        {accessToken: 'synthetic-access'},
      );
    login('google', 'google_ads_native_action', ['1234567890']);
    login('meta', 'meta_native_action', ['act_111']);
    login('tiktok', 'tiktok_native_action', ['act_222']);
    assert.equal(store.resolveConnection(actor, 'google_ads_native_action', '123-456-7890').id, 'google');
    assert.equal(store.resolveConnection(actor, 'meta_native_action', '111').id, 'meta');
    assert.equal(store.resolveConnection(actor, 'meta_native_action', 'act_111').id, 'meta');
    // Another provider's ID is compared as given: no act_ is dropped.
    assert.equal(store.resolveConnection(actor, 'tiktok_native_action', 'act_222').id, 'tiktok');
    assert.throws(
      () => store.resolveConnection(actor, 'tiktok_native_action', '222'),
      e => e.code === 'CONNECTION_REQUIRED',
    );
    assert.throws(
      () => store.resolveConnection(actor, 'google_ads_native_action', '1234567891'),
      e => e.code === 'CONNECTION_REQUIRED',
    );
  } finally {
    store.close();
  }
});
