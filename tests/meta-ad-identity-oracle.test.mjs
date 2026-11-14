// F-L3-03 (audit L3, L9 F-L9-03): the Meta ad identity probe is for amcp_ad_previews only, and it tells a reader nothing
// about an ad outside their access set. A reader limited to one client's account asks for an ad of another account of the
// same login, and for an ad that does not exist: both get the same answer. NF-2 (post-patch validation of the wave 5 Round 2
// fixes): and the activity history, which projects the audit rows of the probe, tells them apart by nothing either.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {AdPreviews} from '../dist/src/ad-previews.js';
import {MirrorError} from '../dist/src/errors.js';
import {nativeReadSteps} from '../dist/src/provider-workflows.js';
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
  // 111 is an ad of account 100, 222 an ad of account 200 (another client's, same login); 444 is refused by Meta as a request
  // (it says nothing about whose ad it is); every other ID does not exist.
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
      if (id === '444')
        return Response.json(
          {
            error: {
              message: 'Invalid parameter',
              type: 'OAuthException',
              code: 100,
              error_subcode: 1487,
              fbtrace_id: 'synthetic',
            },
          },
          {status: 400},
        );
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

/**
 * One previews call of `actor` for `id`, and the audit rows it left, oldest first: the probe's request_started and
 * request_failed, and the refusal of the nested call itself.
 */
async function audited(f, actor, id) {
  const newest = () => f.store.recentAudit(admin.tenantId, 1)[0]?.seq ?? 0,
    before = newest(),
    out = await f.service.call('amcp_ad_previews', previews(id), actor);
  return {
    out,
    rows: f.store
      .recentAudit(admin.tenantId, 100)
      .filter(r => r.seq > before)
      .reverse(),
  };
}
/** A value as text without what differs between two calls by construction: the ID asked for, request IDs and latency. */
const withoutIdentity = (value, id) =>
  JSON.stringify(value, (key, v) =>
    ['requestId', 'request_id', 'latencyMs'].includes(key) ? undefined : v,
  ).replaceAll(id, '<id>');
const trailWithoutIdentity = (rows, id) => rows.map(row => withoutIdentity(JSON.parse(row.event), id));
/** The activity history as `actor` reads it, filtered to the probe's rows: what a reader of the audit is shown. */
async function shown(f, actor) {
  const page = await f.service.call('amcp_workspace', {action: 'history', search: 'meta_ad_id_get', limit: 100}, actor);
  assert.equal(page.success, true, JSON.stringify(page.error));
  return page.data;
}
const forHistory = (event, id) =>
  JSON.stringify({...event, id: undefined, at: undefined, request_id: undefined}).replaceAll(id, '<id>');

