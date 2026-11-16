import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

/**
 * WRT-08: Operations opens a standalone reviewed change at /operations?write_id=. Before, no page showed one, so a
 * lost conversation lost the change. The detail shows the review's state and offers only read-only actions: a provider
 * check, and, after a fresh "appears applied" check, accepting it once the person confirms. It never resubmits.
 */
function fixture(role = 'operator') {
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
    session: {workspaceRole: role},
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
  const controller = new Script("writeRecordController(root, 'review-1')").runInContext(c);
  const record = {
    record_kind: 'write_review',
    review_id: 'review-1',
    state: 'uncertain',
    gateway: 'google_ads_native_action',
    account_id: '123',
    connection_id: 'g',
    action: '<img onerror=bad>',
    fingerprint: 'f'.repeat(64),
    prepared_at: '2026-10-10T10:00:00.000Z',
    expires_at: '2026-10-10T10:05:00.000Z',
    claim: {state: 'uncertain'},
    reconciliation: null,
    suggested_reads: [{method: 'POST', path: '/v23/customers/123/googleAds:search'}],
    next_call: {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: 'review-1'}},
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {bindings, requests, confirmations, root, c, controller, record, settle};
}

test('an uncertain change offers only a read-only provider check, escapes its labels and never resubmits', async () => {
  const f = fixture();
  const loaded = f.controller.load();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].args)), {action: 'status', review_id: 'review-1'});
  assert.equal(f.requests[0].tool, 'write');
  f.requests[0].resolve(f.record);
  await loaded;
  assert.match(f.root.innerHTML, /&lt;img/);
  assert.doesNotMatch(f.root.innerHTML, /<img/);
  assert.match(f.root.innerHTML, /id="write-record-reconcile"/);
  assert.doesNotMatch(f.root.innerHTML, /id="write-record-accept"/);
  assert.doesNotMatch(f.root.innerHTML, /"execute"/);
  const checking = f.bindings.get('#write-record-reconcile')();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].args)), {action: 'reconcile', review_id: 'review-1'});
  f.requests[1].resolve({classification: 'indeterminate'});
  await f.settle();
  f.requests[2].resolve(f.record);
  await checking;
  assert.equal(f.requests.length, 3);
  // A viewer sees the record but is offered no provider check.
  const viewer = fixture('viewer'),
    shown = viewer.controller.load();
  viewer.requests[0].resolve(viewer.record);
  await shown;
  assert.doesNotMatch(viewer.root.innerHTML, /write-record-reconcile/);
});

test('accepting a fresh "appears applied" check needs the person to confirm and sends the shown reconciliation', async () => {
  const f = fixture();
  const reconciliation = {
    reconciliation_id: 'r-1',
    classification: 'appears_applied',
    checked_at: new Date().toISOString(),
  };
  const loaded = f.controller.load();
  f.requests[0].resolve({...f.record, reconciliation});
  await loaded;
  assert.match(f.root.innerHTML, /id="write-record-accept"/);
  const cancelled = f.bindings.get('#write-record-accept')();
  f.confirmations[0](false);
  await cancelled;
  assert.equal(f.requests.length, 1, 'nothing recorded without confirmation');
  const accepted = f.bindings.get('#write-record-accept')();
  f.confirmations[1](true);
  await f.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].args)), {
    action: 'reconcile',
    review_id: 'review-1',
    accept_applied: true,
    reconciliation_id: 'r-1',
  });
  f.requests[1].resolve({state: 'reconciled'});
  await f.settle();
  f.requests[2].resolve({...f.record, state: 'reconciled', reconciliation: {...reconciliation, accepted_at: 1}});
  await accepted;
  assert.doesNotMatch(f.root.innerHTML, /write-record-accept|write-record-reconcile/);
  // A check older than 15 minutes is not offered for acceptance: the provider must be read again.
  const stale = fixture(),
    old = stale.controller.load();
  stale.requests[0].resolve({
    ...stale.record,
    reconciliation: {...reconciliation, checked_at: new Date(Date.now() - 16 * 60000).toISOString()},
  });
  await old;
  assert.doesNotMatch(stale.root.innerHTML, /write-record-accept/);
  assert.match(stale.root.innerHTML, /write-record-reconcile/);
});

