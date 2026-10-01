import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
function fixture() {
  const bindings = new Map(),
    requests = [],
    confirmations = [],
    status = {textContent: ''},
    preview = {innerHTML: ''};
  const root = {innerHTML: '', isConnected: true, setAttribute() {}, querySelector: () => status};
  const c = createContext({
    document: {addEventListener() {}},
    root,
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'operator'},
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    date: String,
    pretty: String,
    badge: String,
    recordDetails: v => JSON.stringify(v),
    errorMessage: e => e.message,
    $: selector => (selector === '#workbook-query-preview' ? preview : {focus() {}}),
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    workspaceCall: (tool, args) => new Promise((resolve, reject) => requests.push({tool, args, resolve, reject})),
    confirmAction: opts => new Promise(resolve => confirmations.push({opts, resolve})),
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
  new Script(readFileSync('web/operations-center.js', 'utf8')).runInContext(c);
  const controller = new Script("workbookQueryController(root, 'original-query')").runInContext(c);
  const query = {
    id: 'original-query',
    name: '<img onerror=bad>',
    query_version: 'version-1',
    can_edit: true,
    account_id: '100',
    gateway: 'meta_native_action',
    connection_id: 'meta',
    schedules: [],
    query_config: {
      platform: 'meta',
      account_id: '100',
      connection_id: 'meta',
      date_range: {since: '2026-09-01', until: '2026-09-07'},
    },
  };
  const form = {
    elements: {
      name: {value: 'Revised query'},
      window: {value: 'fixed'},
      since: {value: '2026-09-02'},
      until: {value: '2026-09-07'},
      days: {value: '7'},
      offset: {value: '0'},
      timezone: {value: 'UTC'},
    },
  };
  return {bindings, requests, confirmations, root, c, controller, query, form, preview, status};
}
test('query editor previews named dates, confirms paused schedules and preserves exact revision/config', async () => {
  const f = fixture(),
    loading = f.controller.load();
  f.requests[0].resolve(f.query);
  await loading;
  assert.doesNotMatch(f.root.innerHTML, /<img/);
  assert.match(f.root.innerHTML, /Report window/);
  const review = f.bindings.get('#workbook-query-form')(f.form);
  assert.equal(f.requests[1].args.action, 'preview_report_query');
  const draft = JSON.parse(JSON.stringify(f.requests[1].args.query));
  assert.equal(draft.query_config.date_range.since, '2026-09-02');
  assert.equal(draft.query_config.account_id, '100');
  f.requests[1].resolve({
    query: draft,
    query_version: 'version-1',
    schedules_to_pause: 2,
    changes: ['name', 'query_config'],
  });
  await review;
  assert.match(f.preview.innerHTML, /2/);
  const save = f.bindings.get('#workbook-query-save')();
  assert.match(f.confirmations[0].opts.consequence, /2.*schedule/);
  f.confirmations[0].resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[2].args)), {
    action: 'save_report_query',
    id: 'original-query',
    query_version: 'version-1',
    query: draft,
    confirmed: true,
  });
  f.requests[2].resolve({prepared_run_id: 'prepared-original'});
  await new Promise(resolve => setImmediate(resolve));
  f.requests[3].resolve({...f.query, name: 'Revised query', query_version: 'version-2'});
  await save;
  assert.match(f.root.innerHTML, /run_id=prepared-original/);
});
test('changing the editor during confirmation invalidates the proposal; stale identity results cannot repaint', async () => {
  const f = fixture(),
    loading = f.controller.load();
  f.requests[0].resolve(f.query);
  await loading;
  const review = f.bindings.get('#workbook-query-form')(f.form);
  f.requests[1].resolve({
    query: f.requests[1].args.query,
    query_version: 'version-1',
    schedules_to_pause: 0,
    changes: ['name'],
  });
  await review;
  const save = f.bindings.get('#workbook-query-save')();
  f.form.elements.name.value = 'Changed again';
  f.confirmations[0].resolve(true);
  await save;
  assert.equal(f.requests.length, 2);
  const pending = f.controller.load();
  f.c.identityGeneration++;
  f.requests[2].resolve({...f.query, name: 'private-other-identity'});
  await pending;
  assert.doesNotMatch(f.root.innerHTML, /private-other-identity/);
});

test('a redacted legacy query offers a JSON repair path without retaining credential placeholders', async () => {
  const f = fixture(),
    loading = f.controller.load();
  f.requests[0].resolve({
    ...f.query,
    configuration_redacted: true,
    query_config: {...f.query.query_config, access_token: '[REDACTED]'},
  });
  await loading;
  assert.match(f.root.innerHTML, /name="configuration"/);
  f.form.elements.configuration = {value: JSON.stringify(f.query.query_config)};
  const review = f.bindings.get('#workbook-query-form')(f.form);
  assert.equal(f.requests[1].args.query.query_config.access_token, undefined);
  assert.equal(f.requests[1].args.query.query_config.account_id, '100');
  f.requests[1].resolve({
    query: f.requests[1].args.query,
    query_version: 'version-1',
    schedules_to_pause: 0,
    changes: ['query_config'],
  });
  await review;
});
