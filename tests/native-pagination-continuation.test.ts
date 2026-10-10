// MCP-04: honest pagination for native reads. A capped aggregation returns a next_call that reads exactly the rows it
// did not merge (Meta cursor, TikTok cursor and page number, Google page token, Reddit page token); TikTok cursor reads
// follow every page; a defaulted Google legacy limit is disclosed. Synthetic transports only: no provider is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {paginate} from '../src/pagination.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from '../src/types.js';

const registry = new Registry(),
  actor: Actor = {tenantId: 'paging', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'};
type Handler = (url: URL, body: JsonObject | undefined) => unknown;
function fixture(gateway: string, account: string, handler: Handler, scopes: string[] = []) {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64')),
    calls: URL[] = [];
  const c: Connection = {
    id: '00000000-0000-4000-8000-000000000041',
    tenantId: actor.tenantId,
    gateway,
    accounts: [account],
    enabled: true,
    label: 'Synthetic',
    scopes,
    userAgent: 'server:amcp-paging-test:0.1.0 (local mock)',
  };
  store.putConnection(admin, c, {accessToken: 'synthetic'});
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url));
      calls.push(u);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Response.json(handler(u, body));
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport);
  return {store, service, calls, call: (tool: string, args: JsonObject) => service.call(tool, args, actor)};
}
const ids = (rows: JsonObject[]) => rows.map(r => String(r.id ?? r.campaign_id ?? r.video_id));
/** Follows next_call until the collection is complete; returns every row's ID in order. */
async function follow(f: ReturnType<typeof fixture>, first: any, rows: (r: any) => JsonObject[]) {
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.data.truncated, true);
  const all = ids(rows(first));
  let current = first;
  while (current.data.truncated) {
    const next = current.data.next_call;
    assert.ok(next, 'a capped aggregation offers the call that reads the remaining pages');
    const args = next.arguments.arguments ?? next.arguments;
    assert.deepEqual(next.effects, {provider_requests: args.max_pages ?? 25, saves: [], advertising_writes: 0});
    current = await f.call(next.tool, next.arguments);
    assert.equal(current.success, true, JSON.stringify(current));
    all.push(...ids(rows(current)));
  }
  assert.equal(current.data.next_call, undefined);
  return all;
}
test('Meta: a capped aggregation continues from the first unread page, and its visible cursor is not a merged page', async () => {
  const pages: Record<string, JsonObject> = {
    '': {
      data: [{id: '1'}, {id: '2'}],
      paging: {cursors: {before: 'b1', after: 'p2'}, next: 'https://graph.facebook.com/next?after=p2'},
    },
    p2: {
      data: [{id: '3'}, {id: '4'}],
      paging: {cursors: {before: 'b2', after: 'p3'}, next: 'https://graph.facebook.com/next?after=p3'},
    },
    p3: {data: [{id: '5'}], paging: {cursors: {before: 'b3', after: 'end'}}},
  };
  const f = fixture('meta_native_action', '123', u => pages[u.searchParams.get('after') ?? '']);
  try {
    const first = await f.call('meta_native_action', {
      action: 'meta_campaign_list',
      account_id: '123',
      params: {fields: 'id,name'},
      aggregate_pages: true,
      max_pages: 2,
    });
    // Old code: paging.cursors.after was 'p2' (page 1's cursor, already merged) and there was no next_call.
    assert.equal(first.data.data.paging.cursors.after, 'p3');
    assert.equal(first.data.pages, 2);
    const all = await follow(f, first, r => r.data.data.data);
    assert.deepEqual(all, ['1', '2', '3', '4', '5'], 'exactly the remaining rows, no duplicate IDs');
    assert.equal(f.calls.at(-1)!.searchParams.get('after'), 'p3');
    // A complete aggregation keeps the last page's paging object, which advertises no further page.
    const complete = await f.call('meta_native_action', {
      action: 'meta_campaign_list',
      account_id: '123',
      params: {fields: 'id,name'},
      aggregate_pages: true,
    });
    assert.equal(complete.data.truncated, false);
    assert.equal(complete.data.next_call, undefined);
    assert.equal(complete.data.data.paging.next, undefined);
    assert.deepEqual(ids(complete.data.data.data), ['1', '2', '3', '4', '5']);
  } finally {
    f.store.close();
  }
});

