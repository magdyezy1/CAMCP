// Package r12-xpreview, item 2: amcp_ad_previews qualifies X's Tweet previews. Before it, platform x_ads answered
// previews: [] and preview_route: "not_qualified" because no document pinned the parameters of the Tweet preview read
// (docs/records/X-TWEET-PREVIEWS-PIN-2026-11-16.md now does). The fixtures follow that record: X's documented shapes and the
// live answer of 2026-11-16, with synthetic IDs and a synthetic payload (no live value is copied).
//
// An "ad" of X is a promoted Tweet, whose promotion names the Tweet (`tweet_id`); a dark (nullcast) Tweet may also be named by
// its own ID. An entry is one Tweet, with the promoted-Tweet IDs that share it. X's HTML snippet is never passed through: only
// its iframe src, and only when it is https://ton.twimg.com/ads-manager/tweet-preview/index.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {
  xNoExpiry,
  xPreviewBatches,
  xPreviewLink,
  xPreviewReasons,
  xTweetPreviewBatch,
} from '../dist/src/x-ad-previews.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const registry = new Registry(),
  account = 'acct1',
  login = 'aaaaaaaa-1111-4111-8111-0000000000a1',
  host = 'https://ton.twimg.com/ads-manager/tweet-preview/index.html',
  // 19-digit Tweet IDs, as X's are, none of them a real one.
  tweet = n => '19000000000000' + String(n).padStart(5, '0'),
  payload = id => 'H4sISYNTHETIC' + id + '%2BAbC%2F%3D',
  link = id => host + '?data=' + payload(id),
  iframe = (src, attributes = '') => `<iframe class='tweet-preview' ${attributes}src='${src}'>`,
  genericNotice =
    'Preview links expire, and a platform may need its own sign-in to show some of them; share them only with people who may see these ads. AMCP does not store them.';

const promotion = (id, tweet_id, line_item_id, over = {}) => ({
  id,
  tweet_id,
  line_item_id,
  entity_status: 'ACTIVE',
  approval_status: 'ACCEPTED',
  deleted: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...over,
});
const darkTweet = (n, name = 'Dark launch') => ({
  id_str: tweet(n),
  tweet_id: tweet(n),
  nullcast: true,
  name,
  full_text: 'SYNTHETIC TWEET TEXT',
  tweet_type: 'PUBLISHED',
});
/** The synthetic account: line items in two campaigns, one Tweet promoted twice, and a dark Tweet that is not promoted. */
function world(over = {}) {
  return {
    lineItems: [
      {id: 'li1', campaign_id: 'cm1', entity_status: 'ACTIVE', deleted: false},
      {id: 'li2', campaign_id: 'cm2', entity_status: 'ACTIVE', deleted: false},
      {id: 'li3', campaign_id: 'cm1', entity_status: 'PAUSED', deleted: true},
    ],
    promoted: [
      promotion('pt1', tweet(1), 'li1'),
      promotion('pt2', tweet(1), 'li2'),
      promotion('pt3', tweet(3), 'li1', {entity_status: 'PAUSED'}),
      promotion('pt4', tweet(4), 'li3', {deleted: true}),
    ],
    dark: [darkTweet(90)],
    // The Tweets X would answer a preview for, the account's own or not: the tool must not lean on X to refuse a foreign one.
    previewable: null,
    silent: new Set(),
    duplicate: new Set(),
    extraEntries: [],
    snippet: id => iframe(link(id)),
    // X answers a filter by line item, or by ID, or the page size, as if it were not there.
    ignoreFilters: false,
    ignoreIds: false,
    ignoreCount: false,
    // The account the answers echo, and the one the preview answer echoes.
    echoAccount: account,
    echoPreviews: account,
    previewStatus: 200,
    previewData: undefined,
    omitCursor: false,
    // A list that says more follows, whatever it was asked for (true: with a cursor; any other value: with that cursor), and the
    // cursor a list that ends carries.
    forceNext: false,
    endAs: null,
    // A page that is exactly as large as the page size it was asked for carries a cursor, as a collection that cannot tell
    // whether another row follows does.
    fullPageCursor: false,
    ...over,
  };
}

/** The synthetic X API: every request is kept, and answered from the world by path (X's documented shapes). */
function api(w, log) {
  return (url, init) => {
    const query = Object.fromEntries(url.searchParams),
      path = url.pathname.replace('/12/accounts/' + account, '');
    log.push({path, query, method: init?.method ?? 'GET'});
    const csv = value => (value === undefined ? null : new Set(value.split(','))),
      envelope = (data, next) => ({
        request: {params: {account_id: w.echoAccount}},
        ...(w.omitCursor ? {} : {next_cursor: next}),
        data,
      }),
      paged = rows => {
        const size = w.ignoreCount ? rows.length : Number(query.count ?? 200),
          start = Number(query.cursor ?? 0);
        return Response.json(
          envelope(
            rows.slice(start, start + size),
            w.forceNext
              ? w.forceNext === true
                ? 'more'
                : w.forceNext
              : start + size < rows.length || (w.fullPageCursor && rows.slice(start, start + size).length === size)
                ? String(start + size)
                : w.endAs,
          ),
        );
      };
    if (path === '/promoted_tweets') {
      const lines = csv(query.line_item_ids),
        ids = csv(query.promoted_tweet_ids);
      return paged(
        w.promoted.filter(
          r =>
            (query.with_deleted === 'true' || !r.deleted) &&
            (w.ignoreFilters || !lines || lines.has(r.line_item_id)) &&
            (w.ignoreIds || !ids || ids.has(r.id)),
        ),
      );
    }
    if (path === '/line_items') {
      const ids = csv(query.line_item_ids);
      return paged(
        w.lineItems.filter(
          r => (query.with_deleted === 'true' || !r.deleted) && (w.ignoreIds || !ids || ids.has(r.id)),
        ),
      );
    }
    if (path === '/tweets') {
      const ids = csv(query.tweet_ids);
      if (query.tweet_type !== 'PUBLISHED' || !['NULLCAST', 'ALL', 'ORGANIC'].includes(query.timeline_type))
        return Response.json({errors: [{code: 'INVALID_PARAMETER', message: 'synthetic'}]}, {status: 400});
      return paged(
        query.timeline_type === 'ORGANIC' ? [] : w.dark.filter(r => w.ignoreIds || !ids || ids.has(r.id_str)),
      );
    }
    if (path === '/tweet_previews') {
      if (w.previewStatus !== 200)
        return Response.json(
          {errors: [{code: 'INVALID_PARAMETER', message: 'synthetic refusal'}]},
          {status: w.previewStatus},
        );
      const asked = query.tweet_ids.split(','),
        known = w.previewable ?? new Set([...w.promoted.map(r => r.tweet_id), ...w.dark.map(r => r.id_str), tweet(77)]);
      return Response.json({
        request: {params: {account_id: w.echoPreviews, tweet_ids: asked, tweet_type: query.tweet_type}},
        data: w.previewData ?? [
          ...asked
            .filter(id => known.has(id) && !w.silent.has(id))
            .flatMap(id => [
              {tweet_id: id, preview: w.snippet(id)},
              ...(w.duplicate.has(id) ? [{tweet_id: id, preview: iframe(link(tweet(66)))}] : []),
            ]),
          ...w.extraEntries,
        ],
      });
    }
    return Response.json({errors: [{code: 'NOT_FOUND', message: 'synthetic'}]}, {status: 404});
  };
}

