import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-field2-access, B3 (the owner's field report of 2026-11-21, issues 3 and 4): gtm_ops LIST_ACCOUNTS without an account_id was refused
// ACCOUNT_REQUIRED (and with one, RESOURCE_SCOPE_REQUIRED, with a next_action that named a call that does not exist), and
// LOOKUP_CONTAINER was refused as the account "containers". Both name no account, so they are the Tag Manager workflow's
// (src/gtm-account-reads.ts), which projects the answer by what the login binds before anything is returned. These tests run it
// through the real service, guard and credentials, with a synthetic Tag Manager API. The captured schema of gtm_ops takes the
// route's own parameters (pageToken, includeGoogleTags, fields, tagId, destinationId) in `params`. Synthetic IDs: accounts 111 and
// 222 (bound), 333 (listed by Tag Manager, not bound), 999 (nowhere).

const registry = new Registry(),
  gateway = 'gtm_native_action',
  tenant = 'gtm-account-reads',
  admin = {tenantId: tenant, userId: 'admin', role: 'admin'},
  operator = {tenantId: tenant, userId: 'operator', role: 'operator'},
  reader = {tenantId: tenant, userId: 'reader', role: 'reader'},
  login = 'cccccccc-8888-4888-8888-000000000001',
  second = 'cccccccc-8888-4888-8888-000000000002',
  readonly = 'https://www.googleapis.com/auth/tagmanager.readonly';
const account = (id, name) => ({
  accountId: id,
  name,
  path: 'accounts/' + id,
  fingerprint: 'fingerprint-' + id,
  tagManagerUrl: 'https://tagmanager.google.com/#/admin/accounts?accountId=' + id,
});
const container = (accountId, containerId, publicId, name) => ({
  accountId,
  containerId,
  name,
  path: 'accounts/' + accountId + '/containers/' + containerId,
  publicId,
  tagIds: [publicId],
  fingerprint: 'fingerprint-' + containerId,
});
const lookups = {
  'GTM-BOUND11': container('111', '1000', 'GTM-BOUND11', 'Bound container'),
  'GTM-OTHER22': container('222', '2000', 'GTM-OTHER22', 'Other bound container'),
  'GTM-UNBOUND3': container('333', '3000', 'GTM-UNBOUND3', 'Secret container of an unbound account'),
  'AW-123456789': container('111', '1000', 'GTM-BOUND11', 'Bound container'),
};
const listed = [account('111', 'Bound one'), account('222', 'Bound two'), account('333', 'Unbound three')];
// The arguments the captured schema takes at the top level; every other name a test gives is a parameter of the route, so it goes in params.
const topLevel = new Set(['account_id', 'connection_id', 'parent', 'path']);
const shaped = (action, given) => {
  const top = {action},
    params = {...(given.params ?? {})};
  for (const [key, value] of Object.entries(given))
    if (key !== 'params') (topLevel.has(key) ? top : params)[key] = value;
  return Object.keys(params).length ? {...top, params} : top;
};

/**
 * A workspace with a Tag Manager login bound to accounts 111 and 222 (and a second login when asked), a synthetic Tag Manager API
 * and the real service. `pageSize` pages the listing; `deny` answers every read with the given HTTP status and body.
 */
function fixture(t, {pageSize = 10, rows = listed, twoLogins = false, deny, allowWrites = true, beforeAnswer} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 66).toString('base64')),
    requests = [];
  t.after(() => store.close());
  const connection = (id, accounts = ['111', '222']) => ({
    id,
    tenantId: tenant,
    gateway,
    accounts,
    writeAccounts: [],
    enabled: true,
    label: 'Synthetic Tag Manager ' + id.slice(-1),
    scopes: [readonly],
  });
  store.putConnection(admin, connection(login), {accessToken: 'synthetic'});
  if (twoLogins) store.putConnection(admin, connection(second), {accessToken: 'synthetic'});
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async (input, init) => {
        const url = new URL(String(input)),
          query = Object.fromEntries(url.searchParams);
        requests.push({
          method: init?.method ?? 'GET',
          path: url.pathname,
          query,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        beforeAnswer?.(requests.length, {store, connection: connection(login)});
        if (deny) return Response.json(deny.body, {status: deny.status});
        if (url.pathname === '/tagmanager/v2/accounts') {
          const start = query.pageToken ? Number(query.pageToken.replace('page-', '')) : 0,
            page = rows.slice(start, start + pageSize),
            masked = query.fields?.startsWith('account(name)') ? page.map(row => ({name: row.name})) : page,
            // A field mask that does not select nextPageToken drops it, as Tag Manager's partial responses do.
            hasToken =
              query.fields === undefined || query.fields === '*' || /(^|,)nextPageToken(,|$)/.test(query.fields);
          return Response.json({
            ...(masked.length ? {account: masked} : {}),
            ...(hasToken && start + pageSize < rows.length ? {nextPageToken: 'page-' + (start + pageSize)} : {}),
          });
        }
        if (/^\/tagmanager\/v2\/accounts\/\d+\/containers$/.test(url.pathname)) return Response.json({});
        if (url.pathname === '/tagmanager/v2/accounts/containers:lookup') {
          const tag = query.tagId ?? query.destinationId;
          if (tag === 'GTM-MISSING1') return Response.json({error: {code: 404, status: 'NOT_FOUND'}}, {status: 404});
          if (tag === 'GTM-DENIED11')
            return Response.json({error: {code: 403, status: 'PERMISSION_DENIED', message: 'denied'}}, {status: 403});
          if (tag === 'GTM-SCOPE111')
            return Response.json(
              {error: {code: 403, status: 'PERMISSION_DENIED', details: [{reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}]}},
              {status: 403},
            );
          if (tag === 'GTM-EXPIRED1') return Response.json({error: {code: 401}}, {status: 401});
          return lookups[tag] ? Response.json(lookups[tag]) : Response.json({error: {code: 404}}, {status: 404});
        }
        throw Error('Unexpected synthetic Tag Manager route ' + url.pathname);
      },
      async () => {},
    ),
    undefined,
    {allowWrites},
  );
  const call = (arguments_, as = admin) => service.call(gateway, {operation: 'gtm_ops', arguments: arguments_}, as),
    list = (given = {}, as = admin) => call(shaped('LIST_ACCOUNTS', given), as),
    lookup = (given, as = admin) => call(shaped('LOOKUP_CONTAINER', given), as),
    owned = () => store.db.prepare('SELECT COUNT(*) AS n FROM resource_ownership').get().n;
  return {store, service, requests, call, list, lookup, owned, connection};
}
const accountsOf = out => out.data.data.account;

