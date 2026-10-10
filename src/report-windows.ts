import {MirrorError} from './errors.js';
import {zonedMidnight} from './workflows.js';
import {accountPlan, accountTimezone} from './workspace.js';
import {reportPlatforms} from './report-metrics.js';
import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';

/**
 * RPT-02 open windows. A reporting period is closed only after its last day has ended in the provider's own day
 * boundary: the account time zone, or the fixed report zone a collector uses. A future `until` is open as well.
 * When the zone is unknown, the westernmost civil offset (UTC−12) is used, so the latest period stays open while it
 * could still be in progress anywhere.
 */
export const unknownWindowTimezone = 'Etc/GMT+12';
/** Report day boundaries fixed by each campaign collector, independent of account metadata. */
export const fixedReportTimezones: Readonly<Record<string, string>> = Object.freeze({
  linkedin: 'UTC',
  microsoft: 'Europe/London',
  apple: 'UTC',
  reddit: 'UTC',
  gsc: 'America/Los_Angeles',
});
export const openWindowWarning =
  'Includes an in-progress day: the last reporting day has not ended in the source time zone. The source stays partial and recommendations wait until it closes.';

const nextDay = (date: string) => new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
function knownZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: zone});
    return true;
  } catch {
    return false;
  }
}
/** When the last day of `range` ends in `timezone`, and whether it is still open at `now`. */
export function reportWindowState(range: {until: string}, timezone: unknown, now = Date.now()) {
  const known = knownZone(timezone);
  let closes: number;
  try {
    closes = zonedMidnight(nextDay(range.until), known ? timezone : unknownWindowTimezone, true);
  } catch {
    // A skipped local midnight (DST at 00:00) falls back to the latest possible civil boundary.
    closes = zonedMidnight(nextDay(range.until), unknownWindowTimezone, true);
  }
  return {
    open: now < closes,
    closes_at: new Date(closes).toISOString(),
    timezone: known ? timezone : null,
    basis: known ? 'source_timezone' : 'unknown_timezone',
  };
}
/** Collected sources whose window had not closed at collection are partial, with the reason in quality. */
export function markReportWindow(result: JsonObject, now = Date.now()): JsonObject {
  if (typeof result?.date_range?.until !== 'string') return result;
  const state = reportWindowState(result.date_range, result.timezone, now);
  if (!state.open) return result;
  return {
    ...result,
    complete: false,
    open_window: true,
    quality: {
      ...(result.quality ?? {}),
      open_window: true,
      window_closes_at: state.closes_at,
      window_timezone_basis: state.basis,
    },
    warnings: [...(result.warnings ?? []), openWindowWarning],
  };
}
/**
 * The reporting time zone of one source without collecting its report: a fixed collector zone, or one account read.
 * Used only for `date_range.source_timezone:"account"`; the collector re-reads and re-checks the account itself.
 */
export async function sourceReportTimezone(
  service: MirrorService,
  source: JsonObject,
  actor: Actor,
): Promise<string | null> {
  const platform = reportPlatforms[source.platform];
  if (!platform) throw new MirrorError('INVALID_REPORT_SOURCE', 'Unsupported reporting platform.');
  if (fixedReportTimezones[source.platform]) return fixedReportTimezones[source.platform]!;
  const account = String(source.account_id),
    connection = String(source.connection_id);
  service.store.resolveConnection(actor, platform.gateway, account, connection);
  const plan: CompiledRequest =
    source.platform === 'ga4'
      ? {
          gateway: platform.gateway,
          accountId: account,
          action: 'AMCP_CAMPAIGN_REPORT',
          method: 'GET',
          path: '/v1beta/properties/' + account,
          query: {},
          origin: 'https://analyticsadmin.googleapis.com',
          headers: {},
          readOnly: true,
          destructive: false,
          requiresConfirmation: false,
          evidence: 'Reporting time zone for a rolling window, bounded property scope',
          warnings: [],
        }
      : accountPlan(platform.gateway, account);
  const out = (await service.runPlan(
    plan,
    {connection_id: connection, aggregate_pages: false, max_pages: 25},
    actor,
  )) as JsonObject;
  if (out.dry_run || out.success !== true || !out.data || typeof out.data !== 'object')
    throw new MirrorError('REPORT_RESPONSE_INVALID', 'The reporting request did not return provider data.', {}, 502);
  const zone = source.platform === 'ga4' ? (out.data.timeZone ?? null) : accountTimezone(platform.gateway, out.data);
  return knownZone(zone) ? zone : null;
}
