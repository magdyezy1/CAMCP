import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {MediaSources, SOURCE_TTL_MS} from '../dist/src/media-sources.js';
import {sha256} from '../dist/src/security.js';
import {ownerAccess} from '../dist/src/spend-policy.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {Client} from '@modelcontextprotocol/client';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createEncryptedBackup, restoreEncryptedBackup} from '../dist/src/backup.js';
import {MAX_MEDIA_BYTES} from '../dist/src/drive-media.js';

const key = Buffer.alloc(32, 81).toString('base64');
const owner = {tenantId: 'retained-fixture', userId: 'owner', role: 'admin'};
const operator = {...owner, userId: 'uploader', role: 'operator'};
const colleague = {...operator, userId: 'colleague'};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
function staged(store, actor = operator, origin = 'link') {
  store.ensureTenant(actor.tenantId);
  const id = 'src-' + randomUUID(),
    now = Date.now();
  store.reserveMediaSource(actor.tenantId, id, now + SOURCE_TTL_MS);
  store.stageMedia(actor.tenantId, id, png);
  store.putDocument(actor.tenantId, 'media_source', id, {
    user_id: actor.userId,
    filename: 'synthetic-original.png',
    origin,
    state: 'complete',
    size: png.length,
    mime: 'image/png',
    kind: 'image',
    sha256: sha256(png),
    created_at: now,
    expires_at: now + SOURCE_TTL_MS,
    inspection: 'unavailable',
  });
  return id;
}
const confirmed = () => ({confirmed: true, expected_sha256: sha256(png)});
const count = store => Number(store.db.prepare('SELECT count(*) AS n FROM retained_media').get().n);
function member(store, role = 'admin') {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS amcp_users(id TEXT PRIMARY KEY,version INTEGER,approved INTEGER,disabled INTEGER)',
  );
  store.db.prepare('INSERT INTO amcp_users VALUES(?,1,1,0)').run('other-owner');
  store.db
    .prepare('INSERT INTO workspace_memberships VALUES(?,?,?,?,?)')
    .run(owner.tenantId, 'other-owner', role, 1, Date.now());
  return {...owner, ownerUserId: 'other-owner', membershipRole: role};
}

test('owner retains an exact encrypted original without extending temporary expiry; retries reuse the copy', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store),
      before = store.document(owner.tenantId, 'media_source', id);
    const retained = sources.retain(owner, id, confirmed());
    assert.equal(retained.source_id, id.replace('src-', 'lib-'));
    assert.equal(retained.retained, true);
    assert.equal(retained.expires_at, null);
    assert.equal(retained.retention.mode, 'until_removed');
    assert.equal(retained.sha256, sha256(png));
    assert.deepEqual(sources.file(operator, retained.source_id).bytes, png);
    assert.deepEqual(store.document(owner.tenantId, 'media_source', id), before);
    assert.equal(sources.retain(owner, id, confirmed()).source_id, retained.source_id);
    assert.equal(count(store), 1);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM audit WHERE event LIKE '%media_source_retained%'").get().n,
      1,
    );
    const sealed = store.db.prepare('SELECT secret FROM retained_media_chunks').get().secret;
    assert.equal(sealed.includes(png.toString('base64')), false);
    assert.throws(() => sources.file(colleague, retained.source_id), {code: 'FORBIDDEN'});
    assert.throws(() => sources.file({...owner, tenantId: 'foreign'}, retained.source_id), {
      code: 'MEDIA_SOURCE_NOT_FOUND',
    });
  } finally {
    store.close();
  }
});

