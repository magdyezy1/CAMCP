import {normalizeAccount} from './account-id.js';
import {responseData, assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {tiktokAudienceGetPath} from './tiktok-paths.js';
import {tiktokConversionGetPath, tiktokPixelListPath} from './tiktok-custom-conversions.js';
import {
  validateTiktokTargeting,
  tiktokTargetingProjection,
  assertTiktokOwnedAudiences,
  tiktokNumericId,
} from './tiktok-targeting.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';
import {activeUnderServingParent, pausedParentChildStatuses} from './paused-parents.js';
import {tiktokAdvertiserRead} from './tiktok-advertiser-state.js';

/**
 * Paused Upgraded Smart+ website-conversion and Instant Form lead generation ad groups, per API for Business v1.3
 * "Create an Upgraded Smart+ Ad Group", "Create an Upgraded Smart+ Lead Generation Campaign with Location as Instant
 * Form" and "Get Upgraded Smart+ Ad Groups" (checked 2026-09-26). TikTok silently ignores targeting fields that do not
 * match the targeting mode, so each mode has its own allowlist here. App, other lead generation destinations, catalog,
 * search, value-based, deep funnel, zip code, Pangle package and allowlist-only settings are outside this contract.
 *
 * R2.5 M4 (package r25-m4-smartweb), click and landing page view ad groups: TikTok stops creating classic Sales campaigns on 2027-01-01,
 * and a regular Upgraded Smart+ Web Campaign is what replaces them, so its website ad group also optimizes for CLICK and for
 * TRAFFIC_LANDING_PAGE_VIEW. "Create an Upgraded Smart+ Ad Group" (https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-ad-group/v1.3)
 * and "Create a regular Upgraded Smart+ Web Campaign" (https://business-api.tiktok.com/portal/docs/create-a-regular-upgraded-smart-web-campaign/v1.3)
 * were read in a browser on 2026-11-20 by the lead's documentation session (impl/r25-m4-DOCS-EVIDENCE.md, row 2). They say:
 * - the goals of a regular Smart+ web campaign (objective WEB_CONVERSIONS, sales_destination WEBSITE) are CLICK, CONVERT,
 *   TRAFFIC_LANDING_PAGE_VIEW and VALUE;
 * - billing_event is CPC for CLICK and OCPM for every other goal;
 * - the custom bid (bid_type BID_TYPE_CUSTOM) is bid_price for CLICK and conversion_bid_price for CONVERT, TRAFFIC_LANDING_PAGE_VIEW,
 *   INSTALL and IN_APP_EVENT, the same fields as the update page (src/tiktok-smart-plus-adgroup-updates.ts);
 * - pixel_id is not supported for CLICK, TRAFFIC_LANDING_PAGE_VIEW, INSTALL and IN_APP_EVENT;
 * - no attribution window is documented for CLICK or TRAFFIC_LANDING_PAGE_VIEW: the page that lists the windows covers CONVERT, VALUE,
 *   INSTALL and IN_APP_EVENT only, and says a goal it does not list cannot be given one by hand.
 * So a click or landing page view ad group reads and sends no pixel, optimization event, custom conversion or attribution field (each
 * refused, fail closed), and bills with CPC or OCPM as its goal says. Live acceptance stays with the checks M4 LV-18 (CLICK) and LV-19
 * (landing page views) on the test advertiser; whether TikTok accepts an ad group created ENABLE under a DISABLE campaign is not
 * documented and stays UNVERIFIED until LV-18 (L1-05, src/provider-adapters.ts).
 */
export const tiktokSmartPlusAdgroupPath = '/v1.3/smart_plus/adgroup/create/';
export const tiktokSmartPlusAdgroupSource =
  'https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-ad-group/v1.3';
const keys = [
  'advertiser_id',
  'request_id',
  'campaign_id',
  'operation_status',
  'adgroup_name',
  'promotion_type',
  'promotion_target_type',
  'optimization_goal',
  'pixel_id',
  'optimization_event',
  'custom_conversion_id',
  'bid_type',
  'bid_price',
  'conversion_bid_price',
  'click_attribution_window',
  'view_attribution_window',
  'engaged_view_attribution_window',
  'attribution_event_count',
  'billing_event',
  'targeting_optimization_mode',
  'suggestion_audience_enabled',
  'targeting_spec',
  'budget_mode',
  'budget',
  'schedule_type',
  'schedule_start_time',
  'schedule_end_time',
  'dayparting',
  'placement_type',
  'placements',
  'comment_disabled',
  'share_disabled',
  'video_download_disabled',
];
const automatic = ['location_ids', 'spc_audience_age', 'languages', 'operating_systems', 'excluded_audience_ids'];
const suggestions = [
  ...automatic,
  'age_groups',
  'gender',
  'audience_ids',
  'interest_category_ids',
  'interest_keyword_ids',
  'actions',
];
const manual = [
  'location_ids',
  'age_groups',
  'gender',
  'languages',
  'audience_ids',
  'excluded_audience_ids',
  'interest_category_ids',
  'interest_keyword_ids',
  'actions',
  'operating_systems',
  'min_android_version',
  'min_ios_version',
  'device_model_ids',
  'network_types',
  'carrier_ids',
  'device_price_ranges',
];
// Pixel standard events usable for optimization (the Custom Conversion event list without PAGE_VIEW, which TikTok documents as not optimizable).
const events = [
  'ADD_BILLING',
  'ON_WEB_CART',
  'ON_WEB_ADD_TO_WISHLIST',
  'APPLICATION_APPROVAL',
  'BUTTON',
  'ON_WEB_REGISTER',
  'CONSULT',
  'CUSTOMIZE_PRODUCT',
  'DOWNLOAD_START',
  'FIND_LOCATION',
  'INITIATE_ORDER',
  'ON_WEB_ORDER',
  'SHOPPING',
  'SCHEDULE',
  'ON_WEB_SEARCH',
  'START_TRIAL',
  'SUBMIT_APPLICATION',
  'ON_WEB_SUBSCRIBE',
  'ON_WEB_DETAIL',
];
const clicks = ['OFF', 'ONE_DAY', 'SEVEN_DAYS', 'FOURTEEN_DAYS', 'TWENTY_EIGHT_DAYS'],
  views = ['OFF', 'ONE_DAY', 'SEVEN_DAYS'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const emoji = /\p{Extended_Pictographic}/u;
const amount = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && Math.abs(v * 100 - Math.round(v * 100)) <= 1e-9;
const time = (v: unknown) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v.replace(' ', 'T') + 'Z'));

export const tiktokSmartPlusAdgroupKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokSmartPlusAdgroupPath;
/** Instant Form lead generation ad groups optimize for form submissions and use no pixel. */
export const tiktokSmartPlusLeadAdgroup = (b: JsonObject) => b.promotion_type === 'LEAD_GENERATION';
/** Fields that only website conversion ad groups carry. */
const websiteOnly = [
  'pixel_id',
  'optimization_event',
  'custom_conversion_id',
  'click_attribution_window',
  'view_attribution_window',
  'engaged_view_attribution_window',
  'attribution_event_count',
];
/**
 * The website goals of this contract and what each takes (R2.5 M4; the module comment says where each fact is from): its billing event
 * (CPC for CLICK, OCPM for every other goal), the field of its custom bid, and whether it optimizes for a pixel event. The row of VALUE
 * waits for someone to ask for it.
 */
const websiteGoals: Readonly<Record<string, {billing: string; bid: string; pixel: boolean}>> = Object.freeze({
  CONVERT: {billing: 'OCPM', bid: 'conversion_bid_price', pixel: true},
  CLICK: {billing: 'CPC', bid: 'bid_price', pixel: false},
  TRAFFIC_LANDING_PAGE_VIEW: {billing: 'OCPM', bid: 'conversion_bid_price', pixel: false},
});
/** The goal's row for a website ad group, or undefined for a lead generation ad group and for a goal outside the contract. */
const websiteGoal = (b: JsonObject) =>
  b.promotion_type === 'WEBSITE' &&
  typeof b.optimization_goal === 'string' &&
  Object.hasOwn(websiteGoals, b.optimization_goal)
    ? websiteGoals[b.optimization_goal]
    : undefined;
