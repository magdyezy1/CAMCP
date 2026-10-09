import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError} from '../dist/src/errors.js';
import {errorRemedy} from '../dist/src/errors.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const size = 5 * 1024 * 1024,
  partSize = 4 * 1024 * 1024,
  owner = 'urn:li:organization:500',
  key = Buffer.alloc(32, 68).toString('base64');
const connection = {
  id: 'login',
  tenantId: 't',
  gateway: 'linkedin_native_action',
  accounts: ['123'],
  writeAccounts: ['123'],
  enabled: true,
  label: 'Synthetic',
  scopes: [],
  resourceBindings: [{accountId: '123', pathPrefix: '/rest/organizations/500'}],
};
const actor = {tenantId: 't', userId: 'u', role: 'admin'},
  credentials = {accessToken: 'synthetic'};
function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-linkedin-resume-')),
    db = path.join(directory, 'test.sqlite');
  let store,
    service,
    initialized = 0,
    finalized = 0,
    interrupt = options.interrupt ?? 1,
    lost = options.lost ?? false;
  const parts = [],
    bytes = Buffer.alloc(size);
  bytes.write('ftypisom', 4);
  const transport = new NativeTransport(async (raw, init) => {
    const url = new URL(String(raw));
    if (url.pathname === '/rest/adAccounts/123') return Response.json({id: 123, name: 'Synthetic account'});
    if (url.hostname === 'www.linkedin.com') {
      const part = Number(url.pathname.split('/').at(-1));
      parts.push(part);
      assert.equal(new Headers(init.headers).has('authorization'), false);
      assert.deepEqual(Buffer.from(init.body), bytes.subarray((part - 1) * partSize, Math.min(part * partSize, size)));
      await options.beforePartResponse?.({store, part});
      if (lost) {
        lost = false;
        throw Error('Synthetic lost part acknowledgement');
      }
      return new Response(null, {status: 201, headers: options.noEtag ? {} : {etag: '"private-part-' + part + '"'}});
    }
    if (url.searchParams.get('action') === 'initializeUpload') {
      initialized++;
      return Response.json({
        value: {
          video: 'urn:li:video:456',
          uploadToken: 'private-upload-token',
          uploadUrlsExpireAt: Date.now() + 60000,
          uploadInstructions: [
            {
              firstByte: 0,
              lastByte: partSize - 1,
              uploadUrl: 'https://www.linkedin.com/dms-uploads/456/1?signature=private-one',
            },
            {
              firstByte: partSize,
              lastByte: size - 1,
              uploadUrl: 'https://www.linkedin.com/dms-uploads/456/2?signature=private-two',
            },
          ],
        },
      });
    }
    if (url.searchParams.get('action') === 'finalizeUpload') {
      finalized++;
      assert.deepEqual(JSON.parse(init.body).finalizeUploadRequest, {
        video: 'urn:li:video:456',
        uploadToken: 'private-upload-token',
        uploadedPartIds: ['private-part-1', 'private-part-2'],
      });
      if (options.lostFinalize) throw Error('Synthetic lost finalize acknowledgement');
      return new Response(null, {status: 200});
    }
    if (url.pathname.startsWith('/rest/videos/')) {
      await options.beforeVideoState?.({store});
      return Response.json({
        ...{
          id: 'urn:li:video:456',
          owner,
          status: finalized ? 'AVAILABLE' : 'WAITING_UPLOAD',
          mediaLibraryMetadata: {associatedAccount: 'urn:li:sponsoredAccount:123'},
        },
        ...options.videoState,
      });
    }
    assert.fail('Unexpected synthetic route ' + url.pathname);
  });
  function open(initial = false) {
    store = new Store(db, key);
    if (initial) store.putConnection(actor, connection, credentials);
    const save = store.saveUploadSession.bind(store);
    store.saveUploadSession = (tenant, id, value, expiry) => {
      save(tenant, id, value, expiry);
      if (interrupt && value.uploaded_part_ids?.length === interrupt) {
        interrupt = 0;
        throw new MirrorError('SYNTHETIC_INTERRUPTION', 'Synthetic process interruption after durable receipt.');
      }
    };
    service = new MirrorService(
      new Registry(),
      store,
      transport,
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
      async () => new Response(bytes),
    );
  }
  open(true);
  const call = (args, who = actor) => service.call('amcp_media', args, who);
  return {
    get store() {
      return store;
    },
    call,
    counts: () => ({initialized, parts: [...parts], finalized}),
    restart: () => {
      store.close();
      open();
    },
    crash: reviewId => {
      store.close();
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/linkedin-resume-crash.mjs', import.meta.url)), db, reviewId],
        {encoding: 'utf8', timeout: 20000, windowsHide: true},
      );
      open();
      return result;
    },
    prepare: () =>
      call({
        action: 'prepare',
        platform: 'linkedin',
        account_id: '123',
        connection_id: 'login',
        drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view',
        owner_urn: owner,
      }),
    close: () => {
      store.close();
      const resolved = fs.realpathSync(directory);
      assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
      assert.equal(path.basename(resolved), path.basename(directory));
      assert.match(path.basename(resolved), /^amcp-linkedin-resume-/);
      assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
      removeTestDirectory(resolved, 'amcp-linkedin-resume-');
    },
  };
}
const execution = (p, action = 'execute') => ({
  action,
  review_id: p.data.review_id,
  idempotency_key: p.data.review_id,
  confirmed: true,
});

