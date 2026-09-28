import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Editing image and video conversation cards and deleting poll and conversation cards, X Ads API v12 (Creatives
 * reference; checked 2026-09-27), with the promoted Tweet usage scan of the website card contract.
 */
const registry = new Registry(),
  gateway = 'x_ads_native_action',
  account = 'acct1',
  userId = '9000000000000000001',
  usedTweet = '9000000000000000009';
const actor = {tenantId: 'x-legacy-cards', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const secret = {
  accessToken: 'synthetic-token',
  consumerKey: 'synthetic-key',
  consumerSecret: 'synthetic-secret',
  tokenSecret: 'synthetic-token-secret',
};
const actions = {
  imageEdit: 'x_accounts_account_id_cards_image_conversation_card_id_put',
  imageDelete: 'x_accounts_account_id_cards_image_conversation_card_id_delete',
  videoEdit: 'x_accounts_account_id_cards_video_conversation_card_id_put',
  videoDelete: 'x_accounts_account_id_cards_video_conversation_card_id_delete',
  pollDelete: 'x_accounts_account_id_cards_poll_card_id_delete',
};
const copy = x => structuredClone(x);
function setup(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 100).toString('base64'));
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
    '13_201': ready('13_201', 'VIDEO'),
  };
  const cards = {
    poll: {
      p1: {
        id: 'p1',
        card_uri: 'card://111',
        name: 'Best coast',
        first_choice: 'East',
        second_choice: 'West',
        duration_in_minutes: '1440',
        deleted: false,
        card_type: 'TEXT_POLLS',
      },
    },
    image_conversation: {
      i1: {
        id: 'i1',
        card_uri: 'card://222',
        name: 'Moon card',
        media_key: '3_100',
        first_cta: '#moon',
        first_cta_tweet: 'Stars tonight',
        thank_you_text: 'Thanks',
        title: 'Full moon',
        deleted: false,
        card_type: 'IMAGE_CONVERSATION',
      },
    },
    video_conversation: {
      v1: {
        id: 'v1',
        card_uri: 'card://333',
        name: 'Launch card',
        media_key: '13_200',
        first_cta: '#APIs',
        first_cta_tweet: 'Ads API',
        thank_you_text: 'Build it',
        title: 'Developers',
        deleted: false,
        card_type: 'VIDEO_CONVERSATION',
      },
    },
  };
  const items = [{id: 'line1', campaign_id: 'campaign1', entity_status: 'ACTIVE'}];
  const ads = [{id: 'pt1', line_item_id: 'line1', tweet_id: usedTweet, entity_status: 'ACTIVE', deleted: false}];
  const tweets = {
    [usedTweet]: {
      id_str: usedTweet,
      id: usedTweet,
      full_text: 'Launch day',
      card_uri: 'card://333',
      user: {id_str: userId},
      entities: {urls: []},
    },
  };
  const calls = [];
  let writes = 0;
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      method = init?.method ?? 'GET',
      suffix = u.pathname.replace('/12/accounts/' + account, '');
    calls.push({method, path: u.pathname, query: Object.fromEntries(u.searchParams)});
    const reply = data => Response.json({data: copy(data), request: {params: {account_id: account}}});
    const missing = () =>
      Response.json({errors: [{code: 'NOT_FOUND', message: 'Not found'}], request: {params: {}}}, {status: 404});
    if (method === 'GET') {
      if (!suffix) return reply({id: account, name: 'Account', currency: 'USD'});
      if (suffix === '/promotable_users') return reply([{user_id: userId, promotable_user_type: 'FULL'}]);
      if (suffix === '/line_items') return reply(items);
      if (suffix === '/promoted_tweets')
        return reply(ads.filter(a => !a.deleted && a.line_item_id === u.searchParams.get('line_item_ids')));
      if (suffix === '/tweets') {
        const ids = u.searchParams.get('tweet_ids').split(',');
        return reply(ids.flatMap(id => (tweets[id] ? [tweets[id]] : [])));
      }
      let m = /^\/media_library\/(\w+)$/.exec(suffix);
      if (m) return library[m[1]] ? reply(library[m[1]]) : missing();
      m = /^\/cards\/(poll|image_conversation|video_conversation)\/(\w+)$/.exec(suffix);
      if (m) return cards[m[1]][m[2]] ? reply(cards[m[1]][m[2]]) : missing();
      return missing();
    }
    writes++;
    const m = /^\/cards\/(poll|image_conversation|video_conversation)\/(\w+)$/.exec(suffix);
    if (!m) throw Error('Unexpected write ' + method + ' ' + suffix);
    if (mode === 'error')
      return Response.json(
        {errors: [{code: 'INVALID_PARAMETER', message: 'Card is locked'}], request: {params: {}}},
        {status: 400},
      );
    const card = cards[m[1]][m[2]];
    if (method === 'DELETE') {
      const row = {...card, deleted: true};
      if (mode !== 'ignore') cards[m[1]][m[2]] = row;
      return reply(row);
    }
    assert.match(
      new Headers(init.headers).get('content-type') ?? '',
      /^application\/x-www-form-urlencoded/,
      'conversation card edits take form parameters',
    );
    const form = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    const {poster_media_key, unlocked_image_media_key, unlocked_video_media_key, ...rest} = form,
      row = {...card, ...rest};
    if (mode !== 'ignore') cards[m[1]][m[2]] = row;
    return reply(row);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (action, card_id, payload, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: 'x',
        arguments: {action, account_id: account, params: {card_id}, ...(payload ? {payload} : {})},
        ...extra,
      },
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
  return {store, calls, cards, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('an unused image conversation card is edited and an unused poll deleted; both verify, a replay sends nothing, and owner deletion rules apply', async () => {
  const f = setup();
  try {
    const e = ok(
      await f.prepare(actions.imageEdit, 'i1', {
        thank_you_text: 'Thank you',
        second_cta: '#sun',
        second_cta_tweet: 'Sunrise',
      }),
    );
    assert.deepEqual(e.data.creative_impact.affected_ads, []);
    ok(await f.execute(e));
    assert.equal(f.cards.image_conversation.i1.second_cta, '#sun');
    assert.equal(ok(await f.verify(e)).data.status, 'verified');
    assert.equal((await f.execute(e)).data.replayed, true);
    const d = ok(await f.prepare(actions.pollDelete, 'p1'));
    ok(await f.execute(d));
    assert.equal(f.cards.poll.p1.deleted, true);
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
  const g = setup();
  try {
    saveSpendPolicy(g.store, admin, {gateway, account_id: account, confirmed: true, policy: {allow_deletion: false}});
    assert.equal((await g.prepare(actions.pollDelete, 'p1')).error?.code, 'POLICY_DELETION_FORBIDDEN');
  } finally {
    g.store.close();
  }
});

test('a card that a promoted Tweet uses needs creative_edit_confirmed with the affected ads listed, then is edited and deleted', async () => {
  const f = setup();
  try {
    const blocked = await f.prepare(actions.videoEdit, 'v1', {
      title: 'Developers 2',
      media_key: '13_201',
      poster_media_key: '3_101',
    });
    assert.equal(blocked.error?.code, 'CREATIVE_IN_USE', JSON.stringify(blocked).slice(0, 400));
    assert.equal(blocked.error.details.affected_ads[0].tweet_id, usedTweet);
    const e = ok(
      await f.prepare(
        actions.videoEdit,
        'v1',
        {title: 'Developers 2', media_key: '13_201', poster_media_key: '3_101'},
        {creative_edit_confirmed: true},
      ),
    );
    ok(await f.execute(e, {creative_edit_confirmed: true}));
    assert.equal(f.cards.video_conversation.v1.media_key, '13_201');
    assert.equal(ok(await f.verify(e)).data.status, 'verified');
    assert.equal((await f.prepare(actions.videoDelete, 'v1')).error?.code, 'CREATIVE_IN_USE');
    const d = ok(await f.prepare(actions.videoDelete, 'v1', undefined, {creative_edit_confirmed: true}));
    ok(await f.execute(d, {creative_edit_confirmed: true}));
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('malformed edits are refused before any write; wrong or missing media after reading; poll cards cannot be edited', async () => {
  const cases = [
    ['components on a conversation card', actions.imageEdit, 'i1', {components: []}],
    ['a CTA without #', actions.imageEdit, 'i1', {first_cta: 'moon'}],
    ['a 24-character thank-you text', actions.imageEdit, 'i1', {thank_you_text: 'x'.repeat(24)}],
    ['an http thank-you URL', actions.videoEdit, 'v1', {thank_you_url: 'http://example.com'}],
    ['a poster on an image card', actions.imageEdit, 'i1', {poster_media_key: '3_101'}],
    ['a malformed media key', actions.videoEdit, 'v1', {media_key: 'clip.mp4'}],
    ['nothing to change', actions.imageEdit, 'i1', {}],
    ['a body on a deletion', actions.imageDelete, 'i1', {name: 'x'}],
  ];
  for (const [label, action, id, payload] of cases) {
    const f = setup();
    try {
      const r = await f.prepare(action, id, payload);
      assert.equal(r.error?.code, 'INVALID_X_CREATIVE', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.writes(), 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = setup();
  try {
    assert.equal(
      (await f.prepare(actions.videoEdit, 'v1', {media_key: '3_100'}, {creative_edit_confirmed: true})).error?.code,
      'INVALID_X_CREATIVE',
    );
    assert.equal((await f.prepare(actions.imageEdit, 'i1', {media_key: '3_999'})).success, false);
    assert.equal((await f.prepare(actions.imageEdit, 'zz9', {title: 'x'})).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.gateway === gateway);
  assert.equal(
    rows.some(r => /cards_poll_card_id_put$/.test(r.action)),
    false,
    'X has no poll card edit',
  );
});

test('an error reply is never resubmitted, an ignored edit or deletion is not verified, and the ledger lists the five rows in the card family', async () => {
  const e = setup('error');
  try {
    const p = ok(await e.prepare(actions.imageEdit, 'i1', {title: 'New'}));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = setup('ignore');
  try {
    for (const p of [
      ok(await g.prepare(actions.imageEdit, 'i1', {title: 'New'})),
      ok(await g.prepare(actions.pollDelete, 'p1')),
    ]) {
      ok(await g.execute(p));
      assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
    }
  } finally {
    g.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.gateway === gateway);
  for (const action of Object.values(actions)) {
    const row = rows.find(r => r.action === action);
    assert.equal(row?.status, 'reviewed_write_family', action);
    assert.equal(row.family, 'x_creatives', action);
  }
});
