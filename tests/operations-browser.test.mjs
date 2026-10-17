import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
const escape = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function browser() {
  const bindings = new Map(),
    status = {textContent: ''},
    requests = [];
  const root = {innerHTML: '', isConnected: true, setAttribute() {}, querySelector: () => status};
  const c = createContext({
    document: {addEventListener() {}},
    $: () => root,
    navigationGeneration: 1,
    identityGeneration: 1,
    esc: escape,
    pretty: String,
    recordDetails: () => '',
    badge: escape,
    date: () => 'Synthetic time',
    workspaceBind: (s, fn) => bindings.set(s, fn),
    errorMessage: e => e.message,
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
  // WEB-07: the paged-list loader is web/work-pages.js, a dependency of the Operations center.
  new Script(readFileSync('web/work-pages.js', 'utf8')).runInContext(c);
  new Script(readFileSync('web/operations-center.js', 'utf8')).runInContext(c);
  c.fetchPage = cursor => new Promise((resolve, reject) => requests.push({cursor, resolve, reject}));
  const pager = new Script("workPageLoader('#page','Work',fetchPage,r=>r.rows.join(','))").runInContext(c);
  return {c, root, bindings, requests, pager, status};
}
test('operations pagination preserves the current page on failure and never paints an older filter or departed route', async () => {
  const b = browser();
  const first = b.pager.load();
  b.requests[0].resolve({rows: ['first'], next_cursor: 'page-2'});
  await first;
  const next = b.bindings.get('#page [data-page-next]')();
  assert.equal(b.requests[1].cursor, 'page-2');
  b.requests[1].reject(Error('synthetic outage'));
  await next;
  assert.match(b.root.innerHTML, /first/);
  assert.match(b.status.textContent, /synthetic outage/);
  const old = b.pager.load(),
    newest = b.pager.load();
  b.requests[3].resolve({rows: ['newest'], next_cursor: null});
  await newest;
  b.requests[2].resolve({rows: ['older'], next_cursor: 'bad'});
  await old;
  assert.match(b.root.innerHTML, /newest/);
  assert.doesNotMatch(b.root.innerHTML, /older/);
  const late = b.pager.load();
  b.c.navigationGeneration++;
  b.requests[4].resolve({rows: ['private-old-route']});
  await late;
  assert.doesNotMatch(b.root.innerHTML, /private-old-route/);
  const detached = browser(),
    pending = detached.pager.load();
  detached.root.isConnected = false;
  detached.requests[0].resolve({rows: ['detached-private-record']});
  await pending;
  assert.equal(detached.root.innerHTML, '');
});
test('shared work pagination suppresses departed identities and stops obsolete handlers before another request', async () => {
  const b = browser(),
    pending = b.pager.load();
  b.c.identityGeneration++;
  b.requests[0].resolve({rows: ['private previous identity'], next_cursor: 'more'});
  await pending;
  assert.doesNotMatch(b.root.innerHTML, /private previous identity/);
  await b.pager.load();
  assert.equal(b.requests.length, 1);
});

test('operation and incident cards escape user labels and expose only the original recovery links', () => {
  const {c} = browser();
  c.op = {
    id: 'original',
    kind: 'upload',
    name: '<img src=x onerror=bad>',
    state: 'uncertain',
    accounts: ['<account>'],
    website_path: '/media?review_id=original',
    next_safe_action: 'Inspect & reconcile',
    updated_at: 1,
  };
  const html = new Script('operationCard(op)').runInContext(c);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;account&gt;/);
  assert.match(html, /\/media\?review_id=original/);
  assert.doesNotMatch(html, /Execute|Retry upload/);
  c.incident = {
    id: 'id/#',
    monitor_name: '<script>x</script>',
    attention_state: 'snoozed',
    state: 'open',
    metric: 'spend',
    threshold: '50',
    value: '60',
    snoozed_until: 5,
    last_report_id: 'report/#',
  };
  const incident = new Script('incidentCard(incident)').runInContext(c);
  assert.doesNotMatch(incident, /<script>/);
  assert.match(incident, /incident_id=id%2F%23/);
  assert.match(incident, /report_id=report%2F%23/);
  assert.match(incident, /Attention resumes/);
});
