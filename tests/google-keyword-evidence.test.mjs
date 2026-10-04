import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {reportPreset} from '../dist/src/report-presets.js';
import {evidenceWorkbook} from '../dist/src/evidence-artifacts.js';
import {
  googleKeywordInput as input,
  googleKeywordRow as row,
  googleKeywordFixture as fixture,
} from './fixtures/google-keyword-evidence-data.mjs';
const ok = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data;
};
const unsaved = f => {
  for (const kind of ['decision_report', 'write_review', 'campaign_plan'])
    assert.equal(f.store.documents(f.owner.tenantId, kind).length, 0, kind);
};

test('Google keyword preset declares a separate criterion/day grain and exact positive Search query/mapping', async t => {
  const f = fixture(t),
    presets = ok(await f.call({action: 'capture_presets'})).presets;
  assert.deepEqual(
    presets.filter(p => p.id.startsWith('google_')).map(p => p.id),
    ['google_campaign', 'google_adset', 'google_ad', 'google_keyword', 'google_search_terms'],
  );
  const p = reportPreset(input);
  assert.equal(p.arguments.action, 'google_ads_v23_google_ads_search');
  assert.match(
    p.arguments.payload.query,
    /FROM keyword_view WHERE segments.date BETWEEN '2026-09-01' AND '2026-09-02' AND campaign.advertising_channel_type = 'SEARCH' AND ad_group_criterion.negative = FALSE$/,
  );
  for (const field of [
    'customer.id',
    'customer.resource_name',
    'campaign.resource_name',
    'campaign.advertising_channel_type',
    'ad_group.resource_name',
    'ad_group_criterion.resource_name',
    'ad_group_criterion.criterion_id',
    'ad_group_criterion.type',
    'ad_group_criterion.negative',
    'ad_group_criterion.keyword.text',
    'ad_group_criterion.keyword.match_type',
    'keyword_view.resource_name',
    'segments.date',
  ])
    assert.ok(p.arguments.payload.query.includes(field), field);
  assert.doesNotMatch(p.arguments.payload.query, /status|all_conversions|search_term_view|mutate/);
  assert.equal(p.mapping.entity_id, '/keywordView/resourceName');
  assert.equal(p.mapping.entity_name, '/adGroupCriterion/keyword/text');
  assert.equal(p.mapping.keyword_match_type, '/adGroupCriterion/keyword/matchType');
  assert.equal(p.mapping.search_term, undefined);
  assert.equal(presets.find(p => p.id === 'google_keyword').grain, 'keyword × day');
  assert.equal(f.requests.length, 0);
});
test('complete paged keyword evidence keeps original text, native enums, exact resources/micros and missing metrics', async t => {
  const f = fixture(t),
    out = ok(await f.call());
  assert.equal(out.row_count, 4);
  assert.equal(out.preset, 'google_keyword');
  assert.equal(out.grain, 'keyword × day');
  assert.equal(out.rows[0].entity_id, 'customers/123/keywordViews/2~9007199254740993');
  assert.equal(out.rows[0].entity_name, 'رمضان Home <img>');
  assert.deepEqual(
    out.rows.map(r => r.keyword_match_type),
    ['EXACT', 'PHRASE', 'BROAD', 'EXACT'],
  );
  assert.equal(out.rows[0].spend, '9007199254.740993');
  assert.equal(out.rows[1].spend, '0');
  assert.equal(out.rows[1].conversions, '0');
  assert.equal(out.rows[2].conversions, null);
  assert.equal(out.rows[2].conversion_value, null);
  assert.equal(out.totals.spend, '9007199257.740993');
  assert.equal(out.totals.clicks, '19');
  assert.equal(out.totals.conversions, null);
  assert.equal(out.coverage.conversions, 'partial');
  assert.equal(out.native_account_evidence.checks.length, 2);
  assert.equal(out.source_pages.length, 2);
  assert.equal(out.collection_usage.requests, 4);
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests[2].body.pageToken, 'opaque-keyword-next');
  assert.equal(f.requests[2].body.query, f.requests[1].body.query);
  assert.equal(out.semantics.conversion_definition, 'metrics.conversions');
  assert.match(out.semantics_source, /declared/);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|synthetic-keyword-secret/);
  const calls = f.requests.length,
    search = ok(await f.call({action: 'get', id: out.id, row_query: 'phrase', limit: 10}));
  assert.equal(search.row_count, 4);
  assert.equal(search.matched_row_count, 1);
  assert.equal(search.rows[0].keyword_match_type, 'PHRASE');
  assert.equal(search.source_hash, out.source_hash);
  assert.deepEqual(search.totals, out.totals);
  assert.equal(f.requests.length, calls);
  assert.equal(f.store.documents(f.owner.tenantId, 'write_review').length, 0);
});
test('keyword text remains literal and native character bounds count Unicode code points', async t => {
  for (const text of ['  رمضان Home  ', '😀'.repeat(80), 'one two three four five six seven eight nine ten']) {
    const r = row();
    r.adGroupCriterion.keyword.text = text;
    delete r.adGroupCriterion.negative;
    assert.equal(ok(await fixture(t, [r]).call()).rows[0].entity_name, text);
  }
});
test('foreign or malformed keyword channel, criterion, text, enum, view and daily grain fail before persistence', async t => {
  const changes = [
    [r => (r.campaign.advertisingChannelType = 'DISPLAY'), 'REPORT_SHAPE_CHANGED'],
    [r => delete r.campaign.advertisingChannelType, 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.type = 'PLACEMENT'), 'REPORT_SHAPE_CHANGED'],
    [r => delete r.adGroupCriterion.type, 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.criterionId = 9007199254740992), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.criterionId = '9223372036854775808'), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.criterionId = '01'), 'REPORT_SHAPE_CHANGED'],
    [
      r => (r.adGroupCriterion.resourceName = 'customers/999/adGroupCriteria/2~9007199254740993'),
      'REPORT_ACCOUNT_MISMATCH',
    ],
    [r => (r.keywordView.resourceName = 'customers/123/keywordViews/9~9007199254740993'), 'REPORT_ACCOUNT_MISMATCH'],
    [r => delete r.keywordView, 'REPORT_ACCOUNT_MISMATCH'],
    [r => (r.adGroupCriterion.negative = true), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.negative = 'false'), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.negative = null), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.keyword.text = ' '), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.keyword.text = '😀'.repeat(81)), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.keyword.text = 'one '.repeat(11)), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.keyword.text = 'home\nterm'), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.keyword.matchType = 'UNKNOWN'), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.keyword.matchType = 'exact'), 'REPORT_SHAPE_CHANGED'],
    [r => (r.adGroupCriterion.keyword.matchType = {value: 'EXACT'}), 'REPORT_SHAPE_CHANGED'],
    [r => delete r.adGroupCriterion.keyword, 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments.device = 'MOBILE'), 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments.date = '2026-09-03'), 'REPORT_DATE_MISMATCH'],
    [r => (r.segments.date = '2026-02-30'), 'REPORT_DATE_MISMATCH'],
    [r => (r.customer.id = '999'), 'REPORT_ACCOUNT_MISMATCH'],
    [r => (r.adGroup.id = '9'), 'REPORT_ACCOUNT_MISMATCH'],
  ];
  for (const [change, code] of changes) {
    const r = row();
    change(r);
    const f = fixture(t, [r]),
      out = await f.call();
    assert.equal(out.success, false);
    assert.equal(out.error.code, code, JSON.stringify(out));
    unsaved(f);
  }
});
test('keyword native parents and match types stay distinct while duplicate or changed immutable metadata is refused across pages', async t => {
  const a = row(),
    b = row('9007199254740993', 'EXACT', '2026-09-01', '4'),
    f = fixture(t, [a, b]);
  const out = ok(await f.call());
  assert.notEqual(out.rows[0].entity_id, out.rows[1].entity_id);
  for (const mode of ['duplicate', 'text', 'match', 'parent']) {
    const rows = [row(), row('9007199254740994', 'PHRASE'), row('9007199254740993', 'EXACT', '2026-09-02')];
    if (mode === 'duplicate') rows[2].segments.date = '2026-09-01';
    if (mode === 'text') rows[2].adGroupCriterion.keyword.text = 'changed';
    if (mode === 'match') rows[2].adGroupCriterion.keyword.matchType = 'PHRASE';
    if (mode === 'parent') rows[2].campaign = {...rows[2].campaign, id: '9', resourceName: 'customers/123/campaigns/9'};
    const bad = fixture(t, rows),
      result = await bad.call();
    assert.equal(result.success, false, mode);
    assert.equal(
      result.error.code,
      mode === 'duplicate'
        ? 'REPORT_DUPLICATE_ROWS'
        : mode === 'parent'
          ? 'REPORT_ACCOUNT_MISMATCH'
          : 'REPORT_SHAPE_CHANGED',
    );
    unsaved(bad);
  }
});
test('keyword pages and both account reads require unchanged current credentials, scopes, account access and key', async t => {
  for (const n of [1, 2, 3, 4])
    for (const mode of ['credentials', 'scopes', 'account', 'disabled', 'key']) {
      const f = fixture(t);
      f.edit((_body, data, count) => {
        if (count === n) {
          if (mode === 'key') f.store.revokeKey(f.key);
          else
            f.store.putConnection(
              f.owner,
              {
                ...f.connection,
                ...(mode === 'scopes'
                  ? {scopes: []}
                  : mode === 'account'
                    ? {accounts: []}
                    : mode === 'disabled'
                      ? {enabled: false}
                      : {}),
              },
              mode === 'credentials' ? {accessToken: 'changed-synthetic'} : f.credentials,
            );
        }
        return data;
      });
      const result = await f.call();
      assert.equal(result.success, false, mode + ':' + n);
      assert.notEqual(result.error.code, 'INTERNAL_ERROR');
      assert.equal(f.requests.length, n);
      unsaved(f);
    }
});
test('native empty keyword defaults preserve zero rows while malformed completion, duplicates and partial metrics cannot become complete evidence', async t => {
  const empty = fixture(t, []);
  empty.edit((body, data) => (body.query.includes('FROM customer') ? data : {}));
  const out = ok(await empty.call());
  assert.equal(out.row_count, 0);
  assert.equal(out.totals.spend, '0');
  assert.equal(out.native_account_evidence.checks.length, 2);
  for (const change of [
    d => delete d.totalResultsCount,
    d => (d.totalResultsCount = '5'),
    d => (d.truncated = true),
    d => (d.totalResultsCount = 4),
    d => (d.summaryRow = {}),
    d => (d.results = null),
  ]) {
    const f = fixture(t);
    f.edit((body, data) => {
      if (body.query.includes('FROM keyword_view')) change(data);
      return data;
    });
    assert.equal((await f.call()).success, false);
    unsaved(f);
  }
});
test('keyword evidence cannot qualify native negative-keyword or campaign budget plans', async t => {
  const f = fixture(t),
    out = ok(await f.call()),
    calls = f.requests.length;
  for (const action of ['search_exclusion_candidates', 'allocation_candidates']) {
    const rejected = await f.call({action, id: out.id});
    assert.equal(rejected.success, false, action);
    assert.notEqual(rejected.error.code, 'INTERNAL_ERROR');
  }
  assert.equal(f.requests.length, calls);
  assert.equal(f.store.documents(f.owner.tenantId, 'campaign_plan').length, 0);
  assert.equal(f.store.documents(f.owner.tenantId, 'write_review').length, 0);
});
test('optional match-type mapping rejects unit/action/format changes and unknown native enums instead of coercing them', async t => {
  const native = reportPreset(input);
  for (const spec of [
    {path: '/adGroupCriterion/keyword/matchType', divisor: 1},
    {path: '/adGroupCriterion/keyword/matchType', action_type: 'purchase'},
    {path: '/adGroupCriterion/keyword/matchType', format: 'tiktok_day'},
  ]) {
    const f = fixture(t);
    const result = await f.call({...native, action: 'capture', mapping: {...native.mapping, keyword_match_type: spec}});
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.equal(f.requests.length, 0);
    unsaved(f);
  }
  for (const value of [false, 'UNKNOWN', 'exact']) {
    const r = row();
    r.adGroupCriterion.keyword.matchType = value;
    const f = fixture(t, [r]),
      result = await f.call({...native, action: 'capture'});
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'REPORT_SHAPE_CHANGED');
    unsaved(f);
  }
});
test('bilingual keyword workbooks append a literal optional match-type column and preserve old rows, headers and unknown cells', async t => {
  const f = fixture(t),
    out = ok(await f.call()),
    stored = f.store.document(f.owner.tenantId, 'decision_report', out.id);
  for (const language of ['en', 'ar']) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await evidenceWorkbook({...stored, id: out.id}, language));
    const rows = book.worksheets[1];
    assert.equal(rows.columnCount, 12);
    assert.equal(rows.getCell('L1').value, 'keyword_match_type');
    assert.equal(rows.getCell('L2').value, 'EXACT');
    assert.equal(rows.getCell('L3').value, 'PHRASE');
    assert.equal(rows.getCell('L4').value, 'BROAD');
    assert.equal(rows.getCell('A2').value, out.rows[0].entity_id);
    assert.equal(rows.getCell('B2').value, 'رمضان Home <img>');
    assert.equal(rows.getCell('E2').value, '9007199254.740993');
    assert.equal(rows.getCell('H4').value, null);
    assert.equal(rows.getCell('L2').alignment.readingOrder, 'ltr');
    assert.equal(rows.views[0].rightToLeft === true, language === 'ar');
    assert.equal(rows.rowCount, 5);
    const old = structuredClone(stored);
    delete old.mapping.keyword_match_type;
    const oldBook = new ExcelJS.Workbook();
    await oldBook.xlsx.load(await evidenceWorkbook(old, language));
    assert.equal(oldBook.worksheets[1].columnCount, 11);
  }
});
