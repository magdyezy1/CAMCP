import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DelegatedNativeCompiler} from '../dist/src/delegated-native.js';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {ScopeGuard} from '../dist/src/scope.js';
import {providerOf} from '../dist/src/provider-adapters.js';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-field2-access, B4 (the owner's field report of 2026-11-21, issue 4; lead's brief): the path of
// tagmanager.accounts.containers.lookup, /tagmanager/v2/accounts/containers:lookup, was read as the Tag Manager account
// "containers" by both the delegated compiler and ScopeGuard (their account path matched any segment after /accounts/), so every
// lookup was refused ACCOUNT_SCOPE_MISMATCH before anything was sent, whatever account held the container. Tag Manager account IDs
// are numeric (src/gtm-login.ts), so a literal segment can never be an account.

const compiler = new DelegatedNativeCompiler();
const compile = args => compiler.compile('gtm_native_action', {operation: 'gtm_ops', arguments: args});
const lookup = {action: 'LOOKUP_CONTAINER', tagId: 'GTM-ABC1234'};

test('a container lookup compiles for the selected account, and without one, with its route and tag ID', () => {
  const selected = compile({...lookup, account_id: '111'});
  assert.equal(selected.method, 'GET');
  assert.equal(selected.readOnly, true);
  assert.equal(selected.path, '/tagmanager/v2/accounts/containers:lookup');
  assert.deepEqual(selected.query, {tagId: 'GTM-ABC1234'});
  assert.equal(selected.accountId, '111');
  const open = compile(lookup);
  assert.equal(open.path, '/tagmanager/v2/accounts/containers:lookup');
  assert.equal(open.accountId, undefined);
  assert.deepEqual(compile({action: 'LOOKUP_CONTAINER', destinationId: 'AW-123456789'}).query, {
    destinationId: 'AW-123456789',
  });
});

test('the account listing route names no account either way', () => {
  const plan = compile({action: 'LIST_ACCOUNTS'});
  assert.equal(plan.path, '/tagmanager/v2/accounts');
  assert.equal(plan.accountId, undefined);
  assert.equal(compile({action: 'LIST_ACCOUNTS', account_id: '111'}).accountId, '111');
});

test('a path that names another numeric account is still refused at compile, whatever route carries it', () => {
  for (const args of [
    {action: 'LIST_CONTAINERS', account_id: '111', parent: 'accounts/999'},
    {action: 'GET_ACCOUNT', account_id: '111', path: 'accounts/999'},
    {action: 'GET_TAG', account_id: '111', path: 'accounts/999/containers/3/workspaces/4/tags/5'},
  ])
    assert.throws(
      () => compile(args),
      error => assertRefused(error, 'ACCOUNT_SCOPE_MISMATCH', {status: 403}),
      args.action,
    );
  // The same account in the path and the argument, and a path with no account argument, are the selected account.
  assert.equal(compile({action: 'LIST_CONTAINERS', account_id: '111', parent: 'accounts/111'}).accountId, '111');
  assert.equal(compile({action: 'LIST_CONTAINERS', parent: 'accounts/111'}).accountId, '111');
});

test('the account model and the delegated rule of Tag Manager name one pattern, which takes a number only', () => {
  const model = providerOf('gtm_native_action').account.path,
    delegated = providerHooks('gtm_native_action').delegated.scope.account;
  assert.equal(String(model), String(delegated.path));
  assert.deepEqual([...delegated.aliases], []);
  assert.equal(model.exec('/tagmanager/v2/accounts/111/containers')?.[1], '111');
  assert.equal(model.exec('/tagmanager/v2/accounts/111:combine')?.[1], '111');
  assert.equal(model.exec('/tagmanager/v2/accounts/111')?.[1], '111');
  for (const path of [
    '/tagmanager/v2/accounts/containers:lookup',
    '/tagmanager/v2/accounts/111abc',
    '/tagmanager/v2/accounts',
    // Anchored (lead review S3-4): a later /accounts/{number} is not the account of a path whose first account segment is no number.
    '/tagmanager/v2/accounts/x/accounts/111/containers',
    '/tagmanager/v2/accounts/containers:lookup/accounts/111',
    '/other/tagmanager/v2/accounts/111/containers',
    '/accounts/111/containers',
  ])
    assert.equal(model.exec(path), null, path);
  assert.equal(model.exec('/tagmanager/v2/accounts/111/containers/222/workspaces/333')?.[1], '111');
  assert.equal(model.exec('/tagmanager/v2/accounts/222:combine')?.[1], '222');
});

