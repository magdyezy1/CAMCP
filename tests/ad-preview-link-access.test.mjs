// Package r25-m0-live (Round 2.5, item 7: observation 6 of the live checks of 2026-11-15). amcp_ad_previews said of every
// platform's links that they "open for anyone who has them", and the Preview your ads page said "Anyone with a link can open
// it". Live, LinkedIn's mobile link rendered the ad standalone, while its desktop link showed LinkedIn's error page without a
// LinkedIn session. The notice no longer promises that: the shared one says a platform may need its own sign-in for some links,
// and LinkedIn's own (src/linkedin-ad-previews.ts) says which of its two links opens without one and which may need one, by the
// device each placement names. The tool's long description is pinned by tests/tool-surface-golden.test.mjs (tools/list in its
// full-description form) and by tests/mcp-own-help.test.mjs (the help repeats it), so it is not changed here, and neither is
// tools/list (the lead, 2026-11-15: no re-recorded golden, 27 bytes of room in the operator listing). The correction the
// description cannot carry is in the help of the tool instead, as `link_access`. (The M3 merge then replaced the description's
// sentence, as its last commit with the golden re-recorded: it says links expire and may need a platform sign-in, and the help's
// note no longer corrects it.) The Arabic of each sentence is in the
// catalogue the page loads (tests/ad-previews-localization.test.mjs); the help is for MCP clients and has none.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AdPreviews} from '../dist/src/ad-previews.js';
import {Registry} from '../dist/src/catalog.js';
import {readGuidance} from '../dist/src/guidance.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
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
  // Platforms whose previews AMCP cannot read answer with the same notice. X is not one of them since package r12-xpreview
  // (it reads its previews, with a connection: tests/x-ad-previews.test.mjs holds that its answer carries the same notice).
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  const none = new AdPreviews(async () => assert.fail('no read is made'), store);
  for (const platform of ['google_ads', 'microsoft_ads', 'dv360', 'criteo', 'apple_ads'])
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

/** The service of the listing and the help, with no provider reachable. */
function helpOf(t) {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  store.ensureTenant(actor.tenantId);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider request is expected');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  // The tool by its listed name: a literal call of a default-call tool with `action` is read by the scan of
  // tests/first-party-contracts.test.mjs as a call of that default action, which has no `action` argument.
  const preview = service.firstPartyTools().find(tool => tool.name === 'amcp_ad_previews');
  return {service, preview, call: (tool, args) => service.call(tool, args, actor)};
}

test('the help of amcp_ad_previews says which links need a sign-in, because its pinned description cannot', async t => {
  const {call, preview} = helpOf(t),
    own = await call(preview.name, {action: 'help'}),
    legacy = await call('amcp_tool_help', {gateway: preview.name});
  for (const help of [own, legacy]) assert.equal(help.success, true, JSON.stringify(help.error));
  const access = own.data.link_access;
  assert.ok(access, 'the help names link_access');
  assert.match(access.note, /a platform may need its own sign-in to show some of them/);
  // R2.5 M3 merge, golden commit 2: the description's own sentence now says the same (links expire, and may need a platform
  // sign-in; the golden pins it in full), so the note no longer corrects it. What the description cannot carry is which links.
  assert.doesNotMatch(access.note, /does not hold|corrects the sentence|anyone who has them/);
  assert.match(
    preview.description,
    /Preview links expire \(.*\) and may need a platform sign-in; AMCP returns them without storing them\./,
  );
  assert.doesNotMatch(preview.description, /open for anyone who has them/);
  // Only a platform that knows which of its links needs a sign-in says so (from its own hooks); no other makes a claim.
  assert.deepEqual(Object.keys(access.platforms), ['linkedin']);
  assert.equal(access.platforms.linkedin, linkedin, 'the sentence of the answer, not a second wording');
  assert.deepEqual(legacy.data.link_access, access, 'both routes to the help say the same');
  // The addition is this tool's alone, and it stays inside the help byte budget the existing tests measure.
  const workspace = await call('amcp_workspace', {action: 'help'});
  assert.equal(workspace.success, true, JSON.stringify(workspace.error));
  assert.equal(workspace.data.link_access, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(own)) <= 40000, 'help bytes: ' + Buffer.byteLength(JSON.stringify(own)));
});

test('tools/list keeps its wording: the compact text says only that links expire, and names no platform', t => {
  const listed = helpOf(t)
    .service.listTools()
    .find(tool => tool.name === 'amcp_ad_previews');
  assert.match(listed.description, /with links that expire\./);
  assert.doesNotMatch(listed.description, /anyone|sign-in|LinkedIn/i);
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

// Package r12-xpreview, review S3-3. The guide the Skill serves (amcp://guides/workspace, the file
// Skills/amcp-campaign-builder/references/workspace.md, which the campaign prompt includes too) still told the model to say that
// "anyone with a link can open it until it expires": the promise the notice, the help and the page gave up in r25-m0-live. It is
// the one place that wrote it for a model to repeat, and a model repeats it to the person who will share a link.
test('the guide the Skill serves tells the model to say what the notice says, and promises no one that a link opens', () => {
  const guide = readGuidance('amcp://guides/workspace').text,
    paragraph = guide
      .split(/\r?\n\r?\n/)
      .find(text => text.includes('amcp_ad_previews') && text.includes('give the user the links'));
  assert.ok(paragraph, 'the guide has its paragraph on ad previews');
  assert.ok(
    paragraph.includes(
      'say that preview links expire and a platform may need its own sign-in to show some of them; share them only with people who may see these ads',
    ),
    'the paragraph says what the notice of the answer says',
  );
  assert.doesNotMatch(guide, /anyone with a link|open for anyone/i);
});
