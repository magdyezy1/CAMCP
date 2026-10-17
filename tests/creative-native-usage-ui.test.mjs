import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';

const meaning =
  'Current scalar Meta creative image-hash or video-ID references in the original upload account. Missing and unsupported formats remain unknown. Configured and effective status do not prove delivery. This is not historical creative attribution or a point-in-time inventory; provider changes can move or repeat ads between pages. An empty matching page can still continue. This read grants no write authority.';
function fixture(
  locale = 'en',
  request = async () => ({
    rows: [],
    examined_ads: 3,
    unresolved_ads: 2,
    meaning,
    source_references: [],
    next_cursor: 'opaque',
  }),
) {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        isConnected: true,
        status: {textContent: ''},
        setAttribute() {},
        addEventListener(type, fn) {
          bindings.set(key + ' ' + type, fn);
        },
        querySelector() {
          return this.status;
        },
      });
    return nodes.get(key);
  };
  const esc = value =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const context = createContext({
    navigationGeneration: 1,
    identityGeneration: 1,
    location: {search: ''},
    URLSearchParams,
    history: {
      replaceState(_state, _title, url) {
        context.location.search = new URL(url, 'https://synthetic.invalid').search;
      },
    },
    document: {addEventListener() {}},
    $: node,
    esc,
    recordDetails: (value, label) =>
      `<details><summary>${esc(label)}</summary><pre>${esc(JSON.stringify(value))}</pre></details>`,
    errorMessage: error => error.message,
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    workspaceCall: async (tool, args) => {
      calls.push({tool, args});
      return request(args);
    },
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  // WEB-07: Creative needs only the paged-list loader (web/work-pages.js), no longer the Operations center.
  run(readFileSync('web/work-pages.js', 'utf8'));
  run(readFileSync('web/creative-library.js', 'utf8'));
  return {run, context, node, bindings, calls};
}
test('current native reference rows retain exact IDs, escaped evidence and independent status in English and Arabic', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.result = {
      meaning,
      examined_ads: 3,
      unresolved_ads: 1,
      source_references: [{request_hash: 'a'.repeat(64)}],
      rows: [
        {
          ad_id: '9007199254740993',
          name: '<native ad>',
          campaign_id: '301',
          adset_id: '401',
          creative_id: '601',
          match_field: 'image_hash',
          media_id: 'opaque-native-hash',
          configured_status: 'PAUSED',
          effective_status: 'CAMPAIGN_PAUSED',
          native_updated_time: '<original time>',
        },
      ],
    };
    const html = f.run('creativeNativeReferenceRows(result)');
    assert.match(html, /9007199254740993|opaque-native-hash/);
    assert.match(html, /PAUSED.*CAMPAIGN_PAUSED/);
    assert.match(html, /&lt;native ad&gt;|&lt;original time&gt;/);
    assert.doesNotMatch(html, /<native ad>|<original time>|data.*execute/);
    assert.match(html, locale === 'ar' ? /مراجع الوسائط الحالية لدى المنصة/ : /Current native media references/);
    assert.match(html, locale === 'ar' ? /لا يحدد هذا الفحص الإسناد التاريخي/ : /not historical creative attribution/);
  }
});
test('native reference reads are explicit, reader-compatible and retain the exact selected asset across paging', async () => {
  const f = fixture('ar');
  f.context.asset = {asset_id: 'asset-original', native_usage_supported: true};
  f.context.active = () => true;
  f.run('mountCreativeNativeReferences(asset,active)');
  assert.equal(f.calls.length, 0);
  assert.match(f.node('#creative-native-references').innerHTML, /اقرأ المراجع الحالية لدى المنصة/);
  assert.doesNotMatch(f.node('#creative-native-references').innerHTML, /disabled/);
  await f.bindings.get('#creative-read-native-references')();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), {
    tool: 'media',
    args: {action: 'asset_usage', asset_id: 'asset-original', limit: 50},
  });
  assert.match(f.node('#creative-native-reference-pages').innerHTML, /لا توجد مراجع قيم مفردة مطابقة/);
  await f.bindings.get('#creative-native-reference-pages [data-page-next]')();
  assert.equal(f.calls[1].args.cursor, 'opaque');
  assert.ok(f.calls.every(c => c.args.asset_id === 'asset-original' && c.args.action === 'asset_usage'));
});
test('changed asset views discard pending native results and forbid subsequent paging or reads', async () => {
  let resolve;
  const f = fixture(
    'en',
    () =>
      new Promise(r => {
        resolve = r;
      }),
  );
  let active = true;
  f.context.asset = {asset_id: 'asset-old', native_usage_supported: true};
  f.context.active = () => active;
  f.run('mountCreativeNativeReferences(asset,active)');
  const pending = f.bindings.get('#creative-read-native-references')();
  assert.equal(f.calls.length, 1);
  active = false;
  resolve({
    rows: [],
    examined_ads: 0,
    unresolved_ads: 0,
    meaning: 'OLD-NATIVE',
    source_references: [],
    next_cursor: 'old',
  });
  await pending;
  assert.equal(f.node('#creative-native-reference-pages').innerHTML, '');
  await f.bindings.get('#creative-read-native-references')();
  assert.equal(f.calls.length, 1);
});
test('unqualified providers cause no native read and unfamiliar diagnostics stay original', () => {
  const f = fixture('ar');
  f.context.asset = {asset_id: 'unqualified', native_usage_supported: false};
  f.context.active = () => true;
  f.run('mountCreativeNativeReferences(asset,active)');
  assert.match(f.node('#creative-native-references').innerHTML, /يتطلب فحص المراجع/);
  assert.equal(f.bindings.has('#creative-read-native-references'), false);
  f.context.reason = 'This login requires Meta advertising read permission.';
  assert.match(f.run('creativeNativeReferenceExplanation(reason)'), /إذن قراءة إعلانات Meta/);
  f.context.reason = 'Unfamiliar provider diagnosis <original>';
  assert.equal(f.run('creativeNativeReferenceExplanation(reason)'), f.context.reason);
});

