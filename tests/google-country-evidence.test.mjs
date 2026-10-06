import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {reportPreset} from '../dist/src/report-presets.js';
import {evidenceWorkbook} from '../dist/src/evidence-artifacts.js';
import {
  googleCountryInput as input,
  googleCountryRow as row,
  googleCountryFixture as fixture,
} from './fixtures/google-country-evidence-data.mjs';
const ok = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data;
};
const unsaved = f => {
  for (const kind of ['decision_report', 'write_review', 'campaign_plan'])
    assert.equal(f.store.documents(f.owner.tenantId, kind).length, 0, kind);
};

test('country preset requests country, location type and day without filters that hide original categories', async t => {
  const f = fixture(t),
    choices = ok(await f.call({action: 'capture_presets'})).presets,
    preset = choices.find(p => p.id === input.preset),
    native = reportPreset(input),
    query = native.arguments.payload.query;
  assert.equal(preset.grain, 'campaign × native country × native location type × day');
  assert.equal(choices.filter(p => p.gateway === 'google_ads_native_action').length, 8);
  assert.match(query, /FROM geographic_view WHERE segments.date BETWEEN '2026-09-01' AND '2026-09-02'$/);
  for (const field of [
    'customer.id',
    'customer.resource_name',
    'campaign.resource_name',
    'geographic_view.resource_name',
    'geographic_view.country_criterion_id',
    'geographic_view.location_type',
    'segments.date',
  ])
    assert.ok(query.includes(field), field);
  assert.doesNotMatch(query, /ad_group|segments\.hour|segments\.device|\.status|country_criterion_id\s*=/);
  assert.equal(native.mapping.entity_id, '/campaign/resourceName');
  assert.equal(native.arguments.aggregate_pages, false);
  assert.equal(native.arguments.payload.search_settings.return_total_results_count, true);
});

test('country capture retains exact large IDs, presence/interest and every original row with complete page/account lineage', async t => {
  const f = fixture(t),
    out = ok(await f.call());
  assert.equal(out.row_count, 8);
  assert.equal(out.rows[0].native_country_criterion_id, '0');
  assert.equal(out.rows[0].native_location_type, 'UNSPECIFIED');
  assert.equal(out.rows[1].native_country_criterion_id, '9007199254740993');
  assert.equal(out.rows[1].native_location_type, 'UNKNOWN');
  assert.equal(out.rows[2].native_country_criterion_id, out.rows[3].native_country_criterion_id);
  assert.equal(out.rows[2].native_location_type, 'AREA_OF_INTEREST');
  assert.equal(out.rows[3].native_location_type, 'LOCATION_OF_PRESENCE');
  assert.equal(out.rows[3].native_geographic_resource, 'customers/123/geographicViews/2222~3');
  assert.equal(out.rows[0].entity_id, 'customers/123/campaigns/9007199254740993');
  assert.equal(out.native_account_evidence.checks.length, 2);
  assert.equal(out.source_pages.length, 2);
  assert.equal(f.requests.length, 4);
  assert.equal(out.source_collection, 'google_search_pages');
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|synthetic-country-secret/);
  for (const kind of ['write_review', 'campaign_plan'])
    assert.equal(f.store.documents(f.owner.tenantId, kind).length, 0);
});

test('country retained search keeps complete totals and makes no additional native read', async t => {
  const f = fixture(t),
    out = ok(await f.call()),
    before = f.requests.length;
  for (const [query, count] of [
    ['AREA_OF_INTEREST', 2],
    ['9007199254740993', 8],
    ['geographicViews/2222~3', 2],
  ]) {
    const found = ok(await f.call({action: 'get', id: out.id, row_query: query}));
    assert.equal(found.row_count, 8);
    assert.equal(found.matched_row_count, count);
    assert.deepEqual(found.totals, out.totals);
    assert.equal(found.source_hash, out.source_hash);
  }
  assert.equal(f.requests.length, before);
});

test('country all-row Excel keeps exact scalar dimensions in both languages', async t => {
  const f = fixture(t),
    out = ok(await f.call()),
    report = f.store.document(f.owner.tenantId, 'decision_report', out.id),
    before = f.requests.length;
  for (const language of ['en', 'ar']) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await evidenceWorkbook({...report, id: out.id}, language));
    const sheet = wb.worksheets.find(s => s.getRow(1).values.includes('native_country_criterion_id'));
    assert.ok(sheet);
    const headers = sheet.getRow(1).values;
    assert.equal(sheet.rowCount, 9);
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('native_country_criterion_id')).value, '0');
    assert.equal(sheet.getRow(3).getCell(headers.indexOf('native_country_criterion_id')).value, '9007199254740993');
    assert.equal(sheet.getRow(4).getCell(headers.indexOf('native_location_type')).value, 'AREA_OF_INTEREST');
    assert.equal(
      sheet.getRow(5).getCell(headers.indexOf('native_geographic_resource')).value,
      'customers/123/geographicViews/2222~3',
    );
  }
  assert.equal(f.requests.length, before);
});

test('complete empty country evidence preserves empty rows without inferring missing-country activity', async t => {
  const f = fixture(t, []),
    out = ok(await f.call());
  assert.equal(out.row_count, 0);
  assert.equal(out.rows.length, 0);
  assert.equal(out.source_pages.length, 1);
  assert.equal(f.requests.length, 3);
});

