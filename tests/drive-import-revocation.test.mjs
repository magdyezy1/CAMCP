import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {CredentialProvider} from '../dist/src/auth.js';
import {MediaSources} from '../dist/src/media-sources.js';
import {sha256} from '../dist/src/security.js';
import {downloadDriveFile, driveGateway, driveSelectionHeld, listDriveFolder} from '../dist/src/private-drive.js';

/**
 * MED-05 (review 2026-10-08), owner decision D23 (4): a Drive import is a frozen copy. Revoking the Drive login, its
 * selection or its download scope neither removes nor blocks an import already made, or an owner's retained copy of
 * it; before this change nothing said so, and a retained copy dropped its Drive provenance entirely. The import and its
 * retained copy now keep the Drive selection they came through (IDs only), and the list reports `drive_access`
 * (`selected` or `revoked`), which the website shows as "Drive access since revoked".
 */
const key = Buffer.alloc(32, 61).toString('base64'),
  owner = {tenantId: 'drive-revocation', userId: 'owner', role: 'admin'},
  operator = {...owner, userId: 'operator', role: 'operator'},
  folder = 'folder0123456789',
  inFolder = 'filein0123456789',
  single = 'single0123456789',
  other = 'other00123456789',
  readonly = ['https://www.googleapis.com/auth/drive.readonly'],
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5sAAAAASUVORK5CYII=',
    'base64',
  );
const json = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
const login = (accounts, extra = {}) => ({
  id: 'drive',
  tenantId: owner.tenantId,
  gateway: driveGateway,
  accounts,
  enabled: true,
  label: 'Private Drive',
  scopes: readonly,
  ...extra,
});
function setup() {
  const store = new Store(':memory:', key);
  store.putConnection(owner, login([folder, single]), {accessToken: 'synthetic-drive'});
  // A synthetic Drive: every file is a 1 × 1 PNG; inFolder sits in the selected folder.
  const fetcher = async u => {
    const url = new URL(String(u));
    assert.equal(url.origin, 'https://www.googleapis.com');
    if (url.searchParams.get('alt') === 'media') return new Response(png);
    const id = url.pathname.split('/').pop();
    return json({
      id,
      name: id === inFolder ? 'Hero.png' : 'Single.png',
      mimeType: 'image/png',
      size: String(png.length),
      capabilities: {canDownload: true},
      parents: [id === inFolder ? folder : 'another0123456789'],
    });
  };
  const credentials = new CredentialProvider(store),
    sources = new MediaSources(store, true, undefined, {
      download: (actor, connection, file, inside, sink) =>
        downloadDriveFile(store, credentials, actor, connection, file, inside, fetcher, sink),
      list: (actor, connection, inside) => listDriveFolder(store, credentials, actor, connection, inside, fetcher),
    });
  const listed = (actor, id) => sources.list(actor).find(s => s.source_id === id);
  return {store, sources, listed};
}

test('an import made through a selected folder or file lists its Drive access as selected', async () => {
  const f = setup();
  try {
    const viaFolder = await f.sources.importDrive(operator, {
        connection_id: 'drive',
        file_id: inFolder,
        folder_id: folder,
      }),
      // A file selected itself; an empty folder_id means none (the file itself is checked).
      direct = await f.sources.importDrive(operator, {connection_id: 'drive', file_id: single, folder_id: ''});
    assert.equal(viaFolder.drive_access, 'selected');
    assert.equal(direct.drive_access, 'selected');
    // IDs only: the record keeps the login, file and folder it came through, and no Drive link or name of them.
    const record = f.store.document(operator.tenantId, 'media_source', viaFolder.source_id);
    assert.deepEqual(record.drive, {connection_id: 'drive', file_id: inFolder, folder_id: folder});
    assert.deepEqual(f.store.document(operator.tenantId, 'media_source', direct.source_id).drive, {
      connection_id: 'drive',
      file_id: single,
      folder_id: null,
    });
    // The view never exposes the provenance IDs themselves, only whether the access stands.
    assert.equal(viaFolder.drive, undefined);
  } finally {
    f.store.close();
  }
});

test('revoking the Drive selection, the login or its scope keeps the frozen import usable and says Drive access was revoked', async () => {
  const f = setup();
  try {
    const s = await f.sources.importDrive(operator, {connection_id: 'drive', file_id: inFolder, folder_id: folder});
    // The folder is no longer selected (the single file still is).
    f.store.updateConnection(owner, login([single]));
    assert.equal(f.listed(operator, s.source_id).drive_access, 'revoked');
    // A frozen copy: the bytes are still there, unchanged, and still usable for a reviewed push.
    const file = f.sources.file(operator, s.source_id);
    assert.deepEqual(file.bytes, png);
    assert.equal(f.sources.describe(operator, s.source_id).sha256, sha256(png));
    // Selecting the folder again restores it.
    f.store.updateConnection(owner, login([folder]));
    assert.equal(f.listed(operator, s.source_id).drive_access, 'selected');
    // The login disabled, or reconnected without a scope that can download: revoked as well.
    f.store.updateConnection(owner, login([], {enabled: false}));
    assert.equal(f.listed(operator, s.source_id).drive_access, 'revoked');
    f.store.updateConnection(owner, login([folder], {scopes: ['openid']}));
    assert.equal(f.listed(operator, s.source_id).drive_access, 'revoked');
    assert.deepEqual(f.sources.file(operator, s.source_id).bytes, png);
    // A new import through the revoked access is still refused: only copies already made are frozen.
    await assert.rejects(
      () => f.sources.importDrive(operator, {connection_id: 'drive', file_id: inFolder, folder_id: folder}),
      e => e.code === 'DRIVE_SCOPE_REQUIRED',
    );
  } finally {
    f.store.close();
  }
});

