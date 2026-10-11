// MED-05 (review 2026-10-08): accessible upload progress. #push-status is a polite live region and was rewritten on
// every 1 MiB part, so a 128 MiB upload made 128 announcements, and the <progress> bar had no accessible name. The bar,
// its name and the visible "part N of M" now move with each part while the region speaks only at the start, each
// quarter and the outcome: at most six announcements for any number of parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    announced = [],
    parts = [],
    labels = [];
  const node = selector => {
    if (!nodes.has(selector)) {
      let text = '';
      nodes.set(selector, {
        innerHTML: '',
        get textContent() {
          return text;
        },
        set textContent(value) {
          text = value;
          // Every write to the polite live region is something a screen reader may speak.
          if (selector === '#push-status' && value) announced.push(value);
          // The visible part counter (not a live region).
          if (selector === '#push-parts' && value) parts.push(value);
        },
        value: '',
        checked: false,
        hidden: false,
        isConnected: true,
        elements: {},
        insertAdjacentHTML(_where, html) {
          this.innerHTML += html;
        },
        addEventListener() {},
        setAttribute(name, value) {
          if (selector === '#push-bar' && name === 'aria-label') labels.push(value);
        },
        focus() {},
        click() {},
        querySelector: node,
        querySelectorAll: () => [],
      });
    }
    return nodes.get(selector);
  };
  const context = createContext({
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    Intl,
    Date,
    Blob,
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
    confirmAction: async () => true,
    navigate: async () => {},
    renderWorkspacePage() {},
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync('web/creative-push.js', 'utf8'));
  context.workspaceBind = (selector, fn) => bindings.set(selector, fn);
  node('#push-review').elements = {name: {value: '', required: false}, owner_urn: {value: ''}, fit: {checked: true}};
  context.targets = [{platform: 'meta', account_id: '100', connection_id: 'login', label: 'Meta · 100'}];
  return {run, context, node, bindings, announced, parts, labels};
}
/** The upload API double: a file of `chunks` parts that completes once every part arrived. */
function serve(f, chunks) {
  const puts = [];
  f.context.api = async (url, init = {}) => {
    if (url === '/api/media/sources' && init.method === 'POST')
      return {
        source_id: 'src-11111111-0000-0000-0000-000000000000',
        filename: 'launch.mp4',
        chunks,
        chunk_bytes: 1048576,
        expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
      };
    if (url.includes('/parts/')) {
      puts.push(url);
      return {received: puts.length - 1};
    }
    if (url.endsWith('/complete'))
      return {
        source_id: 'src-11111111-0000-0000-0000-000000000000',
        filename: 'launch.mp4',
        state: 'complete',
        origin: 'upload',
        mime: 'video/mp4',
        kind: 'video',
        size: chunks * 1048576,
        sha256: 'a'.repeat(64),
        expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
      };
    throw Error('unexpected ' + url);
  };
  return puts;
}
const file = chunks => ({
  name: 'launch.mp4',
  size: chunks * 1048576,
  type: 'video/mp4',
  lastModified: 1,
  slice: () => new Blob(['x']),
});

test('the announcer speaks at each quarter only, whatever the number of parts', () => {
  const f = fixture();
  for (const total of [1, 3, 4, 7, 128, 1000]) {
    const announce = f.context.pushProgressAnnouncer(),
      spoken = [];
    for (let done = 0; done <= total; done++) {
      const percent = announce(done, total);
      if (percent) spoken.push(percent);
    }
    // Never more than the four quarters; always the last one.
    assert.ok(spoken.length <= 4, total + ' parts: ' + spoken);
    assert.equal(spoken.at(-1), 100, total + ' parts');
    assert.deepEqual(
      spoken,
      [...spoken].sort((a, b) => a - b),
      'in order',
    );
  }
  const announce = f.context.pushProgressAnnouncer();
  assert.deepEqual(
    [32, 33, 64, 96, 127, 128].map(done => announce(done, 128)),
    [25, null, 50, 75, null, 100],
  );
});