test('LIST_ACCOUNTS without an account_id works for a login of two accounts: one read, both accounts whole and connected', async t => {
  const f = fixture(t, {rows: listed.slice(0, 2)}),
    out = await f.list();
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(accountsOf(out), [
    {...listed[0], connected: true},
    {...listed[1], connected: true},
  ]);
  assert.equal(out.data.data.not_connected, 0);
  assert.equal(out.data.connection_id, login);
  assert.equal(out.data.pages, 1);
  assert.equal(out.data.complete, true);
  assert.equal(out.data.next_step.website_path, '/connections');
  assert.deepEqual(
    f.requests.map(r => [r.method, r.path, r.query, r.authorization]),
    [['GET', '/tagmanager/v2/accounts', {}, 'Bearer synthetic']],
  );
  // An account_id only chooses the login; the listing is the login's.
  const chosen = await f.list({account_id: '111'});
  assert.equal(chosen.success, true, JSON.stringify(chosen.error));
  assert.equal(accountsOf(chosen).length, 2);
});

test('the listing pages by its token, passes includeGoogleTags on every page, and says when it stopped before the end', async t => {
  const f = fixture(t, {pageSize: 2}),
    out = await f.list({includeGoogleTags: true});
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(out.data.pages, 2);
  assert.deepEqual(
    f.requests.map(r => r.query),
    [{includeGoogleTags: 'true'}, {includeGoogleTags: 'true', pageToken: 'page-2'}],
  );
  assert.equal(accountsOf(out).length, 3, 'all three listed rows, the unbound one for an administrator');
  // A caller may continue from a token itself.
  const from = await f.list({pageToken: 'page-2'});
  assert.equal(from.success, true);
  assert.deepEqual(
    accountsOf(from).map(row => row.accountId),
    ['333'],
  );
  // A listing of more pages than the bound says so and gives the token to continue with.
  const long = fixture(t, {
      pageSize: 1,
      rows: Array.from({length: 14}, (_, i) => account(String(500 + i), 'Account ' + i)),
    }),
    cut = await long.list();
  assert.equal(cut.success, true, JSON.stringify(cut.error));
  assert.equal(cut.data.pages, 10);
  assert.equal(cut.data.truncated, true);
  assert.equal(cut.data.complete, false);
  assert.equal(cut.data.data.nextPageToken, 'page-10');
  assert.equal(long.requests.length, 10);
  // A listing stops after the page that brings it to a thousand accounts, though fewer pages were read.
  const wide = fixture(t, {
      pageSize: 600,
      rows: Array.from({length: 1500}, (_, i) => account(String(10000 + i), 'Account ' + i)),
    }),
    stopped = await wide.list();
  assert.equal(stopped.success, true, JSON.stringify(stopped.error));
  assert.equal(stopped.data.pages, 2);
  assert.equal(stopped.data.truncated, true);
  assert.equal(stopped.data.data.nextPageToken, 'page-1200');
  assert.equal(stopped.data.data.account.length, 1200, 'the whole second page, none of the third');
  assert.equal(stopped.data.data.not_connected, 1200);
});

