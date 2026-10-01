import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createContext, Script} from 'node:vm';

function fixture() {
  const root = {innerHTML: '', textContent: ''},
    bindings = new Map(),
    calls = [],
    pending = [];
  const element = () => ({
    value: '',
    hidden: false,
    dataset: {},
    addEventListener() {},
    closest: () => ({hidden: false}),
  });
  const form = {
    elements: Object.fromEntries(
      [
        'report_name',
        'partial_delivery',
        'schedule_kind',
        'hour',
        'minute',
        'weekday',
        'day',
        'timezone',
        'preset',
        'days',
        'offset_days',
        'window_timezone',
      ].map(k => [k, element()]),
    ),
    addEventListener() {},
  };
  const dialog = {
    open: false,
    isConnected: true,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  };
  const fields = new Map([
    ['#report-delivery-content', root],
    ['#delivery-status', root],
    ['#report-delivery-dialog', dialog],
    ['#report-schedule', form],
  ]);
  const b = {sheets_connections: [], destinations: [], file_destinations: [], views: [], schedules: [], platforms: []};
  const c = createContext({
    Intl,
    URLSearchParams,
    structuredClone,
    console,
    clearTimeout() {},
    setTimeout() {},
    deliveryTimer: null,
    navigationGeneration: 1,
    identityGeneration: 1,
    location: {pathname: '/reporting-overview'},
    session: {workspaceRole: 'operator'},
    document: {querySelector: () => null, addEventListener() {}},
    $: s => {
      if (!fields.has(s)) fields.set(s, element());
      return fields.get(s);
    },
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    overviewState: {
      config: {
        name: 'Client report',
        client_name: '<img src=x>',
        sources: [{}],
        date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'},
      },
      selection: null,
      report: null,
      deliveryDraft: null,
    },
    overviewCall: async args => {
      calls.push(args);
      if (pending.length) return pending.shift()(args);
      return b;
    },
    deliveryBind: (s, fn) => bindings.set(s, fn),
    authBind() {},
    updateSavedReportChoices() {},
    overviewLabel: c => c.name,
    deliveryAccountSummary: () => ['Meta · 00100'],
    pretty: String,
    reportLabel: String,
    date: String,
    reportWindowLabel: () => '',
    reportWindowOptions: () => '',
    deliveryKey: () => 'file-target-test',
    FormData: class {
      constructor(f) {
        this.values = f.values ?? {};
      }
      get(k) {
        return this.values[k] ?? null;
      }
      getAll(k) {
        return this.values[k] ?? [];
      }
      *[Symbol.iterator]() {
        yield* Object.entries(this.values);
      }
    },
  });
  const source = process.env.AMCP_TEST_WEB_ROOT ?? 'web';
  new Script(readFileSync(join(source, 'localization.js'), 'utf8')).runInContext(c);
  new Script(readFileSync(join(source, 'report-delivery.js'), 'utf8')).runInContext(c);
  return {c, root, dialog, bindings, calls, pending, bootstrap: b, run: s => new Script(s).runInContext(c)};
}

test('a report with no Sheets login can choose files and schedule; formats and retention consent stay explicit', async () => {
  const f = fixture();
  await f.run('renderReportDelivery()');
  assert.match(f.root.innerHTML, /id="report-schedule"/);
  assert.match(f.root.innerHTML, /id="report-bind-files"/);
  assert.match(f.root.innerHTML, /&lt;img/);
  assert.doesNotMatch(f.root.innerHTML, /<img/);
  assert.doesNotMatch(f.root.innerHTML, /name="formats"[^>]*checked|name="confirmed"[^>]*checked/);
  await assert.rejects(f.bindings.get('#report-bind-files')({values: {name: 'Files', formats: []}}), /Choose/);
  await assert.rejects(f.bindings.get('#report-bind-files')({values: {name: 'Files', formats: ['pdf']}}), /Confirm/);
  assert.equal(f.calls.length, 1);
});

test('file destination response cannot attach a destination after identity change or a closed dialog', async () => {
  for (const reason of ['identity', 'closed']) {
    const f = fixture();
    await f.run('renderReportDelivery()');
    let release;
    f.pending.push(() => new Promise(r => (release = r)));
    const saving = f.bindings.get('#report-bind-files')({
      values: {
        name: 'Files',
        formats: ['pdf'],
        confirmed: 'on',
        brand_name: 'Client',
        accent_color: '#354B67',
        footer: '',
        template: 'standard',
      },
    });
    if (reason === 'identity') f.c.identityGeneration++;
    else f.dialog.close();
    release({id: 'old-destination'});
    await saving;
    assert.equal(f.c.overviewState.destinationId, undefined, reason);
    assert.equal(f.calls.length, 2, reason);
  }
});

test('a late bootstrap cannot paint delivery details on a newer route', async () => {
  const f = fixture();
  let release;
  f.pending.push(() => new Promise(r => (release = r)));
  const loading = f.run('renderReportDelivery()');
  f.c.navigationGeneration++;
  release(f.bootstrap);
  await loading;
  assert.equal(f.root.innerHTML, '');
  assert.equal(f.dialog.open, false);
});

test('delivery history names stored formats and binds downloads to the original export without trusting supplied URLs', () => {
  const f = fixture(),
    source = process.env.AMCP_TEST_WEB_ROOT ?? 'web';
  const separate = createContext({esc: f.c.esc, document: {addEventListener() {}}});
  new Script(readFileSync(join(source, 'localization.js'), 'utf8')).runInContext(separate);
  new Script(readFileSync(join(source, 'reporting-overview.js'), 'utf8')).runInContext(separate);
  separate.record = {
    exports: [
      {
        id: 'original export',
        state: 'complete',
        destination_kind: 'report_files',
        destination_name: '<img src=x>',
        files: [{format: 'pdf', size_bytes: 1234, download_path: 'javascript:private'}],
      },
    ],
  };
  const html = new Script('renderExportHistory(record)').runInContext(separate);
  assert.match(html, /Download PDF/);
  assert.match(html, /original%20export\.pdf/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /javascript:|<img/);
});