function fixture(t, w = world()) {
  const actor = {tenantId: 'x-ad-previews', userId: 'reader', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 63).toString('base64')),
    log = [],
    answer = api(w, log);
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: login,
      tenantId: actor.tenantId,
      gateway: 'x_ads_native_action',
      enabled: true,
      label: 'Synthetic X',
      accounts: [account],
      scopes: [],
    },
    {
      accessToken: 'synthetic-token',
      consumerKey: 'synthetic-key',
      consumerSecret: 'synthetic-secret',
      tokenSecret: 'synthetic-token-secret',
    },
  );
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async (url, init) => answer(new URL(url), init),
      async () => {},
      30000,
      8 * 1024 * 1024,
      1000,
      1,
    ),
  );
  t.after(() => store.close());
  return {
    store,
    log,
    actor,
    service,
    reads: path => log.filter(r => r.path === path),
    previews: (input = {}) =>
      service.call('amcp_ad_previews', {platform: 'x_ads', account_id: account, connection_id: login, ...input}, actor),
  };
}
const ok = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data;
};
// A read that names its IDs asks for a page of the most IDs X takes in a filter (200: record X-TWEET-PREVIEWS-PIN-2026-11-16, R1 to R3),
// whatever number it names: an answer to such a read is complete when it carries no cursor.
const named = '200';
const entry = (id, promoted, name = null) => ({
  ad_id: id,
  name,
  tweet_id: id,
  promoted_tweet_ids: promoted,
  links: [link(id)],
  expires: xNoExpiry,
});

test('named by a promoted-Tweet ID and a dark Tweet ID, the live shape gives two previews, each with a validated ton.twimg.com link', async t => {
  const f = fixture(t),
    data = ok(await f.previews({ad_ids: ['pt1', tweet(90)]}));
  assert.deepEqual(data.previews, [entry(tweet(1), ['pt1']), entry(tweet(90), [], 'Dark launch')]);
  // The route is qualified: no "not qualified" answer and no explanation to open the Tweet on X instead.
  assert.equal(data.preview_route, undefined);
  assert.equal(data.explanation, undefined);
  assert.equal(data.not_found, undefined);
  assert.equal(data.executed, false);
  assert.equal(data.meaning, genericNotice);
  // One read for the promoted Tweet, one for the dark Tweet among the account's own dark Tweets, one preview read for both
  // Tweets with tweet_type PUBLISHED (X documents tweet_ids as a comma-separated list and tweet_type as required).
  assert.deepEqual(
    f.reads('/promoted_tweets').map(r => r.query),
    [{promoted_tweet_ids: 'pt1', with_deleted: 'true', count: named}],
  );
  assert.deepEqual(
    f.reads('/tweets').map(r => r.query),
    [
      {
        tweet_ids: tweet(90),
        tweet_type: 'PUBLISHED',
        timeline_type: 'NULLCAST',
        include_mentions_and_replies: 'true',
        count: named,
      },
    ],
  );
  assert.deepEqual(
    f.reads('/tweet_previews').map(r => r.query),
    [{tweet_ids: tweet(1) + ',' + tweet(90), tweet_type: 'PUBLISHED'}],
  );
  assert.ok(
    f.log.every(r => r.method === 'GET'),
    'a preview is a read: nothing is sent to X that could change an account',
  );
});

test('without ad_ids it previews the account’s active promoted Tweets: one entry per Tweet, with the promoted-Tweet IDs that share it', async t => {
  const f = fixture(t),
    data = ok(await f.previews());
  // pt1 and pt2 promote one Tweet in two line items: one entry, naming both. pt3 is paused and pt4 deleted.
  assert.deepEqual(data.previews, [entry(tweet(1), ['pt1', 'pt2'])]);
  assert.equal(data.has_more, false);
  assert.equal(data.next_cursor, null);
  assert.deepEqual(
    f.reads('/promoted_tweets').map(r => r.query),
    [{count: '100', with_deleted: 'false'}],
  );
  assert.equal(f.reads('/line_items').length, 0, 'no campaign filter: no parent is read');
  assert.equal(f.reads('/tweets').length, 0, 'no named Tweet: the account’s Tweets are not read');
  assert.deepEqual(
    f.reads('/tweet_previews').map(r => r.query),
    [{tweet_ids: tweet(1), tweet_type: 'PUBLISHED'}],
  );
});

test('statuses select the promoted Tweet’s own status: paused, archived (deleted), all, and their combinations', async t => {
  const f = fixture(t);
  const previews = async statuses =>
    ok(await f.previews({statuses})).previews.map(p => [p.tweet_id, p.promoted_tweet_ids]);
  assert.deepEqual(await previews(['paused']), [[tweet(3), ['pt3']]]);
  assert.deepEqual(await previews(['archived']), [[tweet(4), ['pt4']]]);
  assert.deepEqual(await previews(['active', 'paused']), [
    [tweet(1), ['pt1', 'pt2']],
    [tweet(3), ['pt3']],
  ]);
  assert.deepEqual(await previews(['all']), [
    [tweet(1), ['pt1', 'pt2']],
    [tweet(3), ['pt3']],
    [tweet(4), ['pt4']],
  ]);
  // Deleted promotions are asked for only when a status can select them.
  assert.deepEqual(
    f.reads('/promoted_tweets').map(r => r.query.with_deleted),
    ['false', 'true', 'false', 'true'],
  );
});