test('an unbound account is an ID and a name for an administrator, and a count for an operator, a reader and an access-set actor', async t => {
  const f = fixture(t),
    set = saveAccessSet(f.store, admin, {
      name: 'Client one',
      bindings: [{gateway, connection_id: login, account_id: '111'}],
    }),
    client = {tenantId: tenant, userId: 'client-one', role: 'operator', accessSetId: String(set.id)};
  const asAdmin = await f.list();
  assert.deepEqual(accountsOf(asAdmin), [
    {...listed[0], connected: true},
    {...listed[1], connected: true},
    {accountId: '333', name: 'Unbound three', connected: false},
  ]);
  assert.equal(asAdmin.data.data.not_connected, 1);
  for (const who of [operator, reader]) {
    const out = await f.list({}, who);
    assert.equal(out.success, true, who.role + ': ' + JSON.stringify(out.error));
    assert.deepEqual(accountsOf(out), [
      {...listed[0], connected: true},
      {...listed[1], connected: true},
    ]);
    assert.equal(out.data.data.not_connected, 1);
    assert.doesNotMatch(JSON.stringify(out.data), /333|Unbound three/, who.role);
    assert.equal(out.data.next_step.website_path, '/connections');
  }
  // A client access set reaches account 111 only: account 222 is bound but outside it, so it is neither shown nor counted.
  const scoped = await f.list({}, client);
  assert.equal(scoped.success, true, JSON.stringify(scoped.error));
  assert.deepEqual(accountsOf(scoped), [{...listed[0], connected: true}]);
  assert.equal(scoped.data.data.not_connected, 1);
  assert.doesNotMatch(JSON.stringify(scoped.data), /222|333|Bound two|Unbound three/);
});

test('a listing remembers nothing as ownership and opens no read of an account the login does not bind', async t => {
  const f = fixture(t);
  assert.equal((await f.list()).success, true);
  assert.equal(f.owned(), 0);
  const before = f.requests.length;
  // The listing named account 333, and every other Tag Manager action keeps its account checks.
  assertRefused(
    await f.call({action: 'LIST_CONTAINERS', parent: 'accounts/333', account_id: '111'}),
    'ACCOUNT_SCOPE_MISMATCH',
  );
  assertRefused(await f.call({action: 'LIST_CONTAINERS', parent: 'accounts/333'}), 'CONNECTION_REQUIRED');
  assertRefused(
    await f.call({action: 'LIST_CONTAINERS', account_id: '333', parent: 'accounts/333'}),
    'CONNECTION_REQUIRED',
  );
  assertRefused(
    await f.call({action: 'GET_ACCOUNT', path: 'accounts/999', account_id: '111'}),
    'ACCOUNT_SCOPE_MISMATCH',
  );
  assert.equal(f.requests.length, before, 'none of them was sent');
  // The bound accounts' containers are still listed as before.
  assert.equal((await f.call({action: 'LIST_CONTAINERS', account_id: '111'})).success, true);
});

