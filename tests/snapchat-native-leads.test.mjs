import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {reportPreset, reportPresets} from '../dist/src/report-presets.js';
import ExcelJS from 'exceljs';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {creativePerformanceCases, seedCreativePerformance} from './fixtures/creative-performance-data.mjs';
import {
  snapchatEvidenceInput as purchase,
  snapchatEvidenceCampaign as campaign,
  snapchatEvidenceEntity as entity,
  snapchatEvidenceId as id,
  snapchatEvidenceResponse as response,
} from './fixtures/snapchat-evidence-data.mjs';
const leadInput = level => ({
  ...purchase,
  preset: 'snapchat_' + level + '_leads',
  campaign_id: level === 'campaign' ? undefined : campaign,
  swipe_up_attribution_window: undefined,
  view_attribution_window: undefined,
  semantics: {...purchase.semantics, source_name: 'Synthetic native form submissions'},
});
function fixture(t, level = 'campaign', count = '3', size = 1, tenantId = 'snapchat-native-leads') {
  const actor = {tenantId, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 119).toString('base64')),
    connection = {
      id: purchase.connection_id,
      tenantId: actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: [purchase.account_id],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: ['snapchat-marketing-api'],
    },
    credentials = {accessToken: 'synthetic'},
    requests = [];
  t.after(() => store.close());
  store.putConnection(actor, connection, credentials);
  const rows = Array.from({length: size}, (_, i) => entity(level, id(i + 1))),
    row = rows[0];
  for (const item of rows)
    for (const day of item.timeseries) {
      day.stats.native_leads = count;
      delete day.stats.conversion_purchases;
    }
  let edit = (_url, data) => data;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(raw);
      requests.push({path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method});
      assert.equal(init.method, 'GET');
      const data = response(raw, rows);
      if (url.pathname.endsWith('/stats')) {
        const stat = data.timeseries_stats[0].timeseries_stat;
        delete stat.swipe_up_attribution_window;
        delete stat.view_attribution_window;
        delete stat.conversion_data_processed_end_time;
      }
      return Response.json(edit(url, data));
    }),
  );
  return {
    actor,
    store,
    connection,
    credentials,
    requests,
    row,
    rows,
    edit: fn => {
      edit = fn;
    },
    service,
    call: (args = leadInput(level)) => service.call('amcp_reporting', args, actor),
  };
}
const ok = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data;
};
const stat = data => data.timeseries_stats[0].timeseries_stat;
const unsaved = f => assert.equal(f.store.documents(f.actor.tenantId, 'decision_report').length, 0);
test('three native lead presets expose independent source definitions without changing purchase request bytes', () => {
  assert.equal(reportPresets.filter(p => p.id.startsWith('snapchat_') && p.id.endsWith('_leads')).length, 3);
  for (const level of ['campaign', 'adsquad', 'ad']) {
    const p = reportPreset(leadInput(level));
    assert.equal(p.arguments.query.fields, 'spend,impressions,swipes,native_leads');
    assert.equal(p.mapping.conversions, '/stats/native_leads');
    for (const key of [
      'swipe_up_attribution_window',
      'view_attribution_window',
      'action_report_time',
      'conversion_source_types',
    ])
      assert.equal(p.arguments.query[key], undefined);
  }
  assert.equal(reportPreset(purchase).arguments.query.fields, 'spend,impressions,swipes,conversion_purchases');
  assert.equal(reportPreset(purchase).semantics.conversion_definition, 'conversion_purchases (total sources)');
});
for (const level of ['campaign', 'adsquad', 'ad'])
  test('native ' + level + ' submissions retain exact counts, spend, finalized pages and original scope', async t => {
    const f = fixture(t, level),
      out = ok(await f.call());
    assert.equal(out.row_count, 2);
    assert.equal(out.totals.conversions, '6');
    assert.equal(out.totals.spend, '20.246912');
    assert.equal(out.rows[0].conversions, '3');
    assert.equal(out.source_request.query.fields, 'spend,impressions,swipes,native_leads');
    assert.match(out.semantics.conversion_definition, /native_leads/);
    assert.match(out.semantics_source, /Native submitted-form counts use native_leads/);
    assert.doesNotMatch(out.semantics_source, /Explicit swipe\/view windows|conversion-time reporting/);
    assert.equal(out.native_account_evidence.checks.length, 2);
    assert.equal(out.source_pages.length, 1);
    assert.equal(out.source_pages[0].conversion_data_processed_end_time, undefined);
    assert.ok(out.source_pages.every(p => p.source_hash && p.finalized_data_end_time));
    if (level !== 'campaign') {
      assert.equal(out.source_request.path_params.campaign_id, campaign);
      assert.equal(out.native_account_evidence.parent_campaign.checks.length, 3);
    }
    assert.ok(f.requests.every(r => r.method === 'GET' && !/lead_generation_forms|leads_report|webhook/.test(r.path)));
    const again = ok(await f.call());
    assert.equal(ok(await f.call({action: 'reconcile_report', id: out.id, reference_id: again.id})).matched, true);
  });
