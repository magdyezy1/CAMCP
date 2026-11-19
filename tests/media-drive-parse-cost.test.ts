import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadDriveMedia, driveConfirmation} from '../src/drive-media.js';
import {inspectDrive} from '../src/media-routing.js';
import {MirrorError} from '../src/errors.js';
import {assertRefused} from './helpers/assert-refused.js';
import {drive, file, FILE_ID, html, page, png, share, UUID, type Reply} from './helpers/drive-large.js';

/**
 * R2.5 field fix r25-media-drive-large, fix round 2, item 1 (S2-1 of the lead's security review, 2026-11-20): reading a page
 * costs time in step with its size. A page is read within 64 KiB and then parsed on the one event loop that serves every
 * workspace, so a 64 KiB page built to make the tokenizer backtrack (an unclosed tag repeated, a tag name that never ends)
 * must not hold that loop for more than a moment. The tokenizer was quadratic: such a page held it for 2.4 to 8.1 seconds,
 * and the 32 KiB half of the same page for a quarter of that. The pages here are made up, and no test touches the network.
 *
 * The bound is generous (the fixed code takes a few milliseconds on these pages, a hundred times less), and the growth test
 * is about the algorithm, not this machine: it compares the cost of a page with the cost of its own half.
 */
const KiB = 1024,
  /** The most a 64 KiB page may take to refuse, on any machine that runs the tests. */
  bound = 250,
  fill = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

/** The hostile shapes of the review, each a page of exactly `bytes` ASCII bytes. */
const lettersAfterLt = (bytes: number) => fill('<' + 'a'.repeat(31), bytes),
  scriptAndLetters = (bytes: number) => '<script' + 'a'.repeat(bytes - 7),
  openTextareas = (bytes: number) => fill('<textarea ', bytes),
  oneLongName = (bytes: number) => '<' + 'a'.repeat(bytes - 1),
  openScripts = (bytes: number) => fill('<script ', bytes),
  openForms = (bytes: number) => fill('<form ', bytes),
  openX = (bytes: number) => fill('<x', bytes),
  onlyLts = (bytes: number) => '<'.repeat(bytes);
type Shape = [string, (bytes: number) => string];
const shapes: Shape[] = [
    ['a "<" and 31 letters, repeated', lettersAfterLt],
    ['"<script" and letters', scriptAndLetters],
    ['"<textarea " repeated', openTextareas],
    ['one "<" and 65,535 letters', oneLongName],
    ['"<script " repeated', openScripts],
    ['"<form " repeated', openForms],
    ['"<x" repeated', openX],
    ['"<" repeated', onlyLts],
  ],
  /** The three that cost the most: a tag name and an open tag, an open textarea, and an open form. */
  heaviest: Shape[] = [shapes[0]!, shapes[2]!, shapes[5]!];

/** One refused download whose first answer is `reply`: how long it took, how many requests it made and what it ended in. */
async function once(reply: Reply, workspace?: string) {
  const {fetcher, requests} = drive(reply),
    began = performance.now();
  let error: unknown;
  try {
    if (workspace === undefined) await downloadDriveMedia(share, fetcher);
    else await inspectDrive(share, fetcher, workspace);
  } catch (e) {
    error = e;
  }
  const ms = performance.now() - began;
  assert.ok(error instanceof MirrorError, 'a refusal (MirrorError), not ' + String(error));
  return {ms, error: error as MirrorError, requests: requests.length};
}
/**
 * The fastest of up to three runs, so that a pause of this machine (a collection, a busy neighbour) cannot fail a test: a
 * page that costs seconds costs them on every run, and the runs stop at once on a time no pause explains.
 */
async function fastest(reply: Reply, workspace?: string) {
  let best = await once(reply, workspace);
  for (let run = 1; run < 3 && best.ms > bound && best.ms < 10 * bound; run++) {
    const again = await once(reply, workspace);
    if (again.ms < best.ms) best = again;
  }
  return best;
}
const served =
  (text: string, init: ResponseInit = {}): Reply =>
  () =>
    new Response(text, {...html, ...init});

