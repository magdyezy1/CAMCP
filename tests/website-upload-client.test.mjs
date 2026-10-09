// MED-01 (review 2026-10-08): the website client frees an upload that cannot finish at once (DELETE, keepalive, CSRF),
// keeps an interrupted one to resume, resumes by sending only the missing parts of the same file, and lists unfinished
// uploads with Resume and Discard.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
const hex = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceId = 'src-22222222-2222-2222-2222-222222222222';

function fixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    requests = [],
    fetches = [],
    stored = new Map();
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
        listeners: {},
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        },
        setAttribute() {},
        focus() {},
        click() {
          this.clicked = (this.clicked ?? 0) + 1;
        },
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
    sessionStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
    },
    fetch: async (url, init) => {
      fetches.push({url, ...init});
      return {ok: true, json: async () => ({})};
    },
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync('web/creative-push.js', 'utf8'));
  context.workspaceBind = (selector, fn) => bindings.set(selector, fn);
  return {run, context, node, bindings, requests, fetches, stored};
}
/** A server double: `parts` decides each part's reply; `status` is an unfinished upload's resume state. */
function serve(f, {chunks, parts = () => ({}), status} = {}) {
  f.context.api = async (url, options = {}) => {
    f.requests.push({url, method: options.method ?? 'GET'});
    if (url === '/api/media/sources' && options.method === 'POST')
      return {source_id: sourceId, filename: 'creative.png', chunks, chunk_bytes: 4, expires_at: '2026-10-09T10:30Z'};
    if (url.includes('/parts/')) {
      const reply = parts(Number(url.split('/parts/')[1]));
      if (reply instanceof Error) throw reply;
      return {source_id: sourceId};
    }
    if (url.endsWith('/complete')) return {source_id: sourceId, state: 'complete', sha256: 'f'.repeat(64)};
    if (options.method === 'DELETE') return {source_id: sourceId, removed: true};
    if (url === '/api/media/sources/' + sourceId) return status;
    throw Error('unexpected ' + url);
  };
}
const file = (text = 'abcdefghij') => new File([text], 'creative.png', {type: 'image/png', lastModified: 1000});
const coded = (code, message = code) => Object.assign(Error(message), {code});

test('an upload the server refuses is discarded at once, with keepalive and the session CSRF token', async () => {
  const f = fixture();
  serve(f, {chunks: 3, parts: index => (index === 1 ? coded('INVALID_MEDIA_UPLOAD') : {})});
  f.context.file = file();
  await assert.rejects(f.run('uploadCreative(file, () => {})'), e => e.code === 'INVALID_MEDIA_UPLOAD' && e.discarded);
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0].url, '/api/media/sources/' + sourceId);
  assert.equal(f.fetches[0].method, 'DELETE');
  assert.equal(f.fetches[0].keepalive, true);
  assert.equal(f.fetches[0].headers['X-AMCP-CSRF'], 'csrf-synthetic');
  assert.equal(f.fetches[0].credentials, 'same-origin');
  assert.equal(f.stored.get('amcp.unfinished-uploads'), '{}');
});

test('an upload interrupted by a lost connection is kept to resume, not discarded', async () => {
  const f = fixture();
  serve(f, {chunks: 3, parts: index => (index === 2 ? Error('AMCP could not read the server response.') : {})});
  f.context.file = file();
  let error;
  try {
    await f.run('uploadCreative(file, () => {})');
  } catch (e) {
    error = e;
  }
  assert.equal(error.unfinished.source_id, sourceId);
  assert.equal(error.unfinished.received_chunks, 2);
  assert.equal(f.fetches.length, 0);
  // Each part was tried three times before giving up; the upload is remembered by name, size and last change.
  assert.equal(f.requests.filter(r => r.url.endsWith('/parts/2')).length, 3);
  assert.deepEqual(JSON.parse(f.stored.get('amcp.unfinished-uploads'))[sourceId], {
    name: 'creative.png',
    size: 10,
    last_modified: 1000,
  });
});

