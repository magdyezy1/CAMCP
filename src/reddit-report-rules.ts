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

/** The rules a Reddit report body breaks, as fixed codes. */
export function redditBreakdownProblems(data: unknown): string[] {
  if (!obj(data) || !Array.isArray(data.breakdowns)) return [];
  const breakdowns = data.breakdowns.filter((b): b is string => typeof b === 'string');
  const groups = new Set(breakdowns.filter(b => audience.has(b)).map(b => audience.get(b)!)),
    problems: string[] = [];
  let days: number | undefined;
  if (typeof data.starts_at === 'string' && typeof data.ends_at === 'string') {
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
/**
 * The report body inside a saved reporting query configuration, wrapped (operation + arguments) or not. A saved native
 * report runs with its explicit starts_at/ends_at (src/report-executor.ts), so those dates are the ones checked.
 */
function savedReport(config: unknown): JsonObject | undefined {
  if (!obj(config) || config.gateway !== 'reddit_native_action' || !obj(config.arguments)) return;
  const outer = config.arguments,
    args = obj(outer.arguments) && typeof outer.operation === 'string' ? outer.arguments : outer;
  if (args.action !== 'GET_INSIGHTS') return;
  // The body can be saved as an object or as JSON text, under payload or body, directly or inside params.
  const parsed = (v: unknown): JsonObject | undefined => {
    if (obj(v)) return v;
    if (typeof v !== 'string' || v.length > 65536) return;
    try {
      const value = JSON.parse(v);
      return obj(value) ? value : undefined;
    } catch {
      return;
    }
  };
  const params = obj(args.params) ? args.params : {},
    payload = [args.payload, args.body, params.payload, params.body].map(parsed).find(Boolean);
  return obj(payload?.data) ? payload.data : undefined;
}
/** The Reddit rules a saved reporting query will break, or none. */
export function savedRedditReportProblems(config: unknown): string[] {
  const data = savedReport(config);
  return data ? redditBreakdownProblems(data) : [];
}
/**
 * The warning the reporting bootstrap shows for a saved query (and its schedules) that the rules affect: ahead of the
 * effective date, or, from it, that its runs are now refused.
 */
export function redditReportWarning(
  queryId: string,
  problems: string[],
  scheduleIds: string[],
  now?: number,
): JsonObject {
  const entry = providerDeprecation(redditBreakdownRule),
    effective = deprecationEffective(redditBreakdownRule, now),
    rules = problems.map(p => explanation[p]).join('; ');
  return {
    code: effective ? 'PROVIDER_DEPRECATED' : 'PROVIDER_DEPRECATION_AHEAD',
    provider: 'reddit',
    deprecation: entry.id,
    effective_date: entry.effective_date,
    query_id: queryId,
    schedule_ids: scheduleIds,
    problems,
    message: effective
      ? 'Since ' +
        entry.effective_date +
        ' AMCP refuses this saved report before any request, because Reddit answers it with 400 Bad Request: ' +
        rules +
        '. Change its breakdowns or date range.'
      : 'From ' +
        entry.effective_date +
        ' Reddit answers this saved report with 400 Bad Request: ' +
        rules +
        '. Change its breakdowns or date range before then.',
    source: entry.source_url,
  };
}
