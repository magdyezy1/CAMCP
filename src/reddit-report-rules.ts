import {deprecationEffective, providerDeprecation, refuseDeprecated} from './provider-deprecations.js';
import type {JsonObject} from './types.js';

/**
 * Reddit reporting rules from December 8, 2026 (pinned Reddit OpenAPI, GET_INSIGHTS data.breakdowns; PRV-04). Reddit
 * then answers 400 Bad Request to a report that:
 * - breaks down by HOUR over a range longer than 7 days (any continuous 7-day period is allowed);
 * - combines more than one of KEYWORD, COMMUNITY (legacy SUBREDDIT), INTEREST and LANGUAGE;
 * - combines any of those four with DMA (METRO), REGION, GALLERY_ITEM_ID (CAROUSEL_CARD), OS_TYPE or COUNTRY.
 * The compile path refuses such a report from that day; before it, the reporting bootstrap warns about saved reports
 * and their schedules that will start failing.
 */
export const redditBreakdownRule = 'reddit_report_breakdowns_2026_12';
const audience = new Map([
  ['KEYWORD', 'KEYWORD'],
  ['COMMUNITY', 'COMMUNITY'],
  ['SUBREDDIT', 'COMMUNITY'],
  ['INTEREST', 'INTEREST'],
  ['LANGUAGE', 'LANGUAGE'],
]);
const placement = new Set(['DMA', 'METRO', 'REGION', 'GALLERY_ITEM_ID', 'CAROUSEL_CARD', 'OS_TYPE', 'COUNTRY']);
const day = 86400000;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The rules a Reddit report body breaks, as fixed codes. `rangeDays` replaces the explicit starts_at/ends_at range
 * when a saved report resolves its dates later (for example a last-N-days preset).
 */
export function redditBreakdownProblems(data: unknown, rangeDays?: number): string[] {
  if (!obj(data) || !Array.isArray(data.breakdowns)) return [];
  const breakdowns = data.breakdowns.filter((b): b is string => typeof b === 'string');
  const groups = new Set(breakdowns.filter(b => audience.has(b)).map(b => audience.get(b)!)),
    problems: string[] = [];
  let days = rangeDays;
  if (days === undefined && typeof data.starts_at === 'string' && typeof data.ends_at === 'string') {
    const span = Date.parse(data.ends_at) - Date.parse(data.starts_at);
    if (Number.isFinite(span)) days = span / day;
  }
  if (breakdowns.includes('HOUR') && days !== undefined && days > 7) problems.push('HOUR_RANGE_OVER_7_DAYS');
  if (groups.size > 1) problems.push('MULTIPLE_AUDIENCE_BREAKDOWNS');
  if (groups.size && breakdowns.some(b => placement.has(b))) problems.push('AUDIENCE_WITH_LOCATION_OR_PLACEMENT');
  return problems;
}
const explanation: Record<string, string> = {
  HOUR_RANGE_OVER_7_DAYS: 'an HOUR breakdown covers at most 7 days',
  MULTIPLE_AUDIENCE_BREAKDOWNS: 'a report uses at most one of KEYWORD, COMMUNITY, INTEREST and LANGUAGE',
  AUDIENCE_WITH_LOCATION_OR_PLACEMENT:
    'KEYWORD, COMMUNITY, INTEREST and LANGUAGE cannot be combined with DMA, METRO, REGION, GALLERY_ITEM_ID, CAROUSEL_CARD, OS_TYPE or COUNTRY',
};
/** Refuses, from the effective date, a compiled GET_INSIGHTS body that Reddit will answer with 400. */
export function assertRedditReportRules(data: unknown, now?: number): void {
  if (!deprecationEffective(redditBreakdownRule, now)) return;
  const problems = redditBreakdownProblems(data);
  if (problems.length)
    refuseDeprecated(
      redditBreakdownRule,
      'Reddit no longer accepts this report: ' + problems.map(p => explanation[p]).join('; '),
      {problems},
    );
}
/** The report body inside a saved reporting query configuration, wrapped (operation + arguments) or not. */
function savedReport(config: unknown): {data?: JsonObject; rangeDays?: number} | undefined {
  if (!obj(config) || config.gateway !== 'reddit_native_action' || !obj(config.arguments)) return;
  const outer = config.arguments,
    args = obj(outer.arguments) && typeof outer.operation === 'string' ? outer.arguments : outer;
  if (args.action !== 'GET_INSIGHTS') return;
  const payload = obj(args.payload) ? args.payload : obj(args.request) ? args.request : undefined;
  // A rolling window (src/reporting.ts resolveReportConfig) replaces the saved dates at each run.
  const range = obj(config.date_range) ? config.date_range : undefined,
    rangeDays =
      range?.preset === 'last_complete_days' && Number.isInteger(range.days)
        ? Number(range.days)
        : range?.preset === 'last_complete_week'
          ? 7
          : range?.preset === 'last_complete_month'
            ? 31
            : undefined;
  return {data: obj(payload?.data) ? payload.data : undefined, rangeDays};
}
/** The Reddit rules a saved reporting query will break, or none. */
export function savedRedditReportProblems(config: unknown): string[] {
  const report = savedReport(config);
  return report?.data ? redditBreakdownProblems(report.data, report.rangeDays) : [];
}
/** The warning the reporting bootstrap shows for a saved query (and its schedules) that the rules affect. */
export function redditReportWarning(queryId: string, problems: string[], scheduleIds: string[]): JsonObject {
  const entry = providerDeprecation(redditBreakdownRule);
  return {
    code: 'PROVIDER_DEPRECATION_AHEAD',
    provider: 'reddit',
    deprecation: entry.id,
    effective_date: entry.effective_date,
    query_id: queryId,
    schedule_ids: scheduleIds,
    problems,
    message:
      'From ' +
      entry.effective_date +
      ' Reddit answers this saved report with 400 Bad Request: ' +
      problems.map(p => explanation[p]).join('; ') +
      '. Change its breakdowns or date range before then.',
    source: entry.source_url,
  };
}
