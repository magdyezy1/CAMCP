import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {listingBinding, listingPlace, projectListing} from '../dist/src/account-free-listing.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';

// r25-field2-access, B3: the ownership rule of an account-free listing, as a shared leaf a second provider can reuse (the lead's
// request: Tag Manager's accounts now, TikTok's Business Centers later). It is pure over the rows and the binding, so these tests
// use rows of another provider's shape to show that nothing in it is Tag Manager's.
//
// Lead review S3-3: a TikTok login binds advertisers (its accounts), not Business Centers, so the IDs a login binds at the listed
// level cannot always be its `accounts`: the provider gives them (the `ids` argument of listingBinding). Where TikTok's package keeps
// its Business Center bindings is its decision; these tests use a source that is not `accounts` and that a client access set narrows
// the way it narrows accounts: the path prefix of an administrator's resource binding for an advertiser (src/access-sets.ts narrows a
// login's resource bindings by their account). Synthetic IDs: advertisers 701 and 702; Business Centers 111 and 222 bound, 333 not.

const tenant = 'account-free-listing',
  admin = {tenantId: tenant, userId: 'admin', role: 'admin'},
  operator = {tenantId: tenant, userId: 'operator', role: 'operator'},
  gateway = 'tiktok_native_action',
  login = 'cccccccc-9999-4999-8999-000000000001';
const businessCenters = connection => (connection.resourceBindings ?? []).map(b => b.pathPrefix.split('/').at(-1));

function workspace(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 67).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    admin,
    {
      id: login,
      tenantId: tenant,
      gateway,
      accounts: ['701', '702'],
      resourceBindings: [
        {accountId: '701', pathPrefix: '/business_centers/111'},
        {accountId: '702', pathPrefix: '/business_centers/222'},
      ],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const set = saveAccessSet(store, admin, {
    name: 'Client one',
    bindings: [{gateway, connection_id: login, account_id: '701'}],
  });
  return {store, client: {tenantId: tenant, userId: 'client', role: 'operator', accessSetId: String(set.id)}};
}
const rows = [
  {bc_id: '111', bc_name: 'Center one', timezone: 'UTC'},
  {bc_id: '222', bc_name: 'Center two'},
  {bc_id: '333', bc_name: 'Center three', timezone: 'UTC'},
];
const project = binding =>
  projectListing(
    binding,
    rows,
    row => row.bc_id,
    row => ({id: row.bc_id, name: row.bc_name, connected: false}),
  );

test('the binding is what the login binds at the listed level and the actor reaches, and only an administrator without an access set may see the rest', t => {
  const {store, client} = workspace(t),
    whole = store.resolveConnection(admin, gateway, undefined, login);
  const asAdmin = listingBinding(store, admin, whole, businessCenters);
  assert.deepEqual([...asAdmin.reachable], ['111', '222']);
  assert.deepEqual([...asAdmin.elsewhere], []);
  assert.equal(asAdmin.administrator, true);
  assert.equal(listingBinding(store, operator, whole, businessCenters).administrator, false);
  assert.equal(listingBinding(store, {...operator, role: 'reader'}, whole, businessCenters).administrator, false);
  // A client access set narrows the login to its accounts and their resource bindings, and the Business Center of the other
  // advertiser is elsewhere, never the actor's to learn of: the source is applied to the narrowed login and to the whole one.
  const narrowed = store.resolveConnection(client, gateway, undefined, login),
    scoped = listingBinding(store, client, narrowed, businessCenters);
  assert.deepEqual([...scoped.reachable], ['111']);
  assert.deepEqual([...scoped.elsewhere], ['222']);
  assert.equal(scoped.administrator, false);
  // The role does not matter once a set limits the actor (a set is never on an administrator, and if one were, the set wins).
  assert.equal(listingBinding(store, {...client, role: 'admin'}, narrowed, businessCenters).administrator, false);
  for (const [id, place] of [
    ['111', 'bound'],
    ['222', 'elsewhere'],
    ['333', 'unbound'],
    ['', 'unbound'],
  ])
    assert.equal(listingPlace(scoped, id), place, id);
  // Without a source the IDs a login binds are its accounts, as Tag Manager's listing takes them; for this login, its advertisers.
  const byAccounts = listingBinding(store, client, narrowed);
  assert.deepEqual([...byAccounts.reachable], ['701']);
  assert.deepEqual([...byAccounts.elsewhere], ['702']);
  assert.equal(listingPlace(byAccounts, '111'), 'unbound', 'a Business Center is not one of the accounts');
});

test('a listing is projected by that binding: bound rows whole, the rest by ID and name for the administrator, counted for everyone', t => {
  const {store, client} = workspace(t),
    whole = store.resolveConnection(admin, gateway, undefined, login);
  const asAdmin = project(listingBinding(store, admin, whole, businessCenters));
  assert.deepEqual(asAdmin.rows, [
    {bc_id: '111', bc_name: 'Center one', timezone: 'UTC', connected: true},
    {bc_id: '222', bc_name: 'Center two', connected: true},
    {id: '333', name: 'Center three', connected: false},
  ]);
  assert.equal(asAdmin.notConnected, 1);
  const asOperator = project(listingBinding(store, operator, whole, businessCenters));
  assert.deepEqual(asOperator.rows, [
    {bc_id: '111', bc_name: 'Center one', timezone: 'UTC', connected: true},
    {bc_id: '222', bc_name: 'Center two', connected: true},
  ]);
  assert.equal(asOperator.notConnected, 1);
  assert.doesNotMatch(JSON.stringify(asOperator), /333|Center three/);
  const asClient = project(
    listingBinding(store, client, store.resolveConnection(client, gateway, undefined, login), businessCenters),
  );
  assert.deepEqual(asClient.rows, [{bc_id: '111', bc_name: 'Center one', timezone: 'UTC', connected: true}]);
  assert.equal(asClient.notConnected, 1, 'the bound account outside the set is not counted, the unbound one is');
  assert.doesNotMatch(JSON.stringify(asClient), /222|333|Center two|Center three/);
  // The rows it is given are not changed.
  assert.equal(rows[0].connected, undefined);
});

test('it names no provider and imports no provider module, so any provider’s workflow may use it', () => {
  const source = fs.readFileSync(new URL('../src/account-free-listing.ts', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/['"]([a-z0-9]+(?:_[a-z0-9]+)*)_native_action['"]/g)], [], 'no gateway literal');
  const imported = [...source.matchAll(/^import [^;]*? from '\.\/([^']+)\.js';/gms)].map(m => 'src/' + m[1] + '.ts');
  assert.ok(imported.length > 0);
  assert.deepEqual(
    imported.filter(file => isProviderModule(file) && !providerRegistries.includes(file)),
    [],
  );
});
