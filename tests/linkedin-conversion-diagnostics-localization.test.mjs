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
  // Package r25-m3-pmax (Round 2.5, M3: L2-07) declares four remedies in Google's own table (src/google-remedies.ts) and none in
  // src/errors.ts, as tests/shared-recovery-localization.test.mjs counts them: 191 + 4 = 195 in all, and 194 without the inventory
  // hint, on its own base. A merge with another package that declares remedies measures the merged count; it does not add pins.
  // Package r25-m3-trees (Round 2.5, M3, item 9) declares six remedies in Google's own table (src/google-remedies.ts), as
  // tests/shared-recovery-localization.test.mjs counts them: 191 + 6 = 197 in all, and 196 without the inventory hint.
  // Round 2 (lead review of r25-m3-trees), S3-4: one more rule in Google's own table, as tests/shared-recovery-localization.test.mjs counts
  // it: 197 + 1 = 198 in all, and 197 without the inventory hint.
  // Merge r25-m3-merge, merge 3: r25-m3-trees (198 in all and 197 without the inventory hint on its own base of 191 and 190) on the 195
  // above. pmax and trees declare different remedies, so the merged count is measured by this test's own inspector, not either pin:
  // 191 + 4 (pmax) + 7 (trees) = 202 in all, and 201 without the inventory hint.
  // Package r25-field-tiktok (round 2, the lead's review S3-1) declares one remedy in TikTok's own table (src/tiktok-remedies.ts): the
  // one of a Smart+ ad create or edit that breaks several rules, as tests/shared-recovery-localization.test.mjs counts it: 191 + 1 = 192
  // in all, and 191 without the inventory hint.
  // Merge r25-m3-merge, merge 7: r25-field-tiktok (192 in all and 191 without the inventory hint on its own base of 191 and 190) on the
  // 202 above. tiktok declares one remedy in its own table and the Google ones are other codes, so the merged count is measured by this
  // test's own inspector, not either pin: 191 + 4 (pmax) + 7 (trees) + 1 (tiktok) = 203 in all, and 202 without the inventory hint.
  // Package r25-media-drive-large (item 2) adds three in src/errors.ts, the next steps of a public Drive download refused because the
  // file is not shared, because Google limits its downloads and because Google flagged it (as tests/shared-recovery-localization.test.mjs
  // counts them): 194 in all, and 193 without the inventory hint.
  // Merge r25-m3-merge, merge 8: r25-media-drive-large (194 in all and 193 without the inventory hint on its own base of 191 and 190) on
  // the 203 above. media's three remedies are in src/errors.ts and no other package adds one there, so the merged count is measured by
  // this test's own inspector, not either pin: 191 + 4 (pmax) + 7 (trees) + 1 (tiktok) + 3 (media) = 206 in all, and 205 without the
  // inventory hint.
  // Package r25-field2-google (G3) adds one in src/errors.ts (familyRemedy): the next step of a *_STATE_UNVERIFIED refusal whose
  // details.reason is goal_graph_rule, as tests/shared-recovery-localization.test.mjs counts it. Measured by this test's own inspector
  // on its own base (lead review S2-1, which found this pin left behind): 206 + 1 = 207 in all, and 206 without the inventory hint.
  // Package r25-m4-smartedits (item 3) declares one more remedy in TikTok's own table (src/tiktok-remedies.ts), the one of a Smart+ ad edit whose
  // ad_configuration_patch AMCP merged, as tests/shared-recovery-localization.test.mjs counts it: 206 + 1 = 207 in all, and 206 without the inventory hint.
  // Merge r25-m4a-merge, merge 4: r25-m4-smartedits (207 in all and 206 without the inventory hint on its own base of 206 and 205) on the 207 and 206 above. smartedits' remedy (TikTok's own table) and field2-google's (src/errors.ts) are two different hints, so the merged count is measured by this test's own inspector, not either pin: 206 + 1 (field2-google) + 1 (smartedits) = 208 in all, and 207 without the inventory hint.
  // Package r25-field2-access (B3) adds one in src/errors.ts (reviewRemedy): the next step of GTM_ACCOUNT_NOT_CONNECTED, as
  // tests/shared-recovery-localization.test.mjs counts it: 207 + 1 = 208 in all, and 207 without the inventory hint.
  // Merge r25-m4a-merge, merge 8: r25-field2-access (208 in all and 207 without the inventory hint on its own base of 207 and 206) on the 208 and 207 above. field2-access's remedy (src/errors.ts) and smartedits' (TikTok's own table) are two different hints, so, measured with this test's own inspector: 208 + 1 = 209 in all, and 208 without the inventory hint.
  // Package r25-field3-livefix (item 7) adds one in src/errors.ts (reviewRemedy): the allowlist remedy of a refusal of the app_eligibility layer (TikTok's code 40118, and its
  // code 40002 with the message that the account has no access to a Search campaign type), as tests/shared-recovery-localization.test.mjs counts it: 209 + 1 = 210 in all, and 209
  // without the inventory hint. Its item 8 adds one more in src/errors.ts (reviewRemedy): the remedy of a Smart+ object that is deleted or sits under a deleted campaign or ad group
  // (STATE_TARGET_MISMATCH with details.blocked_by): 210 + 1 = 211 in all, and 210 without the inventory hint. None in a provider's table.
  assert.equal(hints.size, 211);
  assert.ok(hints.has(inventoryHint));
  assert.equal([...hints].filter(hint => hint !== inventoryHint).length, 210);
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
