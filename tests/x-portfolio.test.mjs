import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {xPortfolioResponse, xPortfolioCampaign} from './fixtures/x-portfolio-data.mjs';

function fixture(t) {
  const actor = {tenantId: 'x-portfolio', userId: 'reader', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 107).toString('base64')),
    credentials = {
      accessToken: 'synthetic-token',
      consumerKey: 'synthetic-key',
      consumerSecret: 'synthetic-secret',
      tokenSecret: 'synthetic-token-secret',
    },
    connection = {
      id: 'ffffffff-1111-4111-8111-111111111112',
      tenantId: actor.tenantId,
      gateway: 'x_ads_native_action',
      enabled: true,
      label: 'Synthetic X',
      accounts: ['acct1', 'acct2'],
      scopes: [],
    },
    requests = [];
  t.after(() => store.close());
  store.putConnection({...actor, role: 'admin'}, connection, credentials);
  let edit = (_u, d) => d;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const u = new URL(url);
        requests.push({url: u, method: init.method});
        assert.equal(u.origin, 'https://ads-api.x.com');
        return Response.json(edit(u, xPortfolioResponse(u)));
      },
      async () => {},
      30000,
      8 * 1024 * 1024,
      1000,
      1,
    ),
  );
  return {
    actor,
    store,
    connection,
    credentials,
    requests,
    edit: fn => {
      edit = fn;
    },
    call: (requirements = {entity: 'campaign'}, extra = {}) =>
      service.call(
        'amcp_workspace',
        {
          action: 'portfolio',
          gateway: 'x_ads_native_action',
          account_id: 'acct1',
          connection_id: connection.id,
          limit: 2,
          requirements,
          ...extra,
        },
        actor,
      ),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
const denied = r => {
  assert.equal(r.success, false);
  assert.equal(r.data, undefined);
  return r.error.code;
};

test('X portfolio reads bounded signed campaign pages and preserves exact native micros and independent statuses', async t => {
  const f = fixture(t),
    first = ok(await f.call());
  assert.equal(first.rows[0].id, 'camp1');
  assert.equal(first.rows[0].native_money.daily_budget_amount_local_micro, '9007199254740993');
  assert.equal(first.rows[0].native_money.total_budget_amount_local_micro, null);
  assert.equal(first.rows[0].status, 'PAUSED');
  assert.equal(first.rows[0].effective_status, 'UNKNOWN');
  assert.equal(first.rows[0].servable, false);
  assert.deepEqual(first.rows[0].reasons_not_servable, ['PAUSED_BY_ADVERTISER']);
  assert.equal(first.rows[0].currency, 'USD');
  assert.equal(first.rows[0].timezone, 'America/Los_Angeles');
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|synthetic-secret|synthetic-token/);
  assert.equal(first.has_more, true);
  assert.equal(f.requests.length, 2, 'native automatic pagination stays disabled');
  assert.equal(f.requests[1].url.searchParams.get('count'), '2');
  assert.equal(f.requests[1].url.searchParams.get('with_deleted'), 'false');
  assert.equal(f.requests[1].url.searchParams.get('with_draft'), 'false');
  const next = ok(await f.call({entity: 'campaign'}, {cursor: first.next_cursor}));
  assert.deepEqual(
    next.rows.map(r => r.id),
    ['camp3'],
  );
  assert.equal(next.next_cursor, null);
  assert.equal(f.requests[3].url.searchParams.get('cursor'), 'native-next');
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('X direct child reads verify current campaign and line-item parentage on fixed account routes', async t => {
  const f = fixture(t),
    lines = ok(await f.call({entity: 'line_item', campaign_id: 'camp1'}));
  assert.equal(lines.rows[0].native_money.bid_amount_local_micro, '320000');
  assert.equal(lines.rows[0].campaign_id, 'camp1');
  assert.equal(lines.rows[0].native.product_type, 'PROMOTED_TWEETS');
  assert.equal(f.requests[2].url.searchParams.get('campaign_ids'), 'camp1');
  const posts = ok(await f.call({entity: 'promoted_tweet', campaign_id: 'camp1', line_item_id: 'line1'}));
  assert.equal(posts.rows[0].id, 'post1');
  assert.equal(posts.rows[0].tweet_id, '880290790664060928');
  assert.equal(posts.rows[0].approval_status, 'ACCEPTED');
  assert.deepEqual(posts.rows[0].native_money, {});
  assert.equal(posts.rows[0].currency, 'USD');
  assert.equal(posts.rows[0].line_item_id, 'line1');
  assert.equal(f.requests.at(-1).url.searchParams.get('line_item_ids'), 'line1');
  assert.equal(f.requests.length, 7);
  assert.doesNotMatch(JSON.stringify([lines, posts]), /PRIVATE/);
});

test('X cursors reject tampering, expiry, changed account, hierarchy, page size, actor and credentials before egress', async t => {
  const f = fixture(t),
    first = ok(await f.call());
  const altered = JSON.parse(Buffer.from(first.next_cursor, 'base64url'));
  altered.cursor = 'replacement';
  for (const extra of [
    {cursor: Buffer.from(JSON.stringify(altered)).toString('base64url')},
    {cursor: first.next_cursor + '='},
    {cursor: first.next_cursor, limit: 3},
    {cursor: first.next_cursor, account_id: 'acct2'},
  ])
    assert.equal(denied(await f.call({entity: 'campaign'}, extra)), 'INVALID_CURSOR');
  assert.equal(
    denied(await f.call({entity: 'line_item', campaign_id: 'camp1'}, {cursor: first.next_cursor})),
    'INVALID_CURSOR',
  );
  f.actor.userId = 'other';
  assert.equal(denied(await f.call({entity: 'campaign'}, {cursor: first.next_cursor})), 'INVALID_CURSOR');
  f.actor.userId = 'reader';
  const otherConnection = 'ffffffff-1111-4111-8111-111111111113';
  f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, id: otherConnection}, f.credentials);
  assert.equal(
    denied(await f.call({entity: 'campaign'}, {cursor: first.next_cursor, connection_id: otherConnection})),
    'INVALID_CURSOR',
  );
  const now = Date.now;
  try {
    Date.now = () => now() + 300001;
    assert.equal(denied(await f.call({entity: 'campaign'}, {cursor: first.next_cursor})), 'INVALID_CURSOR');
  } finally {
    Date.now = now;
  }
  f.store.putConnection({...f.actor, role: 'admin'}, f.connection, {...f.credentials, tokenSecret: 'replacement'});
  assert.equal(denied(await f.call({entity: 'campaign'}, {cursor: first.next_cursor})), 'INVALID_CURSOR');
  assert.equal(f.requests.length, 2);
});