// r12-fix item 1 (O-4 of the live checks of 2026-11-16): the lead presets share the stats collector, so the same rule holds. An
// answer with no rows may leave out finalized_data_end_time (the only time these presets need); an answer with rows may not.
for (const level of ['campaign', 'adsquad', 'ad'])
  test(
    'native ' +
      level +
      ' submissions of a window with no rows complete when the answer leaves out its finalization time',
    async t => {
      const f = fixture(t, level, '3', 0);
      f.edit((url, data) => {
        if (url.pathname.endsWith('/stats')) delete stat(data).finalized_data_end_time;
        return data;
      });
      const out = ok(await f.call());
      assert.equal(out.row_count, 0);
      assert.equal(out.source_pages.length, 1);
      assert.equal(out.source_pages[0].entity_count, 0);
      assert.equal(out.source_pages[0].finalized_data_end_time, undefined);
    },
  );
test('native form counts preserve exact large integers and distinguish missing evidence from a zero', async t => {
  const f = fixture(t);
  f.row.timeseries[0].stats.native_leads = '9007199254740993';
  f.row.timeseries[1].stats.native_leads = 0;
  const out = ok(await f.call());
  assert.equal(out.totals.conversions, '9007199254740993');
  assert.deepEqual(
    out.rows.map(r => r.conversions),
    ['9007199254740993', '0'],
  );
  delete f.row.timeseries[1].stats.native_leads;
  const missing = ok(await f.call());
  assert.equal(missing.rows[1].conversions, null);
  assert.equal(missing.coverage.conversions, 'partial');
});
test('native lead pages retain all 201 entities and independent page finalization with unchanged settings', async t => {
  const f = fixture(t, 'ad', '3', 201),
    out = ok(await f.call());
  assert.equal(out.row_count, 402);
  assert.equal(out.totals.conversions, '1206');
  assert.equal(out.totals.spend, '4069.629312');
  assert.deepEqual(
    out.source_pages.map(p => p.row_count),
    [400, 2],
  );
  assert.equal(out.has_more, true);
  const retained = f.store.document(f.actor.tenantId, 'decision_report', out.id);
  assert.equal(retained.rows.length, 402);
  assert.equal(new Set(retained.rows.map(r => r.entity_id)).size, 201);
  const pages = f.requests.filter(r => r.path.endsWith('/stats'));
  assert.equal(pages.length, 2);
  assert.equal(pages[1].query.cursor, '200');
  assert.deepEqual({...pages[1].query, cursor: undefined}, {...pages[0].query, cursor: undefined});
  assert.ok(out.source_pages.every(p => p.finalized_data_end_time && !p.conversion_data_processed_end_time));
});
for (const kind of ['late_page', 'changed_fields', 'foreign_cursor', 'repeated_entity', 'parent_changed'])
  test('native lead continuation refuses ' + kind + ' and retains no partial snapshot', async t => {
    const f = fixture(t, 'ad', '3', 201);
    let parentReads = 0;
    f.edit((url, data) => {
      if (url.pathname.endsWith('/stats')) {
        const second = url.searchParams.has('cursor');
        if (kind === 'late_page' && second) stat(data).finalized_data_end_time = stat(data).start_time;
        if (kind === 'repeated_entity' && second) stat(data).breakdown_stats.ad[0].id = f.row.id;
        if (!second && kind === 'changed_fields') {
          const link = new URL(data.paging.next_link);
          link.searchParams.set('fields', 'spend,impressions,swipes,conversion_purchases');
          data.paging.next_link = link.href;
        }
        if (!second && kind === 'foreign_cursor')
          data.paging.next_link = 'https://foreign.example.test/v1/campaigns/' + campaign + '/stats?cursor=200';
      }
      if (url.pathname === '/v1/campaigns/' + campaign) {
        parentReads++;
        if (kind === 'parent_changed' && parentReads === 2) data.campaigns[0].campaign.ad_account_id = id(999);
      }
      return data;
    });
    assert.equal((await f.call()).success, false);
    unsaved(f);
    assert.ok(f.requests.every(r => r.method === 'GET'));
    if (['changed_fields', 'foreign_cursor'].includes(kind))
      assert.equal(f.requests.filter(r => r.path.endsWith('/stats')).length, 1);
  });
