import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import ExcelJS from 'exceljs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {reportArtifact} from '../dist/src/report-artifacts.js';
import {packFixture} from './fixtures/report-pack-data.mjs';

const evidence = (count = 101) => ({
  id: 'native-evidence',
  gateway: 'tiktok_native_action',
  account_id: '100',
  connection_id: 'login',
  preset: 'tiktok_campaign',
  source: 'provider_read',
  source_hash: 'a'.repeat(64),
  source_collection: 'tiktok_daily_pages',
  grain: 'campaign × day',
  semantics: {
    currency: 'USD',
    timezone: 'Etc/GMT',
    date_from: '2026-09-01',
    date_to: '2026-09-02',
    attribution: 'unknown',
    conversion_definition: 'conversion (optimization goal)',
    complete: false,
    source_name: '=SOURCE()',
  },
  semantics_source: 'Retained declarations; not independently verified',
  captured_at: 1790900000000,
  mapping: {
    entity_id: '/dimensions/campaign_id',
    entity_name: '/metrics/campaign_name',
    date: {path: '/dimensions/stat_time_day', format: 'tiktok_day'},
    spend: '/metrics/spend',
    clicks: '/metrics/clicks',
    conversions: '/metrics/conversion',
  },
  coverage: {spend: 'mapped', clicks: 'mapped', conversions: 'partial', conversion_value: 'unmapped'},
  totals: {spend: '9007199254740993.123456789', clicks: '0', conversions: null},
  rows: Array.from({length: count}, (_, i) => ({
    entity_id: '000' + String(9007199254740993n + BigInt(i)),
    entity_name: i === 0 ? '=1+1' : 'رمضان Home',
    date: '2026-09-01',
    search_term: '@native',
    spend: '9007199254740993.123456789',
    impressions: '100',
    clicks: '0',
    conversions: null,
    conversion_value: null,
    reach: null,
    frequency: null,
  })),
  source_request: {access_token: 'PRIVATE-TOKEN', query: {private: 'PRIVATE-QUERY'}},
  source_pages: [
    {
      page: 1,
      row_count: count,
      total_rows: count,
      source_hash: 'b'.repeat(64),
      captured_at: 1790900000001,
      source_request: {headers: {Authorization: 'PRIVATE-HEADER'}},
    },
  ],
  native_account_evidence: {
    account_id: '100',
    currency: 'USD',
    timezone: 'Etc/GMT',
    checks: [{source_hash: 'c'.repeat(64), captured_at: 1790900000000, source_request: {private: 'PRIVATE-ACCOUNT'}}],
  },
  private: 'PRIVATE-DOCUMENT',
});
const read = async bytes => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  return book;
};
test('detailed evidence XLSX exports every retained row as exact literal text with mappings, declarations and bounded source references', async () => {
  const {evidenceWorkbook} = await import('../dist/src/evidence-artifacts.js');
  const book = await read(await evidenceWorkbook(evidence(), 'en'));
  assert.deepEqual(
    book.worksheets.map(s => s.name),
    ['Report', 'Native rows', 'Metric totals', 'Field mappings', 'Source references'],
  );
  const rows = book.getWorksheet('Native rows');
  assert.equal(rows.rowCount, 102);
  assert.equal(rows.getCell('A2').value, '0009007199254740993');
  assert.equal(rows.getCell('B2').value, '=1+1');
  assert.equal(rows.getCell('B2').type, ExcelJS.ValueType.String);
  assert.equal(rows.getCell('E2').value, '9007199254740993.123456789');
  assert.equal(rows.getCell('G2').value, '0');
  assert.equal(rows.getCell('H2').value, null);
  assert.equal(rows.getCell('A102').value, '0009007199254741093');
  assert.equal(rows.views[0].state, 'frozen');
  assert.equal(rows.views[0].ySplit, 1);
  assert.ok(rows.autoFilter);
  const text = [];
  book.eachSheet(s =>
    s.eachRow(r =>
      r.eachCell(c => {
        assert.notEqual(c.type, ExcelJS.ValueType.Formula);
        assert.notEqual(c.type, ExcelJS.ValueType.Hyperlink);
        text.push(String(c.value));
      }),
    ),
  );
  assert.ok(text.includes('false'));
  assert.ok(text.includes('unknown'));
  assert.ok(text.includes('tiktok_day'));
  assert.ok(text.includes('a'.repeat(64)));
  assert.ok(text.includes('b'.repeat(64)));
  assert.ok(text.includes('c'.repeat(64)));
  assert.doesNotMatch(text.join('\n'), /PRIVATE/);
  assert.match(text.join('\n'), /text.*precision/i);
});
test('detailed evidence workbook language is explicit and changes labels and view direction without changing native cell values', async () => {
  const {evidenceWorkbook} = await import('../dist/src/evidence-artifacts.js');
  const en = await read(await evidenceWorkbook(evidence(1), 'en')),
    ar = await read(await evidenceWorkbook(evidence(1), 'ar'));
  assert.equal(ar.worksheets[1].views[0].rightToLeft, true);
  assert.match(ar.worksheets[0].name, /[\u0600-\u06ff]/);
  assert.deepEqual(ar.worksheets[1].getRow(2).values, en.worksheets[1].getRow(2).values);
  assert.deepEqual(
    ar.worksheets[1].getRow(1).values,
    en.worksheets[1].getRow(1).values,
    'native column keys are stable across languages',
  );
  await assert.rejects(evidenceWorkbook(evidence(1), 'fr'), /language/i);
});
test('detailed evidence generation bounds rows, cell types and text and shares concurrency with existing report artifacts', async () => {
  const {evidenceWorkbook, evidenceArtifact} = await import('../dist/src/evidence-artifacts.js');
  await assert.rejects(evidenceWorkbook(evidence(10001)), /limit/i);
  const long = evidence(1);
  long.rows[0].entity_name = 'x'.repeat(32768);
  await assert.rejects(evidenceWorkbook(long), /cell/i);
  const object = evidence(1);
  object.rows[0].entity_name = {formula: '1+1'};
  await assert.rejects(evidenceWorkbook(object), /scalar|text|value/i);
  const large = evidence(10000);
  for (const row of large.rows) row.entity_name = 'ع'.repeat(500);
  await assert.rejects(evidenceWorkbook(large), /text.*limit/i);
  const pending = reportArtifact('shared-evidence-download', packFixture(), 'xlsx', {});
  await assert.rejects(
    evidenceArtifact('shared-evidence-download', evidence(1), 'en'),
    e => e.code === 'REPORT_DOWNLOAD_BUSY',
  );
  await pending;
  const empty = await read(await evidenceWorkbook(evidence(0)));
  assert.equal(empty.getWorksheet('Native rows').rowCount, 1);
});

