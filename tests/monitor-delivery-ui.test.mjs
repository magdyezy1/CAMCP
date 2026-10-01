import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
function fixture() {
  const bindings = new Map(),
    requests = [],
    confirmations = [],
    root = {innerHTML: '', isConnected: true};
  const c = createContext({
    root,
    navigationGeneration: 1,
    identityGeneration: 1,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    date: String,
    pretty: String,
    badge: String,
    errorMessage: e => e.message,
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    workspaceCall: (tool, args) => new Promise((resolve, reject) => requests.push({tool, args, resolve, reject})),
    confirmAction: (...args) => new Promise(resolve => confirmations.push({args, resolve})),
  });
  new Script(readFileSync('web/operations-center.js', 'utf8')).runInContext(c);
  const controller = new Script("monitorNotificationController(root, 'original-rule')").runInContext(c);
  const settings = {eligible: true, enabled: false, subscription_version: 'current-version', deliveries: []};
  return {bindings, requests, confirmations, root, c, controller, settings};
}
test('monitor notification controls require confirmation, preserve inspected versions and escape delivery details', async () => {
  const f = fixture(),
    loading = f.controller.load();
  f.requests[0].resolve({
    ...f.settings,
    deliveries: [
      {
        id: 'notice',
        incident_id: 'id/#',
        event: 'opened',
        state: 'failed',
        attempts: 5,
        reason: '<img onerror=x>',
        retry_available: true,
        notification_version: 'notice-version',
      },
    ],
  });
  await loading;
  assert.match(f.root.innerHTML, /Enable email notices for me/);
  assert.doesNotMatch(f.root.innerHTML, /<img/);
  assert.match(f.root.innerHTML, /incident_id=id%2F%23/);
  const cancelled = f.bindings.get('#monitor-email-toggle')();
  f.confirmations[0].resolve(false);
  await cancelled;
  assert.equal(f.requests.length, 1);
  const enabled = f.bindings.get('#monitor-email-toggle')();
  f.confirmations[1].resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].args)), {
    action: 'set_monitor_notifications',
    id: 'original-rule',
    enabled: true,
    subscription_version: 'current-version',
    confirmed: true,
  });
  f.requests[1].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  f.requests[2].resolve({...f.settings, enabled: true});
  await enabled;
  assert.match(f.root.innerHTML, /Turn off my email notices/);
});
test('a subscription confirmation and late delivery history cannot cross identity or route changes', async () => {
  const f = fixture(),
    load = f.controller.load();
  f.requests[0].resolve(f.settings);
  await load;
  const save = f.bindings.get('#monitor-email-toggle')();
  f.c.identityGeneration++;
  f.confirmations[0].resolve(true);
  await save;
  assert.equal(f.requests.length, 1);
  const other = fixture(),
    old = other.controller.load(),
    latest = other.controller.load();
  other.requests[1].resolve({...other.settings, enabled: true});
  await latest;
  other.requests[0].resolve(other.settings);
  await old;
  assert.match(other.root.innerHTML, /Turn off my email notices/);
  const pending = other.controller.load();
  other.c.navigationGeneration++;
  other.requests[2].resolve({...other.settings, reason: 'private-old-route'});
  await pending;
  assert.doesNotMatch(other.root.innerHTML, /private-old-route/);
});

test('notice recovery uses its exact version and late mutation errors stay out of a replacement identity', async () => {
  const f = fixture(),
    load = f.controller.load();
  f.requests[0].resolve({
    ...f.settings,
    deliveries: [
      {
        id: 'original-notice',
        incident_id: 'original-incident',
        event: 'opened',
        state: 'failed',
        attempts: 5,
        retry_available: true,
        notification_version: 'exact-notice-version',
      },
    ],
  });
  await load;
  const retry = f.bindings.get('[data-retry-monitor-notice]')({dataset: {retryMonitorNotice: 'original-notice'}});
  f.confirmations[0].resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].args)), {
    action: 'retry_monitor_notification',
    notification_id: 'original-notice',
    notification_version: 'exact-notice-version',
    confirmed: true,
  });
  f.c.identityGeneration++;
  f.requests[1].reject(Error('old-private-failure'));
  await retry;
  assert.doesNotMatch(f.root.innerHTML, /old-private-failure/);
});