test('retaining requires current real owner authority, enabled uploads and exact explicit hash confirmation', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store);
    const nonOwner = member(store);
    for (const actor of [operator, {...owner, testAccount: true}, nonOwner])
      assert.throws(() => sources.retain(actor, id, confirmed()), {code: 'OWNER_REQUIRED'});
    for (const args of [
      {},
      {confirmed: false, expected_sha256: sha256(png)},
      {confirmed: true},
      {confirmed: true, expected_sha256: '0'.repeat(64)},
    ])
      assert.throws(() => sources.retain(owner, id, args));
    assert.throws(() => new MediaSources(store, false).retain(owner, id, confirmed()), {code: 'LIVE_WRITES_DISABLED'});
    store.bindActorCheck(owner, () => {
      throw Object.assign(new Error('fixture revoked'), {code: 'FIXTURE_REVOKED'});
    });
    assert.throws(() => sources.retain(owner, id, confirmed()), {code: 'FIXTURE_REVOKED'});
    assert.equal(count(store), 0);
    assert.equal(store.documents(operator.tenantId, 'retained_media_source').length, 0);
  } finally {
    store.close();
  }
});

test('a previous owner reduced to administrator cannot use owner-only controls through a stale actor snapshot', () => {
  const store = new Store(':memory:', key);
  try {
    const previous = member(store, 'owner');
    ownerAccess(store, previous, 'retain_media');
    store.db
      .prepare("UPDATE workspace_memberships SET role='admin' WHERE tenant_id=? AND user_id=?")
      .run(owner.tenantId, previous.ownerUserId);
    assert.throws(() => ownerAccess(store, previous, 'retain_media'), {code: 'OWNER_REQUIRED'});
  } finally {
    store.close();
  }
});

test('cleanup expires the original upload while the selected retained copy and thumbnail remain usable', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store),
      original = store.document(owner.tenantId, 'media_source', id);
    original.thumbnail = store.sealValue(owner.tenantId, 'media-thumbnail', id, {jpeg: png.toString('base64')});
    store.putDocument(owner.tenantId, 'media_source', id, original);
    const retained = sources.retain(owner, id, confirmed());
    store.putDocument(owner.tenantId, 'media_source', id, {...original, expires_at: Date.now() - 1});
    store.db
      .prepare('UPDATE media_staging SET expires_at=? WHERE tenant_id=? AND id=?')
      .run(Date.now() - 1, owner.tenantId, id);
    store.cleanupTransient();
    assert.throws(() => sources.file(operator, id), {code: 'MEDIA_SOURCE_NOT_FOUND'});
    assert.deepEqual(sources.file(operator, retained.source_id).bytes, png);
    assert.deepEqual(sources.thumbnail(operator, retained.source_id), png);
    assert.equal(sources.retain(owner, id, confirmed()).source_id, retained.source_id);
    assert.deepEqual(
      sources.list(operator).map(s => s.source_id),
      [retained.source_id],
    );
    assert.equal(sources.list(colleague).length, 0);
  } finally {
    store.close();
  }
});

function serviceFixture(store) {
  const requests = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (...args) => {
      requests.push(args);
      throw Error('No native egress in retained-original fixtures');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {service, requests};
}

test('retained originals keep existing creative receipt associations after the temporary source expires', async () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store),
      f = serviceFixture(store);
    store.putConnection(
      owner,
      {
        id: 'meta',
        tenantId: owner.tenantId,
        gateway: 'meta_native_action',
        accounts: ['100'],
        enabled: true,
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    store.putDocument(owner.tenantId, 'workspace_asset', 'receipt', {
      platform: 'meta',
      account_id: '100',
      connection_id: 'meta',
      media_id: 'synthetic-native-id',
      sha256: 'b'.repeat(64),
    });
    store.putDocument(owner.tenantId, 'media_review', 'receipt', {
      user_id: operator.userId,
      plan: {origin: {kind: 'upload', source_id: id}},
    });
    const before = await f.service.call('amcp_media', {action: 'asset', asset_id: 'receipt'}, operator);
    assert.equal(before.data.source.available, true);
    const retained = sources.retain(owner, id, confirmed());
    store.db.prepare('UPDATE media_staging SET expires_at=1 WHERE tenant_id=? AND id=?').run(owner.tenantId, id);
    store.putDocument(owner.tenantId, 'media_source', id, {
      ...store.document(owner.tenantId, 'media_source', id),
      expires_at: 1,
    });
    store.cleanupTransient();
    const result = await f.service.call('amcp_media', {action: 'asset', asset_id: 'receipt'}, operator);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.source.available, true);
    assert.equal(result.data.source.source_id, retained.source_id);
    assert.equal(result.data.source.original_sha256, sha256(png));
    assert.equal(result.data.source.expires_at, null);
    assert.equal(result.data.source.retained, true);
    assert.equal(result.data.uploaded_sha256, 'b'.repeat(64));
    assert.equal(f.requests.length, 0);
    sources.remove(owner, retained.source_id, confirmed());
    const gone = await f.service.call('amcp_media', {action: 'asset', asset_id: 'receipt'}, operator);
    assert.equal(gone.data.source.available, false);
    assert.equal(gone.data.uploaded_sha256, 'b'.repeat(64));
  } finally {
    store.close();
  }
});