test('native campaign/country/type/day grain separates campaigns and dates but refuses cross-page duplicates', async t => {
  const distinct = [
    row(),
    row('2222', 'AREA_OF_INTEREST'),
    row('2222', 'LOCATION_OF_PRESENCE', '2026-09-02'),
    row('2222', 'LOCATION_OF_PRESENCE', '2026-09-01', '3'),
  ];
  assert.equal(ok(await fixture(t, distinct).call()).row_count, 4);
  const duplicate = fixture(t, [...distinct, structuredClone(distinct[0])]),
    out = await duplicate.call();
  assert.equal(out.success, false);
  assert.equal(out.error.code, 'REPORT_DUPLICATE_ROWS');
  unsaved(duplicate);
});

for (const [label, change] of [
  ['missing country', r => delete r.geographicView.countryCriterionId],
  ['unsafe numeric country', r => (r.geographicView.countryCriterionId = 9007199254740993)],
  ['safe numeric country', r => (r.geographicView.countryCriterionId = 2222)],
  ['negative country', r => (r.geographicView.countryCriterionId = '-1')],
  ['leading zero country', r => (r.geographicView.countryCriterionId = '02222')],
  ['int64 overflow country', r => (r.geographicView.countryCriterionId = '9223372036854775808')],
  ['unknown future location', r => (r.geographicView.locationType = 'FUTURE_LOCATION')],
  ['missing location', r => delete r.geographicView.locationType],
  ['numeric location enum', r => (r.geographicView.locationType = 3)],
  ['foreign geographic account', r => (r.geographicView.resourceName = 'customers/200/geographicViews/2222~3')],
  ['conflicting native country', r => (r.geographicView.resourceName = 'customers/123/geographicViews/2223~3')],
  ['conflicting native location', r => (r.geographicView.resourceName = 'customers/123/geographicViews/2222~2')],
  ['padded resource identity', r => (r.geographicView.resourceName += ' ')],
  ['extra reporting segment', r => (r.segments.geoTargetRegion = 'geoTargetConstants/100')],
  ['foreign campaign resource', r => (r.campaign.resourceName = 'customers/200/campaigns/' + r.campaign.id)],
  ['outside selected day', r => (r.segments.date = '2026-10-01')],
])
  test('country capture refuses ' + label + ' before persistence', async t => {
    const original = row();
    change(original);
    const f = fixture(t, [original]),
      out = await f.call();
    assert.equal(out.success, false);
    assert.notEqual(out.error.code, 'INTERNAL_ERROR');
    unsaved(f);
  });

test('country source cannot qualify a campaign budget or search-exclusion proposal', async t => {
  const f = fixture(t),
    out = ok(await f.call()),
    before = f.requests.length;
  for (const action of ['allocation_candidates', 'search_exclusion_candidates']) {
    const refused = await f.call({action, id: out.id});
    assert.equal(refused.success, false);
    assert.notEqual(refused.error.code, 'INTERNAL_ERROR');
  }
  assert.equal(f.requests.length, before);
});

test('revocation during a country page discards the captured native rows', async t => {
  const f = fixture(t);
  f.edit((body, data) => {
    if (/FROM geographic_view/.test(body.query)) f.store.revokeKey(f.key);
    return data;
  });
  const out = await f.call();
  assert.equal(out.success, false);
  assert.notEqual(out.error.code, 'INTERNAL_ERROR');
  unsaved(f);
});

test('custom geographic mappings retain exact scalars, optional unknowns and unchanged older rows', async t => {
  const original = row(),
    f = fixture(t, [original]),
    native = reportPreset(input),
    captured = ok(await f.call({...native, action: 'capture'}));
  assert.equal(captured.rows[0].native_country_criterion_id, '2222');
  assert.equal(captured.rows[0].native_location_type, 'LOCATION_OF_PRESENCE');
  delete original.geographicView.countryCriterionId;
  const unknown = ok(await f.call({...native, action: 'capture'}));
  assert.equal(unknown.rows[0].native_country_criterion_id, null);
  const plain = structuredClone(native);
  for (const key of ['native_country_criterion_id', 'native_location_type', 'native_geographic_resource'])
    delete plain.mapping[key];
  const older = ok(await f.call({...plain, action: 'capture'}));
  assert.equal(Object.hasOwn(older.rows[0], 'native_country_criterion_id'), false);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    await evidenceWorkbook({...f.store.document(f.owner.tenantId, 'decision_report', older.id), id: older.id}),
  );
  assert.equal(workbook.worksheets[1].columnCount, 11);
});

test('geographic mappings cannot scale, format or reinterpret native dimensions before provider dispatch', async t => {
  const f = fixture(t, [row()]);
  for (const key of ['native_country_criterion_id', 'native_location_type', 'native_geographic_resource'])
    for (const extra of [{divisor: 100}, {format: 'linkedin_utc_date'}, {action_type: 'purchase'}]) {
      const native = reportPreset(input);
      native.mapping[key] = {path: native.mapping[key], ...extra};
      const refused = await f.call({...native, action: 'capture'});
      assert.equal(refused.success, false);
      assert.equal(refused.error.code, 'REPORT_SHAPE_CHANGED');
      assert.equal(f.requests.length, 0);
      unsaved(f);
    }
});

test('custom mapped geographic metadata refuses contradictions with original resource identity', async t => {
  for (const change of [
    r => (r.geographicView.countryCriterionId = '2223'),
    r => (r.geographicView.locationType = 'AREA_OF_INTEREST'),
  ]) {
    const original = row();
    change(original);
    const f = fixture(t, [original]),
      out = await f.call({...reportPreset(input), action: 'capture'});
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'REPORT_SHAPE_CHANGED');
    unsaved(f);
  }
});