test("an owner's retained copy keeps the Drive provenance (IDs only) and shows the revocation, without being blocked", async () => {
  const f = setup();
  try {
    const s = await f.sources.importDrive(operator, {connection_id: 'drive', file_id: inFolder, folder_id: folder}),
      retained = f.sources.retain(owner, s.source_id, {confirmed: true, expected_sha256: sha256(png)});
    assert.equal(retained.origin, 'drive');
    assert.equal(retained.drive_access, 'selected');
    // Before MED-05 the retained record dropped the Drive binding: nothing could tell its access was revoked.
    assert.deepEqual(f.store.document(owner.tenantId, 'retained_media_source', retained.source_id).drive, {
      connection_id: 'drive',
      file_id: inFolder,
      folder_id: folder,
    });
    f.store.updateConnection(owner, login([single]));
    assert.equal(f.listed(owner, retained.source_id).drive_access, 'revoked');
    assert.deepEqual(f.sources.file(operator, retained.source_id).bytes, png);
    // The owner still removes it explicitly; revocation removed nothing.
    assert.equal(
      f.sources.remove(owner, retained.source_id, {confirmed: true, expected_sha256: sha256(png)}).removed,
      true,
    );
  } finally {
    f.store.close();
  }
});

test('uploads and link imports carry no Drive access; a malformed provenance is ignored', () => {
  const f = setup();
  try {
    const now = Date.now(),
      put = (id, data) =>
        f.store.putDocument(operator.tenantId, 'media_source', id, {
          user_id: operator.userId,
          filename: 'x.png',
          state: 'complete',
          size: png.length,
          mime: 'image/png',
          kind: 'image',
          sha256: sha256(png),
          created_at: now,
          expires_at: now + 600000,
          inspection: 'unavailable',
          ...data,
        });
    put('src-00000000-0000-0000-0000-000000000001', {origin: 'link', link_host: 'cdn.example'});
    put('src-00000000-0000-0000-0000-000000000002', {origin: 'drive', drive: {connection_id: 7}});
    // A link import that somehow carries a drive field is still not a Drive import.
    put('src-00000000-0000-0000-0000-000000000003', {
      origin: 'link',
      drive: {connection_id: 'drive', file_id: single, folder_id: null},
    });
    for (const s of f.sources.list(operator)) assert.equal(s.drive_access, undefined, s.source_id);
  } finally {
    f.store.close();
  }
});

test('driveSelectionHeld follows the same rules as a Drive download', () => {
  assert.equal(driveSelectionHeld(login([folder]), folder), true);
  assert.equal(driveSelectionHeld(login([folder]), single), false);
  assert.equal(driveSelectionHeld(login([folder], {enabled: false}), folder), false);
  assert.equal(driveSelectionHeld(login([folder], {scopes: ['openid']}), folder), false);
  assert.equal(driveSelectionHeld(login([folder], {gateway: 'meta_native_action'}), folder), false);
  assert.equal(driveSelectionHeld(undefined, folder), false);
  for (const scope of [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive',
    readonly[0],
  ])
    assert.equal(driveSelectionHeld(login([other], {scopes: [scope]}), other), true, scope);
});

/** The push panel in a VM, in English or Arabic, with the page helpers it uses. */
function panel(locale) {
  const context = createContext({
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    Intl,
    Date,
    URLSearchParams,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    date: String,
    document: {addEventListener() {}},
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync('web/creative-push.js', 'utf8'));
  return {context, run};
}
const original = access => ({
  source_id: 'lib-11111111-0000-0000-0000-000000000000',
  filename: 'Hero.png',
  state: 'complete',
  origin: 'drive',
  retained: true,
  mime: 'image/png',
  size: 70,
  uploaded_at: '2026-10-11T08:00:00Z',
  ...(access ? {drive_access: access} : {}),
});

test('the push panel says "Drive access since revoked" on such an original, in English and Arabic', () => {
  for (const locale of ['en', 'ar']) {
    const p = panel(locale),
      revoked = p.context.uiText('Drive access since revoked');
    p.context.recent = [original('revoked'), {...original('selected'), source_id: 'lib-2', filename: 'Still.png'}];
    const html = p.run('creativePushPanel([], recent, [], [])');
    assert.equal(html.split(revoked).length - 1, 1, locale + ': only the revoked original is marked');
    // Arabic has its own wording; the product name Drive stays literal.
    if (locale === 'ar') assert.equal(revoked, 'أُلغي الوصول إلى Drive منذ ذلك الحين');
    // The chosen file explains that the frozen copy is unaffected; nothing for a selected or non-Drive original.
    p.context.s = original('revoked');
    assert.match(p.run('pushDriveAccessNote(s)'), new RegExp(revoked));
    p.context.s = original('selected');
    assert.equal(p.run('pushDriveAccessNote(s)'), '');
    p.context.s = original(undefined);
    assert.equal(p.run('pushDriveAccessNote(s)'), '');
  }
});
