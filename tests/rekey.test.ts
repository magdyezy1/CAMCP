// always-run: walks src/ and server/ for the sealed purposes the rekey lists must cover
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {Store} from '../src/store.js';
import {WebStore} from '../server/web-store.js';
import {SecretBox, masterKeys, scopeKey, sha256} from '../src/security.js';
import {
  jobActorPrefixes,
  rekeyStore,
  sealedColumnScopes,
  sealedDocumentScopes,
  sealedValuePurposes,
} from '../src/rekey.js';
import {createEncryptedBackup, restoreEncryptedBackup, verifyEncryptedBackup} from '../src/backup.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';
import {removeTestDirectory} from './temp.js';
import {runAdmin} from './admin-cli.js';

/**
 * SEC-07 S3: a master-key rotation. One key sealed everything with no way to change it, so a suspected key leak could
 * only be answered by reconnecting every provider. MIRROR_MASTER_KEY_PREVIOUS keeps the replaced key opening values,
 * new values are sealed with the new key, and `admin rekey` re-seals every stored value so the old key can go.
 */
const oldKey = Buffer.alloc(32, 11).toString('base64'),
  newKey = Buffer.alloc(32, 12).toString('base64'),
  tenant = 'rekey',
  actor: Actor = {tenantId: tenant, userId: 'operator', role: 'admin'},
  password = 'synthetic-rekey-admin-password',
  origin = 'http://localhost:4317',
  prefix = 'amcp-rekey-';
const connection = (id: string): Connection => ({
  id,
  tenantId: tenant,
  gateway: 'linkedin_native_action',
  accounts: ['1'],
  enabled: true,
  label: 'Synthetic',
  scopes: [],
});
const request = (cookie: string) => ({headers: {cookie}, socket: {}}) as unknown as Request;