test('LinkedIn resumes only the unsubmitted part after a durable receipt and SQLite reopen', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    const first = await f.call(execution(p));
    assert.equal(first.error.code, 'SYNTHETIC_INTERRUPTION');
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0});
    f.restart();
    const recovery = await f.call({action: 'recovery', review_id: p.data.review_id});
    assert.equal(recovery.data.resume_available, true, JSON.stringify(recovery));
    const result = await f.call(execution(p, 'resume'));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.ready, true);
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1, 2], finalized: 1});
    assert.equal((await f.call(execution(p, 'resume'))).data.replayed, true);
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1, 2], finalized: 1});
  } finally {
    f.close();
  }
});

test('LinkedIn persists the in-flight part before egress and refuses a lost acknowledgement on resume', async () => {
  const f = fixture({lost: true, interrupt: 0});
  try {
    const p = await f.prepare(),
      first = await f.call(execution(p));
    assert.equal(first.error.code, 'WRITE_OUTCOME_UNCERTAIN');
    const session = f.store.uploadSession('t', p.data.review_id);
    assert.equal(session.part_in_flight, 0);
    assert.deepEqual(session.uploaded_part_ids, []);
    f.restart();
    const result = await f.call(execution(p, 'resume'));
    assert.equal(result.error.code, 'RECOVERY_NOT_SAFE');
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0});
  } finally {
    f.close();
  }
});

test('LinkedIn resumes finalization once when every part has a durable receipt', async () => {
  const f = fixture({interrupt: 2});
  try {
    const p = await f.prepare();
    assert.equal((await f.call(execution(p))).error.code, 'SYNTHETIC_INTERRUPTION');
    f.restart();
    const result = await f.call(execution(p, 'resume'));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1, 2], finalized: 1});
  } finally {
    f.close();
  }
});

for (const mode of ['missing_etag', 'lost_finalize'])
  test('LinkedIn cannot resume ' + mode + ' by allocating or submitting again', async () => {
    const f = fixture({interrupt: 0, noEtag: mode === 'missing_etag', lostFinalize: mode === 'lost_finalize'});
    try {
      const p = await f.prepare(),
        first = await f.call(execution(p));
      assert.equal(first.success, false, JSON.stringify(first));
      const counts = f.counts();
      f.restart();
      const recovery = await f.call({action: 'recovery', review_id: p.data.review_id});
      assert.equal(recovery.data.resume_available, false);
      const result = await f.call(execution(p, 'resume'));
      assert.equal(result.error.code, 'RECOVERY_NOT_SAFE');
      assert.deepEqual(f.counts(), counts);
    } finally {
      f.close();
    }
  });