test('a check AMCP made on its own says so, when it looks again, and when its attempts ran out (R2.5 M2)', async () => {
  const check = {
    reconciliation_id: 'r-auto',
    classification: 'indeterminate',
    reason: 'read_failed',
    checked_at: new Date().toISOString(),
    automatic: true,
    attempts: 2,
  };
  const again = fixture(),
    waiting = again.controller.load();
  again.requests[0].resolve({
    ...again.record,
    reconciliation: {...check, next_check_at: '2026-10-10T10:10:00.000Z'},
  });
  await waiting;
  assert.match(again.root.innerHTML, /Checked automatically by AMCP/);
  assert.match(again.root.innerHTML, /AMCP checks again at 2026-10-10T10:10:00.000Z\./);
  assert.doesNotMatch(again.root.innerHTML, /AMCP stopped checking automatically/);

  const spent = fixture(),
    stopped = spent.controller.load();
  spent.requests[0].resolve({...spent.record, reconciliation: {...check, attempts: 6, checks_exhausted: true}});
  await stopped;
  assert.match(spent.root.innerHTML, /Checked automatically by AMCP/);
  assert.match(spent.root.innerHTML, /AMCP stopped checking automatically\./);
  assert.doesNotMatch(spent.root.innerHTML, /AMCP checks again at/);
  assert.match(spent.root.innerHTML, /write-record-reconcile/, 'the person can still check the provider');

  // A check the person asked for is not described as automatic.
  const manual = fixture(),
    own = manual.controller.load();
  manual.requests[0].resolve({
    ...manual.record,
    reconciliation: {
      reconciliation_id: 'r-own',
      classification: 'appears_not_applied',
      checked_at: new Date().toISOString(),
    },
  });
  await own;
  assert.doesNotMatch(manual.root.innerHTML, /Checked automatically|AMCP checks again|AMCP stopped checking/);

  // An automatic "appears applied" is acceptable like any fresh one: the person still confirms it.
  const found = fixture(),
    shown = found.controller.load();
  found.requests[0].resolve({
    ...found.record,
    reconciliation: {
      reconciliation_id: 'r-found',
      classification: 'appears_applied',
      checked_at: new Date().toISOString(),
      automatic: true,
      attempts: 1,
    },
  });
  await shown;
  assert.match(found.root.innerHTML, /Checked automatically by AMCP/);
  assert.match(found.root.innerHTML, /id="write-record-accept"/);
  assert.equal(found.requests.length, 1, 'nothing was accepted or sent by showing it');
});

test('an operations card shows what the read-only check of an uncertain change found, and that AMCP made it (R2.5 M2)', () => {
  const f = fixture();
  const card = reconciliation =>
    new Script(
      'operationCard(' +
        JSON.stringify({
          kind: 'write',
          id: 'review-1',
          name: 'campaign_budget_create',
          state: 'uncertain',
          accounts: ['123'],
          updated_at: 1,
          website_path: '/operations?write_id=review-1',
          next_safe_action: 'x',
          ...(reconciliation ? {reconciliation} : {}),
        }) +
        ')',
    ).runInContext(f.c);
  const automatic = card({classification: 'appears_applied', automatic: true});
  assert.match(automatic, /Read-only provider check/);
  assert.match(automatic, /Appears applied/);
  assert.match(automatic, /Checked automatically by AMCP/);
  const own = card({classification: 'appears_not_applied', automatic: false});
  assert.match(own, /Appears not applied/);
  assert.doesNotMatch(own, /Checked automatically/);
  assert.doesNotMatch(card(undefined), /Read-only provider check/, 'nothing is shown before the first check');
});

test('the change detail ignores stale loads and a departed route or identity', async () => {
  const f = fixture();
  const old = f.controller.load(),
    current = f.controller.load();
  f.requests[1].resolve({...f.record, action: 'Newest'});
  await current;
  f.requests[0].resolve({...f.record, action: 'Old private change'});
  await old;
  assert.match(f.root.innerHTML, /Newest/);
  assert.doesNotMatch(f.root.innerHTML, /Old private/);
  const departed = fixture(),
    loading = departed.controller.load();
  departed.c.navigationGeneration++;
  departed.requests[0].resolve(departed.record);
  await loading;
  assert.doesNotMatch(departed.root.innerHTML, /onerror|write-record-reconcile/);
  const changed = fixture(),
    shown = changed.controller.load();
  changed.requests[0].resolve({
    ...changed.record,
    reconciliation: {reconciliation_id: 'r', classification: 'appears_applied', checked_at: new Date().toISOString()},
  });
  await shown;
  const accept = changed.bindings.get('#write-record-accept')();
  changed.c.identityGeneration++;
  changed.confirmations[0](true);
  await accept;
  assert.equal(changed.requests.length, 1, 'no acceptance after the identity changed');
});
