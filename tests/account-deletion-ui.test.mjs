// SEC-07, owner decision P3 (2026-10-11): Account offers "Delete your account". Before this change the page had no way
// to delete an account. The real web/account-security.js functions run in a VM with a minimal DOM: the preview shows
// what goes or why it cannot, the deletion asks for the consequence dialog before sending anything, and the receipt
// replaces the page once this tab forgot the person. No server is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const source = readFileSync('web/account-security.js', 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from),
    end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'web/account-security.js still defines ' + from);
  return source.slice(start, end);
};

function fixture(responses, confirmations = []) {
  const nodes = new Map(),
    calls = [],
    events = [];
  const node = id => {
    if (!nodes.has(id)) {
      const listeners = new Map();
      nodes.set(id, {
        id,
        textContent: '',
        innerHTML: '',
        disabled: false,
        isConnected: true,
        values: {},
        listeners,
        addEventListener(event, fn) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(fn);
        },
        async dispatch(event, data = {}) {
          for (const fn of [...(listeners.get(event) ?? [])])
            await fn({preventDefault() {}, currentTarget: this, ...data});
        },
        focus() {
          events.push('focus:' + id);
        },
        click() {
          events.push('click:' + id);
        },
      });
    }
    return nodes.get(id);
  };
  const content = {
    innerHTML: '',
    insertAdjacentHTML(_where, html) {
      this.innerHTML += html;
    },
    querySelector: selector => node(selector),
  };
  const context = createContext({
    $: node,
    content,
    session: {authenticated: true, csrf: 'csrf-token'},
    platforms: [
      {gateway: 'meta_native_action', name: 'Meta'},
      {gateway: 'tiktok_native_action', name: 'TikTok'},
    ],
    uiText: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? ''),
    uiNumber: n => String(n),
    esc: String,
    date: v => 'date:' + v,
    formField: (label, name) => `<label>${label}<input name="${name}"></label>`,
    errorMessage: e => e.message,
    confirmAction: async options => {
      events.push('confirm:' + options.title);
      return confirmations.shift() ?? false;
    },
    resetPrivateState() {
      events.push('reset');
      content.innerHTML = '';
    },
    shellLinks() {
      events.push('shell');
    },
    api: async (url, init = {}) => {
      calls.push({url, init});
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    FormData: class {
      constructor(form) {
        this.form = form;
      }
      get(name) {
        return this.form.values[name];
      }
    },
    document: {createElement: () => node('download-link')},
    URL: {createObjectURL: blob => (context.downloaded = blob.text) && 'blob:receipt', revokeObjectURL() {}},
    Blob: class {
      constructor(parts) {
        this.text = parts.join('');
      }
    },
    setTimeout() {},
  });
  new Script(
    slice('/** The platform name of a saved login', '// Reviewer sign-in.') +
      ';globalThis.panel = accountDeletionPanel;',
  ).runInContext(context);
  return {context, node, content, calls, events};
}
const plan = {
  available: true,
  confirm_with: 'email',
  will_delete: {
    workspaces: 1,
    platform_logins: 2,
    saved_records: 7,
    files: 1,
    connector_keys: 3,
    sessions: 2,
    other_workspaces: 1,
  },
  platforms: ['meta_native_action', 'tiktok_native_action'],
};

