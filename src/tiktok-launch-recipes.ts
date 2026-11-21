import {MirrorError} from './errors.js';
import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {currencyMinorDigits} from './budget-units.js';
import {fingerprint} from './workspace-core.js';
import {recipeChoices, recipeEnum} from './recipe-values.js';
import type {DependencyEvidenceContext, RecipeContextFacts} from './provider-adapter.js';
import {tiktokManualCutoffPurchases} from './tiktok-manual-cutoff.js';

/**
 * Guided paused TikTok launch packs (CMP-07, packs owner decision P7 names): website traffic and website purchases on
 * manual campaigns, compiled to the existing reviewed tiktok_entities creates (POST /v1.3/campaign/create/,
 * /v1.3/adgroup/create/ and /v1.3/ad/create/ of API for Business v1.3). The campaign is created DISABLE and its ad
 * group and ad ENABLE under it (paused-parents.ts), so enabling the campaign is the one activation, a separate reviewed
 * status change.
 *
 * The creative is a Spark Ad from an existing TikTok post (tiktok_item_id) under a TikTok account identity (TT_USER or
 * BC_AUTH_TT). A library video would need a CUSTOMIZED_USER identity, which TikTok no longer accepts for new ads that
 * deliver on TikTok (src/tiktok-manual-ad-identities.ts), and Spark Ads from uploads are not a qualified contract.
 * Before anything is created, preflight reads the identity and the post (and, for purchases, the pixel) of the
 * selected advertiser. TikTok's own objective, budget-minimum and post-eligibility rules stay with the provider: a
 * refusal is a typed review or execution error that is never retried.
 */
export const tiktokLaunchSource = 'https://business-api.tiktok.com/portal/docs (API for Business v1.3)';
const gateway = 'tiktok_native_action';
/** Call-to-action values of manual ads (API for Business v1.3 "Enumeration - Call-to-action"), a qualified subset. */
export const tiktokCallToActions = [
  'LEARN_MORE',
  'SHOP_NOW',
  'SIGN_UP',
  'CONTACT_US',
  'APPLY_NOW',
  'BOOK_NOW',
  'ORDER_NOW',
  'GET_QUOTE',
  'SUBSCRIBE',
];
/** Purchase-funnel pixel events a website purchases pack may optimize (TikTok's optimizable standard events). */
export const tiktokPurchaseEvents = ['SHOPPING', 'ON_WEB_ORDER', 'INITIATE_ORDER', 'ON_WEB_CART'];
/**
 * The identity types of a TikTok pack's Spark Ad (AMCP-08: every TikTok pack declares them in the `inputs` of its definition, so `recipes` and
 * `recipe_context` say them): the TikTok account that owns the post, linked to the advertiser or authorized through a Business Center. A custom
 * identity cannot run new ads on the TikTok placement, so it is not listed.
 */
export const tiktokIdentityTypes = recipeChoices(['TT_USER', 'BC_AUTH_TT']);
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
  'call_to_action',
  'start_time',
];
export const tiktokTrafficRecipe = {
  id: 'tiktok_website_traffic',
  name: 'TikTok website traffic with an existing post',
  platform: 'tiktok',
  required,
  optional: ['end_time', 'identity_authorized_bc_id'],
  inputs: {identity_type: tiktokIdentityTypes, call_to_action: recipeChoices(tiktokCallToActions)},
  description:
    'Creates a paused TikTok traffic campaign, a daily-budget ad group on the TikTok placement and a Spark Ad from an existing post. Optimizes clicks with maximum delivery. Preflight reads the identity and post; activation is separate.',
};
export const tiktokConversionRecipe = {
  id: 'tiktok_website_conversions',
  name: 'TikTok website purchases with an existing post',
  platform: 'tiktok',
  required: [...required, 'pixel_id', 'optimization_event'],
  optional: ['end_time', 'identity_authorized_bc_id'],
  inputs: {
    identity_type: tiktokIdentityTypes,
    call_to_action: recipeChoices(tiktokCallToActions),
    optimization_event: recipeChoices(tiktokPurchaseEvents),
  },
  description:
    'Creates a paused TikTok website conversions campaign, a daily-budget ad group that optimizes a purchase event of the selected pixel, and a Spark Ad from an existing post. Pixel access does not establish event delivery; activation is separate.',
};
export const tiktokLaunchRecipes = [tiktokTrafficRecipe, tiktokConversionRecipe];

