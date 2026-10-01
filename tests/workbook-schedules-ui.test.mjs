import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture() {
  const requests = [],
    confirmations = [],
    confirmationOptions = [],
    bindings = new Map();
  const status = {textContent: ''},
    root = {innerHTML: '', isConnected: true, setAttribute() {}, querySelector: () => status};
  const field = value => ({value, addEventListener() {}});
  const form = {
    elements: {
      name: field('Weekly sales'),
      timezone: field('UTC'),
      schedule_kind: field('weekly'),
      weekday: field('1'),
      day: field('1'),
      hour: field('9'),
      minute: field('0'),
      active: {checked: false},
    },
  };
  const escape = v =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;');
  const c = createContext({
    root,
    navigationGeneration: 1,
    identityGeneration: 1,
    $: s => (s === '#workbook-schedule-form' ? form : {focus() {}, hidden: false}),
    esc: escape,
    badge: escape,
    pretty: String,
    date: String,
    errorMessage: e => e.message,
    Intl,
    Date,
    workspaceBind: (s, fn) => bindings.set(s, fn),
    confirmAction: options => {
      confirmationOptions.push(options);
      return new Promise(r => confirmations.push(r));
    },
    workspaceCall: (tool, args) => new Promise((resolve, reject) => requests.push({tool, args, resolve, reject})),
  });
  new Script(readFileSync('web/workbook-schedules.js', 'utf8')).runInContext(c);
  const controller = new Script("workbookScheduleController(root,'original')").runInContext(c);
  const schedule = {
    id: 'original',
    name: '<img src=x>',
    state: 'active',
    active: true,
    schedule_kind: 'weekly',
    schedule: {hour: 9, minute: 0, weekday: 1},
    timezone: 'UTC',
    query_id: 'query',
    query_revision: 2,
    account_id: '100',
    can_edit: true,
    schedule_version: 'version-1',
    occurrences: [Date.UTC(2026, 9, 5, 9)],
    meaning: 'Future runs only',
    last_run: null,
  };
  const preview = {
    id: 'original',
    active: false,
    account_id: '100',
    query_revision: 2,
    schedule: {name: 'Weekly sales', timezone: 'UTC', schedule_kind: 'weekly', hour: 9, minute: 0, weekday: 1},
    occurrences: schedule.occurrences,
    changes: [{field: 'active', from: true, to: false}],
  };
  return {c, root, form, requests, confirmations, confirmationOptions, bindings, controller, schedule, status, preview};
}

test('schedule editor escapes content and saves only the original revision after explicit clock confirmation', async () => {
  const f = fixture(),
    load = f.controller.load();
  f.requests[0].resolve(f.schedule);
  await load;
  assert.match(f.root.innerHTML, /&lt;img/);
  assert.doesNotMatch(f.root.innerHTML, /<img/);
  assert.equal(f.form.elements.day.disabled, true);
  assert.equal(f.form.elements.weekday.disabled, false);
  const cancelled = f.bindings.get('#workbook-schedule-form')(f.form);
  assert.equal(f.requests[1].args.action, 'preview_report_schedule');
  f.requests[1].resolve(f.preview);
  await new Promise(r => setImmediate(r));
  assert.match(f.confirmationOptions[0].consequence, /Account 100 · Query revision 2/);
  assert.match(f.confirmationOptions[0].consequence, /Future runs: enabled → paused/);
  assert.match(f.confirmationOptions[0].consequence, /Next three clock times \(UTC\)/);
  assert.ok(
    f.confirmationOptions[0].consequence.includes(
      new Intl.DateTimeFormat(undefined, {timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short'}).format(
        f.preview.occurrences[0],
      ),
    ),
  );
  f.confirmations[0](false);
  await cancelled;
  assert.equal(f.requests.length, 2);
  const saving = f.bindings.get('#workbook-schedule-form')(f.form);
  f.requests[2].resolve(f.preview);
  await new Promise(r => setImmediate(r));
  f.confirmations[1](true);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[3].args)), {
    action: 'save_report_schedule',
    id: 'original',
    schedule_version: 'version-1',
    confirmed: true,
    active: false,
    schedule: {name: 'Weekly sales', timezone: 'UTC', schedule_kind: 'weekly', hour: 9, minute: 0, weekday: 1},
  });
  f.requests[3].resolve({...f.schedule, state: 'paused'});
  await new Promise(r => setImmediate(r));
  f.requests[4].resolve({...f.schedule, state: 'paused', active: false});
  await saving;
  assert.match(f.root.innerHTML, /paused/);
});

test('schedule editor refuses old results and confirmation after identity or route changes', async () => {
  const f = fixture(),
    old = f.controller.load(),
    current = f.controller.load();
  f.requests[1].resolve({...f.schedule, name: 'Newest'});
  await current;
  f.requests[0].resolve({...f.schedule, name: 'Private old result'});
  await old;
  assert.match(f.root.innerHTML, /Newest/);
  assert.doesNotMatch(f.root.innerHTML, /Private old/);
  const saving = f.bindings.get('#workbook-schedule-form')(f.form);
  f.requests[2].resolve(f.preview);
  await new Promise(r => setImmediate(r));
  f.c.identityGeneration++;
  f.confirmations[0](true);
  await saving;
  assert.equal(f.requests.length, 3);
  const other = fixture(),
    loading = other.controller.load();
  other.c.navigationGeneration++;
  other.requests[0].reject(Error('private error'));
  await loading;
  assert.doesNotMatch(other.root.innerHTML, /private error/);
});
