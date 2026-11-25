import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import * as wire from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const {NativeTransport} = wire;

// r25-mf-jobs item 7: every request had the transport's 30 s limit, which a 128 MiB video can only meet at 4.3 MiB/s; the
// abort cut the upload off and left the file uncertain. A reviewed upload now gets the time its body needs at the media
// layer's own throughput floor (1 MiB/s, src/media-upload.ts), never less than the transport's limit and never more than
// ten minutes. Every other request keeps the limit, and the abort still cancels the upload. Synthetic fetchers only.
const MiB = 1024 * 1024;
const plan = {
  gateway: 'meta_native_action',
  action: 'AMCP_REVIEWED_MEDIA',
  method: 'POST',
  path: '/v26.0/act_123/advideos',
  query: {},
  headers: {},
  body: {title: 'Synthetic video'},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
};
const connection = {
  id: 'c',
  tenantId: 't',
  gateway: 'meta_native_action',
  accounts: ['123'],
  writeAccounts: ['123'],
  label: 'test',
  enabled: true,
  scopes: [],
};
const upload = bytes => ({field: 'source', bytes: Buffer.alloc(bytes), filename: 'v.mp4', mime: 'video/mp4'});

/** The limits every request of `send` asked AbortSignal.timeout for. */
async function limitsOf(send, ...constructor) {
  const asked = [],
    real = AbortSignal.timeout.bind(AbortSignal),
    timer = mock.method(AbortSignal, 'timeout', ms => (asked.push(ms), real(ms)));
  try {
    await send(
      new NativeTransport(
        async () => Response.json({id: '1'}),
        async () => {},
        ...constructor,
      ),
    );
  } finally {
    timer.mock.restore();
  }
  return asked;
}
const request = (body, file) => transport => transport.request({...plan, body}, connection, {accessToken: 't'}, file);

test('an upload gets the time its body needs at the media layer’s throughput floor', async () => {
  const [big] = await limitsOf(request({title: 'v'}, upload(128 * MiB)));
  assert.ok(big >= 128000, '128 MiB at 1 MiB/s needs 128 s, and the limit was ' + big + ' ms');
  assert.ok(big <= 600000, 'and it is bounded: ' + big + ' ms');
  const [mid] = await limitsOf(request({title: 'v'}, upload(64 * MiB)));
  assert.ok(mid >= 64000 && mid < big, 'it grows with the body: ' + mid + ' ms for 64 MiB');
});

test('a small upload, and every request that is not an upload, keeps the transport’s limit', async () => {
  assert.deepEqual(await limitsOf(request({title: 'v'}, upload(MiB))), [30000], 'a 1 MiB upload');
  assert.deepEqual(await limitsOf(request({title: 'v'}, upload(0))), [30000], 'an upload of fields only');
  // A big JSON body is not an upload, whatever its size.
  assert.deepEqual(await limitsOf(request({title: 'x'.repeat(8 * MiB)}, undefined)), [30000]);
  // A read.
  assert.deepEqual(
    await limitsOf(t =>
      t.request({...plan, method: 'GET', readOnly: true, body: undefined}, connection, {accessToken: 't'}),
    ),
    [30000],
  );
  // The transport's own limit is the floor, whatever it is set to.
  assert.deepEqual(await limitsOf(request({title: 'v'}, upload(MiB)), 45000), [45000]);
  assert.deepEqual(await limitsOf(request({title: 'x'}, undefined), 45000), [45000]);
});

test('the limit of an upload is bounded at ten minutes, and never below the transport’s', () => {
  const limit = (...args) => wire.uploadTimeoutMs(...args);
  assert.equal(limit(30000, 0), 30000);
  assert.equal(limit(30000, 128 * MiB), 128000);
  assert.equal(limit(30000, 1024 * MiB), 600000, 'a body of 1 GiB would need 17 minutes: the limit is ten');
  assert.equal(limit(30000, 5e12), 600000);
  assert.equal(limit(900000, 128 * MiB), 900000, 'a transport set above the bound keeps its own limit');
});

test('the abort still cancels an upload: a limit that fires ends it as an uncertain write, and a refusal is unchanged', async () => {
  const controller = new AbortController(),
    timer = mock.method(AbortSignal, 'timeout', () => controller.signal);
  let signal;
  try {
    const transport = new NativeTransport(
        (url, init) => {
          signal = init.signal;
          return new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () => reject(init.signal.reason)),
          );
        },
        async () => {},
      ),
      sent = transport.request(plan, connection, {accessToken: 't'}, upload(128 * MiB));
    setTimeout(() => controller.abort(new DOMException('Timer expired', 'TimeoutError')), 20);
    await assert.rejects(sent, error => assertRefused(error, 'WRITE_OUTCOME_UNCERTAIN'));
    assert.equal(signal, controller.signal, 'the request that was sent carries the limit’s own signal');
    assert.equal(signal.aborted, true);
  } finally {
    timer.mock.restore();
  }
  // A read-only upload is still refused before anything is sent.
  await assert.rejects(
    new NativeTransport(
      async () => Response.json({}),
      async () => {},
    ).request({...plan, readOnly: true, method: 'GET'}, connection, {accessToken: 't'}, upload(1)),
    error => assertRefused(error, 'INVALID_UPLOAD'),
  );
});