test('parent-scoped evidence exports exact campaign identity and bounded parent hashes without native request bodies', async () => {
  const {evidenceWorkbook} = await import('../dist/src/evidence-artifacts.js'),
    report = evidence(1),
    parentId = '22222222-2222-4222-8222-000000000400';
  report.native_account_evidence.parent_campaign = {
    id: parentId,
    checks: [{source_hash: 'd'.repeat(64), captured_at: 1790900000002, source_request: {private: 'PRIVATE-PARENT'}}],
  };
  for (const language of ['en', 'ar']) {
    const book = await read(await evidenceWorkbook(report, language));
    assert.ok(book.worksheets[0].getColumn(2).values.includes(parentId));
    const refs = book.worksheets[4];
    assert.ok(refs.getColumn(1).values.includes('parent_campaign'));
    assert.ok(refs.getColumn(4).values.includes('d'.repeat(64)));
    assert.doesNotMatch(JSON.stringify(refs.getSheetValues()), /PRIVATE/);
  }
  for (const checks of [
    null,
    {},
    Array.from({length: 103}, () => report.native_account_evidence.parent_campaign.checks[0]),
  ]) {
    const invalid = structuredClone(report);
    invalid.native_account_evidence.parent_campaign.checks = checks;
    await assert.rejects(evidenceWorkbook(invalid), /reference.*count/i);
  }
  const missing = structuredClone(report);
  delete missing.native_account_evidence.parent_campaign.id;
  await assert.rejects(evidenceWorkbook(missing), /retained ID/i);
});

