// Package r25-m0-live (Round 2.5, item 7: observation 6 of the live checks of 2026-11-15). amcp_ad_previews said of every
// platform's links that they "open for anyone who has them", and the Preview your ads page said "Anyone with a link can open
// it". Live, LinkedIn's mobile link rendered the ad standalone, while its desktop link showed LinkedIn's error page without a
// LinkedIn session. The notice no longer promises that: the shared one says a platform may need its own sign-in for some links,
// and LinkedIn's own (src/linkedin-ad-previews.ts) says which of its two links opens without one and which may need one, by the
// device each placement names. The tool's long description is pinned by tests/tool-surface-golden.test.mjs and is not
// changed here. The Arabic of each sentence is in the catalogue the page loads (tests/ad-previews-localization.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AdPreviews} from '../dist/src/ad-previews.js';
import {Store} from '../dist/src/store.js';
import {loaderFiles, chunksWith} from '../tools/locale-chunks.mjs';

const actor = {tenantId: 'synthetic-link-access', userId: 'owner', role: 'admin'},
  login = 'aaaaaaaa-1111-4111-8111-000000000001',
  key = Buffer.alloc(32, 92).toString('base64'),
  catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  arabic = /\p{Script=Arabic}/u;
const chunks = chunksWith('ad-previews.js', loaderFiles().dependencies),
  loaded = new Set(
    [...chunks].flatMap(name => Object.keys(JSON.parse(readFileSync('web/locales/ar/' + name + '.json', 'utf8')))),
  );
const iframe = (path, device) => ({
  preview: '<iframe src="https://www.linkedin.com/ads/preview/' + path + '"></iframe>',
  placement: {linkedin: {placementName: 'FEED', contentPresentationType: device}},
});
/** The answers a platform gives for the reads its previews make (the shapes of the platforms' documented responses). */
const answers = {
  linkedin: input =>
    input.action === 'linkedin_rest_ad_previews_get'
      ? {elements: [iframe('desktop-1', 'DESKTOP_WEBSITE'), iframe('mobile-1', 'MOBILE_WEBSITE')]}
      : {elements: [{id: 'urn:li:sponsoredCreative:1', name: 'C', intendedStatus: 'ACTIVE'}]},
  meta: input =>
    input.action === 'meta_ad_list'
      ? {data: [{id: '1', name: 'A', account_id: '100', effective_status: 'ACTIVE'}]}
      : {data: [{body: '<iframe src="https://www.facebook.com/ads/preview/1"></iframe>'}]},
  tiktok: input =>
    input.action === 'tiktok_ad_list'
      ? {
          code: 0,
          data: {
            list: [{ad_id: '1', ad_name: 'A', advertiser_id: '100', operation_status: 'ENABLE'}],
            page_info: {page: 1, page_size: input.query.page_size, total_number: 1, total_page: 1},
          },
        }
      : {code: 0, data: {preview_link: 'https://ads.tiktok.com/preview/1'}},
  reddit: () => ({
    data: [{id: 'a1', name: 'Ad', configured_status: 'ACTIVE', preview_url: 'https://www.reddit.com/p/1'}],
  }),
};
function run(t, platform) {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: login,
      tenantId: actor.tenantId,
      gateway: platform + '_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_read', 'r_ads'],
    },
    {accessToken: 'synthetic'},
  );
  const previews = new AdPreviews(
    async (_tool, input) => ({
      success: true,
      data: {data: answers[platform](input.operation ? input.arguments : input)},
    }),
    store,
  );
  return previews.handle({platform, account_id: '100', connection_id: login}, actor);
}

const generic =
  'Preview links expire, and a platform may need its own sign-in to show some of them; share them only with people who may see these ads. AMCP does not store them.';
const linkedin =
  'Preview links expire; share them only with people who may see these ads. AMCP does not store them. The mobile link (device MOBILE_WEBSITE) opens without a LinkedIn sign-in; the desktop link (device DESKTOP_WEBSITE) may show LinkedIn’s error page unless the viewer is signed in to LinkedIn.';

test('LinkedIn says which of its two links opens without a LinkedIn sign-in and which may need one, by the device each names', async t => {
  const out = await run(t, 'linkedin');
  assert.equal(out.meaning, linkedin);
  // The devices the sentence names are the devices of the placements the answer carries, each with its own link.
  const placements = out.previews[0].placements,
    byDevice = Object.fromEntries(placements.map(p => [p.device, p.url]));
  assert.deepEqual(Object.keys(byDevice).sort(), ['DESKTOP_WEBSITE', 'MOBILE_WEBSITE']);
  assert.match(byDevice.MOBILE_WEBSITE, /mobile-1/);
  assert.match(byDevice.DESKTOP_WEBSITE, /desktop-1/);
  assert.deepEqual(out.previews[0].links, [byDevice.DESKTOP_WEBSITE, byDevice.MOBILE_WEBSITE]);
  assert.doesNotMatch(JSON.stringify(out), /open for anyone who has them|Anyone with a link can open/);
});

test('every other platform’s notice no longer says its links open for anyone who has them', async t => {
  for (const platform of ['meta', 'tiktok', 'reddit']) {
    const out = await run(t, platform);
    assert.equal(out.meaning, generic, platform);
    assert.doesNotMatch(JSON.stringify(out), /open for anyone who has them/, platform);
  }
  // Platforms whose previews AMCP cannot read answer with the same notice.
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  const none = new AdPreviews(async () => assert.fail('no read is made'), store);
  for (const platform of ['google_ads', 'x_ads', 'microsoft_ads', 'dv360', 'criteo', 'apple_ads'])
    assert.equal((await none.handle({platform, account_id: '1'}, actor)).meaning, generic, platform);
});

test('the notices keep what they always said about sharing, and add no promise that a link opens', async t => {
  for (const text of [generic, linkedin]) {
    assert.match(text, /^Preview links expire/);
    assert.match(text, /share them only with people who may see these ads\./);
    assert.match(text, /AMCP does not store them\./);
    assert.doesNotMatch(text, /anyone/i);
  }
  assert.equal((await run(t, 'meta')).executed, false);
});

test('each sentence has Arabic in the catalogue and in the chunks the page loads, keeping the device names', () => {
  for (const text of [generic, linkedin]) {
    assert.ok(Object.hasOwn(catalog, text), 'Arabic for: ' + text.slice(0, 50));
    assert.ok(loaded.has(text), 'the page loads: ' + text.slice(0, 50));
    assert.match(catalog[text], arabic);
  }
  for (const token of ['MOBILE_WEBSITE', 'DESKTOP_WEBSITE', 'LinkedIn'])
    assert.ok(catalog[linkedin].includes(token), token);
});

test('the page’s own line above the results makes no promise either', () => {
  const page = readFileSync('web/ad-previews.js', 'utf8'),
    line =
      "Get each platform's own preview links for ads that already exist. Links expire, and a platform may need its own sign-in to show some of them.";
  assert.doesNotMatch(page, /Anyone with a link can open it/);
  assert.ok(page.includes(line), 'the page says the new line');
  assert.ok(Object.hasOwn(catalog, line) && loaded.has(line), 'Arabic for the new line');
  assert.match(catalog[line], arabic);
});
