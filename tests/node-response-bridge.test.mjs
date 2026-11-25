import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {downloadMediaLink, guardedLookup, linkRequest} from '../dist/src/media-link.js';
import {wooCommerceRequest} from '../dist/src/woocommerce-source.js';
import {downloadReportArchive, publicGet} from '../dist/src/microsoft-report-download.js';
import {downloadXReport} from '../dist/src/x-report-download.js';
import {png} from '../dist/tests/helpers/drive-large.js';
import {crashSentinel, raw, rawHost, viaHost} from '../dist/tests/helpers/local-https-host.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';
import {wooSourceFixture, wooSourceInput} from './fixtures/woocommerce-source-data.mjs';

offerParkedProviders('woocommerce');

/**
 * r25-hotfix-fetch (S1): five transports turn a node HTTPS response into a fetch Response inside the `response` event
 * of `https.request`: the media link import, the WooCommerce source, the Microsoft report file, the X report file and
 * the client metadata document (tests/mcp-registration-protocol.test.ts takes that one through /authorize). The
 * Response constructor throws on a status outside 200-599, and a throw inside that event ends the process, so one host
 * answering `HTTP/1.1 999` was enough. Each answer here is raw bytes from a local host, met by node's own HTTP client
 * and the real transport. The call must be refused with the place's own refusal, the socket closed, and nothing uncaught.
 */

// A Content-Length that promises more than is sent keeps the connection open: only a client that destroys the response
// it will not use closes it. 101 is one a client can surface (the status of a response that is not an upgrade).
const unusable = Object.fromEntries(
  [999, 600, 101].map(status => [status, raw(status, 'Content-Length: 1000\r\n', 'abc')]),
);
const empty = Object.fromEntries([204, 205, 304].map(status => [status, raw(status)]));
const lookup = guardedLookup();
const within = () => AbortSignal.timeout(3000);
const answers = path => unusable[path.slice(1)] ?? empty[path.slice(1)] ?? unusable[999];

test('media link: a host answering a status no Response can carry is refused and closed, and the process stays up', async t => {
  const {crashes, during} = crashSentinel(t),
    host = await rawHost(answers, {hold: true});
  t.after(() => host.close());
  viaHost(t, host);
  for (const status of Object.keys(unusable)) {
    await during(
      assert.rejects(
        downloadMediaLink('https://files.example.test/' + status, {overallMs: 3000}),
        e => assertRefused(e, 'MEDIA_DOWNLOAD_FAILED', {status: 502}),
        status,
      ),
    );
    assert.equal(await host.closed(), true, status + ': the socket was left open');
  }
  assert.deepEqual(crashes, [], 'an uncaught exception or an unhandled rejection');
});

test('media link: ordinary answers are unchanged: the file with its headers, an empty status refused as before', async t => {
  const file = Buffer.concat([
      Buffer.from(
        raw(200, 'Content-Type: image/png\r\nContent-Length: ' + png.length + '\r\nX-Odd: caf\xe9\r\n'),
        'latin1',
      ),
      png,
    ]),
    host = await rawHost(path => (path === '/file' ? file : answers(path)));
  t.after(() => host.close());
  viaHost(t, host);
  const response = await linkRequest(new URL('https://files.example.test/file'), {signal: within(), lookup});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-odd'), 'caf\xe9');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  const got = await downloadMediaLink('https://files.example.test/file', {overallMs: 3000});
  assert.deepEqual([got.mime, got.host], ['image/png', 'files.example.test']);
  assert.deepEqual(got.bytes, png);
  for (const status of Object.keys(empty)) {
    const bare = await linkRequest(new URL('https://files.example.test/' + status), {signal: within(), lookup});
    assert.deepEqual([bare.status, bare.body], [Number(status), null], status);
    await assert.rejects(
      downloadMediaLink('https://files.example.test/' + status, {overallMs: 3000}),
      e => assertRefused(e, 'MEDIA_LINK_UNAVAILABLE', {message: new RegExp('HTTP ' + status)}),
      status,
    );
  }
});

test('an odd header value cannot reach a response callback: node refuses the answer first, as a refused call', async t => {
  // Headers refuses only what node's own parser refuses first (a control character in a value), so no header can make
  // the Response constructor throw today. The guard covers the whole build anyway; this pins that such an answer is a
  // refused call and not a crash.
  const {crashes, during} = crashSentinel(t),
    host = await rawHost(() => raw(200, 'X-Odd: a\x7fb\r\nContent-Length: 0\r\n'));
  t.after(() => host.close());
  viaHost(t, host);
  await during(
    assert.rejects(linkRequest(new URL('https://files.example.test/odd'), {signal: within(), lookup}), {
      code: 'HPE_INVALID_HEADER_TOKEN',
    }),
  );
  assert.deepEqual(crashes, [], 'an uncaught exception or an unhandled rejection');
});

test('WooCommerce: a host answering a status no Response can carry is refused and closed, and the process stays up', async t => {
  const {crashes, during} = crashSentinel(t),
    host = await rawHost(answers, {hold: true}),
    get = status =>
      wooCommerceRequest(new URL('https://shop.example.test/' + status), {
        signal: within(),
        lookup,
        headers: {Accept: 'application/json'},
      });
  t.after(() => host.close());
  viaHost(t, host);
  for (const status of Object.keys(unusable)) {
    await during(assert.rejects(get(status), RangeError, status));
    assert.equal(await host.closed(), true, status + ': the socket was left open');
  }
  for (const status of Object.keys(empty)) {
    const bare = await during(get(status));
    assert.deepEqual([bare.status, bare.body], [Number(status), null], status);
  }
  // The source read answers as it does for any store that is not reachable.
  const f = wooSourceFixture();
  t.after(() => f.close());
  const service = new MirrorService(
    new Registry(),
    f.store,
    new NativeTransport(async () => {
      throw Error('Unqualified generic egress');
    }),
    undefined,
    {allowWrites: false},
    undefined,
    undefined,
    wooCommerceRequest,
  );
  assertRefused(
    await during(service.call('amcp_workspace', wooSourceInput(), f.actor)),
    'WOOCOMMERCE_SOURCE_UNAVAILABLE',
  );
  assert.deepEqual(crashes, [], 'an uncaught exception or an unhandled rejection');
});

