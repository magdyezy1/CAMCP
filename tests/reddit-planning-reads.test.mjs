// PRV-07 C: Reddit planning and history reads from the pinned v3 OpenAPI. Each is a bounded POST read under adsread;
// account-named reads stay inside the selected account, account-agnostic suggestions take no account-owned
// references, and account history never returns who made a change (personal data).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {redditReadActions} from '../dist/src/reddit-extensions.js';

const duration = {start_time: '2026-11-01T00:00:00Z', end_time: '2026-11-08T00:00:00Z'};
const gateway = 'reddit_native_action',
  connection = '11111111-1111-4111-8111-11111111111a';
const estimate = {
  data: {
    total_audience_size: 1200000,
    target_audience_range: {min: 100000, max: 150000},
    delivery_estimates: {impressions: {min: 1000, max: 5000}, clicks: {min: 10, max: 60}},
  },
};
const history = (next = null) => ({
  data: [
    {
      cause: {
        member_id: 't2_person',
        reddit_username: 'synthetic_person',
        email: 'person@example.test',
        fullname: 'Synthetic Person',
        partner_business_name: 'Agency Partner',
        changed_at: '2026-10-05T03:00:00Z',
      },
      change: {
        entity_id: '42',
        entity_name: 'Campaign A',
        entity_type: 'CAMPAIGN',
        field_name: 'configured_status',
        before_value: 'ACTIVE',
        after_value: 'PAUSED',
      },
    },
    {cause: {changed_at: '2026-10-04T03:00:00Z'}, change: {entity_id: '43', entity_type: 'AD', field_name: 'name'}},
  ],
  pagination: {next_url: next},
});
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64'));
  t.after(() => store.close());
  const key = store.createKey({tenantId: 'reddit-planning', userId: 'reader', role: 'reader'}),
    actor = store.authenticate(key);
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['t2_allowed'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic Reddit reader',
      scopes: ['adsread'],
      userAgent: 'server:amcp-mirror-test:0.1.0 (local mock)',
    },
    {accessToken: 'synthetic'},
  );
  const requests = [];
  let respond = url => {
    if (url.pathname.endsWith('/audience_and_delivery_estimates')) return estimate;
    if (url.pathname === '/api/v3/forecasting/bid_suggestions')
      return {data: {min_bid_value: 100, bid_suggestion_median: 250, bid_suggestion_min: 150, bid_suggestion_max: 400}};
    if (url.pathname === '/api/v3/targeting/keyword_suggestions')
      return {data: {keyword_suggestions: [{keyword: 'running shoes', monthly_views: 123435387}]}};
    if (url.pathname.endsWith('/history')) return history();
    throw Error('Unexpected ' + url.pathname);
  };
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(String(raw));
      requests.push({url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null});
      return Response.json(respond(url));
    }),
    undefined,
    {allowWrites: false},
  );
  const read = (action, args = {}, outer = {}) =>
    service.call(
      gateway,
      {operation: 'reddit_account_ops', arguments: {action, connection_id: connection, ...args}, ...outer},
      actor,
    );
  return {store, requests, read, respond: fn => (respond = fn)};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('the four reads are listed as native reads of reddit_account_ops in the action ledger', () => {
  assert.deepEqual(redditReadActions, [
    'GET_DELIVERY_ESTIMATES',
    'GET_BID_SUGGESTIONS',
    'GET_ACCOUNT_HISTORY',
    'LIST_KEYWORD_SUGGESTIONS',
  ]);
  const rows = actionContracts(new Registry()).filter(
    r => r.gateway === gateway && redditReadActions.includes(r.action),
  );
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.status, 'native_read', JSON.stringify(row));
});

test('delivery estimates read the selected account path with a schema-checked body', async t => {
  const f = fixture(t),
    payload = {
      data: {
        objective: 'CLICKS',
        ad_group_configs: [{goal_value: 1000, bid_value: 1500000, targeting: {geolocations: ['US']}}],
      },
    },
    out = ok(await f.read('GET_DELIVERY_ESTIMATES', {params: {ad_account_id: 't2_allowed'}, payload}));
  assert.equal(out.data.data.total_audience_size, 1200000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'POST');
  assert.equal(
    f.requests[0].url.pathname,
    '/api/v3/ad_accounts/t2_allowed/forecasting/audience_and_delivery_estimates',
  );
  assert.deepEqual(f.requests[0].body, payload);
  // Another account's path is refused before any request: the login does not hold that account.
  const foreign = await f.read('GET_DELIVERY_ESTIMATES', {params: {ad_account_id: 't2_other'}, payload});
  assert.equal(foreign.error?.code, 'CONNECTION_REQUIRED');
  assert.equal(f.requests.length, 1);
});