test('adset_ids are line item IDs: sent to X as line_item_ids and still applied to what X returns', async t => {
  const f = fixture(t),
    data = ok(await f.previews({adset_ids: ['li1'], statuses: ['all']}));
  assert.deepEqual(
    data.previews.map(p => [p.tweet_id, p.promoted_tweet_ids]),
    [
      [tweet(1), ['pt1']],
      [tweet(3), ['pt3']],
    ],
  );
  assert.deepEqual(
    f.reads('/promoted_tweets').map(r => r.query),
    [{count: '100', with_deleted: 'true', line_item_ids: 'li1'}],
  );
  // An answer that ignored the filter does not widen the selection: the other line items’ promotions are dropped here.
  const lax = fixture(t, world({ignoreFilters: true})),
    again = ok(await lax.previews({adset_ids: ['li1'], statuses: ['all']}));
  assert.deepEqual(
    again.previews.map(p => p.promoted_tweet_ids),
    [['pt1'], ['pt3']],
  );
});

test('campaign_ids are resolved through the line items of the page read, and a line item X does not list selects nothing', async t => {
  const f = fixture(t),
    data = ok(await f.previews({campaign_ids: ['cm2']}));
  assert.deepEqual(data.previews, [entry(tweet(1), ['pt2'])]);
  // The page’s distinct line items, once, in one read that also lists deleted and draft ones.
  assert.deepEqual(
    f.reads('/line_items').map(r => r.query),
    [{line_item_ids: 'li1,li2', with_deleted: 'true', with_draft: 'true', count: named}],
  );
  const both = ok(await f.previews({campaign_ids: ['cm1'], statuses: ['all']}));
  assert.deepEqual(
    both.previews.map(p => [p.tweet_id, p.promoted_tweet_ids]),
    [
      [tweet(1), ['pt1']],
      [tweet(3), ['pt3']],
      [tweet(4), ['pt4']],
    ],
  );
  // Membership that cannot be proven is not assumed: X lists no line item li2, so its promotion is not in campaign cm2.
  const unlisted = fixture(
      t,
      world({lineItems: [{id: 'li1', campaign_id: 'cm1', entity_status: 'ACTIVE', deleted: false}]}),
    ),
    none = ok(await unlisted.previews({campaign_ids: ['cm2']}));
  assert.deepEqual(none.previews, []);
  assert.equal(none.has_more, false);
});

test('limit counts promoted Tweets, and the cursor resumes the selection in the same list', async t => {
  const f = fixture(t),
    first = ok(await f.previews({statuses: ['all'], limit: 2}));
  assert.deepEqual(
    first.previews.map(p => [p.tweet_id, p.promoted_tweet_ids]),
    [[tweet(1), ['pt1', 'pt2']]],
  );
  assert.equal(first.has_more, true);
  assert.equal(typeof first.next_cursor, 'string');
  const second = ok(await f.previews({statuses: ['all'], limit: 2, cursor: first.next_cursor}));
  assert.deepEqual(
    second.previews.map(p => [p.tweet_id, p.promoted_tweet_ids]),
    [
      [tweet(3), ['pt3']],
      [tweet(4), ['pt4']],
    ],
  );
  assert.equal(second.has_more, false);
  assert.equal(second.next_cursor, null);
  // The cursor is the tool’s own, bound to the selection: another selection refuses it.
  assertRefused(await f.previews({statuses: ['paused'], limit: 2, cursor: first.next_cursor}), 'INVALID_CURSOR');
  // A cursor with named IDs is refused as for every platform.
  assertRefused(await f.previews({ad_ids: ['pt1'], cursor: first.next_cursor}), 'INVALID_CURSOR');
});

test('a scan continues on X’s own cursor into the next native page until it has limit matches', async t => {
  const promoted = [
    ...Array.from({length: 120}, (_, i) => promotion('pa' + i, tweet(1000 + i), 'li1', {entity_status: 'PAUSED'})),
    ...Array.from({length: 3}, (_, i) => promotion('px' + i, tweet(2000 + i), 'li1')),
  ];
  const f = fixture(t, world({promoted})),
    data = ok(await f.previews({limit: 2}));
  assert.deepEqual(
    data.previews.map(p => p.promoted_tweet_ids),
    [['px0'], ['px1']],
  );
  assert.equal(data.has_more, true);
  assert.deepEqual(
    f.reads('/promoted_tweets').map(r => r.query),
    [
      {count: '100', with_deleted: 'false'},
      {count: '100', with_deleted: 'false', cursor: '100'},
    ],
  );
  const rest = ok(await f.previews({limit: 2, cursor: data.next_cursor}));
  assert.deepEqual(
    rest.previews.map(p => p.promoted_tweet_ids),
    [['px2']],
  );
  assert.equal(rest.has_more, false);
});

test('an answer that is not an X collection with an explicit boundary, one account and unique IDs is refused, not guessed at', async t => {
  const refusedShape = async (over, code = 'REPORT_SHAPE_CHANGED') => {
    const f = fixture(t, world(over));
    assertRefused(await f.previews(), code);
    assert.equal(f.reads('/tweet_previews').length, 0, 'nothing is previewed from an answer that was refused');
  };
  await refusedShape({omitCursor: true});
  await refusedShape({promoted: [promotion('pt1', 190000000000000000, 'li1')]});
  await refusedShape({promoted: [promotion('pt1', tweet(1), 'li1'), promotion('pt1', tweet(2), 'li1')]});
  await refusedShape({promoted: [promotion('Bad ID', tweet(1), 'li1')]});
  await refusedShape({promoted: [promotion('pt1', 'not-a-tweet', 'li1')]});
  await refusedShape({promoted: [promotion('pt1', '0123', 'li1')]});
  await refusedShape({promoted: [promotion('pt1', '1'.repeat(26), 'li1')]});
  await refusedShape({promoted: [promotion('pt1', tweet(1), 'Bad Line')]});
  await refusedShape({promoted: [promotion('pt1', tweet(1), 'li1', {deleted: 0})]});
  await refusedShape(
    {promoted: [{...promotion('pt1', tweet(1), 'li1'), account_id: 'other'}]},
    'ACCOUNT_SCOPE_MISMATCH',
  );
  await refusedShape({echoAccount: 'other'}, 'ACCOUNT_SCOPE_MISMATCH');
});