for (const [name, build] of shapes)
  test(
    'a 64 KiB page of ' + name + ' is refused as unrecognized within ' + bound + ' ms, after one request',
    async () => {
      const text = build(64 * KiB);
      assert.equal(Buffer.byteLength(text), 64 * KiB);
      const took = await fastest(served(text));
      assertRefused(took.error, 'DRIVE_FILE_UNAVAILABLE');
      assert.equal(took.error.details.reason, 'unrecognized_page');
      assert.equal(took.requests, 1);
      assert.ok(took.ms < bound, 'took ' + Math.round(took.ms) + ' ms');
    },
  );

test('the other places a page is read are as quick: a 403 page, a JSON answer and a page after the confirmation', async () => {
  const text = lettersAfterLt(64 * KiB);
  // A 403 page is read for its words, which is the classifier alone; the reason it ends in is another test's.
  const refused = await fastest(served(text, {status: 403}));
  assertRefused(refused.error, 'DRIVE_FILE_UNAVAILABLE');
  assert.ok(refused.ms < bound, '403: ' + Math.round(refused.ms) + ' ms');
  const json = await fastest(served(text, {headers: {'Content-Type': 'application/json'}}));
  assertRefused(json.error, 'DRIVE_FILE_UNAVAILABLE');
  assert.ok(json.ms < bound, 'JSON: ' + Math.round(json.ms) + ' ms');
  // The second answer is a page too: after a confirmation that was accepted, a hostile page is refused as quickly.
  const {fetcher, requests} = drive(() => new Response(page(), html), served(text)),
    began = performance.now();
  await assert.rejects(downloadDriveMedia(share, fetcher), e => assertRefused(e, 'DRIVE_FILE_UNAVAILABLE'));
  assert.equal(requests.length, 2);
  assert.ok(
    performance.now() - began < bound,
    'after the confirmation: ' + Math.round(performance.now() - began) + ' ms',
  );
});

test('inspect_google_drive_media reads a hostile page as quickly: it follows the same confirmation, for any member of a workspace', async () => {
  for (const [name, build] of heaviest) {
    const took = await fastest(served(build(64 * KiB)), 'parse-cost-' + name);
    assertRefused(took.error, 'DRIVE_FILE_UNAVAILABLE');
    assert.equal(took.error.details.reason, 'unrecognized_page');
    assert.equal(took.requests, 1);
    assert.ok(took.ms < bound, name + ': ' + Math.round(took.ms) + ' ms');
  }
});

/** The time one refusal of `text` takes, from enough repeats to add up to a time a timer can tell (a slow page is not repeated). */
async function perRefusal(text: string, enough = 40) {
  const began = performance.now();
  let runs = 0;
  do {
    await once(served(text));
    runs++;
  } while (performance.now() - began < enough && runs < 5000);
  return (performance.now() - began) / runs;
}
for (const [name, build] of heaviest)
  test('the cost of a page grows in step with its size, not with its square: ' + name, async () => {
    const half = build(32 * KiB),
      whole = build(64 * KiB);
    // The first runs are compiled as they go, so they are not measured; then the fastest of three measures each size in turn.
    await perRefusal(half, 5);
    await perRefusal(whole, 5);
    let small = Infinity,
      large = Infinity;
    for (let round = 0; round < 3; round++) {
      small = Math.min(small, await perRefusal(half));
      large = Math.min(large, await perRefusal(whole));
      if (large >= 10 * bound) break;
    }
    // A page twice as long takes about twice as long; a quadratic tokenizer takes four times as long.
    assert.ok(
      large < 3 * small,
      'a 32 KiB page took ' + small.toFixed(2) + ' ms and a 64 KiB page ' + large.toFixed(2) + ' ms',
    );
  });

