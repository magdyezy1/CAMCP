import {
  groupReportResults,
  resolveReportResult,
  unavailableReportResult,
  type ReportResultContext,
} from './report-results.js';
import type {JsonObject} from './types.js';
import {accessRefusalCodes, type ReportCollection} from './report-source.js';
import {MirrorError} from './errors.js';
import {tiktokCollectionCheck} from './tiktok-report-pagination.js';
import {
  tiktokStatusFilter,
  tiktokStatusFilterRefused,
  tiktokStatusFilterRefusedWarning,
} from './tiktok-report-request.js';

/** BASIC reports expose native result at ad-group/ad level, never at campaign level (TikTok supported metrics). */
export function tiktokNativeResult(raw: JsonObject, context: ReportResultContext) {
  if (context.level === 'campaign') {
    const groups = raw.amcp_result_groups;
    if (!Array.isArray(groups) || !groups.length) return unavailableReportResult('missing_metric');
    if (groups.length !== 1) return unavailableReportResult('mixed_goals');
    const group = groups[0];
    return {
      definition: group.definition,
      result: group.result,
      source: 'mapped' as const,
      cost_source: group.cost_source,
      unavailable_reason: group.unavailable_reason,
      rounding: group.rounding,
    };
  }
  const goal = context.goal ?? raw.optimization_goal,
    event = context.event ?? raw.optimization_event;
  if (typeof goal !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(goal)) return unavailableReportResult('missing_goal');
  const nativeEvent = typeof event === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(event) ? event : null,
    // Reach is never additive. Future/unpinned goals retain their native row value but acquire no invented total.
    additive =
      ['CLICK', 'CLICKS', 'INSTALL', 'APP_INSTALL', 'CONVERT', 'VIDEO_VIEW', 'LEAD_GENERATION'].includes(goal) &&
      (goal !== 'CONVERT' || nativeEvent !== null),
    verified = additive || goal === 'REACH',
    metrics = raw.metrics ?? {};
  const resolved = resolveReportResult(
    {
      id: 'tiktok:' + goal + ':' + (nativeEvent ?? 'unspecified'),
      metric: 'result',
      label: 'TikTok result',
      native_metric: 'metrics.result',
      aggregation: additive ? 'sum' : 'non_additive',
      unit: 'number',
    },
    {value: metrics.result, spend: verified ? metrics.spend : undefined, cost_per_result: metrics.cost_per_result},
    'provider',
  );
  return verified || resolved.result.value === null
    ? resolved
    : {...resolved, unavailable_reason: 'unsupported_goal' as const};
}

/** Native ad-group rows from one campaign/window. Callers must supply the verified native goal for each row. */
export function tiktokCampaignResultGroups(
  rows: {raw: JsonObject; goal: unknown; event?: unknown}[],
  context: ReportResultContext & {currency: string | null; scope: string},
) {
  return groupReportResults(
    rows.map(row => {
      const resolved = tiktokNativeResult(row.raw, {...context, level: 'adset', goal: row.goal, event: row.event});
      return {
        resolved,
        currency: context.currency,
        scope: context.scope,
        // Use the exact normalized native spend; the result resolver has already checked its precision and unit.
        spend:
          row.raw.metrics?.spend === undefined || row.raw.metrics?.spend === null || row.raw.metrics?.spend === '-'
            ? null
            : String(row.raw.metrics.spend),
      };
    }),
  );
}

/** Shown when the ad group report that names a campaign's result could not be read. */
export const tiktokResultsUnavailableWarning =
  'TikTok’s ad group results could not be read, so campaign results are unknown. Spend, impressions and clicks are unchanged.';
/**
 * Whether `error` is the auxiliary ad group report failing on TikTok's side, so the campaign's own figures can stand
 * without a result: not retryable (a retry retries the job), not AMCP's own limit or refusal (REPORT_*: the whole-job
 * allowance, a changed shape), not a changed login, lost connection or credential failure, and not a cancelled job.
 */