/** Every kind of sealed value the application stores, written through its own APIs under `oldKey`. */
function populate(file: string) {
  const store = new Store(file, oldKey),
    web = new WebStore(store, {origin, masterKey: oldKey, adminPassword: password});
  const ids: JsonObject = {};
  try {
    store.ensureTenant(tenant);
    store.putConnection(actor, connection('modern'), {accessToken: 'modern-token', clientId: 'c', clientSecret: 's'});
    // A login sealed in the legacy delimiter format.
    store.putConnection(actor, connection('legacy'), {accessToken: 'placeholder'});
    store.db
      .prepare('UPDATE connections SET secret=? WHERE id=?')
      .run(new SecretBox(oldKey).seal({accessToken: 'legacy-token'}, tenant + '/legacy'), 'legacy');
    store.saveUploadSession(tenant, 'upload', {url: 'https://upload.invalid/session'}, Date.now() + 600000);
    store.savePreviewReceipt(tenant, 'preview', {url: 'https://preview.invalid/x'});
    store.saveXReportResult(tenant, 'xresult', {rows: [1]}, Date.now() + 600000);
    // Staged media in both chunk formats, and a declared upload reservation.
    store.reserveMedia(tenant, 'review-v2', Date.now() + 600000);
    store.stageMedia(tenant, 'review-v2', Buffer.from('v2 media bytes'));
    process.env.AMCP_MEDIA_CHUNK_FORMAT = 'v1';
    try {
      store.reserveMedia(tenant, 'review-v1', Date.now() + 600000);
      store.stageMedia(tenant, 'review-v1', Buffer.from('v1 media bytes'));
    } finally {
      delete process.env.AMCP_MEDIA_CHUNK_FORMAT;
    }
    ids.source = 'src-' + randomUUID();
    store.reserveMediaSource(tenant, ids.source, Date.now() + 600000, {bytes: 1024, member: 'operator'});
    // A cached fitted copy (MED-03 C): staged bytes and a sealed description in the reservation column.
    ids.fit = 'fit-' + ids.source + '-0123456789abcdef';
    store.stageFitCache(
      tenant,
      ids.fit,
      Date.now() + 600000,
      {sha256: sha256(Buffer.from('fitted'))},
      Buffer.from('fitted'),
    );
    // A retained original: its manifest and one chunk.
    store.db
      .prepare('INSERT INTO retained_media VALUES(?,?,?,?)')
      .run(tenant, 'kept', store.sealValue(tenant, 'retained-media-manifest', 'kept', {chunks: 1, size: 4}), 4);
    store.db
      .prepare('INSERT INTO retained_media_chunks VALUES(?,?,?,?)')
      .run(tenant, 'kept', 0, store.sealMediaChunk(tenant, 'retained-media-chunk', 'kept.0', Buffer.from('kept')));
    // Job-actor bindings under every prefix, in documents and in a job.
    ids.report = store.enqueueReport(actor, {query: 'synthetic'});
    ids.write = store.enqueue(tenant, 'write', {
      review_id: 'review-1',
      actor_binding: store.bindJobActor(actor, 'review-1'),
    });
    store.putDocument(tenant, 'overview_schedule', 'schedule', {actor_binding: store.bindJobActor(actor, 'schedule')});
    store.putDocument(tenant, 'reporting_schedule', 'workbook', {
      actor_binding: store.bindJobActor(actor, 'reporting-schedule:workbook'),
    });
    store.putDocument(tenant, 'report_monitor', 'watch', {actor_binding: store.bindJobActor(actor, 'monitor:watch')});
    store.putDocument(tenant, 'monitor_subscription', 'sub', {
      actor_binding: store.bindJobActor(actor, 'monitor-subscription:sub'),
    });
    store.putDocument(tenant, 'media_review', 'review-2', {
      actor_binding: store.bindJobActor(actor, 'media-job:review-2'),
    });
    // DEC-02: the background outcome review of an allocation plan.
    store.putDocument(tenant, 'allocation_outcome', 'plan-1', {
      actor_binding: store.bindJobActor(actor, 'allocation-outcome:plan-1'),
    });
    // Sealed values inside documents, including one nested in a list entry with its own id.
    store.putDocument(tenant, 'report_file', 'file', {
      sealed: store.sealValue(tenant, 'report-file', 'file', {bytes: 'UEs='}),
    });
    store.putDocument(tenant, 'website_connection', 'shop', {
      woocommerce_setup: {secret: store.sealValue(tenant, 'woocommerce-setup', 'shop', {fingerprint: 'f'})},
    });
    store.putDocument(tenant, 'media_source', 'library', {
      variants: [{id: 'thumb', thumbnail: store.sealValue(tenant, 'media-thumbnail', 'thumb', {jpeg: 'AA=='})}],
    });
    // Website tables: an AI-client secret, a two-step secret, an emailed link, a queued e-mail and an OAuth state.
    store.db
      .prepare('INSERT INTO amcp_mcp_clients VALUES(?,?)')
      .run(
        'client',
        JSON.stringify({client_id: 'client', encrypted_client_secret: web.sealClientSecret('client', 'cs')}),
      );
    store.db
      .prepare('INSERT INTO amcp_mfa VALUES(?,?,?,?,?)')
      .run('user-1', web.sealAccount('mfa:user-1', {secret: 'TOTP'}), '[]', -1, Date.now());
    store.db
      .prepare('INSERT INTO amcp_account_challenges VALUES(?,?,?,?)')
      .run('challenge', 'reset', web.sealAccount('challenge', {userId: 'user-1'}), Date.now() + 600000);
    store.db
      .prepare(
        "INSERT INTO amcp_email_outbox(id,tenant_id,secret,state,available_at,expires_at,created_at) VALUES(?,?,?,'queued',?,?,?)",
      )
      .run('mail-1', tenant, web.sealAccount('mail:mail-1', {to: 'a@example.test'}), 0, Date.now() + 600000, 0);
    const session = web.createSession({tenantId: 'local', userId: 'workspace-admin', role: 'admin'});
    ids.cookie = web.cookieName + '=' + session.id;
    ids.state = web.beginOAuth(session, 'linkedin', {verifier: 'v'});
    ids.session = session.id;
  } finally {
    store.close();
  }
  return ids;
}

