import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {packFixture} from './fixtures/report-pack-data.mjs';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {cleanupReports} from '../dist/src/owner-operations.js';

test('XLSX keeps numeric types, literal untrusted names, leading-zero IDs, missing values and separate measurement groups', async () => {
  const {reportWorkbook} = await import('../dist/src/report-artifacts.js');
  const report = packFixture();
  const bytes = await reportWorkbook(report);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  assert.deepEqual(
    book.worksheets.map(s => s.name),
    ['Report', 'Account summaries', 'Campaign rows', 'Source coverage', 'Evidence'],
  );
  const raw = book.getWorksheet('Campaign rows');
  assert.equal(raw.getCell('B2').value, '00100');
  assert.equal(raw.getCell('C2').value, '00000');
  assert.equal(raw.getCell('D2').value, '=1+1');
  assert.equal(raw.getCell('D2').type, ExcelJS.ValueType.String);
  assert.equal(raw.getCell('J2').value, 12.5);
  assert.equal(raw.getCell('J2').numFmt, '#,##0.00;[Red](#,##0.00);0');
  assert.equal(raw.getCell('D1').fill.fgColor.argb, 'FF354B67');
  assert.equal(raw.views[0].state, 'frozen');
  assert.equal(raw.views[0].ySplit, 1);
  assert.equal(raw.getColumn(4).width, 48);
  assert.equal(raw.getCell('M3').value, null);
  assert.equal(raw.getCell('D3').value, 'رمضان');
  assert.equal(raw.rowCount, 3);
  const summary = book.getWorksheet('Account summaries');
  assert.equal(summary.rowCount, 3);
  assert.deepEqual([summary.getCell('D2').value, summary.getCell('D3').value], ['USD', 'SAR']);
  const evidence = book.getWorksheet('Evidence').getColumn(3).values.slice(2).join('');
  assert.equal(JSON.parse(evidence).state, 'partial');
  assert.equal(JSON.parse(evidence).sources[0].error.code, 'INCOMPLETE_EVIDENCE');
  book.eachSheet(s => s.eachRow(r => r.eachCell(c => assert.notEqual(c.type, ExcelJS.ValueType.Formula))));
});
test('PDF generation embeds its font, preserves partial evidence and bounds work before rendering', async () => {
  const {reportPdf, reportWorkbook} = await import('../dist/src/report-artifacts.js');
  const r = packFixture(),
    bytes = await reportPdf(r);
  assert.match(bytes.toString('ascii', 0, 8), /^%PDF-/);
  assert.match(bytes.toString('latin1'), /\/FontFile2/);
  assert.equal(
    (bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length,
    2,
    'Page numbers must stay on the report pages, without extra footer-only pages.',
  );
  assert.doesNotMatch(bytes.toString('latin1'), /\/JavaScript|\/OpenAction/);
  await assert.rejects(reportPdf({...r, summary: Array(501).fill(r.summary[0])}), /limit/i);
  await assert.rejects(reportWorkbook({...r, rows: Array(100001).fill(r.rows[0])}), /limit/i);
  await assert.rejects(reportWorkbook({...r, rows: [{...r.rows[0], campaign_name: 'x'.repeat(32768)}]}), /cell/i);
  await assert.rejects(
    reportWorkbook({...r, rows: Array(1100).fill({...r.rows[0], campaign_name: 'x'.repeat(32767)})}),
    /text size/i,
  );
  await assert.rejects(reportPdf({...r, state: 'running'}), /finished|successful|ready/i);
  await assert.rejects(reportPdf(r, {brand_name: '漢字'}), /embedded PDF font/);
});
test('report presentation is scope-bound, confirmed and revision protected with no provider mutation', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  const actor = {tenantId: 'local', userId: 'operator', role: 'operator'};
  const connection = {
    id: 'meta',
    tenantId: 'local',
    gateway: 'meta_native_action',
    accounts: ['00100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  store.putDocument('local', 'overview_report', 'synthetic-pack', packFixture());
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider calls');
    }),
  );
  const call = (v, as = actor) => service.call('amcp_reporting_overview', v, as);
  try {
    const input = {
      action: 'save_presentation',
      id: 'synthetic-pack',
      presentation_revision: 0,
      presentation: {
        brand_name: 'Client brand',
        accent_color: '#243A66',
        footer: 'Prepared for the client',
        template: 'compact',
      },
    };
    assert.equal((await call(input)).success, false);
    assert.equal((await call({...input, presentation: undefined, confirmed: true})).success, false);
    assert.equal((await call({...input, confirmed: true}, {...actor, role: 'reader'})).success, false);
    const save = await call({...input, confirmed: true});
    assert.equal(save.success, true, JSON.stringify(save));
    assert.equal(save.data.presentation_revision, 1);
    assert.equal((await call({...input, confirmed: true})).error.code, 'REVISION_CONFLICT');
    const pack = await call({action: 'report_pack', id: 'synthetic-pack'});
    assert.equal(pack.data.presentation.brand_name, 'Client brand');
    assert.ok(pack.data.xlsx_path.endsWith('.xlsx'));
    assert.ok(pack.data.pdf_path.endsWith('.pdf'));
    assert.equal(
      (
        await call({
          ...input,
          confirmed: true,
          presentation_revision: 1,
          presentation: {...input.presentation, logo_url: 'https://private.invalid'},
        })
      ).success,
      false,
    );
    store.putConnection({...actor, role: 'admin'}, {...connection, enabled: false}, {accessToken: 'synthetic'});
    assert.equal((await call({action: 'report_pack', id: 'synthetic-pack'})).success, false);
  } finally {
    store.close();
  }
});
test('artifact download routes require a session and fresh complete source access after asynchronous generation', async () => {
  const master = Buffer.alloc(32, 62).toString('base64'),
    store = new Store(':memory:', master),
    actor = {tenantId: 'local', userId: 'operator', role: 'admin'},
    origin = 'https://amcp.shop';
  const connection = {
    id: 'meta',
    tenantId: 'local',
    gateway: 'meta_native_action',
    accounts: ['00100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  store.putDocument('local', 'overview_report', 'synthetic-pack', packFixture());
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider calls');
    }),
  );
  const listener = await listenForFetch(
    createHttpApp(service, store, {website: {origin, masterKey: master, adminPassword: 'synthetic-test-password'}}),
  );
  const base = 'http://127.0.0.1:' + listener.address().port;
  try {
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({password: 'synthetic-test-password'}),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await login.arrayBuffer();
    for (const format of ['xlsx', 'pdf']) {
      let r = await fetch(base + '/api/reporting-overview/synthetic-pack.' + format);
      await r.arrayBuffer();
      assert.equal(r.status, 401);
      r = await fetch(base + '/api/reporting-overview/synthetic-pack.' + format, {headers: {Cookie: cookie}});
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(r.status, 200, bytes.toString());
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.match(r.headers.get('content-disposition'), /attachment/);
      assert.ok(bytes.length > 1000);
    }
    const resolve = store.resolveConnection.bind(store);
    let checks = 0;
    store.resolveConnection = (...args) => {
      if (++checks === 2) store.putConnection(actor, {...connection, enabled: false}, {accessToken: 'synthetic'});
      return resolve(...args);
    };
    const denied = await fetch(base + '/api/reporting-overview/synthetic-pack.xlsx', {headers: {Cookie: cookie}});
    await denied.arrayBuffer();
    assert.notEqual(denied.status, 200);
    assert.ok(checks >= 2);
  } finally {
    await listener.close();
    store.close();
  }
});
test('report artifact concurrency is bounded and presentation metadata follows snapshot retention', async () => {
  const {reportArtifact} = await import('../dist/src/report-artifacts.js');
  const r = packFixture();
  const pending = reportArtifact('same-tenant', r, 'xlsx', {});
  await assert.rejects(reportArtifact('same-tenant', r, 'xlsx', {}), e => e.code === 'REPORT_DOWNLOAD_BUSY');
  await pending;
  const store = new Store(':memory:', Buffer.alloc(32, 59).toString('base64'));
  try {
    store.ensureTenant('local');
    store.putDocument('local', 'retention_policy', 'reports', {days: 7});
    store.putDocument('local', 'overview_report', r.id, {...r, created_at: 1});
    store.putDocument('local', 'report_presentation', r.id, {presentation: {brand_name: 'Old client'}});
    store.putDocument('local', 'overview_report', 'current', {...r, created_at: Date.now()});
    store.putDocument('local', 'report_presentation', 'current', {presentation: {brand_name: 'Current client'}});
    cleanupReports(store);
    assert.throws(
      () => store.document('local', 'report_presentation', r.id),
      e => e.code === 'NOT_FOUND',
    );
    assert.equal(store.document('local', 'report_presentation', 'current').presentation.brand_name, 'Current client');
  } finally {
    store.close();
  }
});
