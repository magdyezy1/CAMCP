import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {reportPreset} from '../dist/src/report-presets.js';
import {evidenceWorkbook} from '../dist/src/evidence-artifacts.js';
import {
  googleDeviceInput as input,
  googleDeviceRow as row,
  googleDeviceRows as rows,
  googleDeviceFixture as fixture,
} from './fixtures/google-device-evidence-data.mjs';
const ok = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data;
};
const unsaved = f => {
  for (const kind of ['decision_report', 'write_review', 'campaign_plan'])
    assert.equal(f.store.documents(f.owner.tenantId, kind).length, 0, kind);
};

test('device preset uses a separate campaign/device/day grain and only original campaign/device/date fields', async t => {
  const f = fixture(t),
    choices = ok(await f.call({action: 'capture_presets'})).presets,
    preset = choices.find(p => p.id === input.preset),
    native = reportPreset(input),
    query = native.arguments.payload.query;
  assert.equal(preset.grain, 'campaign × device × day');
  assert.equal(choices.filter(p => p.gateway === 'google_ads_native_action').length, 6);
  assert.equal(choices[0].id, 'google_campaign');
  assert.equal(native.arguments.action, 'google_ads_v23_google_ads_search');
  assert.match(query, /FROM campaign WHERE segments.date BETWEEN '2026-09-01' AND '2026-09-02'$/);
  for (const field of [
    'customer.id',
    'customer.resource_name',
    'customer.currency_code',
    'customer.time_zone',
    'campaign.id',
    'campaign.name',
    'campaign.resource_name',
    'segments.date',
    'segments.device',
    'metrics.impressions',
    'metrics.clicks',
    'metrics.cost_micros',
    'metrics.conversions',
    'metrics.conversions_value',
  ])
    assert.ok(query.includes(field), field);
  assert.doesNotMatch(
    query,
    /ad_group|criterion|keyword|search_term|status|advertising_channel_type|all_conversions|mutate/,
  );
  assert.equal(native.mapping.entity_id, '/campaign/resourceName');
  assert.equal(native.mapping.entity_name, '/campaign/name');
  assert.equal(native.mapping.native_device, '/segments/device');
  assert.equal(native.mapping.keyword_match_type, undefined);
  assert.equal(native.arguments.aggregate_pages, false);
  assert.deepEqual(native.arguments.payload.search_settings, {return_total_results_count: true});
  assert.equal(f.requests.length, 0);
});

test('complete campaign/device pages preserve all literal categories, exact resources, zero and unknown metrics', async t => {
  const f = fixture(t),
    out = ok(await f.call());
  assert.equal(out.row_count, 8);
  assert.equal(out.preset, input.preset);
  assert.equal(out.grain, 'campaign × device × day');
  assert.equal(out.rows[0].entity_id, 'customers/123/campaigns/9007199254740993');
  assert.equal(out.rows[0].entity_name, 'رمضان Home <img>');
  assert.deepEqual(
    out.rows.map(r => r.native_device),
    rows().map(r => r.segments.device),
  );
  assert.equal(out.rows[0].spend, '9007199254.740993');
  assert.equal(out.rows[1].spend, '0');
  assert.equal(out.rows[1].conversions, '0');
  assert.equal(out.rows[2].conversions, null);
  assert.equal(out.rows[2].conversion_value, null);
  assert.equal(out.rows[5].native_device, 'UNKNOWN');
  assert.equal(out.rows[6].native_device, 'UNSPECIFIED');
  assert.equal(out.totals.spend, '9007199257.740993');
  assert.equal(out.totals.clicks, '19');
  assert.equal(out.totals.conversions, null);
  assert.equal(out.coverage.conversions, 'partial');
  assert.equal(out.native_account_evidence.checks.length, 2);
  assert.equal(out.source_pages.length, 2);
  assert.equal(out.collection_usage.requests, 4);
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests[2].body.pageToken, 'opaque-device-next');
  assert.equal(f.requests[2].body.query, f.requests[1].body.query);
  assert.equal(out.semantics.conversion_definition, 'metrics.conversions');
  assert.match(out.semantics_source, /declared/);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|synthetic-device-secret/);
});

test('retained native-device search changes the view only, including literal UNKNOWN and UNSPECIFIED', async t => {
  const f = fixture(t),
    original = ok(await f.call()),
    before = f.requests.length;
  for (const query of ['connected_tv', 'UNKNOWN', 'UNSPECIFIED', '2026-09-02']) {
    const found = ok(await f.call({action: 'get', id: original.id, row_query: query, limit: 10}));
    assert.equal(found.row_count, 8);
    assert.equal(found.matched_row_count, 1);
    assert.equal(found.rows.length, 1);
    assert.equal(found.source_hash, original.source_hash);
    assert.deepEqual(found.totals, original.totals);
  }
  assert.equal(f.requests.length, before);
  assert.equal(f.store.documents(f.owner.tenantId, 'decision_report').length, 1);
});

