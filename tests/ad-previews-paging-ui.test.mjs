import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture() {
  const nodes = new Map(),
    calls = [];
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        textContent: '',
        listeners: new Map(),
        addEventListener(name, fn) {
          this.listeners.set(name, fn);
        },
      });
    return nodes.get(id);
  };
  const form = node('#preview-form');
  form.elements = {
    target: {value: '0'},
    ad_ids: {value: ''},
    statuses: {value: 'active'},
    ad_format: {value: 'MOBILE_FEED_STANDARD'},
  };
  let submit;
  const context = createContext({
    platforms: [{gateway: 'snapchat_native_action', connections: [{id: 'login', enabled: true, accounts: ['100']}]}],
    accountLabel: () => 'Synthetic',
    $: node,
    uiText: (s, values = {}) => String(s ?? '').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? ''),
    esc: s =>
      String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    blank: s => s,
    date: String,
    errorMessage: e => e.message,
    workspaceBind: (_selector, fn) => {
      submit = fn;
    },
    workspaceCall: (_tool, args) =>
      new Promise((resolve, reject) => calls.push({args: structuredClone(args), resolve, reject})),
  });
  new Script(readFileSync('web/ad-previews.js', 'utf8')).runInContext(context);
  new Script('bindAdPreviews()').runInContext(context);
  const results = node('#preview-results'),
    click = () => results.listeners.get('click')({target: {closest: () => true}});
  return {form, node, calls, results, click, submit: () => submit(form)};
}
const row = (id, source) => ({
  ad_id: id,
  source_ad_id: source,
  name: id,
  links: ['https://ads.snapchat.com/preview/' + id],
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Load more reuses the selection and native cursor, keeps shared creatives and suppresses duplicate clicks', async () => {
  const f = fixture(),
    first = f.submit();
  assert.deepEqual(f.calls[0].args.statuses, ['active']);
  f.calls[0].resolve({
    previews: [row('cr1', 'a1')],
    meaning: 'Synthetic',
    has_more: true,
    next_cursor: 'signed-cursor',
  });
  await first;
  assert.match(f.results.innerHTML, /preview-load-more/);
  f.click();
  f.click();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].args.cursor, 'signed-cursor');
  assert.equal(f.calls[1].args.account_id, '100');
  f.calls[1].resolve({
    previews: [row('cr1', 'a3'), row('cr1', 'a1')],
    meaning: 'Synthetic',
    has_more: false,
    next_cursor: null,
  });
  await tick();
  assert.match(f.results.innerHTML, /Ad a1/);
  assert.match(f.results.innerHTML, /Ad a3/);
  assert.equal((f.results.innerHTML.match(/Ad a1/g) ?? []).length, 1);
  assert.doesNotMatch(f.results.innerHTML, /preview-load-more/);
});

test('changing the selection discards an in-flight answer and its continuation', async () => {
  const f = fixture(),
    pending = f.submit();
  f.form.elements.statuses.value = 'paused';
  f.form.listeners.get('change')();
  f.calls[0].resolve({previews: [row('stale', 'old')], meaning: 'Synthetic', has_more: true, next_cursor: 'old'});
  await pending;
  assert.doesNotMatch(f.results.innerHTML, /stale|preview-load-more/);
  f.click();
  assert.equal(f.calls.length, 1);
  const fresh = f.submit();
  assert.deepEqual(f.calls[1].args.statuses, ['paused']);
  assert.equal(f.calls[1].args.cursor, undefined);
  f.calls[1].resolve({previews: [], meaning: 'Synthetic', has_more: false});
  await fresh;
});