/** The confirmation page of the helper, padded with text to exactly `bytes`, 64 KiB being the most a page may hold. */
function padded(bytes = 64 * KiB) {
  const empty = page({after: '<p></p>'}).length;
  return page({after: '<p>' + 'x'.repeat(bytes - empty) + '</p>'});
}
test('a confirmation page that fills the 64 KiB limit still parses, quickly, and is followed once', async () => {
  const text = padded();
  assert.equal(Buffer.byteLength(text), 64 * KiB);
  const {fetcher, requests} = drive(served(text), file),
    began = performance.now(),
    got = await downloadDriveMedia(share, fetcher),
    ms = performance.now() - began;
  assert.deepEqual(got.bytes, png);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.url.searchParams.get('confirm'), 't');
  assert.ok(ms < bound, 'took ' + Math.round(ms) + ' ms');
});

/** Markup a page may use for the same form: capitals, quotes of either kind, none, line breaks, a closing slash, comments, scripts and styles. */
const tolerant =
  '<!DOCTYPE html>\n<HTML lang=en><HEAD><META charset=utf-8><TITLE>Synthetic</TITLE>' +
  '<STYLE>a > b { color: red }\n.x::after { content: "<form>" }</STYLE>' +
  '<SCRIPT type="text/javascript">if (a < b && c > d) { write("<form action=\\"https://attacker.invalid/\\">"); }</SCRIPT></HEAD>' +
  '<BODY><!-- <form action="https://attacker.invalid/"> --><P CLASS=\'warning\'>Too large to scan for viruses. a < b</P>' +
  '<FORM ID="download-form"\n  ACTION="https://drive.usercontent.google.com/download"\n  METHOD=get>' +
  '<INPUT TYPE=hidden NAME=id VALUE="' +
  FILE_ID +
  '">' +
  "<INPUT type='hidden' name='export' value='download'>" +
  '<input type="hidden" name="confirm" value="t" />' +
  '<input type="hidden" name="uuid" value="' +
  UUID +
  '"></FORM></BODY></HTML>';
test('the markup a real page may use is still read: capitals, quotes, line breaks, comments, scripts and styles', () => {
  assert.deepEqual(driveConfirmation(tolerant, FILE_ID), {confirm: 't', uuid: UUID});
  assert.deepEqual(driveConfirmation(page(), FILE_ID), {confirm: 't', uuid: UUID});
});

test('a page with a tag that was not read is not the confirmation page, however right the rest of it is', async () => {
  // Each of these holds a tag the tokenizer does not read as one (a quote that holds a "<" or ">", a tag cut off by the next
  // tag or by the end of the page, an apostrophe that never closes). A browser may read such a tag differently from AMCP,
  // so the page is refused as a whole; AMCP asks for nothing more.
  const odd: [string, string][] = [
    ['a quoted ">" in an attribute', '<a title="x>y">link</a>'],
    ['a quoted "<" in an attribute', '<a title="a<b">link</a>'],
    ['a single-quoted ">"', "<a title='x>y'>link</a>"],
    ['a tag cut off by the next tag', '<span title="x"<b>text</b>'],
    ['a tag cut off by the end of the page', '<input type="hidden" name="x'],
    ['a "<" and a letter and nothing else', '<b'],
    ['an apostrophe that never closes', "<a title=it's>link</a>"],
  ];
  // The same page with an ordinary tag in the same place is the confirmation: the odd tag alone makes the difference.
  assert.deepEqual(driveConfirmation(page({after: '<a title="x y">link</a>'}), FILE_ID), {confirm: 't', uuid: UUID});
  for (const [name, tag] of odd) {
    const text = page({after: tag});
    assert.equal(driveConfirmation(text, FILE_ID), undefined, name);
    // With the file ready as the second answer, so that any request after the first would import it.
    const {fetcher, requests} = drive(served(text), file);
    await assert.rejects(downloadDriveMedia(share, fetcher), e => assertRefused(e, 'DRIVE_FILE_UNAVAILABLE'), name);
    assert.equal(requests.length, 1, name + ': nothing more is requested for a page that is refused');
  }
});

test('a "<" that does not open a tag, in the words of a page, does not hide the words after it', async () => {
  const quota =
    '<html><body><p>Synthetic: a < b. Too many users have viewed or downloaded this file recently.</p></body></html>';
  const refusal = await once(served(quota));
  assertRefused(refusal.error, 'DRIVE_FILE_UNAVAILABLE');
  assert.equal(refusal.error.details.reason, 'download_quota');
});
