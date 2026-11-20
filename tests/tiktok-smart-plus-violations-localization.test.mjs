import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {errorResult} from '../dist/src/errors.js';
import {assertTiktokSmartPlusAd} from '../dist/src/tiktok-smart-plus-ads.js';
import {assertTiktokSmartPlusAdUpdate} from '../dist/src/tiktok-smart-plus-ad-updates.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

/**
 * r25-field-tiktok (#6, round 2: the lead's review, S3-1). A Smart+ ad create or edit that breaks several rules of its contract is
 * refused once, with every violation in details.violations. The message of that refusal was a template with the first violation's
 * sentence as a value ("<first>, and 3 more ..."), which the website fills in as it is, so an Arabic page showed that sentence in
 * English. The website looks a message up in its catalogue as it is (web/app.js errorParts), so the message is now the first
 * violation's own sentence, exactly as a refusal of that one rule says it, and the count is in details (violations_count) and in the
 * remedy, worded for people, which has its own Arabic. Here a page in Arabic shows a refusal of two violations with no English
 * sentence, from the page's own code (the fixture runs web/app.js's error layer), for a create and for an edit.
 */
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const reference = 'synthetic-reference-0001';

// The faults of each request are rules with a sentence of their own, each with its Arabic in the catalogue (the sentences that name an
// ID or an unknown key are built per request, and have none, for one violation as for several).
const create = () => ({
  advertiser_id: '123',
  adgroup_id: '300',
  ad_name: 'Spark sale',
  operation_status: 'ENABLE',
  creative_list: [
    {creative_info: {ad_format: 'SINGLE_VIDEO', tiktok_item_id: '9001', identity_type: 'TT_USER', identity_id: 'tt-1'}},
  ],
  landing_page_url_list: [{landing_page_url: 'https://shop.example.test/sale'}],
  ad_configuration: {
    call_to_action_id: '700',
    creative_auto_add_toggle: false,
    creative_auto_enhancement_strategy_list: [],
    product_info_enabled: 'ON',
  },
});
const edit = () => ({
  smart_plus_ad_id: '5100',
  ad_configuration: {
    call_to_action_id: '700',
    creative_auto_add_toggle: 'yes',
    creative_auto_enhancement_strategy_list: [],
    product_info_enabled: 'ON',
  },
});
// `suffixed`: the first sentence does not name its field, so the answer adds the field after it as it does for any refusal that names
// one (src/errors.ts, preciseMessage), and says so in meta.message_parts, which a page translates by its base. A sentence that names
// its field is the message as it is. Both are the paths of a refusal of one rule, so both are covered here.
const cases = {
  create: {
    refuse: () => assertTiktokSmartPlusAd({accountId: '123'}, create()),
    fields: ['operation_status', 'ad_configuration.product_info_enabled'],
    first: 'Create Smart+ ads paused: set operation_status to DISABLE (TikTok defaults to ENABLE).',
    suffixed: false,
  },
  edit: {
    refuse: () => assertTiktokSmartPlusAdUpdate({accountId: '123'}, edit()),
    fields: ['ad_configuration.creative_auto_add_toggle', 'ad_configuration.product_info_enabled'],
    first: 'Set creative_auto_add_toggle to true or false; its default depends on allowlist status.',
    suffixed: true,
  },
};
/** The answer the service gives for a request the contract refuses. */
function refusal(refuse) {
  try {
    refuse();
  } catch (error) {
    return errorResult(error, reference, 0);
  }
  throw new Error('the contract accepted the request');
}
// A page in Arabic may name a field, an enum or a product (UNSET, TikTok, product_info_enabled), but no English sentence: these
// words of the English sentences must not be left in what it shows.
const englishWords =
  /\b(?:the|and|of|to|is|are|for|this|that|with|each|every|its|in|names|rule|breaks|list|prepare|again)\b/i;