/** Whether the ad group optimizes for an event of a pixel: a website conversion ad group, and neither a click nor a lead generation one. */
const usesPixel = (b: JsonObject) => websiteGoal(b)?.pixel === true;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_ADGROUP', message, {field});
}
/** The documented defaults for the targeting mode, applied so review and verification compare what TikTok creates. */
export const tiktokSmartPlusTargetingMode = (b: JsonObject) => ({
  mode: (b.targeting_optimization_mode ?? 'AUTOMATIC') as string,
  suggest: b.suggestion_audience_enabled === true,
});

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSmartPlusAdgroup(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(k => !keys.includes(k));
  if (extra)
    invalid(
      extra,
      '"' +
        extra +
        '" is outside the qualified Smart+ ad group contract (website conversion, click and landing page view and Instant Form lead generation ad groups).',
    );
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if (
    typeof body.request_id !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(body.request_id) ||
    BigInt(body.request_id) > 9223372036854775807n
  )
    invalid(
      'request_id',
      'request_id is required: a string holding a positive 64-bit integer, which TikTok uses to create the ad group only once.',
    );
  if (!tiktokNumericId(body.campaign_id))
    invalid('campaign_id', 'campaign_id must be the numeric ID of an Upgraded Smart+ campaign.');
  // DISABLE, or ENABLE under a Smart+ campaign the review reads DISABLE (Q14, owner 2026-11-15; R2.5 M4, L1-05): the paused-parent rule of
  // src/paused-parents.ts decides that on the state it reads, at prepare and again at execute, so this shape check allows what its level does.
  if (!(pausedParentChildStatuses(plan) ?? ['DISABLE']).includes(body.operation_status))
    invalid(
      'operation_status',
      'Send operation_status DISABLE, or ENABLE under a Smart+ campaign the review reads DISABLE: TikTok enables new Smart+ ad groups by default.',
    );
  const name = body.adgroup_name;
  if (typeof name !== 'string' || !name.trim() || [...name].length > 512 || emoji.test(name))
    invalid('adgroup_name', 'adgroup_name must be nonempty text of at most 512 characters without emoji.');
  const lead = tiktokSmartPlusLeadAdgroup(body),
    goal = lead ? undefined : websiteGoal(body);
  if (lead) {
    if (body.promotion_target_type !== 'INSTANT_PAGE' || body.optimization_goal !== 'LEAD_GENERATION')
      invalid(
        'promotion_target_type',
        'Lead generation ad groups are qualified with an Instant Form: promotion_target_type INSTANT_PAGE and optimization_goal LEAD_GENERATION.',
      );
    const web = websiteOnly.find(k => body[k] !== undefined);
    if (web)
      invalid(
        web,
        '"' + web + '" belongs to website conversion ad groups; Instant Form ad groups optimize for form submissions.',
      );
  } else {
    if (!goal)
      invalid(
        'optimization_goal',
        'Qualified ad groups are website ad groups (promotion_type WEBSITE) that optimize for CONVERT, CLICK or TRAFFIC_LANDING_PAGE_VIEW, or Instant Form lead generation ad groups (promotion_type LEAD_GENERATION).',
      );
    if (body.promotion_target_type !== undefined)
      invalid('promotion_target_type', 'promotion_target_type applies to lead generation ad groups only.');
    if (goal.pixel) {
      if (!tiktokNumericId(body.pixel_id))
        invalid('pixel_id', 'pixel_id must be the numeric ID of the pixel to optimize for.');
      if (!events.includes(body.optimization_event))
        invalid(
          'optimization_event',
          'optimization_event must be an optimizable pixel event: ' + events.join(', ') + '.',
        );
      if (body.custom_conversion_id !== undefined && !tiktokNumericId(body.custom_conversion_id))
        invalid('custom_conversion_id', 'custom_conversion_id must be a numeric custom conversion ID.');
    } else {
      // TikTok supports no pixel for CLICK or TRAFFIC_LANDING_PAGE_VIEW and documents no attribution window for either (the module
      // comment), so each field a conversion ad group carries is refused on a click or landing page view one.
      const web = websiteOnly.find(k => body[k] !== undefined);
      if (web)
        invalid(
          web,
          'A click or landing page view ad group takes no pixel, optimization event, custom conversion or attribution setting: TikTok does not support them for these goals.',
        );
    }
  }
  // The custom bid is bid_price on a click ad group and conversion_bid_price on every other goal; the other field is refused, so that
  // a bid is never sent in a field its goal does not read.
  const bid = goal?.bid ?? 'conversion_bid_price';
  if (bid === 'bid_price') {
    if (body.conversion_bid_price !== undefined)
      invalid('conversion_bid_price', 'A CLICK ad group sets its custom bid in bid_price, not conversion_bid_price.');
  } else if (body.bid_price !== undefined)
    invalid('bid_price', 'bid_price is the custom bid of a CLICK ad group; this ad group sets conversion_bid_price.');
  if (body.bid_type === 'BID_TYPE_CUSTOM') {
    if (!amount(body[bid])) {
      if (bid === 'bid_price')
        invalid(
          'bid_price',
          'A custom bid (BID_TYPE_CUSTOM) on a CLICK ad group needs bid_price: a positive amount with at most two decimals.',
        );
      invalid(
        'conversion_bid_price',
        'Cost cap bidding needs conversion_bid_price: a positive amount with at most two decimals.',
      );
    }
  } else if (body.bid_type === 'BID_TYPE_NO_BID') {
    if (body[bid] !== undefined) {
      if (bid === 'bid_price') invalid('bid_price', 'Maximum delivery (BID_TYPE_NO_BID) takes no bid_price.');
      invalid('conversion_bid_price', 'Maximum delivery (BID_TYPE_NO_BID) takes no conversion_bid_price.');
    }
  } else invalid('bid_type', 'bid_type must be BID_TYPE_NO_BID or BID_TYPE_CUSTOM.');
  const billing = goal?.billing ?? 'OCPM';
  if (body.billing_event !== billing) {
    if (billing === 'CPC') invalid('billing_event', 'Click ad groups bill with CPC.');
    invalid('billing_event', 'Website conversion, landing page view and lead generation ad groups bill with OCPM.');
  }
  const windows = ['click_attribution_window', 'view_attribution_window', 'engaged_view_attribution_window'].filter(
    k => body[k] !== undefined,
  );
  if (windows.length && (body.click_attribution_window === undefined || body.view_attribution_window === undefined))
    invalid(
      'click_attribution_window',
      'Attribution windows are set together: click_attribution_window and view_attribution_window, optionally engaged_view_attribution_window.',
    );
  if (body.click_attribution_window !== undefined && !clicks.includes(body.click_attribution_window))
    invalid('click_attribution_window', 'click_attribution_window must be one of ' + clicks.join(', ') + '.');
  for (const k of ['view_attribution_window', 'engaged_view_attribution_window'])
    if (body[k] !== undefined && !views.includes(body[k])) invalid(k, k + ' must be one of ' + views.join(', ') + '.');
  if (body.attribution_event_count !== undefined && !['UNSET', 'EVERY', 'ONCE'].includes(body.attribution_event_count))
    invalid('attribution_event_count', 'attribution_event_count must be UNSET, EVERY or ONCE.');
  if (
    body.targeting_optimization_mode !== undefined &&
    !['AUTOMATIC', 'MANUAL'].includes(body.targeting_optimization_mode)
  )
    invalid('targeting_optimization_mode', 'targeting_optimization_mode must be AUTOMATIC or MANUAL.');
  const {mode, suggest} = tiktokSmartPlusTargetingMode(body);
  if (
    body.suggestion_audience_enabled !== undefined &&
    (typeof body.suggestion_audience_enabled !== 'boolean' || mode !== 'AUTOMATIC')
  )
    invalid(
      'suggestion_audience_enabled',
      'suggestion_audience_enabled is a boolean that applies to AUTOMATIC targeting only.',
    );
  const spec = body.targeting_spec;
  if (!obj(spec)) invalid('targeting_spec', 'targeting_spec is required.');
  const allowed = mode === 'MANUAL' ? manual : suggest ? suggestions : automatic;
  const ignored = Object.keys(spec).find(k => !allowed.includes(k));
  if (ignored)
    invalid(
      'targeting_spec/' + ignored,
      '"' +
        ignored +
        '" is not used with ' +
        (mode === 'MANUAL'
          ? 'MANUAL targeting'
          : suggest
            ? 'AUTOMATIC targeting with audience suggestions'
            : 'AUTOMATIC targeting without audience suggestions') +
        '; TikTok would silently ignore it.',
    );
  if (spec.spc_audience_age !== undefined && !['OVER_EIGHTEEN', 'OVER_TWENTY_FIVE'].includes(spec.spc_audience_age))
    invalid(
      'targeting_spec/spc_audience_age',
      'spc_audience_age must be OVER_EIGHTEEN or OVER_TWENTY_FIVE (ALL is allowlist-only).',
    );
  // Only app promotion ad groups may target 13-17 year olds.
  validateTiktokTargeting(spec, invalid, {
    path: 'targeting_spec/',
    maxAges: ['AGE_18_24', 'AGE_25_34', 'AGE_35_44', 'AGE_45_54', 'AGE_55_100'],
  });
  if (
    body.budget_mode !== undefined &&
    !['BUDGET_MODE_TOTAL', 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET'].includes(body.budget_mode)
  )
    invalid('budget_mode', 'budget_mode must be BUDGET_MODE_TOTAL or BUDGET_MODE_DYNAMIC_DAILY_BUDGET.');
  if ((body.budget_mode === undefined) !== (body.budget === undefined))
    invalid('budget', 'budget_mode and budget are set together, for campaigns without campaign budget optimization.');
  if (body.budget !== undefined && !amount(body.budget))
    invalid('budget', 'budget must be a positive amount with at most two decimals.');
  if (!['SCHEDULE_FROM_NOW', 'SCHEDULE_START_END'].includes(body.schedule_type))
    invalid('schedule_type', 'schedule_type must be SCHEDULE_FROM_NOW or SCHEDULE_START_END.');
  if (!time(body.schedule_start_time) || body.schedule_start_time >= '2028-01-01 00:00:00')
    invalid('schedule_start_time', 'schedule_start_time is YYYY-MM-DD HH:MM:SS in UTC, before 2028-01-01 00:00:00.');
  if (body.schedule_type === 'SCHEDULE_START_END') {
    if (
      !time(body.schedule_end_time) ||
      body.schedule_end_time > '2038-01-01 00:00:00' ||
      body.schedule_end_time <= body.schedule_start_time
    )
      invalid(
        'schedule_end_time',
        'schedule_end_time is YYYY-MM-DD HH:MM:SS in UTC, after the start and no later than 2038-01-01 00:00:00.',
      );
  } else if (body.schedule_end_time !== undefined) invalid('schedule_end_time', 'SCHEDULE_FROM_NOW takes no end time.');
  if (body.budget_mode === 'BUDGET_MODE_TOTAL' && body.schedule_type !== 'SCHEDULE_START_END')
    invalid('schedule_type', 'A lifetime budget needs SCHEDULE_START_END with an end time.');
  // The converse: a schedule with an end needs a total budget on the campaign or the ad group (R2.5 M4, S2-1, the lead's review of eb0c133f). TikTok's
  // update page allows SCHEDULE_START_END only then (DOCS-EVIDENCE row 4, 2026-11-20; the create page's text is unread, LV-19), so the contract fails
  // closed: an ad group that carries its own dynamic daily budget says so itself, here; one under campaign budget optimization is judged on the
  // campaign's mode, which the review reads (tiktokSmartPlusAdgroupImpact).
  if (body.schedule_type === 'SCHEDULE_START_END' && body.budget_mode === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET')
    invalid(
      'schedule_type',
      'A schedule with an end (SCHEDULE_START_END) needs a total budget (BUDGET_MODE_TOTAL) on the campaign or the ad group.',
    );
  if (body.dayparting !== undefined && (typeof body.dayparting !== 'string' || !/^[01]{336}$/.test(body.dayparting)))
    invalid('dayparting', 'dayparting is 336 characters of 0 and 1 (48 half hours for each day, Monday first).');
  if (
    body.placement_type !== undefined &&
    !['PLACEMENT_TYPE_AUTOMATIC', 'PLACEMENT_TYPE_NORMAL'].includes(body.placement_type)
  )
    invalid('placement_type', 'placement_type must be PLACEMENT_TYPE_AUTOMATIC or PLACEMENT_TYPE_NORMAL.');
  const placements = lead
    ? ['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE', 'PLACEMENT_GLOBAL_APP_BUNDLE']
    : ['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE'];
  if (body.placement_type === 'PLACEMENT_TYPE_NORMAL') {
    const p = body.placements;
    if (!Array.isArray(p) || !p.length || !p.every(v => placements.includes(v)) || new Set(p).size !== p.length)
      invalid('placements', 'Selected placements are one or more of ' + placements.join(', ') + '.');
  } else if (body.placements !== undefined)
    invalid(
      'placements',
      'placements apply only with PLACEMENT_TYPE_NORMAL; TikTok overwrites them under automatic placement.',
    );
  for (const k of ['comment_disabled', 'share_disabled', 'video_download_disabled'])
    if (body[k] !== undefined && typeof body[k] !== 'boolean') invalid(k, k + ' must be true or false.');
}

export function tiktokSmartPlusAdgroupReads(
  plan: CompiledRequest,
): {path: string; query: JsonObject; action: string}[] {
  const b = plan.body as JsonObject,
    advertiser_id = plan.accountId,
    spec = b.targeting_spec as JsonObject;
  const audiences = [...new Set<string>([...(spec.audience_ids ?? []), ...(spec.excluded_audience_ids ?? [])])].sort();
  return [
    {
      path: '/v1.3/smart_plus/campaign/get/',
      query: {advertiser_id, filtering: {campaign_ids: [b.campaign_id]}, page_size: 100},
      action: 'tiktok_smart_plus_campaign_get',
    },
    // Only a conversion ad group optimizes for a pixel event: a lead generation or click ad group reads no pixel (R2.5 M4).
    ...(usesPixel(b)
      ? [{path: tiktokPixelListPath, query: {advertiser_id, pixel_id: b.pixel_id}, action: 'tiktok_pixel_list_get'}]
      : []),
    ...(b.custom_conversion_id !== undefined
      ? [
          {
            path: tiktokConversionGetPath,
            query: {
              advertiser_id,
              custom_conversion_id: b.custom_conversion_id,
              event_source_type: 'PIXEL',
              event_source_id: b.pixel_id,
            },
            action: 'tiktok_custom_conversion_get',
          },
        ]
      : []),
    ...(audiences.length
      ? [
          {
            path: tiktokAudienceGetPath,
            query: {advertiser_id, custom_audience_ids: audiences},
            action: 'tiktok_dmp_custom_audience_get',
          },
        ]
      : []),
  ];
}

const lists = (state: unknown[]) =>
  state.flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : [])) as JsonObject[];