test('the listing takes only pageToken, includeGoogleTags and fields, and nothing else reaches Tag Manager', async t => {
  const f = fixture(t);
  for (const [given, code] of [
    [{bogus: '1'}, 'UNKNOWN_VENDOR_PARAMETER'],
    [{prettyPrint: true}, 'INVALID_ARGUMENT'],
    [{alt: 'json'}, 'INVALID_ARGUMENT'],
    [{quotaUser: 'someone'}, 'INVALID_ARGUMENT'],
    [{callback: 'x'}, 'INVALID_ARGUMENT'],
    [{access_token: 'stolen'}, 'CREDENTIAL_PARAMETER_FORBIDDEN'],
    [{includeGoogleTags: 'yes'}, 'INVALID_PARAMETER'],
  ]) {
    const out = await f.list(given);
    assertRefused(out, code);
    if (code === 'INVALID_ARGUMENT')
      assert.deepEqual(out.error.details.allowed_query, ['pageToken', 'includeGoogleTags', 'fields'], code);
  }
  assert.equal(f.requests.length, 0, 'none of them was sent');
});

test('a field mask keeps nextPageToken, and an answer that cannot be checked against the login is refused, not shown', async t => {
  const f = fixture(t, {pageSize: 2}),
    masked = await f.list({fields: 'account(accountId,name)'});
  assert.equal(masked.success, true, JSON.stringify(masked.error));
  assert.equal(f.requests[0].query.fields, 'account(accountId,name),nextPageToken');
  assert.equal(accountsOf(masked).length, 3, 'the second page was read');
  // A mask that already names the token, or selects everything, is sent as it is.
  const kept = fixture(t);
  await kept.list({fields: 'nextPageToken,account(accountId)'});
  await kept.list({fields: '*'});
  assert.deepEqual(
    kept.requests.map(r => r.query.fields),
    ['nextPageToken,account(accountId)', '*'],
  );
  // A mask without accountId and the path leaves rows that name no account: nothing is returned.
  const unusable = fixture(t),
    refused = await unusable.list({fields: 'account(name)'});
  assertRefused(refused, 'UPSTREAM_RESPONSE_INVALID');
  assert.doesNotMatch(JSON.stringify(refused.error), /Bound one|Unbound three/);
});

test('two logins without a connection_id are ambiguous, a chosen login lists, and a disabled one is refused', async t => {
  const f = fixture(t, {twoLogins: true});
  const ambiguous = await f.list();
  assertRefused(ambiguous, 'AMBIGUOUS_CONNECTION');
  assert.deepEqual(ambiguous.error.details.next_call.arguments.arguments, {platform: 'gtm'});
  assert.equal(f.requests.length, 0);
  const chosen = await f.list({connection_id: second});
  assert.equal(chosen.success, true, JSON.stringify(chosen.error));
  assert.equal(chosen.data.connection_id, second);
  f.store.putConnection(admin, {...f.connection(second), enabled: false}, {accessToken: 'synthetic'});
  f.store.putConnection(admin, {...f.connection(login), enabled: false}, {accessToken: 'synthetic'});
  assertRefused(await f.list(), 'CONNECTION_REQUIRED');
  assertRefused(await f.list({connection_id: second}), 'CONNECTION_REQUIRED');
});

