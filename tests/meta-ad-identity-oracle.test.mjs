// F-L3-03 (audit L3, L9 F-L9-03): the Meta ad identity probe is for amcp_ad_previews only, and it tells a reader nothing
// about an ad outside their access set. A reader limited to one client's account asks for an ad of another account of the
// same login, and for an ad that does not exist: both get the same answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {AdPreviews} from '../dist/src/ad-previews.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const admin = {tenantId: 'synthetic-meta-oracle', userId: 'admin', role: 'admin'},
  login = 'aaaaaaaa-1111-4111-8111-000000000001';
const probe = id => ({
  action: 'meta_ad_id_get',
  account_id: '100',
  connection_id: login,
  ad_id: id,
  query: {fields: 'id,account_id'},
});
const previews = (...ids) => ({platform: 'meta', account_id: '100', connection_id: login, ad_ids: ids});

function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64')),
    requests = [];
  t.after(() => store.close());
  store.putConnection(
    admin,
    {
      id: login,
      tenantId: admin.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100', '200'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  // 111 is an ad of account 100, 222 an ad of account 200 (another client's, same login); every other ID does not exist.
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async raw => {
      const url = new URL(String(raw)),
        id = url.pathname.split('/').at(-1);
      requests.push(url.pathname + '?' + (url.searchParams.get('fields') ?? url.searchParams.get('ad_format') ?? ''));
      if (url.pathname.endsWith('/previews'))
        return Response.json({
          data: [{body: '<iframe src="https://www.facebook.com/ads/preview/' + id + '"></iframe>'}],
        });
      const fields = url.searchParams.get('fields') ?? '';
      if (id === '111')
        return Response.json({
          id: '111',
          account_id: '100',
          ...(fields.includes('name') ? {name: 'Own ad', effective_status: 'ACTIVE'} : {}),
        });
      if (id === '222')
        return Response.json({id: '222', account_id: '200', name: 'FOREIGN CLIENT AD', effective_status: 'ACTIVE'});
      return Response.json(
        {
          error: {
            message:
              "Unsupported get request. Object with ID '" +
              id +
              "' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
            type: 'GraphMethodException',
            code: 100,
            error_subcode: 33,
            fbtrace_id: 'synthetic',
          },
        },
        {status: 400},
      );
    }),
    undefined,
    {allowWrites: false, requireBeforeState: true, maxBudgetChange: 0},
  );
  const set = saveAccessSet(store, admin, {
    name: 'client-a',
    bindings: [{gateway: 'meta_native_action', connection_id: login, account_id: '100'}],
  });
  return {
    store,
    service,
    requests,
    limited: {tenantId: admin.tenantId, userId: 'reader-a', role: 'reader', accessSetId: set.id},
  };
}

test('F-L3-03: a direct identity probe of an ad the caller was never shown to own is refused before any request, whoever asks', async t => {
  const f = fixture(t);
  const actors = {'a reader limited to one client': f.limited, 'the workspace admin': admin};
  const answers = [];
  for (const [who, actor] of Object.entries(actors))
    for (const id of ['111', '222', '333']) {
      const out = await f.service.call('meta_native_action', probe(id), actor);
      assertRefused(out, 'RESOURCE_SCOPE_REQUIRED');
      assert.equal(f.requests.length, 0, who + ' ' + id);
      answers.push([out.error.code, out.error.message.replace(id, '<id>')]);
    }
  // An own ad, a foreign ad and an ad that does not exist: one code, one message.
  assert.equal(new Set(answers.map(answer => answer.join('|'))).size, 1);
});

test('F-L3-03: through the previews tool a foreign ad and an ad that does not exist give the same answer to a limited reader', async t => {
  const f = fixture(t),
    foreign = await f.service.call('amcp_ad_previews', previews('222'), f.limited),
    absent = await f.service.call('amcp_ad_previews', previews('333'), f.limited);
  for (const out of [foreign, absent]) {
    assert.equal(out.success, true, JSON.stringify(out.error));
    assert.deepEqual(out.data.previews, []);
    assert.equal(out.data.not_found_reason, 'Not in this account');
  }
  assert.deepEqual(foreign.data.not_found, ['222']);
  assert.deepEqual(absent.data.not_found, ['333']);
  // Apart from the ID they name, the two answers are the same text.
  const text = (out, id) => JSON.stringify(out.data).replaceAll(id, '<id>');
  assert.equal(text(foreign, '222'), text(absent, '333'));
  // One identity read each, nothing broader: the foreign ad's name was never requested.
  assert.deepEqual(f.requests, ['/v26.0/222?id,account_id', '/v26.0/333?id,account_id']);
  assert.doesNotMatch(JSON.stringify([foreign, absent]), /FOREIGN CLIENT AD|fbtrace|Unsupported get request/);
  // An ad of the reader's own account is still previewed, and only then does it count as owned.
  const own = await f.service.call('amcp_ad_previews', previews('111'), f.limited);
  assert.deepEqual(
    own.data.previews.map(p => p.ad_id),
    ['111'],
  );
  const connection = f.store.resolveConnection(f.limited, 'meta_native_action', '100', login);
  assert.equal(f.store.ownsResource(connection, '100', '111'), true);
  for (const id of ['222', '333']) assert.equal(f.store.ownsResource(connection, '100', id), false, id);
});