test('bid and keyword suggestions run under a bound account and refuse account-owned audience references', async t => {
  const f = fixture(t),
    bid = ok(
      await f.read('GET_BID_SUGGESTIONS', {
        account_id: 't2_allowed',
        payload: {
          data: {ad_account_id: 't2_allowed', duration, bid_type: 'CPC', targeting: {communities: ['running']}},
        },
      }),
    );
  assert.equal(bid.data.data.bid_suggestion_median, 250);
  const keywords = ok(
    await f.read('LIST_KEYWORD_SUGGESTIONS', {account_id: 't2_allowed', payload: {data: {seed_keywords: ['shoes']}}}),
  );
  assert.equal(keywords.data.data.keyword_suggestions[0].monthly_views, 123435387);
  assert.equal(f.requests.length, 2);
  const audience = await f.read('GET_BID_SUGGESTIONS', {
    account_id: 't2_allowed',
    payload: {
      data: {ad_account_id: 't2_allowed', duration, targeting: {custom_audience_ids: ['aud_from_another_account']}},
    },
  });
  assert.equal(audience.success, false);
  assert.equal(audience.error.code, 'ACCOUNT_SCOPE_MISMATCH');
  // An excluded audience is just as account-owned as an included one (it once passed: only custom_audience_ids was
  // checked).
  const excluded = await f.read('GET_BID_SUGGESTIONS', {
    account_id: 't2_allowed',
    payload: {
      data: {
        ad_account_id: 't2_allowed',
        duration,
        targeting: {excluded_custom_audience_ids: ['aud_from_another_account']},
      },
    },
  });
  assert.equal(excluded.success, false);
  assert.equal(excluded.error.code, 'ACCOUNT_SCOPE_MISMATCH');
  assert.match(excluded.error.message, /excluded_custom_audience_ids/);
  // Bid suggestions must name the selected account; another account or none is refused.
  for (const ad_account_id of ['t2_other', undefined]) {
    const r = await f.read('GET_BID_SUGGESTIONS', {
      account_id: 't2_allowed',
      payload: {data: {ad_account_id, duration}},
    });
    assert.equal(r.error?.code, 'ACCOUNT_SCOPE_MISMATCH', String(ad_account_id));
    assert.match(r.error.message, /ad_account_id/);
  }
  const unbound = await f.read('LIST_KEYWORD_SUGGESTIONS', {
    account_id: 't2_other',
    payload: {data: {seed_keywords: ['shoes']}},
  });
  assert.equal(unbound.error?.code, 'CONNECTION_REQUIRED');
  const malformed = await f.read('LIST_KEYWORD_SUGGESTIONS', {account_id: 't2_allowed', payload: {data: {}}});
  // An empty request does not satisfy the pinned Reddit schema: it is refused before any request.
  assert.equal(malformed.error?.code, 'INVALID_VENDOR_BODY');
  assert.equal(f.requests.length, 2);
});

test('account history keeps each change and its time but never who made it', async t => {
  const f = fixture(t),
    out = ok(
      await f.read('GET_ACCOUNT_HISTORY', {
        params: {ad_account_id: 't2_allowed'},
        payload: {data: {start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-08T00:00:00Z'}},
      }),
    );
  const text = JSON.stringify(out);
  for (const personal of ['person@example.test', 'synthetic_person', 'Synthetic Person', 't2_person'])
    assert.equal(text.includes(personal), false, personal);
  assert.deepEqual(out.data.data[0].cause, {
    changed_at: '2026-10-05T03:00:00Z',
    partner_business_name: 'Agency Partner',
    changed_by: 'member_not_shown',
  });
  assert.equal(out.data.data[1].cause.changed_by, 'not_reported');
  assert.equal(out.data.data[0].change.after_value, 'PAUSED');
  assert.deepEqual(out.data.personal_data, {member_identity: 'removed'});
  // The audit keeps a digest of the projected response, never the people.
  const audit = f.store.db.prepare('SELECT event FROM audit').all();
  assert.equal(
    audit.some(a => a.event.includes('person@example.test')),
    false,
  );
  const foreign = await f.read('GET_ACCOUNT_HISTORY', {params: {ad_account_id: 't2_other'}, payload: {data: {}}});
  assert.equal(foreign.success, false);
  assert.equal(f.requests.length, 1);
  // A member filter would say who made the listed changes, so it is refused before any request.
  for (const member_ids of [['t2_person'], []]) {
    const byMember = await f.read('GET_ACCOUNT_HISTORY', {
      params: {ad_account_id: 't2_allowed'},
      payload: {data: {member_ids}},
    });
    assert.equal(byMember.success, false);
    assert.equal(byMember.error.code, 'PERSONAL_DATA_READ_FORBIDDEN');
  }
  assert.equal(f.requests.length, 1);
});

test('account history pages are bounded by page.size and every page stays projected', async t => {
  const f = fixture(t);
  f.respond(url =>
    url.searchParams.get('page.token')
      ? history()
      : history('https://ads-api.reddit.com/api/v3/ad_accounts/t2_allowed/history?page.size=2&page.token=next'),
  );
  const first = ok(
    await f.read('GET_ACCOUNT_HISTORY', {params: {ad_account_id: 't2_allowed', 'page.size': 2}, payload: {data: {}}}),
  );
  assert.equal(f.requests[0].url.searchParams.get('page.size'), '2');
  const second = ok(
    await f.read('GET_ACCOUNT_HISTORY', {
      params: {ad_account_id: 't2_allowed', 'page.size': 2, 'page.token': 'next'},
      payload: {data: {}},
    }),
  );
  assert.equal(f.requests[1].url.searchParams.get('page.token'), 'next');
  for (const out of [first, second]) assert.equal(JSON.stringify(out).includes('person@example.test'), false);
  // The pinned schema caps a page at 1,000 changes.
  const oversized = await f.read('GET_ACCOUNT_HISTORY', {
    params: {ad_account_id: 't2_allowed', 'page.size': 1001},
    payload: {data: {}},
  });
  assert.equal(oversized.error?.code, 'INVALID_PARAMETER');
  assert.match(oversized.error.message, /page.size/);
  assert.equal(f.requests.length, 2);
});