test('a TikTok asset gets provider-neutral usage copy in English and Arabic; a Meta asset keeps the Meta copy', () => {
  // MCP-10: every asset that was not Google or Snapchat was told to "Inspect current Meta image-hash or video-ID
  // references", a TikTok, LinkedIn, X or DV360 upload included.
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    neutral =
      'Current use in ads can be read for Meta images and videos, Google images and Snapchat images and videos. For this asset it stays unknown.',
    metaCopy =
      'Inspect current Meta image-hash or video-ID references in the original upload account. This can find ads outside AMCP plans; it does not attribute historical performance. Other formats and providers remain unknown.';
  for (const locale of ['en', 'ar']) {
    const text = value => (locale === 'ar' ? catalog[value] : value);
    assert.ok(catalog[neutral], 'Arabic for the neutral copy');
    const tiktok = fixture(locale);
    tiktok.context.asset = {asset_id: 'tiktok-asset', platform: 'tiktok', native_usage_supported: false};
    tiktok.context.active = () => true;
    tiktok.run('mountCreativeNativeReferences(asset,active)');
    const html = tiktok.node('#creative-native-references').innerHTML;
    assert.ok(html.includes(text(neutral)), locale);
    assert.ok(!html.includes(text(metaCopy)), locale);
    assert.equal(tiktok.bindings.has('#creative-read-native-references'), false);
    assert.equal(tiktok.calls.length, 0);
    const meta = fixture(locale);
    meta.context.asset = {asset_id: 'meta-asset', platform: 'meta', native_usage_supported: true};
    meta.context.active = () => true;
    meta.run('mountCreativeNativeReferences(asset,active)');
    assert.ok(meta.node('#creative-native-references').innerHTML.includes(text(metaCopy)), locale);
  }
});

const googleMeaning =
  'Current explicit latest-version image links in the selected Google ad asset view and original upload account. The view covers App, Demand Gen and Responsive Search ads; Responsive Display, Performance Max and other formats remain outside this evidence. Missing link flags or types remain unknown, and removed links are counted separately. Configured statuses do not prove serving, historical attribution, performance, reuse eligibility or complete all-format absence. This read grants no write authority.';