function adGroupResultsUnreadable(error: unknown): error is MirrorError {
  return (
    error instanceof MirrorError &&
    !error.retryable &&
    !error.code.startsWith('REPORT_') &&
    !accessRefusalCodes.has(error.code) &&
    error.details.layer !== 'credential' &&
    !['JOB_CANCELLED', 'STALE_JOB_LEASE'].includes(error.code)
  );
}

/**
 * One bounded native ad-group report, not the campaign's unavailable result metric. The read is auxiliary (F-L5-19): the
 * campaign was read by its own report, so a failure of this one leaves the campaign's result unknown, with a warning,
 * and keeps its spend, impressions and clicks; a retryable failure still retries the job.
 */
export async function collectTikTokCampaignResults(c: ReportCollection, metadata: Record<string, JsonObject>) {
  const query: JsonObject = {
    advertiser_id: c.account,
    report_type: 'BASIC',
    data_level: 'AUCTION_ADGROUP',
    dimensions: ['adgroup_id'],
    metrics: ['spend', 'impressions', 'clicks', 'conversion', 'result', 'cost_per_result', 'result_rate'],
    start_date: c.range.since,
    end_date: c.range.until,
    page: 1,
    page_size: 1000,
    enable_total_metrics: true,
    ...(c.lookup?.tiktokStatusFilter === 'refused' ? {} : {filtering: tiktokStatusFilter('adgroup')}),
  };
  let response: JsonObject;
  try {
    try {
      response = await c.run(c.plan('/v1.3/report/integrated/get/', query), true, 'adgroup_results');
    } catch (error) {
      if (!query.filtering || !tiktokStatusFilterRefused(error)) throw error;
      delete query.filtering;
      if (c.lookup) c.lookup.tiktokStatusFilter = 'refused';
      if (!c.warnings.includes(tiktokStatusFilterRefusedWarning)) c.warnings.push(tiktokStatusFilterRefusedWarning);
      response = await c.run(c.plan('/v1.3/report/integrated/get/', query), true, 'adgroup_results');
    }
  } catch (error) {
    if (!adGroupResultsUnreadable(error)) throw error;
    if (!c.warnings.includes(tiktokResultsUnavailableWarning)) c.warnings.push(tiktokResultsUnavailableWarning);
    c.raw = c.raw.map(row => ({...row, amcp_result_groups: []}));
    return;
  }
  if (!Array.isArray(response.data?.list))
    throw new MirrorError(
      'REPORT_SHAPE_CHANGED',
      'TikTok returned a different or malformed native dimensional grain.',
      {},
      502,
    );
  const rows: JsonObject[] = response.data.list;
  if (rows.length > 10000)
    throw new MirrorError('REPORT_ROW_LIMIT', 'Report exceeds 10,000 rows. Narrow the date range or accounts.');
  const checked = tiktokCollectionCheck(rows, response.data.page_info?.total_number ?? 0, response.data.total_metrics, [
    'spend',
    'impressions',
    'clicks',
    'conversion',
  ]);
  c.warnings.push(...checked.warnings);
  if (!checked.complete) {
    c.complete = false;
    c.collectionComplete = false;
  }
  const byCampaign = new Map<string, {raw: JsonObject; goal: unknown; event: unknown}[]>(),
    seen = new Set<string>();
  for (const raw of rows) {
    const id = raw?.dimensions?.adgroup_id,
      group = typeof id === 'string' && Object.hasOwn(metadata, id) ? metadata[id] : undefined;
    if (!group || seen.has(id))
      throw new MirrorError(
        'REPORT_SHAPE_CHANGED',
        'TikTok returned unbound or repeated ad group result rows.',
        {},
        502,
      );
    seen.add(id);
    const campaign = group.campaign_id as string,
      members = byCampaign.get(campaign) ?? [];
    members.push({raw, goal: group.optimization_goal, event: group.optimization_event});
    byCampaign.set(campaign, members);
  }
  c.raw = c.raw.map(row => ({
    ...row,
    amcp_result_groups: tiktokCampaignResultGroups(byCampaign.get(String(row.dimensions?.campaign_id)) ?? [], {
      level: 'campaign',
      range: c.range,
      currency: c.currency,
      scope: JSON.stringify([c.account, row.dimensions?.campaign_id, c.range, c.attribution]),
    }),
  }));
}
