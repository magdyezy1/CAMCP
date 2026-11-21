import {createHash} from 'node:crypto';
import {MirrorError} from './errors.js';
import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {DependencyEvidenceContext, RecipeContextFacts} from './provider-adapter.js';
import {tiktokCtaPortfolioCheck} from './tiktok-cta-portfolios.js';
import {
  tiktokBudget,
  tiktokPurchaseEvents,
  tiktokRead,
  tiktokRecipePrerequisites,
  utc,
} from './tiktok-launch-recipes.js';
import {tiktokSearchMatchTypes} from './tiktok-search-keywords.js';
import {assertTiktokSmartPlusSearchKeywords} from './tiktok-smart-plus-adgroups.js';

/**
 * R2.5 M4 (package r25-m4-search2): a third pack, `tiktok_smart_plus_search_website`, the Smart+ Search pack for Sales with a website
 * destination (the shape of TikTok's "Create an Upgraded Smart+ Non-Catalog Search Ads Campaign for Web" page, read 2026-11-20 by the lead's
 * documentation session, DOCS-EVIDENCE section 6, and again 2026-11-21, impl/r25-m4-search2-DOCS.md P4; the hub offers no Traffic). It is the
 * two packs' plan with a Search campaign (`is_search_campaign: true`) and the advertiser's keywords on its ad group, for the goals CLICK (the
 * default, no pixel) or CONVERT (a purchase event of a pixel), the only two the page names. One pack, not two, for the two goals: the page's
 * goals are the brief's choice (the brief names `optimization_goal`), so its static dependency list names the pixel too, which a click brief
 * does not use (the lead's brief). Smart+ Search campaigns are allowlist-only for each objective, which no read shows: TikTok refuses an
 * advertiser without it at the campaign create with code 40118 (recorded as rejected, nothing created), so the step, the brief, the context
 * and the dependency evidence name it.
 *
 * Where the budget is (S2-1, the lead's review of 27528f0e; P4, P13): TikTok allows Search only with campaign budget optimization off ("Campaign
 * budget strategy: Ad group budget"), so this pack's campaign sends `budget_optimize_on: false` with no limit of its own (BUDGET_MODE_INFINITE;
 * a daily hard cap of the same amount, BUDGET_MODE_DAY, is the other documented choice, and the lead's to make), and its one daily budget is
 * its ad group's: BUDGET_MODE_DYNAMIC_DAILY_BUDGET, which SCHEDULE_FROM_NOW needs. The recipe facts say so (`budget_level: 'adgroup'`), and so
 * does the activation, which names that budget as what starts spending (src/tiktok-recipe-activation.ts). The ad is a Spark Ad from an
 * existing post (the manual Search pages allow it; the Smart+ Search pages list creatives, video posts among them, P4, so a Spark Ad is
 * documented; TikTok's refusal is definitive and nothing spends before activation).
 *
 * Guided paused Upgraded Smart+ website launch packs (R2.5 M4, package r25-m4-smartweb), the replacement of the manual purchases
 * pack: TikTok stops creating classic Sales campaigns on 2027-01-01 (its banner on the create pages, field analysis NC-tiktok), and an
 * Upgraded Smart+ web campaign is what takes their place. Two packs, as the classic ones are two: purchases (a pixel event, CONVERT)
 * and traffic (clicks, CLICK, or landing page views, TRAFFIC_LANDING_PAGE_VIEW; no pixel). One pack would list the pixel as a
 * dependency of a click brief too, because a recipe's dependencies are static (src/capability-eligibility.ts).
 *
 * The plan is three steps on the Smart+ routes that already have reviewed families: the campaign (always created DISABLE, Q1), its
 * ad group and its Spark Ad. The ad group and the ad start ENABLE under the disabled campaign (Q14, L1-05: src/provider-adapters.ts), so
 * the go-live is the one reviewed status change of the campaign (src/tiktok-recipe-activation.ts), and not three. The budget is the
 * campaign's own, one daily budget with campaign budget optimization, TikTok's documented Smart+ default
 * (src/tiktok-smart-plus-campaigns.ts), so the ad group carries none (the Search pack is the exception, above). The Spark Ad takes a dynamic CTA portfolio, which the pack does not
 * create: that needs TikTok's recommendation read and a review of its own. Both automatic creative switches are explicit and off, because
 * their defaults depend on allowlist status (src/tiktok-smart-plus-ads.ts). The placement is TikTok alone, as the Spark Ad contract delivers
 * there. The ad group is automatic targeting by location. Everything else TikTok's contract allows stays outside the pack.
 *
 * request_id: a Smart+ campaign create and an ad group create require one (TikTok de-duplicates by it: its page for the ad group create says
 * of a retry with one key that "only one will succeed", and states no time window, which is UNVERIFIED; the classic create's is 10
 * seconds); the ad create has none (the field list of that route in .mirror/CATALOG/tiktok_native_action.json, and the ad family refuses
 * the key). The lead's decision L3 (2026-11-20): the key is derived from the PLAN's ID and the step's ID, and frozen in the step when
 * create_from_recipe saves the plan, not from the brief, because two identical briefs of two days must not send one key (TikTok could
 * answer the second plan with the first plan's object, which the guard against creating twice does not see once the first create has
 * settled). This does not reopen Q16 (owner, 2026-11-15; R2.5 M2): AMCP adds no key to a create a caller sends; the pack is the caller
 * here, and TikTok demands a key. The compile leaves a placeholder that no request can carry (the contract of each create refuses it);
 * the plan engine gives it its value through `bindToPlan` where the plan is saved, and the read-only preflight checks a compiled recipe
 * with a probe plan ID.
 *
 * Preflight reads, before any create, the identity and the post (by the classic pack's rules, src/tiktok-launch-recipes.ts), the CTA
 * portfolio, and for the purchases pack the pixel. The assets keep the hash of each response, never a body or a link.
 */