/** Opens every value through the application's own readers; throws on the first that does not open. */
function readEverything(store: Store, web: WebStore, ids: JsonObject) {
  assert.equal(store.credentials(tenant, 'modern').accessToken, 'modern-token');
  assert.equal(store.credentials(tenant, 'legacy').accessToken, 'legacy-token');
  assert.equal(store.uploadSession(tenant, 'upload')?.url, 'https://upload.invalid/session');
  assert.equal(store.previewReceipt(tenant, 'preview')?.url, 'https://preview.invalid/x');
  assert.deepEqual(store.xReportResult(tenant, 'xresult')?.rows, [1]);
  assert.equal(store.stagedMedia(tenant, 'review-v2').toString(), 'v2 media bytes');
  assert.equal(store.stagedMedia(tenant, 'review-v1').toString(), 'v1 media bytes');
  const reservation = store.db
    .prepare('SELECT reservation FROM media_staging WHERE id=?')
    .get(ids.source) as JsonObject;
  assert.equal(
    store.keyring!.open<JsonObject>(reservation.reservation, scopeKey(tenant, 'media-reservation', ids.source)).bytes,
    1024,
  );
  // Regression (wave 2): the fit cache's sealed description was missing from the rekey lists, so after a rotation the
  // cached copy no longer opened with the new key alone.
  assert.equal(store.fitCache(tenant, ids.fit)?.metadata.size, 6);
  const manifest = store.db.prepare("SELECT secret FROM retained_media WHERE id='kept'").get() as JsonObject;
  assert.equal(store.openValue(tenant, 'retained-media-manifest', 'kept', manifest.secret).size, 4);
  const chunk = store.db.prepare("SELECT secret FROM retained_media_chunks WHERE id='kept'").get() as JsonObject;
  assert.equal(store.openMediaChunk(tenant, 'retained-media-chunk', 'kept.0', chunk.secret, 'X').toString(), 'kept');
  const job = (id: string) =>
    JSON.parse((store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id) as JsonObject).input) as JsonObject;
  assert.equal(
    store.restoreJobActor(tenant, 'job:' + ids.report, job(ids.report).authority.binding).userId,
    'operator',
  );
  assert.equal(store.restoreJobActor(tenant, 'review-1', job(ids.write).actor_binding).userId, 'operator');
  for (const [kind, id, scope] of [
    ['overview_schedule', 'schedule', 'schedule'],
    ['reporting_schedule', 'workbook', 'reporting-schedule:workbook'],
    ['report_monitor', 'watch', 'monitor:watch'],
    ['monitor_subscription', 'sub', 'monitor-subscription:sub'],
    ['media_review', 'review-2', 'media-job:review-2'],
    ['allocation_outcome', 'plan-1', 'allocation-outcome:plan-1'],
  ])
    assert.equal(
      store.restoreJobActor(tenant, scope!, store.document(tenant, kind!, id!).actor_binding).userId,
      'operator',
    );
  assert.equal(
    store.openValue(tenant, 'report-file', 'file', store.document(tenant, 'report_file', 'file').sealed).bytes,
    'UEs=',
  );
  assert.equal(
    store.openValue(
      tenant,
      'woocommerce-setup',
      'shop',
      store.document(tenant, 'website_connection', 'shop').woocommerce_setup.secret,
    ).fingerprint,
    'f',
  );
  const thumb = store.document(tenant, 'media_source', 'library').variants[0].thumbnail;
  assert.equal(store.openValue(tenant, 'media-thumbnail', 'thumb', thumb).jpeg, 'AA==');
  const client = JSON.parse(
    (store.db.prepare("SELECT data FROM amcp_mcp_clients WHERE id='client'").get() as JsonObject).data,
  );
  assert.equal(web.openClientSecret('client', client.encrypted_client_secret), 'cs');
  const secret = (table: string, column: string, id: string) =>
    (store.db.prepare('SELECT secret FROM ' + table + ' WHERE ' + column + '=?').get(id) as JsonObject).secret;
  assert.equal(web.openAccount('mfa:user-1', secret('amcp_mfa', 'user_id', 'user-1')).secret, 'TOTP');
  assert.equal(web.openAccount('challenge', secret('amcp_account_challenges', 'hash', 'challenge')).userId, 'user-1');
  assert.equal(web.openAccount('mail:mail-1', secret('amcp_email_outbox', 'id', 'mail-1')).to, 'a@example.test');
  const oauth = store.db.prepare('SELECT hash,secret FROM amcp_oauth_states').get() as JsonObject;
  assert.equal(store.keyring!.open<JsonObject>(oauth.secret, scopeKey('website-oauth', oauth.hash)).verifier, 'v');
}
const open = (file: string, current: string, previous: string[] = []) => {
  const store = new Store(file, current, previous);
  return {
    store,
    web: new WebStore(store, {origin, masterKey: current, previousMasterKeys: previous, adminPassword: password}),
  };
};

