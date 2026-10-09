// MED-01 Stage E (review 2026-10-08): the push panel counts each temporary file down on the server's clock, announces
// only the 10-, 5- and 1-minute marks, pushes rows in deadline order, skips a row whose file is deleted before it could
// finish (no prepare call), re-binds planned rows to an identical re-upload (same SHA-256) but not to another file, and
// saves a plan with temporary files only after the member confirms their deadline (owner decision D23). Before this
// the deadlines were static text and rows ran in plan order, so a late row was prepared and failed at the provider step.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
const id = n => 'src-' + String(n).repeat(8) + '-0000-0000-0000-000000000000';

function fixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [],
    confirms = [],
    navigations = [];
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        innerHTML: '',
        textContent: '',
        value: '',
        checked: false,
        hidden: false,
        isConnected: true,
        elements: {},
        insertAdjacentHTML(_where, html) {
          this.innerHTML += html;
        },
        addEventListener() {},
        setAttribute() {},
        focus() {},
        click() {},
        querySelector: node,
        querySelectorAll: () => [],
      });
    return nodes.get(selector);
  };
  const context = createContext({
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    Intl,
    Date,
    Blob,
    File,
    crypto: globalThis.crypto,
    setTimeout: fn => {
      fn();
      return 0;
    },
    clearTimeout() {},
    URLSearchParams,
    document: {addEventListener() {}, querySelector: node, querySelectorAll: () => []},
    $: node,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    date: String,
    toast() {},
    errorMessage: e => String(e?.message ?? ''),
    session: {authenticated: true, workspaceRole: 'operator', csrf: 'csrf-synthetic'},
    platforms: [],
    navigationGeneration: 1,
    identityGeneration: 1,
    sessionStorage: {getItem: () => null, setItem() {}},
    fetch: async () => ({ok: true, json: async () => ({})}),
    confirmAction: async options => {
      confirms.push(options);
      return context.confirmAnswer ?? true;
    },
    navigate: async url => navigations.push(url),
    renderWorkspacePage() {},
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync('web/creative-push.js', 'utf8'));
  context.workspaceBind = (selector, fn) => bindings.set(selector, fn);
  const form = node('#push-review');
  form.elements = {name: {value: '', required: false}, owner_urn: {value: ''}, fit: {checked: true}};
  form.querySelectorAll = selector => (selector === 'input[name=target]:checked' ? [{value: '0'}] : []);
  node('#push-consent').checked = true;
  context.targets = [{platform: 'meta', account_id: '100', connection_id: 'login', label: 'Meta · 100'}];
  return {run, context, node, bindings, calls, confirms, navigations};
}
/**
 * The server double. Its clock runs 25 minutes ahead of this device (server_time), so a countdown computed on the
 * device clock would be 25 minutes off. `listed` are the files the member can add to the push.
 */
function serve(f, listed) {
  const skew = 25 * 60000,
    server = () => new Date(Date.now() + skew).toISOString();
  f.serverNow = () => Date.now() + skew;
  f.context.api = async url => {
    if (url === '/api/media/sources') return {sources: listed, server_time: server()};
    throw Error('unexpected ' + url);
  };
  f.context.workspaceCall = async (tool, input) => {
    f.calls.push({tool, ...plain(input)});
    if (input.action === 'plan')
      return {
        destinations: input.destinations.map(() => ({
          ready: true,
          file: {sha256: 'e'.repeat(64), size: 1024, mime: 'image/png'},
        })),
      };
    if (input.action === 'prepare') return {review_id: 'review-' + input.source_id};
    if (input.action === 'execute') return {state: 'uploaded', media_id: 'm-' + input.review_id};
    if (tool === 'campaign') return {id: 'plan-1'};
    throw Error('unexpected ' + input.action);
  };
  return server();
}
const source = (n, left, extra = {}) => ({
  source_id: id(n),
  filename: 'file-' + n + '.png',
  state: 'complete',
  origin: 'upload',
  mime: 'image/png',
  kind: 'image',
  size: 1024,
  sha256: String(n).repeat(64),
  expires_at: left === null ? null : new Date(Date.now() + 25 * 60000 + left).toISOString(),
  ...extra,
});

test('the countdown follows the server clock and announces only the 10-, 5- and 1-minute marks', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      soon = source(1, 4.5 * 60000),
      later = source(2, 20 * 60000),
      serverTime = serve(f, [soon, later]),
      panel = f.run(`bindCreativePush(targets, [], [], ${JSON.stringify(serverTime)})`);
    for (const s of [soon, later]) await f.bindings.get('[data-push-source]')({dataset: {pushSource: s.source_id}});
    // About four and a half minutes on the server clock (the device clock would say almost half an hour).
    assert.match(f.node('#push-file').innerHTML, /id="push-left-0" class="push-countdown">[^<]*4:[23]\d/);
    assert.match(f.node('#push-file').innerHTML, /id="push-left-1" class="push-countdown">[^<]*(19:5\d|20:00)/);
    panel.tick();
    const announced = f.node('#push-deadline-status').textContent;
    assert.match(
      announced,
      locale === 'ar' ? /بقيت 5 دقائق قبل حذفه/ : /file-1\.png: 5 minutes left before it is deleted/,
    );
    assert.doesNotMatch(announced, /file-2/, 'twenty minutes left is shown but not announced');
    assert.match(f.node('#push-left-0').textContent, /4:[23]\d/);
    // The same mark is never announced twice.
    f.node('#push-deadline-status').textContent = '';
    panel.tick();
    assert.equal(f.node('#push-deadline-status').textContent, '');
  }
});