test('copy authority loss rolls back every retained chunk and metadata record', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store);
    let active = true;
    store.bindActorCheck(owner, () => {
      if (!active) throw Object.assign(new Error('fixture revoked'), {code: 'ACCOUNT_ACCESS_REVOKED'});
    });
    const read = store.stagedMediaChunk.bind(store);
    store.stagedMediaChunk = (...args) => {
      const bytes = read(...args);
      active = false;
      return bytes;
    };
    assert.throws(() => sources.retain(owner, id, confirmed()), {code: 'ACCOUNT_ACCESS_REVOKED'});
    assert.equal(count(store), 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM retained_media_chunks').get().n, 0);
    assert.equal(store.documents(owner.tenantId, 'retained_media_source').length, 0);
  } finally {
    store.close();
  }
});

test('write pause prevents new retention and encrypted-size counter corruption cannot bypass file quotas', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store);
    store.putDocument(owner.tenantId, 'write_pause', 'workspace', {reason: 'fixture pause', paused_at: 1});
    assert.throws(() => sources.retain(owner, id, confirmed()), {code: 'WRITES_PAUSED'});
    assert.equal(count(store), 0);
    store.deleteDocument(owner.tenantId, 'write_pause', 'workspace');
    const retained = sources.retain(owner, id, confirmed());
    store.db
      .prepare('UPDATE retained_media SET size_bytes=0 WHERE tenant_id=? AND id=?')
      .run(owner.tenantId, retained.source_id);
    assert.throws(() => staged(store), {code: 'MEDIA_LIBRARY_INVALID'});
    assert.throws(() => sources.file(operator, retained.source_id), {code: 'MEDIA_LIBRARY_INVALID'});
    assert.equal(sources.remove(owner, retained.source_id, confirmed()).removed, true);
  } finally {
    store.close();
  }
});

test('retained-copy tampering or missing chunks is refused before media preparation', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store),
      retained = sources.retain(owner, id, confirmed());
    store.db.prepare('UPDATE retained_media_chunks SET secret=? WHERE tenant_id=? AND id=?').run(
      store.sealValue(owner.tenantId, 'retained-media-chunk', retained.source_id + '.0', {
        bytes: Buffer.from('different').toString('base64'),
      }),
      owner.tenantId,
      retained.source_id,
    );
    assert.throws(() => sources.file(operator, retained.source_id), {code: 'MEDIA_LIBRARY_INVALID'});
    assert.throws(() => sources.retain(owner, id, confirmed()), {code: 'MEDIA_LIBRARY_INVALID'});
    store.db
      .prepare('DELETE FROM retained_media_chunks WHERE tenant_id=? AND id=?')
      .run(owner.tenantId, retained.source_id);
    assert.throws(() => sources.file(operator, retained.source_id), {code: 'MEDIA_LIBRARY_INVALID'});
  } finally {
    store.close();
  }
});

