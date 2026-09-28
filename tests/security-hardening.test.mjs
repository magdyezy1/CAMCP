import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SecretBox} from '../dist/src/security.js';
import {buildUrl} from '../dist/src/transport.js';
import {MirrorError, errorResult} from '../dist/src/errors.js';

const key = Buffer.alloc(32, 91).toString('base64');

test('sealed secrets refuse truncated authentication tags and malformed IVs', () => {
  const box = new SecretBox(key),
    sealed = box.seal({token: 'synthetic'}, 'scope');
  assert.deepEqual(box.open(sealed, 'scope'), {token: 'synthetic'});
  const [iv, tag, body] = sealed.split('.');
  // AES-GCM verifies a tag as short as 4 bytes unless the length is fixed; each truncation must fail.
  for (const bytes of [4, 8, 12]) {
    const short = Buffer.from(tag, 'base64').subarray(0, bytes).toString('base64');
    assert.throws(() => box.open([iv, short, body].join('.'), 'scope'), {code: 'SECRET_DECRYPT_FAILED'});
  }
  assert.throws(() => box.open([Buffer.alloc(8).toString('base64'), tag, body].join('.'), 'scope'), {
    code: 'SECRET_DECRYPT_FAILED',
  });
});

test('transport refuses dot segments, including percent-encoded ones', () => {
  const connection = {
    id: 'c',
    tenantId: 't',
    gateway: 'meta_native_action',
    accounts: ['123'],
    enabled: true,
    label: 'x',
    scopes: [],
  };
  const request = path => ({
    gateway: 'meta_native_action',
    action: 'x',
    method: 'GET',
    path,
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: '',
    warnings: [],
  });
  assert.equal(buildUrl(request('/v25.0/act_123/campaigns'), connection).pathname, '/v25.0/act_123/campaigns');
  for (const path of [
    '/v25.0/act_123/../999/assigned_users',
    '/v25.0/act_123/%2e%2e/999',
    '/v25.0/act_123/%2E./999',
    '/v25.0/./act_123',
  ])
    assert.throws(() => buildUrl(request(path), connection), {code: 'INVALID_PATH'}, path);
});

test('the LinkedIn API version has one source', () => {
  // Every LinkedIn-Version header comes from linkedinVersion(), which reads AMCP_LINKEDIN_API_VERSION and validates it.
  for (const dir of ['src', 'server'])
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.ts'))) {
      if (file === 'linkedin-version.ts') continue;
      const text = fs.readFileSync(dir + '/' + file, 'utf8');
      assert.doesNotMatch(text, /'LinkedIn-Version'\s*:\s*'20\d{4}'/, dir + '/' + file);
      assert.doesNotMatch(text, /AMCP_LINKEDIN_API_VERSION\s*\?\?/, dir + '/' + file);
    }
});

test('execute-time confirmation refusals say the review is still valid instead of asking to prepare again', () => {
  for (const [code, flag] of [
    ['SPEND_CONFIRMATION_REQUIRED', 'spend_change_confirmed'],
    ['CREATIVE_EDIT_CONFIRMATION_REQUIRED', 'creative_edit_confirmed'],
    ['CONFIRMATION_REQUIRED', 'confirmed'],
  ]) {
    const r = errorResult(new MirrorError(code, 'Needs acknowledgement.'), 'request', 1);
    assert.equal(r.error.category, 'confirmation');
    assert.equal(r.error.remedy.owner, 'user');
    assert.match(r.error.next_action, new RegExp(flag + '=true'));
    assert.match(r.error.next_action, /Do not prepare again/);
  }
  assert.match(
    errorResult(new MirrorError('IDEMPOTENCY_REQUIRED', 'x'), 'request', 1).error.next_action,
    /equal to the review_id/,
  );
  const expired = errorResult(new MirrorError('REVIEW_EXPIRED', 'x'), 'request', 1).error;
  assert.match(expired.next_action, /Nothing was submitted/);
  assert.match(expired.remedy.action, /Nothing was submitted/);
});
