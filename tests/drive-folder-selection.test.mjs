import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

/**
 * A Drive login selects folders as well as files (the owner's request of 2026-09-29), and no other platform gains a
 * second selectable kind. A sync of one kind never drops what the login selected of the other.
 */
const master = Buffer.alloc(32, 63).toString('base64'),
  password = 'synthetic-folder-selection-only',
  origin = 'https://amcp.shop',
  admin = {tenantId: 'local', userId: 'tester', role: 'admin'},
  file = 'drivefile000001',
  folder = 'drivefolder0001';
const drive = async u => {
  const url = new URL(String(u));
  if (url.origin === 'https://oauth2.googleapis.com') throw Error('No token refresh expected');
  const q = url.searchParams.get('q') ?? '';
  return Response.json({
    files: q.includes('google-apps.folder')
      ? [{id: folder, name: 'Autumn campaign'}]
      : [{id: file, name: 'Logo.png', mimeType: 'image/png', size: '10', capabilities: {canDownload: true}}],
  });
};
async function site() {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store),
    listener = await listenForFetch(
      createHttpApp(service, store, {website: {origin, masterKey: master, adminPassword: password, fetcher: drive}}),
    ),
    base = 'http://127.0.0.1:' + listener.address().port;
  const request = async (url, method = 'GET', body, headers = {}) => {
    const r = await fetch(base + url, {
      method,
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: r.status, headers: r.headers, data: await r.json().catch(() => null)};
  };
  const login = await request('/api/session', 'POST', {password});
  const headers = {Cookie: login.headers.get('set-cookie').split(';')[0], 'X-AMCP-CSRF': login.data.csrf};
  const put = c =>
    store.putConnection(
      admin,
      {tenantId: 'local', enabled: false, accounts: [], label: c.id, ...c},
      {accessToken: 'x'},
    );
  return {
    store,
    put,
    call: (url, method, body) => request(url, method, body, headers),
    close: async () => {
      const closed = new Promise(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closed;
      store.close();
    },
  };
}

test('a Drive login selects files and folders; a sync of files keeps the selected folders', async () => {
  const s = await site();
  try {
    s.put({
      id: 'drive',
      gateway: 'google_drive_native_action',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    let r = await s.call('/api/connections/drive/sync', 'POST', {kinds: ['files', 'folders']});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await s.call('/api/connections/drive/assets', 'PATCH', {selected: ['files:' + file, 'folders:' + folder]});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const accounts = () => s.store.listConnections('local').find(c => c.id === 'drive').accounts;
    assert.deepEqual(accounts().sort(), [file, folder].sort());
    // A sync of the files kind alone lists no folders, and must not drop the folder.
    r = await s.call('/api/connections/drive/sync', 'POST', {kinds: ['files']});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(accounts().sort(), [file, folder].sort());
    // The website names Drive folders as a selectable kind.
    const platforms = (await s.call('/api/platforms')).data;
    const list = Array.isArray(platforms) ? platforms : (platforms.platforms ?? []);
    assert.deepEqual(list.find(p => p.id === 'drive').selectableKinds, ['files', 'folders']);
    assert.deepEqual(list.find(p => p.id === 'meta').selectableKinds, ['ad_accounts']);
  } finally {
    await s.close();
  }
});

test('a folder key, or any second kind, is refused for platforms that select one kind', async () => {
  const s = await site();
  try {
    s.put({
      id: 'drive',
      gateway: 'google_drive_native_action',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    await s.call('/api/connections/drive/sync', 'POST', {kinds: ['files', 'folders']});
    // An unsynced folder is unknown.
    let r = await s.call('/api/connections/drive/assets', 'PATCH', {selected: ['folders:drivefolder9999']});
    assert.equal(r.data?.error?.code ?? r.data?.code, 'UNKNOWN_ASSET', JSON.stringify(r.data));
    // The same Drive ID under two kinds is refused.
    r = await s.call('/api/connections/drive/assets', 'PATCH', {selected: ['files:' + file, 'folders:' + file]});
    assert.notEqual(r.status, 200);
    s.put({
      id: 'sheets',
      gateway: 'google_sheets_native_action',
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    r = await s.call('/api/connections/sheets/assets', 'PATCH', {selected: ['folders:' + folder]});
    assert.notEqual(r.status, 200);
  } finally {
    await s.close();
  }
});
