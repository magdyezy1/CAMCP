import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {CredentialProvider} from '../dist/src/auth.js';
import {MediaSources} from '../dist/src/media-sources.js';
import {downloadDriveFile, driveGateway, listDriveFolder} from '../dist/src/private-drive.js';

/**
 * The owner's request of 2026-09-29: bring several Google Drive files, and whole folders, into a creative push. A
 * folder is selected in the Drive login like a file, so AMCP reads only what the member chose: the media files
 * directly in a selected folder (Drive v3 files.list with "'<folder>' in parents"), and a file of that folder only
 * after Drive's own metadata names the folder among the file's parents.
 */
const key = Buffer.alloc(32, 57).toString('base64'),
  operator = {tenantId: 'drive-folders', userId: 'operator', role: 'operator'},
  admin = {...operator, role: 'admin'},
  reader = {...operator, userId: 'reader', role: 'reader'},
  folder = 'folder0123456789',
  inFolder = 'filein0123456789',
  elsewhere = 'fileout123456789',
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5sAAAAASUVORK5CYII=',
    'base64',
  );
const json = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
function setup(accounts = [folder]) {
  const store = new Store(':memory:', key);
  store.putConnection(
    admin,
    {
      id: 'drive',
      tenantId: operator.tenantId,
      gateway: driveGateway,
      accounts,
      enabled: true,
      label: 'Private Drive',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    },
    {accessToken: 'synthetic-drive'},
  );
  const calls = [];
  const fetcher = async (u, init) => {
    const url = new URL(String(u));
    calls.push({url, init});
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(init.redirect, 'error');
    if (url.pathname === '/drive/v3/files')
      return json({
        files: [
          {
            id: inFolder,
            name: 'Hero.png',
            mimeType: 'image/png',
            size: String(png.length),
            capabilities: {canDownload: true},
          },
          {
            id: 'locked012345678',
            name: 'Locked.mp4',
            mimeType: 'video/mp4',
            size: '10',
            capabilities: {canDownload: false},
          },
        ],
      });
    const id = url.pathname.split('/').pop();
    if (id === folder)
      return json({id: folder, name: 'Autumn campaign', mimeType: 'application/vnd.google-apps.folder'});
    if (url.searchParams.get('alt') === 'media') return new Response(png);
    return json({
      id,
      name: id === inFolder ? 'Hero.png' : 'Other.png',
      mimeType: 'image/png',
      size: String(png.length),
      capabilities: {canDownload: true},
      parents: [id === inFolder ? folder : 'another0123456789'],
    });
  };
  return {store, calls, fetcher, credentials: new CredentialProvider(store)};
}

test('a selected folder lists its downloadable media files, and nothing else is read', async () => {
  const f = setup();
  try {
    const out = await listDriveFolder(f.store, f.credentials, operator, 'drive', folder, f.fetcher);
    assert.equal(out.folder.name, 'Autumn campaign');
    assert.deepEqual(
      out.files.map(x => [x.id, x.name, x.mime]),
      [[inFolder, 'Hero.png', 'image/png']],
    );
    const list = f.calls.find(c => c.url.pathname === '/drive/v3/files').url;
    assert.match(list.searchParams.get('q'), new RegExp("^'" + folder + "' in parents and trashed = false"));
    for (const c of f.calls) assert.equal(c.init.headers.Authorization, 'Bearer synthetic-drive');
  } finally {
    f.store.close();
  }
});

test('a folder that is not selected, a file ID as a folder and a bad ID are refused before any Drive request', async () => {
  const f = setup([inFolder]);
  try {
    await assert.rejects(
      () => listDriveFolder(f.store, f.credentials, operator, 'drive', folder, f.fetcher),
      e => e.code === 'CONNECTION_REQUIRED',
    );
    await assert.rejects(
      () => listDriveFolder(f.store, f.credentials, operator, 'drive', '../etc', f.fetcher),
      e => e.code === 'INVALID_DRIVE_ID',
    );
    assert.equal(f.calls.length, 0);
    // A selected file is not a folder: Drive's own metadata decides.
    await assert.rejects(
      () => listDriveFolder(f.store, f.credentials, operator, 'drive', inFolder, f.fetcher),
      e => e.code === 'DRIVE_FOLDER_REQUIRED',
    );
    assert.ok(!f.calls.some(c => c.url.pathname === '/drive/v3/files'));
  } finally {
    f.store.close();
  }
});

test("a file of a selected folder downloads only when Drive names the folder among the file's parents", async () => {
  const f = setup();
  try {
    const file = await downloadDriveFile(f.store, f.credentials, operator, 'drive', inFolder, folder, f.fetcher);
    assert.deepEqual(file.bytes, png);
    assert.equal(file.name, 'Hero.png');
    assert.match(f.calls[0].url.searchParams.get('fields'), /parents/);
    await assert.rejects(
      () => downloadDriveFile(f.store, f.credentials, operator, 'drive', elsewhere, folder, f.fetcher),
      e => e.code === 'DRIVE_DOWNLOAD_FORBIDDEN' && /not in the selected folder/.test(e.message),
    );
    // Without a folder, the file itself must be selected.
    await assert.rejects(
      () => downloadDriveFile(f.store, f.credentials, operator, 'drive', inFolder, undefined, f.fetcher),
      e => e.code === 'CONNECTION_REQUIRED',
    );
  } finally {
    f.store.close();
  }
});

test('a Drive file becomes a push source like an upload, named from Drive; readers cannot import', async () => {
  const f = setup();
  try {
    const sources = new MediaSources(f.store, true, undefined, {
      download: (actor, connection, file, inside, sink) =>
        downloadDriveFile(f.store, f.credentials, actor, connection, file, inside, f.fetcher, sink),
      list: (actor, connection, inside) =>
        listDriveFolder(f.store, f.credentials, actor, connection, inside, f.fetcher),
    });
    const s = await sources.importDrive(operator, {connection_id: 'drive', file_id: inFolder, folder_id: folder});
    assert.equal(s.state, 'complete');
    assert.equal(s.filename, 'Hero.png');
    assert.equal(s.origin, 'drive');
    assert.equal(s.mime, 'image/png');
    assert.equal(sources.list(operator).length, 1);
    await assert.rejects(
      () => sources.importDrive(reader, {connection_id: 'drive', file_id: inFolder, folder_id: folder}),
      e => e.code === 'FORBIDDEN',
    );
    const listed = await sources.driveFolder(operator, {connection_id: 'drive', folder_id: folder});
    assert.equal(listed.files.length, 1);
  } finally {
    f.store.close();
  }
});