for (const state of [
  {status: 'PROCESSING'},
  {status: 'AVAILABLE'},
  {status: 'PROCESSING_FAILED'},
  {status: null},
  {id: 'urn:li:video:foreign'},
  {owner: 'urn:li:organization:999'},
  {mediaLibraryMetadata: {associatedAccount: 'urn:li:sponsoredAccount:999'}},
])
  test('LinkedIn resume validates current exact media before egress: ' + JSON.stringify(state), async () => {
    const f = fixture({videoState: state});
    try {
      const p = await f.prepare();
      await f.call(execution(p));
      f.restart();
      const result = await f.call(execution(p, 'resume'));
      assert.equal(result.success, false, JSON.stringify(result));
      assert.ok(['RECOVERY_NOT_SAFE', 'MEDIA_RESPONSE_INVALID'].includes(result.error.code));
      assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0});
    } finally {
      f.close();
    }
  });

for (const [name, edit] of [
  ['legacy receipt', s => delete s.version],
  ['unknown PUT marker', s => delete s.part_in_flight],
  ['pending PUT', s => (s.part_in_flight = 1)],
  ['finalization attempted', s => (s.finalization_started = true)],
  ['expired URL', s => (s.upload_urls_expire_at = Date.now() - 1)],
  ['unknown expiry', s => delete s.upload_urls_expire_at],
  ['wrong request', s => (s.request_binding = 'foreign')],
  ['wrong owner', s => (s.owner_urn = 'urn:li:organization:999')],
  ['part count', s => (s.uploaded_part_ids = ['one', 'two', 'three'])],
  ['invalid receipt', s => (s.uploaded_part_ids = [''])],
  ['hostile URL', s => (s.upload_instructions[1].uploadUrl = 'https://attacker.invalid/part')],
  ['byte gap', s => s.upload_instructions[1].firstByte++],
  ['malformed token', s => (s.upload_token = {})],
])
  test('LinkedIn resume refuses ' + name + ' in retained session', async () => {
    const f = fixture();
    try {
      const p = await f.prepare();
      await f.call(execution(p));
      const session = f.store.uploadSession('t', p.data.review_id);
      edit(session);
      f.store.saveUploadSession('t', p.data.review_id, session, Date.now() + 60000);
      const result = await f.call(execution(p, 'resume'));
      assert.equal(result.error.code, 'RECOVERY_NOT_SAFE', JSON.stringify(result));
      assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0});
    } finally {
      f.close();
    }
  });

for (const mode of ['login', 'account', 'organization', 'actor', 'tenant', 'expired_review'])
  test('LinkedIn resume preserves ' + mode + ' authority and review boundaries', async () => {
    const f = fixture();
    try {
      const p = await f.prepare();
      await f.call(execution(p));
      if (mode === 'login') f.store.putConnection(actor, connection, {accessToken: 'replacement'});
      if (mode === 'account') f.store.putConnection(actor, {...connection, writeAccounts: []}, credentials);
      if (mode === 'organization') f.store.putConnection(actor, {...connection, resourceBindings: []}, credentials);
      if (mode === 'expired_review') {
        // Since MED-01 Stage D a resume continues within the transfer window set at the claim, not the five-minute
        // review: the boundary is that window.
        const r = f.store.document('t', 'media_review', p.data.review_id);
        f.store.putDocument('t', 'media_review', p.data.review_id, {
          ...r,
          expires_at: Date.now() - 1,
          transfer_expires_at: Date.now() - 1,
        });
      }
      const who =
        mode === 'actor' ? {...actor, userId: 'other'} : mode === 'tenant' ? {...actor, tenantId: 'other'} : actor;
      const result = await f.call(execution(p, 'resume'), who);
      assert.equal(result.success, false, JSON.stringify(result));
      assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0});
    } finally {
      f.close();
    }
  });

test('LinkedIn frozen bytes are rechecked instead of trusting saved part receipts', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    await f.call(execution(p));
    const bytes = f.store.stagedMedia('t', p.data.review_id);
    bytes[100] = 1;
    f.store.stageMedia('t', p.data.review_id, bytes);
    const result = await f.call(execution(p, 'resume'));
    assert.equal(result.error.code, 'REVIEW_CHANGED');
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0});
  } finally {
    f.close();
  }
});