export const tiktokSmartPlusSource =
  'https://business-api.tiktok.com/portal/docs (API for Business v1.3, Upgraded Smart+)';
const gateway = 'tiktok_native_action';
/**
 * The status the pack creates its ad group and ad with, under the campaign it creates DISABLE. ENABLE makes the activation one change of
 * the campaign (L1-05). Whether TikTok accepts a Smart+ child created ENABLE under a DISABLE campaign is UNVERIFIED until the live check
 * M4 LV-18; if it refuses, this one constant becomes DISABLE and the activation becomes three steps (ad, ad group, then campaign, each after
 * the one before is verified: src/tiktok-recipe-activation.ts), both of which tests/tiktok-smart-plus-recipe.test.mjs runs.
 */
export const tiktokSmartPlusChildStatus = 'ENABLE';
/** What the compile puts where a Smart+ create needs the plan's own request_id; the contract of the create refuses it, so it cannot be sent. */
export const tiktokRequestIdPlaceholder = 'assigned when the plan is saved';
const keyedActions = ['tiktok_smart_plus_campaign_create', 'tiktok_smart_plus_adgroup_create'];
/** The goals of the traffic pack: the click goal (the default, CPC) and the landing page view goal (OCPM); neither takes a pixel. */
const trafficGoals = ['CLICK', 'TRAFFIC_LANDING_PAGE_VIEW'];
const required = [
  'name',
  'account_id',
  'connection_id',
  'currency',
  'daily_budget',
  'location_ids',
  'tiktok_item_id',
  'identity_type',
  'identity_id',
  'destination_url',
  'call_to_action_id',
  'start_time',
];
export const tiktokSmartPlusTrafficRecipe = {
  id: 'tiktok_smart_plus_website_traffic',
  name: 'TikTok Smart+ website traffic with an existing post',
  platform: 'tiktok',
  required,
  // optimization_goal: CLICK (the default, CPC) or TRAFFIC_LANDING_PAGE_VIEW (OCPM); neither takes a pixel (src/tiktok-smart-plus-adgroups.ts).
  optional: ['identity_authorized_bc_id', 'optimization_goal'],
  description:
    'Creates a paused Upgraded Smart+ website campaign with one daily budget, an ad group that optimizes clicks (CPC) or landing page views (OCPM) with no pixel, and a Spark Ad from an existing post with a dynamic CTA portfolio. The ad group and ad start enabled under the disabled campaign, so activation is one reviewed change of the campaign.',
};
export const tiktokSmartPlusConversionRecipe = {
  id: 'tiktok_smart_plus_website_conversions',
  name: 'TikTok Smart+ website purchases with an existing post',
  platform: 'tiktok',
  required: [...required, 'pixel_id', 'optimization_event'],
  optional: ['identity_authorized_bc_id'],
  description:
    'Creates a paused Upgraded Smart+ website campaign with one daily budget, an ad group that optimizes a purchase event of the selected pixel and a Spark Ad from an existing post with a dynamic CTA portfolio. Pixel access does not establish event delivery. The ad group and ad start enabled under the disabled campaign, so activation is one reviewed change of the campaign.',
};
/** The goals of the Search pack: the two TikTok's Smart+ Search page names, CLICK (the default, CPC, no pixel) and CONVERT (OCPM, a pixel event). */
const searchGoals = ['CLICK', 'CONVERT'];
export const tiktokSmartPlusSearchRecipe = {
  id: 'tiktok_smart_plus_search_website',
  name: 'TikTok Smart+ Search with an existing post',
  platform: 'tiktok',
  required: [...required, 'keywords'],
  // optimization_goal: CLICK (the default) or CONVERT, which takes pixel_id and optimization_event (src/tiktok-smart-plus-adgroups.ts).
  optional: ['identity_authorized_bc_id', 'optimization_goal', 'pixel_id', 'optimization_event'],
  description:
    'Creates a paused Upgraded Smart+ Search campaign with no budget of its own, an ad group with one daily budget and your keywords that optimizes clicks or a purchase event, and a Spark Ad from an existing post. Smart+ Search is allowlist-only: TikTok refuses other advertisers with code 40118 and nothing is created. Activation is one reviewed change of the campaign.',
};
export const tiktokSmartPlusRecipes = [
  tiktokSmartPlusTrafficRecipe,
  tiktokSmartPlusConversionRecipe,
  tiktokSmartPlusSearchRecipe,
];

