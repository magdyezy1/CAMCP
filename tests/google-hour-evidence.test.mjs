import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {reportPreset} from '../dist/src/report-presets.js';
import {evidenceWorkbook} from '../dist/src/evidence-artifacts.js';
import {
  googleHourInput as input,
  googleHourRows as rows,
  googleHourRow as row,
  googleHourFixture as fixture,
} from './fixtures/google-hour-evidence-data.mjs';
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
const unsaved = f => {
  for (const k of ['decision_report', 'campaign_plan', 'write_review'])
    assert.equal(f.store.documents(f.owner.tenantId, k).length, 0, k);
};
test('hourly discovery and native request select only exact campaign/hour/day identities under existing read boundaries', async t => {
  const f = fixture(t),
    choice = ok(await f.call({action: 'capture_presets'})).presets.find(p => p.id === input.preset),
    native = reportPreset(input);
  assert.equal(choice.grain, 'campaign × hour × day');
  assert.equal(native.mapping.native_hour, '/segments/hour');
  assert.equal(native.mapping.native_device, undefined);
  assert.equal(native.mapping.entity_id, '/campaign/resourceName');
  assert.match(native.arguments.payload.query, /segments.date, segments.hour/);
  assert.doesNotMatch(native.arguments.payload.query, /segments.device|mutate|ad_group|criterion|all_conversions/);
  assert.deepEqual(native.arguments.payload.search_settings, {return_total_results_count: true});
  assert.equal(native.arguments.aggregate_pages, false);
  assert.equal(f.requests.length, 0);
});
test('complete original hourly pages preserve all 24 explicit hours, exact identity and source/account lineage without writes', async t => {
  const f = fixture(t),
    out = ok(await f.call());
  assert.equal(out.row_count, 24);
  assert.equal(out.grain, 'campaign × hour × day');
  assert.deepEqual(
    out.rows.map(r => r.native_hour),
    Array.from({length: 24}, (_, i) => String(i)),
  );
  assert.equal(out.rows[0].native_hour, '0');
  assert.equal(out.rows[0].spend, '0');
  assert.equal(out.rows[0].entity_id, 'customers/123/campaigns/9007199254740993');
  assert.equal(out.totals.spend, '276');
  assert.equal(out.totals.conversions, '27.6');
  assert.equal(out.source_pages.length, 2);
  assert.equal(out.native_account_evidence.checks.length, 2);
  assert.equal(out.collection_usage.requests, 4);
  assert.equal(f.requests.length, 4);
  assert.ok(f.requests.every(r => r.method === 'POST' && r.path === '/v25/customers/123/googleAds:search'));
  assert.equal(f.store.documents(f.owner.tenantId, 'campaign_plan').length, 0);
  assert.equal(f.store.documents(f.owner.tenantId, 'write_review').length, 0);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|synthetic-hour-secret/);
});
test('retained hour search preserves complete totals/source and makes no new native read', async t => {
  const f = fixture(t),
    out = ok(await f.call()),
    before = f.requests.length,
    found = ok(await f.call({action: 'get', id: out.id, row_query: '21', limit: 10}));
  assert.equal(found.row_count, 24);
  assert.equal(found.matched_row_count, 1);
  assert.equal(found.rows[0].native_hour, '21');
  assert.deepEqual(found.totals, out.totals);
  assert.equal(found.source_hash, out.source_hash);
  assert.equal(f.requests.length, before);
});
test('explicit first/last-hour workbook cells stay text in both languages without retained binaries or calls', async t => {
  const f = fixture(t),
    out = ok(await f.call()),
    report = f.store.document(f.owner.tenantId, 'decision_report', out.id),
    before = f.requests.length;
  for (const language of ['en', 'ar']) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await evidenceWorkbook({...report, id: out.id}, language));
    const sheet = wb.getWorksheet('Native rows') ?? wb.worksheets.find(s => s.getRow(1).values.includes('native_hour'));
    assert.ok(sheet);
    const header = sheet.getRow(1).values,
      at = header.indexOf('native_hour');
    assert.ok(at > 0);
    assert.equal(sheet.getRow(2).getCell(at).value, '0');
    assert.equal(sheet.getRow(25).getCell(at).value, '23');
  }
  assert.equal(f.requests.length, before);
});
test('same campaign/hour across distinct days is retained and absent categories never acquire invented zero rows', async t => {
  const f = fixture(t, [row(0), row(23), row(0, '2026-09-02')]),
    out = ok(await f.call());
  assert.equal(out.row_count, 3);
  assert.deepEqual(
    out.rows.map(r => [r.native_hour, r.date]),
    [
      ['0', '2026-09-01'],
      ['23', '2026-09-01'],
      ['0', '2026-09-02'],
    ],
  );
});
test('duplicate native campaign/hour/day refuses before evidence persistence', async t => {
  const f = fixture(t, [row(0), row(0)]),
    out = await f.call();
  assert.equal(out.success, false);
  assert.equal(out.error.code, 'REPORT_DUPLICATE_ROWS');
  unsaved(f);
});
test('missing, noninteger, out-of-range or foreign dimensions cannot become valid midnight evidence', async t => {
  for (const value of [undefined, null, -1, 24, 0.5, '0', '23', false, {}, []])
    await t.test(String(value), async t => {
      const r = row(value);
      if (value === undefined) delete r.segments.hour;
      const f = fixture(t, [r]),
        out = await f.call();
      assert.equal(out.success, false);
      assert.equal(out.error.code, 'REPORT_SHAPE_CHANGED');
      unsaved(f);
    });
  for (const extra of [{device: 'MOBILE'}, {dayOfWeek: 'MONDAY'}])
    await t.test(Object.keys(extra)[0], async t => {
      const r = row(0);
      Object.assign(r.segments, extra);
      const f = fixture(t, [r]),
        out = await f.call();
      assert.equal(out.success, false);
      assert.equal(out.error.code, 'REPORT_SHAPE_CHANGED');
      unsaved(f);
    });
});

