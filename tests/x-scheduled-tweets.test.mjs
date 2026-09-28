import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Scheduled Tweets of an X Ads account, Ads API v12 (Creatives reference and guide, "Scheduled Tweets"; checked
 * 2026-09-27).
 */
const registry = new Registry(),
  gateway = 'x_ads_native_action',
  account = 'acct1',
  author = '12345';
const actor = {tenantId: 'x-scheduled-tweets', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const secret = {
  accessToken: 'synthetic-token',
  consumerKey: 'synthetic-key',
  consumerSecret: 'synthetic-secret',
  tokenSecret: 'synthetic-token-secret',
};
const actions = {
  create: 'x_accounts_account_id_scheduled_tweets_post',
  update: 'x_accounts_account_id_scheduled_tweets_scheduled_tweet_id_put',
  remove: 'x_accounts_account_id_scheduled_tweets_scheduled_tweet_id_delete',
};
const copy = x => structuredClone(x);
const later = (days = 3) => new Date(Date.now() + days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
function setup(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 96).toString('base64'));
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
  const users = [
    {user_id: author, promotable_user_type: 'FULL', deleted: false},
    {user_id: '777', promotable_user_type: 'RETWEETS_ONLY', deleted: false},
  ];
  const library = {
    '3_100': {media_key: '3_100', media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', deleted: false},
    '3_101': {media_key: '3_101', media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', deleted: false},
    '13_200': {media_key: '13_200', media_type: 'VIDEO', media_status: 'TRANSCODE_COMPLETED', deleted: false},
    '13_201': {media_key: '13_201', media_type: 'VIDEO', media_status: 'TRANSCODING', deleted: false},
  };
  const cards = {
    'card://111': {card_uri: 'card://111', id: 'c1', deleted: false},
    'card://222': {card_uri: 'card://222', id: 'c2', deleted: true},
  };
  const tweets = {
    '900000000000000001': {
      id: '900000000000000001',
      id_str: '900000000000000001',
      user_id: author,
      text: 'Spring launch',
      card_uri: null,
      media_keys: [],
      nullcast: true,
      scheduled_at: later(5),
      scheduled_status: 'SCHEDULED',
      tweet_id: null,
      completed_at: null,
    },
    '900000000000000002': {
      id: '900000000000000002',
      id_str: '900000000000000002',
      user_id: author,
      text: 'Out now',
      card_uri: 'card://111',
      media_keys: [],
      nullcast: true,
      scheduled_at: '2026-01-01T09:00:00Z',
      scheduled_status: 'SCHEDULED',
      tweet_id: '1500000000000000001',
      completed_at: '2026-01-01T09:00:02Z',
    },
    '900000000000000003': {
      id: '900000000000000003',
      id_str: '900000000000000003',
      user_id: author,
      text: 'Soon',
      card_uri: null,
      media_keys: [],
      nullcast: true,
      scheduled_at: new Date(Date.now() + 4 * 60000).toISOString(),
      scheduled_status: 'SCHEDULED',
      tweet_id: null,
      completed_at: null,
    },
  };
  const promotions = [{id: 'spt1', line_item_id: 'line1', scheduled_tweet_id: '900000000000000001', deleted: false}];
  const calls = [];
  let writes = 0,
    next = 10;
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      method = init?.method ?? 'GET',
      suffix = u.pathname.replace('/12/accounts/' + account, '');
    calls.push({method, path: u.pathname, query: Object.fromEntries(u.searchParams)});
    const reply = data =>
      Response.json({
        data: copy(data),
        request: {params: {account_id: account}},
        ...(Array.isArray(data) ? {next_cursor: null} : {}),
      });
    const missing = () =>
      Response.json({errors: [{code: 'NOT_FOUND', message: 'Not found'}], request: {params: {}}}, {status: 404});
    if (method === 'GET') {
      if (!suffix) return reply({id: account, name: 'Account', deleted: false});
      if (suffix === '/promotable_users') return reply(users);
      if (suffix === '/cards/all')
        return reply(
          u.searchParams
            .get('card_uris')
            .split(',')
            .map(c => cards[c])
            .filter(Boolean),
        );
      if (suffix === '/scheduled_promoted_tweets') return reply(promotions);
      let m = /^\/media_library\/(\w+)$/.exec(suffix);
      if (m) return library[m[1]] ? reply(library[m[1]]) : missing();
      m = /^\/scheduled_tweets\/(\d+)$/.exec(suffix);
      if (m) return tweets[m[1]] ? reply(tweets[m[1]]) : missing();
      return missing();
    }
    writes++;
    const form = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    const shaped = f => {
      const row = {...f};
      if ('media_keys' in row) row.media_keys = row.media_keys ? row.media_keys.split(',') : [];
      if ('nullcast' in row) row.nullcast = row.nullcast !== 'false';
      if (row.card_uri === '') row.card_uri = null;
      return row;
    };
    if (method === 'POST' && suffix === '/scheduled_tweets') {
      const id = String(900000000000000000n + BigInt(next++)),
        {as_user_id, ...rest} = shaped(form),
        row = {
          id,
          id_str: id,
          user_id: as_user_id,
          text: '',
          card_uri: null,
          media_keys: [],
          nullcast: true,
          ...rest,
          scheduled_status: 'SCHEDULED',
          tweet_id: null,
          completed_at: null,
        };
      if (mode !== 'ignore') tweets[id] = row;
      return reply(mode === 'other' ? {...row, user_id: '777'} : row);
    }
    const m = /^\/scheduled_tweets\/(\d+)$/.exec(suffix);
    if (method === 'PUT' && m) {
      const row = {...tweets[m[1]], ...shaped(form)};
      if (mode !== 'ignore') tweets[m[1]] = row;
      return reply(row);
    }
    if (method === 'DELETE' && m) {
      const row = tweets[m[1]];
      if (mode !== 'ignore') delete tweets[m[1]];
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
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, tweets, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const tweet = (extra = {}) => ({
  as_user_id: author,
  scheduled_at: later(),
  text: 'New collection, Friday 9am',
  ...extra,
});
const id1 = '900000000000000001';

test('a promoted-only Tweet with a card and one with images are scheduled and verify; its text and media change; a replay sends nothing', async () => {
  const x = setup();
  try {
    const p = ok(await x.prepare(actions.create, tweet({card_uri: 'card://111'})));
    assert.equal(p.data.creative_impact.scope, 'scheduled_tweet');
    assert.match(p.data.creative_impact.effect, /promoted-only Tweet/);
    ok(await x.execute(p));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    assert.equal((await x.execute(p)).data.replayed, true);
    assert.equal(x.writes(), 1);
    const q = ok(await x.prepare(actions.create, tweet({text: '', media_keys: '3_100,3_101', nullcast: true})));
    ok(await x.execute(q));
    assert.equal(ok(await x.verify(q)).data.status, 'verified');
    const u = ok(
      await x.prepare(
        actions.update,
        {text: 'Spring launch, now with video', media_keys: '13_200'},
        {scheduled_tweet_id: id1},
      ),
    );
    ok(await x.execute(u));
    assert.deepEqual(x.tweets[id1].media_keys, ['13_200']);
    assert.equal(ok(await x.verify(u)).data.status, 'verified');
  } finally {
    x.store.close();
  }
});

test('a scheduled Tweet is deleted and verifies gone; the review names the line items that promote it; owner deletion rules apply', async () => {
  const x = setup();
  try {
    const d = ok(await x.prepare(actions.remove, undefined, {scheduled_tweet_id: id1}));
    assert.deepEqual(d.data.creative_impact.promoted_in_line_items, ['line1']);
    assert.equal(d.data.creative_impact.may_affect_serving, true);
    ok(await x.execute(d));
    assert.equal(x.tweets[id1], undefined);
    assert.equal(ok(await x.verify(d)).data.status, 'verified');
  } finally {
    x.store.close();
  }
  const owner = setup();
  try {
    saveSpendPolicy(owner.store, admin, {
      gateway,
      account_id: account,
      confirmed: true,
      policy: {allow_deletion: false},
    });
    assert.equal(
      (await owner.prepare(actions.remove, undefined, {scheduled_tweet_id: id1})).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    ok(await owner.prepare(actions.create, tweet()));
  } finally {
    owner.store.close();
  }
});

test('malformed scheduled Tweets are refused before any request', async () => {
  const cases = [
    ['organic', actions.create, tweet({nullcast: false})],
    ['past time', actions.create, tweet({scheduled_at: '2020-01-01T09:00:00Z'})],
    ['too soon', actions.create, tweet({scheduled_at: new Date(Date.now() + 6 * 60000).toISOString()})],
    ['local time', actions.create, tweet({scheduled_at: '2030-01-01T09:00:00+02:00'})],
    ['no text or media', actions.create, tweet({text: ''})],
    ['long text', actions.create, tweet({text: 'x'.repeat(281)})],
    ['card and media', actions.create, tweet({card_uri: 'card://111', media_keys: '3_100'})],
    ['five images', actions.create, tweet({media_keys: '3_1,3_2,3_3,3_4,3_5'})],
    ['repeated media', actions.create, tweet({media_keys: '3_100,3_100'})],
    ['media array', actions.create, tweet({media_keys: ['3_100']})],
    ['card form', actions.create, tweet({card_uri: '111'})],
    ['author', actions.create, tweet({as_user_id: '@brand'})],
    ['unknown field', actions.create, tweet({name: 'Launch'})],
    ['reschedule', actions.update, {scheduled_at: later(9)}],
    ['empty update', actions.update, {}],
  ];
  for (const [label, action, payload] of cases) {
    const x = setup();
    try {
      const r = await x.prepare(action, payload, action === actions.update ? {scheduled_tweet_id: id1} : {});
      assert.equal(r.error?.code, 'INVALID_X_SCHEDULED_TWEET', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(x.calls.length, 0, label);
    } finally {
      x.store.close();
    }
  }
});

test('published, imminent and unknown Tweets, other authors, unusable cards and media and unchanged values are refused after reading, without writes', async () => {
  const x = setup();
  try {
    assert.match(
      (await x.prepare(actions.update, {text: 'Late'}, {scheduled_tweet_id: '900000000000000002'})).error?.message ??
        '',
      /already published/,
    );
    assert.match(
      (await x.prepare(actions.remove, undefined, {scheduled_tweet_id: '900000000000000002'})).error?.message ?? '',
      /already published/,
    );
    assert.match(
      (await x.prepare(actions.update, {text: 'Late'}, {scheduled_tweet_id: '900000000000000003'})).error?.message ??
        '',
      /within 10 minutes/,
    );
    assert.equal(
      (await x.prepare(actions.remove, undefined, {scheduled_tweet_id: '900000000000000099'})).error?.code,
      'STATE_NOT_FOUND',
    );
    assert.match(
      (await x.prepare(actions.create, tweet({as_user_id: '777'}))).error?.message ?? '',
      /FULL promotable user/,
    );
    assert.match(
      (await x.prepare(actions.create, tweet({card_uri: 'card://222'}))).error?.message ?? '',
      /not an available card/,
    );
    assert.match(
      (await x.prepare(actions.create, tweet({media_keys: '13_201'}))).error?.message ?? '',
      /not ready media/,
    );
    assert.match(
      (await x.prepare(actions.create, tweet({media_keys: '3_100,13_200'}))).error?.message ?? '',
      /one GIF or one video/,
    );
    assert.match(
      (await x.prepare(actions.update, {text: 'Spring launch'}, {scheduled_tweet_id: id1})).error?.message ?? '',
      /already has these values/,
    );
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('a receipt for another author is never resubmitted, an ignored change is not verified, and the ledger lists the three writes', async () => {
  const other = setup('other');
  try {
    const p = ok(await other.prepare(actions.create, tweet()));
    assert.equal((await other.execute(p)).success, false);
    assert.equal((await other.execute(p)).success, false);
    assert.equal(other.writes(), 1);
  } finally {
    other.store.close();
  }
  const ignored = setup('ignore');
  try {
    for (const p of [
      ok(await ignored.prepare(actions.update, {text: 'Changed'}, {scheduled_tweet_id: id1})),
      ok(await ignored.prepare(actions.remove, undefined, {scheduled_tweet_id: id1})),
    ]) {
      ok(await ignored.execute(p));
      assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
    }
  } finally {
    ignored.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'x_scheduled_tweets', action);
  }
});
