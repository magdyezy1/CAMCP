import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {removeTestDirectory} from './temp.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport, oauth1} from '../src/transport.js';
import {WriteVerifier} from '../src/write-verification.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {xCreativeOutcome, xReader} from '../src/x-creative-writes.js';
import type {Actor, JsonObject} from '../src/types.js';

const gateway = 'x_ads_native_action',
  account = '123',
  prefix = '/12/accounts/' + account;
const actor: Actor = {tenantId: 'x-creative-fixture', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'};
const key = Buffer.alloc(32, 79).toString('base64'),
  userId = '9000000000000000001',
  tweetId = '9000000000000000002',
  mediaId = '9000000000000000003',
  cardUri = 'card://9000000000000000004';
const mediaKey = '13_' + mediaId,
  credentials = {
    accessToken: 'synthetic-token',
    consumerKey: 'synthetic-key',
    consumerSecret: 'synthetic-secret',
    tokenSecret: 'synthetic-token-secret',
  };
const components = [
  {type: 'MEDIA', media_key: mediaKey},
  {type: 'DETAILS', title: 'إعلان تجريبي', destination: {type: 'WEBSITE', url: 'https://example.test/landing'}},
];
const cardCreate = {action: 'x_accounts_account_id_cards_post', payload: {name: 'Reviewed website video', components}};
const tweetCreate = {
  action: 'x_accounts_account_id_tweet_post',
  payload: {as_user_id: userId, text: 'Reviewed text', card_uri: cardUri, nullcast: true, name: 'Reviewed Tweet'},
};
const promotion = {
  action: 'x_accounts_account_id_promoted_tweets_post',
  payload: {line_item_id: 'line1', tweet_ids: tweetId},
};
const cardEdit = {
  action: 'x_accounts_account_id_cards_card_id_put',
  params: {card_id: 'card1'},
  payload: {name: 'New name'},
};
const rename = {
  action: 'x_accounts_account_id_tweets_tweet_id_name_put',
  params: {tweet_id: tweetId},
  payload: {name: 'New Tweet name'},
};
const execution = (review: JsonObject, extra: JsonObject = {}) => ({
  action: 'execute',
  review_id: review.review_id,
  idempotency_key: review.idempotency_key,
  confirmed: true,
  ...extra,
});

function fixture(file = ':memory:') {
  const store = new Store(file, key),
    registry = new Registry();
  const connection = {
    id: 'x-login',
    tenantId: actor.tenantId,
    gateway,
    accounts: [account],
    writeAccounts: [account],
    enabled: true,
    label: 'Synthetic X login',
    scopes: [],
  };
  store.putConnection(admin, connection, credentials);
  const cards = new Map<string, JsonObject>(),
    tweets = new Map<string, JsonObject>(),
    library = new Map<string, JsonObject>(),
    ads: JsonObject[] = [];
  const items = [
    {id: 'line1', campaign_id: 'campaign1', entity_status: 'ACTIVE'},
    {id: 'line2', campaign_id: 'campaign1', entity_status: 'PAUSED'},
  ];
  const calls: {method: string; path: string; query: JsonObject; body: JsonObject; type: string | null}[] = [];
  const controls = {
    linePages: false,
    repeatCursor: false,
    wrongLine: false,
    lag: 0,
    failList: false,
    loss: false,
    cardArray: true,
    readHook: undefined as (() => void) | undefined,
    metrics: 0,
  };
  const seed = () => {
    library.set(mediaKey, {
      media_key: mediaKey,
      media_status: 'TRANSCODE_COMPLETED',
      media_type: 'VIDEO',
      deleted: false,
    });
    cards.set('card1', {
      id: 'card1',
      card_uri: cardUri,
      name: cardCreate.payload.name,
      components: structuredClone(components),
      deleted: false,
    });
    tweets.set(tweetId, {
      id_str: tweetId,
      id: Number(tweetId),
      full_text: tweetCreate.payload.text,
      name: tweetCreate.payload.name,
      card_uri: cardUri,
      nullcast: true,
      user: {id_str: userId, id: Number(userId)},
      entities: {urls: []},
      retweet_count: 0,
      favorite_count: 0,
    });
  };
  const transport = new NativeTransport(async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET',
      headers = new Headers(init?.headers),
      contentType = headers.get('content-type');
    const raw = init?.body,
      b: JsonObject =
        raw instanceof FormData
          ? Object.fromEntries(raw)
          : raw
            ? contentType === 'application/json'
              ? JSON.parse(String(raw))
              : Object.fromEntries(new URLSearchParams(String(raw)))
            : {};
    calls.push({method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: b, type: contentType});
    assert.match(headers.get('authorization') ?? '', /^OAuth /);
    if (url.origin === 'https://upload.x.com') {
      const command = url.searchParams.get('command') ?? b.command;
      if (command === 'INIT') assert.equal(b.media_category, 'amplify_video');
      if (command === 'APPEND') {
        assert.ok(raw instanceof FormData);
        return new Response(null, {status: 204});
      }
      return Response.json({media_id_string: mediaId, media_key: mediaKey, processing_info: {state: 'succeeded'}});
    }
    assert.equal(url.origin, 'https://ads-api.x.com');
    assert.ok(url.pathname.startsWith(prefix));
    const suffix = url.pathname.slice(prefix.length);
    if (method === 'GET') {
      controls.readHook?.();
      if (suffix === '') return Response.json({data: {id: account, name: 'Synthetic account', currency: 'USD'}});
      if (suffix === '/promotable_users')
        return Response.json({data: [{user_id: userId, promotable_user_type: 'FULL'}]});
      if (suffix === '/cards/all')
        return Response.json({
          data: [...cards.values()].filter(c => url.searchParams.get('card_uris')!.split(',').includes(c.card_uri)),
        });
      if (suffix.startsWith('/cards/')) {
        const card = cards.get(suffix.split('/').at(-1)!);
        return Response.json({data: controls.cardArray ? [card] : card});
      }
      if (suffix.startsWith('/media_library/')) return Response.json({data: library.get(suffix.split('/').at(-1)!)});
      if (suffix === '/tweets') {
        assert.equal(url.searchParams.get('tweet_type'), 'PUBLISHED');
        assert.equal(url.searchParams.get('timeline_type'), 'ALL');
        assert.equal(url.searchParams.get('user_id'), userId);
        const ids = url.searchParams.get('tweet_ids')!.split(',');
        return Response.json({
          data: ids.flatMap(id =>
            tweets.has(id)
              ? [{...tweets.get(id), retweet_count: controls.metrics, favorite_count: controls.metrics}]
              : [],
          ),
        });
      }
      if (suffix === '/line_items')
        return controls.linePages
          ? Response.json({
              data: url.searchParams.has('cursor') ? [items[1]] : [items[0]],
              next_cursor: controls.repeatCursor || !url.searchParams.has('cursor') ? 'next' : null,
            })
          : Response.json({data: items});
      if (suffix.startsWith('/line_items/'))
        return Response.json({data: items.find(i => i.id === suffix.split('/').at(-1))});
      if (suffix === '/campaigns/campaign1') return Response.json({data: {id: 'campaign1', entity_status: 'ACTIVE'}});
      if (suffix === '/promoted_tweets') {
        if (controls.failList)
          return Response.json({
            errors: [{code: 'SERVICE_UNAVAILABLE', message: 'Synthetic incomplete list'}],
            data: [],
          });
        const line = url.searchParams.get('line_item_ids');
        assert.ok(line && !line.includes(','), 'usage and verification must query one exact line item');
        assert.equal(url.searchParams.has('sort_by'), false);
        if (controls.lag-- > 0) return Response.json({data: []});
        return Response.json({data: ads.filter(a => !a.deleted && (controls.wrongLine || a.line_item_id === line))});
      }
      throw Error('Unexpected synthetic read ' + suffix);
    }
    if (controls.loss) throw Error('Synthetic response lost after dispatch');
    if (suffix === '/media_library') {
      assert.equal(Object.hasOwn(b, 'media_category'), false, 'media_category is rejected by the library endpoint');
      const media = {
        media_key: b.media_key,
        name: b.name,
        file_name: b.file_name,
        media_status: 'TRANSCODE_COMPLETED',
        media_type: 'VIDEO',
        deleted: false,
      };
      library.set(b.media_key, media);
      return Response.json({data: media});
    }
    if (suffix === '/cards' || suffix.startsWith('/cards/')) {
      if (method !== 'DELETE') {
        assert.equal(contentType, 'application/json', 'X cards require JSON');
        const auth = headers.get('authorization')!,
          nonce = /oauth_nonce="([^"]+)"/.exec(auth)![1]!,
          timestamp = /oauth_timestamp="([^"]+)"/.exec(auth)![1]!;
        assert.equal(
          auth,
          oauth1(method, url, credentials, undefined, decodeURIComponent(nonce), timestamp),
          'JSON fields must not enter the OAuth form signature',
        );
      }
      const card =
        method === 'POST'
          ? {id: 'card1', card_uri: cardUri, ...b, deleted: false}
          : {...cards.get('card1'), ...b, deleted: method === 'DELETE'};
      cards.set('card1', card);
      if (method !== 'POST') for (const ad of ads) if (tweets.get(ad.tweet_id)?.card_uri === cardUri) ad.deleted = true;
      return Response.json({data: method !== 'POST' && controls.cardArray ? [card] : card});
    }
    if (suffix === '/tweet') {
      assert.equal(b.nullcast, 'true');
      assert.ok([...cards.values()].some(c => c.card_uri === b.card_uri));
      const tweet = {
        id_str: tweetId,
        id: Number(tweetId),
        name: b.name,
        full_text: b.text,
        card_uri: b.card_uri,
        nullcast: true,
        user: {id_str: b.as_user_id},
        entities: {urls: []},
        retweet_count: 0,
      };
      tweets.set(tweetId, tweet);
      return Response.json({data: tweet});
    }
    if (suffix.endsWith('/name')) {
      const tweet = {...tweets.get(tweetId), name: b.name};
      tweets.set(tweetId, tweet);
      for (const ad of ads) if (ad.tweet_id === tweetId) ad.deleted = true;
      return Response.json({data: tweet});
    }
    if (suffix === '/promoted_tweets') {
      assert.equal(Object.hasOwn(b, 'entity_status'), false);
      const rows = b.tweet_ids.split(',').map((id: string, i: number) => ({
        id: 'promo' + (ads.length + i + 1),
        line_item_id: b.line_item_id,
        tweet_id: id,
        entity_status: 'ACTIVE',
        approval_status: 'ACCEPTED',
        deleted: false,
      }));
      ads.push(...rows);
      return Response.json({data: rows});
    }
    throw Error('Unexpected synthetic mutation ' + suffix);
  });
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(24)]);
  let downloads = 0;
  const source: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, 'drive.usercontent.google.com');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    downloads++;
    return new Response(mp4, {headers: {'Content-Type': 'video/mp4'}});
  };
  const service = new MirrorService(
    registry,
    store,
    transport,
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    source,
  );
  const prepare = (args: JsonObject, extra: JsonObject = {}, as = actor) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, connection_id: connection.id, arguments: {account_id: account, ...args}, ...extra},
      as,
    );
  const execute = (review: JsonObject, extra: JsonObject = {}) =>
    service.call('amcp_write', execution(review, extra), actor);
  const verify = (review: JsonObject) =>
    new WriteVerifier(store, registry, transport, service.credentials).verify(actor, review.review_id);
  const writes = () => calls.filter(c => c.method !== 'GET');
  return {
    store,
    service,
    connection,
    calls,
    controls,
    cards,
    tweets,
    library,
    ads,
    items,
    seed,
    prepare,
    execute,
    verify,
    writes,
    downloads: () => downloads,
  };
}
const prepared = async (p: Promise<any>) => {
  const r = await p;
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data as JsonObject;
};
const succeeded = (r: any) => {
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.success, true, JSON.stringify(r));
  return r.data;
};

