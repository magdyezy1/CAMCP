import test from 'node:test';
import assert from 'node:assert/strict';
import {redact, redactUrlSecrets} from '../dist/src/security.js';

/**
 * R2.5 M1 (L1-02, package r25-m1-hash): `ticket` is a signed-link parameter. TikTok's advertiser licence link carries a
 * `ticket=` value that is a credential to the document, so it is never logged, shown in an error or kept in an audit row,
 * like `signature` and `sig`. It is a parameter name only: `ticket` is an ordinary property name in provider data (a
 * support ticket), so an object key of that name keeps its value. Synthetic values only.
 */
const SECRET = 'SYNTHETICTICKET0123456789';
const link = 'https://ads.example/pssresource/internal/download?ticket=' + SECRET + '&id=7';

test('a ticket parameter in a URL string of a native read result is hidden, the rest of the link is kept', () => {
  const {value, redacted} = redactUrlSecrets({data: {list: [{license_url: link}]}});
  const shown = JSON.stringify(value);
  assert.equal(shown.includes(SECRET), false, shown);
  assert.match(shown, /ticket=\[REDACTED\]&id=7/);
  assert.equal(redacted, 1);
});

test('the ticket stays hidden in a field that names a signed link: only sig and signature are kept there', () => {
  const {value} = redactUrlSecrets({preview_link: link + '&sig=KEEPME'}, new Set(['preview_link']));
  const shown = JSON.stringify(value);
  assert.equal(shown.includes(SECRET), false, shown);
  assert.match(shown, /sig=KEEPME/);
});

test('a ticket pair in free text is hidden after ?, &, # and ;, in any case or escape', () => {
  const base = 'https://ads.example/d';
  // A pair after each delimiter, with the text after it that must survive (as tests/redaction-credential-names.test.mjs).
  const pairs = name => [
    ['?', `${base}?${name}=${SECRET}&n=2`],
    ['&', `${base}?x=1&${name}=${SECRET}&n=2`],
    ['#', `${base}?x=1#${name}=${SECRET}&n=2`],
    [';', `${base}?x=1;${name}=${SECRET};n=2`],
  ];
  for (const name of ['ticket', 'TICKET', 'Ticket', '%74icket'])
    for (const [lead, url] of pairs(name)) {
      const text = redact('Platform refused ' + url + ' for the request');
      assert.equal(text.includes(SECRET), false, lead + name + ': ' + text);
      assert.match(text, /n=2/, lead + name + ': ' + text);
      assert.equal(redact(text), text, 'redacting again changes nothing');
    }
});

test('ticket as an ordinary property name, or in prose, is not a credential', () => {
  assert.deepEqual(redact({ticket: 'T-1234', rows: [{ticket: 'T-5'}]}), {ticket: 'T-1234', rows: [{ticket: 'T-5'}]});
  const prose = 'Please quote support ticket=T-1234 when you write';
  assert.equal(redact(prose), prose);
  // A name that only contains the word is another parameter.
  const other = 'https://ads.example/d?tickets=1&my-ticket=2';
  assert.equal(redactUrlSecrets({link: other}).value.link, other);
});