test('real HTTP MCP SDK advertises and confirms retained sources, then refuses revoked access without egress', async () => {
  const store = new Store(':memory:', key),
    f = serviceFixture(store),
    id = staged(store);
  const token = store.createKey(owner),
    listener = await listenForFetch(createHttpApp(f.service, store));
  const client = new Client({name: 'retained-original-fixture', version: '1'});
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + listener.address().port + '/mcp'), {
        requestInit: {headers: {Authorization: 'Bearer ' + token}},
      }),
    );
    const advertised = (await client.listTools()).tools.find(tool => tool.name === 'amcp_media');
    assert.ok(advertised.inputSchema.properties.action.enum.includes('retain_source'));
    assert.ok(advertised.inputSchema.properties.action.enum.includes('remove_source'));
    const call = async args =>
      JSON.parse(
        (await client.callTool({name: 'amcp_media', arguments: args})).content.find(item => item.type === 'text').text,
      );
    const result = await call({action: 'retain_source', source_id: id, ...confirmed()});
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.sha256, sha256(png));
    assert.equal(result.data.expires_at, null);
    const list = await call({action: 'list'});
    assert.ok(list.data.sources.some(source => source.source_id === result.data.source_id && source.retained));
    const refused = await call({action: 'remove_source', source_id: result.data.source_id});
    assert.equal(refused.error.code, 'MEDIA_RETENTION_CONFIRMATION_REQUIRED');
    assert.equal(count(store), 1);
    store.revokeKey(token);
    await assert.rejects(
      client.callTool({name: 'amcp_media', arguments: {action: 'retain_source', source_id: id, ...confirmed()}}),
    );
    assert.equal(count(store), 1);
    assert.equal(f.requests.length, 0);
  } finally {
    await client.close();
    await new Promise(done => listener.close(done));
    store.close();
  }
});

test('website retention and permanent removal enforce session, origin, CSRF, selected hash and reviewer isolation', async () => {
  const store = new Store(':memory:', key),
    f = serviceFixture(store),
    password = 'synthetic-retained-owner-password';
  const origin = 'https://fixture.example',
    listener = await listenForFetch(
      createHttpApp(f.service, store, {
        website: {
          origin,
          masterKey: key,
          adminPassword: password,
          testPassword: 'synthetic-retained-reviewer-password',
          authEnv: {},
        },
      }),
    );
  const base = 'http://127.0.0.1:' + listener.address().port,
    id = staged(store, {tenantId: 'local', userId: 'fixture', role: 'admin'});
  try {
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({password}),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0],
      csrf = (await login.json()).csrf;
    const headers = {Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-AMCP-CSRF': csrf};
    const route = '/api/media/sources/' + id + '/retain';
    for (const override of [{Cookie: ''}, {Origin: 'https://foreign.example'}, {'X-AMCP-CSRF': 'wrong'}]) {
      const refused = await fetch(base + route, {
        method: 'POST',
        headers: {...headers, ...override},
        body: JSON.stringify(confirmed()),
      });
      assert.ok([401, 403].includes(refused.status));
      assert.equal(count(store), 0);
    }
    const retainedResponse = await fetch(base + route, {method: 'POST', headers, body: JSON.stringify(confirmed())});
    assert.equal(retainedResponse.status, 200, await retainedResponse.clone().text());
    const retained = await retainedResponse.json();
    const deleteRoute = base + '/api/media/sources/' + retained.source_id;
    assert.equal((await fetch(deleteRoute, {method: 'DELETE', headers})).status, 409);
    assert.equal(count(store), 1);
    const removed = await fetch(deleteRoute, {method: 'DELETE', headers, body: JSON.stringify(confirmed())});
    assert.equal(removed.status, 200);
    assert.equal(count(store), 0);
    const reviewer = await fetch(base + '/api/session/test', {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({password: 'synthetic-retained-reviewer-password'}),
    });
    assert.equal(reviewer.status, 200);
    const reviewerCookie = reviewer.headers.get('set-cookie').split(';')[0],
      reviewerCsrf = (await reviewer.json()).csrf;
    const denied = await fetch(base + route, {
      method: 'POST',
      headers: {...headers, Cookie: reviewerCookie, 'X-AMCP-CSRF': reviewerCsrf},
      body: JSON.stringify(confirmed()),
    });
    assert.equal(denied.status, 403);
    assert.equal(count(store), 0);
    assert.equal(f.requests.length, 0);
  } finally {
    await new Promise(done => listener.close(done));
    store.close();
  }
});

