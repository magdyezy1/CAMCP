import test from 'node:test';
import assert from 'node:assert/strict';
import {creativeNativeUsageUi} from './fixtures/creative-native-usage-ui.mjs';
import {snapUsageIds as ids} from './fixtures/snapchat-asset-usage-data.mjs';
const asset = {
  asset_id: 'asset-147',
  account_id: ids.account,
  connection_id: 'snap-login',
  media_id: ids.media,
  uploaded_sha256: 'e'.repeat(64),
  native_usage_supported: true,
  native_usage_kind: 'snapchat_top_snap',
};
const meaning =
  'Current literal Snapchat creative top-snap media references in the original upload account. Both bounded creative collections and original media/account observations must match. Missing scalar references remain unresolved; nested images, icons, previews, dynamic templates, lead-form media and other associations are outside this view. Native packaging, review and media-processing statuses do not establish ad delivery, historical assignment, performance or reuse eligibility. Complete means the selected visible collection was observed twice, not an atomic inventory or complete all-format absence. This read grants no write authority.';
const result = (extra = {}) => ({
  ...asset,
  platform: 'snapchat',
  record_kind: 'native_asset_references',
  complete: true,
  selected_limit: 50,
  reference_view: 'snapchat_top_snap',
  qualified_view: 'creative.top_snap_media_id',
  provider_mutations: 0,
  saved_snapshot: false,
  has_more: false,
  next_cursor: null,
  meaning,
  examined_creatives: 3,
  other_top_snap_creatives: 1,
  unresolved_creatives: 1,
  native_media: {id: ids.media, ad_account_id: ids.account, media_status: 'READY'},
  source_references: [],
  rows: [
    {
      creative_id: ids.creative,
      ad_account_id: ids.account,
      media_id: ids.media,
      match_field: 'creative.top_snap_media_id',
      name: '<native creative>',
      creative_type: 'WEB_VIEW',
      packaging_status: 'SUCCESS',
      review_status: 'PENDING_REVIEW',
    },
  ],
  ...extra,
});
function mounted(locale, request) {
  const f = creativeNativeUsageUi(locale, request);
  f.context.asset = structuredClone(asset);
  f.context.active = () => true;
  f.run('mountCreativeNativeReferences(asset,active)');
  return f;
}
test('bilingual Snapchat table keeps exact creative/media identities and separate native statuses without inventing ad hierarchy', () => {
  for (const locale of ['en', 'ar']) {
    const f = creativeNativeUsageUi(locale);
    f.context.result = result();
    const html = f.run('creativeNativeReferenceRows(result)');
    assert.match(html, /&lt;native creative&gt;/);
    assert.match(html, new RegExp('dir="ltr">' + ids.creative));
    assert.match(html, new RegExp('dir="ltr">' + ids.media));
    assert.match(html, /SUCCESS.*PENDING_REVIEW/);
    assert.match(html, /READY/);
    assert.match(html, /role="region" tabindex="0" aria-label=/);
    assert.match(
      html,
      locale === 'ar'
        ? /مراجع المواد الإبداعية الحالية لمورد سناب شات العلوي/
        : /Current Snapchat top-snap creative references/,
    );
    assert.match(html, locale === 'ar' ? /لا تثبت حالات التجهيز/ : /do not establish ad delivery/);
    assert.doesNotMatch(html, /<native creative>|Ad ID:|Ad group|Ad set|Campaign ID:|undefined/);
    f.context.result = result({rows: []});
    assert.match(
      f.run('creativeNativeReferenceRows(result)'),
      locale === 'ar' ? /لم يُرصد مرجع علوي مباشر/ : /No literal top-snap reference/,
    );
  }
});
test('Snapchat handoffs restore only the exact original qualified bound and require an explicit read', async () => {
  for (const locale of ['en', 'ar']) {
    const f = creativeNativeUsageUi(locale, args => result({selected_limit: args.limit}));
    f.context.asset = structuredClone(asset);
    f.context.active = () => true;
    f.context.location.search = '?asset_id=asset-147&reference_view=snapchat_top_snap&reference_limit=200';
    f.run('mountCreativeNativeReferences(asset,active)');
    assert.equal(f.node('#creative-snapchat-reference-limit').value, '200');
    assert.equal(f.calls.length, 0);
    await f.bindings.get('#creative-read-native-references')();
    assert.equal(f.calls[0].args.reference_view, 'snapchat_top_snap');
    assert.equal(f.calls[0].args.limit, 200);
    assert.equal(f.calls[0].args.cursor, undefined);
    assert.match(f.node('#creative-native-reference-pages').innerHTML, /creative.top_snap_media_id/);
    for (const search of [
      '?asset_id=other&reference_view=snapchat_top_snap&reference_limit=200',
      '?asset_id=asset-147&reference_view=ad_images&reference_limit=200',
      '?asset_id=asset-147&reference_view=snapchat_top_snap&reference_limit=200&reference_limit=300',
    ]) {
      f.context.location.search = search;
      f.run('mountCreativeNativeReferences(asset,active)');
      assert.equal(f.node('#creative-snapchat-reference-limit').value, '50');
    }
  }
});
test('Snapchat input changes, reordered reads and departed identities/routes withhold stale evidence in both languages', async () => {
  for (const locale of ['en', 'ar']) {
    const pending = [],
      f = mounted(locale, () => new Promise(r => pending.push(r))),
      read = f.bindings.get('#creative-read-native-references');
    const first = read();
    f.node('#creative-snapchat-reference-limit').value = '200';
    f.bindings.get('#creative-snapchat-reference-limit input')();
    pending[0](result({meaning: 'STALE-FIRST'}));
    await first;
    assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /STALE-FIRST/);
    const second = read(),
      third = read();
    pending[2](result({selected_limit: 200, meaning: 'LATEST'}));
    await third;
    pending[1](result({selected_limit: 200, meaning: 'OLD-ORDER'}));
    await second;
    assert.match(f.node('#creative-native-reference-pages').innerHTML, /LATEST/);
    assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /OLD-ORDER/);
    for (const key of ['identityGeneration', 'navigationGeneration']) {
      const p = read();
      f.context[key]++;
      pending.at(-1)(result({selected_limit: 200, meaning: 'DEPARTED'}));
      await p;
      assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /DEPARTED/);
      f.context[key]--;
    }
  }
});
test('Snapchat invalid limits refuse egress and wrong native scopes do not render in either language', async () => {
  for (const locale of ['en', 'ar']) {
    const f = mounted(locale, async () => result({account_id: ids.other, meaning: 'WRONG-ACCOUNT'}));
    f.node('#creative-snapchat-reference-limit').value = '1001';
    await f.bindings.get('#creative-read-native-references')();
    assert.equal(f.calls.length, 0);
    assert.match(f.node('#creative-native-reference-pages').innerHTML, /role="alert"/);
    f.node('#creative-snapchat-reference-limit').value = '50';
    await f.bindings.get('#creative-read-native-references')();
    assert.doesNotMatch(f.node('#creative-native-reference-pages').innerHTML, /WRONG-ACCOUNT|native creative/);
    assert.match(
      f.node('#creative-native-reference-pages').innerHTML,
      locale === 'ar' ? /تغير مورد سناب شات الأصلي/ : /original Snapchat asset/,
    );
  }
});