test('SEC-07 S3: after rekey every sealed value opens with the new key alone and no longer with the old one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    file = path.join(dir, 'live.sqlite');
  try {
    const ids = populate(file);
    // Rotation: the new key seals, the old one still opens; the website session survives the key change.
    let s = open(file, newKey, [oldKey]);
    assert.ok(s.web.session(request(String(ids.cookie))), 'a master-key rotation is not a password change');
    const pending = rekeyStore(s.store, {dryRun: true}) as JsonObject;
    assert.equal(pending.status, 'pending');
    assert.equal(pending.totals.current, 0);
    assert.equal(pending.totals.unreadable, 0);
    assert.ok(pending.totals.previous >= 27, JSON.stringify(pending.locations));
    const done = rekeyStore(s.store) as JsonObject;
    assert.equal(done.status, 'rekeyed', JSON.stringify(done.locations));
    assert.equal(done.totals.resealed, pending.totals.previous);
    assert.equal(done.totals.unreadable, 0);
    assert.equal((rekeyStore(s.store, {dryRun: true}) as JsonObject).status, 'complete');
    assert.equal(s.store.verifyAudit(), true);
    readEverything(s.store, s.web, ids);
    s.store.close();
    // The new key alone opens everything.
    s = open(file, newKey);
    readEverything(s.store, s.web, ids);
    s.store.close();
    // The old key alone opens nothing that was stored.
    const old = new Store(file, oldKey);
    try {
      assert.throws(() => old.credentials(tenant, 'modern'), {code: 'SECRET_DECRYPT_FAILED'});
      assert.throws(() => old.credentials(tenant, 'legacy'), {code: 'SECRET_DECRYPT_FAILED'});
      assert.throws(() => old.stagedMedia(tenant, 'review-v2'), {code: 'SECRET_DECRYPT_FAILED'});
      assert.throws(() => old.uploadSession(tenant, 'upload'), {code: 'SECRET_DECRYPT_FAILED'});
      const withOld = rekeyStore(old, {dryRun: true}) as JsonObject;
      assert.equal(withOld.totals.current, 0);
      assert.equal(withOld.totals.previous, 0);
      assert.equal(withOld.totals.unreadable, done.totals.current + done.totals.resealed);
    } finally {
      old.close();
    }
  } finally {
    removeTestDirectory(dir, prefix);
  }
});

test('SEC-07 S3: v1 backups still verify and restore after a rotation; v2 archives name their key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    file = path.join(dir, 'live.sqlite');
  try {
    populate(file);
    const store = new Store(file, oldKey),
      v1 = path.join(dir, 'old.v1.amcp'),
      v2 = path.join(dir, 'old.v2.amcp');
    try {
      await createEncryptedBackup(store, v1, oldKey, {tmpdir: dir, format: 'v1'});
      const receipt = await createEncryptedBackup(store, v2, oldKey, {tmpdir: dir});
      assert.equal(receipt.format, 'v2');
      assert.equal(fs.readFileSync(v1).subarray(0, 14).toString(), 'AMCP-BACKUP-1\n');
      assert.equal(fs.readFileSync(v2).subarray(0, 14).toString(), 'AMCP-BACKUP-2\n');
    } finally {
      store.close();
    }
    const ring = {current: newKey, previous: [oldKey]};
    for (const archive of [v1, v2]) {
      const verified = await verifyEncryptedBackup(archive, ring, dir);
      assert.equal(verified.status, 'verified');
      // The new key alone cannot open an archive the old key wrote.
      // v1 names no key, so the new key fails to decrypt it; v2 names the old key id, which the new key alone lacks.
      await assert.rejects(verifyEncryptedBackup(archive, newKey, dir), {
        code: archive === v1 ? 'BACKUP_DECRYPT_FAILED' : 'BACKUP_KEY_UNKNOWN',
      });
    }
    await assert.rejects(verifyEncryptedBackup(v2, newKey, dir), {code: 'BACKUP_KEY_UNKNOWN'});
    // A restored pre-rotation copy opens with the ring, and `rekey` moves it to the new key.
    const target = path.join(dir, 'restored.sqlite');
    await restoreEncryptedBackup(v1, target, ring, {preserveAccess: true});
    const restored = new Store(target, newKey, [oldKey]);
    try {
      assert.equal(restored.credentials(tenant, 'modern').accessToken, 'modern-token');
      assert.equal((rekeyStore(restored) as JsonObject).status, 'rekeyed');
    } finally {
      restored.close();
    }
    const after = new Store(target, newKey);
    try {
      assert.equal(after.credentials(tenant, 'modern').accessToken, 'modern-token');
    } finally {
      after.close();
    }
    // A v2 archive of the new key needs no previous key.
    const fresh = new Store(file, newKey, [oldKey]),
      archive = path.join(dir, 'new.amcp');
    try {
      assert.equal((rekeyStore(fresh) as JsonObject).status, 'rekeyed');
      await createEncryptedBackup(fresh, archive, masterKeys({current: newKey, previous: [oldKey]}), {tmpdir: dir});
    } finally {
      fresh.close();
    }
    assert.equal((await verifyEncryptedBackup(archive, newKey, dir)).status, 'verified');
  } finally {
    removeTestDirectory(dir, prefix);
  }
});