test('X portfolio refuses wrong native scope, unsafe money, deleted or malformed entities and incomplete envelopes', async t => {
  for (const change of [
    d => (d.request.params.account_id = 'foreign'),
    d => delete d.request,
    d => (d.data[0].account_id = 'foreign'),
    d => (d.data[0].id = 123),
    d => (d.data[0].daily_budget_amount_local_micro = 9007199254740992),
    d => (d.data[0].daily_budget_amount_local_micro = '9223372036854775808'),
    d => (d.data[0].daily_budget_amount_local_micro = '1e6'),
    d => (d.data[0].deleted = true),
    d => delete d.data[0].deleted,
    d => (d.data[0].entity_status = 'DRAFT'),
    d => (d.data[0].servable = 'true'),
    d => (d.data[0].currency = 'invalid'),
    d => (d.data = [d.data[0], d.data[0]]),
    d => (d.errors = [{code: 'PARTIAL'}]),
    d => (d.data = null),
    d => (d.next_cursor = {}),
    d => (d.paging = {next: 'https://example.test/'}),
  ]) {
    const f = fixture(t);
    f.edit((u, d) => {
      if (u.pathname.endsWith('/campaigns')) change(d);
      return d;
    });
    assert.ok(['PORTFOLIO_INVALID_RESPONSE', 'PLATFORM_ERROR'].includes(denied(await f.call())), change.toString());
    assert.equal(f.requests.length, 2);
  }
});

