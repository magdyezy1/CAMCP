import {MirrorError} from './errors.js';
import type {ObjectiveTable} from './report-objectives.js';
import {detailContractVersion, detailedOverviewRows, overviewSourceLevel} from './overview-levels.js';
import {fingerprint, reportContractVersion} from './report-quality.js';
import {metricRoundingRecord, parseProviderDecimal} from './provider-decimal.js';
import type {JsonObject} from './types.js';
import type {ReportSource} from './report-source.js';

/**
 * RPT-07 granular parity: ad-group and ad levels for Microsoft, Reddit and Apple through their existing report compile
 * paths (Microsoft Submit/Poll performance reports, the Reddit report endpoint, Apple v1 app reports), with the same row
 * bounds and the guided detailed-level semantics: exact additive window totals per native entity, reach and frequency
 * unknown, parents from the provider (never guessed), a declared reporting window and the detail contract version.
 *  - Microsoft: AdGroupPerformanceReportRequest / AdPerformanceReportRequest, whose rows name their campaign and ad group.
 *  - Reddit: breakdowns CAMPAIGN_ID, AD_GROUP_ID (and AD_ID), with current names from the account's ad group and ad lists.
 *  - Apple: reports/apps/adgroups and reports/apps/ads, with parents from the account's ad group, ad and campaign queries.
 */
export const nativeDetailPlatforms: readonly string[] = ['linkedin', 'microsoft', 'reddit', 'apple'];
/** Distinct entities per source whose names or parents are read; entities beyond it keep IDs and unknown parents. */
export const nativeDetailLookupLimit = 1000;
export const nativeDetailLookupLimitedWarning =
  'This source reports more than 1000 entities, so names and parents beyond that bound stay unknown.';
const shape = (message: string): never => {
  throw new MirrorError('REPORT_SHAPE_CHANGED', message, {}, 502);
};
const foreign = (message: string): never => {
  throw new MirrorError('REPORT_ACCOUNT_MISMATCH', message, {}, 502);
};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const name = (v: unknown) => (typeof v === 'string' && v.length <= 1000 ? v : null);
export const nativeDetailId = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
/** A safe positive integer or exact decimal ID string, as the exact decimal string. */
const idText = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : nativeDetailId(v) ? v : undefined;

/**
 * A provider metric as exact decimal text at nine places, rounded half to even when the provider sent more (owner
 * decision D10, counted in `rounding` by metric), after a power-of-ten native `divisor`. Blank, `--` and absent values
 * stay unknown (null); anything else that is not a nonnegative decimal is a changed report shape.
 */
