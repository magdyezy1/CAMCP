import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {providerAdapters} from '../dist/src/provider-adapters.js';
import {accountPlatforms, contextOperationHelp} from '../dist/src/context-operations.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-field2-access, B5 (the owner's field report of 2026-11-21, issue 5; lead's decision D8): list_accounts filtered by the short
// name of a platform ("gtm") and refused the full name every row is labeled with ("gtm_native_action"), so the filter and the output
// used different vocabularies. Now each label a row carries is a valid filter, the short spellings stay, and the spellings the
// reporting tools use (microsoft, apple, gsc) are accepted too. The AMBIGUOUS_CONNECTION refusal names the filter for every provider.

const registry = new Registry(),
  owner = {tenantId: 'platform-names', userId: 'owner', role: 'admin'},
  suffix = '_native_action';
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 63).toString('base64')),
    requests = [];
  t.after(() => store.close());
  store.ensureTenant(owner.tenantId);
  // Two logins of every provider bound to the same account, so that a call naming the account is ambiguous.
  for (const adapter of providerAdapters)
    for (const letter of ['a', 'b'])
      store.putConnection(
        owner,
        {
          id: adapter.id + '-' + letter,
          tenantId: owner.tenantId,
          gateway: adapter.gateway,
          accounts: ['111'],
          enabled: true,
          label: 'Synthetic ' + adapter.id + ' ' + letter,
          scopes: [],
        },
        {accessToken: 'synthetic'},
      );
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async input => {
      requests.push(String(input));
      throw Error('list_accounts reads AMCP records and sends nothing');
    }),
  );
  return {
    store,
    service,
    requests,
    list: args => service.call('amcp_platform_workspace', {operation: 'list_accounts', arguments: args}, owner),
  };
}
const ids = result => {
  assert.equal(result.success, true, JSON.stringify(result.error));
  return result.data.map(row => row.connection_id).sort();
};

test('the full gateway name filters like the short one, and every row carries the label that filters to it', async t => {
  const f = fixture(t);
  const short = await f.list({platform: 'gtm'});
  assert.equal(short.success, true, JSON.stringify(short));
  assert.deepEqual(ids(short), ['gtm-a', 'gtm-b']);
  assert.ok(short.data.every(row => row.platform === 'gtm_native_action'));
  const full = await f.list({platform: 'gtm_native_action'});
  assert.equal(full.success, true, JSON.stringify(full));
  assert.deepEqual(full.data, short.data);
  assert.equal(f.requests.length, 0);
});

test('for the login of every provider, the platform its own row carries, its short name and its ID select exactly its rows', async t => {
  const f = fixture(t);
  for (const adapter of providerAdapters) {
    const label = adapter.gateway,
      expected = [adapter.id + '-a', adapter.id + '-b'];
    for (const name of [label, label.slice(0, -suffix.length), adapter.id]) {
      const out = await f.list({platform: name});
      assert.equal(out.success, true, name + ': ' + JSON.stringify(out.error));
      assert.deepEqual(ids(out), expected, name);
      assert.ok(
        out.data.every(row => row.platform === label),
        name,
      );
    }
  }
  assert.equal(f.requests.length, 0);
});

test('the reporting spellings microsoft, apple and gsc select their gateway (D8)', async t => {
  const f = fixture(t);
  for (const [name, gateway] of [
    ['microsoft', 'microsoft_ads_native_action'],
    ['apple', 'apple_ads_native_action'],
    ['gsc', 'google_search_console_native_action'],
  ]) {
    const out = await f.list({platform: name});
    assert.equal(out.success, true, name + ': ' + JSON.stringify(out.error));
    assert.ok(out.data.length === 2 && out.data.every(row => row.platform === gateway), name);
  }
});

test('a name that is no provider is refused with the names that are, in both spellings', async t => {
  const f = fixture(t);
  for (const platform of [
    'gtm_native',
    'gtm_native_actionx',
    'gtm_native_action_',
    'amcp_native_action',
    'amcp_platform_workspace',
    'GTM',
    ' gtm',
    '',
    5,
    null,
    ['gtm'],
    {platform: 'gtm'},
  ]) {
    const out = await f.list({platform});
    assertRefused(out, 'INVALID_ARGUMENT');
    assert.equal(out.error.details.field, 'platform', JSON.stringify(platform));
    const allowed = out.error.details.allowed;
    assert.deepEqual(allowed, [...allowed].sort());
    for (const name of [
      'gtm',
      'gtm_native_action',
      'meta',
      'meta_native_action',
      'microsoft',
      'google_ads_native_action',
    ])
      assert.ok(allowed.includes(name), name);
    assert.ok(!allowed.includes('amcp_native_action'));
  }
  assert.equal(f.requests.length, 0);
});