test('TikTok cursor reads follow every page; has_more without a cursor is refused', async () => {
  const advertiser = '7000000000000000001',
    videos = (from: number, n: number) => Array.from({length: n}, (_, i) => ({video_id: 'v' + (from + i)}));
  let mode = 'cursor';
  const f = fixture('tiktok_native_action', advertiser, u => {
    const cursor = Number(u.searchParams.get('cursor') ?? 0);
    if (mode === 'no_cursor') return {code: 0, message: 'OK', data: {videos: videos(0, 2), has_more: true}};
    if (cursor === 0) return {code: 0, message: 'OK', data: {videos: videos(0, 2), cursor: 2, has_more: true}};
    if (cursor === 2) return {code: 0, message: 'OK', data: {videos: videos(2, 2), cursor: 4, has_more: true}};
    return {code: 0, message: 'OK', data: {videos: videos(4, 1), cursor: 5, has_more: false}};
  });
  const args = {
    action: 'tiktok_identity_video_get',
    account_id: advertiser,
    params: {identity_type: 'TT_USER', identity_id: 'synthetic-identity'},
    aggregate_pages: true,
  };
  try {
    // Old code: one provider call, pages 1, truncated false, while has_more stayed true.
    const all = await f.call('tiktok_native_action', args);
    assert.equal(all.success, true, JSON.stringify(all));
    assert.equal(all.data.pages, 3);
    assert.equal(all.data.truncated, false);
    assert.deepEqual(ids(all.data.data.data.videos), ['v0', 'v1', 'v2', 'v3', 'v4']);
    assert.equal(all.data.data.data.has_more, false, 'the visible completion flag describes the last page read');
    const calls = f.calls.length;
    const first = await f.call('tiktok_native_action', {...args, max_pages: 2});
    assert.equal(f.calls.length, calls + 2);
    assert.deepEqual(await follow(f, first, r => r.data.data.data.videos), ['v0', 'v1', 'v2', 'v3', 'v4']);
    mode = 'no_cursor';
    const refused = await f.call('tiktok_native_action', args);
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'UNKNOWN_PAGINATION');
  } finally {
    f.store.close();
  }
});