test('a 128-part upload is announced about six times, while the named bar and the visible parts move each part', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      puts = serve(f, 128);
    f.run('bindCreativePush(targets, [], [], new Date().toISOString())');
    await f.bindings.get('#push-upload')({elements: {file: {files: [file(128)]}}, reset() {}});
    assert.equal(puts.length, 128, 'every part was sent');
    // Before MED-05: 128 part announcements plus the start, "Checking the file…" and the outcome.
    assert.ok(
      f.announced.length <= 6,
      locale + ': ' + f.announced.length + ' announcements: ' + f.announced.join(' | '),
    );
    assert.equal(f.announced.filter(a => /part \d+ of/.test(a) || /الجزء/.test(a)).length, 0, 'no per-part speech');
    assert.match(
      f.announced.join(' | '),
      locale === 'ar'
        ? /launch\.mp4: رُفع 25%.*رُفع 50%.*رُفع 75%.*رُفع 100%/
        : /launch\.mp4: 25% uploaded.*50%.*75%.*100% uploaded/,
    );
    // The progress element is named by the file it shows.
    assert.ok(f.labels.length > 0);
    assert.match(f.labels.at(-1), locale === 'ar' ? /تقدّم رفع launch\.mp4/ : /Upload progress of launch\.mp4/);
    assert.equal(f.node('#push-bar').value, 128);
    assert.equal(f.node('#push-bar').max, 128);
    // The visible part counter (not a live region) moved with every part, then showed the check of the whole file.
    assert.equal(f.parts.length, 129, locale + ': one visible step per part plus the check');
    assert.match(f.parts[0], locale === 'ar' ? /launch\.mp4/ : /launch\.mp4: part 1 of 128/);
    assert.match(f.parts[127], locale === 'ar' ? /128/ : /launch\.mp4: part 128 of 128/);
    assert.equal(f.parts[128], f.context.uiText('Checking the file…'));
    // The outcome replaces it, so no stale part counter stays next to the result.
    assert.equal(f.node('#push-parts').textContent, '');
  }
});

test('a resumed upload announces only the quarters still ahead of the parts already received', async () => {
  const f = fixture(),
    puts = serve(f, 8);
  f.context.api = (
    inner =>
    async (url, init = {}) => {
      // The unfinished upload's status: parts 0-3 already arrived.
      if (url === '/api/media/sources/src-11111111-0000-0000-0000-000000000000' && !init.method)
        return {
          source_id: 'src-11111111-0000-0000-0000-000000000000',
          filename: 'launch.mp4',
          state: 'receiving',
          size: 8 * 1048576,
          chunks: 8,
          chunk_bytes: 1048576,
          received_parts: [0, 1, 2, 3],
          parts_sealed: false,
          first_part_sha256: null,
          expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
        };
      return inner(url, init);
    }
  )(f.context.api);
  // The page still holds the file, so Resume continues at once.
  f.context.file = file(8);
  f.run(
    `bindCreativePush(targets, [], [{source_id: 'src-11111111-0000-0000-0000-000000000000', filename: 'launch.mp4', size: ${8 * 1048576}, chunks: 8, received_chunks: 4, expires_at: new Date(Date.now() + 1800000).toISOString(), file}], new Date().toISOString())`,
  );
  await f.bindings.get('[data-push-resume]')({dataset: {pushResume: 'src-11111111-0000-0000-0000-000000000000'}});
  // Only the four missing parts were sent.
  assert.equal(puts.length, 4);
  // "Resuming", then 50% (reached by the first part sent), 75%, 100% and the outcome; never 25% again.
  assert.equal(f.announced.length, 5, f.announced.join(' | '));
  assert.match(f.announced[0], /Resuming launch\.mp4/);
  assert.deepEqual(f.announced.slice(1, 4), [
    'launch.mp4: 50% uploaded',
    'launch.mp4: 75% uploaded',
    'launch.mp4: 100% uploaded',
  ]);
  assert.match(f.announced[4], /The file is ready/);
  assert.equal(f.labels.at(-1), 'Upload progress of launch.mp4');
});

test('the progress bar carries an accessible name in the panel markup', () => {
  const f = fixture();
  const html = f.run('creativePushPanel(targets, [], [], [])');
  assert.match(html, /<progress id="push-bar"[^>]*aria-label="Upload progress"/);
  assert.match(html, /<p id="push-parts" class="form-note"><\/p>/);
  assert.match(html, /<p id="push-status" class="form-note" role="status"><\/p>/);
});