test('a read-only deployment lists for a reader, since it is a read, and Google’s refusals are relayed with nothing kept', async t => {
  const f = fixture(t, {allowWrites: false}),
    out = await f.list({}, reader);
  assert.equal(out.success, true, JSON.stringify(out.error));
  for (const [status, body, code] of [
    [403, {error: {code: 403, status: 'PERMISSION_DENIED'}}, 'PROVIDER_ACCESS_DENIED'],
    [401, {error: {code: 401}}, 'AUTH_EXPIRED'],
  ]) {
    const denied = fixture(t, {deny: {status, body}});
    assertRefused(await denied.list(), code);
    assert.equal(denied.owned(), 0, 'nothing is cached');
  }
});

test('the login is checked again before each attempt: a login disabled during the first page stops the listing', async t => {
  const f = fixture(t, {
    pageSize: 2,
    beforeAnswer: (count, {store, connection}) => {
      if (count === 1) store.putConnection(admin, {...connection, enabled: false}, {accessToken: 'synthetic'});
    },
  });
  assertRefused(await f.list(), 'CONNECTION_REQUIRED');
  assert.equal(f.requests.length, 1, 'the second page was never requested');
});

// Lead review S3-2: the binding the answer is projected by is the login's after the last read, as the native path authorizes a page
// against the login resolved after it. An administrator's change of the selection keeps the login and its credentials (a metadata
// change, so no CONNECTION_AUTHORITY_CHANGED), and a client access set's change is applied at the next resolution: in both cases only
// the binding taken after the read can keep an account that was withdrawn during it from being returned.
const bothAccounts = ['111', '222'].map(account_id => ({gateway, connection_id: login, account_id}));

test('a lookup is judged by the accounts the login binds after the read: an account unbound during it withholds its container', async t => {
  const f = fixture(t, {
    beforeAnswer: (count, {store, connection}) => {
      if (count === 1) store.updateConnection(admin, {...connection, accounts: ['111']});
    },
  });
  const out = await f.lookup({tagId: 'GTM-OTHER22'});
  assertRefused(out, 'GTM_ACCOUNT_NOT_CONNECTED');
  assert.equal(out.error.details.account_id, '222', 'an administrator without a set is told which account it is');
  assert.doesNotMatch(JSON.stringify(out.error), /Other bound container|2000|fingerprint/, 'the body is withheld');
  assert.equal(f.requests.length, 1);
  // The account the login still binds is unaffected.
  assert.equal((await f.lookup({tagId: 'GTM-BOUND11'})).success, true);
});

test('an access set narrowed during a lookup applies to what it returns: the account it no longer reaches is withheld and not named', async t => {
  let narrow;
  const f = fixture(t, {beforeAnswer: (count, context) => narrow?.(count, context)}),
    set = saveAccessSet(f.store, admin, {name: 'Client one', bindings: bothAccounts}),
    client = {tenantId: tenant, userId: 'client-one', role: 'operator', accessSetId: String(set.id)};
  narrow = (count, {store}) => {
    if (count === 1)
      saveAccessSet(store, admin, {
        id: set.id,
        revision: set.revision,
        name: 'Client one',
        bindings: [bothAccounts[0]],
      });
  };
  const out = await f.lookup({tagId: 'GTM-OTHER22'}, client);
  assertRefused(out, 'GTM_ACCOUNT_NOT_CONNECTED');
  assert.equal(out.error.details.account_id, undefined);
  assert.doesNotMatch(JSON.stringify(out.error), /222|Other bound container|2000|fingerprint/);
});