test('X parent and child identity failures stop before an unrelated hierarchy is displayed', async t => {
  for (const where of ['account', 'campaign', 'line', 'post']) {
    const f = fixture(t);
    f.edit((u, d) => {
      if (where === 'account' && u.pathname === '/12/accounts/acct1') d.data.id = 'foreign';
      if (where === 'campaign' && u.pathname.endsWith('/campaigns/camp1')) d.data.id = 'foreign';
      if (where === 'line' && u.pathname.endsWith('/line_items/line1')) d.data.campaign_id = 'foreign';
      if (where === 'post' && u.pathname.endsWith('/promoted_tweets')) d.data[0].line_item_id = 'foreign';
      return d;
    });
    assert.equal(
      denied(await f.call({entity: 'promoted_tweet', campaign_id: 'camp1', line_item_id: 'line1'})),
      'PORTFOLIO_INVALID_RESPONSE',
    );
    assert.equal(f.requests.length, ['account', 'campaign', 'line', 'post'].indexOf(where) + 1);
  }
  const f = fixture(t);
  f.edit((u, d) => {
    if (u.pathname.endsWith('/line_items')) d.data[0].campaign_id = 'foreign';
    return d;
  });
  assert.equal(denied(await f.call({entity: 'line_item', campaign_id: 'camp1'})), 'PORTFOLIO_INVALID_RESPONSE');
  assert.equal(f.requests.length, 3);
});

test('X inventory fences credential and account changes after each native read', async t => {
  for (const reason of ['credentials', 'account', 'scopes'])
    for (const at of [1, 2, 3, 4]) {
      const f = fixture(t);
      f.edit((_u, d) => {
        if (f.requests.length === at)
          f.store.putConnection(
            {...f.actor, role: 'admin'},
            {
              ...f.connection,
              ...(reason === 'account' ? {accounts: []} : reason === 'scopes' ? {scopes: ['changed']} : {}),
            },
            reason === 'credentials' ? {...f.credentials, tokenSecret: 'rotated'} : f.credentials,
          );
        return d;
      });
      denied(await f.call({entity: 'promoted_tweet', campaign_id: 'camp1', line_item_id: 'line1'}));
      assert.equal(f.requests.length, at);
    }
});

test('X pagination refuses adjacent overlaps and repeated continuation tokens without following URLs', async t => {
  for (const reason of ['overlap', 'cycle']) {
    const f = fixture(t),
      first = ok(await f.call());
    f.edit((u, d) => {
      if (u.pathname.endsWith('/campaigns')) {
        if (reason === 'overlap') d.data = [xPortfolioCampaign()];
        else d.next_cursor = 'native-next';
      }
      return d;
    });
    assert.equal(denied(await f.call({entity: 'campaign'}, {cursor: first.next_cursor})), 'PORTFOLIO_INVALID_RESPONSE');
    assert.equal(f.requests.length, 4);
  }
});

test('X portfolio accepts explicit empty data and rejects malformed hierarchy or page limits before egress', async t => {
  const f = fixture(t);
  for (const requirements of [
    {entity: 'line_item'},
    {entity: 'campaign', campaign_id: 'camp1'},
    {entity: 'ad'},
    {entity: 'promoted_tweet', campaign_id: 'camp1', line_item_id: 'bad/path'},
  ])
    denied(await f.call(requirements));
  for (const extra of [{limit: 0}, {limit: 101}, {account_id: 'BAD ACCOUNT'}])
    denied(await f.call({entity: 'campaign'}, extra));
  assert.equal(f.requests.length, 0);
  f.edit((u, d) => (u.pathname.endsWith('/campaigns') ? {...d, data: [], next_cursor: null} : d));
  const empty = ok(await f.call());
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.has_more, false);
});

test('X signed traversal stops at 100 pages with distinct tokens and never exceeds one native list per page', async t => {
  const f = fixture(t);
  f.edit((u, d) => {
    if (u.pathname.endsWith('/campaigns')) {
      const page = Number((u.searchParams.get('cursor') ?? 'n1').slice(1));
      d.data = [xPortfolioCampaign('c' + page)];
      d.next_cursor = 'n' + (page + 1);
    }
    return d;
  });
  let cursor;
  for (let page = 1; page <= 100; page++) {
    const result = await f.call({entity: 'campaign'}, cursor ? {cursor} : {});
    if (page < 100) cursor = ok(result).next_cursor;
    else assert.equal(denied(result), 'PORTFOLIO_INCOMPLETE');
  }
  assert.equal(f.requests.length, 200);
});
