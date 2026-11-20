import test, {after, before, mock} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {MediaSources} from '../src/media-sources.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {MirrorError} from '../src/errors.js';
import {createHttpApp} from '../server/http-app.js';
import type {Actor} from '../src/types.js';
import {listenForFetch} from './http-listener.js';
import {assertRefused} from './helpers/assert-refused.js';
import {
  FILE_ID,
  confirmationPage,
  drive,
  endpoint,
  file,
  hosts,
  noOutboundFetch,
  png,
  share,
} from './helpers/drive-large.js';

/**
 * R2.5 field fix r25-media-drive-large, item 4 (2026-11-19): the website's "import from a link" takes a public Google Drive
 * link through the same Drive helper the MCP drive_url does, so a large file behind Drive's confirmation page imports there
 * too; a link that is not a Drive link goes the way it always went. Every page and file is synthetic.
 */
const key = Buffer.alloc(32, 55).toString('base64'),
  operator: Actor = {tenantId: 't', userId: 'u', role: 'operator'};
// Nothing in this file may reach Drive or the internet, whatever the wiring does: any other host fails the test.
before(() => noOutboundFetch());
after(() => mock.restoreAll());
const redirectToSignIn = () =>
  new Response(null, {status: 302, headers: {Location: 'https://accounts.google.com/ServiceLogin?service=wise'}});
const count = (store: Store, table: string) =>
  (store.db.prepare('SELECT count(*) AS n FROM ' + table).get() as {n: number}).n;
async function refusal(run: Promise<unknown>): Promise<MirrorError> {
  try {
    await run;
  } catch (e) {
    assert.ok(e instanceof MirrorError, 'a refusal (MirrorError), not ' + String(e));
    return e;
  }
  return assert.fail('expected a refusal');
}

test('a public Drive link imported on the website goes through the Drive helper: the confirmation page is followed', async () => {
  const store = new Store(':memory:', key),
    stand = drive(confirmationPage, file);
  let linkRequests = 0;
  try {
    const sources = new MediaSources(
        store,
        true,
        async () => {
          linkRequests++;
          return new Response(png);
        },
        undefined,
        stand.fetcher,
      ),
      done = await sources.importLink(operator, share);
    assert.equal(done.state, 'complete');
    assert.equal(done.origin, 'drive');
    assert.equal(done.link_host, undefined);
    assert.equal(done.drive_access, undefined);
    assert.equal(done.filename, 'drive.png');
    assert.equal(done.mime, 'image/png');
    assert.equal(done.size, png.length);
    assert.deepEqual(sources.file(operator, done.source_id).bytes, png);
    assert.equal(linkRequests, 0);
    assert.equal(stand.requests.length, 2);
    assert.deepEqual(hosts(stand.requests), [
      'https://drive.usercontent.google.com',
      'https://drive.usercontent.google.com',
    ]);
    for (const r of stand.requests) assert.equal(r.url.origin + r.url.pathname, endpoint);
    // The link and the file's ID are never stored, as a link import stores its host only.
    const stored =
      JSON.stringify(store.db.prepare('SELECT data FROM documents').all()) +
      JSON.stringify(store.db.prepare('SELECT event FROM audit').all());
    assert.equal(stored.includes(FILE_ID), false);
    assert.equal(stored.includes('drive.google.com'), false);
    assert.equal(count(store, 'media_admissions'), 0);
    assert.equal(sources.list(operator).length, 1);
  } finally {
    store.close();
  }
});
test('a link that is not a Drive link goes the way it always went, and never asks Drive', async () => {
  const store = new Store(':memory:', key),
    stand = drive(confirmationPage, file);
  try {
    const sources = new MediaSources(store, true, async () => new Response(png), undefined, stand.fetcher),
      done = await sources.importLink(operator, 'https://cdn.example.com/banner.png?token=secret-token');
    assert.equal(done.origin, 'link');
    assert.equal(done.link_host, 'cdn.example.com');
    assert.equal(done.filename, 'banner.png');
    assert.deepEqual(sources.file(operator, done.source_id).bytes, png);
    assert.equal(stand.requests.length, 0);
    // A look-alike of Drive's host is a link like any other: it goes to the link importer, never to Drive.
    const lookalike = await sources.importLink(
      operator,
      'https://drive.google.com.attacker.invalid/file/d/' + FILE_ID + '/view',
    );
    assert.equal(lookalike.origin, 'link');
    assert.equal(lookalike.link_host, 'drive.google.com.attacker.invalid');
    assert.equal(stand.requests.length, 0);
  } finally {
    store.close();
  }
});
test('a Drive link that is not public is refused with its reason, and nothing is left behind', async () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true, undefined, undefined, drive(redirectToSignIn).fetcher),
      e = await refusal(sources.importLink(operator, share));
    assertRefused(e, 'DRIVE_FILE_UNAVAILABLE');
    assert.equal(e.details.reason, 'not_shared');
    assert.equal(sources.list(operator).length, 0);
    assert.deepEqual(
      {
        staging: count(store, 'media_staging'),
        chunks: count(store, 'media_chunks'),
        admissions: count(store, 'media_admissions'),
      },
      {staging: 0, chunks: 0, admissions: 0},
    );
  } finally {
    store.close();
  }
});
test('a Drive folder or a Google Doc is refused as what it is, before any request', async () => {
  const store = new Store(':memory:', key),
    stand = drive(confirmationPage, file);
  try {
    const sources = new MediaSources(store, true, undefined, undefined, stand.fetcher);
    for (const link of [
      'https://drive.google.com/drive/folders/synFolderIdAbcdefg1',
      'https://docs.google.com/document/d/synDocumentIdAbcdef1/edit',
    ])
      assertRefused(await refusal(sources.importLink(operator, link)), 'INVALID_DRIVE_LINK');
    assert.equal(stand.requests.length, 0);
    assert.equal(count(store, 'media_admissions'), 0);
  } finally {
    store.close();
  }
});