test('a named ID the account does not hold is reported not found and never reaches a preview read, whoever X would answer for', async t => {
  // tweet(77) is previewable by X (the fixture answers for it) but is none of the account’s dark Tweets or promoted Tweets.
  const f = fixture(t),
    data = ok(await f.previews({ad_ids: [tweet(77), 'zz9', 'Bad:ID']}));
  assert.deepEqual(data.previews, []);
  assert.deepEqual(data.not_found, [tweet(77), 'zz9', 'Bad:ID']);
  assert.equal(data.not_found_reason, 'Not in this account');
  assert.equal(f.reads('/tweet_previews').length, 0);
  assert.doesNotMatch(JSON.stringify(f.log), /Bad/, 'an ID of no known shape is not sent to X');
  // A Tweet that is promoted but not dark is not one of the account’s dark Tweets: name its promoted-Tweet ID instead.
  const promotedOnly = ok(await f.previews({ad_ids: [tweet(3)]}));
  assert.deepEqual(promotedOnly.previews, []);
  assert.deepEqual(promotedOnly.not_found, [tweet(3)]);
  // Named with its promotion, the Tweet is proven by the promotion: no search of the dark Tweets, one entry, nothing missing.
  const tweetReads = f.reads('/tweets').length,
    withPromotion = ok(await f.previews({ad_ids: [tweet(3), 'pt3']}));
  assert.deepEqual(
    withPromotion.previews.map(p => [p.tweet_id, p.promoted_tweet_ids]),
    [[tweet(3), ['pt3']]],
  );
  assert.equal(withPromotion.not_found, undefined);
  assert.equal(f.reads('/tweets').length, tweetReads);
  assert.equal(f.reads('/tweet_previews').at(-1).query.tweet_ids, tweet(3), 'only the proven Tweet is asked for');
});

test('named IDs ignore statuses, but the campaign and line item filters still apply to them', async t => {
  const f = fixture(t);
  // pt4 is a deleted promotion: a named ID is read with deleted ones listed.
  const deleted = ok(await f.previews({ad_ids: ['pt4']}));
  assert.deepEqual(
    deleted.previews.map(p => p.promoted_tweet_ids),
    [['pt4']],
  );
  assert.equal(f.reads('/promoted_tweets').at(-1).query.with_deleted, 'true');
  // pt1 is in line item li1, so a filter for li2 leaves it out and says why.
  const filtered = ok(await f.previews({ad_ids: ['pt1'], adset_ids: ['li2']}));
  assert.deepEqual(filtered.previews, []);
  assert.deepEqual(filtered.not_found, ['pt1']);
  assert.equal(
    filtered.not_found_reason,
    'No matching ad in this account for the selected campaign and ad set filters.',
  );
  // pt2 is in li2, whose campaign is cm2.
  const matching = ok(await f.previews({ad_ids: ['pt2'], campaign_ids: ['cm2']}));
  assert.deepEqual(
    matching.previews.map(p => p.promoted_tweet_ids),
    [['pt2']],
  );
  assert.deepEqual(f.reads('/line_items').at(-1).query, {
    line_item_ids: 'li2',
    with_deleted: 'true',
    with_draft: 'true',
    count: named,
  });
  // A dark Tweet has no campaign or line item to match: with a filter it is left out, and X’s Tweets are not even read.
  const before = f.reads('/tweets').length,
    dark = ok(await f.previews({ad_ids: [tweet(90)], campaign_ids: ['cm1']}));
  assert.deepEqual(dark.not_found, [tweet(90)]);
  assert.equal(f.reads('/tweets').length, before);
});

test('named IDs are asked for once, and two IDs of one Tweet are one entry, in the order named', async t => {
  const f = fixture(t),
    data = ok(await f.previews({ad_ids: ['pt2', 'pt1', 'pt1', tweet(90), tweet(90)]}));
  assert.deepEqual(data.previews, [entry(tweet(1), ['pt2', 'pt1']), entry(tweet(90), [], 'Dark launch')]);
  assert.equal(f.reads('/promoted_tweets')[0].query.promoted_tweet_ids, 'pt2,pt1');
  assert.equal(f.reads('/tweets')[0].query.tweet_ids, tweet(90));
  assert.equal(f.reads('/tweet_previews').length, 1);
});

test('a read that names its IDs asks for a page larger than them, so an answer with exactly those IDs is complete', async t => {
  // X may end a page that is exactly as large as the page size it was asked for with a cursor, as a collection that cannot tell
  // whether another row follows does: a page the size of the IDs named would then look incomplete when every ID was found.
  const f = fixture(t, world({fullPageCursor: true})),
    all = ok(await f.previews({ad_ids: ['pt1', 'pt2', tweet(90)]}));
  assert.deepEqual(
    all.previews.map(p => [p.tweet_id, p.promoted_tweet_ids]),
    [
      [tweet(1), ['pt1', 'pt2']],
      [tweet(90), []],
    ],
  );
  const lines = ok(await f.previews({ad_ids: ['pt1', 'pt2'], campaign_ids: ['cm1', 'cm2']}));
  assert.deepEqual(
    lines.previews.map(p => p.promoted_tweet_ids),
    [['pt1', 'pt2']],
  );
  const reads = f.log.filter(r => r.path !== '/tweet_previews');
  assert.deepEqual([...new Set(reads.map(r => r.path))].sort(), ['/line_items', '/promoted_tweets', '/tweets']);
  for (const read of reads) assert.equal(read.query.count, named, read.path);
  // The list of the account's promoted Tweets is not one of them: it is read a page of 100 at a time, as before.
  assert.equal(ok(await f.previews()).has_more, false, 'a list with fewer rows than its page ends where X ends it');
  assert.equal(f.reads('/promoted_tweets').at(-1).query.count, '100');
});

test('a Tweet X does not answer for is reported missing, an extra or doubled answer is not taken, and nothing is dropped silently', async t => {
  const w = world({
    silent: new Set([tweet(1)]),
    duplicate: new Set([tweet(90)]),
    extraEntries: [{tweet_id: tweet(55), preview: iframe(link(tweet(55)))}],
  });
  const f = fixture(t, w),
    data = ok(await f.previews({ad_ids: ['pt1', tweet(90)]}));
  assert.equal(data.previews.length, 2, 'one entry for each Tweet asked for');
  const [missing, doubled] = data.previews;
  assert.deepEqual(missing, {
    ad_id: tweet(1),
    name: null,
    tweet_id: tweet(1),
    promoted_tweet_ids: ['pt1'],
    links: [],
    reason: 'not_returned',
    note: xPreviewReasons.not_returned,
  });
  // Two answers for one Tweet cannot both be its preview: neither is taken.
  assert.deepEqual(
    [doubled.links, doubled.reason, doubled.note],
    [[], 'link_not_accepted', xPreviewReasons.link_not_accepted],
  );
  assert.doesNotMatch(
    JSON.stringify(data),
    new RegExp(tweet(55) + '|' + tweet(66)),
    'an entry X was not asked for is not returned',
  );
  // The reasons are a closed set, each with its sentence.
  assert.deepEqual(Object.keys(xPreviewReasons).sort(), ['link_not_accepted', 'not_returned']);
});