test('P3: the preview lists what goes, and a refused preview offers no deletion form', async () => {
  const refused = fixture([
    {
      available: false,
      refusal: {
        code: 'ERASURE_WORKSPACE_SHARED',
        message:
          'Other members still use your workspace, and AMCP cannot hand it to another owner. Remove them in Workspace members first; nothing was deleted.',
      },
    },
  ]);
  refused.context.panel();
  assert.match(refused.content.innerHTML, /Delete your account/);
  await refused.node('#account-deletion-review').dispatch('click', {currentTarget: refused.node('review')});
  assert.deepEqual(
    refused.calls.map(c => c.url),
    ['/api/account/deletion'],
  );
  const area = refused.node('#account-deletion-plan').innerHTML;
  assert.match(area, /Other members still use your workspace/);
  assert.doesNotMatch(area, /account-deletion-form/);

  const f = fixture([plan]);
  f.context.panel();
  await f.node('#account-deletion-review').dispatch('click', {currentTarget: f.node('review')});
  const shown = f.node('#account-deletion-plan').innerHTML;
  for (const line of [
    '2 platform logins',
    '7 saved records, such as reports and plans',
    '3 connector keys and AI-client connections',
    '1 memberships in other workspaces',
    'Meta, TikTok',
    'Older backups keep a copy until they expire',
    'Type your email address to confirm',
    'account-deletion-form',
  ])
    assert.ok(shown.includes(line), line);
});

test('P3: cancelling the consequence dialog sends nothing; confirming deletes and shows the receipt in a signed-out tab', async () => {
  const f = fixture(
    [
      plan,
      {
        deleted: true,
        receipt: {
          erasure_id: 'erasure-1',
          erased_at: Date.UTC(2026, 9, 12),
          reason: 'self_service',
          deleted: plan.will_delete,
        },
        platforms: plan.platforms,
      },
    ],
    [false, true],
  );
  f.context.panel();
  await f.node('#account-deletion-review').dispatch('click', {currentTarget: f.node('review')});
  const form = f.node('#account-deletion-form'),
    button = f.node('submit');
  form.values.confirm = 'person@example.test';
  await form.dispatch('submit', {submitter: button});
  assert.deepEqual(
    f.calls.map(c => c.url),
    ['/api/account/deletion'],
    'nothing is sent when the dialog is cancelled',
  );
  await form.dispatch('submit', {submitter: button});
  assert.deepEqual(
    f.calls.map(c => c.url),
    ['/api/account/deletion', '/api/account/delete'],
  );
  assert.deepEqual(JSON.parse(f.calls[1].init.body), {confirm: 'person@example.test'});
  assert.equal(f.calls[1].init.method, 'POST');
  // This tab forgets the person before it shows the receipt.
  assert.deepEqual(f.events.slice(-4), ['confirm:Delete your account permanently?', 'reset', 'shell', 'focus:h1']);
  assert.equal(f.context.session.authenticated, false);
  assert.match(f.content.innerHTML, /Your account was deleted/);
  assert.match(f.content.innerHTML, /Erasure receipt erasure-1/);
  assert.match(f.content.innerHTML, /Remove AMCP’s access in each of them: Meta, TikTok/);
  // The downloadable receipt names the erasure, its UTC time and what went.
  await f.node('#account-deletion-download').dispatch('click');
  assert.match(
    f.context.downloaded,
    /^AMCP account deletion receipt\nErasure receipt erasure-1, 2026-10-12T00:00:00\.000Z\./,
  );
  assert.match(f.context.downloaded, /- 2 platform logins\n/);
  assert.equal(f.node('download-link').download, 'AMCP-deletion-receipt.txt');
});

test('P3: a refused deletion keeps the page, says why and enables the button again', async () => {
  const f = fixture(
    [plan, Object.assign(Error('Type your account’s email address exactly to confirm. Nothing was deleted.'), {})],
    [true],
  );
  f.context.panel();
  await f.node('#account-deletion-review').dispatch('click', {currentTarget: f.node('review')});
  const form = f.node('#account-deletion-form'),
    button = f.node('submit');
  form.values.confirm = 'wrong@example.test';
  await form.dispatch('submit', {submitter: button});
  assert.equal(
    f.node('#account-deletion-error').textContent,
    'Type your account’s email address exactly to confirm. Nothing was deleted.',
  );
  assert.equal(button.disabled, false);
  assert.equal(f.context.session.authenticated, true);
  assert.equal(f.events.includes('reset'), false);
});
