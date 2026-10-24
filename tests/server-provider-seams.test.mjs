import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';
import {providerLogin, registeredProviderLogins} from '../dist/src/provider-logins.js';
import {providerById} from '../dist/src/provider-adapters.js';
import {googleAccountDiscovery, googleSelectedAccountRead} from '../dist/src/google-account-discovery.js';
import {googleAccountDiscovery as serverAccountDiscovery} from '../dist/server/google-account-discovery.js';
import {googleAdsCustomers} from '../dist/src/google-version.js';

// ARC-01 phase B, the website's server modules: route modules, the website's own flows and the composition root take
// their provider facts from the registries instead of naming a gateway or importing a provider module. The behaviour
// of each moved step is pinned by its suites (tests/google-reauthorization.test.ts, tests/connection-management.test.mjs
// and the cross-build pins of tests/website-server-steps.test.mjs); these cases pin the seams.

const graph = runtimeGraph(process.cwd());
const providerImports = file =>
  [...graph.get(file)].filter(id => isProviderModule(id) && !providerRegistries.includes(id)).sort();
const source = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const gatewayLiteral = /['"][a-z0-9_]+_native_action['"]/;

test('the Google renewal names no gateway and reads through Google Ads’ renewal steps', () => {
  for (const file of ['server/google-reauthorization.ts', 'server/google-account-discovery.ts']) {
    assert.doesNotMatch(source(file), gatewayLiteral, file);
    assert.deepEqual(providerImports(file), [], file + ' consults the provider login registry instead');
    assert.ok(graph.get(file).has('src/provider-logins.ts'), file);
  }
  const gateway = providerById('google').gateway,
    renewal = providerLogin(gateway).renewal;
  assert.ok(Object.isFrozen(renewal));
  // The hierarchy is the one asset discovery reads, and the server module's public path still names that function.
  assert.equal(renewal.accounts, googleAccountDiscovery);
  assert.equal(serverAccountDiscovery, googleAccountDiscovery);
  assert.equal(renewal.selectedAccountRead, googleSelectedAccountRead);
  // The read of a selected account, as the renewal sent it before the move.
  assert.deepEqual(renewal.selectedAccountRead(gateway, '1234567890'), {
    gateway,
    action: 'AMCP_GOOGLE_SELECTED_VERIFICATION',
    method: 'POST',
    path: googleAdsCustomers + '1234567890/googleAds:search',
    query: {},
    body: {query: 'SELECT customer.id, customer.currency_code, customer.time_zone, customer.status FROM customer'},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'SELECTED_ACCOUNT_VERIFICATION',
    warnings: [],
  });
  // Only Google Ads renews through its own reads; every other platform renews through its asset discovery
  // (server/connection-reauthorization.ts).
  assert.deepEqual(
    registeredProviderLogins.filter(l => l.renewal).map(l => l.gateway),
    [gateway],
  );
});
