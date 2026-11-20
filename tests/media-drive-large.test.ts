import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadDriveMedia} from '../src/drive-media.js';
import {assertRefused} from './helpers/assert-refused.js';
import {
  FILE_ID,
  OTHER_ID,
  UUID,
  endpoint,
  share,
  html,
  png,
  page,
  drive,
  confirmationPage,
  file,
  counting,
  hosts,
} from './helpers/drive-large.js';

/**
 * R2.5 field fix r25-media-drive-large (2026-11-19, P0): a public Drive file too large for Google to scan is served
 * behind a confirmation page ("can't scan this file for viruses"). AMCP follows it under strict rules: it recognizes the
 * page strictly, builds the one further request itself from its own fixed host and validated values, and never
 * requests a URL the page names. Every page and every body below is written by hand with synthetic values; nothing here
 * was copied from Drive or from a field report, and no test touches the network.
 */
test('a confirmation page is followed once: two requests, both to the download endpoint, the second built by AMCP', async () => {
  const {fetcher, requests} = drive(confirmationPage, file),
    {sink, written} = counting(),
    got = await downloadDriveMedia(share, fetcher, sink);
  assert.equal(requests.length, 2);
  for (const {url, init} of requests) {
    assert.equal(url.origin + url.pathname, endpoint);
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    assert.equal(new Headers(init?.headers).has('cookie'), false);
  }
  assert.deepEqual(
    [...requests[0]!.url.searchParams],
    [
      ['id', FILE_ID],
      ['export', 'download'],
    ],
  );
  assert.deepEqual(
    [...requests[1]!.url.searchParams],
    [
      ['id', FILE_ID],
      ['export', 'download'],
      ['confirm', 't'],
      ['uuid', UUID],
    ],
  );
  // The page is never staged: only the file's own bytes reach the sink.
  assert.equal(written(), png.length);
  assert.equal(got.mime, 'image/png');
  assert.equal(got.kind, 'image');
});
test('the confirmation keeps the share link’s resource key and a page without uuid still confirms', async () => {
  const {fetcher, requests} = drive(() => new Response(page({uuid: null, confirm: 'Abc_-9'}), html), file),
    got = await downloadDriveMedia(share + '&resourcekey=0-synResourceKey1', fetcher);
  assert.deepEqual(got.bytes, png);
  assert.deepEqual(
    [...requests[1]!.url.searchParams],
    [
      ['id', FILE_ID],
      ['export', 'download'],
      ['confirm', 'Abc_-9'],
      ['resourcekey', '0-synResourceKey1'],
    ],
  );
});
test('a confirmed download may be redirected to a Drive file host, which is checked as before', async () => {
  const {fetcher, requests} = drive(
    confirmationPage,
    () =>
      new Response(null, {
        status: 303,
        headers: {Location: 'https://doc-0k-9c-docs.googleusercontent.com/docs/securesc/synthetic/file?e=download'},
      }),
    file,
  );
  assert.deepEqual((await downloadDriveMedia(share, fetcher)).bytes, png);
  assert.deepEqual(hosts(requests), [
    'https://drive.usercontent.google.com',
    'https://drive.usercontent.google.com',
    'https://doc-0k-9c-docs.googleusercontent.com',
  ]);
});