export function nativeDecimal(
  value: unknown,
  field: string,
  rounding: Record<string, number>,
  divisor: unknown = 1,
): string | null {
  if (value === undefined || value === null || value === '' || value === '--') return null;
  const parsed = parseProviderDecimal(typeof value === 'string' ? value.trim() : value, {field, divisor});
  if (parsed.rounded) rounding[field] = (rounding[field] ?? 0) + 1;
  const whole = parsed.scaled / 1000000000n,
    fraction = (parsed.scaled % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return whole.toString() + (fraction ? '.' + fraction : '');
}
const mapped = (id: string, entityName: string | null, metrics: Record<string, string | null>) => ({
  entity_id: id,
  entity_name: entityName,
  spend: metrics.spend ?? null,
  impressions: metrics.impressions ?? null,
  clicks: metrics.clicks ?? null,
  conversions: metrics.conversions ?? null,
  conversion_value: metrics.conversion_value ?? null,
  reach: null,
  frequency: null,
});

/** Microsoft ad group / ad performance rows: the rows carry their own campaign and ad group. */
export function microsoftDetail(
  level: string,
  account: string,
  currency: string | null,
  rows: JsonObject[],
  rounding: Record<string, number>,
) {
  const out: JsonObject[] = [],
    parents: Record<string, JsonObject> = {},
    seen = new Set<string>();
  for (const row of rows) {
    if (!object(row)) shape('Microsoft returned a malformed report row.');
    if (row.AccountId !== undefined && row.AccountId !== account)
      foreign('Microsoft returned a report row of another account.');
    if (currency && row.CurrencyCode !== undefined && row.CurrencyCode !== currency)
      throw new MirrorError('REPORT_CURRENCY_MISMATCH', 'Microsoft returned a different account currency.', {}, 502);
    const id = level === 'ad' ? row.AdId : row.AdGroupId;
    if (!nativeDetailId(id) || !nativeDetailId(row.CampaignId) || (level === 'ad' && !nativeDetailId(row.AdGroupId)))
      shape('Microsoft did not return the exact native entity and parent IDs.');
    if (seen.has(id)) shape('Microsoft returned duplicate entity rows for one report window.');
    seen.add(id);
    parents[id] = {
      campaign_id: row.CampaignId,
      campaign_name: name(row.CampaignName),
      ...(level === 'ad' ? {adset_id: row.AdGroupId, adset_name: name(row.AdGroupName)} : {}),
    };
    out.push({
      ...mapped(id, name(level === 'ad' ? row.AdTitle || null : row.AdGroupName), {
        spend: nativeDecimal(row.Spend, 'spend', rounding),
        impressions: nativeDecimal(row.Impressions, 'impressions', rounding),
        clicks: nativeDecimal(row.Clicks, 'clicks', rounding),
        conversions: nativeDecimal(row.Conversions, 'conversions', rounding),
        conversion_value: nativeDecimal(row.Revenue, 'conversion_value', rounding),
      }),
    });
  }
  return {rows: out, parents};
}

/**
 * Reddit report rows broken down by CAMPAIGN_ID and AD_GROUP_ID (and AD_ID): the parents come from the report row; the
 * current ad group and ad lists add names and must agree with those parents.
 */
export function redditDetail(
  level: string,
  rows: JsonObject[],
  lists: {campaigns: JsonObject[]; adGroups: JsonObject[]; ads: JsonObject[]},
  account: string,
  rounding: Record<string, number>,
  overviewV4 = false,
) {
  const owned = (row: JsonObject) => row.ad_account_id === undefined || String(row.ad_account_id) === account;
  for (const row of [...lists.adGroups, ...lists.ads])
    if (!object(row) || !owned(row)) foreign('Reddit returned an ad group or ad of another account.');
  const campaigns = new Map(lists.campaigns.map(c => [String(c.id), c])),
    groups = new Map(lists.adGroups.map(g => [String(g.id), g])),
    ads = new Map(lists.ads.map(a => [String(a.id), a])),
    out: JsonObject[] = [],
    parents: Record<string, JsonObject> = {},
    seen = new Set<string>();
  for (const row of rows) {
    if (!object(row)) shape('Reddit returned a malformed report row.');
    const id = level === 'ad' ? row.ad_id : row.ad_group_id;
    if (!nativeDetailId(id) || !nativeDetailId(row.campaign_id) || (level === 'ad' && !nativeDetailId(row.ad_group_id)))
      shape('Reddit did not return the exact native entity and parent IDs.');
    if (seen.has(id)) shape('Reddit returned duplicate entity rows for one report window.');
    seen.add(id);
    const group = groups.get(String(row.ad_group_id)),
      ad = level === 'ad' ? ads.get(String(id)) : undefined;
    // A listed entity that names other parents than its report row is a changed hierarchy, never a choice.
    if (
      (group?.campaign_id !== undefined && String(group.campaign_id) !== row.campaign_id) ||
      (ad &&
        ((ad.ad_group_id !== undefined && String(ad.ad_group_id) !== row.ad_group_id) ||
          (ad.campaign_id !== undefined && String(ad.campaign_id) !== row.campaign_id)))
    )
      foreign('The detailed entity changed native parents during collection.');
    parents[id] = {
      ...(overviewV4 ? {entity_metadata: level === 'ad' ? ad : group} : {}),
      campaign_id: row.campaign_id,
      campaign_name: name(campaigns.get(row.campaign_id)?.name),
      ...(typeof campaigns.get(row.campaign_id)?.objective === 'string'
        ? {objective: campaigns.get(row.campaign_id)!.objective}
        : {}),
      ...(level === 'ad' ? {adset_id: row.ad_group_id, adset_name: name(group?.name)} : {}),
    };
    out.push(
      mapped(id, name((level === 'ad' ? ad : group)?.name), {
        // Reddit reports spend in microcurrency.
        spend: nativeDecimal(row.spend ?? row.SPEND, 'spend', rounding, 1000000),
        impressions: nativeDecimal(row.impressions ?? row.IMPRESSIONS, 'impressions', rounding),
        clicks: nativeDecimal(row.clicks ?? row.CLICKS, 'clicks', rounding),
      }),
    );
  }
  return {rows: out, parents};
}

/** Apple ad group / ad report rows (metadata and totalMetrics) with parents from the account's own queries. */
export function appleDetail(
  level: string,
  rows: JsonObject[],
  lists: {campaigns: JsonObject[]; adGroups: JsonObject[]; ads: JsonObject[]},
  currency: string | null,
  rounding: Record<string, number>,
  v4?: {account: string},
) {
  if (v4)
    for (const row of [...lists.campaigns, ...lists.adGroups, ...lists.ads]) {
      if (row.adAccountId === undefined) shape('Native entity metadata is malformed.');
      if (String(row.adAccountId) !== v4.account) foreign('The native entity belongs to another advertising account.');
    }
  const campaigns = new Map(lists.campaigns.map(c => [idText(c.id), c])),
    groups = new Map(lists.adGroups.map(g => [idText(g.id), g])),
    ads = new Map(lists.ads.map(a => [idText(a.id), a])),
    out: JsonObject[] = [],
    parents: Record<string, JsonObject> = {},
    seen = new Set<string>();
  for (const row of rows) {
    const metadata = row?.metadata,
      totals = row?.totalMetrics,
      id = idText(metadata?.id);
    if (!object(metadata) || !object(totals) || !id) shape('Apple did not return the exact native entity row.');
    if (seen.has(id!)) shape('Apple returned duplicate entity rows for one report window.');
    seen.add(id!);
    const spend = totals.localSpend;
    if (spend !== undefined && spend !== null && (!object(spend) || (currency && spend.currency !== currency)))
      throw new MirrorError('REPORT_CURRENCY_MISMATCH', 'Apple returned a different account currency.', {}, 502);
    const ad = level === 'ad' ? ads.get(id) : undefined,
      group = groups.get(level === 'ad' ? idText(ad?.adGroupId) : id),
      campaignId = idText((ad ?? group)?.campaignId);
    // Parents come only from the account's own records, and must agree with each other.
    if (ad && group && idText(group.campaignId) !== idText(ad.campaignId))
      foreign('The detailed entity changed native parents during collection.');
    parents[id!] =
      campaignId === undefined
        ? {}
        : {
            ...(v4 ? {entity_metadata: level === 'ad' ? ad : group} : {}),
            campaign_id: campaignId,
            campaign_name: name(campaigns.get(campaignId)?.name),
            ...(level === 'ad' && group ? {adset_id: idText(group.id), adset_name: name(group.name)} : {}),
          };
    out.push(
      mapped(id!, name(metadata.name), {
        spend: nativeDecimal((spend as JsonObject | undefined)?.amount, 'spend', rounding),
        impressions: nativeDecimal(totals.impressions, 'impressions', rounding),
        clicks: nativeDecimal(totals.taps, 'clicks', rounding),
        conversions: nativeDecimal(totals.totalInstalls, 'conversions', rounding),
      }),
    );
  }
  return {rows: out, parents};
}

/** The detailed source result: the guided detailed levels' declared-window and quality semantics. */
export function nativeDetailResult(
  source: JsonObject,
  detail: {rows: JsonObject[]; parents: Record<string, JsonObject>},
  native: JsonObject[],
  base: {
    lineage: JsonObject[];
    metadata: JsonObject;
    currency: string | null;
    timezone: string | null;
    range: JsonObject;
    providerComplete: boolean;
    resultDefinition: string;
    warnings: string[];
    context: JsonObject;
    rounding: Record<string, number>;
    objectives?: ObjectiveTable;
    resultReader?: ReportSource['readResult'];
    statusReader?: ReportSource['readStatus'];
    activityReader?: (raw: JsonObject) => boolean | null;
  },
) {
  const descriptor = overviewSourceLevel(source),
    options = source.report_options,
    rounded = metricRoundingRecord(base.rounding);
  if (detail.rows.length > 10000)
    throw new MirrorError('REPORT_ROW_LIMIT', 'Report exceeds 10,000 rows. Narrow the date range or accounts.');
  const complete = options.complete_window === true && base.providerComplete;
  return {
    contract_version: reportContractVersion,
    quality: {
      version: 1,
      pages_collected: base.providerComplete,
      measurement_complete: options.complete_window === false || !base.providerComplete ? false : null,
      reporting_window_declared_complete: options.complete_window,
      status: 'declared_measurement',
      entity_level: descriptor.id,
      ...(rounded ? {metric_rounding: rounded} : {}),
    },
    lineage: base.lineage,
    query_fingerprint: fingerprint(base.lineage.map(l => l.query_fingerprint)),
    rows: detailedOverviewRows(
      source,
      {
        rows: detail.rows,
        native_rows: native,
        semantics: {
          currency: base.currency,
          date_from: base.range.since,
          date_to: base.range.until,
          attribution: options.attribution,
        },
      },
      detail.parents,
      base.objectives,
      base.resultReader,
      base.statusReader,
      base.activityReader,
    ),
    metadata: base.metadata,
    account_name: base.metadata.name ?? base.metadata.displayName ?? null,
    currency: base.currency,
    timezone: base.timezone,
    date_range: base.range,
    detail_contract: source.reporting_contract === 'overview-config-v4' ? 'overview-detail-v4' : detailContractVersion,
    collection_complete: base.providerComplete,
    complete,
    ...base.context,
    attribution: options.attribution,
    result_definition: base.resultDefinition,
    warnings: [
      'Detailed rows retain the native entity level and exact additive window totals. Reach and frequency are never summed; missing values stay unknown. Reporting-window completeness and attribution remain explicitly declared.',
      ...(options.complete_window === true
        ? []
        : [
            'The reporting window was declared incomplete. The source stays partial and recommendations are held until a complete window is collected.',
          ]),
      ...base.warnings,
    ],
    source_kind: 'paid',
    captured_at: Date.now(),
  };
}