function invalid(message: string, field: string, code = 'RECIPE_INPUT_INVALID', details: JsonObject = {}): never {
  throw new MirrorError(code, message, {field, ...details});
}
const numeric = (v: unknown, max = 32): v is string =>
  typeof v === 'string' && new RegExp('^[1-9][0-9]{0,' + (max - 1) + '}$').test(v);
const pad = (n: number) => String(n).padStart(2, '0');
/** An ISO timestamp with an explicit UTC offset, as TikTok's UTC "YYYY-MM-DD HH:MM:SS". */
export function utc(value: unknown, field: string): {text: string; time: number} {
  const m =
      typeof value === 'string' &&
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value),
    time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (
    !m ||
    !Number.isFinite(time) ||
    Number(m[2]) > 23 ||
    Number(m[3]) > 59 ||
    Number(m[4]) > 59 ||
    new Date(m[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== m[1]
  )
    invalid('Use a valid timestamp with an explicit UTC offset.', field, 'RECIPE_DATE_INVALID');
  const d = new Date(time);
  return {
    time,
    text:
      d.getUTCFullYear() +
      '-' +
      pad(d.getUTCMonth() + 1) +
      '-' +
      pad(d.getUTCDate()) +
      ' ' +
      pad(d.getUTCHours()) +
      ':' +
      pad(d.getUTCMinutes()) +
      ':' +
      pad(d.getUTCSeconds()),
  };
}
/**
 * A TikTok budget in the account currency: TikTok takes a decimal number with at most two places, and never more
 * places than the currency has (JPY none). Exact decimal text is checked before it becomes the JSON number TikTok reads.
 */
export function tiktokBudget(v: unknown, currency: unknown): {text: string; native: number} {
  const digits = currencyMinorDigits(currency);
  if (digits === undefined) invalid('Unknown account currency.', 'currency', 'INVALID_RECIPE_MONEY');
  const places = Math.min(2, digits);
  if ((typeof v !== 'string' && typeof v !== 'number') || !/^\d{1,9}(?:\.\d+)?$/.test(String(v)))
    invalid('Use a positive decimal daily budget in account currency.', 'daily_budget', 'INVALID_RECIPE_MONEY');
  const [whole, fraction = ''] = String(v).split('.');
  if (fraction.length > places && /[1-9]/.test(fraction.slice(places)))
    throw new MirrorError(
      'INVALID_RECIPE_MONEY',
      'TikTok takes budgets with at most two decimal places, and no more than the account currency has.',
      {field: 'daily_budget', value: String(v), currency, decimal_places: places},
    );
  const kept = fraction.slice(0, places).replace(/0+$/, ''),
    text = String(BigInt(whole!)) + (kept ? '.' + kept : '');
  if (Number(text) <= 0)
    invalid('Use a positive decimal daily budget in account currency.', 'daily_budget', 'INVALID_RECIPE_MONEY');
  return {text, native: Number(text)};
}

/** Compiles a TikTok launch brief; existing reviewed routes only, nothing is read or sent. */
export function buildTiktokLaunchRecipe(b: JsonObject, conversions: boolean): JsonObject {
  const definition = conversions ? tiktokConversionRecipe : tiktokTrafficRecipe;
  // From 2027-01-01 TikTok no longer creates the manual Sales campaign this pack compiles to (R2.5 M4, L2): the pack is refused, first.
  if (conversions) tiktokManualCutoffPurchases();
  if (!b.name.trim() || /\p{Extended_Pictographic}/u.test(b.name))
    invalid('Use a campaign name without emoji.', 'name');
  if (!numeric(b.account_id)) invalid('Use the exact numeric TikTok advertiser ID.', 'account_id');
  if (!numeric(b.tiktok_item_id)) invalid('Use the numeric ID of an existing TikTok post.', 'tiktok_item_id');
  // The identity type, the call to action and the purchase event are read by their declared values, and the value used is the listed one
  // (AMCP-08): a brief that writes TT_USER in small letters sends TT_USER.
  const identityType = recipeEnum(b, 'identity_type', definition.inputs.identity_type) as string;
  if (typeof b.identity_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.identity_id))
    invalid('Use the exact identity_id of the TikTok account that owns the post.', 'identity_id');
  const bc = b.identity_authorized_bc_id === '' ? undefined : b.identity_authorized_bc_id;
  if ((identityType === 'BC_AUTH_TT') !== (bc !== undefined) || (bc !== undefined && !numeric(bc)))
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
  const callToAction = recipeEnum(b, 'call_to_action', definition.inputs.call_to_action) as string;
  let url: URL;
  try {
    url = new URL(b.destination_url);
  } catch {
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a full HTTPS landing page URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048)
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a public HTTPS landing page URL without credentials.');
  let optimizationEvent: string | undefined;
  if (conversions) {
    if (!numeric(b.pixel_id)) invalid('Use the numeric ID of a pixel of this advertiser.', 'pixel_id');
    optimizationEvent = recipeEnum(b, 'optimization_event', tiktokConversionRecipe.inputs.optimization_event) as string;
  } else
    for (const key of ['pixel_id', 'optimization_event'])
      if (b[key] !== undefined && b[key] !== '')
        invalid('The traffic workflow optimizes clicks; choose the purchases workflow to optimize a pixel event.', key);
  const budget = tiktokBudget(b.daily_budget, b.currency),
    start = utc(b.start_time, 'start_time'),
    end = b.end_time === undefined || b.end_time === '' ? undefined : utc(b.end_time, 'end_time');
  if (end && end.time <= start.time) invalid('End time must follow start time.', 'end_time', 'RECIPE_DATE_INVALID');
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
  const creative: JsonObject = {
    ad_name: (b.name + ' · ad').slice(0, 512),
    ad_format: 'SINGLE_VIDEO',
    tiktok_item_id: b.tiktok_item_id,
    identity_type: identityType,
    identity_id: b.identity_id,
    ...(bc !== undefined ? {identity_authorized_bc_id: bc} : {}),
    landing_page_url: url.href,
    call_to_action: callToAction,
    // Under the disabled campaign the ad group and ad start enabled; enabling the campaign is the one activation.
    operation_status: 'ENABLE',
  };
  return {
    action: 'create',
    name: b.name,
    brief:
      definition.name +
      ' in ' +
      b.currency +
      '. The campaign starts disabled. Preflight reads the identity and post' +
      (conversions ? ' and the pixel' : '') +
      ' of the selected advertiser; every change uses its own review and activation is a separate reviewed change.',
    steps: [
      step('campaign', 'tiktok_campaign_create', {
        advertiser_id: b.account_id,
        campaign_name: b.name,
        objective_type: conversions ? 'WEB_CONVERSIONS' : 'TRAFFIC',
        budget_mode: 'BUDGET_MODE_INFINITE',
        operation_status: 'DISABLE',
      }),
      step(
        'adgroup',
        'tiktok_adgroup_create',
        {
          advertiser_id: b.account_id,
          campaign_id: {$ref: 'campaign#/data/data/campaign_id'},
          adgroup_name: (b.name + (conversions ? ' · website purchases' : ' · website traffic')).slice(0, 512),
          promotion_type: 'WEBSITE',
          placement_type: 'PLACEMENT_TYPE_NORMAL',
          placements: ['PLACEMENT_TIKTOK'],
          location_ids: locations,
          budget_mode: 'BUDGET_MODE_DAY',
          budget: budget.native,
          schedule_type: end ? 'SCHEDULE_START_END' : 'SCHEDULE_FROM_NOW',
          schedule_start_time: start.text,
          ...(end ? {schedule_end_time: end.text} : {}),
          optimization_goal: conversions ? 'CONVERT' : 'CLICK',
          ...(conversions ? {pixel_id: b.pixel_id, optimization_event: optimizationEvent} : {}),
          billing_event: conversions ? 'OCPM' : 'CPC',
          bid_type: 'BID_TYPE_NO_BID',
          pacing: 'PACING_MODE_SMOOTH',
          operation_status: 'ENABLE',
        },
        ['campaign'],
        conversions ? ['tiktok_pixel'] : [],
      ),
      step(
        'ad',
        'tiktok_ad_create',
        {advertiser_id: b.account_id, adgroup_id: {$ref: 'adgroup#/data/data/adgroup_id'}, creatives: [creative]},
        ['adgroup'],
        ['tiktok_spark_post'],
      ),
    ],
    recipe: {
      id: definition.id,
      platform: 'tiktok',
      currency: b.currency,
      daily_budget: budget.text,
      schedule_inputs: ['start_time', 'end_time'],
      schedule: {
        type: end ? 'SCHEDULE_START_END' : 'SCHEDULE_FROM_NOW',
        start_utc: start.text,
        end_utc: end?.text ?? null,
        meaning: 'TikTok reads ad group schedule times in UTC; the brief’s offsets were converted exactly.',
      },
      bidding_strategy: 'BID_TYPE_NO_BID',
      optimization_goal: conversions ? 'CONVERT' : 'CLICK',
      placements: ['PLACEMENT_TIKTOK'],
      location_ids: locations,
      creative: {
        tiktok_item_id: b.tiktok_item_id,
        identity_type: identityType,
        identity_id: b.identity_id,
        ...(bc !== undefined ? {identity_authorized_bc_id: bc} : {}),
      },
      bidding_effect: conversions
        ? 'Maximum delivery uses the daily budget to seek the chosen purchase event. It does not guarantee a cost per purchase or result. Activation is separate.'
        : 'Maximum delivery uses the daily budget to seek clicks. It does not optimize purchases or guarantee results. Activation is separate.',
      budget_acceptance:
        'TikTok sets a minimum daily ad group budget per currency and refuses a smaller one at review or execution.',
      creative_acceptance:
        'Preflight reads the identity (available, may use its posts, not a political account) and the post (a video owned by the identity). Ad review, Spark authorization lifetime and objective acceptance remain unverified until TikTok reviews the ad.',
      ...(conversions
        ? {
            pixel_id: b.pixel_id,
            optimization_event: optimizationEvent,
            measurement_acceptance:
              'Preflight reads the pixel for this advertiser; actual event delivery and provider objective acceptance remain unverified.',
          }
        : {}),
      source: tiktokLaunchSource,
    },
  };
}