/** Pages that look like the confirmation page, and each break one rule of recognizing it. */
const hostile: [string, string][] = [
  ['a form action on another host', page({action: 'https://attacker.invalid/download'})],
  ['a protocol-relative form action', page({action: '//attacker.invalid/download'})],
  ['a relative form action', page({action: '/download'})],
  ['the same host with another path', page({action: 'https://drive.usercontent.google.com/other'})],
  ['the endpoint with a query already on it', page({action: endpoint + '?id=' + OTHER_ID})],
  ['a form that posts', page({method: 'post'})],
  ['an id that is not the file requested', page({id: OTHER_ID})],
  ['an export that is not a download', page({exportValue: 'view'})],
  ['an injected confirm value', page({confirm: 't&x=1'})],
  ['an injected confirm value in an entity', page({confirm: 't&amp;x=1'})],
  ['an injected confirm value, percent-encoded', page({confirm: 't%26x=1'})],
  ['a confirm value past 64 characters', page({confirm: 'a'.repeat(65)})],
  ['an empty confirm value', page({confirm: ''})],
  ['a uuid that is not a uuid', page({uuid: 'not-a-uuid&x=1'})],
  ['a hidden field of another name', page({inside: '<input type="hidden" name="redirect" value="x">'})],
  ['a second id', page({inside: '<input type="hidden" name="id" value="' + OTHER_ID + '">'})],
  // Each of these is otherwise a valid page, so the one rule it breaks is the only thing that can refuse it.
  ['a field typed in by a person', page({uuid: null, inside: '<input type="text" name="uuid" value="' + UUID + '">'})],
  ['a field outside the form', page({uuid: null, after: '<input type="hidden" name="uuid" value="' + UUID + '">'})],
  ['a second, empty form', page({after: '<form action="' + endpoint + '" method="get"></form>'})],
  [
    'a field that a button names',
    page({uuid: null, inside: '<button type="hidden" name="uuid" value="' + UUID + '">Go</button>'}),
  ],
  ['a button that submits elsewhere', page({inside: '<button formaction="https://attacker.invalid/">Go</button>'})],
  ['a field with a form of its own', page({inside: '<input type="submit" form="other" value="Go">'})],
  ['an extra link to another host', page({after: '<a href="https://attacker.invalid/file.mp4">Download</a>'})],
  ['an extra protocol-relative link', page({after: '<a href="//attacker.invalid/file.mp4">Download</a>'})],
  ['an extra javascript link', page({after: '<a href="javascript:void(0)">Download</a>'})],
  ['a base element', page({after: '<base href="https://attacker.invalid/">'})],
  ['a refresh to another host', page({after: '<meta http-equiv="refresh" content="0;url=https://attacker.invalid/">'})],
  ['an embedded frame on another host', page({after: '<iframe src="https://attacker.invalid/"></iframe>'})],
  ['no form at all', '<html><body><p>Sign in to continue.</p></body></html>'],
];
for (const [name, body] of hostile)
  test('a hostile page is refused after one request, and no URL it names is requested: ' + name, async () => {
    const {fetcher, requests} = drive(() => new Response(body, html), file);
    await assert.rejects(downloadDriveMedia(share, fetcher), e => assertRefused(e, 'DRIVE_FILE_UNAVAILABLE'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url.href, endpoint + '?id=' + FILE_ID + '&export=download');
  });
test('links to Google’s own hosts and to relative paths do not make the page hostile', async () => {
  const links =
    '<a href="/open?id=' +
    FILE_ID +
    '">name</a> <a href="//support.google.com/drive/answer/1">Help</a> <a href="https://policies.google.com/terms">Terms</a>' +
    '<a href="#top">top</a><link rel="stylesheet" href="https://www.gstatic.com/x.css">';
  const {fetcher, requests} = drive(() => new Response(page({after: links}), html), file);
  assert.deepEqual((await downloadDriveMedia(share, fetcher)).bytes, png);
  assert.equal(requests.length, 2);
});

test('a page that a file host served is never taken for a confirmation page, even when it looks like one', async () => {
  // A public file that is itself HTML, written to look like Drive's page, comes from a file host after a redirect.
  const {fetcher, requests} = drive(
    () =>
      new Response(null, {
        status: 303,
        headers: {Location: 'https://doc-0k-9c-docs.googleusercontent.com/docs/securesc/synthetic/page'},
      }),
    confirmationPage,
    file,
  );
  await assert.rejects(downloadDriveMedia(share, fetcher), e => assertRefused(e, 'DRIVE_FILE_UNAVAILABLE'));
  assert.equal(requests.length, 2);
});
test('a second confirmation page after confirming is refused, never followed again', async () => {
  const {fetcher, requests} = drive(confirmationPage);
  await assert.rejects(downloadDriveMedia(share, fetcher), e => assertRefused(e, 'DRIVE_FILE_UNAVAILABLE'));
  assert.equal(requests.length, 2);
  assert.deepEqual(hosts(requests), ['https://drive.usercontent.google.com', 'https://drive.usercontent.google.com']);
});

/** A page body of `total` bytes in `chunk`-byte pieces, beginning with a valid confirmation page. */
function longPage(total: number, chunk: number) {
  const head = page({after: '<!--'}),
    all = Buffer.concat([
      Buffer.from(head),
      Buffer.alloc(Math.max(0, total - head.length - 3), 0x61),
      Buffer.from('-->'),
    ]);
  const sent = {bytes: 0, cancelled: false};
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent.bytes >= all.length) return c.close();
      const part = all.subarray(sent.bytes, sent.bytes + chunk);
      sent.bytes += part.length;
      c.enqueue(new Uint8Array(part));
    },
    cancel() {
      sent.cancelled = true;
    },
  });
  return {response: new Response(stream, html), sent, length: all.length};
}
test('a page over 64 KiB is refused without reading the rest of it', async () => {
  const long = longPage(1024 * 1024, 16 * 1024),
    {fetcher, requests} = drive(() => long.response, file);
  await assert.rejects(downloadDriveMedia(share, fetcher), e => assertRefused(e, 'DRIVE_FILE_UNAVAILABLE'));
  assert.equal(requests.length, 1);
  assert.equal(long.sent.cancelled, true);
  assert.ok(long.sent.bytes <= 64 * 1024 + 2 * 16 * 1024, 'read ' + long.sent.bytes + ' bytes of a 1 MiB page');
});
test('a page of exactly 64 KiB is read in full and confirms; one byte more is refused', async () => {
  const exact = longPage(64 * 1024, 4096),
    over = longPage(64 * 1024 + 1, 4096);
  assert.equal(exact.length, 64 * 1024);
  assert.equal(over.length, 64 * 1024 + 1);
  const ok = drive(() => exact.response, file);
  assert.deepEqual((await downloadDriveMedia(share, ok.fetcher)).bytes, png);
  assert.equal(ok.requests.length, 2);
  const refused = drive(() => over.response, file);
  await assert.rejects(downloadDriveMedia(share, refused.fetcher), e => assertRefused(e, 'DRIVE_FILE_UNAVAILABLE'));
  assert.equal(refused.requests.length, 1);
});