test('LinkedIn concurrent resumes share the existing durable media lock', async () => {
  const prior = process.env.AMCP_MEDIA_MEMORY_MB;
  process.env.AMCP_MEDIA_MEMORY_MB = '2048';
  let release, started;
  const gate = new Promise(resolve => (release = resolve)),
    entered = new Promise(resolve => (started = resolve));
  let first;
  const f = fixture({
    beforePartResponse: async ({part}) => {
      if (part === 2) {
        started();
        await gate;
      }
    },
  });
  try {
    const p = await f.prepare();
    await f.call(execution(p));
    first = f.call(execution(p, 'resume'));
    await entered;
    const second = await f.call(execution(p, 'resume'));
    assert.equal(second.error.code, 'MEDIA_UPLOAD_BUSY');
    release();
    assert.equal((await first).success, true);
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1, 2], finalized: 1});
  } finally {
    release();
    if (first) await first;
    f.close();
    if (prior === undefined) delete process.env.AMCP_MEDIA_MEMORY_MB;
    else process.env.AMCP_MEDIA_MEMORY_MB = prior;
  }
});

test('LinkedIn resume refuses a lost recorded OAuth scope even with unchanged credentials', async () => {
  const f = fixture();
  try {
    f.store.putConnection(actor, {...connection, scopes: ['rw_ads']}, credentials);
    const p = await f.prepare();
    await f.call(execution(p));
    f.store.putConnection(actor, connection, credentials);
    const result = await f.call(execution(p, 'resume'));
    assert.equal(result.error.code, 'RECOVERY_NOT_SAFE');
    assert.equal(result.error.details.reason, 'login_changed');
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0});
  } finally {
    f.close();
  }
});

test('LinkedIn resume rechecks login after the fallible waiting-state read', async () => {
  const f = fixture({
    beforeVideoState: ({store}) => store.putConnection(actor, connection, {accessToken: 'replacement'}),
  });
  try {
    const p = await f.prepare();
    await f.call(execution(p));
    const result = await f.call(execution(p, 'resume'));
    assert.equal(result.error.code, 'REAUTHORIZATION_REQUIRED');
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0});
  } finally {
    f.close();
  }
});

test('LinkedIn recovery exposes counts and safe reasons without signed URLs, tokens or ETags', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    await f.call(execution(p));
    const recovery = await f.call({action: 'recovery', review_id: p.data.review_id});
    assert.equal(recovery.data.progress.parts_confirmed, 1);
    assert.equal(recovery.data.progress.bytes_confirmed, partSize);
    assert.equal(JSON.stringify(recovery).includes('private-'), false);
    assert.equal(JSON.stringify(recovery).includes('signature='), false);
    assert.equal(JSON.stringify(recovery).includes('login_fingerprint'), false);
    const raw = f.store.db
      .prepare("SELECT data FROM documents WHERE tenant_id='t' AND kind='upload_session' AND id=?")
      .get(p.data.review_id).data;
    assert.equal(raw.includes('private-'), false);
  } finally {
    f.close();
  }
});

test('LinkedIn resumes after a real process exit once its short lease expires within the original review', async () => {
  const f = fixture({interrupt: 0}),
    now = Date.now;
  try {
    const p = await f.prepare(),
      crashed = f.crash(p.data.review_id);
    assert.equal(crashed.status, 73, crashed.stderr);
    assert.equal(
      f.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get('t', p.data.review_id).state,
      'pending',
    );
    // The crashed process still holds its execution lease. Since MED-02 admission reserves for the file's size, its
    // small media reservation no longer refuses everything (MEDIA_MEMORY_BUSY): the review's own lease refuses instead.
    const first = await f.call(execution(p, 'resume'));
    assert.equal(first.error.code, 'MEDIA_UPLOAD_BUSY');
    assert.deepEqual(f.counts(), {initialized: 0, parts: [], finalized: 0}, 'the refused resume sent nothing');
    const instant = now();
    Date.now = () => instant + 46000;
    const result = await f.call(execution(p, 'resume'));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(f.counts(), {initialized: 0, parts: [2], finalized: 1});
  } finally {
    Date.now = now;
    f.close();
  }
});