test('foreign campaign/customer, changed currency/timezone, malformed device and extra/missing dimensions fail before saving', async t => {
  const changes = [
    [r => (r.campaign.resourceName = 'customers/999/campaigns/9007199254740993'), 'REPORT_ACCOUNT_MISMATCH'],
    [r => delete r.campaign.resourceName, 'REPORT_ACCOUNT_MISMATCH'],
    [r => (r.campaign.id = 9007199254740992), 'REPORT_SHAPE_CHANGED'],
    [r => (r.campaign.id = '9223372036854775808'), 'REPORT_SHAPE_CHANGED'],
    [r => (r.customer.id = '999'), 'REPORT_ACCOUNT_MISMATCH'],
    [r => (r.customer.resourceName = 'customers/999'), 'REPORT_ACCOUNT_MISMATCH'],
    [r => (r.customer.currencyCode = 'SAR'), 'REPORT_CURRENCY_MISMATCH'],
    [r => (r.customer.timeZone = 'Asia/Riyadh'), 'REPORT_TIMEZONE_MISMATCH'],
    [r => delete r.segments.device, 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments.device = null), 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments.device = 2), 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments.device = false), 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments.device = 'mobile'), 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments.device = 'NEW_DEVICE'), 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments.device = {value: 'MOBILE'}), 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments.hour = 0), 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments = []), 'REPORT_SHAPE_CHANGED'],
    [r => delete r.segments.date, 'REPORT_SHAPE_CHANGED'],
    [r => (r.segments.date = '2026-09-03'), 'REPORT_DATE_MISMATCH'],
    [r => (r.segments.date = '2026-02-30'), 'REPORT_DATE_MISMATCH'],
  ];
  for (const [change, code] of changes) {
    const native = row();
    change(native);
    const f = fixture(t, [native]),
      rejected = await f.call();
    assert.equal(rejected.success, false);
    assert.equal(rejected.error.code, code, JSON.stringify(rejected));
    unsaved(f);
  }
});

test('campaign/device/date is the duplicate key across pages; distinct devices, dates and campaigns remain distinct', async t => {
  const valid = [row(), row('DESKTOP'), row('MOBILE', '2026-09-02'), row('MOBILE', '2026-09-01', '2')];
  assert.equal(ok(await fixture(t, valid).call()).row_count, 4);
  const duplicate = rows();
  duplicate[7] = row();
  const f = fixture(t, duplicate),
    rejected = await f.call();
  assert.equal(rejected.error.code, 'REPORT_DUPLICATE_ROWS');
  assert.equal(f.requests.length, 3);
  unsaved(f);
});