test('the website’s link route imports a public Drive file, refuses one that is not public, and leaves other links alone', async () => {
  const master = Buffer.alloc(32, 56).toString('base64'),
    password = 'synthetic-test-password-only',
    origin = 'https://amcp.shop',
    store = new Store(':memory:', master);
  let stand = drive(confirmationPage, file);
  const requested: string[] = [],
    svc = new MirrorService(
      new Registry(),
      store,
      undefined,
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
      async (input, init) => {
        requested.push(String(input));
        return stand.fetcher(input, init);
      },
      async () => new Response(png),
    ),
    listener = await listenForFetch(
      createHttpApp(svc, store, {website: {origin, masterKey: master, adminPassword: password}}),
    ),
    base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  try {
    const login = await fetch(base + '/api/session', {
        method: 'POST',
        headers: {Origin: origin, 'Content-Type': 'application/json'},
        body: JSON.stringify({password}),
      }),
      cookie = login.headers.get('set-cookie')!.split(';')[0]!,
      csrf = (await login.json()).csrf,
      headers = {Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-AMCP-CSRF': csrf},
      importLink = (url: string) =>
        fetch(base + '/api/media/sources/link', {method: 'POST', headers, body: JSON.stringify({url})});
    // A public Drive file, behind the confirmation page.
    const first = await importLink(share),
      imported = await first.json();
    assert.equal(first.status, 201, JSON.stringify(imported));
    assert.equal(imported.origin, 'drive');
    assert.equal(imported.state, 'complete');
    assert.match(imported.source_id, /^src-/);
    assert.equal(requested.length, 2);
    // It is among the member's files.
    const listed = await (await fetch(base + '/api/media/sources', {headers: {Cookie: cookie}})).json();
    assert.deepEqual(
      listed.sources.map((s: {source_id: string}) => s.source_id),
      [imported.source_id],
    );
    // A Drive file that is not public: the refusal's code and its words reach the page.
    stand = drive(redirectToSignIn);
    const refused = await importLink(share),
      body = await refused.json();
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(body.error.code, 'DRIVE_FILE_UNAVAILABLE');
    assert.match(body.error.message, /Drive connection/);
    // Any other link is the link importer's, as before.
    const other = await importLink('https://cdn.example.com/banner.png'),
      otherBody = await other.json();
    assert.equal(other.status, 201, JSON.stringify(otherBody));
    assert.equal(otherBody.origin, 'link');
    assert.equal(otherBody.link_host, 'cdn.example.com');
    assert.equal(requested.length, 3, 'only the Drive file and the refused Drive link asked Drive');
  } finally {
    const closed = new Promise<void>(r => listener.close(() => r()));
    listener.closeAllConnections();
    await closed;
    store.close();
  }
});