function invalid(message: string, field: string, code = 'RECIPE_INPUT_INVALID', details: JsonObject = {}): never {
  throw new MirrorError(code, message, {field, ...details});
}
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown, max = 32): v is string =>
  typeof v === 'string' && new RegExp('^[1-9][0-9]{0,' + (max - 1) + '}$').test(v);
const given = (v: unknown) => v !== undefined && v !== '';
/** A keyword written as a line, `MATCH_TYPE: keyword` (the website's brief form writes a list one item per line): the match type, a colon, then the keyword, which may hold colons itself. */
const keywordLine = /^\s*([A-Z][A-Z_]*)\s*:\s*([\s\S]*)$/;
/**
 * The keywords of a Search brief as the ad group sends them: records of a keyword and a match type, or lines `MATCH_TYPE: keyword`, both
 * compiled to the record with the keyword trimmed (the compile writes the body, so it may trim what the raw contract refuses). The rest is
 * the ad group contract's own rule, raised with this pack's code and the field `keywords`: 1 to 1,000 items, a match type TikTok's pages name,
 * no pair twice, no other key. Nothing is read or sent.
 */
function searchKeywords(value: unknown): {keyword: string; match_type: string}[] {
  const list = Array.isArray(value)
    ? value.map((item, i) => {
        if (typeof item === 'string') {
          const line = keywordLine.exec(item);
          if (!line)
            invalid(
              'Each keyword is a record of a keyword and a match_type, or a line written as MATCH_TYPE: keyword.',
              'keywords/' + i,
            );
          return {keyword: line[2]!.trim(), match_type: line[1]!};
        }
        return obj(item) && typeof item.keyword === 'string' ? {...item, keyword: item.keyword.trim()} : item;
      })
    : value;
  try {
    assertTiktokSmartPlusSearchKeywords(list);
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'INVALID_TIKTOK_SMART_PLUS_ADGROUP')
      invalid(e.message, String(e.details.field).replace(/^search_keywords/, 'keywords'));
    throw e;
  }
  return list as {keyword: string; match_type: string}[];
}

/**
 * The request_id of a Smart+ create of a plan: a positive decimal of at most 63 bits, never 0, derived from the SHA-256 of the plan's ID and
 * the step's ID (the lead's decision L3, 2026-11-20). The same plan and step always give the same key, so a step that is prepared again
 * sends the key it was saved with; two plans give two keys, whatever their briefs.
 */
export function tiktokSmartPlusRequestId(planId: string, stepId: string): string {
  const digest = createHash('sha256')
    .update('amcp-tiktok-smart-plus-request-id\n' + planId + '\n' + stepId)
    .digest();
  // 1 to 2^63 - 1: TikTok's key is a 64-bit integer, and this one is never 0 (the contract of the create refuses 0 and more than 2^63 - 1).
  return String((digest.readBigUInt64BE(0) % 9223372036854775807n) + 1n);
}
const keyed = (step: JsonObject) =>
  step.kind === 'write' &&
  step.gateway === gateway &&
  obj(step.arguments) &&
  keyedActions.includes(step.arguments.action) &&
  obj(step.arguments.payload);
/**
 * A recipe's step as a saved plan with this ID holds it: a Smart+ campaign or ad group create whose request_id is the placeholder gets the
 * key of this plan and step; every other step, and a step that already has a key of its own, is returned as it is. Pure (the adapter's
 * `campaign.bindToPlan`).
 */
export function tiktokBindToPlan(step: JsonObject, planId: string): JsonObject {
  if (!keyed(step) || step.arguments.payload.request_id !== tiktokRequestIdPlaceholder) return step;
  return {
    ...step,
    arguments: {
      ...step.arguments,
      payload: {...step.arguments.payload, request_id: tiktokSmartPlusRequestId(planId, String(step.id))},
    },
  };
}
/** The step as the compile made it: a key it was given at the plan is the placeholder again (the adapter's `campaign.unbindFromPlan`). */
export function tiktokUnbindFromPlan(step: JsonObject): JsonObject {
  if (!keyed(step) || typeof step.arguments.payload.request_id !== 'string') return step;
  return {
    ...step,
    arguments: {...step.arguments, payload: {...step.arguments.payload, request_id: tiktokRequestIdPlaceholder}},
  };
}

