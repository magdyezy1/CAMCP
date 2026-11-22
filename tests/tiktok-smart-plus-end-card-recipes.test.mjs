import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {smartPlusWebBriefs} from './fixtures/tiktok-smart-plus-web.mjs';
import {smartPlusSearchBriefs} from './fixtures/tiktok-smart-plus-search.mjs';

/**
 * The three Upgraded Smart+ packs offer no end cards (package r25-m4b-endcards, S3-2 of the lead's review, 2026-11-22). The first version of
 * the package gave each pack an optional `end_card_ids`, which the ad step sent as `end_card_list` and preflight read. TikTok documents end
 * cards for TikTok Ad Network ads under a custom identity ("Use end cards in TikTok Ad Network ads", read 2026-11-22), and every pack fixes
 * settings that guide's table excludes: a Spark identity, TikTok placement alone and, for the Search pack, a Search campaign. A pack with end
 * cards would have created its paused campaign and ad group and then been refused at the ad step (40118 for an advertiser that is not on the
 * allowlist, or TikTok's refusal of a scenario it does not document), leaving a campaign and an ad group with no ad after the person approved
 * the plan once. The standalone ad create and edit keep `end_card_list` (tests/tiktok-smart-plus-end-cards.test.mjs). A pack that meets the
 * documented scenario (a custom identity on Pangle placements: matrix A4, `smartcreative`) may offer end cards again, and changes this test.
 */
const packs = [
  ['tiktok_smart_plus_website_traffic', smartPlusWebBriefs('19191919-1919-4191-8191-191919191919').traffic],
  ['tiktok_smart_plus_website_conversions', smartPlusWebBriefs('19191919-1919-4191-8191-191919191919').conversions],
  ['tiktok_smart_plus_search_website', smartPlusSearchBriefs('20202020-2020-4202-8202-202020202020').clicks],
];

test('the three Smart+ packs offer no end cards: none lists end_card_ids, their ad step sends no end_card_list and reads no end card, and a brief that names the input compiles the plan it would without it', () => {
  for (const [id, brief] of packs) {
    const definition = campaignRecipes.find(r => r.id === id);
    assert.ok(!definition.required.includes('end_card_ids'), id + ' does not require end_card_ids');
    assert.ok(!definition.optional.includes('end_card_ids'), id + ' does not offer end_card_ids');
    const plan = campaignRecipe(id, brief),
      ad = plan.steps.find(s => s.id === 'smart_plus_ad');
    assert.equal(ad.arguments.payload.end_card_list, undefined, id);
    assert.deepEqual(ad.prerequisites, ['tiktok_spark_post', 'tiktok_cta_portfolio'], id);
    assert.equal(plan.recipe.creative.end_card_ids, undefined, id);
    assert.deepEqual(
      campaignRecipe(id, {...brief, end_card_ids: ['8801', '8802']}),
      plan,
      id + ': the input changes nothing',
    );
  }
});