const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** One read-only TikTok request of the selected advertiser, through the gateway's own registry and scope checks. */
export async function tiktokRead(
  service: MirrorService,
  actor: Actor,
  scope: {account_id: string; connection_id: string},
  action: string,
  query: JsonObject,
): Promise<{data: JsonObject; request: JsonObject; hash: string}> {
  const out = await service.call(gateway, {action, ...scope, query}, actor);
  if (!out.success) throw new MirrorError(out.error.code, out.error.message, out.error.details);
  const body = out.data?.data;
  if (out.data?.truncated || !obj(body) || body.code !== 0 || !obj(body.data))
    throw new MirrorError('INCOMPLETE_STATE', 'TikTok did not return a complete, successful read.', {action});
  return {data: body.data, request: {action, query}, hash: fingerprint(body.data)};
}
function prerequisite(message: string, details: JsonObject): never {
  throw new MirrorError('CAMPAIGN_PREREQUISITE_REQUIRED', message, details);
}

/**
 * Preflight reads of a TikTok launch pack (CMP-07), run before any campaign predecessor exists: the Spark identity and
 * post of an ad step marked `tiktok_spark_post`, and the pixel of an ad group step marked `tiktok_pixel`. Each read is
 * a native read of the selected advertiser; a dependency TikTok does not return, or one it reports as unusable, blocks
 * the plan. Nothing here is a grant: the native review of each step reads its own state again.
 */