/** Compiles a Smart+ launch brief; existing reviewed routes only, nothing is read or sent. */
export function buildTiktokSmartPlusRecipe(
  b: JsonObject,
  conversions: boolean,
  childStatus: string = tiktokSmartPlusChildStatus,
): JsonObject {
  return compileSmartPlus(b, conversions ? 'conversions' : 'traffic', childStatus);
}
/** Compiles a Smart+ Search brief (R2.5 M4, package r25-m4-search2): the same plan with a Search campaign and the keywords on its ad group. */
export function buildTiktokSmartPlusSearchRecipe(
  b: JsonObject,
  childStatus: string = tiktokSmartPlusChildStatus,
): JsonObject {
  return compileSmartPlus(b, 'search', childStatus);
}
/**
 * The compile of the three packs: `kind` picks the pack's definition, the goals and inputs it takes, and what it adds to the plan. A kind
 * the Search pack adds nothing to compiles byte for byte as it did before the Search pack (the fingerprints of its steps are pinned by
 * tests/tiktok-smart-plus-recipe.test.mjs).
 */
function compileSmartPlus(b: JsonObject, kind: 'traffic' | 'conversions' | 'search', childStatus: string): JsonObject {
  const definition =
    kind === 'conversions'
      ? tiktokSmartPlusConversionRecipe
      : kind === 'search'
        ? tiktokSmartPlusSearchRecipe
        : tiktokSmartPlusTrafficRecipe;
  const search = kind === 'search';
  if (!b.name.trim() || /\p{Extended_Pictographic}/u.test(b.name))
    invalid('Use a campaign name without emoji.', 'name');
  if (!numeric(b.account_id)) invalid('Use the exact numeric TikTok advertiser ID.', 'account_id');
  if (!numeric(b.tiktok_item_id)) invalid('Use the numeric ID of an existing TikTok post.', 'tiktok_item_id');
  if (b.identity_type !== 'TT_USER' && b.identity_type !== 'BC_AUTH_TT')
    invalid(
      'Choose the TikTok account identity type that owns the post: TT_USER or BC_AUTH_TT. A custom identity cannot run new ads on the TikTok placement.',
      'identity_type',
    );
  if (typeof b.identity_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.identity_id))
    invalid('Use the exact identity_id of the TikTok account that owns the post.', 'identity_id');
  const bc = b.identity_authorized_bc_id === '' ? undefined : b.identity_authorized_bc_id;
  if ((b.identity_type === 'BC_AUTH_TT') !== (bc !== undefined) || (bc !== undefined && !numeric(bc)))
    invalid(
      'identity_authorized_bc_id is the numeric Business Center ID, required for BC_AUTH_TT and only for it.',
      'identity_authorized_bc_id',
    );
  const locations = b.location_ids;
  if (
    !Array.isArray(locations) ||
    locations.length < 1 ||
    locations.length > 20 ||
    locations.some(l => !numeric(l, 16)) ||
    new Set(locations).size !== locations.length
  )
    invalid('Choose 1–20 distinct numeric TikTok location IDs (from /v1.3/tool/region/).', 'location_ids');
  // A Smart+ Spark Ad takes a dynamic CTA portfolio, never one of the classic call-to-action names.
  if (given(b.call_to_action))
    invalid(
      'This workflow takes call_to_action_id, the ID of a dynamic CTA portfolio, in place of call_to_action.',
      'call_to_action',
    );
  if (!numeric(b.call_to_action_id))
    invalid('Use the numeric ID of a dynamic CTA portfolio of this advertiser.', 'call_to_action_id');
  // A pack takes no end time (S2-1, the lead's review of eb0c133f). With one the ad group would be SCHEDULE_START_END under the campaign's daily
  // budget, which TikTok's update page allows only under a total budget (the create page's text is unread: LV-19), so TikTok would refuse the ad
  // group after the paused campaign exists, and AMCP cannot delete a Smart+ campaign yet. The pack fails closed, before anything is compiled;
  // lift this only if the create page allows the combination. A blank value is no input, as everywhere in a brief.
  if (given(b.end_time))
    invalid(
      'A Smart+ pack runs from its start under one daily budget; end it with a reviewed status change.',
      'end_time',
    );
  let url: URL;
  try {
    url = new URL(b.destination_url);
  } catch {
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a full HTTPS landing page URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048)
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a public HTTPS landing page URL without credentials.');
  // The goal of a Search brief is its own choice, CLICK or CONVERT (the page names no other); the keywords are checked first, so that a brief that
  // breaks both hears of the list (R2.5 M4, package r25-m4-search2).
  const keywords = search ? searchKeywords(b.keywords) : undefined,
    goalName = search && given(b.optimization_goal) ? b.optimization_goal : 'CLICK';
  if (search && !searchGoals.includes(goalName))
    invalid('Choose CLICK or CONVERT, the goals of the Search workflow.', 'optimization_goal', undefined, {
      allowed: searchGoals,
    });
  // Whether the ad group optimizes a pixel event: the purchases pack always, and a Search brief that names CONVERT.
  const pixel = kind === 'conversions' || (search && goalName === 'CONVERT');
  if (pixel) {
    if (!numeric(b.pixel_id)) invalid('Use the numeric ID of a pixel of this advertiser.', 'pixel_id');
    if (!tiktokPurchaseEvents.includes(b.optimization_event))
      invalid('Choose one of the listed purchase events to optimize.', 'optimization_event', undefined, {
        allowed: tiktokPurchaseEvents,
      });
    if (!search && given(b.optimization_goal))
      invalid('The purchases workflow optimizes a purchase event; it takes no optimization_goal.', 'optimization_goal');
  } else if (search) {
    for (const key of ['pixel_id', 'optimization_event'])
      if (given(b[key])) invalid('A click goal takes no pixel; choose CONVERT to optimize a purchase event.', key);
  } else {
    for (const key of ['pixel_id', 'optimization_event'])
      if (given(b[key]))
        invalid(
          'The traffic workflow optimizes clicks or landing page views; choose the purchases workflow to optimize a pixel event.',
          key,
        );
    if (given(b.optimization_goal) && !trafficGoals.includes(b.optimization_goal))
      invalid(
        'Choose CLICK or TRAFFIC_LANDING_PAGE_VIEW, the goals of the traffic workflow.',
        'optimization_goal',
        undefined,
        {
          allowed: trafficGoals,
        },
      );
  }
  const budget = tiktokBudget(b.daily_budget, b.currency),
    start = utc(b.start_time, 'start_time');
  const goal = pixel ? 'CONVERT' : search ? goalName : given(b.optimization_goal) ? b.optimization_goal : 'CLICK';
  const step = (
    id: string,
    action: string,
    payload: JsonObject,
    depends_on: string[] = [],
    prerequisites: string[] = [],
    description?: string,
  ) => ({
    id,
    kind: 'write',
    gateway,
    account_id: b.account_id,
    connection_id: b.connection_id,
    expected_currency: b.currency,
    arguments: {action, payload},
    depends_on,
    ...(prerequisites.length ? {prerequisites} : {}),
    ...(description ? {description} : {}),
  });
  return {
    action: 'create',
    name: b.name,
    brief:
      definition.name +
      ' in ' +
      b.currency +
      (search
        ? '. The campaign starts disabled with no budget of its own (TikTok allows Search only with campaign budget optimization off); its ad group carries the one daily budget.'
        : '. The campaign starts disabled with one daily budget.') +
      (search
        ? ' Smart+ Search campaigns are allowlist-only: TikTok refuses an advertiser without the allowlist for this objective at the campaign create, and nothing is created.'
        : '') +
      ' Preflight reads the identity, post and CTA portfolio' +
      (pixel ? ' and the pixel' : '') +
      ' of the selected advertiser; every change uses its own review and activation is one separate reviewed change of the campaign.',
    steps: [
      step(
        'smart_plus_campaign',
        'tiktok_smart_plus_campaign_create',
        {
          advertiser_id: b.account_id,
          request_id: tiktokRequestIdPlaceholder,
          operation_status: 'DISABLE',
          objective_type: 'WEB_CONVERSIONS',
          sales_destination: 'WEBSITE',
          campaign_name: b.name,
          // Search needs campaign budget optimization off, sent (TikTok's default is on), and the budget on the ad group; the campaign has no
          // limit of its own (S2-1). Another pack keeps the one daily budget on the campaign.
          ...(search
            ? {budget_optimize_on: false, budget_mode: 'BUDGET_MODE_INFINITE'}
            : {
                budget_optimize_on: true,
                budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
                budget: budget.native,
              }),
          // Once set, TikTok does not change it (the manual create page): this campaign is a Search campaign for good.
          ...(search ? {is_search_campaign: true} : {}),
        },
        [],
        [],
        search
          ? 'Create the paused Smart+ Search campaign. TikTok refuses an advertiser without its Smart+ Search allowlist with code 40118 and creates nothing.'
          : undefined,
      ),
      step(
        'smart_plus_adgroup',
        'tiktok_smart_plus_adgroup_create',
        {
          advertiser_id: b.account_id,
          request_id: tiktokRequestIdPlaceholder,
          campaign_id: {$ref: 'smart_plus_campaign#/data/data/campaign_id'},
          // Under the disabled campaign the ad group and ad start as childStatus says (ENABLE: the activation is one change).
          operation_status: childStatus,
          adgroup_name: (b.name + (search ? ' · Search' : pixel ? ' · website purchases' : ' · website traffic')).slice(
            0,
            512,
          ),
          promotion_type: 'WEBSITE',
          optimization_goal: goal,
          ...(pixel ? {pixel_id: b.pixel_id, optimization_event: b.optimization_event} : {}),
          // The advertiser's keywords, as the contract of the ad group takes them (the brief's own order).
          ...(search ? {search_keywords: keywords} : {}),
          bid_type: 'BID_TYPE_NO_BID',
          // CPC for the click goal and OCPM for every other (TikTok: "Create an Upgraded Smart+ Ad Group").
          billing_event: goal === 'CLICK' ? 'CPC' : 'OCPM',
          targeting_spec: {location_ids: locations},
          // The Search pack's one daily budget is the ad group's own, as TikTok's pages say for a campaign without budget optimization (S2-1):
          // the dynamic daily mode, which SCHEDULE_FROM_NOW below needs. Another pack's budget is its campaign's.
          ...(search ? {budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET', budget: budget.native} : {}),
          // From the start under one daily budget: a schedule with an end needs a total budget (the rule above, and the ad group contract's).
          schedule_type: 'SCHEDULE_FROM_NOW',
          schedule_start_time: start.text,
          // The Spark Ad contract delivers on the TikTok placement (src/tiktok-smart-plus-ads.ts).
          placement_type: 'PLACEMENT_TYPE_NORMAL',
          placements: ['PLACEMENT_TIKTOK'],
        },
        ['smart_plus_campaign'],
        pixel ? ['tiktok_pixel'] : [],
      ),
      step(
        'smart_plus_ad',
        'tiktok_smart_plus_ad_create',
        {
          advertiser_id: b.account_id,
          adgroup_id: {$ref: 'smart_plus_adgroup#/data/data/adgroup_id'},
          ad_name: (b.name + ' · ad').slice(0, 512),
          operation_status: childStatus,
          creative_list: [
            {
              creative_info: {
                ad_format: 'SINGLE_VIDEO',
                tiktok_item_id: b.tiktok_item_id,
                identity_type: b.identity_type,
                identity_id: b.identity_id,
                ...(bc !== undefined ? {identity_authorized_bc_id: bc} : {}),
              },
            },
          ],
          landing_page_url_list: [{landing_page_url: url.href}],
          // Both automatic creative switches are explicit: their defaults depend on allowlist status.
          ad_configuration: {
            call_to_action_id: b.call_to_action_id,
            creative_auto_add_toggle: false,
            creative_auto_enhancement_strategy_list: [],
          },
        },
        ['smart_plus_adgroup'],
        ['tiktok_spark_post', 'tiktok_cta_portfolio'],
      ),
    ],
    recipe: {
      id: definition.id,
      platform: 'tiktok',
      currency: b.currency,
      daily_budget: budget.text,
      budget_level: search ? 'adgroup' : 'campaign',
      schedule_inputs: ['start_time'],
      schedule: {
        type: 'SCHEDULE_FROM_NOW',
        start_utc: start.text,
        end_utc: null,
        meaning: 'TikTok reads ad group schedule times in UTC; the brief’s offsets were converted exactly.',
      },
      bidding_strategy: 'BID_TYPE_NO_BID',
      optimization_goal: goal,
      placements: ['PLACEMENT_TIKTOK'],
      location_ids: locations,
      children_start: childStatus,
      creative: {
        tiktok_item_id: b.tiktok_item_id,
        identity_type: b.identity_type,
        identity_id: b.identity_id,
        ...(bc !== undefined ? {identity_authorized_bc_id: bc} : {}),
        call_to_action_id: b.call_to_action_id,
      },
      // The budget the delivery uses is the campaign's, or for the Search pack the ad group's (S2-1).
      bidding_effect: search
        ? pixel
          ? 'Maximum delivery uses the ad group’s daily budget to seek the chosen purchase event on your keywords. It does not guarantee a cost per purchase or result. Activation is separate.'
          : 'Maximum delivery uses the ad group’s daily budget to seek clicks on your keywords. It does not optimize purchases or guarantee results. Activation is separate.'
        : pixel
          ? 'Maximum delivery uses the campaign’s daily budget to seek the chosen purchase event. It does not guarantee a cost per purchase or result. Activation is separate.'
          : goal === 'CLICK'
            ? 'Maximum delivery uses the campaign’s daily budget to seek clicks. It does not optimize purchases or guarantee results. Activation is separate.'
            : 'Maximum delivery uses the campaign’s daily budget to seek landing page views. It does not optimize purchases or guarantee results. Activation is separate.',
      budget_acceptance: search
        ? 'TikTok sets a minimum daily budget per currency and refuses a smaller one at review or execution (here, at the ad group).'
        : 'TikTok sets a minimum daily campaign budget per currency and refuses a smaller one at review or execution.',
      creative_acceptance:
        'Preflight reads the identity (available, may use its posts, not a political account), the post (a video owned by the identity) and the CTA portfolio (a dynamic CTA portfolio of this advertiser). Ad review, Spark authorization lifetime and objective acceptance remain unverified until TikTok reviews the ad.',
      ...(pixel
        ? {
            pixel_id: b.pixel_id,
            optimization_event: b.optimization_event,
            measurement_acceptance:
              'Preflight reads the pixel for this advertiser; actual event delivery and provider objective acceptance remain unverified.',
          }
        : {}),
      ...(search
        ? {
            keywords: {
              count: keywords!.length,
              by_match_type: Object.fromEntries(
                tiktokSearchMatchTypes.map(type => [type, keywords!.filter(k => k.match_type === type).length]),
              ),
            },
            keyword_acceptance:
              'TikTok reviews each keyword after the ad group is created (audit_status in the ad group read); AMCP reads the keywords back as a set and does not wait for their review.',
            allowlist_acceptance:
              'Smart+ Search campaigns are allowlist-only for each objective, and TikTok documents no read of the allowlist, so preflight cannot check it. TikTok decides at the campaign create: an advertiser that is not on the allowlist for this objective is refused with code 40118, recorded as rejected, and nothing is created.',
          }
        : {}),
      source: tiktokSmartPlusSource,
    },
  };
}

function prerequisite(message: string, details: JsonObject): never {
  throw new MirrorError('CAMPAIGN_PREREQUISITE_REQUIRED', message, details);
}
/**
 * Preflight reads of a Smart+ launch pack, run before any campaign predecessor exists. A Spark Ad step marked `tiktok_spark_post` has its
 * identity and post read by the classic pack's own rules (the ad is shown to that function as the classic ad create it would be, with its
 * first creative), and a step marked `tiktok_cta_portfolio` has its CTA portfolio read: it must exist for the selected advertiser and be a
 * CTA portfolio, by the rule of the ad create's own state check. An ad group step marked `tiktok_pixel` has its pixel read by the classic
 * rules. A dependency TikTok does not return, or reports as unusable, blocks the plan; nothing here is a grant, and the native review of
 * each step reads its own state again.
 */
export async function tiktokSmartPlusRecipePrerequisites(
  service: MirrorService,
  actor: Actor,
  plan: CompiledRequest,
  connectionId: string,
  prerequisites: string[],
): Promise<JsonObject[]> {
  if (plan.gateway !== gateway || plan.method !== 'POST' || !obj(plan.body)) return [];
  const scope = {account_id: String(plan.accountId), connection_id: connectionId},
    assets: JsonObject[] = [];
  if (plan.path === '/v1.3/smart_plus/ad/create/') {
    if (prerequisites.includes('tiktok_spark_post')) {
      const first =
          Array.isArray(plan.body.creative_list) && obj(plan.body.creative_list[0]) ? plan.body.creative_list[0] : {},
        info = obj(first.creative_info) ? first.creative_info : {};
      assets.push(
        ...(await tiktokRecipePrerequisites(
          service,
          actor,
          {...plan, path: '/v1.3/ad/create/', body: {creatives: [info]}} as CompiledRequest,
          connectionId,
          ['tiktok_spark_post'],
        )),
      );
    }
    const portfolio = obj(plan.body.ad_configuration) ? plan.body.ad_configuration.call_to_action_id : undefined;
    if (prerequisites.includes('tiktok_cta_portfolio') && numeric(portfolio)) {
      const details = {call_to_action_id: portfolio, field: 'call_to_action_id'};
      let read: Awaited<ReturnType<typeof tiktokRead>>;
      try {
        read = await tiktokRead(service, actor, scope, 'tiktok_creative_portfolio_get', {
          advertiser_id: scope.account_id,
          creative_portfolio_id: portfolio,
        });
      } catch (e) {
        // S3-1 (the lead's review of eb0c133f): a portfolio TikTok has no record of answers the read with a code of its own (40002 for an ID it
        // does not know), which the gateway gives as PLATFORM_ERROR, and a read without a portfolio is INCOMPLETE_STATE. Each is a dependency TikTok
        // did not return, so it blocks the plan as a prerequisite that names call_to_action_id, as the other dependencies do. Any other failure (a
        // throttle, an outage, a missing grant) keeps its own code: it is no statement about the portfolio.
        const upstream: unknown = e instanceof MirrorError ? e.details?.upstream : undefined;
        if (
          e instanceof MirrorError &&
          (e.code === 'INCOMPLETE_STATE' || (e.code === 'PLATFORM_ERROR' && obj(upstream)))
        )
          prerequisite('TikTok did not return a usable CTA portfolio with this ID for the selected advertiser.', {
            ...details,
            ...(obj(upstream) && typeof upstream.code === 'number' ? {upstream_code: upstream.code} : {}),
          });
        throw e;
      }
      try {
        // The check the ad create's own review makes, on the portfolio just read (src/tiktok-cta-portfolios.ts).
        tiktokCtaPortfolioCheck(
          portfolio,
          [
            {
              data: {
                creative_portfolio_id: portfolio,
                creative_portfolio_type: read.data.creative_portfolio_type ?? null,
                portfolio_content: read.data.portfolio_content,
              },
            },
          ],
          'call_to_action_id',
        );
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        if (e.code === 'STATE_TARGET_MISMATCH')
          prerequisite(
            'TikTok did not return a usable CTA portfolio with this ID for the selected advertiser.',
            details,
          );
        prerequisite('The portfolio is not a dynamic CTA portfolio, which call_to_action_id needs.', {
          ...details,
          portfolio_type: read.data.creative_portfolio_type ?? null,
        });
      }
      assets.push({
        asset_type: 'TikTok CTA portfolio',
        asset_id: portfolio,
        status: 'provider_read_checked',
        account_id: scope.account_id,
        connection_id: connectionId,
        source_reference: {
          source_kind: 'native_cta_portfolio_read',
          request: read.request,
          response_hash: read.hash,
          captured_at: Date.now(),
        },
        meaning:
          'TikTok returned this dynamic CTA portfolio for the selected advertiser, and it holds call-to-action groups. Ad review and objective acceptance remain unverified.',
      });
    }
  }
  if (plan.path === '/v1.3/smart_plus/adgroup/create/' && prerequisites.includes('tiktok_pixel'))
    assets.push(
      ...(await tiktokRecipePrerequisites(
        service,
        actor,
        {...plan, path: '/v1.3/adgroup/create/', body: {pixel_id: plan.body.pixel_id}} as CompiledRequest,
        connectionId,
        ['tiktok_pixel'],
      )),
    );
  return assets;
}

// What recipe_context says of each pack, as the classic packs' contexts do (their text is src/tiktok-launch-recipes.ts's).
const tiktokSmartPlusPrerequisite =
  'existing TikTok post, account identity and dynamic CTA portfolio with explicit location/schedule inputs';
export const tiktokSmartPlusTrafficContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'Uses an existing TikTok post as a Spark Ad with a dynamic CTA portfolio and optimizes clicks or landing page views in an Upgraded Smart+ campaign. Preflight reads the identity, post and CTA portfolio; ad review and objective acceptance remain unverified. The ad group and ad start enabled under the disabled campaign; activation is one reviewed change of the campaign.',
  ]),
  prerequisite: tiktokSmartPlusPrerequisite,
});
export const tiktokSmartPlusConversionContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'Uses an existing TikTok post as a Spark Ad with a dynamic CTA portfolio and optimizes a purchase event of the selected pixel in an Upgraded Smart+ campaign. Preflight reads the identity, post, CTA portfolio and pixel; event delivery, ad review and objective acceptance remain unverified. The ad group and ad start enabled under the disabled campaign; activation is one reviewed change of the campaign.',
  ]),
  prerequisite: tiktokSmartPlusPrerequisite,
});
export const tiktokSmartPlusSearchContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'Uses an existing TikTok post as a Spark Ad and optimizes clicks or a purchase event on the keywords given, in an Upgraded Smart+ Search campaign, which has no budget of its own: the one daily budget is its ad group’s. TikTok refuses an advertiser without the Smart+ Search allowlist with code 40118 at the campaign create (recorded as rejected, nothing created), and preflight cannot read it. Keyword review, ad review and objective acceptance remain unverified.',
  ]),
  prerequisite:
    'TikTok Smart+ Search allowlist for the Sales objective, an existing TikTok post, account identity and dynamic CTA portfolio with explicit location/schedule inputs and keywords',
});

/**
 * The dependencies the Smart+ packs add to the classic ones (the identity, post and pixel are src/tiktok-launch-recipes.ts's): the CTA
 * portfolio preflight read, and the Smart+ Search allowlist of the Search pack, which no read shows (it stays unknown, and says why).
 */
export function tiktokSmartPlusDependencyEvidence(
  id: string,
  {assets, scope}: DependencyEvidenceContext,
): JsonObject | undefined {
  if (id === 'smart_plus_search_allowlist')
    return {
      status: 'unknown',
      meaning:
        'TikTok documents no read of its Smart+ Search allowlist, so preflight cannot check it. It decides at the campaign create: an advertiser without it is refused with code 40118 and nothing is created.',
    };
  if (id !== 'dynamic_cta_portfolio') return undefined;
  const proof = assets.find(
    a =>
      a.asset_type === 'TikTok CTA portfolio' &&
      a.account_id === scope.account_id &&
      a.connection_id === scope.connection_id &&
      a.status === 'provider_read_checked',
  );
  return proof ? {status: 'ready', evidence: proof, meaning: proof.meaning} : undefined;
}
