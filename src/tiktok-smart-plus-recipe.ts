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

/**
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
 * (src/tiktok-smart-plus-campaigns.ts), so the ad group carries none. The Spark Ad takes a dynamic CTA portfolio, which the pack does not
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
export const tiktokSmartPlusRecipes = [tiktokSmartPlusTrafficRecipe, tiktokSmartPlusConversionRecipe];

function invalid(message: string, field: string, code = 'RECIPE_INPUT_INVALID', details: JsonObject = {}): never {
  throw new MirrorError(code, message, {field, ...details});
}
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown, max = 32): v is string =>
  typeof v === 'string' && new RegExp('^[1-9][0-9]{0,' + (max - 1) + '}$').test(v);
const given = (v: unknown) => v !== undefined && v !== '';

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
  const definition = conversions ? tiktokSmartPlusConversionRecipe : tiktokSmartPlusTrafficRecipe;
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
  if (conversions) {
    if (!numeric(b.pixel_id)) invalid('Use the numeric ID of a pixel of this advertiser.', 'pixel_id');
    if (!tiktokPurchaseEvents.includes(b.optimization_event))
      invalid('Choose one of the listed purchase events to optimize.', 'optimization_event', undefined, {
        allowed: tiktokPurchaseEvents,
      });
    if (given(b.optimization_goal))
      invalid('The purchases workflow optimizes a purchase event; it takes no optimization_goal.', 'optimization_goal');
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
  const goal = conversions ? 'CONVERT' : given(b.optimization_goal) ? b.optimization_goal : 'CLICK';
  const step = (
    id: string,
    action: string,
    payload: JsonObject,
    depends_on: string[] = [],
    prerequisites: string[] = [],
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
  });
  return {
    action: 'create',
    name: b.name,
    brief:
      definition.name +
      ' in ' +
      b.currency +
      '. The campaign starts disabled with one daily budget. Preflight reads the identity, post and CTA portfolio' +
      (conversions ? ' and the pixel' : '') +
      ' of the selected advertiser; every change uses its own review and activation is one separate reviewed change of the campaign.',
    steps: [
      step('smart_plus_campaign', 'tiktok_smart_plus_campaign_create', {
        advertiser_id: b.account_id,
        request_id: tiktokRequestIdPlaceholder,
        operation_status: 'DISABLE',
        objective_type: 'WEB_CONVERSIONS',
        sales_destination: 'WEBSITE',
        campaign_name: b.name,
        budget_optimize_on: true,
        budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
        budget: budget.native,
      }),
      step(
        'smart_plus_adgroup',
        'tiktok_smart_plus_adgroup_create',
        {
          advertiser_id: b.account_id,
          request_id: tiktokRequestIdPlaceholder,
          campaign_id: {$ref: 'smart_plus_campaign#/data/data/campaign_id'},
          // Under the disabled campaign the ad group and ad start as childStatus says (ENABLE: the activation is one change).
          operation_status: childStatus,
          adgroup_name: (b.name + (conversions ? ' · website purchases' : ' · website traffic')).slice(0, 512),
          promotion_type: 'WEBSITE',
          optimization_goal: goal,
          ...(conversions ? {pixel_id: b.pixel_id, optimization_event: b.optimization_event} : {}),
          bid_type: 'BID_TYPE_NO_BID',
          // CPC for the click goal and OCPM for every other (TikTok: "Create an Upgraded Smart+ Ad Group").
          billing_event: goal === 'CLICK' ? 'CPC' : 'OCPM',
          targeting_spec: {location_ids: locations},
          // From the start under the campaign's daily budget: a schedule with an end needs a total budget (the rule above, and the ad group contract's).
          schedule_type: 'SCHEDULE_FROM_NOW',
          schedule_start_time: start.text,
          // The Spark Ad contract delivers on the TikTok placement (src/tiktok-smart-plus-ads.ts).
          placement_type: 'PLACEMENT_TYPE_NORMAL',
          placements: ['PLACEMENT_TIKTOK'],
        },
        ['smart_plus_campaign'],
        conversions ? ['tiktok_pixel'] : [],
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
      budget_level: 'campaign',
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
      bidding_effect: conversions
        ? 'Maximum delivery uses the campaign’s daily budget to seek the chosen purchase event. It does not guarantee a cost per purchase or result. Activation is separate.'
        : goal === 'CLICK'
          ? 'Maximum delivery uses the campaign’s daily budget to seek clicks. It does not optimize purchases or guarantee results. Activation is separate.'
          : 'Maximum delivery uses the campaign’s daily budget to seek landing page views. It does not optimize purchases or guarantee results. Activation is separate.',
      budget_acceptance:
        'TikTok sets a minimum daily campaign budget per currency and refuses a smaller one at review or execution.',
      creative_acceptance:
        'Preflight reads the identity (available, may use its posts, not a political account), the post (a video owned by the identity) and the CTA portfolio (a dynamic CTA portfolio of this advertiser). Ad review, Spark authorization lifetime and objective acceptance remain unverified until TikTok reviews the ad.',
      ...(conversions
        ? {
            pixel_id: b.pixel_id,
            optimization_event: b.optimization_event,
            measurement_acceptance:
              'Preflight reads the pixel for this advertiser; actual event delivery and provider objective acceptance remain unverified.',
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
      const read = await tiktokRead(service, actor, scope, 'tiktok_creative_portfolio_get', {
          advertiser_id: scope.account_id,
          creative_portfolio_id: portfolio,
        }),
        details = {call_to_action_id: portfolio, field: 'call_to_action_id'};
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

/** The dependency the Smart+ packs add to the classic ones (the identity, post and pixel are src/tiktok-launch-recipes.ts's): the CTA portfolio preflight read. */
export function tiktokSmartPlusDependencyEvidence(
  id: string,
  {assets, scope}: DependencyEvidenceContext,
): JsonObject | undefined {
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