test('a resume checks the chosen file, then sends only the missing parts', async () => {
  const f = fixture(),
    bytes = Buffer.from('abcdefghij');
  serve(f, {
    chunks: 3,
    status: {
      source_id: sourceId,
      state: 'receiving',
      size: 10,
      chunks: 3,
      chunk_bytes: 4,
      received_parts: [0, 2],
      missing_parts: [1],
      parts_sealed: false,
      first_part_sha256: hex(bytes.subarray(0, 4)),
    },
  });
  f.context.file = file();
  const done = await f.run(`resumeCreativeUpload(${JSON.stringify(sourceId)}, file, () => {})`);
  assert.equal(done.state, 'complete');
  assert.deepEqual(
    f.requests.filter(r => r.method === 'PUT').map(r => r.url),
    ['/api/media/sources/' + sourceId + '/parts/1'],
  );
  assert.equal(f.requests.filter(r => r.url.endsWith('/complete')).length, 1);
  // A file of another size, or another first part, is refused before anything is sent.
  for (const other of ['abcdefghijk', 'XXXXefghij']) {
    f.requests.length = 0;
    f.context.file = file(other);
    await assert.rejects(f.run(`resumeCreativeUpload(${JSON.stringify(sourceId)}, file, () => {})`), {
      code: 'MEDIA_RESUME_FILE_MISMATCH',
    });
    assert.deepEqual(
      f.requests.map(r => r.method),
      ['GET'],
    );
  }
  assert.equal(f.fetches.length, 0, 'a mismatch never discards the upload');
});

test('an upload whose parts were sealed by an interrupted completion is completed again without parts', async () => {
  const f = fixture();
  serve(f, {
    chunks: 3,
    status: {source_id: sourceId, state: 'receiving', size: 10, chunks: 3, chunk_bytes: 4, parts_sealed: true},
  });
  f.context.file = file();
  assert.equal((await f.run(`resumeCreativeUpload(${JSON.stringify(sourceId)}, file, () => {})`)).state, 'complete');
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 0);
  // While sending parts, a sealed upload is completed instead of failing.
  const g = fixture();
  serve(g, {chunks: 3, parts: index => (index === 1 ? coded('MEDIA_UPLOAD_COMPLETING') : {})});
  g.context.file = file();
  assert.equal((await g.run('uploadCreative(file, () => {})')).state, 'complete');
  assert.equal(g.fetches.length, 0);
});

test('unfinished uploads are listed with Resume and Discard in both languages; Discard frees the place', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    serve(f, {chunks: 3});
    f.context.targets = [];
    f.context.unfinished = [
      {
        source_id: sourceId,
        filename: 'Draft <video>.mp4',
        state: 'receiving',
        chunks: 3,
        received_chunks: 1,
        released_if_idle_at: '2026-10-09T10:10:00Z',
        expires_at: '2026-10-09T10:30:00Z',
      },
    ];
    f.node('#push-review').elements = {name: {value: ''}, owner_urn: {value: ''}, fit: {checked: true}};
    f.run('bindCreativePush(targets, [], unfinished)');
    const html = f.node('#push-unfinished').innerHTML;
    assert.match(html, /data-push-resume="src-2222/);
    assert.match(html, /data-push-discard="src-2222/);
    assert.doesNotMatch(html, /<video>/);
    assert.match(html, locale === 'ar' ? /عمليات الرفع غير المكتملة/ : /Unfinished uploads/);
    assert.match(html, locale === 'ar' ? /تجاهل/ : /Discard/);
    // Resume without the file in this page asks for it again.
    await f.bindings.get('[data-push-resume]')({dataset: {pushResume: sourceId}});
    assert.equal(f.node('#push-resume-file').clicked, 1);
    await f.bindings.get('[data-push-discard]')({dataset: {pushDiscard: sourceId}});
    assert.deepEqual(plain(f.requests.filter(r => r.method === 'DELETE')), [
      {url: '/api/media/sources/' + sourceId, method: 'DELETE'},
    ]);
    assert.equal(f.node('#push-unfinished').innerHTML, '');
  }
});
