import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture() {
  const bindings = new Map(),
    requests = [],
    confirmations = [];
  const status = {textContent: ''},
    root = {innerHTML: '', isConnected: true, setAttribute() {}, querySelector: () => status};
  const escape = v =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;');
  const c = createContext({
    document: {addEventListener() {}},
    $: () => ({focus() {}}),
    navigationGeneration: 1,
    identityGeneration: 1,
    esc: escape,
    pretty: String,
    date: String,
    badge: escape,
    errorMessage: e => e.message,
    recordDetails: v => '<pre>' + escape(JSON.stringify(v)) + '</pre>',
    toast() {},
    workspaceBind: (s, fn) => bindings.set(s, fn),
    workspaceCall: (tool, args) => new Promise((resolve, reject) => requests.push({tool, args, resolve, reject})),
    confirmAction: () => new Promise(resolve => confirmations.push(resolve)),
    root,
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
  new Script(readFileSync('web/operations-center.js', 'utf8')).runInContext(c);
  const controller = new Script("workbookRunController(root, 'original')").runInContext(c);
  const run = {
    id: 'original',
    name: '<img onerror=bad>',
    state: 'prepared',
    gateway: 'meta_native_action',
    account_id: '100',
    connection_id: 'meta',
    query_id: 'query',
    query_revision: 2,
    attempts: 0,
    can_resume: true,
    run_version: 'version-1',
    next_safe_action: 'Inspect & resume',
    next_call: {tool: 'amcp_native_action'},
    created_at: 1,
    updated_at: 2,
  };
  return {bindings, requests, confirmations, root, c, controller, run};
}

test('workbook run view escapes labels and resumes only the inspected original after confirmation', async () => {
  const f = fixture();
  const loaded = f.controller.load();
  f.requests[0].resolve(f.run);
  await loaded;
  assert.match(f.root.innerHTML, /&lt;img/);
  assert.doesNotMatch(f.root.innerHTML, /<img/);
  assert.match(f.root.innerHTML, /Resume report/);
  const cancelled = f.bindings.get('#workbook-run-resume')();
  f.confirmations[0](false);
  await cancelled;
  assert.equal(f.requests.length, 1);
  const accepted = f.bindings.get('#workbook-run-resume')();
  f.confirmations[1](true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].args)), {
    action: 'resume_report_run',
    id: 'original',
    run_version: 'version-1',
    confirmed: true,
  });
  f.requests[1].resolve({...f.run, state: 'queued', can_resume: false});
  await new Promise(resolve => setImmediate(resolve));
  f.requests[2].resolve({...f.run, state: 'queued', can_resume: false});
  await accepted;
  assert.doesNotMatch(f.root.innerHTML, /id="workbook-run-resume"/);
});

test('workbook detail refuses stale refreshes, identity changes and confirmation after navigation', async () => {
  const f = fixture();
  const old = f.controller.load(),
    current = f.controller.load();
  f.requests[1].resolve({...f.run, name: 'Newest'});
  await current;
  f.requests[0].resolve({...f.run, name: 'Old private result'});
  await old;
  assert.match(f.root.innerHTML, /Newest/);
  assert.doesNotMatch(f.root.innerHTML, /Old private/);
  const resume = f.bindings.get('#workbook-run-resume')();
  f.c.identityGeneration++;
  f.confirmations[0](true);
  await resume;
  assert.equal(f.requests.length, 2);
  const other = fixture(),
    loading = other.controller.load();
  other.c.navigationGeneration++;
  other.requests[0].resolve(other.run);
  await loading;
  assert.doesNotMatch(other.root.innerHTML, /onerror|Resume report/);
  const detached = fixture(),
    last = detached.controller.load();
  detached.root.isConnected = false;
  detached.requests[0].reject(Error('private failure'));
  await last;
  assert.doesNotMatch(detached.root.innerHTML, /private failure/);
});