const googleResult = (extra = {}) => ({
  platform: 'google_ads',
  asset_id: 'google-original',
  complete: true,
  selected_limit: 200,
  examined_links: 3,
  examined_ads: 2,
  unresolved_links: 1,
  removed_links: 1,
  meaning: googleMeaning,
  source_references: [],
  rows: [
    {
      ad_id: '9007199254740993',
      ad_resource_name: 'customers/100/adGroupAds/20~9007199254740993',
      name: '<native image ad>',
      ad_type: 'DEMAND_GEN_MULTI_ASSET_AD',
      campaign_id: '10',
      ad_group_id: '20',
      media_id: 'customers/100/assets/700',
      field_type: 'MARKETING_IMAGE',
      configured_status: 'PAUSED',
      campaign_status: 'ENABLED',
      ad_group_status: null,
    },
  ],
  ...extra,
});
const pmaxResult = (extra = {}) =>
  googleResult({
    reference_view: 'performance_max',
    examined_asset_groups: 2,
    examined_ads: undefined,
    meaning:
      'Current configured image links in the selected Performance Max asset-group view and original upload account. Enabled and paused links remain separate native configurations; removed links are counted separately, and missing roles or statuses remain unknown. Asset groups are not individual ads. This view excludes campaign-level brand-guideline logos, Responsive Display, other associations and video. It does not prove serving, policy approval, historical attribution, performance, reuse eligibility or complete all-format absence. This read grants no write authority.',
    rows: [
      {
        asset_group_id: '9007199254740993',
        asset_group_resource_name: 'customers/100/assetGroups/9007199254740993',
        name: '<native image group>',
        campaign_id: '10',
        media_id: 'customers/100/assets/700',
        field_type: 'MARKETING_IMAGE',
        link_status: 'PAUSED',
        asset_group_status: 'ENABLED',
        campaign_status: 'PAUSED',
      },
    ],
    ...extra,
  });

const brandMeaning = /export const pmaxBrandImageMeaning\s*=\s*'([^']+)';/.exec(
  readFileSync('src/google-pmax-brand-image-links.ts', 'utf8'),
)[1];
const brandResult = (extra = {}) =>
  googleResult({
    reference_view: 'performance_max_brand',
    examined_campaigns: 2,
    examined_ads: undefined,
    unresolved_links: 2,
    meaning: brandMeaning,
    rows: [
      {
        campaign_id: '9007199254740993',
        campaign_resource_name: 'customers/100/campaigns/9007199254740993',
        name: '<native brand campaign>',
        media_id: 'customers/100/assets/700',
        field_type: 'LOGO',
        link_status: 'PAUSED',
        campaign_status: 'ENABLED',
        brand_guidelines_enabled: true,
      },
    ],
    ...extra,
  });