// What X's snippet may be and what it may not. The good ones keep what the live answer has (single quotes, no closing tag), and
// the other spellings an HTML parser reads the same way; the link returned is always the validated URL, never the snippet.
const goodPath = '/ads-manager/tweet-preview/index.html';
const accepted = [
  ['the live shape', `<iframe class='tweet-preview' src='${host}?data=A%2FB%3D'>`, host + '?data=A%2FB%3D'],
  ['a closing tag', `<iframe class='tweet-preview' src='${host}?data=A'></iframe>`, host + '?data=A'],
  [
    'double quotes and other attributes',
    `<iframe width="300" height="400" src="${host}?data=A" frameborder="0">`,
    host + '?data=A',
  ],
  ['upper-case names', `<IFRAME CLASS='x' SRC='${host}?data=A'>`, host + '?data=A'],
  ['&amp; between parameters', `<iframe src='${host}?data=A&amp;lang=en'>`, host + '?data=A&lang=en'],
  ['a raw & between parameters', `<iframe src='${host}?data=A&lang=en'>`, host + '?data=A&lang=en'],
  ['surrounding white space', `\n  <iframe src='${host}?data=A'>  \n`, host + '?data=A'],
  [
    'an upper-case host, which is the same host',
    `<iframe src='HTTPS://TON.TWIMG.COM${goodPath}?data=A'>`,
    host + '?data=A',
  ],
  ['the default port spelt out', `<iframe src='https://ton.twimg.com:443${goodPath}?data=A'>`, host + '?data=A'],
  [
    'a dot segment that resolves to the path',
    `<iframe src='https://ton.twimg.com/ads-manager/x/../tweet-preview/index.html?data=A'>`,
    host + '?data=A',
  ],
  ['no query at all', `<iframe src='${host}'>`, host],
];
const refused = [
  ['another host', `<iframe src='https://evil.example${goodPath}?data=A'>`],
  ['a sub-domain of the host', `<iframe src='https://x.ton.twimg.com${goodPath}?data=A'>`],
  ['the host as a prefix of another', `<iframe src='https://ton.twimg.com.evil.example${goodPath}?data=A'>`],
  ['a host that only ends like it', `<iframe src='https://evilton.twimg.com${goodPath}?data=A'>`],
  ['the parent domain', `<iframe src='https://twimg.com${goodPath}?data=A'>`],
  ['a trailing dot', `<iframe src='https://ton.twimg.com.${goodPath}?data=A'>`],
  ['X’s older guide host', `<iframe src='https://ton.smf1.x.com${goodPath}?data=A'>`],
  ['a host behind user information', `<iframe src='https://ton.twimg.com@evil.example${goodPath}?data=A'>`],
  ['user information', `<iframe src='https://user:pw@ton.twimg.com${goodPath}?data=A'>`],
  ['a user name only', `<iframe src='https://user@ton.twimg.com${goodPath}?data=A'>`],
  ['another port', `<iframe src='https://ton.twimg.com:8443${goodPath}?data=A'>`],
  ['http', `<iframe src='http://ton.twimg.com${goodPath}?data=A'>`],
  ['a protocol-relative URL', `<iframe src='//ton.twimg.com${goodPath}?data=A'>`],
  ['a relative path', `<iframe src='${goodPath}?data=A'>`],
  ['a javascript: URL', `<iframe src='javascript:alert(1)'>`],
  ['a javascript: URL that names the host', `<iframe src='javascript://ton.twimg.com${goodPath}%0Aalert(1)'>`],
  ['a data: URL', `<iframe src='data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;'>`],
  ['a blob: URL', `<iframe src='blob:https://ton.twimg.com/1234'>`],
  ['another path', `<iframe src='https://ton.twimg.com/ads-manager/tweet-preview/other.html?data=A'>`],
  ['the directory only', `<iframe src='https://ton.twimg.com/ads-manager/tweet-preview/?data=A'>`],
  ['a longer path', `<iframe src='${host}/more?data=A'>`],
  ['an upper-case path', `<iframe src='https://ton.twimg.com/Ads-Manager/Tweet-Preview/index.html?data=A'>`],
  [
    'an encoded slash in the path',
    `<iframe src='https://ton.twimg.com/ads-manager%2Ftweet-preview/index.html?data=A'>`,
  ],
  [
    'a dot segment that leaves the path',
    `<iframe src='https://ton.twimg.com/ads-manager/tweet-preview/../index.html?data=A'>`,
  ],
  ['a backslash in the host', `<iframe src='https://evil.example\\@ton.twimg.com${goodPath}?data=A'>`],
  ['a fragment', `<iframe src='${host}?data=A#x'>`],
  ['an entity for a slash in the host', `<iframe src='https://evil.example&sol;ton.twimg.com${goodPath}?data=A'>`],
  ['an entity for a dot in the host', `<iframe src='https://ton.twimg.com&period;evil.example${goodPath}?data=A'>`],
  ['an entity in the path', `<iframe src='https://ton.twimg.com/ads-manager&sol;tweet-preview/index.html?data=A'>`],
  ['a numeric entity', `<iframe src='https://ton.twimg.com&#47;ads-manager/tweet-preview/index.html'>`],
  ['a semicolon before the query', `<iframe src='https://ton.twimg.com;evil.example/${goodPath}?data=A'>`],
  ['an entity left after decoding &amp;', `<iframe src='${host}?data=A&amp;amp;x=1'>`],
  ['white space inside the URL', `<iframe src='${host}?data=A B'>`],
  ['a tab inside the URL', `<iframe src='https://ton.twimg.com${goodPath}\t?data=A'>`],
  ['an angle bracket inside the URL', `<iframe src='${host}?data=<A>'>`],
  ['no src', `<iframe class='tweet-preview'>`],
  ['an empty src', `<iframe src=''>`],
  ['two src attributes', `<iframe src='${host}?data=A' src='https://evil.example/'>`],
  ['the same attribute twice with other spelling', `<iframe src='${host}?data=A' SRC='https://evil.example/'>`],
  ['an srcdoc beside the src', `<iframe srcdoc='<script>alert(1)</script>' src='${host}?data=A'>`],
  ['an srcdoc without markup beside the src', `<iframe srcdoc='plain' src='${host}?data=A'>`],
  ['an upper-case SRCDOC beside the src', `<iframe SRCDOC='plain' src='${host}?data=A'>`],
  ['a backslash after the host', `<iframe src='https://ton.twimg.com\\ads-manager\\tweet-preview\\index.html?data=A'>`],
  ['an unterminated src', `<iframe class='tweet-preview' src='${host}?data=A`],
  ['an unterminated tag', `<iframe class='tweet-preview' src='${host}?data=A'`],
  ['an unquoted src with a quote in it', `<iframe src=${host}?data="A">`],
  ['a src of quotes that do not match', `<iframe src='${host}?data=A">`],
  ['an attribute that is not well formed', `<iframe class='tweet-preview' src='${host}?data=A' ="x">`],
  ['attributes with no space between them', `<iframe class='tweet-preview'src='${host}?data=A'>`],
  ['markup before the iframe', `<script>alert(1)</script><iframe src='${host}?data=A'>`],
  ['markup after the iframe', `<iframe src='${host}?data=A'></iframe><script>alert(1)</script>`],
  ['text after the iframe', `<iframe src='${host}?data=A'> open it`],
  ['a wrapper element', `<div><iframe src='${host}?data=A'></iframe></div>`],
  ['two iframes', `<iframe src='${host}?data=A'><iframe src='${host}?data=B'>`],
  ['an iframe whose tag is not closed by >', `<iframe src='${host}?data=A'<`],
  ['another element', `<img src='${host}?data=A'>`],
  ['a link element', `<a href='${host}?data=A'>`],
  ['no markup, only the URL', `${host}?data=A`],
  ['an empty string', ''],
  ['white space only', '   '],
  ['a snippet over the size cap', `<iframe src='${host}?data=${'A'.repeat(16384)}'>`],
  ['null', null],
  ['a number', 7],
  ['an object', {src: host}],
  ['an array of the snippet', [`<iframe src='${host}?data=A'>`]],
  ['undefined', undefined],
];

