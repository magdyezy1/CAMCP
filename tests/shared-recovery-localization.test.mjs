import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  inspectSharedRecoveryHints,
  inspectGoogleCaptureRemedies,
  inspectProviderCaptureRemedies,
  inspectMeasurementRemedies,
  localeProblems,
} from '../tools/check-locales.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  source = readFileSync('src/errors.ts', 'utf8'),
  hints = inspectSharedRecoveryHints(source, 'src/errors.ts');
test('shared recovery ownership includes only literal hints in the three exact authored functions and lookup positions', () => {
  const sample =
    "function familyRemedy(code){r('state','Owned family.');native.r('state','Native method.');r('state',native.message??'Native fallback.');} export function errorRemedy(e){const stateRead={STATE_TOO_LARGE:'Owned state.',NATIVE_CODE:native.message};const other={STATE_TOO_LARGE:'Other state.'};return {action:e.code==='CODE'?'Owned branch.':ready?'Owned nested branch.':native.message};} export function errorResult(e){const remediation={OWNER_REQUIRED:'Owned legacy hint.',NATIVE_CODE:native.message};return {message:'Unselected message.',details:{native:'Unselected detail.'}};} function other(){return {action:'Unrelated function.'};}";
  const expected = ['Owned family.', 'Owned state.', 'Owned branch.', 'Owned nested branch.', 'Owned legacy hint.'];
  assert.deepEqual([...inspectSharedRecoveryHints(sample, 'src/errors.ts')], expected);
  assert.deepEqual([...inspectSharedRecoveryHints(sample, 'src\\errors.ts')], expected);
  for (const file of ['tests/errors.ts', 'src/native-errors.ts', 'src/errors-other.ts'])
    assert.equal(inspectSharedRecoveryHints(sample, file).size, 0);
  assert.equal(inspectGoogleCaptureRemedies(source, 'src/errors.ts').size, 5);
  assert.equal(inspectProviderCaptureRemedies(source, 'src/errors.ts').size, 8);
  assert.equal(inspectMeasurementRemedies(source, 'src/errors.ts').size, 12);
});
test('all 138 shared recovery hints have authored Arabic with exact native tool fields and quantities', () => {
  assert.equal(hints.size, 138);
  const inventoryHint = errorResult(new MirrorError('PORTFOLIO_INVALID_RESPONSE', 'Fixture'), 'ref', 0).error
    .next_action;
  assert.ok(hints.has(inventoryHint));
  assert.equal([...hints].filter(hint => hint !== inventoryHint).length, 137);
  assert.deepEqual(localeProblems(catalog, hints), []);
  for (const hint of hints) {
    assert.match(catalog[hint], /[\u0600-\u06ff]/);
    for (const token of new Set(
      hint.match(
        /\b(?:amcp_[a-z_]+|MIRROR_MASTER_KEY|[a-z]+(?:_[a-z0-9]+)+|details\.[a-z_]+|changes\.drop|FILTERED)\b/g,
      ) ?? [],
    ))
      assert.ok(catalog[hint].includes(token), 'Missing native token ' + token);
    for (const quantity of new Set(hint.match(/\b\d[\d,]*\b/g) ?? []))
      assert.ok(catalog[hint].includes(quantity), 'Missing declared quantity ' + quantity);
  }
});
test('the actual formatter displays every shared hint in both languages without changing its original envelope', () => {
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale);
    for (const hint of hints) {
      const response = errorResult(
        new MirrorError('NATIVE_CODE', 'Original <img> diagnostic 00123', {
          native_id: '9007199254740993',
          amount: '0012.34',
          currency: 'SAR',
          state: 'UNKNOWN',
        }),
        'shared-recovery-reference',
        0,
      );
      // Evaluate display ownership independently of which code branch selects this authored hint.
      response.error.next_action = hint;
      response.error.remedy.action = hint;
      const before = JSON.stringify(response);
      f.context.response = response;
      f.context.error = f.run('requestError(response)');
      const display = f.run('errorMessage(error)');
      assert.ok(display.includes('Original <img> diagnostic 00123'));
      assert.ok(display.includes(locale === 'ar' ? catalog[hint] : hint));
      assert.ok(display.includes('shared-recovery-reference'));
      assert.equal(f.context.error.code, 'NATIVE_CODE');
      assert.equal(f.context.error.details, response.error.details);
      assert.equal(f.context.error.details.native_id, '9007199254740993');
      assert.equal(JSON.stringify(response), before);
      assert.equal(response.error.remedy.mutation_retry_safe, false);
    }
  }
});
test('actual safety-critical remedy branches remain distinct and never change submitted-write retry authority', () => {
  const codes = {
    WRITE_OUTCOME_UNCERTAIN: 'state',
    WRITE_PARTIAL_OR_FAILED: 'provider',
    STATE_CHANGED: 'state',
    REVIEW_EXPIRED: 'state',
    WRITES_PAUSED: 'policy',
    LIVE_WRITES_DISABLED: 'deployment',
    WRITE_CONTRACT_UNAVAILABLE: 'contract',
    WRITE_ACCOUNT_FORBIDDEN: 'grant',
    RESOURCE_SCOPE_REQUIRED: 'grant',
    PROVIDER_ACCESS_DENIED: 'provider',
    INSUFFICIENT_SCOPE: 'grant',
    ENCRYPTION_REQUIRED: 'deployment',
    TOKEN_REFRESH_FAILED: 'provider',
    CONNECTION_REQUIRED: 'grant',
    AMBIGUOUS_CONNECTION: 'request',
    POLICY_BUDGET_LIMIT: 'policy',
    PAUSED_CREATION_REQUIRED: 'request',
    STATE_READ_FAILED: 'state',
    STATE_NOT_FOUND: 'state',
    STATE_TOO_LARGE: 'state',
    STATE_TARGET_MISMATCH: 'state',
    INCOMPLETE_STATE: 'state',
    MEDIA_UPLOAD_INCOMPLETE: 'request',
    MEDIA_PARTS_BUSY: 'state',
    MEDIA_CHANGED: 'state',
    INVALID_ARGUMENT: 'request',
  };
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale);
    for (const [code, category] of Object.entries(codes)) {
      const response = errorResult(new MirrorError(code, 'Original refusal 00123'), 'critical-recovery-reference', 0),
        before = JSON.stringify(response);
      assert.equal(response.error.category, category, code);
      assert.equal(response.error.remedy.mutation_retry_safe, false, code);
      assert.ok(hints.has(response.error.next_action), code + ' next action');
      assert.ok(hints.has(response.error.remedy.action), code + ' remedy');
      f.context.response = response;
      f.context.error = f.run('requestError(response)');
      assert.ok(
        f
          .run('errorMessage(error)')
          .includes(locale === 'ar' ? catalog[response.error.next_action] : response.error.next_action),
      );
      assert.equal(JSON.stringify(response), before);
    }
  }
});
test('native and changed recovery text remains literal and superseded requests remain silent', () => {
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale);
    for (const hint of ['Native hint <img> 00123', 'Use the request ID to inspect the audit trail. Native says X']) {
      const response = {
          success: false,
          error: {
            code: 'NATIVE_CODE',
            message: 'Native failure',
            next_action: hint,
            remedy: {mutation_retry_safe: false},
            details: {id: '9007199254740993'},
          },
          meta: {requestId: 'native-reference'},
        },
        before = JSON.stringify(response);
      f.context.response = response;
      f.context.error = f.run('requestError(response)');
      assert.ok(f.run('errorMessage(error)').includes(hint));
      assert.equal(JSON.stringify(response), before);
    }
    f.context.error = f.run('supersededRequest()');
    f.context.error.message = 'Obsolete native diagnostic';
    assert.equal(f.run('errorMessage(error)'), '');
  }
});