for (const mode of ['lock_replaced', 'lock_expired', 'admission_lost', 'clock_backwards'])
  test('LinkedIn stops at the next boundary after ' + mode + ' and retains the accepted ETag', async () => {
    const now = Date.now,
      f = fixture({
        interrupt: 0,
        beforePartResponse: ({store, part}) => {
          if (part !== 1) return;
          if (mode === 'lock_replaced')
            store.db.prepare("UPDATE service_locks SET owner='new-worker' WHERE key LIKE 'media-execution:%'").run();
          if (mode === 'lock_expired')
            store.db.prepare("UPDATE service_locks SET expires_at=0 WHERE key LIKE 'media-execution:%'").run();
          if (mode === 'admission_lost') store.db.prepare('DELETE FROM media_admissions').run();
          if (mode === 'clock_backwards') {
            const instant = now();
            Date.now = () => instant - 1000;
          }
        },
      });
    try {
      const p = await f.prepare(),
        result = await f.call(execution(p));
      assert.equal(
        result.error.code,
        mode.startsWith('lock_') ? 'MEDIA_UPLOAD_LEASE_LOST' : 'MEDIA_ADMISSION_LOST',
        JSON.stringify(result),
      );
      assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0});
      assert.deepEqual(f.store.uploadSession('t', p.data.review_id).uploaded_part_ids, ['private-part-1']);
      assert.equal(f.store.uploadSession('t', p.data.review_id).part_in_flight, null);
    } finally {
      Date.now = now;
      f.close();
    }
  });

test('media leases renew conditionally and cannot resurrect after another holder takes over', () => {
  const store = new Store(':memory:', key),
    now = Date.now;
  let instant = now();
  Date.now = () => instant;
  try {
    const lease = store.mediaAdmission('one');
    assert.equal(store.db.prepare('SELECT expires_at FROM media_admissions').get().expires_at, instant + 45000);
    instant += 40000;
    lease.check();
    assert.equal(store.db.prepare('SELECT expires_at FROM media_admissions').get().expires_at, instant + 45000);
    instant += 10000;
    assert.throws(
      () => store.mediaAdmission('two'),
      e => e.code === 'MEDIA_MEMORY_BUSY',
    );
    instant += 36000;
    const replacement = store.mediaAdmission('two');
    assert.throws(
      () => lease.check(),
      e => e.code === 'MEDIA_ADMISSION_LOST',
    );
    lease.release();
    assert.equal(store.db.prepare('SELECT tenant_id FROM media_admissions').get().tenant_id, 'two');
    replacement.release();
    assert.equal(store.acquireLock('media-test', 'one', 45000), true);
    instant += 40000;
    assert.equal(store.renewLock('media-test', 'one', 45000), true);
    instant += 45001;
    assert.equal(store.renewLock('media-test', 'one', 45000), false);
    assert.equal(store.acquireLock('media-test', 'two', 45000), true);
    assert.equal(store.renewLock('media-test', 'one', 45000), false);
    store.releaseLock('media-test', 'one');
    assert.equal(store.db.prepare("SELECT owner FROM service_locks WHERE key='media-test'").get().owner, 'two');
  } finally {
    Date.now = now;
    store.close();
  }
});

test('media recovery errors keep the original operation and do not suggest a replacement', () => {
  for (const code of [
    'MEDIA_MEMORY_BUSY',
    'MEDIA_UPLOAD_BUSY',
    'MEDIA_ADMISSION_LOST',
    'MEDIA_UPLOAD_LEASE_LOST',
    'RECOVERY_NOT_SAFE',
    'MEDIA_UPLOAD_URL_EXPIRED',
  ]) {
    const remedy = errorRemedy(new MirrorError(code, 'Synthetic'));
    assert.equal(remedy.mutation_retry_safe, false);
    assert.match(remedy.action, /original review/);
    assert.match(remedy.action, /recover/);
  }
  assert.doesNotMatch(
    errorRemedy(new MirrorError('PROVIDER_ACTION_UNSUPPORTED', 'Synthetic')).action,
    /withdrawn|retired/,
  );
});
