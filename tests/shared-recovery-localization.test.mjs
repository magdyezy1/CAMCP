import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  inspectSharedRecoveryHints,
  inspectGoogleCaptureRemedies,
  inspectProviderCaptureRemedies,
  inspectMeasurementRemedies,
  localeProblems,
  providerRemedyModules,
  sharedRecoveryHints,
} from '../tools/check-locales.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {assertWebsiteRemedy} from './fixtures/website-remedy.mjs';
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  source = readFileSync('src/errors.ts', 'utf8'),
  // ARC-04 stage C: errorRemedy's hints and those of the providers' remedy tables it consults first.
  hints = sharedRecoveryHints();
test('shared recovery ownership includes only literal hints in the exact authored functions, the providers’ remedy tables and lookup positions', () => {
  // errorRemedy's shared rules sit in three functions it consults in order (ARC-04 stage C); workflowRemedy stands for
  // them here.
  const sample =
    "function familyRemedy(code){r('state','Owned family.');native.r('state','Native method.');r('state',native.message??'Native fallback.');} export function errorRemedy(e){const stateRead={STATE_TOO_LARGE:'Owned state.',NATIVE_CODE:native.message};const other={STATE_TOO_LARGE:'Other state.'};return {action:e.code==='CODE'?'Owned branch.':ready?'Owned nested branch.':native.message};} function workflowRemedy(e){if(e.code==='X')return {action:'Owned shared rule.'};} export function errorResult(e){const remediation={OWNER_REQUIRED:'Owned legacy hint.',NATIVE_CODE:native.message};return {message:'Unselected message.',details:{native:'Unselected detail.'}};} function other(){return {action:'Unrelated function.'};}";
  const expected = [
    'Owned family.',
    'Owned state.',
    'Owned branch.',
    'Owned nested branch.',
    'Owned shared rule.',
    'Owned legacy hint.',
  ];
  assert.deepEqual([...inspectSharedRecoveryHints(sample, 'src/errors.ts')], expected);
  assert.deepEqual([...inspectSharedRecoveryHints(sample, 'src\\errors.ts')], expected);
  for (const file of ['tests/errors.ts', 'src/native-errors.ts', 'src/errors-other.ts', 'src/meta-remedies-other.ts'])
    assert.equal(inspectSharedRecoveryHints(sample, file).size, 0);
  // A provider's remedy table: the action of every remedy it declares, whatever function it sits in.
  const table =
    "export const metaRemedies=[{codes:['META_X'],remedy:{category:'state',owner:'operator',action:'Owned provider remedy.',mutation_retry_safe:false}},{codes:['META_Y'],remedy:{category:'state',action:ready?'Owned branch two.':'Owned branch three.'}}]; const note={message:'Unselected message.'};";
  assert.deepEqual(
    [...inspectSharedRecoveryHints(table, 'src/meta-remedies.ts')],
    ['Owned provider remedy.', 'Owned branch two.', 'Owned branch three.'],
  );
  assert.ok(providerRemedyModules.includes('src/meta-remedies.ts'));
  // The inventory is the union of errorRemedy's and the tables', each hint once.
  const parts = ['src/errors.ts', ...providerRemedyModules].map(
    file => inspectSharedRecoveryHints(readFileSync(file, 'utf8'), file).size,
  );
  assert.equal(
    parts.reduce((a, b) => a + b, 0),
    hints.size,
  );
  assert.equal(inspectGoogleCaptureRemedies(source, 'src/errors.ts').size, 5);
  assert.equal(inspectProviderCaptureRemedies(source, 'src/errors.ts').size, 8);
  assert.equal(inspectMeasurementRemedies(source, 'src/errors.ts').size, 12);
});
test('all 178 shared recovery hints have authored Arabic with exact native tool fields and quantities', () => {
  // 163 since SEC-08 added ACCOUNT_SCOPE_RESTRICTED's remedy, CMP-03 added LOCATION_PARENT_NOT_PAUSED's remedy
  // (Microsoft location criteria of a campaign not paused), and PRV-06 added the REDDIT_PIXEL_NOT_IN_ACCOUNT,
  // SNAPCHAT_SEGMENT_UNAVAILABLE, META_ADVANTAGE_CREATIVE_CHOICE_REQUIRED and
  // META_ADVANTAGE_CREATIVE_FEATURE_UNAVAILABLE remedies; 164 since owner decision P5 added POLICY_CURRENCY_UNSET's;
  // 166 since CMP-03's Microsoft location lookup added two (MICROSOFT_LOCATIONS_UNPINNED, and one for an unreadable or
  // unavailable locations file); 167 since ARC-01 added the remedy of a provider parked by the owner
  // (GATEWAY_NOT_OFFERED with reason owner_parked: Criteo, WooCommerce). ARC-04 stage C moved 27 of them, the
  // providers' own, into their remedy tables (src/*-remedies.ts): 140 in src/errors.ts, the same 167 in all. Package mcp-surface
  // (V2-MCP-06) adds the two remedies of MEDIA_REVIEW_REQUIRED, with and without the call it names, to src/errors.ts: 142, 169 in all.
  // Package r25-hotfix item 1 adds the remedy of a TikTok report whose page counts the check refused, to TikTok's own table
  // (src/tiktok-remedies.ts): 142 in src/errors.ts, 170 in all. Item 2 adds the remedy of a provider response that does
  // not match the pinned contract of its route, to src/errors.ts: 143, 171 in all.
  // Package r25-m0-errors (Round 2.5, M0: LEAD-01) adds the next steps of CAPABILITY_ACCOUNT_UNAVAILABLE's five causes: the
  // one for an account no connection covers is CONNECTION_REQUIRED's sentence (one string), so four are new: 146, 173 in all
  // (on the integration's 142 and 169, before the hotfix).
  // Its LEAD-03 adds the next step of the refusal of workspace health (OWNER_REQUIRED with required_role "owner or
  // administrator"): 147, 174 in all.
  // Its L3-02 adds the next step of a write the provider throttled after it was sent (PLATFORM_RATE_LIMIT with the status
  // call of an uncertain write): 148, 175 in all.
  // Merge r25-m0-merge, with r25-hotfix (143 in src/errors.ts, 171 in all on its own base) and r25-m0-errors (148, 175): both
  // started from 142 and 169 and add different hints, so no package's own pin is the merged count. Measured on the merged tree
  // (the inspectors this test uses: sharedRecoveryHints and inspectSharedRecoveryHints over src/errors.ts): 142 + 1 (hotfix item
  // 2) + 6 (errors) = 149 in src/errors.ts, and 169 + 2 (hotfix) + 6 (errors) = 177 in all.
  // Package r25-m0-live (Round 2.5) adds LinkedIn's remedy for an empty analytics answer to its table (item 3, src/linkedin-remedies.ts)
  // and, to src/errors.ts, the remedy of an account ID the request names twice, differently (item 4): 143, 171 in all. Its review fix
  // S2-1 declares, in TikTok's own table (src/tiktok-remedies.ts), the remedy of a report whose page counts the check refused, worded
  // for people as r25-hotfix item 1 declared it for MCP clients: 143 in src/errors.ts, 172 in all (the LinkedIn remedy is reworded, not added).
  // Merge r25-m0-merge, live (143 in src/errors.ts and 172 in all on its own base of 142 and 169) on the 177 above: the hotfix and
  // live declare the same TikTok page-count remedy in TikTok's own table, live's wording wins (the lead's decision of 2026-11-15),
  // and it is one hint, not two. What live adds on top of the hotfix and errors is LinkedIn's remedy (+1, its own table) and the
  // account-conflict remedy (+1, src/errors.ts): 169 + 1 (hotfix, upstream response) + 1 (the TikTok remedy, once) + 6 (errors)
  // + 2 (live) = 179 in all, and 142 + 1 + 6 + 1 = 150 in src/errors.ts, as this test's own inspectors measure them on the
  // merged tree. (Live's note for the hotfix alone, 173 and 144, is this plus the errors package's six.)
  // Package r25-m1-diff (Round 2.5, M1: L5-04, T2) adds the remedy of the refusal of a review's state check (STATE_CHANGED with
  // the two hashes and the changed fields: nothing was sent, what to check, and that no flag skips the check) to src/errors.ts;
  // its next step is the same sentence, so it is one hint: 151 in src/errors.ts, 180 in all, on its own base.
  // Lead review S2-2 (r25-m1-diff) adds the remedy of the same check refused after a claim (a media resume: part of the upload
  // may have been sent, so check its status or receipt and never send it again blindly), again one hint: 152 in src/errors.ts,
  // 181 in all.
  assert.equal(hints.size, 181);
  assert.equal(inspectSharedRecoveryHints(source, 'src/errors.ts').size, 152);
  const inventoryHint = errorResult(new MirrorError('PORTFOLIO_INVALID_RESPONSE', 'Fixture'), 'ref', 0).error
    .next_action;
  assert.ok(hints.has(inventoryHint));
  assert.equal([...hints].filter(hint => hint !== inventoryHint).length, 180);
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
      // WEB-03: a hint written for an MCP client gives way to the website's own wording.
      assertWebsiteRemedy(f, display, hint, locale === 'ar' ? catalog[hint] : hint);
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
    const f = accountWorkflowFixture(locale),
      replaced = new Map(),
      t = text => (locale === 'ar' ? catalog[text] : text);
    for (const [code, category] of Object.entries(codes)) {
      const response = errorResult(new MirrorError(code, 'Original refusal 00123'), 'critical-recovery-reference', 0),
        before = JSON.stringify(response);
      assert.equal(response.error.category, category, code);
      assert.equal(response.error.remedy.mutation_retry_safe, false, code);
      assert.ok(hints.has(response.error.next_action), code + ' next action');
      assert.ok(hints.has(response.error.remedy.action), code + ' remedy');
      f.context.response = response;
      f.context.error = f.run('requestError(response)');
      const display = f.run('errorMessage(error)');
      // WEB-03: a hint written for an MCP client gives way to the website's own wording.
      assertWebsiteRemedy(f, display, response.error.next_action, t(response.error.next_action));
      f.context.websiteRemedyHint = response.error.next_action;
      if (f.run('agentDirected(websiteRemedyHint)')) {
        replaced.set(code, f.run('websiteRemedy(error)'));
        // The website wording keeps the safety facts the server remedy states (regression: the category fallback
        // dropped "Never resubmit an uncertain mutation").
        if (/never resubmit|is never resubmitted/i.test(response.error.next_action))
          assert.ok(display.includes(t('A change whose outcome is not confirmed is never sent again.')), code);
        if (/never authorizes a write/i.test(response.error.next_action))
          assert.ok(display.includes(t('A failed or incomplete read never authorizes a change.')), code);
      }
      // A refusal the page words itself (an uncertain write, design review 2026-10) keeps the server remedy's safety
      // facts in its words: AMCP sends nothing again, and the person does not repeat the change unless a read-back or
      // the account shows it was not applied (the server says "Do not create another resource or use a new idempotency
      // key"). A remedy without the second fact would let a person recreate a resource the provider may already have
      // applied; worded as "before you repeat the change yourself" it read as an invitation to repeat (review fix).
      if (f.run("websiteOwnMessage(error) !== ''")) {
        assert.equal(code, 'WRITE_OUTCOME_UNCERTAIN');
        assert.match(response.error.next_action, /Do not create another resource/);
        const own = t(
          'AMCP never sends it again. Do not repeat the change unless a read-back or the account itself shows it was not applied; a read-back changes nothing.',
        );
        assert.ok(own && display.includes(own), code);
        assert.doesNotMatch(display, /repeat the change yourself/, code);
        assert.ok(display.includes('critical-recovery-reference'), code);
      }
      assert.equal(JSON.stringify(response), before);
    }
    // Each replaced remedy is the page's own wording for that refusal, never one shared text for several of them.
    assert.ok(replaced.has('INVALID_ARGUMENT') && replaced.has('STATE_TARGET_MISMATCH'), [...replaced.keys()].join());
    assert.equal(new Set(replaced.values()).size, replaced.size, JSON.stringify([...replaced]));
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
