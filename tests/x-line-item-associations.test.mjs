import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Promoted accounts, media creatives and scheduled promoted Tweets of X Ads line items, Ads API v12 (Campaign Management
 * reference; checked 2026-09-27).
 */
const registry = new Registry(),
  gateway = 'x_ads_native_action',
  account = 'acct1';
const actor = {tenantId: 'x-associations', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const secret = {
  accessToken: 'synthetic-token',
  consumerKey: 'synthetic-key',
  consumerSecret: 'synthetic-secret',
  tokenSecret: 'synthetic-token-secret',
};
const actions = {
  promote: 'x_accounts_account_id_promoted_accounts_post',
  unpromote: 'x_accounts_account_id_promoted_accounts_promoted_account_id_delete',
  media: 'x_accounts_account_id_media_creatives_post',
  unmedia: 'x_accounts_account_id_media_creatives_media_creative_id_delete',
  schedule: 'x_accounts_account_id_scheduled_promoted_tweets_post',
  unschedule: 'x_accounts_account_id_scheduled_promoted_tweets_scheduled_promoted_tweet_id_delete',
};
const copy = x => structuredClone(x);
function setup(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 97).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'x',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    secret,
  );
  const lines = {
    follow: {
      id: 'follow',
      campaign_id: 'camp1',
      product_type: 'PROMOTED_ACCOUNT',
      objective: 'FOLLOWERS',
      entity_status: 'ACTIVE',
      deleted: false,
    },
    video: {
      id: 'video',
      campaign_id: 'camp1',
      product_type: 'MEDIA',
      objective: 'PREROLL_VIEWS',
      entity_status: 'PAUSED',
      deleted: false,
    },
    clicks: {
      id: 'clicks',
      campaign_id: 'camp1',
      product_type: 'MEDIA',
      objective: 'WEBSITE_CLICKS',
      entity_status: 'PAUSED',
      deleted: false,
    },
    gone: {
      id: 'gone',
      campaign_id: 'camp1',
      product_type: 'PROMOTED_ACCOUNT',
      objective: 'FOLLOWERS',
      entity_status: 'PAUSED',
      deleted: true,
    },
    tweets: {
      id: 'tweets',
      campaign_id: 'camp1',
      product_type: 'PROMOTED_TWEETS',
      objective: 'ENGAGEMENTS',
      entity_status: 'PAUSED',
      deleted: false,
    },
  };
  const campaigns = {camp1: {id: 'camp1', entity_status: 'ACTIVE', deleted: false}};
  const users = [
    {user_id: '756201191646691328', promotable_user_type: 'FULL'},
    {user_id: '12345', promotable_user_type: 'FULL'},
  ];
  const media = {
    m1: {id: 'm1', creative_type: 'PREROLL', deleted: false},
    m2: {id: 'm2', creative_type: 'BANNER', deleted: false},
    m3: {id: 'm3', creative_type: 'PREROLL', deleted: true},
  };
  const scheduled = {
    '870358555227860992': {
      id: '870358555227860992',
      scheduled_at: '2030-01-01T09:00:00Z',
      completed_at: null,
      scheduled_status: 'SCHEDULED',
    },
    '870358555227860993': {
      id: '870358555227860993',
      scheduled_at: '2030-01-02T09:00:00Z',
      completed_at: null,
      scheduled_status: 'SCHEDULED',
    },
    '870358555227860994': {
      id: '870358555227860994',
      scheduled_at: '2026-01-01T09:00:00Z',
      completed_at: '2026-01-01T09:00:03Z',
      scheduled_status: 'SUCCESS',
    },
  };
  const rows = {
    promoted_accounts: {
      pa1: {id: 'pa1', line_item_id: 'follow', user_id: '12345', entity_status: 'ACTIVE', deleted: false},
    },
    media_creatives: {
      mc1: {
        id: 'mc1',
        line_item_id: 'video',
        account_media_id: 'm1',
        creative_type: 'PREROLL',
        entity_status: 'ACTIVE',
        deleted: false,
      },
    },
    scheduled_promoted_tweets: {
      spt1: {
        id: 'spt1',
        line_item_id: 'tweets',
        scheduled_tweet_id: '870358555227860993',
        tweet_id: null,
        deleted: false,
      },
    },
  };
  const calls = [];
  let writes = 0,
    next = 5;
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      method = init?.method ?? 'GET',
      suffix = u.pathname.replace('/12/accounts/' + account, '');
    calls.push({method, path: u.pathname, query: Object.fromEntries(u.searchParams)});
    const reply = data =>
      Response.json({
        data: copy(data),
        request: {params: {account_id: account, ...Object.fromEntries(u.searchParams)}},
        ...(Array.isArray(data) ? {next_cursor: null} : {}),
      });
    const missing = () =>
      Response.json({errors: [{code: 'NOT_FOUND', message: 'Not found'}], request: {params: {}}}, {status: 404});
    if (method === 'GET') {
      if (!suffix) return reply({id: account, name: 'Account', deleted: false});
      if (suffix === '/promotable_users') return reply(users);
      let m = /^\/(line_items|campaigns|account_media|scheduled_tweets)\/(\w+)$/.exec(suffix);
      if (m) {
        const src = {line_items: lines, campaigns, account_media: media, scheduled_tweets: scheduled}[m[1]];
        return src[m[2]] ? reply(src[m[2]]) : missing();
      }
      m = /^\/(promoted_accounts|media_creatives|scheduled_promoted_tweets)(?:\/(\w+))?$/.exec(suffix);
      if (m && m[2]) return rows[m[1]][m[2]] ? reply(rows[m[1]][m[2]]) : missing();
      if (m)
        return reply(
          Object.values(rows[m[1]]).filter(
            r => u.searchParams.get('line_item_ids').split(',').includes(r.line_item_id) && !r.deleted,
          ),
        );
      return missing();
    }
    writes++;
    const form = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    let m = /^\/(promoted_accounts|media_creatives|scheduled_promoted_tweets)$/.exec(suffix);
    if (method === 'POST' && m) {
      const id = 'new' + next++,
        row = {
          id,
          ...form,
          ...(m[1] === 'media_creatives' ? {creative_type: media[form.account_media_id]?.creative_type} : {}),
          entity_status: 'ACTIVE',
          deleted: false,
        };
      if (mode !== 'ignore') rows[m[1]][id] = row;
      return reply(mode === 'other' ? {...row, line_item_id: 'other'} : row);
    }
    m = /^\/(promoted_accounts|media_creatives|scheduled_promoted_tweets)\/(\w+)$/.exec(suffix);
    if (method === 'DELETE' && m) {
      const row = {...rows[m[1]][m[2]], deleted: true};
      if (mode !== 'ignore') rows[m[1]][m[2]] = row;
      return reply(row);
    }
    throw Error('Unexpected write ' + method + ' ' + suffix);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (action, payload, params = {}) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: account, params, ...(payload ? {payload} : {})}},
      actor,
    );
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, rows, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a user is promoted once after spending confirmation and verifies; removing the promotion verifies too', async () => {
  const x = setup();
  try {
    const p = ok(await x.prepare(actions.promote, {line_item_id: 'follow', user_id: '756201191646691328'})),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'promoted_accounts');
    assert.equal(impact.may_affect_serving, true);
    assert.match(impact.effect, /serves at once/);
    assert.equal((await x.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await x.execute(p, {spend_change_confirmed: true}));
    assert.equal(x.writes(), 1);
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    assert.equal((await x.execute(p, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(x.writes(), 1);
    const d = ok(await x.prepare(actions.unpromote, undefined, {promoted_account_id: 'pa1'}));
    ok(await x.execute(d));
    assert.equal(x.rows.promoted_accounts.pa1.deleted, true);
    assert.equal(ok(await x.verify(d)).data.status, 'verified');
  } finally {
    x.store.close();
  }
});

test('preroll and banner media creatives follow the landing URL rules, are created once and verify; owner policy treats them as activation', async () => {
  const x = setup();
  try {
    const p = ok(
      await x.prepare(actions.media, {
        line_item_id: 'clicks',
        account_media_id: 'm2',
        landing_url: 'https://example.com/offer',
      }),
    );
    assert.equal(p.data.creative_impact.after.creativeType, 'BANNER');
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    ok(await x.execute(p, {spend_change_confirmed: true}));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    assert.match(
      (await x.prepare(actions.media, {line_item_id: 'clicks', account_media_id: 'm2'})).error?.message ?? '',
      /needs a landing_url|already a media creative/,
    );
    assert.match(
      (
        await x.prepare(actions.media, {
          line_item_id: 'video',
          account_media_id: 'm1',
          landing_url: 'https://example.com',
        })
      ).error?.message ?? '',
      /preroll call to action/,
    );
    saveSpendPolicy(x.store, admin, {gateway, account_id: account, confirmed: true, policy: {allow_activation: false}});
    assert.equal(
      (await x.prepare(actions.media, {line_item_id: 'clicks', account_media_id: 'm1'})).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
  } finally {
    x.store.close();
  }
});

test('a scheduled Tweet is promoted once after confirmation and verifies; published, already promoted and unknown scheduled Tweets and media line items are refused', async () => {
  const x = setup();
  try {
    const p = ok(await x.prepare(actions.schedule, {line_item_id: 'tweets', scheduled_tweet_id: '870358555227860992'})),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'scheduled_promoted_tweets');
    assert.equal(impact.after.scheduledAt, '2030-01-01T09:00:00Z');
    assert.match(impact.effect, /once it is published/);
    assert.equal((await x.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await x.execute(p, {spend_change_confirmed: true}));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    assert.equal(
      (await x.prepare(actions.schedule, {line_item_id: 'tweets', scheduled_tweet_id: '870358555227860993'})).error
        ?.code,
      'CONFIGURATION_EXISTS',
    );
    assert.match(
      (await x.prepare(actions.schedule, {line_item_id: 'tweets', scheduled_tweet_id: '870358555227860994'})).error
        ?.message ?? '',
      /already published/,
    );
    assert.match(
      (await x.prepare(actions.schedule, {line_item_id: 'video', scheduled_tweet_id: '870358555227860993'})).error
        ?.message ?? '',
      /PROMOTED_TWEETS or PROMOTED_ACCOUNT/,
    );
    assert.equal(
      (await x.prepare(actions.schedule, {line_item_id: 'tweets', scheduled_tweet_id: '999'})).success,
      false,
    );
    const d = ok(await x.prepare(actions.unschedule, undefined, {scheduled_promoted_tweet_id: 'spt1'}));
    ok(await x.execute(d));
    assert.equal(x.rows.scheduled_promoted_tweets.spt1.deleted, true);
    assert.equal(ok(await x.verify(d)).data.status, 'verified');
  } finally {
    x.store.close();
  }
});

test('malformed associations are refused before any request', async () => {
  const cases = [
    // Unsafe JSON numbers are refused by the compiler before the family sees them.
    [
      'numeric user as number',
      actions.promote,
      {line_item_id: 'follow', user_id: 756201191646691328},
      'UNSAFE_NUMERIC_ID',
    ],
    ['screen name', actions.promote, {line_item_id: 'follow', user_id: '@example'}],
    ['missing line item', actions.promote, {user_id: '12345'}],
    ['unknown promoted field', actions.promote, {line_item_id: 'follow', user_id: '12345', entity_status: 'PAUSED'}],
    ['missing media', actions.media, {line_item_id: 'video'}],
    ['relative landing URL', actions.media, {line_item_id: 'clicks', account_media_id: 'm2', landing_url: '/offer'}],
    [
      'landing URL with spaces',
      actions.media,
      {line_item_id: 'clicks', account_media_id: 'm2', landing_url: 'https://example.com/a b'},
    ],
    ['unknown media field', actions.media, {line_item_id: 'video', account_media_id: 'm1', creative_type: 'PREROLL'}],
    [
      'scheduled Tweet as number',
      actions.schedule,
      {line_item_id: 'tweets', scheduled_tweet_id: 870358555227860992},
      'UNSAFE_NUMERIC_ID',
    ],
    [
      'scheduled Tweet with text',
      actions.schedule,
      {line_item_id: 'tweets', scheduled_tweet_id: '870358555227860992', text: 'Hello'},
    ],
  ];
  for (const [label, action, payload, code = 'INVALID_X_LINE_ITEM_ASSOCIATION'] of cases) {
    const x = setup();
    try {
      const r = await x.prepare(action, payload);
      assert.equal(r.error?.code, code, label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(x.calls.length, 0, label);
    } finally {
      x.store.close();
    }
  }
});

test('incompatible, deleted or unknown line items, users and media, and duplicates are refused after reading, without writes', async () => {
  const x = setup();
  try {
    assert.match(
      (await x.prepare(actions.promote, {line_item_id: 'video', user_id: '12345'})).error?.message ?? '',
      /PROMOTED_ACCOUNT line item/,
    );
    assert.match(
      (await x.prepare(actions.promote, {line_item_id: 'gone', user_id: '12345'})).error?.message ?? '',
      /deleted/,
    );
    assert.match(
      (await x.prepare(actions.promote, {line_item_id: 'follow', user_id: '999'})).error?.message ?? '',
      /not a promotable user/,
    );
    assert.equal(
      (await x.prepare(actions.promote, {line_item_id: 'follow', user_id: '12345'})).error?.code,
      'CONFIGURATION_EXISTS',
    );
    assert.equal(
      (await x.prepare(actions.media, {line_item_id: 'video', account_media_id: 'm1'})).error?.code,
      'CONFIGURATION_EXISTS',
    );
    assert.match(
      (await x.prepare(actions.media, {line_item_id: 'video', account_media_id: 'm3'})).error?.message ?? '',
      /deleted/,
    );
    assert.equal((await x.prepare(actions.media, {line_item_id: 'video', account_media_id: 'm9'})).success, false);
    assert.equal((await x.prepare(actions.unmedia, undefined, {media_creative_id: 'mc9'})).success, false);
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('a receipt for another line item is a failure that is never resubmitted, and an ignored deletion is not verified; the ledger lists the six writes', async () => {
  const other = setup('other');
  try {
    const p = ok(await other.prepare(actions.promote, {line_item_id: 'follow', user_id: '756201191646691328'}));
    assert.equal((await other.execute(p, {spend_change_confirmed: true})).success, false);
    assert.equal((await other.execute(p, {spend_change_confirmed: true})).success, false);
    assert.equal(other.writes(), 1);
  } finally {
    other.store.close();
  }
  const ignored = setup('ignore');
  try {
    const p = ok(await ignored.prepare(actions.unmedia, undefined, {media_creative_id: 'mc1'}));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'x_line_item_associations', action);
  }
});