export async function tiktokRecipePrerequisites(
  service: MirrorService,
  actor: Actor,
  plan: CompiledRequest,
  connectionId: string,
  prerequisites: string[],
): Promise<JsonObject[]> {
  if (plan.gateway !== gateway || plan.method !== 'POST' || !obj(plan.body)) return [];
  const scope = {account_id: String(plan.accountId), connection_id: connectionId},
    assets: JsonObject[] = [],
    base = (asset_type: string, asset_id: string, kind: string, read: {request: JsonObject; hash: string}) => ({
      asset_type,
      asset_id,
      status: 'provider_read_checked',
      account_id: scope.account_id,
      connection_id: connectionId,
      source_reference: {
        source_kind: kind,
        request: read.request,
        response_hash: read.hash,
        captured_at: Date.now(),
      },
    });
  if (plan.path === '/v1.3/ad/create/' && prerequisites.includes('tiktok_spark_post')) {
    const c = Array.isArray(plan.body.creatives) && obj(plan.body.creatives[0]) ? plan.body.creatives[0] : {};
    if (!numeric(c.tiktok_item_id)) return [];
    const who = {
      advertiser_id: scope.account_id,
      identity_type: c.identity_type,
      identity_id: c.identity_id,
      ...(c.identity_authorized_bc_id !== undefined ? {identity_authorized_bc_id: c.identity_authorized_bc_id} : {}),
    };
    const identity = await tiktokRead(service, actor, scope, 'tiktok_identity_info_get', who),
      info = obj(identity.data.identity_info) ? identity.data.identity_info : undefined,
      details = {identity_id: c.identity_id, identity_type: c.identity_type, field: 'identity_id'};
    if (!info || String(info.identity_id) !== c.identity_id || info.identity_type !== c.identity_type)
      prerequisite('TikTok did not return this identity for the selected advertiser.', details);
    if (
      c.identity_authorized_bc_id !== undefined &&
      String(info.identity_authorized_bc_id) !== c.identity_authorized_bc_id
    )
      prerequisite('The identity belongs to another Business Center than the one stated.', {
        ...details,
        identity_authorized_bc_id: info.identity_authorized_bc_id ?? null,
      });
    if (info.available_status !== 'AVAILABLE')
      prerequisite('The identity is not available for ads.', {
        ...details,
        available_status: info.available_status ?? null,
      });
    if (info.can_pull_video !== true)
      prerequisite('The identity cannot use its existing posts in ads (can_pull_video is not true).', details);
    if (info.is_gpppa === true)
      prerequisite('Government, politician and political party accounts cannot run Spark Ads.', details);
    assets.push({
      ...base('TikTok identity', String(c.identity_id), 'native_identity_read', identity),
      identity_type: c.identity_type,
      available_status: info.available_status,
      meaning:
        'TikTok returned this identity for the selected advertiser as available and able to use its posts. Spark authorization lifetime and ad review remain unverified; the native ad review runs separately.',
    });
    const posts = await tiktokRead(service, actor, scope, 'tiktok_identity_video_info_get', {
        ...who,
        item_ids: [c.tiktok_item_id],
      }),
      post = (Array.isArray(posts.data.video_details) ? posts.data.video_details : []).find(
        (p: JsonObject) => obj(p) && String(p.item_id) === c.tiktok_item_id,
      );
    if (!post)
      prerequisite('TikTok did not return this post for the identity.', {
        tiktok_item_id: c.tiktok_item_id,
        field: 'tiktok_item_id',
      });
    if (post.item_type !== undefined && post.item_type !== 'VIDEO')
      prerequisite('A single-video Spark Ad needs a video post.', {
        tiktok_item_id: c.tiktok_item_id,
        item_type: post.item_type,
        field: 'tiktok_item_id',
      });
    assets.push({
      ...base('TikTok post', String(c.tiktok_item_id), 'native_identity_post_read', posts),
      item_type: post.item_type ?? null,
      meaning:
        'TikTok returned this post for the identity. Post eligibility for promotion and the ad review remain unverified until TikTok reviews the ad.',
    });
  }
  if (plan.path === '/v1.3/adgroup/create/' && prerequisites.includes('tiktok_pixel') && numeric(plan.body.pixel_id)) {
    const pixelId = plan.body.pixel_id,
      read = await tiktokRead(service, actor, scope, 'tiktok_pixel_list_get', {
        advertiser_id: scope.account_id,
        pixel_id: pixelId,
      }),
      pixel = (Array.isArray(read.data.pixels) ? read.data.pixels : []).find(
        (p: JsonObject) => obj(p) && String(p.pixel_id) === pixelId,
      );
    if (!pixel)
      prerequisite('TikTok did not return this pixel for the selected advertiser.', {
        pixel_id: pixelId,
        field: 'pixel_id',
      });
    if (obj(pixel.asset_ownership) && pixel.asset_ownership.asset_relation_status === 'UNBOUND')
      prerequisite('The pixel has been unbound from this advertiser.', {pixel_id: pixelId, field: 'pixel_id'});
    assets.push({
      ...base('TikTok pixel', pixelId, 'native_pixel_read', read),
      meaning:
        'TikTok returned this pixel for the selected advertiser. Event delivery and objective acceptance remain unverified.',
    });
  }
  return assets;
}