test('device capture rechecks current credentials, scopes, account access and key around each native read', async t => {
  for (const phase of [1, 2, 3, 4])
    for (const mode of ['credentials', 'scopes', 'account', 'disabled', 'key']) {
      const f = fixture(t);
      f.edit((_body, data, count) => {
        if (count === phase) {
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
      const rejected = await f.call();
      assert.equal(rejected.success, false, mode + ':' + phase);
      assert.notEqual(rejected.error.code, 'INTERNAL_ERROR');
      assert.equal(f.requests.length, phase);
      unsaved(f);
    }
});

test('device capture refuses partial or changing counts and repeated continuation before persistence', async t => {
  for (const mode of [
    'missing_count',
    'changed_count',
    'truncated',
    'summary',
    'repeated_token',
    'malformed_rows',
    'row_limit',
  ]) {
    const f = fixture(t);
    f.edit((body, data) => {
      if (body.query.includes('FROM customer')) return data;
      if (mode === 'missing_count') delete data.totalResultsCount;
      if (mode === 'changed_count' && body.pageToken) data.totalResultsCount = '9';
      if (mode === 'truncated') data.truncated = true;
      if (mode === 'summary') data.summaryRow = {};
      if (mode === 'malformed_rows') data.results = null;
      if (mode === 'row_limit') data.totalResultsCount = '10001';
      if (mode === 'repeated_token') {
        data.totalResultsCount = '20';
        data.nextPageToken = 'opaque-device-next';
      }
      return data;
    });
    const rejected = await f.call();
    assert.equal(rejected.success, false, mode);
    assert.equal(rejected.error.code, mode === 'row_limit' ? 'REPORT_COLLECTION_LIMIT' : 'REPORT_INCOMPLETE');
    unsaved(f);
  }
});

test('a terminal empty device response preserves an empty report without inventing device rows or coverage', async t => {
  const f = fixture(t, []);
  f.edit((body, data) => (body.query.includes('FROM customer') ? data : {}));
  const out = ok(await f.call());
  assert.equal(out.row_count, 0);
  assert.deepEqual(out.rows, []);
  assert.equal(out.native_account_evidence.checks.length, 2);
  assert.equal(f.requests.length, 3);
  assert.equal(out.mapping.native_device, '/segments/device');
});

test('device evidence cannot qualify campaign budgets or negative-keyword plans and incompatible grains cannot reconcile', async t => {
  const f = fixture(t),
    out = ok(await f.call()),
    before = f.requests.length;
  for (const action of ['search_exclusion_candidates', 'allocation_candidates']) {
    const rejected = await f.call({action, id: out.id});
    assert.equal(rejected.success, false, action);
    assert.notEqual(rejected.error.code, 'INTERNAL_ERROR');
  }
  const other = {
    ...f.store.document(f.owner.tenantId, 'decision_report', out.id),
    preset: 'google_campaign',
    grain: 'campaign × day',
  };
  f.store.putDocument(f.owner.tenantId, 'decision_report', 'other-grain', other);
  const mismatch = await f.call({action: 'reconcile_report', id: out.id, reference_id: 'other-grain'});
  assert.equal(mismatch.success, false);
  assert.notEqual(mismatch.error.code, 'INTERNAL_ERROR');
  assert.equal(f.requests.length, before);
  for (const kind of ['campaign_plan', 'write_review'])
    assert.equal(f.store.documents(f.owner.tenantId, kind).length, 0);
});

test('native-device mappings reject transforms before reads and never coerce unsupported native categories', async t => {
  const native = reportPreset(input);
  for (const spec of [
    {path: '/segments/device', divisor: 1},
    {path: '/segments/device', action_type: 'purchase'},
    {path: '/segments/device', format: 'tiktok_day'},
  ]) {
    const f = fixture(t),
      rejected = await f.call({...native, action: 'capture', mapping: {...native.mapping, native_device: spec}});
    assert.equal(rejected.success, false);
    assert.equal(rejected.error.code, 'REPORT_SHAPE_CHANGED');
    assert.equal(rejected.error.message, 'Native device requires an unmodified field pointer.');
    assert.equal(f.requests.length, 0);
    unsaved(f);
  }
  for (const value of [false, 2, 'mobile', 'NEW_DEVICE']) {
    const r = row();
    r.segments.device = value;
    const f = fixture(t, [r]),
      rejected = await f.call({...native, action: 'capture'});
    assert.equal(rejected.success, false);
    assert.equal(rejected.error.code, 'REPORT_SHAPE_CHANGED');
    assert.equal(rejected.error.message, 'Native device must retain a documented Google device value.');
    unsaved(f);
  }
});

test('optional manual device mapping keeps missing cells unknown and unmapped rows/workbook headers unchanged', async t => {
  const native = reportPreset(input),
    r = row();
  delete r.segments.device;
  const f = fixture(t, [r]),
    mapped = ok(await f.call({...native, action: 'capture'}));
  assert.equal(mapped.rows[0].native_device, null);
  const mapping = {...native.mapping};
  delete mapping.native_device;
  const plain = ok(await f.call({...native, action: 'capture', mapping}));
  assert.equal(Object.hasOwn(plain.rows[0], 'native_device'), false);
  const saved = f.store.document(f.owner.tenantId, 'decision_report', plain.id);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await evidenceWorkbook({...saved, id: plain.id}));
  assert.equal(book.worksheets[1].columnCount, 11);
  const hidden = {...saved, rows: saved.rows.map(row => ({...row, native_device: 'CONNECTED_TV'}))};
  f.store.putDocument(f.owner.tenantId, 'decision_report', plain.id, hidden);
  assert.equal(ok(await f.call({action: 'get', id: plain.id, row_query: 'CONNECTED_TV'})).matched_row_count, 0);
});

test('bilingual device workbooks preserve all rows and append only the mapped literal native_device column', async t => {
  const f = fixture(t),
    out = ok(await f.call()),
    saved = f.store.document(f.owner.tenantId, 'decision_report', out.id);
  for (const language of ['en', 'ar']) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await evidenceWorkbook({...saved, id: out.id}, language));
    const sheet = book.worksheets[1];
    assert.equal(sheet.columnCount, 12);
    assert.equal(sheet.rowCount, 9);
    assert.equal(sheet.getCell('L1').value, 'native_device');
    for (let i = 0; i < out.rows.length; i++) {
      assert.equal(sheet.getCell(i + 2, 1).value, out.rows[i].entity_id);
      assert.equal(sheet.getCell(i + 2, 12).value, out.rows[i].native_device);
      assert.equal(sheet.getCell(i + 2, 12).alignment.readingOrder, 'ltr');
    }
    assert.equal(sheet.getCell('B2').value, 'رمضان Home <img>');
    assert.equal(sheet.getCell('E2').value, '9007199254.740993');
    assert.equal(sheet.getCell('H3').value, '0');
    assert.equal(sheet.getCell('H4').value, null);
    assert.equal(Boolean(sheet.views[0].rightToLeft), language === 'ar');
    const both = {
      ...saved,
      mapping: {...saved.mapping, keyword_match_type: '/keyword/matchType'},
      rows: saved.rows.map(r => ({...r, keyword_match_type: 'EXACT'})),
    };
    const combined = new ExcelJS.Workbook();
    await combined.xlsx.load(await evidenceWorkbook({...both, id: out.id}, language));
    assert.equal(combined.worksheets[1].columnCount, 13);
    assert.equal(combined.worksheets[1].getCell('L1').value, 'keyword_match_type');
    assert.equal(combined.worksheets[1].getCell('M1').value, 'native_device');
  }
});
