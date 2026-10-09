import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ownerOperations} from '../dist/src/owner-operations.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {packFixture} from './fixtures/report-pack-data.mjs';

/**
 * SEC-05 (review 2026-10-08): the role matrix says viewers have no exports and Sheets export refuses them, but every
 * report-file download route checked only the session and account access, so a viewer downloaded CSV, evidence, PDF
 * and Excel files. Downloads now need an operator role unless the workspace owner allows viewer downloads.
 */
const origin = 'https://amcp.shop',
  master = Buffer.alloc(32, 64).toString('base64'),
  password = 'synthetic-downloads-admin-password';

async function site() {
  const store = new Store(':memory:', master);
  store.putConnection(
    {tenantId: 'local', userId: 'workspace-admin', role: 'admin'},
    {
      id: 'meta',
      tenantId: 'local',
      gateway: 'meta_native_action',
      accounts: ['00100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const report = packFixture();
  store.putDocument('local', 'overview_report', report.id, report);
  let network = 0;
  const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        network++;
        throw Error('Unexpected provider request');
      }),
    ),
    website = {origin, masterKey: master, adminPassword: password, authEnv: {}};
  const listener = await listenForFetch(createHttpApp(service, store, {publicOrigin: origin, website}));
  const base = 'http://127.0.0.1:' + listener.address().port,
    web = new WebStore(store, website),
    accounts = new UserAccounts(web);
  const member = (role, email = role + '@example.test') => {
    const user = accounts.newUser('Member ' + role, email, null, true);
    store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run('local', user.id, role, Date.now());
    const s = accounts.session(user, 'local');
    return {user, headers: {Cookie: web.cookie(s.id), 'X-AMCP-CSRF': s.csrf}};
  };
  const login = await fetch(base + '/api/session', {
    method: 'POST',
    headers: {Origin: origin, 'Content-Type': 'application/json'},
    body: JSON.stringify({password}),
  });
  const owner = {Cookie: login.headers.get('set-cookie').split(';')[0], 'X-AMCP-CSRF': (await login.json()).csrf};
  const request = async (path, headers, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return {status: response.status, json, text, disposition: response.headers.get('content-disposition')};
  };
  return {
    store,
    report,
    member,
    owner,
    request,
    network: () => network,
    close: async () => {
      await new Promise(resolve => listener.close(resolve));
      store.close();
    },
  };
}

/** Every website route that hands out a report file: the retained report's CSV and source evidence, its PDF and Excel
 * packs, retained report files, and detailed evidence workbooks. */
const routes = report => ({
  csv: '/api/reporting-overview/' + report.id + '.csv',
  metadata: '/api/reporting-overview/' + report.id + '.metadata.json',
  pack_pdf: '/api/reporting-overview/missing-pack.pdf',
  pack_xlsx: '/api/reporting-overview/missing-pack.xlsx',
  file_pdf: '/api/reporting-files/missing-export.pdf',
  file_xlsx: '/api/reporting-files/missing-export.xlsx',
  evidence_xlsx: '/api/reporting-evidence/missing-evidence.xlsx?language=en',
});

test('SEC-05: viewers cannot download report files from any download route by default (regression: a viewer received the CSV and evidence attachments)', async () => {
  const s = await site();
  try {
    const viewer = s.member('viewer');
    for (const [name, path] of Object.entries(routes(s.report))) {
      const refused = await s.request(path, viewer.headers);
      assert.equal(refused.status, 403, name);
      assert.equal(refused.json.error.code, 'FORBIDDEN', name);
      assert.match(refused.json.error.message, /operator role is required to download report files/, name);
      assert.equal(refused.disposition, null, name);
    }
    const session = await s.request('/api/session', viewer.headers);
    assert.equal(session.json.downloadsAllowed, false);
    // Operators and the owner download as before; the gate passes for the routes whose fixtures do not exist (404).
    for (const headers of [s.member('operator').headers, s.owner]) {
      const csv = await s.request(routes(s.report).csv, headers);
      assert.equal(csv.status, 200);
      assert.match(csv.disposition, /attachment/);
      assert.equal((await s.request(routes(s.report).metadata, headers)).status, 200);
      assert.equal((await s.request(routes(s.report).file_pdf, headers)).status, 404);
      assert.equal((await s.request('/api/session', headers)).json.downloadsAllowed, true);
    }
    assert.equal(s.network(), 0);
  } finally {
    await s.close();
  }
});