// Writes and campaigns (ARC-04, wave 4c): what recipe_context says of each pack, moved verbatim from
// src/recipe-context.ts, which asks the recipe's provider (its adapter's `campaign.recipes`).
const tiktokLaunchPrerequisite = 'existing TikTok post and account identity with explicit location/schedule inputs';
export const tiktokTrafficContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'Uses an existing TikTok post as a Spark Ad on the TikTok placement and optimizes clicks. Preflight reads the identity and post; ad review and objective acceptance remain unverified. Activation is separate.',
    // Static, with no clock (R2.5 M4, the lead's added item of 2026-11-21): TikTok's Upgraded Smart+ migration guide is wider than the banner the
    // cut-off follows (src/tiktok-manual-cutoff.ts), and the two pages conflict. This pack is not refused, because a create TikTok stops makes nothing;
    // the notice says what the guide says, with its date, and names the Smart+ traffic pack as the route that lasts. Its Arabic is in the catalogue.
    'TikTok’s Upgraded Smart+ migration guide (https://business-api.tiktok.com/portal/docs/upgraded-smart-campaign/v1.3, read 2026-11-21) says that after 2026-12-31 Manual campaigns can no longer be created with /campaign/create/, while /campaign/update/ and /campaign/status/update/ keep working. TikTok’s Create ads page names only the Sales, App Promotion and Lead Generation objectives, so the two pages differ, and AMCP does not refuse this Traffic pack: a create TikTok stops makes nothing. For a route that lasts, use tiktok_smart_plus_website_traffic, the Upgraded Smart+ website traffic pack (the CLICK goal).',
  ]),
  prerequisite: tiktokLaunchPrerequisite,
});
export const tiktokConversionContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'Uses an existing TikTok post as a Spark Ad and optimizes a purchase event of the selected pixel. Preflight reads the identity, post and pixel; event delivery, ad review and objective acceptance remain unverified. Activation is separate.',
    // Static, with no clock (R2.5 M4, L2): the pack is refused from the day itself (src/tiktok-manual-cutoff.ts).
    'TikTok stops manual website purchase campaigns on 2027-01-01; use tiktok_smart_plus_website_conversions.',
  ]),
  prerequisite: tiktokLaunchPrerequisite,
});

// Writes and campaigns (wave 4c): moved verbatim from recipeEligibility (src/recipe-eligibility.ts), which asks the
// recipe's provider (its adapter's `campaign.dependencyEvidence`); the pixel is TikTok's for a TikTok recipe.
/** TikTok launch packs (CMP-07): the identity, post and pixel preflight read for this exact advertiser. */
export function tiktokDependencyEvidence(
  id: string,
  {assets, scope}: DependencyEvidenceContext,
): JsonObject | undefined {
  if (!['tiktok_spark_identity', 'existing_tiktok_post', 'account_owned_pixel'].includes(id)) return undefined;
  const type = {
      tiktok_spark_identity: 'TikTok identity',
      existing_tiktok_post: 'TikTok post',
      account_owned_pixel: 'TikTok pixel',
    }[id as 'tiktok_spark_identity'],
    proof = assets.find(
      a =>
        a.asset_type === type &&
        a.account_id === scope.account_id &&
        a.connection_id === scope.connection_id &&
        a.status === 'provider_read_checked',
    );
  return proof ? {status: 'ready', evidence: proof, meaning: proof.meaning} : undefined;
}