test('the announcement helper marks 10, 5 and 1 minutes and deletion once each', () => {
  const f = fixture(),
    s = {source_id: id(3), filename: 'clip.mp4', expires_at: new Date(1000 * 60000).toISOString()},
    announced = new Set(),
    at = minutes => (1000 - minutes) * 60000,
    say = minutes => f.context.pushDeadlineAnnouncement(s, announced, at(minutes));
  f.context.s = s;
  assert.equal(say(12), '');
  assert.match(say(9.5), /10 minutes left/);
  assert.equal(say(9), '');
  assert.match(say(4.2), /5 minutes left/);
  assert.match(say(0.5), /1 minute left/);
  assert.match(say(-0.1), /was deleted at its deadline/);
  assert.equal(say(-1), '');
  assert.equal(f.context.pushRemaining(at(0) + 61000, at(0)), '1:01');
  assert.equal(f.context.pushRemaining(Infinity), '');
});

test('rows are pushed soonest deadline first and a row that cannot finish in time is skipped without a prepare', async () => {
  const f = fixture(),
    retained = source(4, null, {source_id: 'lib-44444444-0000-0000-0000-000000000000', retained: true}),
    late = source(5, 20000),
    soon = source(6, 6 * 60000),
    serverTime = serve(f, [retained, late, soon]);
  f.run(`bindCreativePush(targets, [], [], ${JSON.stringify(serverTime)})`);
  for (const s of [retained, late, soon])
    await f.bindings.get('[data-push-source]')({dataset: {pushSource: s.source_id}});
  await f.bindings.get('#push-review')(f.node('#push-review'));
  assert.deepEqual(
    f.calls.filter(c => c.action === 'plan').map(c => c.source_id),
    [retained.source_id, late.source_id, soon.source_id],
  );
  const review = f.node('#push-reviews').innerHTML;
  assert.match(review, /Uploads are pushed in deadline order, the soonest first\. Estimated time: about 2 minutes\./);
  assert.match(review, /1 of them would be deleted before their turn and are skipped/);
  f.calls.length = 0;
  await f.bindings.get('#push-execute')();
  // Deadline order (the retained original has none, so it goes last); the late row sends nothing at all.
  assert.deepEqual(
    f.calls.filter(c => c.action === 'prepare').map(c => c.source_id),
    [soon.source_id, retained.source_id],
  );
  assert.equal(f.calls.filter(c => c.source_id === late.source_id).length, 0, 'zero prepare calls for the late row');
  assert.match(f.node('#push-reviews').innerHTML, /Upload again/);
  assert.match(f.node('#push-reviews').innerHTML, /Its upload is deleted before this push could finish/);
  assert.match(f.node('#push-status').textContent, /Submitted 2 of 3/);
});

test('an identical re-upload takes over the skipped rows; a different file does not', async () => {
  const f = fixture(),
    late = source(7, 20000),
    again = source(8, 30 * 60000, {sha256: late.sha256}),
    other = source(9, 30 * 60000),
    serverTime = serve(f, [late, again, other]);
  f.run(`bindCreativePush(targets, [], [], ${JSON.stringify(serverTime)})`);
  await f.bindings.get('[data-push-source]')({dataset: {pushSource: late.source_id}});
  await f.bindings.get('#push-review')(f.node('#push-review'));
  await f.bindings.get('#push-execute')();
  assert.equal(f.calls.filter(c => c.action === 'prepare').length, 0);
  // A file with another SHA-256 re-binds nothing (the direct check; adding it starts a new review instead).
  const rows = [{state: 'expired', source: late}];
  f.context.rows = rows;
  f.context.other = other;
  assert.equal(f.run('pushRebindRows(rows, other)'), 0);
  assert.equal(rows[0].source.source_id, late.source_id);
  // The same file uploaded again re-binds the planned row: a new upload with its own window, not an extension.
  await f.bindings.get('[data-push-source]')({dataset: {pushSource: again.source_id}});
  assert.match(f.node('#push-status').textContent, /1 planned uploads now use the new upload of file-8\.png/);
  assert.doesNotMatch(f.node('#push-file').innerHTML, /file-7\.png/, 'the expired copy leaves the push');
  f.calls.length = 0;
  await f.bindings.get('#push-execute')();
  assert.deepEqual(
    f.calls.filter(c => c.action === 'prepare').map(c => [c.source_id, c.expected_sha256]),
    [[again.source_id, 'e'.repeat(64)]],
  );
});

test('a plan with temporary files is saved only after the member confirms their deadline', async () => {
  const f = fixture(),
    upload = source(1, 10 * 60000),
    serverTime = serve(f, [upload]);
  f.run(`bindCreativePush(targets, [], [], ${JSON.stringify(serverTime)})`);
  await f.bindings.get('[data-push-source]')({dataset: {pushSource: upload.source_id}});
  f.node('#push-review').elements.name.value = 'Plan media';
  await f.bindings.get('#push-review')(f.node('#push-review'));
  f.context.confirmAnswer = false;
  await f.bindings.get('#push-save-plan')();
  assert.equal(f.confirms.length, 1);
  assert.match(f.confirms[0].consequence, /Temporary files in this plan are deleted from/);
  assert.equal(f.calls.filter(c => c.tool === 'campaign').length, 0, 'declining saves nothing');
  f.context.confirmAnswer = true;
  await f.bindings.get('#push-save-plan')();
  const create = f.calls.find(c => c.tool === 'campaign');
  assert.equal(create.acknowledge_temporary_sources, true);
  assert.equal(create.steps[0].arguments.source_id, upload.source_id);
  assert.deepEqual(f.navigations, ['/campaigns?id=plan-1']);
});
