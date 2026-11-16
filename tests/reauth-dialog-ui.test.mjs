// SEC-06 S1: the website's request wrapper turns a REAUTH_REQUIRED refusal into a "Confirm it's you" dialog and sends
// the original request exactly once more after the server accepted the proof. Before, the person had to sign out and
// in again and redo the change. The real web/app.js functions run in a VM with a minimal DOM; no server is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const source = readFileSync('web/app.js', 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from),
    end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'web/app.js still defines ' + from);
  return source.slice(start, end);
};

function fixture(responses, sessionState = {}) {
  const nodes = new Map(),
    calls = [];
  const node = id => {
    if (!nodes.has(id)) {
      const listeners = new Map();
      nodes.set(id, {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
        hidden: false,
        disabled: false,
        open: false,
        opened: 0,
        listeners,
        addEventListener(event, fn) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(fn);
        },
        removeEventListener(event, fn) {
          listeners.get(event)?.delete(fn);
        },
        dispatch(event, data = {}) {
          for (const fn of [...(listeners.get(event) ?? [])]) fn({preventDefault() {}, ...data});
        },
        showModal() {
          this.open = true;
          this.opened++;
        },
        close() {
          this.open = false;
          this.dispatch('close');
        },
        focus() {},
        querySelector: () => null,
      });
    }
    return nodes.get(id);
  };
  const context = createContext({
    $: node,
    session: {authenticated: true, csrf: 'csrf-token', hasPassword: true, identities: [], ...sessionState},
    navigationGeneration: 1,
    identityGeneration: 1,
    uiText: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? ''),
    esc: String,
    resetPrivateState() {},
    showLogin() {},
    identityKey: () => '',
    // r25-ar-lazy: the request wrapper waits for catalog sentences an answer carries; these answers carry none
    // (tests/web-answer-chunks.test.mjs covers the wait).
    uiEnsureAnswerChunks: async () => {},
    sessionStorage: {setItem() {}},
    location: {pathname: '/connectors', search: '', assign() {}},
    fetch: async (url, init) => {
      calls.push({url, init, body: init.body});
      const [status, data] = responses.shift() ?? [500, {error: {code: 'UNEXPECTED'}}];
      return {ok: status < 400, status, json: async () => data};
    },
  });
  new Script(
    slice('function requestError(', 'const content = $(') +
      slice('function confirmIdentity(', 'function showLogin(') +
      ';globalThis.api = api;',
  ).runInContext(context);
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return {context, node, calls, settle, run: code => new Script(code).runInContext(context)};
}
const refused = [403, {error: {code: 'REAUTH_REQUIRED', message: 'Confirm it’s you to continue.'}}],
  body = JSON.stringify({name: 'Late token', role: 'reader'});

test('SEC-06: a REAUTH_REQUIRED refusal opens the dialog and repeats the same request once after the password', async () => {
  const f = fixture([refused, [200, {reauthenticated: true}], [200, {id: 'token-1'}]]);
  const pending = f.run(`api('/api/connector-tokens', {method: 'POST', body: ${JSON.stringify(body)}})`);
  await f.settle();
  assert.equal(f.node('#reauth-dialog').open, true);
  assert.equal(f.node('#reauth-password-field').hidden, false);
  assert.equal(f.node('#reauth-code-field').hidden, true, 'no two-step field without two-step verification');
  f.node('#reauth-password').value = 'the password';
  f.node('#reauth-form').dispatch('submit');
  assert.deepEqual(await pending, {id: 'token-1'});
  assert.deepEqual(
    f.calls.map(c => c.url),
    ['/api/connector-tokens', '/api/account/reauthenticate', '/api/connector-tokens'],
  );
  assert.equal(f.calls[2].body, body, 'the original request is repeated unchanged');
  assert.equal(f.calls[2].init.method, 'POST');
  assert.equal('reauthRetried' in f.calls[2].init, false, 'the retry marker is not a fetch option');
  assert.deepEqual(JSON.parse(f.calls[1].body), {password: 'the password'});
  assert.equal(f.calls[1].init.headers['X-AMCP-CSRF'], 'csrf-token');
  assert.equal(f.node('#reauth-dialog').open, false);
  assert.equal(f.node('#reauth-password').value, '', 'the password is cleared from the dialog');
});

test('SEC-06: the repeat happens at most once, and cancelling sends nothing more', async () => {
  const again = fixture([refused, [200, {reauthenticated: true}], refused]);
  const pending = again.run(`api('/api/connector-tokens', {method: 'POST', body: ${JSON.stringify(body)}})`);
  await again.settle();
  again.node('#reauth-password').value = 'the password';
  again.node('#reauth-form').dispatch('submit');
  await assert.rejects(pending, {code: 'REAUTH_REQUIRED'});
  assert.equal(again.calls.length, 3);
  assert.equal(again.node('#reauth-dialog').opened, 1);

  const cancelled = fixture([refused]);
  const stopped = cancelled.run(`api('/api/mcp/consent', {method: 'POST', body: '{"approved":true}'})`);
  await cancelled.settle();
  cancelled.node('#reauth-cancel').dispatch('click');
  await assert.rejects(stopped, {code: 'REAUTH_REQUIRED'});
  assert.deepEqual(
    cancelled.calls.map(c => c.url),
    ['/api/mcp/consent'],
  );
});

test('SEC-06: a wrong password keeps the dialog open with the reason; a two-step code confirms instead', async () => {
  const f = fixture(
    [
      refused,
      [401, {error: {code: 'INVALID_LOGIN', message: 'That password is incorrect.'}}],
      [200, {reauthenticated: true}],
      [200, {success: true}],
    ],
    {mfaEnabled: true},
  );
  const pending = f.run(`api('/api/connections/c1/write-access', {method: 'PATCH', body: '{"accounts":["1"]}'})`);
  await f.settle();
  assert.equal(f.node('#reauth-code-field').hidden, false);
  f.node('#reauth-password').value = 'wrong';
  f.node('#reauth-form').dispatch('submit');
  await f.settle();
  assert.equal(f.node('#reauth-dialog').open, true);
  assert.equal(f.node('#reauth-error').textContent, 'That password is incorrect.');
  f.node('#reauth-code').value = ' 123456 ';
  f.node('#reauth-form').dispatch('submit');
  assert.deepEqual(await pending, {success: true});
  assert.deepEqual(JSON.parse(f.calls[2].body), {code: '123456'});
  assert.equal(f.calls[3].body, '{"accounts":["1"]}');
});
