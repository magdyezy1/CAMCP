import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {AssetDiscovery} from '../dist/server/asset-discovery.js';

/**
 * The owner's request of 2026-09-29: the website names each advertising account by its own name and ID, never
 * "LinkedIn Ads 55864214" or the ID alone. LinkedIn's adAccountUsers finder returns only the account URN and the
 * member's role, so discovery reads each account (GET /rest/adAccounts/{id}, the read AMCP already uses for
 * LinkedIn reviews) for its name, currency and status.
 */
const master = Buffer.alloc(32, 91).toString('base64'),
  owner = {tenantId: 'names', userId: 'owner', role: 'admin'};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

test('LinkedIn discovery names each ad account from its own read, and never invents a name', async () => {
  const store = new Store(':memory:', master);
  try {
    const connection = {
      id: 'li',
      tenantId: owner.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['55864214'],
      enabled: true,
      label: 'LinkedIn login',
      scopes: ['r_ads'],
      isDefault: true,
    };
    store.putConnection(owner, connection, {accessToken: 'synthetic'});
    const reads = [];
    const discovery = new AssetDiscovery(store, async url => {
      const u = new URL(String(url));
      if (u.pathname === '/rest/adAccountUsers')
        return json({
          elements: [
            {account: 'urn:li:sponsoredAccount:55864214', role: 'ACCOUNT_MANAGER'},
            {account: 'urn:li:sponsoredAccount:222', role: 'VIEWER'},
          ],
          paging: {start: 0, count: 100, total: 2, links: []},
        });
      reads.push(u.pathname);
      if (u.pathname === '/rest/adAccounts/55864214')
        return json({id: 55864214, name: 'Riyadh Brand', currency: 'SAR', status: 'ACTIVE'});
      return json({status: 403, message: 'Not enough permissions'}, 403);
    });
    const result = await discovery.sync(connection);
    const group = result.groups[0];
    assert.equal(group.complete, true, JSON.stringify(group));
    const byId = Object.fromEntries(group.assets.map(a => [a.id, a]));
    assert.deepEqual(reads.sort(), ['/rest/adAccounts/222', '/rest/adAccounts/55864214']);
    assert.equal(byId['55864214'].name, 'Riyadh Brand');
    assert.equal(byId['55864214'].currency, 'SAR');
    assert.equal(byId['55864214'].status, 'ACTIVE');
    // An account whose own read fails keeps its ID as its name: no "LinkedIn Ads 222".
    assert.equal(byId['222'].name, '222');
    assert.ok(!group.assets.some(a => /LinkedIn Ads/.test(a.name)));
  } finally {
    store.close();
  }
});
