import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Paused Upgraded Smart+ website-conversion and lead-generation campaigns, per API for Business v1.3 "Create an
 * Upgraded Smart+ Campaign" and "Get Upgraded Smart+ Campaigns" (checked 2026-09-26). App, catalog, search,
 * promotional, iOS dedicated and RTA campaigns, and allowlist-only Goal-based budget increase, are outside this
 * contract. Campaigns are created with operation_status DISABLE, since TikTok's default is ENABLE.
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
];
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
        '" is outside the qualified Smart+ campaign contract (app, catalog, search, promotional, iOS dedicated, RTA and Goal-based budget increase campaigns are not qualified).',
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
    a = advertiser(state);
  return {
    provider: 'tiktok',
    scope: 'smart_plus_campaigns',
    may_affect_serving: false,
    effect:
      'Creates a paused Upgraded Smart+ ' +
      (b.objective_type === 'WEB_CONVERSIONS' ? 'website conversion' : 'lead generation') +
      ' campaign. Nothing delivers until reviewed ad groups and ads exist and a reviewed status change turns it on.',
    campaign: {
      name: b.campaign_name,
      objective_type: b.objective_type,
      campaign_budget_optimization: cbo,
      budget_mode: mode,
      budget: b.budget ?? null,
      currency: a?.currency ?? null,
      special_industries: b.special_industries ?? [],
    },
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
