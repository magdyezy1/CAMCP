import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redact,
  redactUrlSecrets,
  redactCredentialShapes,
  redactCredentialShapesWithPaths,
} from '../dist/src/security.js';

/**
 * R2.5 M1 (L1-02, package r25-m1-hash; lead review S3-2): TikTok's advertiser licence link is a credential to the document,
 * so it is never logged, shown in an error or kept in an audit row. It is hidden where TikTok hands it out: under its own
 * field, `license_url`, as `shareable_preview_url` is. `ticket` is NOT a secret URL parameter by name: a landing page that
 * carries one (an event or a queue ticket the advertiser configured) must reach a new ad as it was read, show to the
 * approver as it is, and be saved in a reporting setting, as every other parameter of it. Synthetic values only.
 */
const SECRET = 'SYNTHETICTICKET0123456789';
const licence = 'https://ads.tiktok.com/pssresource/internal/download?ticket=' + SECRET + '&id=7';
const landing = 'https://events.example/buy?ticket=vip&utm_source=amcp';

test('a landing page that carries a ticket is shown as it is: in a native read result, a log, a display and a saved setting (S3-2)', () => {
  const row = {
    landing_page_url: landing,
    rows: [{click_tracking_url: 'https://track.example/c?utm_source=a&ticket=T-9'}],
  };
  const read = redactUrlSecrets({data: {list: [row]}});
  assert.deepEqual(read.value, {data: {list: [row]}});
  assert.equal(read.redacted, 0);
  assert.deepEqual(redact(row), row);
  assert.equal(
    redact('Platform refused ' + landing + ' for the request'),
    'Platform refused ' + landing + ' for the request',
  );
  // The credential refusal of saved reporting queries and settings judges the same text: nothing is hidden, so nothing is refused.
  assert.deepEqual(redactCredentialShapes({query: {landing_page_url: landing}}), {query: {landing_page_url: landing}});
  // The approver reads the same state the review kept, with nothing hidden.
  const shown = redactCredentialShapesWithPaths({before_state: [{data: {list: [row]}}]});
  assert.deepEqual(shown.value.before_state, [{data: {list: [row]}}]);
  assert.deepEqual(shown.redacted, []);
});

test('the licence link stays hidden under its field, wherever the field stands and however it is spelled', () => {
  for (const key of ['license_url', 'licenseUrl', 'LICENSE_URL', 'license-url']) {
    const hidden = '[PRIVATE_LICENSE_URL]';
    assert.deepEqual(redact({[key]: licence}), {[key]: hidden}, key);
    assert.deepEqual(
      redact({data: {list: [{[key]: licence, advertiser_id: '1'}]}}).data.list[0],
      {[key]: hidden, advertiser_id: '1'},
      key,
    );
    assert.deepEqual(redactCredentialShapes({[key]: licence}), {[key]: hidden}, key);
    const read = redactUrlSecrets({data: {list: [{[key]: licence, advertiser_id: '1'}]}});
    assert.deepEqual(read.value.data.list[0], {[key]: hidden, advertiser_id: '1'}, key);
    assert.equal(read.redacted, 1, key);
    assert.equal(JSON.stringify(read.value).includes(SECRET), false, key);
  }
  // A display says where it hid something, and never what.
  const shown = redactCredentialShapesWithPaths({before_state: [{license_url: licence}]});
  assert.deepEqual(shown.redacted, [{path: '$["before_state"][0]["license_url"]'}]);
  assert.equal(JSON.stringify(shown).includes(SECRET), false);
  // Hiding it again changes nothing.
  assert.deepEqual(redact(redact({license_url: licence})), {license_url: '[PRIVATE_LICENSE_URL]'});
});

test('a field of another name that holds a ticket is an ordinary value, and ticket as a property or in prose is no credential', () => {
  assert.deepEqual(redact({ticket: 'T-1234', rows: [{ticket: 'T-5'}], page: landing}), {
    ticket: 'T-1234',
    rows: [{ticket: 'T-5'}],
    page: landing,
  });
  const prose = 'Please quote support ticket=T-1234 when you write';
  assert.equal(redact(prose), prose);
  const other = 'https://ads.example/d?tickets=1&my-ticket=2';
  assert.equal(redactUrlSecrets({link: other}).value.link, other);
});

test('the credentials a link may carry are still hidden beside a ticket: token, sig, signature and the signed-URL parameters', () => {
  for (const name of ['token', 'sig', 'signature', 'x-signature', 'x-amz-signature', 'x-goog-signature']) {
    const url = 'https://events.example/buy?ticket=vip&' + name + '=' + SECRET + '&n=2';
    const read = redactUrlSecrets({link: url}).value.link;
    assert.equal(read.includes(SECRET), false, name);
    assert.ok(read.includes('ticket=vip') && read.includes('n=2'), name + ': ' + read);
    assert.equal(redact(url).includes(SECRET), false, name);
  }
});
