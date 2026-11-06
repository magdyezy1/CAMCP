// V2-PRV-01 hardening of amcp_ad_previews (audit F-L3-12 and F-L3-13): the platform is checked against the tool's own
// list before anything else, and a link whose separators are spelled as entities is not a platform link.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AdPreviews, previewLinks} from '../dist/src/ad-previews.js';
import {linkedInPreviewLinks} from '../dist/src/linkedin-ad-previews.js';
import {Store} from '../dist/src/store.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const actor = {tenantId: 'synthetic-preview-hardening', userId: 'owner', role: 'admin'};
const fixture = t => {
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64')),
    reads = [];
  t.after(() => store.close());
  const call = async (_tool, input) => {
    reads.push(input);
    return assert.fail('no read');
  };
  return {reads, previews: new AdPreviews(call, store)};
};

test('F-L3-12: a platform outside the schema is refused first, with no read, whatever else the request holds', async t => {
  const {previews, reads} = fixture(t);
  // Names a plain object answers to, a differently spelt platform, a platform of another kind and a missing one.
  const platforms = [
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'Meta',
    'meta ',
    '',
    undefined,
    null,
    7,
    ['meta'],
    {},
  ];
  // Each is refused for the platform even when the request is also wrong elsewhere: the platform is checked first.
  for (const platform of platforms)
    for (const extra of [{}, {account_id: ' '}, {limit: 99}, {ad_ids: []}, {connection_id: 4}, {cursor: 'x'}])
      await assert.rejects(
        previews.handle({...(platform === undefined ? {} : {platform}), account_id: '1', ...extra}, actor),
        error =>
          assertRefused(error, 'INVALID_ARGUMENT', {message: /^Choose a platform from the schema\.$/}) &&
          error.details.field === 'platform',
        JSON.stringify([platform, extra]),
      );
  assert.equal(reads.length, 0);
  // The platforms of the schema still answer.
  for (const platform of ['google_ads', 'x_ads', 'microsoft_ads', 'dv360', 'criteo', 'apple_ads']) {
    const out = await previews.handle({platform, account_id: '1'}, actor);
    assert.equal(out.platform, platform);
    assert.deepEqual(out.previews, []);
  }
});

// An HTML parser reads `&sol;` in a src as "/", so a tag whose host is "evil.com&sol;.linkedin.com" would send a browser
// to evil.com, while the URL parser reads the whole text as a host that ends in ".linkedin.com". Only the text before
// the first "?" can name a host or a path; there, an entity (`&`) or a `;` is never part of a platform link.
const separators = ['&sol;', '&bsol;', '&colon;', '&num;', '&quest;', '&commat;', '&#47;', '&#x2f;', '&amp;', ';'];

test('F-L3-13: a LinkedIn preview src whose host or path spells a separator as an entity is no link', () => {
  const now = Date.UTC(2026, 10, 3),
    link = src => linkedInPreviewLinks([{preview: '<iframe src="' + src + '"></iframe>'}], now).map(l => l.url);
  for (const separator of separators) {
    assert.deepEqual(link('https://evil.com' + separator + '.linkedin.com/x'), [], 'host ' + separator);
    assert.deepEqual(link('https://www.linkedin.com/ads' + separator + 'preview/?d=1'), [], 'path ' + separator);
  }
  // The same entities in the query, where the platform puts its own separators, still make a link.
  assert.deepEqual(link('https://www.linkedin.com/ads/ad-preview/?d=synthetic&amp;v=1&amp;w=2'), [
    'https://www.linkedin.com/ads/ad-preview/?d=synthetic&v=1&w=2',
  ]);
  assert.deepEqual(link('https://www.linkedin.com/ads/ad-preview/?d=a;b'), [
    'https://www.linkedin.com/ads/ad-preview/?d=a;b',
  ]);
});

test('F-L3-13: the platform links of Meta, TikTok and Reddit refuse the same spellings, in markup and in plain strings', () => {
  const hosts = {meta: 'facebook.com', tiktok: 'tiktok.com', reddit: 'reddit.com'};
  for (const [platform, host] of Object.entries(hosts)) {
    for (const separator of separators) {
      const bad = 'https://evil.com' + separator + '.' + host + '/x';
      assert.deepEqual(previewLinks(platform, bad), [], platform + ' string ' + separator);
      assert.deepEqual(
        previewLinks(platform, {body: '<iframe src="' + bad + '"></iframe>'}),
        [],
        platform + ' src ' + separator,
      );
      assert.deepEqual(
        previewLinks(platform, {body: '<a href="' + bad + '">x</a>'}),
        [],
        platform + ' href ' + separator,
      );
    }
    const good = 'https://www.' + host + '/ads/p?d=1&amp;t=2';
    assert.deepEqual(previewLinks(platform, {body: '<iframe src="' + good + '"></iframe>'}), [
      'https://www.' + host + '/ads/p?d=1&t=2',
    ]);
  }
});