test('SEC-05: the workspace owner may allow viewer downloads, audited; others cannot change it and confirmation is required', async () => {
  const s = await site();
  try {
    const viewer = s.member('viewer'),
      operator = s.member('operator'),
      admin = s.member('admin');
    for (const headers of [viewer.headers, operator.headers, admin.headers]) {
      const refused = await s.request('/api/export-policy', headers, {viewer_downloads: true, confirmed: true});
      assert.equal(refused.status, 403);
      assert.equal(refused.json.error.code, 'OWNER_REQUIRED');
    }
    const unconfirmed = await s.request('/api/export-policy', s.owner, {viewer_downloads: true});
    assert.equal(unconfirmed.status, 400);
    assert.equal((await s.request(routes(s.report).csv, viewer.headers)).status, 403);
    const saved = await s.request('/api/export-policy', s.owner, {viewer_downloads: true, confirmed: true});
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.viewer_downloads, true);
    const csv = await s.request(routes(s.report).csv, viewer.headers);
    assert.equal(csv.status, 200);
    assert.match(csv.disposition, /attachment/);
    assert.equal((await s.request(routes(s.report).metadata, viewer.headers)).status, 200);
    for (const name of ['pack_pdf', 'file_xlsx', 'evidence_xlsx'])
      assert.equal((await s.request(routes(s.report)[name], viewer.headers)).status, 404, name);
    assert.equal((await s.request('/api/session', viewer.headers)).json.downloadsAllowed, true);
    const health = ownerOperations(
      s.store,
      {action: 'health'},
      {tenantId: 'local', userId: 'workspace-admin', role: 'admin'},
    );
    assert.deepEqual(health.export_policy, {viewer_downloads: true});
    assert.equal(
      (await s.request('/api/export-policy', s.owner, {viewer_downloads: false, confirmed: true})).status,
      200,
    );
    assert.equal((await s.request(routes(s.report).csv, viewer.headers)).status, 403);
    const audit = s.store.db
      .prepare('SELECT event FROM audit ORDER BY seq')
      .all()
      .map(r => JSON.parse(r.event))
      .filter(e => e.event === 'export_policy_saved')
      .map(e => [e.viewer_downloads, e.by]);
    assert.deepEqual(audit, [
      [true, 'workspace-admin'],
      [false, 'workspace-admin'],
    ]);
  } finally {
    await s.close();
  }
});

test('SEC-05: download controls are hidden when the session may not download, and shown otherwise', async () => {
  const pack = async downloadsAllowed => {
    const content = {innerHTML: '', querySelector: () => ({setAttribute() {}, focus() {}})};
    const context = createContext({
      document: {addEventListener() {}},
      navigationGeneration: 1,
      identityGeneration: 1,
      content,
      location: {search: '?report_id=synthetic'},
      URLSearchParams,
      overviewCall: async () => ({csv_path: '/api/reporting-overview/r.csv', evidence_path: '/r.json'}),
      bindReportPresentation: async () => {},
      reportPackBody: () => '<article>Snapshot</article>',
      workspaceBind() {},
      encodeURIComponent,
      esc: String,
      ...(downloadsAllowed === undefined ? {} : {session: {downloadsAllowed}}),
    });
    const source = readFileSync('web/evidence-workflows.js', 'utf8');
    new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
    new Script(source.slice(source.indexOf('async function renderReportPack('))).runInContext(context);
    await new Script('renderReportPack()').runInContext(context);
    return content.innerHTML;
  };
  for (const allowed of [undefined, true]) {
    const html = await pack(allowed);
    for (const control of ['id="download-pack"', 'id="download-pack-pdf"', 'id="download-pack-xlsx"', 'r.csv'])
      assert.ok(html.includes(control), control);
  }
  const hidden = await pack(false);
  for (const control of ['download-pack', 'r.csv', '/r.json']) assert.ok(!hidden.includes(control), control);
  assert.ok(hidden.includes('id="print-pack"'));
  // Retained report files list no download links for such a session.
  const overview = readFileSync('web/reporting-overview.js', 'utf8'),
    start = overview.indexOf('function reportFileLinks('),
    links = overview.slice(start, overview.indexOf('\n}\n', start) + 3);
  for (const [allowed, count] of [
    [undefined, 2],
    [false, 0],
  ]) {
    const context = createContext({
      esc: String,
      encodeURIComponent,
      uiText: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]),
      ...(allowed === undefined ? {} : {session: {downloadsAllowed: allowed}}),
    });
    new Script(links).runInContext(context);
    context.e = {
      id: 'export',
      files: [
        {format: 'pdf', size_bytes: 2048},
        {format: 'xlsx', size_bytes: 4096},
      ],
    };
    const html = new Script('reportFileLinks(e)').runInContext(context);
    assert.equal((html.match(/\/api\/reporting-files\//g) ?? []).length, count);
  }
  // The detailed evidence workbook panel explains the limit instead of offering the download.
  const evidence = readFileSync('web/evidence-workflows.js', 'utf8'),
    from = evidence.indexOf('function mountEvidenceDownload('),
    mount = evidence.slice(from, evidence.indexOf('\n}\n', from) + 3);
  for (const allowed of [undefined, false]) {
    const root = {innerHTML: '', isConnected: true, setAttribute() {}};
    const context = createContext({
      navigationGeneration: 1,
      identityGeneration: 1,
      esc: String,
      encodeURIComponent,
      uiText: text => text,
      $: selector =>
        selector === '#report-evidence-download' ? root : {value: 'en', addEventListener() {}, disabled: false},
      ...(allowed === undefined ? {} : {session: {downloadsAllowed: allowed}}),
    });
    new Script(mount).runInContext(context);
    context.report = {id: 'evidence'};
    new Script('mountEvidenceDownload(report, () => true)').runInContext(context);
    assert.equal(root.innerHTML.includes('id="evidence-download-xlsx"'), allowed === undefined);
    assert.equal(root.innerHTML.includes('limited to operators'), allowed === false);
  }
});