test('a redirect after the confirmation to a host outside the allow-list is refused, and is never requested', async () => {
  for (const location of [
    'https://attacker.invalid/file.mp4',
    'http://169.254.169.254/latest/meta-data/',
    'https://drive.usercontent.google.com.attacker.invalid/download',
    'https://drive.usercontent.google.com:8443/download',
    'https://accounts.google.com.attacker.invalid/ServiceLogin',
    '//attacker.invalid/file.mp4',
  ]) {
    const {fetcher, requests} = drive(
      confirmationPage,
      () => new Response(null, {status: 302, headers: {Location: location}}),
    );
    await assert.rejects(
      downloadDriveMedia(share, fetcher),
      e => assertRefused(e, 'UNAPPROVED_MEDIA_SOURCE'),
      location,
    );
    assert.equal(requests.length, 2, location);
    assert.deepEqual(hosts(requests), ['https://drive.usercontent.google.com', 'https://drive.usercontent.google.com']);
  }
});
test('the redirect budget of three still holds across the confirmation', async () => {
  const hop = () =>
      new Response(null, {
        status: 302,
        headers: {Location: 'https://doc-0k-9c-docs.googleusercontent.com/docs/securesc/x'},
      }),
    {fetcher, requests} = drive(confirmationPage, hop);
  await assert.rejects(downloadDriveMedia(share, fetcher), e => assertRefused(e, 'MEDIA_DOWNLOAD_FAILED'));
  // One request for the page, one for the confirmation, three redirects followed, and no more.
  assert.equal(requests.length, 5);
});
