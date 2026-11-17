import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parsers} from 'prettier/plugins/babel';
import {inspectMeasurementFailures, localeProblems, sharedRecoveryHints} from '../tools/check-locales.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {assertWebsiteRemedy} from './fixtures/website-remedy.mjs';
const file = 'src/linkedin-conversion-evidence.ts',
  source = readFileSync(file, 'utf8'),
  catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  labels = [
    'Registration method',
    'Reported ownership',
    "This view requests LinkedIn's default owned-rule selection. Shared rules are not requested. Missing method or ownership fields stay unknown.",
    'Search name, ID, type, method or ownership.',
  ];
test('LinkedIn conversion failure selector owns only exact source helpers and literal diagnostic positions', () => {
  const sample =
    "bad('Owned scope.','INSUFFICIENT_SCOPE');invalid('Owned evidence.');bad(native.message??'Unselected fallback.','NATIVE_CODE');invalid(native.error.message);new MirrorError('NATIVE_CODE','Unselected native reason.');const data={conversionMethod:'CONVERSIONS_API',ownershipType:'OWNED',message:'Unselected field.'};";
  for (const name of [file, file.replaceAll('/', '\\')])
    assert.deepEqual([...inspectMeasurementFailures(sample, name)], ['Owned scope.', 'Owned evidence.']);
  for (const name of [
    'src/linkedin-evidence.ts',
    'tests/linkedin-conversion-evidence.ts',
    'src/other-linkedin-conversion-evidence.ts',
  ])
    assert.equal(inspectMeasurementFailures(sample, name).size, 0);
  const hints = sharedRecoveryHints(),
    inventoryHint = errorResult(new MirrorError('PORTFOLIO_INVALID_RESPONSE', 'Fixture'), 'ref', 0).error.next_action;
  // The shared inventory of tests/shared-recovery-localization.test.mjs (SEC-08, CMP-03 and ARC-01 added one remedy
  // each, PRV-06 four, owner decision P5 one, and CMP-03's Microsoft location lookup two): errorRemedy's in
  // src/errors.ts and the providers' remedy tables it consults first (ARC-04 stage C). Package mcp-surface (V2-MCP-06) adds
  // two: the remedies of MEDIA_REVIEW_REQUIRED, with and without the call it names. Package r25-hotfix item 1 adds one, in
  // TikTok's own table: the remedy of a report whose page counts the check refused. Item 2 adds one, in src/errors.ts: the
  // remedy of a provider response that does not match the pinned contract of its route. Package r25-m0-errors (Round 2.5,
  // M0) adds six: the next steps of CAPABILITY_ACCOUNT_UNAVAILABLE's four causes that had none of their own (LEAD-01), of
  // the health refusal (LEAD-03) and of a write the provider throttled after it was sent (L3-02), as the shared inventory
  // counts them. Merge r25-m0-merge: the hotfix's pin (171 on its own base) and the errors package's (175) both started
  // from 169 and add different hints, so the merged count is measured, not either pin: 169 + 2 + 6 = 177.
  // Package r25-m0-live (Round 2.5) adds two: LinkedIn's
  // remedy for an empty analytics answer (item 3, src/linkedin-remedies.ts) and the remedy of an account ID the request names twice,
  // differently (item 4, src/errors.ts): 171. Its review fix S2-1 adds one more, in TikTok's own table (src/tiktok-remedies.ts): the
  // remedy of a report whose page counts the check refused, worded for people (the one r25-hotfix item 1 declares for MCP clients): 172.
  // Merge r25-m0-merge, live on the 177 above: the hotfix and live declare that same TikTok remedy and it is one hint (live's
  // wording wins, the lead's decision of 2026-11-15), so live adds LinkedIn's remedy and the account-conflict remedy on top of
  // the hotfix and errors; the merged count is measured by this test's own inspector, not either pin: 177 + 2 = 179.
  // Package r25-m1-diff (Round 2.5, M1: L5-04, T2) adds one in src/errors.ts: the remedy of the refusal of a review's state
  // check (STATE_CHANGED with the two hashes and the changed fields), whose next step is the same sentence, so it is one
  // hint: 180 in all, on its own base (the pin of tests/shared-recovery-localization.test.mjs moved with it). Lead review S2-2
  // adds one more: the remedy of the same check refused after a claim (a media resume), 181 in all.
  // Package r12-fix (item 3, V2-RPT-05) declares five remedies in the providers' own tables, none in src/errors.ts: Snapchat's four for
  // a stats answer whose timestamp AMCP refused (src/snapchat-remedies.ts) and X's one for an entity whose parent is in neither
  // list (src/x-remedies.ts): 179 + 5 = 184, as tests/shared-recovery-localization.test.mjs counts them.
  // Merge r25-m1-merge, merge 3: r12-fix (184 on its own base of 179) on the diff package's 181. They add different hints, so no
  // package's own pin is the merged count; the merged count is measured by this test's own inspector, not either pin:
  // 179 + 2 (diff) + 5 (r12-fix) = 186, and 185 without the inventory hint.
  // Package r25-m2-reconcile's rework (lead review S3-5) adds three in src/errors.ts, none in a provider's table: the remedies of
  // DUPLICATE_OF_UNCERTAIN_WRITE (one for a create AMCP can look up, one for a create it cannot) and of DUPLICATE_OF_COMPLETED_WRITE,
  // three different sentences: 186 + 3 = 189 in all, 188 without the inventory hint.
  // Package r25-m2-refusal (Round 2.5, M2: L1-08) declares one remedy in TikTok's own table (src/tiktok-remedies.ts), the one of a
  // parameter refusal TikTok declared in an HTTP 200 answer, which AMCP rejects: 186 + 1 = 187, and 186 without the inventory hint.
  // Merge r25-m2-merge, merge 2: refusal (187 on its own base of 186) on reconcile's 189. They add different hints (reconcile's three
  // are in src/errors.ts, refusal's one in TikTok's own table), so no package's own pin is the merged count; the merged count is
  // measured by this test's own inspector: 186 + 3 (reconcile) + 1 (refusal) = 190 in all, and 189 without the inventory hint.
  // Package r12-gpreview (item 3) adds one in src/errors.ts: the remedy of a write whose provider answer did not match what AMCP
  // reviewed (WRITE_PARTIAL_OR_FAILED with native_response_valid false), as tests/shared-recovery-localization.test.mjs counts it:
  // 187 in all, and 186 without the inventory hint, on its own base.
  // Merge r25-m2-merge, merge 3: gpreview (187 on its own base of 186) on the 190 above. Its one hint is in src/errors.ts and no other
  // package adds it, so the merged count is measured by this test's own inspector, not either pin: 186 + 3 (reconcile) + 1 (refusal)
  // + 1 (gpreview) = 191 in all, and 190 without the inventory hint.
  assert.equal(hints.size, 191);
  assert.ok(hints.has(inventoryHint));
  assert.equal([...hints].filter(hint => hint !== inventoryHint).length, 190);
});
test('all 26 LinkedIn authored conversion failures and four metadata/search labels have Arabic coverage', () => {
  const failures = inspectMeasurementFailures(source, file);
  assert.equal(failures.size, 26);
  const required = new Set([...failures, ...labels]);
  assert.equal(required.size, 30);
  assert.deepEqual(localeProblems(catalog, required), []);
  for (const label of required) {
    assert.match(catalog[label], /[\u0600-\u06ff]/);
    assert.notEqual(catalog[label], label);
  }
  for (const native of ['OWNED', 'SHARED', 'CONVERSIONS_API', 'conversionMethod', 'ownershipType', 'r_ads', 'rw_ads'])
    assert.equal(Object.hasOwn(catalog, native), false);
});
test('all authored conversion diagnostics format bilingually without altering codes, details, references or retry authority', () => {
  const values = [],
    walk = node => {
      if (!node || typeof node !== 'object') return;
      if (
        node.type === 'CallExpression' &&
        ['bad', 'invalid'].includes(node.callee?.name) &&
        node.arguments[0]?.type === 'StringLiteral'
      )
        values.push({
          message: node.arguments[0].value,
          code: node.callee.name === 'invalid' ? 'MEASUREMENT_EVIDENCE_INVALID' : node.arguments[1].value,
        });
      for (const [key, value] of Object.entries(node))
        if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
          for (const child of Array.isArray(value) ? value : [value]) walk(child);
    };
  walk(parsers['babel-ts'].parse(source));
  assert.equal(new Set(values.map(v => v.message)).size, 26);
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale);
    for (const {message, code} of values) {
      const response = errorResult(
          new MirrorError(code, message, {
            account_id: '100',
            conversion_id: '9007199254740993',
            native_ownership: 'FUTURE_<img>',
          }),
          'synthetic-conversion-diagnostic-reference',
          0,
        ),
        original = JSON.stringify(response);
      assert.equal(response.error.remedy.mutation_retry_safe, false);
      f.context.response = response;
      const error = f.run('requestError(response)');
      assert.equal(error.message, message);
      assert.equal(error.code, code);
      assert.equal(error.details, response.error.details);
      f.context.error = error;
      const display = f.run('errorMessage(error)');
      assert.ok(display.includes(locale === 'ar' ? catalog[message] : message));
      assert.ok(display.includes('synthetic-conversion-diagnostic-reference'));
      assert.equal(Object.hasOwn(catalog, response.error.next_action), true);
      // WEB-03: a hint written for an MCP client gives way to the website's own wording.
      assertWebsiteRemedy(
        f,
        display,
        response.error.next_action,
        locale === 'ar' ? catalog[response.error.next_action] : response.error.next_action,
      );
      assert.equal(JSON.stringify(response), original);
    }
  }
});
