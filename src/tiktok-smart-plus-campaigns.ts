import {normalizeAccount} from './account-id.js';
import {responseData, assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';
import {tiktokAdvertiserRead} from './tiktok-advertiser-state.js';

/**
 * Paused Upgraded Smart+ website-conversion and lead-generation campaigns, per API for Business v1.3 "Create an
 * Upgraded Smart+ Campaign" and "Get Upgraded Smart+ Campaigns" (checked 2026-09-26). App, catalog,
 * promotional, iOS dedicated and RTA campaigns, and allowlist-only Goal-based budget increase, are outside this
 * contract. Campaigns are created with operation_status DISABLE, since TikTok's default is ENABLE.
 *
 * R2.5 M4 (package r25-m4-search2): a Search campaign. TikTok's hub "Create Upgraded Smart+ Search Ads Campaigns"
 * (https://business-api.tiktok.com/portal/docs/create-upgraded-smart-search-ads-campaigns/v1.3) and its Sales/Web non-catalog page
 * (https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-non-catalog-search-ads-campaign-for-web/v1.3), as the lead's
 * documentation session read them on 2026-11-20 (impl/r25-m4-DOCS-EVIDENCE.md, section 6), say that /smart_plus/campaign/create/ takes
 * `is_search_campaign: true` with objective_type WEB_CONVERSIONS and sales_destination WEBSITE (Sales with a website destination), and
 * for Lead Generation; the hub offers no Traffic. The key is a boolean. TikTok fixes it once the campaign exists (the manual create
 * page: "Once set, this field cannot be updated"), so the edit family (src/tiktok-smart-plus-campaign-updates.ts) keeps refusing it.
 * Search campaigns are allowlist-only for each objective: an advertiser that is not on the list is refused at this create with code
 * 40118 (Return codes, read 2026-11-20), which AMCP records as rejected with nothing created (src/tiktok-write-rejection.ts), and no read
 * shows the list, so the review names it. What the pages leave open (the budget structure of a Search campaign, among it) is not
 * restricted here beyond the rules above: TikTok's own refusal is definitive. The objective rules below already allow nothing but the two
 * shapes, so the key adds no case of its own.
 */
export const tiktokSmartPlusCampaignPath = '/v1.3/smart_plus/campaign/create/';
export const tiktokSmartPlusCampaignSource =
  'https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-campaign/v1.3';
const keys = [
  'advertiser_id',
  'request_id',
  'operation_status',
  'objective_type',
  'sales_destination',
  'campaign_type',
  'campaign_name',
  'special_industries',
  'budget_optimize_on',
  'budget_mode',
  'budget',
  'po_number',
  'is_search_campaign',
];
/**
 * What the review of a Search campaign says of the list that decides it (R2.5 M4, package r25-m4-search2): TikTok documents no read of
 * its Search allowlist, so only its refusal at this create tells.
 */
export const tiktokSmartPlusSearchAllowlistNotice =
  'Smart+ Search campaigns are allowlist-only for each objective: TikTok refuses an advertiser that is not on its allowlist for this objective with code 40118, and nothing is created.';
const cboModes = ['BUDGET_MODE_DYNAMIC_DAILY_BUDGET', 'BUDGET_MODE_TOTAL'];
const limitModes = ['BUDGET_MODE_INFINITE', 'BUDGET_MODE_DAY', 'BUDGET_MODE_TOTAL'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const emoji = /\p{Extended_Pictographic}/u;
// TikTok counts each Chinese or Japanese character as two.
const width = (s: string) => [...s].reduce((n, c) => n + (/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(c) ? 2 : 1), 0);

export const tiktokSmartPlusCampaignKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokSmartPlusCampaignPath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_CAMPAIGN', message, {field});
}
/** The documented defaults, applied so review and verification compare the campaign TikTok will create. */
export function tiktokSmartPlusCampaignSettings(body: JsonObject): JsonObject {
  const cbo = body.budget_optimize_on ?? true;
  return {cbo, mode: body.budget_mode ?? (cbo ? 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET' : 'BUDGET_MODE_INFINITE')};
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSmartPlusCampaign(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(k => !keys.includes(k));
  if (extra)
    invalid(
      extra,
      '"' +
        extra +
        '" is outside the qualified Smart+ campaign contract (app, catalog, promotional, iOS dedicated, RTA and Goal-based budget increase campaigns are not qualified).',
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
      'request_id is required: a string holding a positive 64-bit integer, which TikTok uses to create the campaign only once.',
    );
  if (body.operation_status !== 'DISABLE')
    invalid(
      'operation_status',
      'Send operation_status DISABLE: TikTok enables new Smart+ campaigns by default. Turn them on later with a reviewed status change.',
    );
  if (!['WEB_CONVERSIONS', 'LEAD_GENERATION'].includes(body.objective_type))
    invalid('objective_type', 'objective_type must be WEB_CONVERSIONS or LEAD_GENERATION.');
  if (
    body.objective_type === 'WEB_CONVERSIONS'
      ? body.sales_destination !== 'WEBSITE'
      : body.sales_destination !== undefined
  )
    invalid(
      'sales_destination',
      body.objective_type === 'WEB_CONVERSIONS'
        ? 'Website conversion campaigns need sales_destination WEBSITE; app destinations need a catalog and are not qualified.'
        : 'Lead generation campaigns take no sales_destination.',
    );
  // A Search campaign (R2.5 M4): the two objective shapes above are the ones TikTok's pages document it for, so only the type is checked.
  if (body.is_search_campaign !== undefined && typeof body.is_search_campaign !== 'boolean')
    invalid('is_search_campaign', 'is_search_campaign must be true or false.');
  if (body.campaign_type !== undefined && body.campaign_type !== 'REGULAR_CAMPAIGN')
    invalid('campaign_type', 'Only REGULAR_CAMPAIGN is qualified.');
  const name = body.campaign_name;
  if (typeof name !== 'string' || !name.trim() || width(name) > 512 || emoji.test(name))
    invalid(
      'campaign_name',
      'campaign_name must be nonempty, at most 512 characters (Chinese and Japanese count twice) and without emoji.',
    );
  const industries = body.special_industries;
  if (
    industries !== undefined &&
    (!Array.isArray(industries) ||
      !industries.every(v => ['HOUSING', 'EMPLOYMENT', 'CREDIT'].includes(v)) ||
      new Set(industries).size !== industries.length)
  )
    invalid('special_industries', 'special_industries lists unique values from HOUSING, EMPLOYMENT and CREDIT.');
  if (body.budget_optimize_on !== undefined && typeof body.budget_optimize_on !== 'boolean')
    invalid('budget_optimize_on', 'budget_optimize_on must be true or false.');
  const {cbo, mode} = tiktokSmartPlusCampaignSettings(body);
  if (!(cbo ? cboModes : limitModes).includes(mode))
    invalid(
      'budget_mode',
      cbo
        ? 'With campaign budget optimization, budget_mode is BUDGET_MODE_DYNAMIC_DAILY_BUDGET or BUDGET_MODE_TOTAL.'
        : 'Without campaign budget optimization, budget_mode is BUDGET_MODE_INFINITE, BUDGET_MODE_DAY or BUDGET_MODE_TOTAL.',
    );
  const v = body.budget;
  if (mode === 'BUDGET_MODE_INFINITE') {
    if (v !== undefined) invalid('budget', 'BUDGET_MODE_INFINITE takes no budget.');
  } else if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || Math.abs(v * 100 - Math.round(v * 100)) > 1e-9)
    invalid(
      'budget',
      'budget is required for ' + mode + ': a positive amount in the account currency with at most two decimals.',
    );
  if (
    body.po_number !== undefined &&
    (typeof body.po_number !== 'string' ||
      !body.po_number.trim() ||
      [...body.po_number].length > 100 ||
      /[\x00-\x1f]/.test(body.po_number))
  )
    invalid('po_number', 'po_number must be text of at most 100 characters.');
}

const advertiser = (state: unknown[]) =>
  state
    .flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : []))
    .find((r: JsonObject) => r?.advertiser_id !== undefined) as JsonObject | undefined;
export function tiktokSmartPlusCampaignImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const b = plan.body as JsonObject,
    {cbo, mode} = tiktokSmartPlusCampaignSettings(b),
    a = advertiser(state),
    search = b.is_search_campaign === true;
  return {
    provider: 'tiktok',
    scope: 'smart_plus_campaigns',
    may_affect_serving: false,
    effect:
      'Creates a paused Upgraded Smart+ ' +
      (b.objective_type === 'WEB_CONVERSIONS' ? 'website conversion' : 'lead generation') +
      (search ? ' Search' : '') +
      ' campaign. Nothing delivers until reviewed ad groups and ads exist and a reviewed status change turns it on.',
    campaign: {
      name: b.campaign_name,
      objective_type: b.objective_type,
      is_search_campaign: search,
      campaign_budget_optimization: cbo,
      budget_mode: mode,
      budget: b.budget ?? null,
      currency: a?.currency ?? null,
      special_industries: b.special_industries ?? [],
    },
    ...(search ? {allowlist: tiktokSmartPlusSearchAllowlistNotice} : {}),
    budget_meaning:
      mode === 'BUDGET_MODE_INFINITE'
        ? 'No campaign-level limit; each ad group needs its own budget.'
        : cbo
          ? 'Campaign budget shared by its ad groups.'
          : 'Limit on the total of all ad group budgets in this campaign.',
    source: tiktokSmartPlusCampaignSource,
  };
}
/** TikTok returns the created campaign; the ID is what the receipt must carry. */
export const tiktokSmartPlusCampaignId = (d: JsonObject) =>
  obj(d.data) && typeof d.data.campaign_id === 'string' && /^[1-9][0-9]{0,31}$/.test(d.data.campaign_id)
    ? d.data.campaign_id
    : undefined;