for (const [name, c] of Object.entries(cases))
  test(`${name}: a refusal of two violations has the first one's own sentence as its message, and each violation has its own Arabic`, () => {
    const response = refusal(c.refuse),
      {message, details, next_action} = response.error;
    assert.deepEqual(
      details.violations.map(v => v.field),
      c.fields,
    );
    assert.equal(details.violations_count, 2);
    // The message is the first violation's sentence, which the catalogue has as its own key; there is no template. The answer's own
    // way of naming the field (after the sentence, when the sentence does not name it) is the one of a refusal of that one rule.
    assert.equal(details.violations[0].message, c.first);
    assert.equal(message, c.suffixed ? c.first.replace(/\.$/, '') + ': ' + details.field + '.' : c.first);
    assert.equal(details.field, c.fields[0]);
    assert.equal(response.meta.message_parts?.base, c.suffixed ? c.first : undefined);
    assert.equal(response.error.message_localization, undefined);
    // Each violation says its own sentence, so a client or a page that shows the list has each in the interface language.
    for (const violation of details.violations)
      assert.ok(Object.hasOwn(catalog, violation.message), 'Arabic for: ' + violation.message);
    // The next action, which says there are more, is worded for people and has its Arabic too.
    assert.ok(Object.hasOwn(catalog, next_action), 'Arabic for the remedy: ' + next_action);
    assert.equal(response.error.remedy.action, next_action);
  });

for (const [name, c] of Object.entries(cases))
  test(`${name}: an Arabic page shows a refusal of two violations with no English sentence, and an English page shows it as written`, () => {
    const response = refusal(c.refuse),
      {message, next_action} = response.error;
    for (const locale of ['en', 'ar']) {
      const f = accountWorkflowFixture(locale);
      f.context.response = response;
      f.context.error = f.run('requestError(response)');
      const shown = f.run('errorMessage(error)'),
        parts = f.run('errorParts(error)');
      assert.equal(f.context.error.code, 'INVALID_TIKTOK_SMART_PLUS_AD');
      assert.ok(shown.includes(reference), 'the reference is shown');
      if (locale === 'en') {
        assert.ok(shown.includes(message), shown);
        assert.ok(shown.includes(next_action), shown);
        continue;
      }
      // The page looks the message up as it is (by its base, with the field after it, when the sentence does not name its field), so
      // the first violation reads in Arabic, as a refusal of that one rule does.
      const split = response.meta.message_parts;
      assert.equal(
        parts.message,
        split ? catalog[split.base].replace(/\.$/, '') + ': ' + split.suffix : catalog[message],
      );
      assert.match(parts.message, /[؀-ۿ]/);
      // The remedy is worded for people, so the page shows it as written, in Arabic, and not its category's wording.
      f.context.hint = next_action;
      assert.equal(f.run('agentDirected(hint)'), false, 'written for an MCP client: ' + next_action);
      assert.equal(parts.remedy, catalog[next_action]);
      assert.match(parts.remedy, /[؀-ۿ]/);
      // Neither English sentence is on the page, and no English word of one is left in what it shows.
      assert.equal(shown.includes(message), false, 'the message in English: ' + shown);
      assert.equal(shown.includes(next_action), false, 'the remedy in English: ' + shown);
      assert.doesNotMatch(shown.replace(reference, ''), englishWords, shown);
      // The envelope is not changed by being shown.
      assert.equal(f.context.error.details.violations.length, 2);
    }
  });

test('one violation reads as it always did, in both languages, and the remedy of several is not its remedy', () => {
  const body = {...create(), ad_configuration: {...create().ad_configuration, product_info_enabled: 'UNSET'}},
    response = refusal(() => assertTiktokSmartPlusAd({accountId: '123'}, body)),
    {message, details, next_action} = response.error;
  assert.equal(message, cases.create.first);
  assert.equal(details.field, 'operation_status');
  assert.equal(details.violations, undefined);
  assert.equal(details.violations_count, undefined);
  assert.equal(response.error.message_localization, undefined);
  assert.notEqual(next_action, refusal(cases.create.refuse).error.next_action);
  const f = accountWorkflowFixture('ar');
  f.context.response = response;
  f.context.error = f.run('requestError(response)');
  assert.equal(f.run('errorParts(error)').message, catalog[message]);
});