for (const value of [-1, 9007199254740992, '1.25', '1e3', '-1', '1'.repeat(31)])
  test('native lead counts refuse inexact or invalid integer ' + String(value), async t => {
    const f = fixture(t);
    f.row.timeseries[0].stats.native_leads = value;
    assert.equal((await f.call()).error?.code, 'REPORT_SHAPE_CHANGED');
    unsaved(f);
  });
for (const kind of [
  'not_finalized',
  'missing_finalization',
  'wrong_day',
  'duplicate',
  'foreign_account',
  'changed_currency',
  'revoked',
  'wrong_parent',
  'bad_count',
])
  test('native lead evidence refuses ' + kind + ' without retaining a report', async t => {
    const level = kind === 'wrong_parent' ? 'ad' : 'campaign',
      f = fixture(t, level);
    let accountReads = 0;
    f.edit((url, data) => {
      if (url.pathname.endsWith('/stats')) {
        if (kind === 'not_finalized') stat(data).finalized_data_end_time = stat(data).start_time;
        if (kind === 'missing_finalization') delete stat(data).finalized_data_end_time;
        if (kind === 'wrong_day')
          stat(data).breakdown_stats[level][0].timeseries[0].start_time = '2026-09-01T01:00:00Z';
        if (kind === 'duplicate')
          stat(data).breakdown_stats[level].push(structuredClone(stat(data).breakdown_stats[level][0]));
        if (kind === 'wrong_parent') stat(data).id = id(999);
        if (kind === 'bad_count') stat(data).breakdown_stats[level][0].timeseries[0].stats.native_leads = 1.25;
        if (kind === 'revoked') f.store.putConnection(f.actor, {...f.connection, enabled: false}, f.credentials);
      }
      if (url.pathname === '/v1/adaccounts/' + purchase.account_id) {
        accountReads++;
        if (kind === 'foreign_account') data.adaccounts[0].adaccount.id = id(999);
        if (kind === 'changed_currency' && accountReads === 2) data.adaccounts[0].adaccount.currency = 'SAR';
      }
      return data;
    });
    const out = await f.call();
    assert.equal(out.success, false, kind);
    unsaved(f);
  });
test('native lead presets refuse unrelated purchase settings and require current exact child parents before reads', async t => {
  const f = fixture(t, 'ad');
  for (const input of [
    {...leadInput('ad'), campaign_id: undefined},
    {...leadInput('ad'), campaign_id: '../foreign'},
    {...leadInput('campaign'), campaign_id: campaign},
    {...leadInput('campaign'), swipe_up_attribution_window: '7_DAY'},
    {...leadInput('campaign'), view_attribution_window: 'none'},
  ]) {
    assert.equal((await f.call(input)).success, false);
    unsaved(f);
  }
  assert.equal(f.requests.length, 0);
});
test('lead snapshots cannot be reconciled across original parent campaigns or with purchases', async t => {
  const f = fixture(t, 'ad'),
    a = ok(await f.call()),
    b = ok(await f.call());
  const saved = f.store.document(f.actor.tenantId, 'decision_report', b.id);
  f.store.putDocument(f.actor.tenantId, 'decision_report', b.id, {
    ...saved,
    source_request: {...saved.source_request, path_params: {campaign_id: id(401)}},
  });
  assert.equal(
    (await f.call({action: 'reconcile_report', id: a.id, reference_id: b.id})).error?.code,
    'REPORT_SEMANTICS_MISMATCH',
  );
  f.store.putDocument(f.actor.tenantId, 'decision_report', b.id, {
    ...saved,
    preset: 'snapchat_ad',
    semantics: {...saved.semantics, conversion_definition: 'conversion_purchases (total sources)'},
  });
  assert.equal(
    (await f.call({action: 'reconcile_report', id: a.id, reference_id: b.id})).error?.code,
    'REPORT_SEMANTICS_MISMATCH',
  );
});
test('retained linked-ad performance offers native form counts separately and rechecks current access without provider calls', async t => {
  const actor = {tenantId: 'native-lead-performance', userId: 'operator', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 120).toString('base64'));
  t.after(() => store.close());
  const spec = creativePerformanceCases.find(s => s.platform === 'snapchat'),
    seed = seedCreativePerformance(store, actor, spec),
    leadId = 'report-native-leads';
  store.putDocument(actor.tenantId, 'decision_report', leadId, {
    ...seed.report,
    preset: 'snapchat_ad_leads',
    semantics: {...seed.report.semantics, conversion_definition: 'native_leads (submitted native lead forms)'},
    rows: seed.report.rows.map((row, i) => ({...row, conversions: i === 0 ? '3' : row.conversions})),
  });
  let nativeRequests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      nativeRequests++;
      throw Error('Provider calls forbidden');
    }),
  );
  const call = args =>
      service.call('amcp_media', {action: 'asset_performance', asset_id: seed.assetId, ...args}, actor),
    choices = ok(await call({}));
  assert.deepEqual(choices.reports.map(r => r.id).sort(), [leadId, seed.reportId].sort());
  const out = ok(await call({report_id: leadId, plan_id: seed.planId}));
  assert.equal(out.preset, 'snapchat_ad_leads');
  assert.equal(out.rows[0].conversions, '3');
  assert.equal(out.network_requests, 0);
  assert.deepEqual(out.matched_ad_ids, [spec.ad]);
  store.putConnection({...actor, role: 'admin'}, {...seed.connection, enabled: false}, {accessToken: 'synthetic'});
  assert.equal((await call({report_id: leadId, plan_id: seed.planId})).success, false);
  assert.equal(nativeRequests, 0);
});

