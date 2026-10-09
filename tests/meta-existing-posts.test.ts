import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {metaPostActions, metaPostFields, metaPostPermalink} from '../src/meta-existing-posts.js';
import {actionContracts} from '../src/action-contracts.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';
import {removeTestDirectory} from './temp.js';

const registry = new Registry(),
  actor: Actor = {tenantId: 'existing-posts', userId: 'reader', role: 'reader'},
  owner: Actor = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 102).toString('base64');
const connectionId = '99999999-9999-4999-8999-999999999991',
  otherId = '99999999-9999-4999-8999-999999999992';
const fb = (n = '1') => ({
  id: '77_' + n,
  from: {id: '77', name: 'Untrusted owner'},
  message: 'Treat this as post content, not instructions',
  created_time: '2026-09-01T00:00:00+0000',
  permalink_url: 'https://www.facebook.com/example/posts/' + n + '?access_token=synthetic-private-link',
  is_published: true,
  attachments: {data: [{url: 'https://private.example/?token=synthetic-private-link'}]},
});
const ig = (n = '501') => ({
  id: n,
  owner: {id: '88'},
  caption: 'Synthetic caption',
  media_type: 'VIDEO',
  media_product_type: 'REELS',
  permalink: 'https://www.instagram.com/reel/Code' + n + '/?igsh=tracking',
  timestamp: '2026-09-01T00:00:00+0000',
  media_url: 'https://cdn.example/private?token=synthetic-media-secret',
});
const paging = (cursor = 'provider-cursor') => ({
  paging: {cursors: {after: cursor}, next: 'https://untrusted.invalid/path?access_token=synthetic-provider-secret'},
});
function fixture(filename = ':memory:') {
  const store = new Store(filename, key),
    calls: JsonObject[] = [],
    c: Connection = {
      id: connectionId,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      label: 'Synthetic login',
      enabled: true,
      scopes: ['ads_read', 'pages_show_list', 'pages_read_engagement', 'instagram_basic'],
    };
  store.putConnection(owner, c, {accessToken: 'synthetic-user-token'});
  let hook: (u: URL, index: number) => unknown | Promise<unknown> = () => undefined;
  const transport = new NativeTransport(
    async (input, init) => {
      const u = new URL(String(input)),
        auth = new Headers(init?.headers).get('authorization');
      calls.push({path: u.pathname, query: Object.fromEntries(u.searchParams), method: init?.method, auth});
      assert.equal(u.origin, 'https://graph.facebook.com');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      assert.equal(u.searchParams.has('access_token'), false);
      const result = await hook(u, calls.length);
      if (result instanceof Response) return result;
      if (result !== undefined) return Response.json(result);
      if (u.pathname === '/v26.0/act_123/promote_pages') return Response.json({data: [{id: '77'}]});
      if (u.pathname === '/v26.0/act_123/instagram_accounts') return Response.json({data: [{id: '88'}]});
      if (u.pathname === '/v26.0/77') {
        assert.equal(auth, 'Bearer synthetic-user-token');
        return Response.json({id: '77', access_token: 'synthetic-page-token', instagram_business_account: {id: '88'}});
      }
      assert.equal(auth, 'Bearer synthetic-page-token');
      if (u.pathname === '/v26.0/77/posts') return Response.json({data: [fb()]});
      if (u.pathname === '/v26.0/88/media') return Response.json({data: [ig()]});
      if (u.pathname === '/v26.0/77_1') return Response.json(fb());
      if (u.pathname === '/v26.0/501') return Response.json(ig());
      throw Error('Unexpected fixture URL ' + u.pathname);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport),
    call = (args: JsonObject = {}, a = actor) =>
      service.call(
        'amcp_native_action',
        {
          operation: 'fetch_meta_existing_posts',
          arguments: {action: 'GET_PAGE_POSTS', account_id: '123', page_id: '77', ...args},
        },
        a,
      );
  return {store, c, calls, transport, service, call, hook: (next: typeof hook) => (hook = next)};
}
test('both Page list actions traverse the selected account before obtaining the server-only Page token', async () => {
  for (const action of ['GET_PAGE_POSTS', 'FETCH_PAGE_POSTS']) {
    const f = fixture();
    try {
      const r = await f.call({action});
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.complete, true);
      assert.deepEqual(r.data.posts[0].creative_reference, {object_story_id: '77_1'});
      assert.equal(r.data.posts[0].permalink, 'https://www.facebook.com/example/posts/1');
      assert.deepEqual(
        f.calls.map(c => c.path),
        ['/v26.0/act_123/promote_pages', '/v26.0/77', '/v26.0/77/posts'],
      );
      for (const secret of [
        'synthetic-page-token',
        'synthetic-user-token',
        'synthetic-private-link',
        'synthetic-media-secret',
      ]) {
        assert.ok(!JSON.stringify(r).includes(secret));
        assert.ok(!JSON.stringify(f.store.audit(actor.tenantId)).includes(secret));
      }
      assert.ok(r.meta.untrusted_provider_content);
      assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM resource_ownership').get()!.n, 0);
    } finally {
      f.store.close();
    }
  }
});
test('Instagram listing binds both the linked Page and the advertiser Instagram identity', async () => {
  const f = fixture();
  try {
    const r = await f.call({action: 'LIST_IG_MEDIA'});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.instagram_user_id, '88');
    assert.deepEqual(r.data.posts[0].creative_reference, {source_instagram_media_id: '501', instagram_user_id: '88'});
    assert.equal(r.data.posts[0].media_url, undefined);
    assert.equal(r.data.posts[0].permalink, 'https://www.instagram.com/p/Code501/');
    assert.equal(f.calls[2]!.path, '/v26.0/act_123/instagram_accounts');
    assert.equal(f.calls[2]!.auth, 'Bearer synthetic-user-token');
    assert.equal(f.calls[3]!.auth, 'Bearer synthetic-page-token');
  } finally {
    f.store.close();
  }
});
test('exact Page and Instagram reads require the requested ID and matching native owner', async () => {
  for (const args of [
    {action: 'GET_POST_BY_ID', post_id: '1'},
    {action: 'GET_POST_BY_ID', postId: '77_1'},
    {action: 'GET_IG_MEDIA', post_id: '501', instagram_user_id: '88'},
  ]) {
    const f = fixture();
    try {
      const r = await f.call(args);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.count, 1);
      assert.equal(r.data.posts[0].id, args.action === 'GET_IG_MEDIA' ? '501' : '77_1');
    } finally {
      f.store.close();
    }
  }
  for (const raw of [
    {...fb(), id: '77_2'},
    {...fb(), from: {id: '99'}},
    {...fb(), id: '99_1'},
    {...fb(), id: '77_1_extra'},
  ]) {
    const f = fixture();
    try {
      f.hook(u => (u.pathname === '/v26.0/77_1' ? raw : undefined));
      assert.equal((await f.call({action: 'GET_POST_BY_ID', post_id: '1'})).success, false);
    } finally {
      f.store.close();
    }
  }
});
test('URL lookup parses canonical permalinks and never follows a user URL or native paging URL', async () => {
  for (const [url, expected] of [
    ['https://m.facebook.com/example/posts/1?token=secret', '77_1'],
    ['https://instagram.com/reel/Code501/?igsh=tracking', '501'],
  ]) {
    const f = fixture();
    try {
      const r = await f.call({action: 'LOOKUP_POST_BY_URL', url});
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.found, true);
      assert.equal(r.data.posts[0].id, expected);
      assert.ok(f.calls.every(c => !JSON.stringify(c.query).includes('secret')));
    } finally {
      f.store.close();
    }
  }
});
test('list limits expose encrypted exact-request continuations and resumed segments never claim global completeness', async () => {
  const f = fixture();
  try {
    f.hook(u =>
      u.pathname === '/v26.0/77/posts'
        ? u.searchParams.has('after')
          ? {data: [fb('2')]}
          : {data: [fb()], ...paging('synthetic-provider-secret')}
        : undefined,
    );
    const r = await f.call({limit: 1});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.complete, false);
    assert.equal(r.data.incomplete_reason, 'requested_result_limit');
    const next = r.data.next_call;
    assert.ok(next.arguments.arguments.after.startsWith('v1.'));
    assert.ok(!JSON.stringify(r).includes('synthetic-provider-secret'));
    assert.ok(!JSON.stringify(r).includes('untrusted.invalid'));
    const resumed = await f.service.call(next.tool, next.arguments, actor);
    assert.equal(resumed.success, true, JSON.stringify(resumed));
    assert.equal(resumed.data.retrieved_from_start, false);
    assert.equal(resumed.data.complete, false);
    assert.equal(resumed.data.remaining_pages_complete, true);
    assert.equal(resumed.data.posts[0].id, '77_2');
    assert.equal(f.calls.at(-1)!.query.after, 'synthetic-provider-secret');
  } finally {
    f.store.close();
  }
});
test('read continuation encryption survives a restart but refuses another actor, tenant, selection or key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-post-cursor-')),
    filename = path.join(dir, 'test.sqlite');
  let store = new Store(filename, key);
  try {
    const token = store.sealReadCursor(actor, 'exact selection', {after: 'synthetic-secret-cursor'});
    assert.ok(!token.includes('synthetic-secret-cursor'));
    store.close();
    store = new Store(filename, key);
    assert.deepEqual(store.openReadCursor(actor, 'exact selection', token), {after: 'synthetic-secret-cursor'});
    for (const [a, b, t] of [
      [actor, 'different selection', token],
      [{...actor, tenantId: 'other'}, 'exact selection', token],
      [{...actor, userId: 'other'}, 'exact selection', token],
      [actor, 'exact selection', token.slice(0, -2) + 'xx'],
    ])
      assert.throws(() => store.openReadCursor(a as Actor, b as string, t as string), {code: 'INVALID_READ_CURSOR'});
    const other = new Store(':memory:', Buffer.alloc(32, 1).toString('base64'));
    try {
      assert.throws(() => other.openReadCursor(actor, 'exact selection', token), {code: 'INVALID_READ_CURSOR'});
    } finally {
      other.close();
    }
  } finally {
    store.close();
    removeTestDirectory(dir, 'amcp-post-cursor-');
  }
});
test('encrypted cursors expire and reject a backwards wall-clock jump', t => {
  const f = fixture();
  try {
    const initial = Date.now();
    let now = initial;
    t.mock.method(Date, 'now', () => now);
    const token = f.store.sealReadCursor(actor, 'selection', {after: 'cursor'});
    now = initial + 900000;
    assert.throws(() => f.store.openReadCursor(actor, 'selection', token), {code: 'INVALID_READ_CURSOR'});
    now = initial - 1;
    assert.throws(() => f.store.openReadCursor(actor, 'selection', token), {code: 'INVALID_READ_CURSOR'});
  } finally {
    f.store.close();
  }
});
test('read cursors reject noncanonical base64, trailing padding data and extra segments', () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 3; i++) {
      const token = f.store.sealReadCursor(actor, 'selection', {after: 'x'.repeat(i)});
      assert.equal(f.store.openReadCursor(actor, 'selection', token).after.length, i);
      for (const bad of [
        token + 'junk',
        token + '.ignored',
        token + '=',
        token.replace('v1.', 'v1.\n'),
        token.replace('.', '..'),
      ])
        assert.throws(() => f.store.openReadCursor(actor, 'selection', bad), {code: 'INVALID_READ_CURSOR'});
    }
  } finally {
    f.store.close();
  }
});
test('changing connection, actor, limit or lookup cannot reuse a returned continuation', async () => {
  const f = fixture();
  try {
    f.hook(u => (u.pathname === '/v26.0/77/posts' ? {data: [fb()], ...paging()} : undefined));
    const r = await f.call({limit: 1});
    assert.equal(r.success, true, JSON.stringify(r));
    const args = r.data.next_call.arguments.arguments;
    f.store.putConnection(owner, {...f.c, id: otherId}, {accessToken: 'synthetic-user-token'});
    for (const override of [
      {limit: 2},
      {connection_id: otherId},
      {action: 'LOOKUP_POST_BY_URL', url: 'https://www.facebook.com/example/posts/1'},
      {after: args.after + 'bad'},
    ]) {
      const before = f.calls.length,
        result = await f.call({...args, ...override});
      assert.equal(result.error.code, 'INVALID_READ_CURSOR');
      assert.equal(f.calls.length, before);
    }
    assert.equal((await f.call(args, {...actor, userId: 'other'})).error.code, 'INVALID_READ_CURSOR');
  } finally {
    f.store.close();
  }
});
test('canonical URL refusal happens before any token or provider access and logs do not retain private URLs', async () => {
  const f = fixture();
  try {
    for (const url of [
      'http://facebook.com/a/posts/1',
      'https://facebook.com.evil.invalid/a/posts/1',
      'https://www.facebook.com@evil.invalid/a/posts/1',
      'https://www.facebook.com/share/private-secret',
      'https://www.instagram.com/stories/user/123/',
      'https://127.0.0.1/private-secret',
      'https://www.facebook.com:444/a/posts/1',
      'https://www.facebook.com/a/posts/1#private-secret',
      'https://www.facebook.com/story.php?story_fbid=1&id=99',
    ])
      assert.equal((await f.call({action: 'LOOKUP_POST_BY_URL', url})).success, false, url);
    assert.equal(f.calls.length, 0);
    assert.ok(!JSON.stringify(f.store.audit(actor.tenantId)).includes('private-secret'));
  } finally {
    f.store.close();
  }
});
test('dry-run validates and describes native prerequisites with zero calls or credentials', async () => {
  const f = fixture();
  try {
    f.store.putConnection(owner, {...f.c, enabled: false}, {accessToken: 'synthetic-user-token'});
    const r = await f.call({action: 'LIST_IG_MEDIA', dry_run: true});
    assert.equal(r.success, true);
    assert.equal(r.data.executed, false);
    assert.equal(r.data.network_requests, 0);
    assert.ok(r.data.required_scopes.includes('instagram_basic'));
    assert.equal(f.calls.length, 0);
    assert.equal((await f.call({action: 'GET_IG_MEDIA', dry_run: true})).success, false);
  } finally {
    f.store.close();
  }
});
test('advertiser grants, exact login choice and scopes are separate from native identity permissions', async () => {
  const f = fixture();
  try {
    f.store.putConnection(owner, {...f.c, id: otherId}, {accessToken: 'synthetic-user-token'});
    assert.equal((await f.call()).error.code, 'AMBIGUOUS_CONNECTION');
    assert.equal((await f.call({}, {...actor, tenantId: 'other'})).error.code, 'CONNECTION_REQUIRED');
    assert.equal((await f.call({account_id: '456'})).error.code, 'CONNECTION_REQUIRED');
    assert.equal(f.calls.length, 0);
    const r = await f.call({connection_id: connectionId});
    assert.equal(r.success, true);
    assert.equal(r.data.connection_id, connectionId);
    assert.equal(f.c.writeAccounts, undefined);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    g.store.putConnection(
      owner,
      {...g.c, scopes: ['ads_read', 'pages_show_list', 'pages_read_engagement']},
      {accessToken: 'synthetic-user-token'},
    );
    assert.deepEqual((await g.call({action: 'LIST_IG_MEDIA'})).error.details.required_scopes, ['instagram_basic']);
    assert.equal(g.calls.length, 0);
    assert.equal((await g.call()).success, true);
  } finally {
    g.store.close();
  }
});
test('missing Page/Instagram membership, changed linkage and missing Page token fail closed', async () => {
  for (const mode of ['page', 'instagram', 'link', 'token', 'owner', 'ig_owner']) {
    const f = fixture();
    try {
      f.hook(u =>
        (mode === 'page' && u.pathname.endsWith('/promote_pages')) ||
        (mode === 'instagram' && u.pathname.endsWith('/instagram_accounts'))
          ? {data: []}
          : mode === 'link' && u.pathname === '/v26.0/77'
            ? {id: '77', access_token: 'synthetic-page-token', instagram_business_account: {id: '99'}}
            : mode === 'token' && u.pathname === '/v26.0/77'
              ? {id: '77'}
              : mode === 'owner' && u.pathname.endsWith('/posts')
                ? {data: [{...fb(), from: {id: '99'}}]}
                : mode === 'ig_owner' && u.pathname.endsWith('/media')
                  ? {data: [{...ig(), owner: {id: '99'}}]}
                  : undefined,
      );
      const r = await f.call(
        ['instagram', 'link', 'ig_owner'].includes(mode) ? {action: 'LIST_IG_MEDIA', instagram_user_id: '88'} : {},
      );
      assert.equal(r.success, false, mode);
      if (mode === 'page') assert.equal(f.calls.length, 1);
    } finally {
      f.store.close();
    }
  }
});
test('scope revocation, disconnect and reauthorization during a read abort before disclosing content', async () => {
  for (const mode of ['scope', 'disconnect', 'grant', 'reauthorize']) {
    const f = fixture();
    try {
      f.hook((_u, index) => {
        if (index === 3) {
          if (mode === 'scope')
            f.store.putConnection(owner, {...f.c, scopes: ['ads_read']}, {accessToken: 'synthetic-user-token'});
          else if (mode === 'grant')
            f.store.putConnection(owner, {...f.c, accounts: []}, {accessToken: 'synthetic-user-token'});
          else
            f.store.putConnection(
              owner,
              {...f.c, enabled: mode !== 'disconnect'},
              {accessToken: mode === 'reauthorize' ? 'synthetic-changed-token' : 'synthetic-user-token'},
            );
        }
        return undefined;
      });
      const r = await f.call();
      assert.equal(r.success, false, mode);
      assert.equal(r.data, undefined);
      assert.equal(f.calls.length, 3);
    } finally {
      f.store.close();
    }
  }
});
test('malformed, partial, duplicate and oversized native envelopes never become successful empty post lists', async () => {
  for (const body of [
    {},
    {data: null},
    {data: [], warnings: []},
    {data: [], summary: {}},
    {data: [fb(), fb()]},
    {data: [{...fb(), id: 1}]},
    {data: [{...fb(), message: 123}]},
    {data: [{...fb(), is_published: 'true'}]},
    {data: [fb()], paging: {next: 'https://evil.invalid'}},
    {data: [], ...paging()},
    {data: [], paging: null},
    {data: [fb()], paging: {cursors: {after: 'same'}, next: 0}},
    {data: [{...fb(), huge: 'x'.repeat(2 * 1024 * 1024)}]},
  ]) {
    const f = fixture();
    try {
      f.hook(u => (u.pathname.endsWith('/posts') ? body : undefined));
      assert.equal((await f.call()).success, false, JSON.stringify(body).slice(0, 120));
    } finally {
      f.store.close();
    }
  }
});
test('upstream failure details never leak a Page token or a private URL, including HTTP 200 errors', async () => {
  for (const status of [200, 400, 403]) {
    const f = fixture();
    try {
      f.hook(u =>
        u.pathname.endsWith('/posts')
          ? Response.json(
              {error: {message: 'synthetic-page-token https://private.invalid/?secret=private-value'}},
              {status},
            )
          : undefined,
      );
      const r = await f.call();
      assert.equal(r.success, false);
      const publicData = JSON.stringify([r, f.store.audit(actor.tenantId)]);
      assert.ok(!publicData.includes('synthetic-page-token'));
      assert.ok(!publicData.includes('private-value'));
      assert.ok(!publicData.includes('private.invalid'));
      if (status === 403) assert.equal(r.error.code, 'PROVIDER_ACCESS_DENIED');
    } finally {
      f.store.close();
    }
  }
});
test('complete bounded identity discovery is required even if the target occurs on the first page', async () => {
  const f = fixture();
  try {
    f.hook(u =>
      u.pathname.endsWith('/promote_pages')
        ? u.searchParams.has('after')
          ? {data: [{id: '78'}]}
          : {data: [{id: '77'}], ...paging('identities-2')}
        : undefined,
    );
    assert.equal((await f.call()).success, true);
    assert.equal(f.calls[1]!.query.after, 'identities-2');
    assert.equal(f.calls[2]!.path, '/v26.0/77');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    g.hook((u, index) =>
      u.pathname.endsWith('/promote_pages') ? {data: [{id: String(index + 76)}], ...paging('loop')} : undefined,
    );
    const r = await g.call();
    assert.equal(r.error.code, 'META_POST_READ_INCOMPLETE');
    assert.equal(g.calls.length, 2);
  } finally {
    g.store.close();
  }
});
test('URL search distinguishes no match, missing permalink and a partial bounded search', async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.call({action: 'LOOKUP_POST_BY_URL', url: 'https://www.facebook.com/example/posts/99'})).data.found,
      false,
    );
    f.hook(u => (u.pathname.endsWith('/posts') ? {data: [{...fb(), permalink_url: undefined}]} : undefined));
    assert.equal(
      (await f.call({action: 'LOOKUP_POST_BY_URL', url: 'https://www.facebook.com/example/posts/99'})).error.code,
      'META_POST_READ_INCOMPLETE',
    );
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    let page = 0;
    g.hook(u =>
      u.pathname.endsWith('/posts')
        ? {data: Array.from({length: 100}, (_, i) => fb(String(page * 100 + i + 1))), ...paging('cursor-' + ++page)}
        : undefined,
    );
    const r = await g.call({action: 'LOOKUP_POST_BY_URL', url: 'https://www.facebook.com/example/posts/9999'});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.found, false);
    assert.equal(r.data.search_complete, false);
    assert.equal(r.data.scanned, 1000);
    assert.equal(r.data.pages, 10);
    assert.equal(r.data.incomplete_reason, 'search_bound');
    assert.ok(r.data.next_call);
  } finally {
    g.store.close();
  }
});
test('post pagination loops and duplicate identities are rejected instead of offering an endless continuation', async () => {
  const f = fixture();
  try {
    let n = 0;
    f.hook(u => (u.pathname.endsWith('/posts') ? {data: [fb(String(++n))], ...paging('same')} : undefined));
    assert.equal((await f.call()).error.code, 'META_POST_READ_INCOMPLETE');
  } finally {
    f.store.close();
  }
});
test('unsupported field overrides, conflicting aliases and foreign IDs are refused before egress', async () => {
  const f = fixture();
  try {
    for (const input of [
      {account_id: 123},
      {page_id: '../77'},
      {page_id: '99', pageId: '77'},
      {action: 'GET_POST_BY_ID', post_id: '99_1'},
      {action: 'GET_IG_MEDIA', post_id: '77_1'},
      {params: {access_token: 'synthetic-secret'}},
      {payload: {fields: 'access_token'}},
      {params: {fields: 'id,access_token'}},
      {limit: 101},
      {limit: 0},
      {params: {account_id: '999'}},
      {url: 'https://facebook.com/example/posts/1'},
      {instagram_user_id: '88'},
    ])
      assert.equal((await f.call(input)).success, false, JSON.stringify(input));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('empty successful collections stay empty and keep their provider-coverage qualification', async () => {
  const f = fixture();
  try {
    f.hook(u => (u.pathname.endsWith('/posts') ? {data: []} : undefined));
    const r = await f.call();
    assert.equal(r.success, true);
    assert.deepEqual(r.data.posts, []);
    assert.equal(r.data.complete, true);
    assert.match(r.data.qualification, /Deleted or unavailable/);
  } finally {
    f.store.close();
  }
});
test('runtime help and the action ledger agree without mutating captured schema evidence', () => {
  const captured = JSON.stringify(registry.data.tools.find(t => t.name === 'amcp_native_action'));
  const help = registry.help(
    {gateway: 'amcp_native_action', operation: 'fetch_meta_existing_posts'},
    {mode: 'strict', flags: {}},
  );
  assert.ok(help.argumentsSchema.properties.instagram_user_id);
  assert.equal(help.argumentsSchema.properties.payload, undefined);
  assert.ok(help.amcp_contract);
  assert.equal(JSON.stringify(registry.data.tools.find(t => t.name === 'amcp_native_action')), captured);
  const rows = actionContracts(registry).filter(r => r.operation === 'fetch_meta_existing_posts');
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(r => r.action).sort(), [...metaPostActions].sort());
  assert.ok(
    rows.every(
      r =>
        r.status === 'local_workflow' &&
        r.live_qualification === 'unverified' &&
        r.implementation === 'src/meta-existing-posts.ts',
    ),
  );
});
test('fixed read fields and identity edges are present in the source-hashed official v26 SDK fixture', () => {
  const f = JSON.parse(fs.readFileSync('tests/fixtures/meta-post-sdk-v26.json', 'utf8'));
  assert.equal(f.sdk_tag, '26.0.2');
  for (const field of metaPostFields.facebook) assert.ok(f.fields.pagepost[field], field);
  for (const field of metaPostFields.instagram) assert.ok(f.fields.igmedia[field], field);
  assert.deepEqual(
    Object.values(f.routes).map((v: any) => v.method),
    ['GET', 'GET', 'GET', 'GET'],
  );
  assert.equal(
    Object.values(f.sources).filter((v: any) => /^[a-f0-9]{64}$/.test(v.sha256) && v.url.includes('/26.0.2/')).length,
    5,
  );
});
test('canonical permalink conversion strips tracking and refuses URL ambiguity', () => {
  assert.equal(
    metaPostPermalink('https://www.facebook.com/story.php?id=77&story_fbid=1&access_token=secret').url,
    'https://www.facebook.com/permalink.php?story_fbid=1&id=77',
  );
  assert.equal(metaPostPermalink('https://www.instagram.com/reel/A-b_c/').key, 'A-b_c');
  assert.throws(() => metaPostPermalink('https://www.facebook.com/story.php?id=77&id=88&story_fbid=1'));
});
test('provider read timeout bounds are checked with a monotonic clock', async t => {
  const f = fixture();
  try {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    f.hook((_u, index) => {
      if (index === 2) now = 60001;
      return undefined;
    });
    const r = await f.call();
    assert.equal(r.error.code, 'META_POST_READ_INCOMPLETE');
    assert.equal(f.calls.length, 2);
  } finally {
    f.store.close();
  }
});

test('numeric Facebook permalink forms reconcile to the exact owned composite post ID', async () => {
  const f = fixture();
  try {
    for (const url of [
      'https://www.facebook.com/story.php?id=77&story_fbid=1',
      'https://www.facebook.com/77/posts/1',
    ]) {
      const r = await f.call({action: 'LOOKUP_POST_BY_URL', url});
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.found, true);
      assert.equal(r.data.posts[0].id, '77_1');
    }
    const before = f.calls.length;
    assert.equal(
      (await f.call({action: 'LOOKUP_POST_BY_URL', url: 'https://www.facebook.com/99/posts/1'})).error.code,
      'ACCOUNT_SCOPE_MISMATCH',
    );
    assert.equal(f.calls.length, before);
  } finally {
    f.store.close();
  }
});
test('reauthorization racing credential retrieval cannot send the previous identity token', async t => {
  const f = fixture();
  try {
    t.mock.method(f.service.credentials, 'get', async () => {
      f.store.putConnection(owner, f.c, {accessToken: 'synthetic-changed-token'});
      return {accessToken: 'synthetic-user-token'};
    });
    assert.equal((await f.call()).error.code, 'CONNECTION_AUTHORITY_CHANGED');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('reauthorization and changed Page-to-Instagram linkage invalidate old continuations', async () => {
  const f = fixture();
  try {
    f.hook(u => (u.pathname.endsWith('/posts') ? {data: [fb()], ...paging()} : undefined));
    const r = await f.call({limit: 1});
    f.store.putConnection(owner, f.c, {accessToken: 'synthetic-changed-token'});
    const before = f.calls.length;
    assert.equal(
      (await f.service.call(r.data.next_call.tool, r.data.next_call.arguments, actor)).error.code,
      'INVALID_READ_CURSOR',
    );
    assert.equal(f.calls.length, before);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    g.hook(u => (u.pathname.endsWith('/media') ? {data: [ig()], ...paging()} : undefined));
    const r = await g.call({action: 'LIST_IG_MEDIA', limit: 1});
    assert.equal(r.success, true, JSON.stringify(r));
    g.hook(u =>
      u.pathname === '/v26.0/77'
        ? {id: '77', access_token: 'synthetic-page-token', instagram_business_account: {id: '89'}}
        : u.pathname.endsWith('/instagram_accounts')
          ? {data: [{id: '89'}]}
          : undefined,
    );
    assert.equal(
      (await g.service.call(r.data.next_call.tool, r.data.next_call.arguments, actor)).error.code,
      'INVALID_READ_CURSOR',
    );
    assert.ok(!g.calls.some(c => c.path === '/v26.0/89/media'));
  } finally {
    g.store.close();
  }
});
test('exact Instagram foreign owners and unknown media types do not disclose a creative reference', async () => {
  for (const row of [
    {...ig(), owner: {id: '99'}},
    {...ig(), owner: undefined},
    {...ig(), id: '502'},
    {...ig(), media_type: 'UNKNOWN'},
  ]) {
    const f = fixture();
    try {
      f.hook(u => (u.pathname === '/v26.0/501' ? row : undefined));
      const r = await f.call({action: 'GET_IG_MEDIA', post_id: '501'});
      assert.equal(r.success, false);
      assert.equal(r.data, undefined);
    } finally {
      f.store.close();
    }
  }
});
test('documented post-read examples execute and their creative references pass separate local write inspection', async () => {
  const examples = JSON.parse(
    fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).meta_existing_post_reads;
  assert.equal(examples.length, 5);
  const f = fixture();
  try {
    for (const example of examples) {
      const r = await f.service.call(example.gateway, example.arguments, actor);
      assert.equal(r.success, true, JSON.stringify(r));
      const before = f.calls.length,
        inspect = await f.service.call(
          'amcp_write',
          {
            action: 'inspect',
            gateway: 'meta_native_action',
            arguments: {
              action: 'meta_creative_create',
              account_id: '123',
              payload: {name: 'User-approved existing post creative', ...r.data.posts[0].creative_reference},
            },
          },
          actor,
        );
      assert.equal(inspect.success, true, JSON.stringify(inspect));
      assert.equal(inspect.data.review_contract_supported, true, JSON.stringify(inspect));
      assert.equal(f.calls.length, before);
    }
  } finally {
    f.store.close();
  }
});