test('an encrypted backup restores selected retained bytes and provenance in a new disposable database', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-retained-backup-fixture-')),
    store = new Store(':memory:', key);
  let restored;
  try {
    const sources = new MediaSources(store, true),
      id = staged(store),
      retained = sources.retain(owner, id, confirmed());
    const file = path.join(dir, 'synthetic.amcp'),
      destination = path.join(dir, 'restored.sqlite');
    await createEncryptedBackup(store, file, key);
    await restoreEncryptedBackup(file, destination, key);
    restored = new Store(destination, key);
    const recovered = new MediaSources(restored, true);
    assert.deepEqual(recovered.file(operator, retained.source_id).bytes, png);
    assert.equal(recovered.list(operator).find(s => s.retained).retention.original_source_id, id);
    assert.equal(restored.verifyAudit(), true);
  } finally {
    restored?.close();
    store.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('amcp-retained-backup-fixture-'));
    await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 50});
  }
});

test('shared original-file byte and global count ceilings include encrypted retained reservations', () => {
  const accounted = (store, tenant, size) => {
    const id = 'lib-' + randomUUID();
    store.db
      .prepare('INSERT INTO retained_media VALUES(?,?,?,?)')
      .run(
        tenant,
        id,
        store.sealValue(tenant, 'retained-media-manifest', id, {size, chunks: 1, sha256: 'c'.repeat(64)}),
        size,
      );
  };
  const store = new Store(':memory:', key);
  try {
    // Synthetic encrypted accounting fixtures avoid allocating full-size binaries; this tests admission only.
    for (let i = 0; i < 3; i++) accounted(store, 'byte-bound', MAX_MEDIA_BYTES);
    store.reserveMediaSource('byte-bound', 'src-' + randomUUID(), Date.now() + 60000);
    assert.throws(() => store.reserveMediaSource('byte-bound', 'src-' + randomUUID(), Date.now() + 60000), {
      code: 'MEDIA_STAGING_FULL',
    });
    assert.throws(() => store.assertRetainedMediaCapacity('byte-bound', 1), {code: 'MEDIA_STAGING_FULL'});
    for (let i = 0; i < 47; i++) accounted(store, 'count-bound-' + i, 1);
    assert.throws(() => store.reserveMediaSource('other', 'src-' + randomUUID(), Date.now() + 60000), {
      code: 'MEDIA_STAGING_FULL',
    });
    assert.throws(() => store.assertRetainedMediaCapacity('other', 1), {code: 'MEDIA_STAGING_FULL'});
    store.reserveMedia('byte-bound', 'review-independent', Date.now() + 60000);
  } finally {
    store.close();
  }
});

test('unexpected source chunks or impossible archived manifests cannot establish a retained success', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store);
    const secret = store.db
      .prepare('SELECT secret FROM media_chunks WHERE tenant_id=? AND id=? AND chunk_index=0')
      .get(owner.tenantId, id).secret;
    store.db.prepare('INSERT INTO media_chunks VALUES(?,?,1,?)').run(owner.tenantId, id, secret);
    assert.throws(() => sources.retain(owner, id, confirmed()), {code: 'MEDIA_LIBRARY_INVALID'});
    assert.equal(count(store), 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM retained_media_chunks').get().n, 0);
    store.db.prepare('DELETE FROM media_chunks WHERE tenant_id=? AND id=? AND chunk_index=1').run(owner.tenantId, id);
    const retained = sources.retain(owner, id, confirmed());
    const invalid = store.sealValue(owner.tenantId, 'retained-media-manifest', retained.source_id, {
      size: png.length,
      chunks: 1000000,
      sha256: sha256(png),
    });
    store.db
      .prepare('UPDATE retained_media SET secret=? WHERE tenant_id=? AND id=?')
      .run(invalid, owner.tenantId, retained.source_id);
    assert.throws(() => sources.file(operator, retained.source_id), {code: 'MEDIA_LIBRARY_INVALID'});
  } finally {
    store.close();
  }
});