test('bilingual campaign logo results preserve exact campaign identity, configured state and scoped meaning', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.result = brandResult();
    const html = f.run('creativeGoogleImageReferences(result)');
    assert.match(html, /dir="ltr">9007199254740993/);
    assert.match(html, /customers\/100\/campaigns\/9007199254740993/);
    assert.match(html, /&lt;native brand campaign&gt;/);
    assert.match(html, /PAUSED.*ENABLED/);
    assert.match(html, /dir="ltr">LOGO/);
    assert.match(
      html,
      locale === 'ar' ? /روابط شعارات حملات الأداء الأفضل الحالية/ : /Current Performance Max campaign logo links/,
    );
    assert.match(
      html,
      locale === 'ar' ? /روابط الحملات لا تمثل إعلانات منفردة أو مجموعات موارد/ : /not individual ads or asset groups/,
    );
    assert.doesNotMatch(html, /<native brand campaign>|Ad group|assetGroups|undefined/);
    assert.match(html, /role="region" tabindex="0" aria-label=/);
  }
});
test('campaign-logo choice and limit edits clear results and withhold changed-view responses in both languages', async () => {
  for (const locale of ['en', 'ar']) {
    const pending = [],
      f = fixture(locale, () => new Promise(r => pending.push(r)));
    f.context.asset = {
      asset_id: 'google-original',
      native_usage_supported: true,
      native_usage_kind: 'google_image_links',
    };
    f.context.active = () => true;
    f.run('mountCreativeNativeReferences(asset,active)');
    f.node('#creative-google-reference-view').value = 'performance_max_brand';
    f.node('#creative-google-reference-limit').value = '200';
    f.bindings.get('#creative-google-reference-view change')();
    assert.equal(f.calls.length, 0);
    const a = f.bindings.get('#creative-read-native-references')();
    assert.equal(f.calls[0].args.reference_view, 'performance_max_brand');
    f.node('#creative-google-reference-view').value = 'performance_max';
    f.bindings.get('#creative-google-reference-view change')();
    pending[0](brandResult({meaning: 'STALE-BRAND'}));
    await a;
    assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /STALE-BRAND/);
    const b = f.bindings.get('#creative-read-native-references')();
    pending[1](pmaxResult());
    await b;
    assert.match(f.node('#creative-native-reference-pages').innerHTML, /assetGroups/);
    f.node('#creative-google-reference-limit').value = '50';
    f.bindings.get('#creative-google-reference-limit input')();
    assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /assetGroups/);
    f.node('#creative-google-reference-view').value = 'performance_max_brand';
    const c = f.bindings.get('#creative-read-native-references')();
    pending[2](pmaxResult({selected_limit: 50, meaning: 'WRONG-GROUP'}));
    await c;
    assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /WRONG-GROUP/);
    assert.match(f.node('#creative-native-reference-pages').innerHTML, /role="alert"/);
  }
});
test('original media handoffs initialize bounded views without reads and clear choices on another asset', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale, async () => brandResult());
    f.context.asset = {
      asset_id: 'google-original',
      native_usage_supported: true,
      native_usage_kind: 'google_image_links',
    };
    f.context.active = () => true;
    f.context.location.search = '?asset_id=google-original&reference_view=performance_max_brand&reference_limit=200';
    f.run('mountCreativeNativeReferences(asset,active)');
    assert.equal(f.node('#creative-google-reference-view').value, 'performance_max_brand');
    assert.equal(f.node('#creative-google-reference-limit').value, '200');
    assert.equal(f.calls.length, 0);
    await f.bindings.get('#creative-read-native-references')();
    assert.equal(f.calls[0].args.reference_view, 'performance_max_brand');
    assert.equal(f.calls[0].args.limit, 200);
    f.node('#creative-google-reference-view').value = 'performance_max';
    f.bindings.get('#creative-google-reference-view change')();
    assert.equal(new URLSearchParams(f.context.location.search).get('reference_view'), 'performance_max');
    f.run('mountCreativeNativeReferences(asset,active)');
    assert.equal(f.node('#creative-google-reference-view').value, 'performance_max');
    f.node('#creative-google-reference-view').value = 'performance_max_brand';
    f.bindings.get('#creative-google-reference-view change')();
    const original = new URLSearchParams(
      f.run('creativeMediaHandoffQuery(location.search,"google-original").toString()'),
    );
    assert.equal(original.get('reference_view'), 'performance_max_brand');
    const different = new URLSearchParams(f.run('creativeMediaHandoffQuery(location.search,"different").toString()'));
    assert.equal(different.get('asset_id'), 'different');
    assert.equal(different.has('reference_view'), false);
    assert.equal(different.has('reference_limit'), false);
    for (const search of [
      '?asset_id=other&reference_view=performance_max_brand&reference_limit=200',
      '?asset_id=google-original&reference_view=all&reference_limit=9999',
    ]) {
      f.context.location.search = search;
      f.run('mountCreativeNativeReferences(asset,active)');
      assert.equal(f.node('#creative-google-reference-view').value, 'ad_images');
      assert.equal(f.node('#creative-google-reference-limit').value, '50');
      assert.equal(f.calls.length, 1);
    }
  }
});

test('bilingual PMax image results preserve asset-group identities, native link state and separate scoped counts', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.result = pmaxResult();
    const html = f.run('creativeGoogleImageReferences(result)');
    assert.match(html, /dir="ltr">9007199254740993/);
    assert.match(html, /customers\/100\/assetGroups\/9007199254740993/);
    assert.match(html, /&lt;native image group&gt;/);
    assert.match(html, /PAUSED.*ENABLED.*PAUSED/);
    assert.doesNotMatch(html, /<native image group>|Ad ID|Ad group|creative_id|undefined/);
    assert.match(
      html,
      locale === 'ar' ? /روابط الصور الحالية في حملات الأداء الأفضل/ : /Current Performance Max image links/,
    );
    assert.match(html, locale === 'ar' ? /مجموعة الموارد لا تمثل إعلانًا منفردًا/ : /not individual ads/);
    assert.match(html, /role="region" tabindex="0" aria-label=/);
  }
});

test('explicit native-view and bound edits clear current PMax results and withhold old selected responses', async () => {
  for (const locale of ['en', 'ar']) {
    const pending = [];
    const f = fixture(locale, () => new Promise(r => pending.push(r)));
    f.context.asset = {
      asset_id: 'google-original',
      native_usage_supported: true,
      native_usage_kind: 'google_image_links',
    };
    f.context.active = () => true;
    f.run('mountCreativeNativeReferences(asset,active)');
    f.node('#creative-google-reference-limit').value = '200';
    f.node('#creative-google-reference-view').value = 'performance_max';
    f.bindings.get('#creative-google-reference-view change')();
    assert.equal(f.calls.length, 0);
    const a = f.bindings.get('#creative-read-native-references')();
    assert.equal(f.calls[0].args.reference_view, 'performance_max');
    f.node('#creative-google-reference-view').value = 'ad_images';
    f.bindings.get('#creative-google-reference-view change')();
    pending[0](pmaxResult({meaning: 'STALE-PMAX'}));
    await a;
    assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /STALE-PMAX/);
    const b = f.bindings.get('#creative-read-native-references')();
    pending[1](googleResult());
    await b;
    assert.match(f.node('#creative-native-reference-pages').innerHTML, /9007199254740993/);
    f.node('#creative-google-reference-limit').value = '50';
    f.bindings.get('#creative-google-reference-limit input')();
    assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /9007199254740993/);
    assert.equal(f.calls.length, 2);
    f.node('#creative-google-reference-view').value = 'performance_max';
    const c = f.bindings.get('#creative-read-native-references')();
    pending[2](googleResult({selected_limit: 50, meaning: 'WRONG-VIEW'}));
    await c;
    assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /WRONG-VIEW/);
    assert.match(f.node('#creative-native-reference-pages').innerHTML, /role="alert"/);
  }
});

