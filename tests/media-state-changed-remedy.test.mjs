import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError} from '../dist/src/errors.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

/**
 * Round 2.5, package r25-m1-diff, lead review S2-2: the remedy of a STATE_CHANGED may say "Nothing was sent" only where
 * that is true. A media upload refused before anything was claimed sent nothing, and says so. A resume is refused after
 * a claim, with part of the upload already at the provider: it must send the agent to the upload's status and receipt, and
 * tell it never to send the upload again blindly. The two are told apart by what the refusal itself marks
 * (`submission: "not_sent"`), not by the shape of its fields. Every case runs the real media lifecycle against a
 * synthetic LinkedIn video transfer; nothing leaves the process.
 */
const size = 5 * 1024 * 1024,
  partSize = 4 * 1024 * 1024,
  owner = 'urn:li:organization:500',
  key = Buffer.alloc(32, 71).toString('base64'),
  connection = {
    id: 'login',
    tenantId: 't',
    gateway: 'linkedin_native_action',
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
    resourceBindings: [{accountId: '123', pathPrefix: '/rest/organizations/500'}],
  },
  actor = {tenantId: 't', userId: 'u', role: 'admin'};

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-media-state-changed-')),
    db = path.join(directory, 'test.sqlite'),
    bytes = Buffer.alloc(size),
    account = {name: 'Synthetic account'},
    parts = [];
  bytes.write('ftypisom', 4);
  let store,
    service,
    initialized = 0,
    finalized = 0,
    interrupt = 0;
  const transport = new NativeTransport(async (raw, init) => {
    const url = new URL(String(raw));
    if (url.pathname === '/rest/adAccounts/123') return Response.json({id: 123, ...account});
    if (url.hostname === 'www.linkedin.com') {
      parts.push(Number(url.pathname.split('/').at(-1)));
      return new Response(null, {status: 201, headers: {etag: '"private-part-' + parts.at(-1) + '"'}});
    }
    if (url.searchParams.get('action') === 'initializeUpload') {
      initialized++;
      return Response.json({
        value: {
          video: 'urn:li:video:456',
          uploadToken: 'private-upload-token',
          uploadUrlsExpireAt: Date.now() + 60000,
          uploadInstructions: [
            {firstByte: 0, lastByte: partSize - 1, uploadUrl: 'https://www.linkedin.com/dms-uploads/456/1?signature=a'},
            {
              firstByte: partSize,
              lastByte: size - 1,
              uploadUrl: 'https://www.linkedin.com/dms-uploads/456/2?signature=b',
            },
          ],
        },
      });
    }
    if (url.searchParams.get('action') === 'finalizeUpload') {
      finalized++;
      return new Response(null, {status: 200});
    }
    if (url.pathname.startsWith('/rest/videos/'))
      return Response.json({
        id: 'urn:li:video:456',
        owner,
        status: finalized ? 'AVAILABLE' : 'WAITING_UPLOAD',
        mediaLibraryMetadata: {associatedAccount: 'urn:li:sponsoredAccount:123'},
      });
    assert.fail('Unexpected synthetic route ' + url.pathname);
  });
  function open(initial = false) {
    store = new Store(db, key);
    if (initial) store.putConnection(actor, connection, {accessToken: 'synthetic'});
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
  const call = args => service.call('amcp_media', args, actor);
  return {
    account,
    call,
    counts: () => ({initialized, parts: [...parts], finalized}),
    interruptAfter: n => (interrupt = n),
    restart: () => {
      store.close();
      open();
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
      removeTestDirectory(fs.realpathSync(directory), 'amcp-media-state-changed-');
    },
  };
}
const execution = (p, action = 'execute') => ({
  action,
  review_id: p.data.review_id,
  idempotency_key: p.data.review_id,
  confirmed: true,
});
const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));

test('a media upload refused before anything was claimed marks it as not sent, and its remedy says nothing was sent', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    f.account.name = 'Renamed account';
    const refused = await f.call(execution(p));
    assert.equal(refused.error.code, 'STATE_CHANGED', JSON.stringify(refused.error));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.match(refused.error.remedy.action, /^Nothing was sent\./);
    assert.deepEqual(f.counts(), {initialized: 0, parts: [], finalized: 0}, 'nothing reached the provider');
  } finally {
    f.close();
  }
});

test('a resume refused as STATE_CHANGED after a claim never says nothing was sent: it names the status and the receipt', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    f.interruptAfter(1);
    assert.equal((await f.call(execution(p))).error.code, 'SYNTHETIC_INTERRUPTION');
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0}, 'part of the upload is at the provider');
    f.restart();
    f.account.name = 'Renamed account';
    const refused = await f.call(execution(p, 'resume'));
    assert.equal(refused.error.code, 'STATE_CHANGED', JSON.stringify(refused.error));
    assert.deepEqual(f.counts(), {initialized: 1, parts: [1], finalized: 0}, 'the refusal sent nothing more');
    // What it carries is what it always carried, and it is not marked as a refusal that sent nothing.
    assert.equal(refused.error.details.submission, undefined);
    assert.ok(refused.error.details.changed_fields.length > 0);
    assert.ok(refused.error.details.material.length > 0);
    // The agent is sent to the upload's recovery record (its claim, journal and progress), which reads without writing.
    assert.deepEqual(refused.error.details.next_call, {
      tool: 'amcp_media',
      arguments: {action: 'recovery', review_id: p.data.review_id},
    });
    for (const [what, text] of [
      ['remedy.action', refused.error.remedy.action],
      ['next_action', refused.error.next_action],
    ]) {
      assert.doesNotMatch(text, /Nothing was sent/i, what);
      assert.match(text, /may (?:already )?have been sent/i, what);
      assert.match(text, /status or receipt/i, what);
      assert.match(text, /never send it again blindly/i, what);
      assert.match(text, /No flag skips this check/, what);
      assert.match(text, /details\.next_call/, what);
    }
    assert.equal(refused.error.remedy.category, 'state');
    assert.equal(refused.error.remedy.mutation_retry_safe, false);
    // The call it names reads the upload without sending anything: the claim it holds, and the one part that was sent.
    const recovery = await f.call(refused.error.details.next_call.arguments);
    assert.equal(recovery.success, true, JSON.stringify(recovery));
    assert.equal(recovery.data.progress.parts_confirmed, 1);
    assert.ok(['pending', 'uncertain'].includes(recovery.data.state), recovery.data.state);
    assert.deepEqual(
      f.counts(),
      {initialized: 1, parts: [1], finalized: 0},
      'reading the recovery record sent nothing',
    );
  } finally {
    f.close();
  }
});

test('the remedy of a refusal after a claim is in Arabic, with the names of the fields and of the call kept', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    f.interruptAfter(1);
    await f.call(execution(p));
    f.restart();
    f.account.name = 'Renamed account';
    const refused = await f.call(execution(p, 'resume'));
    assert.equal(refused.error.code, 'STATE_CHANGED');
    for (const english of new Set([refused.error.remedy.action, refused.error.next_action])) {
      assert.doesNotMatch(english, /Nothing was sent/i, 'the words of a refusal that sent nothing');
      const arabic = catalog[english];
      assert.equal(typeof arabic, 'string', 'no Arabic for: ' + english);
      assert.match(arabic, /[؀-ۿ]/u);
      for (const name of ['details.next_call', 'details.material'])
        assert.ok(arabic.includes(name), name + ' in: ' + arabic);
    }
  } finally {
    f.close();
  }
});