test('a listing is projected by the accounts the login binds after its last page: one unbound during it is not connected, one an access set dropped is silent', async t => {
  const unbound = fixture(t, {
      pageSize: 2,
      beforeAnswer: (count, {store, connection}) => {
        if (count === 1) store.updateConnection(admin, {...connection, accounts: ['111']});
      },
    }),
    out = await unbound.list();
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(accountsOf(out), [
    {...listed[0], connected: true},
    {accountId: '222', name: 'Bound two', connected: false},
    {accountId: '333', name: 'Unbound three', connected: false},
  ]);
  assert.equal(out.data.data.not_connected, 2);
  let narrow;
  const f = fixture(t, {pageSize: 2, beforeAnswer: (count, context) => narrow?.(count, context)}),
    set = saveAccessSet(f.store, admin, {name: 'Client one', bindings: bothAccounts}),
    client = {tenantId: tenant, userId: 'client-one', role: 'operator', accessSetId: String(set.id)};
  narrow = (count, {store}) => {
    if (count === 1)
      saveAccessSet(store, admin, {
        id: set.id,
        revision: set.revision,
        name: 'Client one',
        bindings: [bothAccounts[0]],
      });
  };
  const scoped = await f.list({}, client);
  assert.equal(scoped.success, true, JSON.stringify(scoped.error));
  assert.deepEqual(accountsOf(scoped), [{...listed[0], connected: true}]);
  assert.equal(scoped.data.data.not_connected, 1, 'the unbound account is counted, the one the set dropped is not');
  assert.doesNotMatch(JSON.stringify(scoped.data), /222|333|Bound two|Unbound three/);
});

test('LOOKUP_CONTAINER returns a container of a bound account after one read, by tag ID or by destination ID', async t => {
  const f = fixture(t),
    out = await f.lookup({tagId: 'GTM-BOUND11'});
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(out.data.data, lookups['GTM-BOUND11']);
  assert.deepEqual(
    f.requests.map(r => [r.method, r.path, r.query, r.authorization]),
    [['GET', '/tagmanager/v2/accounts/containers:lookup', {tagId: 'GTM-BOUND11'}, 'Bearer synthetic']],
  );
  const byDestination = await f.lookup({destinationId: 'AW-123456789', account_id: '111'});
  assert.equal(byDestination.success, true, JSON.stringify(byDestination.error));
  assert.equal(byDestination.data.data.accountId, '111');
  for (const who of [operator, reader]) assert.equal((await f.lookup({tagId: 'GTM-OTHER22'}, who)).success, true);
  assert.equal(f.owned(), 0, 'nothing is remembered as ownership');
});

test('a container of an account the login does not bind is GTM_ACCOUNT_NOT_CONNECTED, withheld whole, and its account is named to an administrator only', async t => {
  const f = fixture(t),
    sentence =
      'Container {tag} belongs to a Tag Manager account this login does not bind. An administrator connects it in Connections, then look it up again.';
  for (const [who, named] of [
    [admin, true],
    [operator, false],
    [reader, false],
  ]) {
    const out = await f.lookup({tagId: 'GTM-UNBOUND3'}, who);
    assertRefused(out, 'GTM_ACCOUNT_NOT_CONNECTED');
    assert.equal(out.error.message, sentence.replace('{tag}', 'GTM-UNBOUND3'));
    assert.deepEqual(out.error.message_localization, {key: sentence, values: {tag: 'GTM-UNBOUND3'}});
    assert.equal(out.error.category, 'grant');
    assert.match(out.error.next_action, /Connections/);
    assert.equal(out.error.details.account_id, named ? '333' : undefined, who.role);
    assert.doesNotMatch(
      JSON.stringify(out.error),
      /Secret container|3000|fingerprint/,
      who.role + ': the body is withheld',
    );
    if (!named) assert.doesNotMatch(JSON.stringify(out.error), /333/, who.role);
  }
  assert.equal(f.owned(), 0);
  // An access-set actor is told nothing more, for an unbound account and for a bound one outside its set.
  const set = saveAccessSet(f.store, admin, {
      name: 'Client one',
      bindings: [{gateway, connection_id: login, account_id: '111'}],
    }),
    client = {tenantId: tenant, userId: 'client-one', role: 'operator', accessSetId: String(set.id)};
  for (const tag of ['GTM-UNBOUND3', 'GTM-OTHER22']) {
    const out = await f.lookup({tagId: tag}, client);
    assertRefused(out, 'GTM_ACCOUNT_NOT_CONNECTED');
    assert.equal(out.error.details.account_id, undefined, tag);
    assert.doesNotMatch(JSON.stringify(out.error), /222|333|Secret container|Other bound container/, tag);
  }
  assert.equal((await f.lookup({tagId: 'GTM-BOUND11'}, client)).success, true);
});