test('Google image references use exact LTR IDs, escaped names, scoped bilingual explanations and a named scrolling table', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.result = googleResult();
    const html = f.run('creativeNativeReferenceRows(result)');
    assert.match(html, /dir="ltr">9007199254740993/);
    assert.match(html, /customers\/100\/assets\/700/);
    assert.match(html, /&lt;native image ad&gt;/);
    assert.doesNotMatch(html, /<native image ad>|Creative ID|Ad set ID/);
    assert.match(html, /role="region" tabindex="0" aria-label=/);
    assert.match(html, /<caption>/);
    assert.match(
      html,
      locale === 'ar'
        ? /روابط الصور الحالية في Google|الإسناد التاريخي/
        : /Current Google image links|historical attribution/,
    );
    assert.match(html, locale === 'ar' ? /الحد المختار لفحص المجموعة كاملة/ : /Selected complete-collection limit/);
  }
});

test('Google native reads require an explicit complete bound, forbid cursors and reject invalid limits before a call', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale, async () => googleResult());
    f.context.asset = {
      asset_id: 'google-original',
      native_usage_supported: true,
      native_usage_kind: 'google_image_links',
    };
    f.context.active = () => true;
    f.run('mountCreativeNativeReferences(asset,active)');
    assert.equal(f.calls.length, 0);
    assert.match(f.node('#creative-native-references').innerHTML, /type="number" min="1" max="1000"/);
    f.node('#creative-google-reference-limit').value = '1001';
    await f.bindings.get('#creative-read-native-references')();
    assert.equal(f.calls.length, 0);
    f.node('#creative-google-reference-limit').value = '200';
    await f.bindings.get('#creative-read-native-references')();
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), {
      tool: 'media',
      args: {action: 'asset_usage', asset_id: 'google-original', limit: 200},
    });
    assert.match(f.node('#creative-native-reference-pages').innerHTML, /9007199254740993/);
    assert.equal(f.bindings.has('#creative-native-reference-pages [data-page-next]'), false);
  }
});

test('new Google reads and changed asset/session views withhold stale results and mismatched original scope', async () => {
  const pending = [];
  const f = fixture('en', () => new Promise(r => pending.push(r)));
  let active = true;
  f.context.asset = {
    asset_id: 'google-original',
    native_usage_supported: true,
    native_usage_kind: 'google_image_links',
  };
  f.context.active = () => active;
  f.run('mountCreativeNativeReferences(asset,active)');
  f.node('#creative-google-reference-limit').value = '200';
  const a = f.bindings.get('#creative-read-native-references')(),
    b = f.bindings.get('#creative-read-native-references')();
  pending[1](googleResult({rows: [], meaning: 'NEW-RESULT'}));
  await b;
  pending[0](googleResult({meaning: 'STALE-RESULT'}));
  await a;
  assert.match(f.node('#creative-native-reference-pages').innerHTML, /NEW-RESULT/);
  assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /STALE-RESULT/);
  const c = f.bindings.get('#creative-read-native-references')();
  active = false;
  pending[2](googleResult({meaning: 'WRONG-SESSION'}));
  await c;
  assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /WRONG-SESSION/);
  await f.bindings.get('#creative-read-native-references')();
  assert.equal(f.calls.length, 3);
  active = true;
  const d = f.bindings.get('#creative-read-native-references')();
  pending[3](googleResult({asset_id: 'foreign', meaning: 'FOREIGN-RESULT'}));
  await d;
  assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /FOREIGN-RESULT/);
  assert.match(f.node('#creative-native-reference-pages').innerHTML, /role="alert"/);
});
