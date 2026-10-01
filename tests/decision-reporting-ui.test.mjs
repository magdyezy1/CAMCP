import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture(getReport, getList) {
  const nodes = new Map();
  let focused;
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        isConnected: true,
        addEventListener() {},
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
    document: {addEventListener() {}},
    navigationGeneration: 1,
    identityGeneration: 1,
    content: node('#content'),
    $: node,
    workspaceCall: async (_tool, args) =>
      args.action === 'list' ? (getList ? getList() : {reports: []}) : getReport ? getReport() : report,
    mountCaptureWizard: async fn => {
      open = fn;
    },
    mountReferenceImport() {},
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
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
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

test('late report lists and their failures do not render after identity changes', async () => {
  for (const fail of [false, true]) {
    let resolve, reject;
    const pending = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const f = fixture(undefined, () => pending);
    const rendering = f.render();
    f.context.identityGeneration++;
    if (fail) reject(Error('Previous identity list error'));
    else resolve({reports: [f.report]});
    await assert.doesNotReject(rendering);
    assert.equal(f.node('#content').innerHTML, '');
    assert.equal(f.node('#decision-report-list').innerHTML, '');
  }
});
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
test('a late retained report cannot paint or raise errors in a new identity', async () => {
  for (const fail of [false, true]) {
    let resolve, reject;
    const pending = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    const f = fixture(() => pending);
    await f.render();
    const opening = f.open();
    f.context.identityGeneration++;
    f.node('#report-detail').innerHTML = 'New identity';
    if (fail) reject(Error('obsolete report'));
    else resolve(f.report);
    await opening;
    assert.equal(f.node('#report-detail').innerHTML, 'New identity');
    assert.equal(f.url(), undefined);
  }
});