test('only an iframe whose src is exactly https://ton.twimg.com/ads-manager/tweet-preview/index.html yields a link, and the link is the validated URL', () => {
  for (const [what, snippet, expected] of accepted) assert.equal(xPreviewLink(snippet), expected, what);
  for (const [what, snippet] of refused) assert.equal(xPreviewLink(snippet), null, what);
  // A snippet at the cap is read, one byte over is not.
  const atCap = `<iframe src='${host}?data=` + 'A'.repeat(16384 - `<iframe src='${host}?data=`.length - 2) + `'>`;
  assert.equal(atCap.length, 16384);
  assert.equal(xPreviewLink(atCap), host + '?data=' + 'A'.repeat(16384 - `<iframe src='${host}?data=`.length - 2));
  assert.equal(xPreviewLink(atCap + ' '), null);
});

test('the tool returns no link for a hostile or malformed snippet, with a closed-set reason, and none of its markup or text', async t => {
  const w = world(),
    f = fixture(t, w),
    hostile = refused.filter(([, snippet]) => typeof snippet === 'string');
  for (const [what, snippet] of hostile) {
    w.snippet = () => snippet;
    const data = ok(await f.previews({ad_ids: ['pt1']}));
    assert.equal(data.previews.length, 1, what);
    const [one] = data.previews;
    assert.deepEqual(one.links, [], what);
    assert.equal(one.reason, 'link_not_accepted', what);
    assert.equal(one.note, xPreviewReasons.link_not_accepted, what);
    assert.equal(one.expires, undefined, what + ': no expiry is stated for a link that is not returned');
    // Nothing of what X sent comes back: the answer holds the Tweet, its promotion and the fixed reason.
    assert.deepEqual(
      Object.keys(one).sort(),
      ['ad_id', 'links', 'name', 'note', 'promoted_tweet_ids', 'reason', 'tweet_id'],
      what,
    );
    assert.doesNotMatch(JSON.stringify(data), /evil|javascript|<|alert|srcdoc|iframe|ton\.twimg|data:/i, what);
  }
});