test('reviewed X video chain streams Drive -> upload -> library -> JSON card -> nullcast Tweet -> active promotion -> per-line-item verification', async () => {
  const x = fixture();
  try {
    const media = await prepared(
      x.service.call(
        'amcp_media',
        {
          action: 'prepare',
          platform: 'x_ads',
          account_id: account,
          connection_id: 'x-login',
          drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view',
          name: 'Reviewed video',
        },
        actor,
      ),
    );
    const upload = await x.service.call('amcp_media', execution(media), actor);
    assert.equal(upload.success, true, JSON.stringify(upload));
    assert.equal(upload.data.media_id, mediaId);
    let registered = upload.data;
    if (!registered.library_id) {
      const attachment = await prepared(
        x.service.call('amcp_media', {action: 'prepare_library', review_id: media.review_id}, actor),
      );
      const result = await x.service.call('amcp_media', execution(attachment), actor);
      assert.equal(result.success, true, JSON.stringify(result));
      registered = result.data;
    }
    assert.equal(registered.library_id, mediaKey);
    assert.equal(x.downloads(), 1);
    const card = await prepared(x.prepare(cardCreate));
    succeeded(await x.execute(card));
    assert.equal((await x.verify(card)).status, 'verified');
    const tweet = await prepared(x.prepare(tweetCreate));
    const made = succeeded(await x.execute(tweet));
    assert.equal(made.data.data.id_str, tweetId);
    assert.equal((await x.verify(tweet)).status, 'verified');
    const promote = await prepared(x.prepare(promotion));
    assert.match(promote.request.warnings.join(' '), /may serve immediately/);
    assert.equal((await x.execute(promote)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    succeeded(await x.execute(promote, {spend_change_confirmed: true}));
    x.controls.lag = 2;
    assert.equal((await x.verify(promote)).status, 'verified');
    const count = x.writes().length;
    assert.equal(succeeded(await x.execute(promote, {spend_change_confirmed: true})).replayed, true);
    assert.equal(x.writes().length, count);
    assert.equal(x.calls.filter(c => c.path.endsWith('/promoted_tweets') && c.method === 'GET').length, 3);
    assert.equal(x.ads.length, 1);
  } finally {
    x.store.close();
  }
});

test('all new X route inspections are local; unsupported transports, formats and fake paused promotion fields fail before egress', async () => {
  const x = fixture();
  try {
    for (const args of [
      cardCreate,
      cardEdit,
      {...cardEdit, action: 'x_accounts_account_id_cards_card_id_delete', payload: {}},
      tweetCreate,
      rename,
      {action: 'x_accounts_account_id_media_library_post', payload: {media_key: mediaKey, name: 'Library'}},
    ]) {
      const r = await x.service.call(
        'amcp_write',
        {action: 'inspect', gateway, arguments: {account_id: account, ...args}},
        actor,
      );
      assert.equal(r.data.review_contract_supported, true, JSON.stringify(r));
    }
    assert.equal(x.calls.length, 0);
    for (const args of [
      {...promotion, payload: {...promotion.payload, entity_status: 'PAUSED'}},
      {...tweetCreate, payload: {...tweetCreate.payload, nullcast: false}},
      {...cardCreate, payload: {...cardCreate.payload, card_type: 'VIDEO_WEBSITE'}},
      {...cardCreate, payload: {name: 'wrong order', components: [...components].reverse()}},
    ]) {
      assert.equal((await x.prepare(args)).error.code, 'INVALID_X_CREATIVE');
    }
    assert.equal(
      (await x.prepare({...tweetCreate, payload: {...tweetCreate.payload, as_user_id: Number(userId)}})).error.code,
      'UNSAFE_NUMERIC_ID',
    );
    const upload = await x.prepare({action: 'x_media_upload_post', payload: {media_data: 'synthetic'}});
    assert.equal(upload.error.code, 'MEDIA_SOURCE_REQUIRED');
    assert.equal(x.calls.length, 0);
  } finally {
    x.store.close();
  }
});

for (const edit of [cardEdit, rename, {...cardEdit, action: 'x_accounts_account_id_cards_card_id_delete', payload: {}}])
  test(
    edit.action + ' blocks referencing ads; frozen override returns a scoped recovery plan without replaying mutations',
    async () => {
      const x = fixture();
      try {
        x.seed();
        x.ads.push({id: 'promo1', line_item_id: 'line2', tweet_id: tweetId, entity_status: 'ACTIVE', deleted: false});
        x.controls.linePages = true;
        const blocked = await x.prepare(edit);
        assert.equal(blocked.error.code, 'CREATIVE_IN_USE', JSON.stringify(blocked));
        assert.equal(blocked.error.details.affected_ads[0].promoted_tweet_id, 'promo1');
        assert.equal(x.writes().length, 0);
        const review = await prepared(x.prepare(edit, {creative_edit_confirmed: true}));
        assert.equal(review.creative_impact.affected_ads[0].line_item_id, 'line2');
        assert.equal((await x.execute(review)).error.code, 'CREATIVE_EDIT_CONFIRMATION_REQUIRED');
        const result = succeeded(await x.execute(review, {creative_edit_confirmed: true}));
        assert.equal(result.creative_impact.automatic_repromotion, false);
        const replay = result.creative_impact.recovery_plan[0].arguments;
        assert.equal(replay.connection_id, 'x-login');
        assert.deepEqual(replay.arguments.payload, {line_item_id: 'line2', tweet_ids: tweetId});
        assert.equal(x.ads[0]!.deleted, true);
        assert.equal(x.writes().length, 1, 'the override never automatically re-promotes');
        const verification = await x.verify(review);
        assert.equal(verification.status, 'verified', JSON.stringify(verification));
        for (const check of verification.checks) assert.equal(check.expected_hash, check.actual_hash);
        assert.equal(succeeded(await x.execute(review, {creative_edit_confirmed: true})).replayed, true);
        assert.equal(x.writes().length, 1);
      } finally {
        x.store.close();
      }
    },
  );

test('creative usage added or changed between prepare and execute is blocked, including override expansion', async () => {
  const x = fixture();
  try {
    x.seed();
    const r = await prepared(x.prepare(cardEdit));
    x.ads.push({id: 'promo1', line_item_id: 'line1', tweet_id: tweetId, entity_status: 'ACTIVE'});
    assert.equal((await x.execute(r)).error.code, 'CREATIVE_IN_USE');
    const allowed = await prepared(x.prepare(cardEdit, {creative_edit_confirmed: true}));
    x.ads.push({id: 'promo2', line_item_id: 'line2', tweet_id: tweetId, entity_status: 'ACTIVE'});
    const changed = await x.execute(allowed, {creative_edit_confirmed: true});
    assert.equal(changed.error.code, 'STATE_CHANGED');
    assert.ok(changed.error.details.changed_fields.length);
    assert.equal(x.writes().length, 0);
    assert.equal((await x.execute(r, {creative_edit_confirmed: true})).error.code, 'REVIEW_CHANGED');
  } finally {
    x.store.close();
  }
});

test('incomplete usage, wrong line-item bindings, repeated cursors and unreadable Tweet metadata fail closed even with override', async () => {
  for (const mode of ['failList', 'wrongLine', 'repeatCursor', 'missingTweet']) {
    const x = fixture();
    try {
      x.seed();
      x.ads.push({id: 'promo1', line_item_id: 'line2', tweet_id: tweetId, entity_status: 'ACTIVE'});
      if (mode === 'missingTweet') x.tweets.clear();
      else if (mode === 'repeatCursor') {
        x.controls.linePages = true;
        x.controls.repeatCursor = true;
      } else x.controls[mode as 'failList' | 'wrongLine'] = true;
      const r = await x.prepare(cardEdit, {creative_edit_confirmed: true});
      assert.equal(r.error.code, 'X_CREATIVE_STATE_UNVERIFIED', JSON.stringify(r));
      assert.equal(x.writes().length, 0);
      if (mode === 'failList') {
        assert.equal(r.error.details.http_status, 200);
        assert.equal(r.error.details.provider_error_code, 'PLATFORM_ERROR');
        assert.equal(r.error.details.upstream.errors[0].code, 'SERVICE_UNAVAILABLE');
      }
    } finally {
      x.store.close();
    }
  }
});

test('promotion honors activation policy and creative edits honor deletion policy', async () => {
  const x = fixture();
  try {
    x.seed();
    saveSpendPolicy(x.store, admin, {
      gateway,
      account_id: account,
      confirmed: true,
      policy: {allow_activation: false, allow_deletion: false},
    });
    const promotionResult = await x.prepare(promotion);
    assert.equal(promotionResult.error.code, 'POLICY_ACTIVATION_FORBIDDEN', JSON.stringify(promotionResult));
    const edit = await x.prepare(cardEdit, {creative_edit_confirmed: true});
    assert.equal(edit.error.code, 'POLICY_DELETION_FORBIDDEN', JSON.stringify(edit));
    assert.equal(x.writes().length, 0);
  } finally {
    x.store.close();
  }
});

test('X review comparison ignores Tweet counters but catches text, card components and parent delivery changes', async () => {
  const x = fixture();
  try {
    x.seed();
    const r = await prepared(x.prepare(rename));
    x.controls.metrics = 123;
    assert.equal((await x.execute(r)).success, true);
    const card = await prepared(x.prepare(cardEdit));
    x.cards.get('card1')!.components[1].destination.url = 'https://example.test/other';
    assert.equal((await x.execute(card)).error.code, 'STATE_CHANGED');
    const changedCreative = await prepared(x.prepare(promotion));
    x.cards.get('card1')!.components[1].destination.url = 'https://example.test/changed-after-promotion-review';
    assert.equal((await x.execute(changedCreative, {spend_change_confirmed: true})).error.code, 'STATE_CHANGED');
    const p = await prepared(x.prepare(promotion));
    x.items[0]!.entity_status = 'PAUSED';
    assert.equal((await x.execute(p, {spend_change_confirmed: true})).error.code, 'STATE_CHANGED');
  } finally {
    x.store.close();
  }
});

test('missing account grants, wrong actors and revocation during dependency reads cannot dispatch X creatives', async () => {
  const x = fixture();
  try {
    x.seed();
    assert.equal((await x.prepare(cardCreate, {}, {...actor, role: 'reader'})).error.code, 'FORBIDDEN');
    assert.equal((await x.prepare(cardCreate, {}, {...actor, tenantId: 'other'})).success, false);
    x.controls.readHook = () => {
      x.store.putConnection(admin, {...x.connection, writeAccounts: []}, credentials);
    };
    assert.equal((await x.prepare(cardCreate)).error.code, 'WRITE_ACCOUNT_FORBIDDEN');
    assert.equal(x.writes().length, 0);
  } finally {
    x.store.close();
  }
});

test('per-line-item verification reports pending lag and never turns an absent association into a safe write retry', async () => {
  const x = fixture();
  try {
    x.seed();
    const r = await prepared(x.prepare(promotion));
    succeeded(await x.execute(r, {spend_change_confirmed: true}));
    x.controls.lag = 10;
    const pending = await x.verify(r);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.automatic_retry_of_mutation, false);
    assert.equal(pending.next_call.arguments.review_id, r.review_id);
    assert.equal(x.writes().length, 1);
    x.controls.lag = 0;
    assert.equal((await x.verify(r)).status, 'verified');
    assert.equal(x.writes().length, 1);
  } finally {
    x.store.close();
  }
});

test('concurrent creative execution claims once and a lost response remains uncertain', async () => {
  const x = fixture();
  try {
    x.seed();
    const r = await prepared(x.prepare(cardCreate));
    await Promise.all([x.execute(r), x.execute(r)]);
    assert.equal(x.writes().length, 1);
    const second = await prepared(x.prepare(cardCreate));
    x.controls.loss = true;
    assert.equal((await x.execute(second)).success, false);
    const writes = x.writes().length;
    assert.equal((await x.execute(second)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(x.writes().length, writes);
  } finally {
    x.store.close();
  }
});

test('X response contracts reject empty, partial, duplicate, wrong-parent and unsafe identities, including HTTP 200', async () => {
  const x = fixture();
  try {
    x.seed();
    const p = (await prepared(x.prepare(promotion))).request;
    for (const data of [
      undefined,
      [],
      [null],
      [{id: 'promo1', tweet_id: tweetId, line_item_id: 'other', entity_status: 'ACTIVE'}],
      [{id: 'promo1', tweet_id: tweetId, line_item_id: 'line1', entity_status: 'PAUSED'}],
    ])
      assert.equal(xCreativeOutcome(p, {status: 200, headers: {}, data: {data}}), false);
    const t = (await prepared(x.prepare(tweetCreate))).request;
    assert.equal(xCreativeOutcome(t, {status: 200, headers: {}, data: {data: {id: Number(tweetId)}}}), false);
    const c = (await prepared(x.prepare(cardEdit))).request;
    assert.equal(xCreativeOutcome(c, {status: 200, headers: {}, data: {data: [{id: 'card1'}, {id: 'card2'}]}}), false);
    assert.equal(xCreativeOutcome(c, {status: 200, headers: {}, data: {data: [{id: 'wrong'}]}}), false);
  } finally {
    x.store.close();
  }
});

test('X discovery rejects unknown pagination and row limits; supports multiple promotable identities without guessing authors', async () => {
  const x = fixture();
  try {
    x.seed();
    const p = (await prepared(x.prepare(promotion))).request;
    for (const envelope of [
      {data: [], paging: {next: 'cursor'}},
      {data: [], errors: {}},
      {data: [], total_count: 2},
      {data: [{}], next_cursor: 7},
    ]) {
      await assert.rejects(xReader(p, async () => ({status: 200, headers: {}, data: envelope})).list('/line_items'), {
        code: 'X_CREATIVE_STATE_UNVERIFIED',
      });
    }
    let calls = 0;
    await assert.rejects(
      xReader(p, async () => ({
        status: 200,
        headers: {},
        data: {data: Array.from({length: 1000}, () => ({})), next_cursor: 'cursor' + ++calls},
      })).list('/line_items'),
      {code: 'X_CREATIVE_DISCOVERY_LIMIT'},
    );
    assert.equal(calls, 21);
    const secondUser = '9000000000000000005',
      secondTweet = '9000000000000000006',
      requests: string[] = [];
    const read = xReader(p, async q => {
      requests.push(String(q.query.user_id));
      return {
        status: 200,
        headers: {},
        data: {
          data: q.path.endsWith('/promotable_users')
            ? [{user_id: userId}, {user_id: secondUser}]
            : q.query.user_id === userId
              ? [x.tweets.get(tweetId)]
              : [{id_str: secondTweet, text: 'Second author', user: {id_str: secondUser}}],
        },
      };
    });
    assert.equal((await read.tweets([tweetId, secondTweet])).length, 2);
    assert.deepEqual(requests, ['undefined', userId, secondUser]);
  } finally {
    x.store.close();
  }
});

test('four-Tweet promotion verifies every association and reordered card components remain a conflict', async () => {
  const x = fixture();
  try {
    x.seed();
    const ids = [tweetId, '9000000000000000012', '9000000000000000022', '9000000000000000032'];
    for (const id of ids) x.tweets.set(id, {...x.tweets.get(tweetId), id_str: id, id: Number(id)});
    const r = await prepared(x.prepare({...promotion, payload: {...promotion.payload, tweet_ids: ids.join(',')}}));
    succeeded(await x.execute(r, {spend_change_confirmed: true}));
    const verified = await x.verify(r);
    assert.equal(verified.checks.length, 4);
    assert.equal(verified.status, 'verified');
    const edit = await prepared(x.prepare(cardEdit, {creative_edit_confirmed: true}));
    x.cards.get('card1')!.components.reverse();
    assert.equal((await x.execute(edit, {creative_edit_confirmed: true})).error.code, 'STATE_CHANGED');
  } finally {
    x.store.close();
  }
});

test('X receipt replay survives reopening SQLite; expired and tampered reviews cannot dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-x-review-')),
    file = join(dir, 'synthetic.sqlite');
  let x = fixture(file);
  try {
    x.seed();
    const r = await prepared(x.prepare(cardCreate));
    succeeded(await x.execute(r));
    x.store.close();
    x = fixture(file);
    assert.equal(succeeded(await x.execute(r)).replayed, true);
    assert.equal(x.writes().length, 0);
    x.seed();
    const expired = await prepared(x.prepare(cardCreate)),
      record = x.store.document(actor.tenantId, 'write_review', expired.review_id);
    x.store.putDocument(actor.tenantId, 'write_review', expired.review_id, {...record, expires_at: Date.now() - 1});
    assert.equal((await x.execute(expired)).error.code, 'REVIEW_EXPIRED');
    const edit = await prepared(x.prepare(cardEdit, {creative_edit_confirmed: true})),
      stored = x.store.document(actor.tenantId, 'write_review', edit.review_id);
    x.store.putDocument(actor.tenantId, 'write_review', edit.review_id, {...stored, creative_edit_confirmed: false});
    assert.equal((await x.execute(edit)).error.code, 'REVIEW_CHANGED');
    assert.equal(x.writes().length, 0);
  } finally {
    x.store.close();
    removeTestDirectory(dir, 'amcp-x-review-');
  }
});