async function httpFixture(t) {
  const master = Buffer.alloc(32, 107).toString('base64'),
    store = new Store(':memory:', master),
    actor = {tenantId: 'local', userId: 'operator', role: 'admin'},
    origin = 'https://amcp.shop',
    connection = {
      id: 'login',
      tenantId: 'local',
      gateway: 'tiktok_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  store.putDocument('local', 'decision_report', 'native-evidence', evidence());
  const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('No provider requests');
      }),
    ),
    listener = await listenForFetch(
      createHttpApp(service, store, {website: {origin, masterKey: master, adminPassword: 'synthetic-test-password'}}),
    ),
    base = 'http://127.0.0.1:' + listener.address().port;
  t.after(async () => {
    await listener.close();
    store.close();
  });
  const login = await fetch(base + '/api/session', {
    method: 'POST',
    headers: {Origin: origin, 'Content-Type': 'application/json'},
    body: JSON.stringify({password: 'synthetic-test-password'}),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await login.arrayBuffer();
  return {actor, connection, store, service, base, cookie, path: '/api/reporting-evidence/native-evidence.xlsx'};
}
test('evidence download requires a session, current account access and returns all rows with private cache and content hash', async t => {
  const f = await httpFixture(t);
  let out = await fetch(f.base + f.path);
  await out.arrayBuffer();
  assert.equal(out.status, 401);
  out = await fetch(f.base + f.path + '?language=en', {headers: {Cookie: f.cookie}});
  const bytes = Buffer.from(await out.arrayBuffer());
  assert.equal(out.status, 200, bytes.toString());
  assert.equal(out.headers.get('cache-control'), 'no-store');
  assert.match(out.headers.get('content-disposition'), /attachment/);
  assert.equal(out.headers.get('x-content-sha256'), createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await read(bytes)).getWorksheet('Native rows').rowCount, 102);
  const metadata = await f.service.call('amcp_reporting', {action: 'get', id: 'native-evidence'}, f.actor);
  assert.equal(metadata.data.xlsx_path, f.path);
  for (const path of [f.path + '?language=fr', '/api/reporting-evidence/missing.xlsx']) {
    out = await fetch(f.base + path, {headers: {Cookie: f.cookie}});
    await out.arrayBuffer();
    assert.notEqual(out.status, 200);
  }
  f.store.putConnection(f.actor, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
  out = await fetch(f.base + f.path, {headers: {Cookie: f.cookie}});
  await out.arrayBuffer();
  assert.notEqual(out.status, 200);
});
test('evidence export rechecks session, account access and document revision after asynchronous workbook generation', async t => {
  for (const mode of ['access', 'revision', 'session']) {
    const f = await httpFixture(t),
      original = f.store.resolveConnection.bind(f.store);
    let checks = 0;
    f.store.resolveConnection = (...args) => {
      if (++checks === 1 && mode === 'session') f.store.db.prepare('DELETE FROM amcp_web_sessions').run();
      if (checks === 2) {
        if (mode === 'access')
          f.store.putConnection(f.actor, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
        else
          f.store.putDocument('local', 'decision_report', 'native-evidence', {
            ...evidence(),
            source_hash: 'd'.repeat(64),
          });
      }
      return original(...args);
    };
    const out = await fetch(f.base + f.path, {headers: {Cookie: f.cookie}});
    await out.arrayBuffer();
    assert.notEqual(out.status, 200);
    assert.ok(checks >= (mode === 'session' ? 1 : 2));
    if (mode === 'session') assert.equal(out.status, 401);
    if (mode === 'revision') assert.equal(out.status, 409);
  }
});