test('authenticated HTTP lead capture and English/Arabic all-row downloads preserve counts, parent references and current access', async t => {
  const f = fixture(t, 'ad', '3', 201, 'local'),
    origin = 'https://synthetic.example.test',
    masterKey = Buffer.alloc(32, 119).toString('base64');
  const listener = await listenForFetch(
    createHttpApp(f.service, f.store, {
      website: {origin, masterKey, adminPassword: 'synthetic-native-lead-test', authEnv: {}},
    }),
  );
  t.after(() => listener.close());
  const base = 'http://127.0.0.1:' + listener.address().port;
  const login = await fetch(base + '/api/session', {
    method: 'POST',
    headers: {Origin: origin, 'Content-Type': 'application/json'},
    body: JSON.stringify({password: 'synthetic-native-lead-test'}),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0],
    session = await login.json(),
    headers = {Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-AMCP-CSRF': session.csrf};
  const capture = await fetch(base + '/api/workspace/reporting', {
    method: 'POST',
    headers,
    body: JSON.stringify(leadInput('ad')),
  });
  assert.equal(capture.status, 200);
  const report = ok(await capture.json());
  assert.equal(report.row_count, 402);
  assert.equal(report.totals.conversions, '1206');
  const nativeRequests = f.requests.length;
  assert.equal(nativeRequests, 7);
  for (const language of ['en', 'ar']) {
    const download = await fetch(base + report.xlsx_path + '?language=' + language, {headers: {Cookie: cookie}});
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('cache-control'), 'no-store');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await download.arrayBuffer()));
    const rows = workbook.worksheets[1];
    assert.equal(rows.rowCount, 403);
    assert.equal(rows.getCell('H2').value, '3');
    assert.equal(rows.getCell('H403').value, '3');
    assert.equal(rows.views[0].rightToLeft, language === 'ar');
    const cover = workbook.worksheets[0];
    assert.ok(cover.getColumn(2).values.includes(campaign));
    assert.ok(cover.getColumn(2).values.includes('native_leads (submitted native lead forms)'));
    const references = workbook.worksheets[4];
    assert.equal(references.getColumn(1).values.filter(v => v === 'parent_campaign').length, 3);
    assert.equal(references.getColumn(1).values.filter(v => v === 'page').length, 2);
    const text = [];
    workbook.eachSheet(s => s.eachRow(r => r.eachCell(c => text.push(String(c.value)))));
    assert.doesNotMatch(text.join('\n'), /accessToken|Authorization|Bearer/);
  }
  assert.equal(f.requests.length, nativeRequests);
  f.store.putConnection(f.actor, {...f.connection, enabled: false}, f.credentials);
  const revoked = await fetch(base + report.xlsx_path, {headers: {Cookie: cookie}});
  await revoked.arrayBuffer();
  assert.notEqual(revoked.status, 200);
  assert.equal(f.requests.length, nativeRequests);
});