test('every path a Tag Manager plan carries starts with the prefix the account pattern is anchored to', () => {
  // The anchor is only safe if every route does: the 106 routes of the pinned vendor snapshot, each compiled path, and the paths
  // the workflows and diagnostics build themselves (their prefix constant).
  const routes = JSON.parse(fs.readFileSync('generated/vendor-routes.json', 'utf8')).routes.filter(
    r => r.gateway === 'gtm_native_action',
  );
  assert.ok(routes.length > 100);
  for (const route of routes) assert.ok(route.path.startsWith('/tagmanager/v2/'), route.action + ' ' + route.path);
  for (const file of ['src/gtm-diagnostics.ts', 'src/gtm-workflow-writes.ts', 'src/gtm-workspace-writes.ts'])
    assert.match(fs.readFileSync(file, 'utf8'), /prefix\s*=\s*'\/tagmanager\/v2\/'/, file);
});

test('ScopeGuard reads only a numeric segment as the Tag Manager account of a path', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 62).toString('base64'));
  try {
    const guard = new ScopeGuard(new Registry(), store),
      connection = {
        id: 'c-gtm',
        tenantId: 'gtm-account-path',
        gateway: 'gtm_native_action',
        accounts: ['111'],
        label: 'Synthetic',
        enabled: true,
        scopes: [],
      },
      authorize = path =>
        guard.authorize(
          {
            gateway: 'gtm_native_action',
            action: 'gtm_ops/GET',
            method: 'GET',
            path,
            query: {},
            headers: {},
            readOnly: true,
            destructive: false,
            requiresConfirmation: false,
            accountId: '111',
            evidence: 'TEST',
            warnings: [],
          },
          connection,
        );
    // The bound account, and its containers and custom methods, are in scope.
    for (const path of [
      '/tagmanager/v2/accounts/111',
      '/tagmanager/v2/accounts/111/containers',
      '/tagmanager/v2/accounts/111/containers/222/workspaces/333/tags/4',
      '/tagmanager/v2/accounts/111/containers/222:combine',
    ])
      assert.equal(authorize(path), '111', path);
    // Another numeric account is a scope mismatch naming the path, a longer number included.
    for (const path of [
      '/tagmanager/v2/accounts/999/containers',
      '/tagmanager/v2/accounts/1112/containers',
      '/tagmanager/v2/accounts/999',
    ])
      assert.throws(
        () => authorize(path),
        error => assertRefused(error, 'ACCOUNT_SCOPE_MISMATCH', {status: 403}) && error.details.field === 'path',
        path,
      );
    // A literal segment is no account: the lookup route is refused for want of ownership, not for naming "containers". Nor does a
    // later numeric account segment make one of a path whose first account segment is no number (lead review S3-4: the pattern is
    // anchored to the route prefix, so ScopeGuard would not accept either of these two for a login bound to 111).
    for (const path of [
      '/tagmanager/v2/accounts/containers:lookup',
      '/tagmanager/v2/accounts',
      '/tagmanager/v2/accounts/111abc/containers',
      '/tagmanager/v2/accounts/x/accounts/111/containers',
      '/tagmanager/v2/accounts/containers:lookup/accounts/111',
    ])
      assert.throws(
        () => authorize(path),
        error => assertRefused(error, 'RESOURCE_SCOPE_REQUIRED', {status: 403}),
        path,
      );
  } finally {
    store.close();
  }
});