for (const [who, caller] of [
  ['a reader limited to one client', f => f.limited],
  ['the workspace admin, who has full access', () => admin],
])
  test(`NF-2: ${who} leaves the same audit trail and history for a foreign ad as for an absent one`, async t => {
    const f = fixture(t),
      actor = caller(f),
      foreign = await audited(f, actor, '222'),
      absent = await audited(f, actor, '333');
    // Both answers were already one (F-L3-03), the whole envelope, not only its data; the rows behind them are now one too.
    for (const out of [foreign.out, absent.out]) assert.deepEqual(out.data.previews, []);
    assert.equal(withoutIdentity(absent.out, '333'), withoutIdentity(foreign.out, '222'));
    assert.equal(foreign.rows.length, 3, 'request started, request failed, the nested call refused');
    assert.equal(absent.rows.length, 3);
    assert.deepEqual(trailWithoutIdentity(absent.rows, '333'), trailWithoutIdentity(foreign.rows, '222'));
    const failed = JSON.parse(foreign.rows[1].event);
    assert.equal(failed.event, 'request_failed');
    assert.equal(failed.error.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal(failed.error.message, 'Not in this account');
    // What the history shows of them (the website's activity page projects the same rows).
    const page = await shown(f, actor),
      events = page.events.filter(e => e.event === 'request_failed');
    assert.equal(events.length, 2, 'the history shows both failures');
    assert.equal(forHistory(events[0], '333'), forHistory(events[1], '222'));
    assert.doesNotMatch(
      JSON.stringify(page),
      /UPSTREAM_ERROR|Unsupported get request|fbtrace|synthetic|FOREIGN CLIENT AD|HTTP 400/,
    );
    assert.deepEqual(
      events.map(e => e.diagnostics.map(d => d.code)),
      [['ACCOUNT_SCOPE_MISMATCH'], ['ACCOUNT_SCOPE_MISMATCH']],
    );
  });

test('NF-2: a failure that says nothing about whose ad it is is still recorded as what it was, so the comparison above can find a difference', async t => {
  const f = fixture(t),
    refused = await audited(f, f.limited, '444'),
    absent = await audited(f, f.limited, '333');
  assert.equal(refused.out.success, false, 'Meta refusing the request fails the call');
  const failed = JSON.parse(refused.rows[1].event);
  assert.equal(failed.event, 'request_failed');
  assert.equal(failed.error.code, 'UPSTREAM_ERROR');
  assert.notDeepEqual(trailWithoutIdentity(refused.rows, '444'), trailWithoutIdentity(absent.rows, '333'));
  const page = await shown(f, f.limited),
    codes = page.events.filter(e => e.event === 'request_failed').map(e => e.error.code);
  assert.deepEqual(codes, ['ACCOUNT_SCOPE_MISMATCH', 'UPSTREAM_ERROR']);
});

test('NF-2: only the previews tool’s own identity probe has its refusals made one; every other failure and every other read keeps its error', () => {
  const plan = {
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
      nested: true,
    },
    upstream = (status, error) =>
      new MirrorError(
        'UPSTREAM_ERROR',
        'Platform returned HTTP ' + status,
        {http_status: status, upstream: {error}},
        status,
      ),
    gone = upstream(400, {
      code: 100,
      error_subcode: 33,
      message: "Unsupported get request. Object with ID '150' does not exist, cannot be loaded.",
      fbtrace_id: 'synthetic',
    });
  // Whatever way the probe finds that an ad is not the account’s, the refusal is one.
  for (const error of [
    new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Not in this account', {}, 403),
    gone,
    upstream(404, {message: 'Not found'}),
    new MirrorError('NOT_FOUND', 'No such object.', {}, 404),
  ]) {
    const out = nativeReadSteps.safeError(plan, error);
    assert.ok(out instanceof MirrorError, error.code);
    assert.deepEqual(
      [out.code, out.message, out.details, out.status],
      ['ACCOUNT_SCOPE_MISMATCH', 'Not in this account', {}, 403],
    );
  }
  // A failure that says nothing about whose ad it is stays itself.
  for (const error of [
    upstream(400, {code: 100, error_subcode: 1487, message: 'Invalid parameter'}),
    upstream(500, {message: 'Service unavailable'}),
    new MirrorError('PLATFORM_RATE_LIMIT', 'Meta asked for a pause.', {}, 429, true),
    new MirrorError('AUTH_EXPIRED', 'Reconnect the account.', {}, 401),
    new Error('socket closed'),
  ])
    assert.equal(nativeReadSteps.safeError(plan, error), error, error.code ?? error.message);
  // Another caller, another read, another provider: the same absence stays what it was.
  for (const near of [
    {nested: false},
    {nested: undefined},
    {query: {fields: 'id,account_id,name'}},
    {query: {fields: 'id,account_id', limit: '1'}},
    {path: '/v26.0/act_150'},
    {action: 'meta_ad_list'},
    {method: 'POST'},
    {gateway: 'tiktok_native_action'},
  ])
    assert.equal(nativeReadSteps.safeError({...plan, ...near}, gone), gone, JSON.stringify(near));
});

test('NF-2: a direct identity probe is refused before any request, so it leaves no request row in the history to tell a foreign ad from an absent one', async t => {
  const f = fixture(t),
    readers = [
      ['a reader limited to one client', f.limited],
      ['the workspace admin', admin],
    ];
  for (const [who, actor] of readers)
    for (const id of ['111', '222', '333'])
      assertRefused(await f.service.call('meta_native_action', probe(id), actor), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(f.requests.length, 0, 'nothing was sent');
  for (const [who, actor] of readers) {
    const page = await shown(f, actor);
    // The refusal came before request_started: no request event and no error code for any ID, whoever reads.
    assert.deepEqual(
      page.events.filter(e => e.error !== undefined || /^request_/.test(e.event)),
      [],
      who,
    );
  }
});
