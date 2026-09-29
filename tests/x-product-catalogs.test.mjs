import test from 'node:test';
import assert from 'node:assert/strict';
import {actionContracts} from '../dist/src/action-contracts.js';
import {authorizeXCatalogRead, xCatalogRead} from '../dist/src/x-catalogs.js';
import {registry, setup, account, gateway} from './x-catalog-fixture.mjs';

/**
 * X product catalogs, opened by the owner on 2026-09-29, from X's "Catalog Management API Reference" (docs.x.com, read
 * 2026-09-29): one catalog per user; POST product_catalogs with name and user_id, PUT with name, DELETE ("a permanent
 * deletion").
 */
const actions = {
  create: 'x_product_catalogs_post',
  rename: 'x_product_catalogs_product_catalog_id_put',
  remove: 'x_product_catalogs_product_catalog_id_delete',
};
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 800));

test('a catalog is created for a FULL promotable user of the account who has none, and read back', async () => {
  const x = setup({noCatalog: true});
  try {
    const p = ok(await x.prepare(actions.create, {name: 'Riyadh shop', user_id: '333'}));
    assert.equal(p.data.creative_impact.operation, 'create');
    assert.equal(p.data.creative_impact.user_id, '333');
    assert.match(p.data.creative_impact.note, /early access/);
    ok(await x.execute(p));
    const sent = x.calls.find(c => c.method === 'POST');
    assert.deepEqual(sent.body, {name: 'Riyadh shop', user_id: '333'});
    assert.match(sent.type, /x-www-form-urlencoded/);
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    refused(await x.prepare(actions.create, {name: 'Second', user_id: '333'}), 'CONFIGURATION_EXISTS');
    refused(await x.prepare(actions.create, {name: 'Second', user_id: '111'}), 'CONFIGURATION_EXISTS');
    refused(await x.prepare(actions.create, {name: 'Retweets', user_id: '222'}), 'STATE_TARGET_MISMATCH');
    refused(await x.prepare(actions.create, {name: 'Stranger', user_id: '999'}), 'STATE_TARGET_MISMATCH');
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('shapes are refused before any request', async () => {
  const x = setup();
  try {
    for (const payload of [
      {name: 'No user'},
      {name: 'X', user_id: 333},
      {name: 'X', user_id: '333', vertical: 'COMMERCE'},
      {name: ' padded', user_id: '333'},
      {name: 'x'.repeat(256), user_id: '333'},
    ])
      assert.equal((await x.prepare(actions.create, payload)).success, false, JSON.stringify(payload));
    refused(
      await x.prepare(actions.rename, {name: 'X', user_id: '111'}, {product_catalog_id: '9001'}),
      'INVALID_X_CATALOG',
    );
    refused(await x.prepare(actions.remove, {name: 'X'}, {product_catalog_id: '9001'}), 'INVALID_X_CATALOG');
    assert.equal(x.calls.length, 0);
  } finally {
    x.store.close();
  }
});

test('a catalog of a promotable user is renamed; catalogs of other users are out of scope', async () => {
  const x = setup();
  try {
    const p = ok(await x.prepare(actions.rename, {name: 'Shop KSA'}, {product_catalog_id: '9001'}));
    assert.deepEqual(p.data.creative_impact.before, {name: 'Shop'});
    ok(await x.execute(p));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    refused(await x.prepare(actions.rename, {name: 'Shop KSA'}, {product_catalog_id: '9001'}), 'INVALID_X_CATALOG');
    refused(await x.prepare(actions.rename, {name: 'Mine'}, {product_catalog_id: '9009'}), 'STATE_TARGET_MISMATCH');
    // AMCP never lists the catalogs of a user who is not a promotable user of the account.
    assert.ok(!x.calls.some(c => c.query.user_id === '999'));
  } finally {
    x.store.close();
  }
});

test('only an empty catalog is deleted: no product, product set or scheduled feed', async () => {
  const x = setup();
  try {
    const full = await x.prepare(actions.remove, undefined, {product_catalog_id: '9001'});
    refused(full, 'CATALOG_NOT_EMPTY');
    assert.match(full.error.message, /products, 2 product set\(s\), its scheduled feed/);
    assert.match(full.error.remedy.action, /Nothing was submitted.*each with its own review/);
    const p = ok(await x.prepare(actions.remove, undefined, {product_catalog_id: '9002'}));
    assert.equal(p.data.creative_impact.deleting.name, 'Empty');
    ok(await x.execute(p));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    assert.ok(!x.catalogs.has('9002'));
  } finally {
    x.store.close();
  }
});

test('internal catalog reads are limited to the exact shapes the readers build', () => {
  const plan = {gateway, accountId: account, action: 'x_product_catalogs_get', query: {}, headers: {}, readOnly: true};
  const read = (path, query, tag) => xCatalogRead(plan, path, query, tag);
  assert.equal(
    authorizeXCatalogRead(read('/12/accounts/' + account + '/promotable_users', {count: 200}), account),
    true,
  );
  assert.equal(
    authorizeXCatalogRead(read('/12/product_catalogs', {user_id: '111'}, {xCatalogUser: '111'}), account),
    true,
  );
  assert.equal(
    authorizeXCatalogRead(read('/12/product_catalogs/9001/products', {count: 100}, {xCatalogId: '9001'}), account),
    true,
  );
  for (const [path, query, tag] of [
    ['/12/product_catalogs', {user_id: '999'}, {}],
    ['/12/product_catalogs', {user_id: '999'}, {xCatalogUser: '111'}],
    ['/12/product_catalogs/9009/products', {count: 100}, {xCatalogId: '9001'}],
    ['/12/product_catalogs/9001/products', {count: 100, filter: 'x'}, {xCatalogId: '9001'}],
    ['/12/accounts/other/promotable_users', {count: 200}, {}],
  ])
    assert.throws(() => authorizeXCatalogRead(read(path, query, tag), account), /RESOURCE_SCOPE_REQUIRED|Unqualified/);
  const rows = actionContracts(registry);
  assert.deepEqual(
    rows
      .filter(r => r.family === 'x_product_catalogs')
      .map(r => r.action)
      .sort(),
    Object.values(actions).sort(),
  );
});