test('a container of another bound account than the selected one is ACCOUNT_SCOPE_MISMATCH naming it', async t => {
  const f = fixture(t),
    out = await f.lookup({tagId: 'GTM-OTHER22', account_id: '111'});
  assertRefused(out, 'ACCOUNT_SCOPE_MISMATCH');
  assert.equal(
    out.error.message,
    'Container GTM-OTHER22 is in Tag Manager account 222 of this login, not the selected one.',
  );
  assert.equal(out.error.details.account_id, '222');
  assert.equal(out.error.details.selected_account_id, '111');
  assert.equal(out.error.category, 'grant');
  assert.doesNotMatch(JSON.stringify(out.error), /Other bound container|2000/);
  assert.equal((await f.lookup({tagId: 'GTM-OTHER22', account_id: '222'})).success, true);
  // An account the login does not bind is no selection at all.
  assertRefused(await f.lookup({tagId: 'GTM-OTHER22', account_id: '999'}), 'CONNECTION_REQUIRED');
});

test('Google’s 404 and a plain denial are one precise refusal; a missing permission and an expired login keep their own', async t => {
  const f = fixture(t);
  for (const [tag, status] of [
    ['GTM-MISSING1', 404],
    ['GTM-DENIED11', 403],
    ['GTM-ABSENT99', 404],
  ]) {
    const out = await f.lookup({tagId: tag});
    assertRefused(out, 'NOT_FOUND');
    assert.equal(out.error.message, 'No container with this tag ID is visible to this Tag Manager login.', tag);
    assert.equal(out.error.details.http_status, status, 'the two answers stay apart for whoever reports it: ' + tag);
  }
  assertRefused(await f.lookup({tagId: 'GTM-SCOPE111'}), 'INSUFFICIENT_SCOPE');
  assertRefused(await f.lookup({tagId: 'GTM-EXPIRED1'}), 'AUTH_EXPIRED');
  assert.equal(f.owned(), 0);
});

test('a lookup that does not name exactly one well-formed tag, or carries anything else, is refused before any request', async t => {
  const f = fixture(t);
  for (const given of [
    {},
    {tagId: 'GTM-BOUND11', destinationId: 'AW-123456789'},
    {tagId: 'gtm-bound11'},
    {tagId: 'GTM-'},
    {tagId: 'GTM-AB'},
    {tagId: 'GTM-BOUND 11'},
    {tagId: 'GTM-BOUND11/../x'},
    {tagId: 'TOOLONGPREFIX-ABCDEF'},
    {destinationId: 'aw-123456789'},
    {tagId: 'GTM-BOUND11', fields: 'accountId'},
    {tagId: 'GTM-BOUND11', prettyPrint: true},
    {tagId: 'GTM-BOUND11', alt: 'json'},
  ]) {
    const out = await f.lookup(given);
    assertRefused(out, 'INVALID_ARGUMENT');
    assert.deepEqual(out.error.details.allowed_query, ['tagId', 'destinationId'], JSON.stringify(given));
  }
  assertRefused(await f.lookup({tagId: 'GTM-BOUND11', bogus: '1'}), 'UNKNOWN_VENDOR_PARAMETER');
  assertRefused(
    await f.call({action: 'LOOKUP_CONTAINER', params: {tagId: 'GTM-BOUND11'}, tag_id: 'GTM-OTHER22'}),
    'CONFLICTING_PARAMETER',
  );
  assert.equal(f.requests.length, 0, 'none of them was sent');
});

// Lead review S3-1: the path these two actions replace (MirrorService.runPlan) records request_started, request_completed and
// request_failed, and the workflows of other providers record a completion event. A refusal is audited at tool level; a successful
// read, which may show an administrator the names of accounts the workspace does not bind, left no trace.
const events = (f, requestId) =>
  f.store
    .audit(tenant)
    .filter(row => row.request_id === requestId)
    .map(row => JSON.parse(row.event));

