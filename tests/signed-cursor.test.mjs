import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {CursorRefused, cursorLifetimeMs, cursorSignature, openCursor, sealCursor} from '../dist/src/signed-cursor.js';
import {fingerprint} from '../dist/src/workspace-core.js';

// ARC-04 stage E: the one signed-cursor codec of the portfolio adapters.
const key = 'synthetic-authorization',
  binding = 'synthetic-binding',
  now = 1_800_000_000_000,
  payload = {version: 1, binding, page: 2, after: 'token', expires_at: now + 1000};
const rules = {key, binding, maxLength: 4096, now};
const refused = (cursor, extra = {}) => assert.throws(() => openCursor(cursor, {...rules, ...extra}), CursorRefused);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

test('a sealed cursor opens to its payload, without its signature, under the same key and binding', () => {
  const cursor = sealCursor(payload, key);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(openCursor(cursor, rules), payload);
  // The signature the seven adapters used: HMAC-SHA256 of the payload fingerprint, keyed by the authorization.
  assert.equal(cursorSignature(payload, key), createHmac('sha256', key).update(fingerprint(payload)).digest('hex'));
  assert.equal(JSON.parse(Buffer.from(cursor, 'base64url').toString()).signature, cursorSignature(payload, key));
});

test('a tampered, re-signed-elsewhere or unsigned cursor is refused', () => {
  const cursor = sealCursor(payload, key),
    sealed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  refused(encode({...sealed, page: 3}));
  refused(sealCursor(payload, 'another-key'));
  refused(encode({...payload}));
  refused(encode({...payload, signature: 'A'.repeat(64)}));
  refused(encode({...payload, signature: sealed.signature.slice(0, 62)}));
});

test('a cursor for another read, of another version or outside its lifetime is refused', () => {
  refused(sealCursor({...payload, binding: 'other-binding'}, key));
  refused(sealCursor({...payload, version: 2}, key));
  // Expired at the instant itself.
  refused(sealCursor({...payload, expires_at: now}, key));
  refused(sealCursor({...payload, expires_at: now - 1}, key));
  refused(sealCursor({...payload, expires_at: now + cursorLifetimeMs + 1}, key));
  refused(sealCursor({...payload, expires_at: String(now + 1000)}, key));
  assert.deepEqual(openCursor(sealCursor({...payload, expires_at: now + cursorLifetimeMs}, key), rules).page, 2);
});

test('an oversized, non-base64url, non-canonical or non-object cursor is refused', () => {
  const cursor = sealCursor(payload, key);
  refused(cursor, {maxLength: cursor.length - 1});
  assert.ok(openCursor(cursor, {...rules, maxLength: cursor.length}));
  refused(cursor + '=');
  refused(cursor.slice(0, 10) + '.' + cursor.slice(11));
  refused(cursor + 'A');
  refused(42);
  refused(undefined);
  refused('');
  refused(Buffer.from('not json').toString('base64url'));
  refused(encode([payload]));
  refused(encode('a string'));
});