test('WooCommerce: an ordinary answer keeps its status, body and the selected headers only', async t => {
  const body = '{"id":"woocommerce_currency","value":"SAR"}',
    host = await rawHost(() =>
      raw(
        200,
        'Content-Type: application/json\r\nX-WP-Total: 1\r\nX-Private: UNUSED-PRIVATE-WOO\r\nContent-Length: ' +
          body.length +
          '\r\n',
        body,
      ),
    );
  t.after(() => host.close());
  viaHost(t, host);
  const response = await wooCommerceRequest(new URL('https://shop.example.test/ok'), {
    signal: within(),
    lookup,
    headers: {Accept: 'application/json'},
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    [response.headers.get('content-type'), response.headers.get('x-wp-total'), response.headers.get('x-private')],
    ['application/json', '1', null],
  );
  assert.equal((await response.json()).value, 'SAR');
});

test('Microsoft report file: a host answering a status no Response can carry is refused and closed, and the process stays up', async t => {
  const {crashes, during} = crashSentinel(t),
    host = await rawHost(answers, {hold: true});
  t.after(() => host.close());
  viaHost(t, host);
  for (const status of Object.keys(unusable)) {
    await during(
      assert.rejects(publicGet(new URL('https://reports.example.test/' + status), within()), RangeError, status),
    );
    assert.equal(await host.closed(), true, status + ': the socket was left open');
  }
  // This transport never gave an empty status a null body: such an answer is refused too, where it used to end the process.
  for (const status of Object.keys(empty))
    await during(
      assert.rejects(publicGet(new URL('https://reports.example.test/' + status), within()), TypeError, status),
    );
  for (const status of [999, 304])
    await during(
      assert.rejects(
        downloadReportArchive('https://reports.example.test/' + status),
        e => assertRefused(e, 'REPORT_DOWNLOAD_FAILED', {status: 502, message: /failed or timed out/}),
        String(status),
      ),
    );
  assert.deepEqual(crashes, [], 'an uncaught exception or an unhandled rejection');
});

test('Microsoft report file: an ordinary answer is downloaded as before', async t => {
  const archive = Buffer.from('PK synthetic archive bytes'),
    host = await rawHost(path =>
      path === '/archive'
        ? raw(
            200,
            'Content-Type: application/zip\r\nContent-Length: ' + archive.length + '\r\n',
            archive.toString('latin1'),
          )
        : raw(404, 'Content-Length: 0\r\n'),
    );
  t.after(() => host.close());
  viaHost(t, host);
  const response = await publicGet(new URL('https://reports.example.test/archive'), within());
  assert.deepEqual([response.status, response.headers.get('content-type')], [200, 'application/zip']);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), archive);
  assert.deepEqual(await downloadReportArchive('https://reports.example.test/archive'), archive);
  await assert.rejects(downloadReportArchive('https://reports.example.test/missing'), e =>
    assertRefused(e, 'REPORT_DOWNLOAD_FAILED', {status: 502, message: /exceeds the 8 MiB/}),
  );
});

const xRow = job => ({
  url: 'https://ton.twimg.com/advertiser-api-async-analytics/stats_job_' + job + '.json.gz',
  expires_at: new Date(Date.now() + 3600000).toISOString(),
});
const xRead = job => downloadXReport(xRow(job), {job_id: job}, () => {}, undefined, performance.now() + 3000);
const xHost = () =>
  rawHost(
    path => {
      const job = /stats_job_(\w+)\./.exec(path)?.[1] ?? '';
      return (
        unusable[job] ??
        empty[job] ??
        (job === 'ok' ? raw(200, 'Content-Length: 20\r\n', 'not a gzip stream...') : raw(404))
      );
    },
    {hold: true},
  );

test('X report file: a host answering a status no Response can carry is refused and closed, and the process stays up', async t => {
  const {crashes, during} = crashSentinel(t),
    host = await xHost();
  t.after(() => host.close());
  viaHost(t, host);
  for (const status of Object.keys(unusable)) {
    await during(
      assert.rejects(
        xRead(status),
        e => assertRefused(e, 'X_REPORT_DOWNLOAD_INVALID', {status: 502, message: /failed or timed out/}),
        status,
      ),
    );
    assert.equal(await host.closed(), true, status + ': the socket was left open');
  }
  // This transport never gave an empty status a null body: such an answer is refused too, where it used to end the process.
  for (const status of Object.keys(empty))
    await during(
      assert.rejects(
        xRead(status),
        e => assertRefused(e, 'X_REPORT_DOWNLOAD_INVALID', {status: 502, message: /failed or timed out/}),
        status,
      ),
    );
  assert.deepEqual(crashes, [], 'an uncaught exception or an unhandled rejection');
});

test('X report file: an ordinary answer reaches the report checks as before', async t => {
  const host = await xHost();
  t.after(() => host.close());
  viaHost(t, host);
  await assert.rejects(xRead('404'), e => assertRefused(e, 'X_REPORT_DOWNLOAD_INVALID', {message: /unsuccessful/}));
  await assert.rejects(xRead('ok'), e =>
    assertRefused(e, 'X_REPORT_DOWNLOAD_INVALID', {message: /bounded native gzip/}),
  );
});