test('TikTok page-number lists continue at the next page number', async () => {
  const advertiser = '7000000000000000001';
  const f = fixture('tiktok_native_action', advertiser, u => {
    const page = Number(u.searchParams.get('page') ?? 1);
    return {
      code: 0,
      message: 'OK',
      data: {
        list: [{campaign_id: 'c' + (page * 2 - 1)}, {campaign_id: 'c' + page * 2}],
        page_info: {page, page_size: 2, total_number: 6, total_page: 3},
      },
    };
  });
  try {
    const first = await f.call('tiktok_native_action', {
      action: 'tiktok_campaign_get',
      account_id: advertiser,
      params: {page_size: 2},
      aggregate_pages: true,
      max_pages: 2,
    });
    assert.equal(first.data.data.data.page_info.page, 2);
    assert.equal(first.data.next_call.arguments.query.page, 3);
    assert.deepEqual(await follow(f, first, r => r.data.data.data.list), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  } finally {
    f.store.close();
  }
});

test('Google page tokens: the continuation carries the next token in the request body', async () => {
  const pages: Record<string, JsonObject> = {
    '': {results: [{campaign: {id: '1'}}], nextPageToken: 't2'},
    t2: {results: [{campaign: {id: '2'}}], nextPageToken: 't3'},
    t3: {results: [{campaign: {id: '3'}}]},
  };
  const f = fixture(
    'google_ads_native_action',
    '1234567890',
    (_u, body) => pages[String(body?.page_token ?? body?.pageToken ?? '')],
    ['https://www.googleapis.com/auth/adwords'],
  );
  try {
    const first = await f.call('google_ads_native_action', {
      action: 'google_ads_v23_google_ads_search',
      account_id: '1234567890',
      params: {query: 'SELECT campaign.id FROM campaign'},
      aggregate_pages: true,
      max_pages: 1,
    });
    const rows = (r: any) => r.data.data.results.map((x: JsonObject) => ({id: x.campaign.id}));
    assert.deepEqual(await follow(f, first, rows), ['1', '2', '3']);
  } finally {
    f.store.close();
  }
});

test('Reddit (a delegated route): the continuation replaces the caller’s page-token alias', async () => {
  const base = 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_111/campaigns';
  const f = fixture(
    'reddit_native_action',
    'a2_111',
    u => {
      const token = u.searchParams.get('page.token') ?? 'r1';
      const next = ({r1: 'r2', r2: 'r3'} as Record<string, string>)[token];
      return {
        data: [{id: 'reddit-' + token}],
        pagination: next ? {next_url: base + '?page.size=1&page.token=' + next} : {},
      };
    },
    ['adsread'],
  );
  try {
    // Delegated operations aggregate only for AMCP's own callers (reports); their public schema has no aggregation
    // controls, so the continuation reads the next page itself.
    const args = {action: 'LIST_CAMPAIGNS', account_id: 'a2_111', pageSize: 1, pageToken: 'r1', aggregate_pages: true},
      plan = f.service.delegatedCompiler.compile('reddit_native_action', {
        operation: 'reddit_campaign_ops',
        arguments: args,
      });
    const first: any = await f.service.runPlan(plan, {...args, max_pages: 1}, actor);
    assert.equal(first.truncated, true);
    assert.deepEqual(ids(first.data.data), ['reddit-r1']);
    const next = first.next_call;
    assert.equal(next.arguments.operation, 'reddit_campaign_ops');
    assert.equal(next.arguments.arguments.pageToken, 'r2', 'the alias the caller used carries the next token');
    assert.equal(next.arguments.arguments.aggregate_pages, undefined);
    assert.deepEqual(next.effects, {provider_requests: 1, saves: [], advertising_writes: 0});
    const rest = await f.call(next.tool, next.arguments);
    assert.equal(rest.success, true, JSON.stringify(rest));
    assert.deepEqual(ids(rest.data.data.data), ['reddit-r2']);
    assert.equal(f.calls.at(-1)!.searchParams.get('page.token'), 'r2');
  } finally {
    f.store.close();
  }
});

test('TikTok integrated reports are still collected whole from page one; a capped one repeats with every page', async () => {
  const advertiser = '7000000000000000001',
    total = 3;
  const f = fixture('tiktok_native_action', advertiser, u => {
    const page = Number(u.searchParams.get('page') ?? 1);
    return {
      code: 0,
      message: 'OK',
      data: {
        list: [{dimensions: {stat_time_day: '2026-09-0' + page}, metrics: {spend: '1'}}],
        page_info: {page, page_size: 1, total_number: total, total_page: total},
      },
    };
  });
  const args = {
    action: 'tiktok_report_integrated_get',
    account_id: advertiser,
    params: {
      report_type: 'BASIC',
      data_level: 'AUCTION_ADVERTISER',
      dimensions: ['stat_time_day'],
      metrics: ['spend'],
      start_date: '2026-09-01',
      end_date: '2026-09-03',
      page_size: 1,
    },
    aggregate_pages: true,
  };
  try {
    const capped = await f.call('tiktok_native_action', {...args, max_pages: 2});
    assert.equal(capped.success, true, JSON.stringify(capped));
    assert.equal(capped.data.truncated, true);
    assert.equal(capped.data.next_call.arguments.max_pages, total);
    assert.equal(capped.data.next_call.arguments.params.page, undefined, 'never resumes an integrated report mid-way');
    const whole = await f.call(capped.data.next_call.tool, capped.data.next_call.arguments);
    assert.equal(whole.data.truncated, false);
    assert.equal(whole.data.data.data.list.length, total);
    const midway = await f.call('tiktok_native_action', {...args, params: {...args.params, page: 2}});
    assert.equal(midway.error.code, 'REPORT_INCOMPLETE');
  } finally {
    f.store.close();
  }
});

test('Google legacy lists disclose their defaulted 100-row limit', async () => {
  let rows = 100;
  const queries: string[] = [];
  const f = fixture(
    'google_ads_native_action',
    '1234567890',
    (_url, body) => {
      queries.push(String(body?.query));
      return {results: Array.from({length: rows}, (_, i) => ({campaign: {id: String(i + 1)}}))};
    },
    ['https://www.googleapis.com/auth/adwords'],
  );
  try {
    const defaulted = await f.call('google_ads_native_action', {action: 'FETCH_CAMPAIGNS', account_id: '1234567890'});
    assert.equal(defaulted.success, true, JSON.stringify(defaulted));
    assert.match(String(f.calls.length), /^1$/);
    assert.equal(defaulted.data.truncated_possible, true);
    assert.equal(defaulted.data.default_limit, 100);
    assert.equal(defaulted.data.next_call.arguments.params.limit, 10000);
    const raised = await f.call(defaulted.data.next_call.tool, defaulted.data.next_call.arguments);
    assert.equal(raised.success, true, JSON.stringify(raised));
    // The offered call compiles to the same GAQL list with the maximum limit in place of the default.
    assert.match(queries[0]!, / LIMIT 100$/);
    assert.equal(queries[1], queries[0]!.replace(/ LIMIT 100$/, ' LIMIT 10000'));
    assert.equal(raised.data.truncated_possible, undefined, 'an explicit limit is the caller’s choice');
    const explicit = await f.call('google_ads_native_action', {
      action: 'FETCH_CAMPAIGNS',
      account_id: '1234567890',
      params: {limit: 100},
    });
    assert.equal(explicit.data.truncated_possible, undefined);
    rows = 99;
    const fewer = await f.call('google_ads_native_action', {action: 'FETCH_CAMPAIGNS', account_id: '1234567890'});
    assert.equal(fewer.data.truncated_possible, undefined);
  } finally {
    f.store.close();
  }
});

test('paginate refuses a continued response without a row collection instead of replacing the first page', async () => {
  const plan: CompiledRequest = {
    gateway: 'meta_native_action',
    action: 'list',
    method: 'GET',
    path: '/v26.0/act_123/campaigns',
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    accountId: '123',
    evidence: 'TEST',
    warnings: [],
  };
  await assert.rejects(
    paginate(plan, async p => ({id: p.query.after ?? 'first', paging: {next: 'n', cursors: {after: 'x'}}}), 5),
    {code: 'UNKNOWN_PAGINATION'},
  );
  const capped = await paginate(
    plan,
    async p => ({
      data: [{id: p.query.after ?? '1'}],
      paging: {next: 'n', cursors: {after: String(Number(p.query.after ?? 1) + 1)}},
    }),
    2,
  );
  assert.equal(capped.truncated, true);
  assert.equal(capped.continuation?.query.after, '3');
});
