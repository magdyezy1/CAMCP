import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {inspectSharedRecoveryHints, localeProblems} from '../tools/check-locales.mjs';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {portfolioRefusalFixture} from './fixtures/portfolio-refusal-data.mjs';
const hint =
  'The provider returned an incomplete or invalid inventory response, so AMCP did not use it. Keep the same selected account and hierarchy, and retry this read once. If it fails again, report the request ID.';
const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
test('invalid inventory response identifies provider recovery without changing refusal, retryability, details or reference', () => {
  const details = {
    native_id: '9007199254740993',
    amount: '0012.34',
    native_state: 'UNKNOWN',
  };
  for (const retryable of [false, true]) {
    const error = new MirrorError('PORTFOLIO_INVALID_RESPONSE', 'Native inventory refusal', details, 400, retryable);
    const result = errorResult(error, 'original-request-reference', 7);
    assert.equal(result.success, false);
    assert.equal(result.error.code, error.code);
    assert.equal(result.error.message, error.message);
    assert.equal(result.error.details, details);
    assert.equal(result.error.retryable, retryable);
    assert.equal(error.status, 400);
    assert.equal(result.error.category, 'provider');
    assert.deepEqual(result.error.remedy, {
      category: 'provider',
      owner: 'provider',
      action: hint,
      mutation_retry_safe: false,
    });
    assert.equal(result.error.next_action, hint);
    assert.equal(result.meta.requestId, 'original-request-reference');
    assert.equal(result.meta.untrusted_provider_content, undefined);
    assert.equal(result.meta.untrusted_paths, undefined);
  }
});
test('an original provider error body retains stronger access guidance and untrusted-content labeling', () => {
  const upstream = {message: 'Native diagnostic <img>', code: '00123'},
    result = errorResult(
      new MirrorError('PORTFOLIO_INVALID_RESPONSE', 'Native failure', {upstream}),
      'original-request',
      0,
    );
  assert.equal(result.error.category, 'provider');
  assert.equal(result.error.remedy.owner, 'provider_or_account_admin');
  assert.match(result.error.next_action, /Inspect the native error and request ID/);
  assert.notEqual(result.error.next_action, hint);
  assert.equal(result.error.remedy.mutation_retry_safe, false);
  assert.equal(result.error.details.upstream, upstream);
  assert.ok(result.meta.untrusted_provider_content);
  assert.deepEqual(result.meta.untrusted_paths, ['error.details.upstream']);
});
test('inventory-specific guidance leaves input corrections, provider failures and uncertain writes in their original families', () => {
  const expected = [
    ['INVALID_ARGUMENT', 'request', /argument the message names/],
    ['PORTFOLIO_UNQUALIFIED', 'request', /Correct what the message names/],
    ['STATE_TARGET_MISMATCH', 'state', /different object/],
    ['UPSTREAM_RESPONSE_INVALID', 'provider', /Inspect the native error and request ID/],
    ['MEDIA_RESPONSE_INVALID', 'provider', /do not resubmit/],
    ['REPORT_SHAPE_CHANGED', 'provider', /do not resubmit/],
    ['WRITE_OUTCOME_UNCERTAIN', 'state', /Do not create another resource/],
    ['X_TARGETING_OUTCOME_UNCERTAIN', 'state', /original review\/key/],
  ];
  for (const [code, category, action] of expected) {
    const result = errorResult(new MirrorError(code, 'Fixture'), 'original-reference', 0);
    assert.equal(result.error.category, category, code);
    assert.equal(result.error.remedy.mutation_retry_safe, false, code);
    assert.match(result.error.next_action, action, code);
    assert.notEqual(result.error.next_action, hint, code);
  }
});
test('shared locale gate requires the authored inventory remedy and both formatters keep the original envelope', () => {
  const required = inspectSharedRecoveryHints(fs.readFileSync('src/errors.ts', 'utf8'), 'src/errors.ts');
  assert.ok(required.has(hint));
  assert.deepEqual(localeProblems(catalog, new Set([hint])), []);
  assert.match(catalog[hint], /[\u0600-\u06ff]/);
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale),
      result = errorResult(
        new MirrorError('PORTFOLIO_INVALID_RESPONSE', 'Google returned an invalid account currency.'),
        'inventory-original-reference',
        0,
      ),
      original = JSON.stringify(result);
    f.context.response = result;
    f.context.error = f.run('requestError(response)');
    const displayed = f.run('errorMessage(error)');
    assert.ok(displayed.includes(locale === 'ar' ? catalog[hint] : hint));
    assert.ok(displayed.includes('inventory-original-reference'));
    assert.equal(JSON.stringify(result), original);
    assert.equal(f.context.error.next_action, hint);
  }
});
for (const provider of ['google', 'meta', 'linkedin', 'snapchat', 'tiktok', 'x'])
  test(
    'actual ' + provider + ' collector and input guard retain their native refusal and zero-retry recovery boundary',
    async () => {
      const f = portfolioRefusalFixture(provider);
      try {
        const before = JSON.stringify(f.input),
          result = await f.service.call('amcp_workspace', f.input, f.actor);
        assert.equal(result.success, false);
        assert.equal(result.error.code, f.code);
        assert.equal(result.error.message, f.message);
        assert.equal(result.error.category, 'provider');
        assert.equal(result.error.next_action, hint);
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.remedy.mutation_retry_safe, false);
        assert.equal(f.requests.length, 1);
        assert.equal(JSON.stringify(f.input), before);
        const invalid = await f.service.call('amcp_workspace', {...f.input, limit: 0}, f.actor);
        assert.equal(invalid.success, false);
        assert.equal(invalid.error.code, 'INVALID_ARGUMENT');
        assert.equal(invalid.error.category, 'request');
        assert.notEqual(invalid.error.next_action, hint);
        assert.equal(f.requests.length, 1, 'Invalid input must not read; displaying recovery must not retry');
        for (const kind of ['decision_report', 'campaign_plan', 'write_review'])
          assert.equal(f.store.documents(f.actor.tenantId, kind).length, 0);
      } finally {
        f.close();
      }
    },
  );
