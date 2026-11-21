import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyProviderError} from '../dist/src/provider-error-taxonomy.js';
import {MirrorError, errorRemedy} from '../dist/src/errors.js';
import {tiktokRejectionIsNonApplied} from '../dist/src/tiktok-write-rejection.js';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';
import {
  tiktokSearchContext,
  tiktokSearchDependencyEvidence,
  tiktokSearchRecipe,
} from '../dist/src/tiktok-search-recipe.js';
import {
  tiktokSmartPlusDependencyEvidence,
  tiktokSmartPlusSearchContext,
  tiktokSmartPlusSearchRecipe,
} from '../dist/src/tiktok-smart-plus-recipe.js';
import {tiktokSmartPlusSearchAllowlistNotice} from '../dist/src/tiktok-smart-plus-campaigns.js';
import {tiktokSearchBrief} from './fixtures/tiktok-search-build.mjs';
import {smartPlusSearchBriefs} from './fixtures/tiktok-smart-plus-search.mjs';

/**
 * R2.5 field3, package r25-field3-livefix, item 7 (the live check LV-30 of 2026-11-21): TikTok refused the Smart+ Search pack's campaign with code 40002 and
 * "Your account doesn't have access to this Search campaign type. Request access or choose a type your account supports.", and not with 40118, the code that
 * TikTok's Return codes page gives the allowlist ("The app or advertiser is not on the allowlist for accessing the feature"). The refusal read as a refused
 * parameter. It is the same refusal: it has the class of 40118 (PROVIDER_ACCESS_DENIED, the app_eligibility layer), and both have one remedy that names the
 * Search type. Only that sentence of the generic code 40002 is read so: every other 40002 stays a refused parameter. Synthetic bodies; nothing is sent.
 */
const sentence =
  "Your account doesn't have access to this Search campaign type. Request access or choose a type your account supports.";
const headers = {get: () => null};
const classify = body =>
  classifyProviderError({gateway: 'tiktok_native_action', status: 200, headers, body, readOnly: false, inBody: true});

test('code 40118 keeps its class, and the 40002 sentence about a Search campaign type has the same class', () => {
  const allowlist = classify({
    code: 40118,
    message: 'The app or advertiser is not on the allowlist for accessing the feature',
  });
  assert.deepEqual(
    [allowlist.code, allowlist.layer, allowlist.retryable, allowlist.providerCode, allowlist.documented],
    ['PROVIDER_ACCESS_DENIED', 'app_eligibility', false, 40118, true],
  );
  for (const message of [
    sentence,
    sentence.replace("'", '’'),
    sentence.toUpperCase(),
    'Sorry. ' + sentence + ' Contact your representative.',
  ]) {
    const typed = classify({code: 40002, message});
    assert.deepEqual(
      [typed.code, typed.layer, typed.retryable, typed.providerCode],
      ['PROVIDER_ACCESS_DENIED', 'app_eligibility', false, 40002],
      message,
    );
    // The pair was observed, not read in TikTok's return-code table.
    assert.equal(typed.documented, false);
  }
});

test('every other 40002 stays what it was, and the sentence under another code is no allowlist refusal', () => {
  for (const message of [
    'Your budget must be $50 or more.',
    'Creative portfolio does not exist',
    'Your account does not have access to this feature.',
    "Your account doesn't have access to this campaign type.",
    '',
    undefined,
    null,
    42,
  ]) {
    const other = classify({code: 40002, message});
    assert.equal(other.code === 'PROVIDER_ACCESS_DENIED' && other.layer === 'app_eligibility', false, String(message));
  }
  for (const code of [40000, 40001, 40007, 50000]) {
    const other = classify({code, message: sentence});
    assert.equal(other.layer === 'app_eligibility', false, String(code));
  }
});

test('the refusal is recorded as rejected like any 40002 in an HTTP 200 answer with no data, and carries one remedy that names the allowlist and the Search type', () => {
  const plan = {gateway: 'tiktok_native_action', readOnly: false};
  assert.equal(tiktokRejectionIsNonApplied(plan, 200, {code: 40002, message: sentence, data: {}}), true);
  assert.equal(tiktokRejectionIsNonApplied(plan, 200, {code: 40118, message: 'x', data: {}}), true);
  const refusal = code =>
    errorRemedy(
      new MirrorError('PROVIDER_ACCESS_DENIED', 'Platform reported an unsuccessful result.', {
        layer: 'app_eligibility',
        provider_code: code,
        submission: 'rejected',
        http_status: 200,
        upstream: {code},
      }),
    );
  const remedy = refusal(40002);
  assert.deepEqual(remedy, refusal(40118), 'one remedy for both codes');
  assert.deepEqual(
    [remedy.category, remedy.owner, remedy.mutation_retry_safe],
    ['provider', 'provider_or_account_admin', false],
  );
  assert.match(remedy.action, /allowlist/);
  assert.match(remedy.action, /Search type/);
  assert.match(remedy.action, /objective/);
  assert.match(remedy.action, /nothing was created or changed/);
  // A refusal of another layer keeps the shared advice of its code, and a 403 with no layer says what it always said.
  for (const details of [{}, {layer: 'role_or_asset_access'}, {layer: 'consent'}, {layer: 'unknown', upstream: {}}]) {
    const generic = errorRemedy(new MirrorError('PROVIDER_ACCESS_DENIED', 'Platform returned HTTP 403', details, 403));
    assert.doesNotMatch(generic.action, /allowlist/, JSON.stringify(details));
    assert.match(
      generic.action,
      /Check account access, granted scopes, app access tier and payload/,
      JSON.stringify(details),
    );
  }
});

test('every sentence of the two Search packs that names the allowlist refusal names both of its codes, so a caller is not sent to look for 40118 alone', () => {
  const connection = '19191919-1919-4191-8191-191919191919';
  const manual = campaignRecipe('tiktok_search_traffic', tiktokSearchBrief(connection));
  const smart = campaignRecipe('tiktok_smart_plus_search_website', smartPlusSearchBriefs(connection).clicks);
  const sentences = {
    'manual pack description': tiktokSearchRecipe.description,
    'manual pack context': tiktokSearchContext.limitations[0],
    'manual dependency evidence': tiktokSearchDependencyEvidence('search_ads_allowlist', {}).meaning,
    'manual campaign step': manual.steps[0].description,
    'manual brief': manual.recipe.allowlist_acceptance,
    'Smart+ pack description': tiktokSmartPlusSearchRecipe.description,
    'Smart+ pack context': tiktokSmartPlusSearchContext.limitations[0],
    'Smart+ dependency evidence': tiktokSmartPlusDependencyEvidence('smart_plus_search_allowlist', {
      assets: [],
      scope: {},
    }).meaning,
    'Smart+ campaign step': smart.steps[0].description,
    'Smart+ brief': smart.recipe.allowlist_acceptance,
    'Smart+ campaign notice': tiktokSmartPlusSearchAllowlistNotice,
  };
  assert.equal(Object.keys(sentences).length, 11);
  for (const [name, text] of Object.entries(sentences)) {
    assert.equal(typeof text, 'string', name);
    assert.match(text, /40118/, name);
    assert.match(text, /40002/, name);
    assert.match(text, /no access to this Search campaign type/, name);
  }
});