test('SEC-07 S3: the CLI rekey reports pending work with exit code 2, re-seals, and refuses a malformed previous key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    file = path.join(dir, 'live.sqlite');
  try {
    populate(file);
    const run = (args: string[], previous = oldKey) =>
      runAdmin(args, {
        env: {...process.env, MIRROR_DB: file, MIRROR_MASTER_KEY: newKey, MIRROR_MASTER_KEY_PREVIOUS: previous},
        timeout: 60000,
      });
    const dry = run(['rekey', '--dry-run']);
    assert.equal(dry.status, 2, dry.stderr);
    const report = JSON.parse(dry.stdout);
    assert.equal(report.status, 'pending');
    assert.equal(report.key_ids.previous.length, 1);
    assert.notEqual(report.key_ids.current, report.key_ids.previous[0]);
    assert.equal(JSON.stringify(report).includes(oldKey), false);
    const rekeyed = run(['rekey']);
    assert.equal(rekeyed.status, 0, rekeyed.stderr);
    assert.equal(JSON.parse(rekeyed.stdout).status, 'rekeyed');
    assert.equal(run(['rekey', '--dry-run']).status, 0);
    const bad = run(['rekey', '--dry-run'], 'not-a-key');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /MIRROR_MASTER_KEY_PREVIOUS/);
  } finally {
    removeTestDirectory(dir, prefix);
  }
});

test('SEC-07 S3: without the previous key a rotation reads as a door password change (the ring is what keeps sessions)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    file = path.join(dir, 'live.sqlite');
  try {
    const ids = populate(file),
      s = open(file, newKey);
    try {
      assert.equal(s.web.session(request(String(ids.cookie))), undefined);
      const events = (s.store.audit('local', 100) as {event: string}[]).map(e => JSON.parse(e.event).event);
      assert.ok(events.includes('administrator_password_changed'));
    } finally {
      s.store.close();
    }
  } finally {
    removeTestDirectory(dir, prefix);
  }
});

test('SEC-07 S3: the rekey lists cover every sealed purpose, job-actor prefix and scope kind the source uses', () => {
  const files = (dir: string): string[] =>
    fs
      .readdirSync(dir, {withFileTypes: true})
      .flatMap(e =>
        e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
      );
  const source = [...files('src'), ...files('server')].map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const found = (pattern: RegExp) => new Set([...source.matchAll(pattern)].map(m => m[1] ?? ''));
  // bindJobActor(<actor>, '<prefix>' + id) or bindJobActor(<actor>, <id>)
  for (const prefix of found(/bindJobActor\(\s*[\w.]+\s*,\s*(?:'([^']*)'\s*\+)?/g))
    assert.ok((jobActorPrefixes as readonly string[]).includes(prefix), 'job-actor prefix ' + prefix);
  for (const purpose of found(/(?:sealValue|sealMediaChunk)\(\s*[\w.]+\s*,\s*'([^']+)'/g))
    assert.ok((sealedValuePurposes as readonly string[]).includes(purpose), 'sealed purpose ' + purpose);
  const known = new Set<string>([
    ...sealedDocumentScopes,
    ...sealedColumnScopes,
    'sealed-value',
    'job-actor',
    // Not sealing: rate-limit and quota keys.
    'account-rate',
    'x-rate',
    // R2.5 M2 (package r25-m2-refusal, S3-1): the cooldown key of one bucket of a provider's rate limit, a Meta business use case
    // (src/transport.ts, scopedRateKey): a request counted in the bucket meets it and no other does. It seals nothing.
    'usage-scope',
    'tiktok-report-create',
    'x-report-processing',
    // RPT-06: the deployment-wide hourly admission of provider report and export jobs (src/provider-jobs.ts).
    'provider-job',
  ]);
  for (const kind of found(/scopeKey\(\s*[\w.!]+\s*,\s*'([a-z0-9-]+)'/g))
    assert.ok(known.has(kind), 'scope kind ' + kind);
  for (const kind of found(/scopeKey\(\s*'([a-z0-9-]+)'/g)) assert.ok(known.has(kind), 'scope kind ' + kind);
});
