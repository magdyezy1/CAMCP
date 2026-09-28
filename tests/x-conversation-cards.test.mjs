import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * X poll, image conversation and video conversation cards, Ads API v12 (Creatives reference; checked 2026-09-27).
 */
const registry = new Registry(),
  gateway = 'x_ads_native_action',
  account = 'acct1';
const actor = {tenantId: 'x-conversation-cards', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const secret = {
  accessToken: 'synthetic-token',
  consumerKey: 'synthetic-key',
  consumerSecret: 'synthetic-secret',
  tokenSecret: 'synthetic-token-secret',
};
const actions = {
  poll: 'x_accounts_account_id_cards_poll_post',
  image: 'x_accounts_account_id_cards_image_conversation_post',
  video: 'x_accounts_account_id_cards_video_conversation_post',
};
const copy = x => structuredClone(x);
function setup(mode = '', features = ['PROMOTED_MEDIA_POLLS']) {
  const store = new Store(':memory:', Buffer.alloc(32, 99).toString('base64'));
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
  const ready = (media_key, media_type) => ({
    media_key,
    media_type,
    media_status: 'TRANSCODE_COMPLETED',
    deleted: false,
  });
  const library = {
    '3_100': ready('3_100', 'IMAGE'),
    '3_101': ready('3_101', 'IMAGE'),
    '13_200': ready('13_200', 'VIDEO'),
    '13_201': {...ready('13_201', 'VIDEO'), media_status: 'TRANSCODING'},
    '3_102': {...ready('3_102', 'IMAGE'), deleted: true},
  };
  const cards = {poll: {}, image_conversation: {}, video_conversation: {}};
  const calls = [];
  let writes = 0,
    next = 1;
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
      if (suffix === '/features') return reply(features);
      let m = /^\/media_library\/(\w+)$/.exec(suffix);
      if (m) return library[m[1]] ? reply(library[m[1]]) : missing();
      m = /^\/cards\/(poll|image_conversation|video_conversation)\/(\w+)$/.exec(suffix);
      if (m) return cards[m[1]][m[2]] ? reply(cards[m[1]][m[2]]) : missing();
      return missing();
    }
    writes++;
    assert.match(
      new Headers(init.headers).get('content-type') ?? '',
      /^application\/x-www-form-urlencoded/,
      'legacy card routes take form parameters',
    );
    const form = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    if (mode === 'error')
      return Response.json(
        {errors: [{code: 'INVALID_PARAMETER', message: 'Invalid media'}], request: {params: {}}},
        {status: 400},
      );
    const m = /^\/cards\/(poll|image_conversation|video_conversation)$/.exec(suffix);
    if (method === 'POST' && m) {
      const id = '5a' + next++,
        {media_key, poster_media_key, unlocked_image_media_key, unlocked_video_media_key, ...rest} = form;
      const row = {
        ...rest,
        ...(m[1] === 'poll' ? {} : {media_key}),
        id,
        card_uri: 'card://95839766501577' + id.length + next,
        deleted: false,
        card_type: m[1].toUpperCase(),
        created_at: '2026-09-27T12:00:00Z',
      };
      if (mode === 'noid') return reply({...row, id: undefined});
      if (mode !== 'ignore') cards[m[1]][id] = mode === 'drift' ? {...row, name: 'Changed by X'} : row;
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
      {action: 'prepare', gateway, arguments: {action, account_id: account, params, payload}},
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, cards, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const poll = (extra = {}) => ({
  name: 'Best coast',
  duration_in_minutes: 10080,
  first_choice: 'East',
  second_choice: 'West',
  ...extra,
});
const imageCard = (extra = {}) => ({
  name: 'Moon card',
  media_key: '3_100',
  first_cta: '#moon',
  first_cta_tweet: 'Stars tonight',
  thank_you_text: 'Thanks',
  title: 'Full moon',
  ...extra,
});
const videoCard = (extra = {}) => ({
  name: 'Launch card',
  media_key: '13_200',
  poster_media_key: '3_101',
  first_cta: '#APIs',
  first_cta_tweet: 'Ads API',
  second_cta: '#Docs',
  second_cta_tweet: 'Reading the docs',
  thank_you_text: 'Build it',
  thank_you_url: 'https://example.com/thanks',
  ...extra,
});

test('a text poll, a media poll and image and video conversation cards are created and verify; a replay sends nothing', async () => {
  const f = setup();
  try {
    const p = ok(await f.prepare(actions.poll, poll({third_choice: 'Neither'})));
    assert.equal(p.data.creative_impact.scope, 'poll_card');
    assert.match(p.data.creative_impact.effect, /opens now/);
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const media = ok(await f.prepare(actions.poll, poll({media_key: '13_200'})));
    assert.ok(
      f.calls.some(c => c.path.endsWith('/features')),
      'a media poll reads the account features',
    );
    ok(await f.execute(media));
    assert.equal(ok(await f.verify(media)).data.status, 'verified');
    const i = ok(await f.prepare(actions.image, imageCard({unlocked_image_media_key: '3_101'})));
    ok(await f.execute(i));
    assert.equal(ok(await f.verify(i)).data.status, 'verified');
    const v = ok(await f.prepare(actions.video, videoCard()));
    assert.equal(v.data.creative_impact.media.length, 2);
    ok(await f.execute(v));
    assert.equal(ok(await f.verify(v)).data.status, 'verified');
    assert.equal(f.writes(), 4);
  } finally {
    f.store.close();
  }
});

test('malformed cards are refused before any request', async () => {
  const cases = [
    ['another account', actions.poll, poll(), {account_id: 'other'}],
    ['one choice', actions.poll, poll({second_choice: undefined})],
    ['a fourth choice without a third', actions.poll, poll({fourth_choice: 'North'})],
    ['a 26-character choice', actions.poll, poll({first_choice: 'x'.repeat(26)})],
    ['equal choices', actions.poll, poll({second_choice: 'east'})],
    ['four minutes', actions.poll, poll({duration_in_minutes: 4})],
    ['a week and a minute', actions.poll, poll({duration_in_minutes: 10081})],
    ['a CTA without #', actions.image, imageCard({first_cta: 'moon'})],
    ['a 21-character hashtag', actions.image, imageCard({first_cta: '#' + 'm'.repeat(21)})],
    ['a CTA without its Tweet', actions.image, imageCard({second_cta: '#sun'})],
    ['a third CTA without a second', actions.image, imageCard({third_cta: '#sky', third_cta_tweet: 'Sky'})],
    ['one CTA and no title', actions.image, imageCard({title: undefined})],
    ['a 24-character thank-you text', actions.image, imageCard({thank_you_text: 'x'.repeat(24)})],
    ['an http thank-you URL', actions.video, videoCard({thank_you_url: 'http://example.com'})],
    ['a malformed media key', actions.video, videoCard({media_key: 'video.mp4'})],
    ['an unqualified field', actions.image, imageCard({entity_status: 'ACTIVE'})],
  ];
  for (const [label, action, payload, params] of cases) {
    const f = setup();
    try {
      const r = await f.prepare(action, JSON.parse(JSON.stringify(payload)), params);
      assert.ok(
        ['INVALID_X_CONVERSATION_CARD', 'ACCOUNT_SCOPE_MISMATCH'].includes(r.error?.code),
        label + ': ' + JSON.stringify(r).slice(0, 300),
      );
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('missing, deleted, unready or wrong media and a media poll without the feature are refused after reading, without writes', async () => {
  const f = setup();
  try {
    assert.equal((await f.prepare(actions.image, imageCard({media_key: '3_999'}))).error?.code, 'STATE_NOT_FOUND');
    assert.equal((await f.prepare(actions.image, imageCard({media_key: '3_102'}))).error?.code, 'STATE_NOT_FOUND');
    assert.equal(
      (await f.prepare(actions.video, videoCard({media_key: '13_201'}))).error?.code,
      'INVALID_X_CONVERSATION_CARD',
    );
    assert.equal(
      (await f.prepare(actions.image, imageCard({media_key: '13_200'}))).error?.code,
      'INVALID_X_CONVERSATION_CARD',
    );
    assert.equal(
      (await f.prepare(actions.video, videoCard({poster_media_key: '13_200'}))).error?.code,
      'INVALID_X_CONVERSATION_CARD',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = setup('', []);
  try {
    assert.equal(
      (await g.prepare(actions.poll, poll({media_key: '3_100'}))).error?.code,
      'INVALID_X_CONVERSATION_CARD',
    );
    ok(await g.prepare(actions.poll, poll()));
  } finally {
    g.store.close();
  }
});

test('an error reply and a receipt without a card are never resubmitted, changed or missing cards are not verified, and the ledger lists the three rows; edits and deletions belong to the card family', async () => {
  for (const mode of ['error', 'noid']) {
    const e = setup(mode);
    try {
      const p = ok(await e.prepare(actions.poll, poll()));
      assert.equal((await e.execute(p)).success, false, mode);
      assert.equal((await e.execute(p)).success, false, mode);
      assert.equal(e.writes(), 1, mode);
    } finally {
      e.store.close();
    }
  }
  for (const mode of ['ignore', 'drift']) {
    const g = setup(mode);
    try {
      const p = ok(await g.prepare(actions.image, imageCard()));
      ok(await g.execute(p));
      assert.notEqual(ok(await g.verify(p)).data.status, 'verified', mode);
    } finally {
      g.store.close();
    }
  }
  const rows = actionContracts(registry).filter(r => r.gateway === gateway);
  for (const action of Object.values(actions)) {
    const row = rows.find(r => r.action === action);
    assert.equal(row?.status, 'reviewed_write_family', action);
    assert.equal(row.family, 'x_conversation_cards', action);
  }
  assert.equal(rows.find(r => r.action === 'x_accounts_account_id_cards_poll_card_id_delete')?.family, 'x_creatives');
});