/** Against the normalized review state: a matching Smart+ campaign, a usable pixel and eligible custom conversion for website conversions, owned audiences and a budget and bid that fit the campaign. */
export function tiktokSmartPlusAdgroupImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const b = plan.body as JsonObject,
    spec = b.targeting_spec as JsonObject,
    {mode, suggest} = tiktokSmartPlusTargetingMode(b),
    lead = tiktokSmartPlusLeadAdgroup(b),
    goal = b.optimization_goal;
  const campaign = lists(state).find(r => String(r.campaign_id) === b.campaign_id && r.objective_type !== undefined);
  if (!campaign)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Smart+ campaign ' + b.campaign_id + ' was not returned for the selected advertiser.',
      {campaign_id: b.campaign_id},
    );
  if (lead) {
    if (
      campaign.objective_type !== 'LEAD_GENERATION' ||
      campaign.catalog_enabled === true ||
      campaign.is_search_campaign === true
    )
      invalid(
        'campaign_id',
        'Smart+ campaign ' + b.campaign_id + ' is not a lead generation campaign without catalog or search.',
      );
  } else if (
    campaign.objective_type !== 'WEB_CONVERSIONS' ||
    campaign.sales_destination !== 'WEBSITE' ||
    campaign.catalog_enabled === true ||
    campaign.is_search_campaign === true
  )
    invalid(
      'campaign_id',
      'Smart+ campaign ' + b.campaign_id + ' is not a website conversion campaign without catalog or search.',
    );
  const cbo = campaign.budget_optimize_on !== false;
  if (cbo && b.budget !== undefined)
    invalid(
      'budget',
      'The campaign uses campaign budget optimization, so TikTok ignores ad group budgets. Remove budget_mode and budget.',
    );
  if (!cbo && b.budget === undefined)
    invalid(
      'budget',
      'The campaign does not use campaign budget optimization, so the ad group needs budget_mode and budget.',
    );
  if (!cbo && campaign.budget_mode === 'BUDGET_MODE_DAY' && b.budget_mode !== 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET')
    invalid('budget_mode', 'Under a campaign daily limit, ad groups use BUDGET_MODE_DYNAMIC_DAILY_BUDGET.');
  const dynamic = cbo
    ? campaign.budget_mode === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET'
    : b.budget_mode === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET';
  if (b.schedule_type === 'SCHEDULE_FROM_NOW' && !dynamic)
    invalid('schedule_type', 'SCHEDULE_FROM_NOW needs a dynamic daily budget on the campaign or the ad group.');
  const total = cbo ? campaign.budget_mode === 'BUDGET_MODE_TOTAL' : b.budget_mode === 'BUDGET_MODE_TOTAL';
  if (b.schedule_type === 'SCHEDULE_START_END' && !total)
    invalid(
      'schedule_type',
      'A schedule with an end (SCHEDULE_START_END) needs a total budget (BUDGET_MODE_TOTAL) on the campaign or the ad group.',
    );
  if (lead && b.bid_type === 'BID_TYPE_CUSTOM' && !dynamic)
    invalid('bid_type', 'A target CPA (BID_TYPE_CUSTOM) needs a dynamic daily budget on the campaign or the ad group.');
  const pixel = usesPixel(b)
    ? (state
        .flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.pixels) ? s.data.pixels : []))
        .find((p: JsonObject) => String(p.pixel_id) === b.pixel_id) as JsonObject | undefined)
    : undefined;
  if (usesPixel(b) && !pixel)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Pixel ' + b.pixel_id + ' was not returned for the selected advertiser.',
      {pixel_id: b.pixel_id},
    );
  if (pixel && obj(pixel.asset_ownership) && pixel.asset_ownership.asset_relation_status === 'UNBOUND')
    invalid('pixel_id', 'Pixel ' + b.pixel_id + ' has been unbound from this advertiser.');
  if (b.custom_conversion_id !== undefined) {
    const c = state
      .map(s => (obj(s) && obj(s.data) ? s.data : undefined))
      .find(d => d !== undefined && d.custom_conversion_id === b.custom_conversion_id && Object.hasOwn(d, 'eligible'));
    if (!c)
      throw new MirrorError('STATE_TARGET_MISMATCH', 'The custom conversion was not returned for this pixel.', {
        custom_conversion_id: b.custom_conversion_id,
      });
    if (c.event_source_id !== b.pixel_id || c.optimization_event !== b.optimization_event)
      invalid(
        'custom_conversion_id',
        'Custom conversion ' +
          b.custom_conversion_id +
          ' must belong to pixel ' +
          b.pixel_id +
          " and use the ad group's optimization_event " +
          b.optimization_event +
          '.',
      );
    if (c.eligible !== true)
      invalid(
        'custom_conversion_id',
        'Custom conversion ' +
          b.custom_conversion_id +
          ' has no qualifying pixel activity yet; TikTok accepts it only when ACTIVE or NO_RECENT_ACTIVITY.',
      );
  }
  assertTiktokOwnedAudiences(
    state,
    [...new Set<string>([...(spec.audience_ids ?? []), ...(spec.excluded_audience_ids ?? [])])],
    invalid,
    'Smart+ ad groups',
  );
  // An ad group created ENABLE under a campaign the review reads serving (Q1, owner 2026-11-15; R2.5 M4, r25-m4-smartops) starts serving at
  // once, so execute asks for spend_change_confirmed (src/tiktok-serving-children.ts); under a campaign read paused it delivers nothing.
  const serving = activeUnderServingParent(plan, state);
  return {
    provider: 'tiktok',
    scope: 'smart_plus_adgroups',
    may_affect_serving: serving,
    // An ad group created ENABLE (Q14, L1-05) under a campaign the review read paused delivers nothing until that campaign is turned on; one
    // under a campaign that serves (Q1) serves at once; a prepare or an execute under a campaign it could not read is refused (PARENT_SERVING).
    effect:
      'Creates ' +
      (b.operation_status === 'ENABLE' ? 'an enabled' : 'a paused') +
      ' Upgraded Smart+ ' +
      (lead
        ? 'Instant Form lead generation'
        : goal === 'CLICK'
          ? 'website click'
          : goal === 'TRAFFIC_LANDING_PAGE_VIEW'
            ? 'website landing page view'
            : 'website conversion') +
      ' ad group in campaign ' +
      b.campaign_id +
      (serving
        ? ', which the review reads as serving: it starts serving at once (Q1), so execute needs spend_change_confirmed.'
        : b.operation_status === 'ENABLE'
          ? ', which the review reads paused. Nothing delivers until the campaign is enabled, a separate reviewed status change.'
          : '. Nothing delivers until it has reviewed ads and a reviewed status change turns it on.'),
    adgroup: {
      name: b.adgroup_name,
      optimization: lead
        ? 'form submissions (LEAD_GENERATION, Instant Form)'
        : goal === 'CLICK'
          ? 'clicks (CPC)'
          : goal === 'TRAFFIC_LANDING_PAGE_VIEW'
            ? 'landing page views (OCPM)'
            : b.optimization_event,
      pixel: pixel
        ? {
            pixel_id: b.pixel_id,
            name: pixel.pixel_name ?? null,
            owned: obj(pixel.asset_ownership) ? pixel.asset_ownership.ownership_status === true : null,
          }
        : null,
      custom_conversion_id: b.custom_conversion_id ?? null,
      bidding:
        b.bid_type !== 'BID_TYPE_CUSTOM'
          ? 'maximum delivery'
          : goal === 'CLICK'
            ? {cpc_bid: b.bid_price}
            : {cost_cap: b.conversion_bid_price},
      budget: cbo
        ? 'campaign budget (' + campaign.budget_mode + ' ' + campaign.budget + ')'
        : {mode: b.budget_mode, amount: b.budget},
      targeting: {
        mode,
        audience_suggestions: suggest,
        locations: (spec.location_ids as string[]).length,
        fields: Object.keys(spec),
      },
      schedule: {type: b.schedule_type, start: b.schedule_start_time, end: b.schedule_end_time ?? null},
    },
    source: tiktokSmartPlusAdgroupSource,
  };
}