test('report destinations are listed only when their platform is asked for, by any of its names, and inactive accounts stay refused', async t => {
  const f = fixture(t),
    all = await f.list({});
  assert.equal(all.success, true);
  assert.ok(!all.data.some(row => /google_(sheets|drive)_native_action/.test(row.platform)));
  for (const name of ['sheets', 'google_sheets', 'google_sheets_native_action']) {
    const out = await f.list({platform: name});
    assert.deepEqual(ids(out), ['sheets-a', 'sheets-b'], name);
  }
  for (const name of ['drive', 'google_drive', 'google_drive_native_action'])
    assert.deepEqual(ids(await f.list({platform: name})), ['drive-a', 'drive-b'], name);
  assertRefused(await f.list({include_inactive: true}), 'INVALID_ARGUMENT', {message: /include_inactive/});
  assertRefused(await f.list({platform: 'gtm_native_action', include_inactive: true}), 'INVALID_ARGUMENT');
});

test('every login of every provider that is ambiguous names the filter that lists its candidates, and that call succeeds', async t => {
  const f = fixture(t);
  for (const adapter of providerAdapters) {
    let refusal;
    assert.throws(
      () => f.store.resolveConnection(owner, adapter.gateway, '111'),
      error => {
        refusal = error;
        return assertRefused(error, 'AMBIGUOUS_CONNECTION');
      },
      adapter.id,
    );
    const next = refusal.details.next_call;
    assert.equal(next.tool, 'amcp_platform_workspace');
    assert.equal(next.arguments.operation, 'list_accounts');
    assert.equal(
      typeof next.arguments.arguments.platform,
      'string',
      adapter.id + ' gets a filter, not the unfiltered list',
    );
    const listed = await f.service.call(next.tool, next.arguments, owner);
    assert.equal(listed.success, true, adapter.id + ': ' + JSON.stringify(listed.error));
    assert.deepEqual(ids(listed), [adapter.id + '-a', adapter.id + '-b'], adapter.id);
  }
  // The providers that already had a filter keep the one they had.
  for (const [gateway, platform] of [
    ['meta_native_action', 'meta'],
    ['google_ads_native_action', 'google'],
    ['x_ads_native_action', 'x'],
    ['tiktok_native_action', 'tiktok'],
  ])
    assert.throws(
      () => f.store.resolveConnection(owner, gateway, '111'),
      error =>
        assertRefused(error, 'AMBIGUOUS_CONNECTION') &&
        error.details.next_call.arguments.arguments.platform === platform,
      gateway,
    );
});

test('a Tag Manager call that names an account two logins bind is refused with the Tag Manager filter, and nothing is sent', async t => {
  const f = fixture(t),
    out = await f.service.call(
      'gtm_native_action',
      {operation: 'gtm_ops', arguments: {action: 'LIST_CONTAINERS', account_id: '111'}},
      owner,
    );
  assertRefused(out, 'AMBIGUOUS_CONNECTION');
  assert.deepEqual(out.error.details.next_call, {
    tool: 'amcp_platform_workspace',
    arguments: {operation: 'list_accounts', arguments: {platform: 'gtm'}},
  });
  assert.equal(f.requests.length, 0);
});

test('operation help lists every accepted name, the full gateway names and the reporting spellings included', () => {
  const names = accountPlatforms(registry),
    help = contextOperationHelp(registry, {gateway: 'amcp_platform_workspace', operation: 'list_accounts'}),
    listed = help.argumentsSchema.properties.platform.enum;
  assert.deepEqual(listed, names);
  assert.deepEqual(names, [...new Set(names)].sort());
  for (const adapter of providerAdapters)
    for (const name of [adapter.id, adapter.gateway, adapter.gateway.slice(0, -suffix.length)])
      assert.ok(names.includes(name), name);
  // Nothing else is accepted: every name is a provider's ID, a gateway of a provider, or that gateway without its suffix.
  const known = new Set(
    providerAdapters.flatMap(adapter => [adapter.id, adapter.gateway, adapter.gateway.slice(0, -suffix.length)]),
  );
  assert.deepEqual(
    names.filter(name => !known.has(name)),
    [],
  );
});