test('durable X campaign plans preflight symbolic media/card IDs and execute only verified predecessor references', async () => {
  const x = fixture();
  try {
    const call = (input: JsonObject) => x.service.call('amcp_campaign', input, actor),
      steps = [
        {
          id: 'media',
          kind: 'media',
          arguments: {
            platform: 'x_ads',
            drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view',
            name: 'Synthetic video',
          },
          depends_on: [],
        },
        {
          id: 'card',
          kind: 'write',
          gateway,
          arguments: {
            ...cardCreate,
            payload: {
              ...cardCreate.payload,
              components: [{type: 'MEDIA', media_key: {$ref: 'media#/media_key'}}, components[1]],
            },
          },
          depends_on: ['media'],
        },
        {
          id: 'tweet',
          kind: 'write',
          gateway,
          arguments: {...tweetCreate, payload: {...tweetCreate.payload, card_uri: {$ref: 'card#/data/data/card_uri'}}},
          depends_on: ['card'],
        },
        {
          id: 'promotion',
          kind: 'write',
          gateway,
          arguments: {...promotion, payload: {...promotion.payload, tweet_ids: {$ref: 'tweet#/data/data/id_str'}}},
          depends_on: ['tweet'],
        },
      ].map(s => ({...s, account_id: account, connection_id: 'x-login'}));
    const run = await prepared(
      call({action: 'create', name: 'Synthetic durable X chain', brief: 'Website video campaign fixture', steps}),
    );
    const preflight = await prepared(call({action: 'preflight', id: run.id}));
    assert.equal(preflight.blocked, false, JSON.stringify(preflight));
    assert.equal(x.writes().length, 0);
    let latest: JsonObject = run;
    for (const step of steps) {
      const next = await prepared(call({action: 'prepare_next', id: run.id}));
      assert.equal(next.step_id, step.id, JSON.stringify(next));
      assert.ok(next.review?.review_id);
      latest = await prepared(
        call({
          action: 'execute_next',
          id: run.id,
          review_id: next.review.review_id,
          idempotency_key: next.review.review_id,
          confirmed: true,
          spend_change_confirmed: true,
        }),
      );
      assert.equal(latest.steps.find((s: JsonObject) => s.id === step.id).status, 'verified', JSON.stringify(latest));
    }
    assert.equal(latest.state, 'complete');
    assert.equal(x.ads.length, 1);
    assert.equal(x.calls.filter(c => c.path.endsWith('/cards') && c.method === 'POST').length, 1);
  } finally {
    x.store.close();
  }
});
