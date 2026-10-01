import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture(getReport) {
  const nodes = new Map();
  let focused;
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        isConnected: true,
        setAttribute() {},
        focus() {
          focused = id;
        },
      });
    return nodes.get(id);
  };
  const report = {
    id: 'new-report',
    semantics: {
      source_name: 'Newly captured evidence',
      currency: 'USD',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      complete: true,
    },
    totals: {spend: '12.5', impressions: '100', clicks: '10', conversions: null},
    rows: [],
  };
  let open, url;
  const context = createContext({
    navigationGeneration: 1,
    content: node('#content'),
    $: node,
    workspaceCall: async (_tool, args) => (args.action === 'list' ? {reports: []} : getReport ? getReport() : report),
    mountCaptureWizard: async fn => {
      open = fn;
    },
    mountScenarioModel() {},
    workspaceBind() {},
    esc: v => String(v ?? ''),
    date: String,
    badge: String,
    blank: String,
    recordDetails: () => '',
    controls: () => '',
    history: {
      replaceState: (_a, _b, value) => {
        url = value;
      },
    },
    location: {search: ''},
    URLSearchParams,
    encodeURIComponent,
  });
  const source = readFileSync('web/workspace.js', 'utf8');
  new Script(source.slice(source.indexOf('async function renderDecisionReports()'))).runInContext(context);
  return {
    node,
    context,
    report,
    render: () => new Script('renderDecisionReports()').runInContext(context),
    open: () => open('new-report'),
    url: () => url,
    focused: () => focused,
  };
}
test('captured evidence appears in the current report list immediately without a reload', async () => {
  const f = fixture();
  await f.render();
  assert.match(f.node('#decision-report-list').innerHTML, /No evidence captured yet/);
  await f.open();
  assert.match(f.node('#decision-report-list').innerHTML, /Newly captured evidence/);
  assert.doesNotMatch(f.node('#decision-report-list').innerHTML, /No evidence captured yet/);
  assert.match(f.node('#decision-report-list').innerHTML, /data-report="new-report"/);
  assert.equal(f.url(), '/reports?id=new-report');
  assert.equal(f.focused(), '#report-detail');
});
test('a report response cannot replace the current page or URL after the user navigates away', async () => {
  let resolve;
  const pending = new Promise(r => {
    resolve = r;
  });
  const f = fixture(() => pending);
  await f.render();
  const opening = f.open();
  f.context.navigationGeneration++;
  f.node('#report-detail').innerHTML = 'Current destination';
  resolve(f.report);
  await opening;
  assert.equal(f.node('#report-detail').innerHTML, 'Current destination');
  assert.equal(f.url(), undefined);
  assert.equal(f.focused(), undefined);
});
