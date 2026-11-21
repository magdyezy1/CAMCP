import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {listingBinding, listingPlace, projectListing} from '../dist/src/account-free-listing.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';

// r25-field2-access, B3: the ownership rule of an account-free listing, as a shared leaf a second provider can reuse (the lead's
// request: Tag Manager's accounts now, TikTok's Business Centers later). It is pure over the rows and the binding, so these tests
// use rows of another provider's shape to show that nothing in it is Tag Manager's. Synthetic IDs: 111 and 222 bound, 333 not.

const tenant = 'account-free-listing',
  admin = {tenantId: tenant, userId: 'admin', role: 'admin'},
  operator = {tenantId: tenant, userId: 'operator', role: 'operator'},
  gateway = 'tiktok_native_action',
  login = 'cccccccc-9999-4999-8999-000000000001';

function workspace(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 67).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    admin,
    {id: login, tenantId: tenant, gateway, accounts: ['111', '222'], enabled: true, label: 'Synthetic', scopes: []},
    {accessToken: 'synthetic'},
  );
  const set = saveAccessSet(store, admin, {
    name: 'Client one',
    bindings: [{gateway, connection_id: login, account_id: '111'}],
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

test('the binding is what the login binds and the actor reaches, and only an administrator without an access set may see the rest', t => {
  const {store, client} = workspace(t),
    whole = store.resolveConnection(admin, gateway, undefined, login);
  const asAdmin = listingBinding(store, admin, whole);
  assert.deepEqual([...asAdmin.reachable], ['111', '222']);
  assert.deepEqual([...asAdmin.elsewhere], []);
  assert.equal(asAdmin.administrator, true);
  assert.equal(listingBinding(store, operator, whole).administrator, false);
  assert.equal(listingBinding(store, {...operator, role: 'reader'}, whole).administrator, false);
  // A client access set narrows the login to its accounts; the other bound account is elsewhere, never the actor's to learn of.
  const narrowed = store.resolveConnection(client, gateway, undefined, login),
    scoped = listingBinding(store, client, narrowed);
  assert.deepEqual([...scoped.reachable], ['111']);
  assert.deepEqual([...scoped.elsewhere], ['222']);
  assert.equal(scoped.administrator, false);
  // The role does not matter once a set limits the actor (a set is never on an administrator, and if one were, the set wins).
  assert.equal(listingBinding(store, {...client, role: 'admin'}, narrowed).administrator, false);
  for (const [id, place] of [
    ['111', 'bound'],
    ['222', 'elsewhere'],
    ['333', 'unbound'],
    ['', 'unbound'],
  ])
    assert.equal(listingPlace(scoped, id), place, id);
});

test('a listing is projected by that binding: bound rows whole, the rest by ID and name for the administrator, counted for everyone', t => {
  const {store, client} = workspace(t),
    whole = store.resolveConnection(admin, gateway, undefined, login);
  const asAdmin = project(listingBinding(store, admin, whole));
  assert.deepEqual(asAdmin.rows, [
    {bc_id: '111', bc_name: 'Center one', timezone: 'UTC', connected: true},
    {bc_id: '222', bc_name: 'Center two', connected: true},
    {id: '333', name: 'Center three', connected: false},
  ]);
  assert.equal(asAdmin.notConnected, 1);
  const asOperator = project(listingBinding(store, operator, whole));
  assert.deepEqual(asOperator.rows, [
    {bc_id: '111', bc_name: 'Center one', timezone: 'UTC', connected: true},
    {bc_id: '222', bc_name: 'Center two', connected: true},
  ]);
  assert.equal(asOperator.notConnected, 1);
  assert.doesNotMatch(JSON.stringify(asOperator), /333|Center three/);
  const asClient = project(listingBinding(store, client, store.resolveConnection(client, gateway, undefined, login)));
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