test('missing encrypted source chunks leave no retained bytes, metadata or successful retention audit', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store);
    store.db.prepare('DELETE FROM media_chunks WHERE tenant_id=? AND id=?').run(owner.tenantId, id);
    assert.throws(() => sources.retain(owner, id, confirmed()));
    assert.equal(count(store), 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM retained_media_chunks').get().n, 0);
    assert.equal(store.documents(owner.tenantId, 'retained_media_source').length, 0);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM audit WHERE event LIKE '%media_source_retained%'").get().n,
      0,
    );
  } finally {
    store.close();
  }
});

test('retained copies share the original-file count ceiling and keep review staging independent', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store);
    sources.retain(owner, id, confirmed());
    for (let i = 0; i < 23; i++) staged(store);
    assert.throws(() => staged(store), {code: 'MEDIA_STAGING_FULL'});
    assert.throws(
      () =>
        sources.retain(
          owner,
          sources.list(operator).find(s => !s.retained && s.source_id !== id).source_id,
          confirmed(),
        ),
      {code: 'MEDIA_STAGING_FULL'},
    );
    assert.equal(count(store), 1);
    store.reserveMedia(owner.tenantId, 'fixture-review', Date.now() + 60000);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM media_staging WHERE id='fixture-review'").get().n, 1);
  } finally {
    store.close();
  }
});

test('forgetting retained bytes requires owner and exact confirmation; frozen receipt metadata survives', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store),
      retained = sources.retain(owner, id, confirmed());
    store.putDocument(owner.tenantId, 'workspace_asset', 'fixture-receipt', {
      source_id: retained.source_id,
      sha256: retained.sha256,
    });
    assert.throws(() => sources.remove(operator, retained.source_id, confirmed()), {code: 'OWNER_REQUIRED'});
    for (const args of [undefined, {}, {confirmed: true, expected_sha256: 'f'.repeat(64)}])
      assert.throws(() => sources.remove(owner, retained.source_id, args));
    assert.equal(count(store), 1);
    assert.equal(sources.remove(owner, retained.source_id, confirmed()).removed, true);
    assert.equal(count(store), 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM retained_media_chunks').get().n, 0);
    assert.throws(() => sources.file(operator, retained.source_id), {code: 'MEDIA_SOURCE_NOT_FOUND'});
    assert.equal(store.document(owner.tenantId, 'workspace_asset', 'fixture-receipt').sha256, sha256(png));
    assert.deepEqual(sources.file(operator, id).bytes, png);
  } finally {
    store.close();
  }
});

test('retained source survives an actual store restart with exact bytes and current uploader access', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-retained-fixture-')),
    filename = path.join(dir, 'synthetic.sqlite');
  let store = new Store(filename, key);
  try {
    const sources = new MediaSources(store, true),
      id = staged(store),
      retained = sources.retain(owner, id, confirmed());
    store.close();
    store = new Store(filename, key);
    const reopened = new MediaSources(store, true);
    assert.deepEqual(reopened.file(operator, retained.source_id).bytes, png);
    assert.equal(reopened.list(operator).find(s => s.source_id === retained.source_id).retention.mode, 'until_removed');
    assert.throws(() => reopened.file(colleague, retained.source_id), {code: 'FORBIDDEN'});
  } finally {
    store.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('amcp-retained-fixture-'));
    await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 50});
  }
});