test('hour grain cannot qualify budget/exclusion changes or reconcile as a campaign daily report', async t => {
  const f = fixture(t),
    out = ok(await f.call()),
    before = f.requests.length;
  for (const action of ['allocation_candidates', 'search_exclusion_candidates']) {
    const denied = await f.call({action, id: out.id});
    assert.equal(denied.success, false);
    assert.notEqual(denied.error.code, 'INTERNAL_ERROR');
  }
  const other = {
    ...f.store.document(f.owner.tenantId, 'decision_report', out.id),
    preset: 'google_campaign',
    grain: 'campaign × day',
  };
  f.store.putDocument(f.owner.tenantId, 'decision_report', 'other-grain', other);
  const denied = await f.call({action: 'reconcile_report', id: out.id, reference_id: 'other-grain'});
  assert.equal(denied.success, false);
  assert.notEqual(denied.error.code, 'INTERNAL_ERROR');
  assert.equal(f.requests.length, before);
  for (const k of ['campaign_plan', 'write_review']) assert.equal(f.store.documents(f.owner.tenantId, k).length, 0);
});
test('optional hour mapping refuses unit/action/date transforms before reads and preserves missing or unmapped cells', async t => {
  const native = reportPreset(input);
  for (const spec of [
    {path: '/segments/hour', divisor: 1},
    {path: '/segments/hour', action_type: 'purchase'},
    {path: '/segments/hour', format: 'tiktok_day'},
  ])
    await t.test('transform ' + Object.keys(spec)[1], async t => {
      const f = fixture(t),
        denied = await f.call({...native, action: 'capture', mapping: {...native.mapping, native_hour: spec}});
      assert.equal(denied.success, false);
      assert.equal(denied.error.code, 'REPORT_SHAPE_CHANGED');
      assert.equal(f.requests.length, 0);
      unsaved(f);
    });
  const r = row();
  delete r.segments.hour;
  const f = fixture(t, [r]),
    mapped = ok(await f.call({...native, action: 'capture'}));
  assert.equal(mapped.rows[0].native_hour, null);
  const mapping = {...native.mapping};
  delete mapping.native_hour;
  const plain = ok(await f.call({...native, action: 'capture', mapping}));
  assert.equal(Object.hasOwn(plain.rows[0], 'native_hour'), false);
  const saved = f.store.document(f.owner.tenantId, 'decision_report', plain.id),
    book = new ExcelJS.Workbook();
  await book.xlsx.load(await evidenceWorkbook({...saved, id: plain.id}));
  assert.equal(book.worksheets[1].columnCount, 11);
  f.store.putDocument(f.owner.tenantId, 'decision_report', plain.id, {
    ...saved,
    rows: saved.rows.map(r => ({...r, native_hour: '21'})),
  });
  assert.equal(ok(await f.call({action: 'get', id: plain.id, row_query: '21'})).matched_row_count, 0);
});

test('native explicit hours and dates remain unchanged with a verified non-UTC account timezone', async t => {
  const f = fixture(t, [row(0), row(23)]);
  f.edit((_body, data) => ({
    ...data,
    results: data.results.map(r => ({...r, customer: {...r.customer, timeZone: 'Asia/Riyadh'}})),
  }));
  const out = ok(await f.call({...input, semantics: {...input.semantics, timezone: 'Asia/Riyadh'}}));
  assert.equal(out.semantics.timezone, 'Asia/Riyadh');
  assert.deepEqual(
    out.rows.map(r => [r.native_hour, r.date]),
    [
      ['0', '2026-09-01'],
      ['23', '2026-09-01'],
    ],
  );
  assert.equal(f.requests.length, 3);
});
test('hourly source authority revoked during the second native page refuses before retaining evidence', async t => {
  const f = fixture(t);
  f.edit((_body, data, count) => {
    if (count === 3) f.store.revokeKey(f.key);
    return data;
  });
  const denied = await f.call();
  assert.equal(denied.success, false);
  assert.notEqual(denied.error.code, 'INTERNAL_ERROR');
  unsaved(f);
  assert.equal(f.requests.length, 3);
});