test('F-L3-03: however the identity read finds an ad is not the account’s, the tool lists it as not in this account and goes no further; any other failure still fails the call', async t => {
  const f = fixture(t),
    read = async error => {
      const reads = [],
        tool = new AdPreviews(async (_tool, input) => {
          reads.push(input.action);
          return {success: false, error};
        }, f.store);
      return {reads, run: () => tool.handle(previews('333'), admin)};
    };
  const absence = {
    'the observer’s refusal of a foreign ad': {code: 'ACCOUNT_SCOPE_MISMATCH', message: 'Not in this account'},
    'the refusal of a node whose ownership is not established': {
      code: 'RESOURCE_SCOPE_REQUIRED',
      message: 'Resource ownership is not established.',
    },
    'a not-found answer': {code: 'NOT_FOUND', message: 'No such object.'},
    'a 404 from Meta': {code: 'UPSTREAM_ERROR', message: 'Platform returned HTTP 404', details: {http_status: 404}},
  };
  for (const [what, error] of Object.entries(absence)) {
    const {reads, run} = await read(error),
      out = await run();
    assert.deepEqual(out.not_found, ['333'], what);
    assert.equal(out.not_found_reason, 'Not in this account', what);
    assert.deepEqual(out.previews, [], what);
    // One identity read; the metadata and the preview were never asked for.
    assert.deepEqual(reads, ['meta_ad_id_get'], what);
  }
  // A failure that says nothing about whose ad it is must not read as absence: the call fails with it.
  for (const error of [
    {code: 'RATE_LIMITED', message: 'Meta asked for a pause.'},
    {code: 'UPSTREAM_ERROR', message: 'Platform returned HTTP 500', details: {http_status: 500}},
    {code: 'CONNECTION_NEEDS_REAUTH', message: 'Reconnect the account.'},
  ]) {
    const {reads, run} = await read(error);
    await assert.rejects(run(), e => e.code === error.code, error.code);
    assert.deepEqual(reads, ['meta_ad_id_get'], error.code);
  }
});

test('F-L3-03: a caller cannot mark its own call as the previews tool’s', async t => {
  const f = fixture(t);
  for (const extra of [{nested: true}, {scopeContext: {nested: true}}, {readOnly: true, nested: true}]) {
    const out = await f.service.call('meta_native_action', {...probe('222'), ...extra}, f.limited);
    assertRefused(out, ['RESOURCE_SCOPE_REQUIRED', 'UNSUPPORTED_PARAMETER']);
    assert.equal(f.requests.length, 0, JSON.stringify(extra));
  }
});

test('F-L3-03: a direct read of an ad already shown to be the account’s works as a node read and learns nothing new', async t => {
  const f = fixture(t);
  await f.service.call('amcp_ad_previews', previews('111'), f.limited);
  const before = f.requests.length,
    connection = f.store.resolveConnection(f.limited, 'meta_native_action', '100', login),
    owned = await f.service.call('meta_native_action', probe('111'), f.limited);
  assert.equal(owned.success, true, JSON.stringify(owned.error));
  assert.equal(f.requests.length, before + 1);
  assert.equal(f.store.ownsResource(connection, '100', '111'), true);
  // Another ID is still refused before any request.
  assertRefused(await f.service.call('meta_native_action', probe('222'), f.limited), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(f.requests.length, before + 1);
});

test('F-L3-03: the identity authorizer admits only the exact two-field read, and only on the previews tool’s path', () => {
  const authorizer = providerHooks('meta_native_action').scope.authorizers.find(
      a => a.name === 'meta_ad_identity_read',
    ),
    plan = {
      gateway: 'meta_native_action',
      action: 'meta_ad_id_get',
      method: 'GET',
      path: '/v26.0/150',
      query: {fields: 'id,account_id'},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      accountId: '100',
      evidence: 'TEST',
      warnings: [],
    },
    ask = extra => authorizer.authorize({...plan, ...extra}, {}, '100', {});
  // Claimed by its shape, as every authorizer is; decided only for the nested call the service marks.
  assert.equal(authorizer.claims(plan), true);
  assert.equal(ask({}), false);
  assert.equal(ask({nested: false}), false);
  assert.equal(ask({nested: true}), true);
  for (const near of [
    {query: {fields: 'id,account_id,name'}},
    {query: {fields: 'id,account_id', limit: '1'}},
    {query: {fields: 'account_id,id'}},
    {path: '/v26.0/act_150'},
    {path: '/v26.0/150/previews'},
    {path: '/v26.0/0150'},
    {method: 'POST'},
    {readOnly: false},
    {body: {}},
    {specialTransport: 'multipart'},
    {origin: 'https://example.invalid'},
    {action: 'meta_ad_account_id_get'},
    {gateway: 'tiktok_native_action'},
  ])
    assert.equal(ask({nested: true, ...near}), false, JSON.stringify(near));
});