export const tiktokSmartPlusAdgroupId = (d: JsonObject) =>
  obj(d.data) && tiktokNumericId(d.data.adgroup_id) ? (d.data.adgroup_id as string) : undefined;
/** The sent configuration with documented defaults, in the form the ad group read compares. */
export function tiktokSmartPlusAdgroupVerification(plan: CompiledRequest, result: JsonObject) {
  const d = obj(result.data) ? result.data : {},
    id = tiktokSmartPlusAdgroupId(d),
    b = plan.body as JsonObject,
    {mode} = tiktokSmartPlusTargetingMode(b);
  if (!id) throw new MirrorError('VERIFICATION_UNSUPPORTED', 'The creation receipt has no ad group ID.');
  const expected: JsonObject = {adgroup_id: id};
  for (const k of keys)
    if (!['advertiser_id', 'request_id', 'targeting_spec', 'placements'].includes(k) && b[k] !== undefined)
      expected[k] = b[k];
  expected.targeting_optimization_mode = mode;
  expected.targeting_spec = tiktokTargetingProjection(b.targeting_spec, Object.keys(b.targeting_spec as JsonObject));
  if (b.placements !== undefined) expected.placements = [...(b.placements as string[])].sort();
  return [
    {
      path: '/v1.3/smart_plus/adgroup/get/',
      query: {advertiser_id: plan.accountId, filtering: {adgroup_ids: [id]}, page_size: 100},
      expected,
      id,
    },
  ];
}
/** The ad group read in comparable form: targeting sets and price ranges normalized, placements as a set. */
export function tiktokSmartPlusAdgroupProjection(row: unknown): JsonObject | undefined {
  if (!obj(row)) return undefined;
  const spec = obj(row.targeting_spec) ? row.targeting_spec : {};
  return {
    ...row,
    targeting_spec: tiktokTargetingProjection(spec, Object.keys(spec)),
    ...(Array.isArray(row.placements) ? {placements: [...row.placements].map(String).sort()} : {}),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokSmartPlusAdgroupFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_smart_plus_adgroups',
  files: [
    'src/tiktok-smart-plus-adgroups.ts',
    ['tests/tiktok-smart-plus-adgroups.test.mjs', 'tests/tiktok-smart-plus-lead-adgroups.test.mjs'],
  ],
  kind: tiktokSmartPlusAdgroupKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokSmartPlusAdgroup(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) => {
    const id = normalizeAccount(plan.gateway, plan.accountId!);
    return [
      tiktokAdvertiserRead(stateRead, id),
      ...tiktokSmartPlusAdgroupReads(plan).map(r => {
        const read = stateRead(r.path, r.query);
        read.action = r.action;
        // The Smart+ campaign an ad group is created in is its PARENT (R2.5 M1, S3-5): metadata for the review's ordering and
        // the rotation harness; its state is the family's own projection.
        if (r.path === '/v1.3/smart_plus/campaign/get/') read.stateRole = 'parent';
        return read;
      }),
    ];
  },
  impact: tiktokSmartPlusAdgroupImpact,
  outcome: (plan, result) => {
    const d = responseData(result);
    return d.code === 0 && !!tiktokSmartPlusAdgroupId(d);
  },
  verification: (plan, result, before, verificationRead) =>
    tiktokSmartPlusAdgroupVerification(plan, result).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_smart_plus_adgroup_get'},
    })),
});
