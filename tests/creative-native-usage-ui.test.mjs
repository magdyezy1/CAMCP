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
  run(readFileSync('web/operations-center.js', 'utf8'));
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