export function tiktokSmartPlusCampaignVerification(plan: CompiledRequest, result: JsonObject) {
  const id = tiktokSmartPlusCampaignId(obj(result.data) ? result.data : {}),
    b = plan.body as JsonObject,
    {cbo, mode} = tiktokSmartPlusCampaignSettings(b);
  if (!id) throw new MirrorError('VERIFICATION_UNSUPPORTED', 'The creation receipt has no campaign ID.');
  const expected: JsonObject = {
    campaign_id: id,
    campaign_name: b.campaign_name,
    objective_type: b.objective_type,
    operation_status: 'DISABLE',
    budget_optimize_on: cbo,
    budget_mode: mode,
    ...(b.sales_destination !== undefined ? {sales_destination: b.sales_destination} : {}),
    // A Search campaign reads back as one (R2.5 M4); a key the body did not send is not asked of the read.
    ...(b.is_search_campaign !== undefined ? {is_search_campaign: b.is_search_campaign} : {}),
    ...(b.budget !== undefined ? {budget: b.budget} : {}),
    ...(b.special_industries !== undefined ? {special_industries: [...b.special_industries].sort()} : {}),
    ...(b.po_number !== undefined ? {po_number: b.po_number} : {}),
  };
  return [
    {
      path: '/v1.3/smart_plus/campaign/get/',
      query: {advertiser_id: plan.accountId, filtering: {campaign_ids: [id]}, page_size: 100},
      expected,
      id,
    },
  ];
}
/** special_industries is a set; the read may return it in any order. */
export function tiktokSmartPlusCampaignProjection(row: unknown): JsonObject | undefined {
  if (!obj(row)) return undefined;
  return Array.isArray(row.special_industries)
    ? {...row, special_industries: [...row.special_industries].map(String).sort()}
    : row;
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokSmartPlusCampaignFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_smart_plus_campaigns',
  files: ['src/tiktok-smart-plus-campaigns.ts', ['tests/tiktok-smart-plus-campaigns.test.mjs']],
  kind: tiktokSmartPlusCampaignKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokSmartPlusCampaign(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) => {
    const id = normalizeAccount(plan.gateway, plan.accountId!);
    return [tiktokAdvertiserRead(stateRead, id)];
  },
  impact: tiktokSmartPlusCampaignImpact,
  outcome: (plan, result) => {
    const d = responseData(result);
    return d.code === 0 && !!tiktokSmartPlusCampaignId(d);
  },
  verification: (plan, result, before, verificationRead) =>
    tiktokSmartPlusCampaignVerification(plan, result).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_smart_plus_campaign_get'},
    })),
});