// Design note 4: Snapchat's and Reddit's continuation checks were written again in the previews tool, with their own parameter
// sets. The tool now takes the checks of the readers that already had them (src/snapchat-paging.ts, src/reddit-paging.ts);
// these pin what it refuses, so a link that leaves the request's origin, route or parameters is never followed.
const loginId = 'aaaaaaaa-1111-4111-8111-000000000001';
const connectionFor = (t, gateway, extra = {}) => {
  const store = new Store(':memory:', Buffer.alloc(32, 94).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: loginId,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['r_ads', 'ads_read'],
      ...extra,
    },
    {accessToken: 'synthetic'},
  );
  return store;
};
const refusedShape = (out, what) =>
  assertRefused(out, 'REPORT_SHAPE_CHANGED', {message: /invalid preview list or continuation/}) || what;

test('Snapchat: a continuation that leaves the request’s origin, route or parameters is refused, and a valid one is taken', async t => {
  const base = 'https://adsapi.snapchat.com/v1/adaccounts/100/ads';
  const hostile = {
    'another origin': 'https://example.invalid/v1/adaccounts/100/ads?limit=100&sort=created_at-desc&cursor=c2',
    'another account': 'https://adsapi.snapchat.com/v1/adaccounts/200/ads?limit=100&sort=created_at-desc&cursor=c2',
    'another route': 'https://adsapi.snapchat.com/v1/adaccounts/100/creatives?limit=100&sort=created_at-desc&cursor=c2',
    'userinfo': 'https://user:pw@adsapi.snapchat.com/v1/adaccounts/100/ads?limit=100&sort=created_at-desc&cursor=c2',
    'a user name only':
      'https://user@adsapi.snapchat.com/v1/adaccounts/100/ads?limit=100&sort=created_at-desc&cursor=c2',
    'a password only': 'https://:pw@adsapi.snapchat.com/v1/adaccounts/100/ads?limit=100&sort=created_at-desc&cursor=c2',
    'a fragment': base + '?limit=100&sort=created_at-desc&cursor=c2#x',
    'a changed limit': base + '?limit=1000&sort=created_at-desc&cursor=c2',
    'an added parameter': base + '?limit=100&sort=created_at-desc&cursor=c2&read_deleted_entities=true',
    'a repeated cursor': base + '?limit=100&sort=created_at-desc&cursor=c2&cursor=c3',
    'no cursor': base + '?limit=100&sort=created_at-desc',
    'an empty cursor': base + '?limit=100&sort=created_at-desc&cursor=',
    'a cursor with a space': base + '?limit=100&sort=created_at-desc&cursor=c%202',
    'a cursor with a control character': base + '?limit=100&sort=created_at-desc&cursor=c%0A2',
    'a cursor too long to seal': base + '?limit=100&sort=created_at-desc&cursor=' + 'c'.repeat(2049),
    'a link too long to read': base + '?limit=100&sort=created_at-desc&cursor=c2&x=' + 'c'.repeat(8200),
    'not text': 12345,
  };
  const answer = link => ({
    request_status: 'SUCCESS',
    ads: [{sub_request_status: 'SUCCESS', ad: {id: 'a1', creative_id: 'cr1', name: 'A', status: 'ACTIVE'}}],
    paging: {next_link: link},
  });
  for (const [what, link] of Object.entries(hostile)) {
    const reads = [],
      previews = new AdPreviews(
        async (_tool, input) => {
          reads.push(input.action);
          return {success: true, data: {data: answer(link)}};
        },
        connectionFor(t, 'snapchat_native_action'),
      );
    await assert.rejects(
      previews.handle({platform: 'snapchat', account_id: '100', connection_id: loginId}, actor),
      error => refusedShape(error, what),
      what,
    );
    // Nothing was followed, and no creative or preview was read behind it.
    assert.deepEqual(reads, ['snapchat_ad_list'], what);
  }
  // Paging that holds more than the link is refused too, and its link is not followed: a second list read would be one.
  const extraReads = [];
  const extraKey = new AdPreviews(
    async (_tool, input) => {
      extraReads.push(input.action);
      if (extraReads.length > 1) throw new Error('the link was followed');
      return {
        success: true,
        data: {
          data: {
            ...answer(base + '?limit=100&sort=created_at-desc&cursor=c2'),
            paging: {next_link: base + '?limit=100&sort=created_at-desc&cursor=c2', total: 9},
          },
        },
      };
    },
    connectionFor(t, 'snapchat_native_action'),
  );
  await assert.rejects(
    extraKey.handle({platform: 'snapchat', account_id: '100', connection_id: loginId}, actor),
    error => refusedShape(error),
  );
  assert.deepEqual(extraReads, ['snapchat_ad_list']);
  // The request's own link is taken: the scan goes on to the page the cursor names (and stops there, in this test).
  let pages = 0;
  const good = new AdPreviews(
    async (_tool, input) => {
      assert.equal(input.action, 'snapchat_ad_list');
      if (pages++ === 0)
        return {success: true, data: {data: answer(base + '?limit=100&sort=created_at-desc&cursor=c2')}};
      assert.equal(input.query.cursor, 'c2');
      throw new Error('stop');
    },
    connectionFor(t, 'snapchat_native_action'),
  );
  await assert.rejects(good.handle({platform: 'snapchat', account_id: '100', connection_id: loginId}, actor), /stop/);
});
test('Reddit: a continuation that leaves the request’s origin, route or parameters is refused, and a named read has none', async t => {
  const base = 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_100/ads';
  const hostile = {
    'another origin': 'https://example.invalid/api/v3/ad_accounts/a2_100/ads?page.size=100&page.token=t2',
    'another account': 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_200/ads?page.size=100&page.token=t2',
    'another route': 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_100/campaigns?page.size=100&page.token=t2',
    'userinfo': 'https://user:pw@ads-api.reddit.com/api/v3/ad_accounts/a2_100/ads?page.size=100&page.token=t2',
    'a user name only': 'https://user@ads-api.reddit.com/api/v3/ad_accounts/a2_100/ads?page.size=100&page.token=t2',
    'a password only': 'https://:pw@ads-api.reddit.com/api/v3/ad_accounts/a2_100/ads?page.size=100&page.token=t2',
    'a fragment': base + '?page.size=100&page.token=t2#x',
    'a changed page size': base + '?page.size=1000&page.token=t2',
    'an added parameter': base + '?page.size=100&page.token=t2&id=1',
    'a repeated token': base + '?page.size=100&page.token=t2&page.token=t3',
    'no token': base + '?page.size=100',
    'an empty token': base + '?page.size=100&page.token=',
    'not a link': 'not a link',
  };
  const answer = link => ({
    data: [
      {
        id: 'a1',
        name: 'Ad',
        configured_status: 'ACTIVE',
        preview_url: 'https://www.reddit.com/p/1',
        preview_expiry: '2999-01-01T00:00:00Z',
      },
    ],
    pagination: {next_url: link},
  });
  // The first page names `link` as the next one. A second list read would mean the link was followed, so it fails with an
  // error of its own: a repeated page would otherwise be refused with the same code, and hide a link taken by mistake.
  const run = (link, extra = {}, reads = []) =>
    new AdPreviews(
      async (_tool, input) => {
        reads.push(input.arguments?.action);
        if (reads.length > 1) throw new Error('the link was followed: ' + link);
        return {success: true, data: {data: answer(link)}};
      },
      connectionFor(t, 'reddit_native_action', {userAgent: 'amcp-tests/1.0 (synthetic)', accounts: ['a2_100']}),
    ).handle({platform: 'reddit', account_id: 'a2_100', connection_id: loginId, ...extra}, actor);
  for (const [what, link] of Object.entries(hostile)) {
    const reads = [];
    await assert.rejects(run(link, {}, reads), error => refusedShape(error, what), what);
    assert.deepEqual(reads, ['LIST_ADS'], what);
  }
  // The request's own link is taken (the page is full, so the answer carries a cursor).
  const out = await run(base + '?page.size=100&page.token=t2', {limit: 1});
  assert.equal(out.has_more, true);
  assert.equal(typeof out.next_cursor, 'string');
  // A named read asks for exactly the named IDs and has no next page, so a link there is wrong.
  const named = [];
  await assert.rejects(run(base + '?page.size=1&id=a1&page.token=t2', {ad_ids: ['a1']}, named), error =>
    refusedShape(error),
  );
  assert.deepEqual(named, ['LIST_ADS']);
});