test('a successful read is audited under its request: who, which login, and the counts, with no account name or ID', async t => {
  const f = fixture(t),
    out = await f.list();
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(typeof out.meta.requestId, 'string');
  assert.deepEqual(events(f, out.meta.requestId), [
    {
      event: 'gtm_account_read_completed',
      actor: 'admin',
      connection_id: login,
      action: 'gtm_ops/LIST_ACCOUNTS',
      pages: 1,
      returned: 3,
      not_connected: 1,
      truncated: false,
    },
  ]);
  const found = await f.lookup({tagId: 'GTM-BOUND11'});
  assert.deepEqual(events(f, found.meta.requestId), [
    {
      event: 'gtm_account_read_completed',
      actor: 'admin',
      connection_id: login,
      action: 'gtm_ops/LOOKUP_CONTAINER',
      pages: 1,
      returned: 1,
      account_id: '111',
      tag: 'GTM-BOUND11',
    },
  ]);
  // What the actor does not see is not in the record either: an operator's listing counts the unbound account and names nothing.
  const asOperator = await f.list({}, operator);
  const [record] = events(f, asOperator.meta.requestId);
  assert.equal(record.actor, 'operator');
  assert.equal(record.returned, 2);
  assert.equal(record.not_connected, 1);
  assert.doesNotMatch(
    JSON.stringify(events(f, out.meta.requestId)),
    /Bound one|Bound two|Unbound three|333|fingerprint/,
  );
});

test('an access-set actor’s read is audited with its set, and a refused lookup is audited by the tool, not as a completed read', async t => {
  const f = fixture(t),
    set = saveAccessSet(f.store, admin, {name: 'Client one', bindings: [bothAccounts[0]]}),
    client = {tenantId: tenant, userId: 'client-one', role: 'operator', accessSetId: String(set.id)};
  const out = await f.list({}, client);
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(events(f, out.meta.requestId), [
    {
      event: 'gtm_account_read_completed',
      actor: 'client-one',
      access_set_id: String(set.id),
      connection_id: login,
      action: 'gtm_ops/LIST_ACCOUNTS',
      pages: 1,
      returned: 1,
      not_connected: 1,
      truncated: false,
    },
  ]);
  const refused = await f.lookup({tagId: 'GTM-UNBOUND3'}, client);
  assertRefused(refused, 'GTM_ACCOUNT_NOT_CONNECTED');
  const rows = events(f, refused.meta.requestId);
  assert.equal(
    rows.some(row => row.event === 'gtm_account_read_completed'),
    false,
    'nothing was returned, so no read completed for the actor',
  );
  assert.equal(rows.length, 1, 'the refusal is audited once, by the tool');
  assert.doesNotMatch(JSON.stringify(rows), /Secret container|3000|fingerprint/);
});

test('the action contract ledger lists the two reads as this workflow’s, and every other Tag Manager row as it was', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.operation === 'gtm_ops'),
    row = action => rows.find(r => r.action === action);
  for (const action of ['LIST_ACCOUNTS', 'LOOKUP_CONTAINER']) {
    assert.equal(row(action).status, 'local_workflow', action);
    assert.equal(row(action).implementation, 'src/gtm-account-reads.ts', action);
    assert.deepEqual(row(action).tests, ['tests/gtm-account-reads.test.mjs'], action);
  }
  assert.equal(row('LIST_CONTAINERS').status, 'native_read');
  assert.equal(row('GET_ACCOUNT').status, 'native_read');
});

test('every refusal of a lookup names its own next step and carries no container', async t => {
  const f = fixture(t),
    refusals = [
      await f.lookup({tagId: 'GTM-UNBOUND3'}),
      await f.lookup({tagId: 'GTM-OTHER22', account_id: '111'}),
      await f.lookup({tagId: 'GTM-MISSING1'}),
      await f.lookup({}),
    ];
  for (const out of refusals) {
    assert.equal(out.success, false);
    assert.doesNotMatch(JSON.stringify(out), /Secret container|Other bound container|"containerId"/);
    assert.ok(out.error.next_action.length > 20, out.error.code + ': ' + out.error.next_action);
  }
});