test('X’s HTML is never passed through: no markup, no snippet, and a link only as the validated URL', async t => {
  const f = fixture(t),
    out = ok(await f.previews({ad_ids: ['pt1', tweet(90)]})),
    text = JSON.stringify(out);
  assert.doesNotMatch(text, /<iframe|<\/|class=|tweet-preview'/);
  // The assertions below are about entries that exist: an answer with none would pass them without saying anything.
  assert.equal(out.previews.length, 2);
  for (const p of out.previews) {
    assert.equal(p.links.length, 1);
    assert.equal(p.preview, undefined);
    assert.ok(
      p.links.every(l =>
        /^https:\/\/ton\.twimg\.com\/ads-manager\/tweet-preview\/index\.html\?data=[A-Za-z0-9%]+$/.test(l),
      ),
    );
  }
  // The text of a dark Tweet is the provider’s content and is not part of a preview: only its name is.
  assert.doesNotMatch(text, /SYNTHETIC TWEET TEXT/);
});

test('a link states that X names no expiry, and AMCP invents none', async t => {
  const f = fixture(t),
    out = ok(await f.previews({ad_ids: ['pt1']}));
  assert.match(xNoExpiry, /^X states no expiry/);
  assert.equal(out.previews[0].expires, xNoExpiry);
  assert.equal(out.previews[0].expires_at, undefined);
  assert.doesNotMatch(JSON.stringify(out), /expires_at|30 days|hours|minutes/);
});

test('Tweets are asked for in batches of at most the 200 X documents, in one read for a call’s ten', async t => {
  assert.equal(xTweetPreviewBatch, 200);
  const ids = Array.from({length: 450}, (_, i) => tweet(i + 1));
  assert.deepEqual(
    xPreviewBatches(ids).map(b => b.length),
    [200, 200, 50],
  );
  assert.deepEqual(xPreviewBatches(ids).flat(), ids, 'every ID once, in order');
  assert.deepEqual(
    xPreviewBatches(ids.slice(0, 200)).map(b => b.length),
    [200],
  );
  assert.deepEqual(
    xPreviewBatches(ids.slice(0, 201)).map(b => b.length),
    [200, 1],
  );
  assert.deepEqual(xPreviewBatches([]), []);
  // The record of the route states the same limit.
  assert.match(
    fs.readFileSync('docs/records/X-TWEET-PREVIEWS-PIN-2026-11-16.md', 'utf8'),
    new RegExp('up to ' + xTweetPreviewBatch + ' IDs'),
  );
  // The most a call names, ten Tweets, is one read.
  const dark = Array.from({length: 10}, (_, i) => darkTweet(100 + i, 'Dark ' + i)),
    f = fixture(t, world({dark})),
    out = ok(await f.previews({ad_ids: dark.map(r => r.id_str)}));
  assert.equal(out.previews.length, 10);
  assert.deepEqual(
    f.reads('/tweet_previews').map(r => r.query.tweet_ids.split(',').length),
    [10],
  );
});

test('X’s refusal of the preview read is each entry’s own diagnostic, and the call still answers', async t => {
  const f = fixture(t, world({previewStatus: 400})),
    out = ok(await f.previews({ad_ids: ['pt1', tweet(90)]}));
  assert.equal(out.previews.length, 2);
  for (const p of out.previews) {
    assert.deepEqual(p.links, []);
    assert.equal(typeof p.error?.code, 'string');
    assert.equal(typeof p.error?.message, 'string');
  }
  assert.equal(f.reads('/tweet_previews').length, 1, 'the refused batch is read once, not once per entry');
});

test('X’s preview answer is read as the documented one: its account and shape are checked, and an entry that names no asked-for Tweet answers none', async t => {
  // An answer that names another account, or whose data is not a bounded list, is each entry’s own refusal.
  for (const [over, code] of [
    [{echoPreviews: 'other'}, 'ACCOUNT_SCOPE_MISMATCH'],
    [{previewData: 'nope'}, 'REPORT_SHAPE_CHANGED'],
    [{previewData: Array.from({length: 1001}, () => ({}))}, 'REPORT_SHAPE_CHANGED'],
  ]) {
    const f = fixture(t, world(over)),
      out = ok(await f.previews({ad_ids: ['pt1']}));
    assert.deepEqual(
      out.previews.map(p => [p.links, p.error?.code]),
      [[[], code]],
    );
  }
  // Entries with no usable Tweet ID, a number for one, or an ID that was not asked for answer no Tweet: the one asked for is missing.
  const stray = fixture(
      t,
      world({
        previewData: [
          {preview: iframe(link(tweet(1)))},
          {tweet_id: 1900000000000000001, preview: iframe(link(tweet(1)))},
          null,
          'x',
          {tweet_id: tweet(55), preview: iframe(link(tweet(55)))},
        ],
      }),
    ),
    out = ok(await stray.previews({ad_ids: ['pt1']}));
  assert.deepEqual(
    out.previews.map(p => [p.links, p.reason]),
    [[[], 'not_returned']],
  );
});

test('a read that names its IDs is answered only for them, completely, and a dark Tweet must say it is one', async t => {
  const stranger = promotion('pt9', tweet(9), 'li1');
  for (const [what, over, ad_ids] of [
    ['a named promotion read X continues', {forceNext: true}, ['pt1']],
    ['a named Tweet read X continues', {forceNext: true}, [tweet(90)]],
    ['a promotion nobody named', {ignoreIds: true, promoted: [stranger]}, ['pt3']],
    ['a dark Tweet nobody named', {ignoreIds: true, dark: [darkTweet(91)]}, [tweet(90)]],
    ['a Tweet that is not nullcast', {dark: [{...darkTweet(90), nullcast: false}]}, [tweet(90)]],
    // Both IDs are among those asked for, so only their disagreement refuses the row.
    ['a Tweet whose two IDs disagree', {dark: [{...darkTweet(90), tweet_id: tweet(91)}]}, [tweet(90), tweet(91)]],
    ['a Tweet with no ID', {ignoreIds: true, dark: [{name: 'x', nullcast: true}]}, [tweet(90)]],
    ['a Tweet listed twice', {dark: [darkTweet(90), darkTweet(90)]}, [tweet(90), tweet(91)]],
    [
      'more Tweets than were named',
      {ignoreIds: true, ignoreCount: true, dark: [darkTweet(90), darkTweet(91)]},
      [tweet(90)],
    ],
    ['more promotions than were named', {ignoreIds: true, ignoreCount: true}, ['pt1']],
  ]) {
    const f = fixture(t, world(over));
    assertRefused(await f.previews({ad_ids}), 'REPORT_SHAPE_CHANGED');
    assert.equal(f.reads('/tweet_previews').length, 0, what + ': nothing is previewed from it');
  }
});

test('a page larger than the 100 it was asked for is refused, and so is a line item answer that does not describe the line items asked about', async t => {
  const many = Array.from({length: 101}, (_, i) => promotion('pm' + i, tweet(3000 + i), 'li1')),
    big = fixture(t, world({promoted: many, ignoreCount: true}));
  assertRefused(await big.previews(), 'REPORT_SHAPE_CHANGED');
  const line = (id, campaign_id = 'cm1') => ({id, campaign_id, entity_status: 'ACTIVE', deleted: false});
  // The campaign filter reads the page's two line items, li1 and li2.
  for (const [what, over, code] of [
    ['a line item nobody asked about', {ignoreIds: true, lineItems: [line('li9')]}, 'REPORT_SHAPE_CHANGED'],
    ['a line item listed twice', {lineItems: [line('li1'), line('li1')]}, 'REPORT_SHAPE_CHANGED'],
    ['a line item with no campaign', {lineItems: [line('li1', null), line('li2')]}, 'REPORT_SHAPE_CHANGED'],
    ['a campaign that is not an ID', {lineItems: [line('li1', 'Bad Campaign'), line('li2')]}, 'REPORT_SHAPE_CHANGED'],
    ['a continuation of the line items', {forceNext: true}, 'REPORT_SHAPE_CHANGED'],
    ['more line items than were asked about', {ignoreIds: true, ignoreCount: true}, 'REPORT_SHAPE_CHANGED'],
    [
      'a line item of another account',
      {lineItems: [{...line('li1'), account_id: 'other'}, line('li2')]},
      'ACCOUNT_SCOPE_MISMATCH',
    ],
  ]) {
    const f = fixture(t, world(over));
    assertRefused(await f.previews({campaign_ids: ['cm1']}), code);
    assert.equal(f.reads('/line_items').length, 1, what + ': the refusal is of the line items’ answer');
    assert.equal(f.reads('/tweet_previews').length, 0, what);
  }
});

test('the line items of a scan are asked about once, whatever page they come back on', async t => {
  const promoted = [
      ...Array.from({length: 120}, (_, i) => promotion('pa' + i, tweet(1000 + i), 'li1')),
      ...Array.from({length: 3}, (_, i) => promotion('pp' + i, tweet(2000 + i), 'li1', {entity_status: 'PAUSED'})),
    ],
    f = fixture(t, world({promoted})),
    out = ok(await f.previews({statuses: ['paused'], campaign_ids: ['cm1'], limit: 3}));
  assert.deepEqual(
    out.previews.map(p => p.promoted_tweet_ids),
    [['pp0'], ['pp1'], ['pp2']],
  );
  assert.equal(f.reads('/promoted_tweets').length, 2, 'the scan read two native pages');
  assert.deepEqual(
    f.reads('/line_items').map(r => r.query.line_item_ids),
    ['li1'],
  );
});

test('a list ends where X ends it, with a null cursor or the older zero or empty one, and any other cursor must be a plain token', async t => {
  for (const endAs of [null, '0', 0, '']) {
    const f = fixture(t, world({endAs})),
      out = ok(await f.previews());
    assert.equal(out.has_more, false, JSON.stringify(endAs));
    assert.equal(f.reads('/promoted_tweets').length, 1, JSON.stringify(endAs));
  }
  for (const forceNext of ['two words', {cursor: 'x'}, 'x'.repeat(2049), 'tab\tin', 'é']) {
    const f = fixture(t, world({forceNext}));
    assertRefused(await f.previews(), 'REPORT_SHAPE_CHANGED');
  }
});

test('a dark Tweet is identified by its id_str, or by a string tweet_id, and a number in another field of its row is not taken for an ID', async t => {
  for (const [what, row] of [
    ['a numeric tweet_id beside the id_str', {...darkTweet(90), tweet_id: 1900000000000000090}],
    ['a numeric id beside the id_str', {...darkTweet(90), id: 1900000000000000090}],
    ['no id_str and a string tweet_id', {name: 'Dark launch', nullcast: true, tweet_id: tweet(90)}],
  ]) {
    const f = fixture(t, world({dark: [row], ignoreIds: true, previewable: new Set([tweet(90)])})),
      data = ok(await f.previews({ad_ids: [tweet(90)]}));
    assert.deepEqual(
      data.previews.map(p => [p.tweet_id, p.links.length]),
      [[tweet(90), 1]],
      what,
    );
  }
  // A row whose only ID is a number names no Tweet: a number in a JSON answer may not be the ID it was written as.
  const f = fixture(t, world({dark: [{name: 'x', nullcast: true, tweet_id: 1900000000000000090}], ignoreIds: true}));
  assertRefused(await f.previews({ad_ids: [tweet(90)]}), 'REPORT_SHAPE_CHANGED');
  assert.equal(f.reads('/tweet_previews').length, 0);
});

test('a DRAFT promotion is selected by "all" alone, and a promotion that names no line item only without a parent filter', async t => {
  const promoted = [
      promotion('pd1', tweet(11), 'li1', {entity_status: 'DRAFT'}),
      promotion('pn1', tweet(12), undefined),
    ],
    f = fixture(t, world({promoted})),
    select = async over => ok(await f.previews(over)).previews.map(p => p.promoted_tweet_ids.join());
  assert.deepEqual(await select({}), ['pn1']);
  assert.deepEqual(await select({statuses: ['paused', 'archived']}), []);
  assert.deepEqual(await select({statuses: ['all']}), ['pd1', 'pn1']);
  assert.deepEqual(await select({statuses: ['all'], campaign_ids: ['cm1']}), ['pd1']);
  // X filters by line item itself; one that answered without doing it still selects only what names the line item.
  const lax = fixture(t, world({promoted, ignoreFilters: true}));
  assert.deepEqual(
    ok(await lax.previews({statuses: ['all'], adset_ids: ['li1']})).previews.map(p => p.promoted_tweet_ids.join()),
    ['pd1'],
  );
});

test('the gates of the tool stay: a connection and account of X are needed, X takes no placement, and its filters are X’s own IDs', async t => {
  const f = fixture(t);
  assertRefused(await f.previews({account_id: 'another'}), 'CONNECTION_REQUIRED');
  assertRefused(await f.previews({connection_id: 'bbbbbbbb-2222-4222-8222-000000000002'}), 'CONNECTION_REQUIRED');
  assertRefused(await f.previews({ad_format: 'MOBILE_FEED_STANDARD'}), 'INVALID_ARGUMENT');
  assertRefused(await f.previews({campaign_ids: ['a:b']}), 'INVALID_ARGUMENT', {
    message: /X preview filters use X’s own IDs/,
  });
  assertRefused(await f.previews({adset_ids: ['UPPER']}), 'INVALID_ARGUMENT', {
    message: /X preview filters use X’s own IDs/,
  });
  assert.deepEqual(f.log, [], 'a refused request makes no read');
  // A connection of X cannot serve another platform’s previews.
  assertRefused(await f.previews({platform: 'meta'}), 'CONNECTION_REQUIRED');
});

test('the help of the tool says what X’s ad_ids and adset_ids are, keeps what it said of the others, and tools/list says nothing of X', async t => {
  // The tool by its listed name: a literal call of a default-call tool with `action` is read by the scan of
  // tests/first-party-contracts.test.mjs as a call of that default action, which has no `action` argument.
  const f = fixture(t),
    name = f.service.firstPartyTools().find(tool => tool.name === 'amcp_ad_previews').name,
    help = ok(await f.service.call(name, {action: 'help'}, f.actor)),
    notes = help.contract.arguments_schema.properties;
  assert.match(notes.ad_ids.description, /X: promoted Tweet IDs or the ID of a dark Tweet/);
  assert.match(notes.adset_ids.description, /X line item IDs/);
  // What the notes said of the other platforms stays (tests/mcp-listing-budget.test.mjs pins the same sentences).
  assert.match(notes.ad_ids.description, /Snapchat and LinkedIn: creative IDs; Google Ads: asset group IDs/);
  assert.match(notes.ad_ids.description, /Named IDs ignore statuses/);
  assert.match(notes.adset_ids.description, /Snapchat ad squad IDs; LinkedIn native campaign IDs/);
  // The notes are not in tools/list, whose routing summary of the tool names no platform but Meta's placement
  // (tests/tool-surface-golden.test.mjs pins it whole).
  const listed = f.service.listTools().find(tool => tool.name === 'amcp_ad_previews');
  assert.equal(listed.inputSchema.properties.ad_ids.description, undefined);
  assert.doesNotMatch(listed.description, /\bX\b|Tweet/);
});

test('a preview call leaves no preview link in the audit trail', async t => {
  const f = fixture(t);
  ok(await f.previews({ad_ids: ['pt1', tweet(90)]}));
  const rows = f.store.db.prepare('SELECT * FROM audit WHERE tenant_id=?').all(f.actor.tenantId),
    text = JSON.stringify(rows);
  assert.ok(rows.length > 0, 'the reads are audited');
  assert.doesNotMatch(text, /ton\.twimg\.com|SYNTHETIC|tweet-preview/);
});
