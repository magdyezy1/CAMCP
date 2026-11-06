import type {JsonObject} from './types.js';

/** BASIC reporting limits, pinned in the wave-5 provider documentation record (v1.3). */
export const tiktokSpanDays = 30;
export const tiktokCampaignWindowDays = 365;
export const tiktokStatusFilterRefusedWarning =
  'TikTok refused the deleted-objects filter, so campaigns deleted since this window may be missing.';

/**
 * A calendar day (YYYY-MM-DD, optionally followed by TikTok's " 00:00:00") as UTC milliseconds, or NaN when the text
 * is not a real day. The digits are read, never `Date.parse` of the whole text: a date with a time and no zone is
 * parsed as local time, which moves the day by the server's offset.
 */
function calendarDay(value: string): number {
  const digits = /^(\d{4})-(\d{2})-(\d{2})(?: 00:00:00)?$/.exec(value);
  if (!digits) return NaN;
  const [year, month, day] = [Number(digits[1]), Number(digits[2]), Number(digits[3])],
    date = new Date(0);
  // setUTCFullYear keeps years below 100 as written, which Date.UTC would read as 19xx.
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() : NaN;
}
/** Inclusive ISO calendar dates: UTC arithmetic advances dates without changing the advertiser's day boundary. */
export function tiktokDailySpans(from: string, to: string): {from: string; to: string}[] {
  const spans = [];
  const last = calendarDay(to);
  for (let start = calendarDay(from); start <= last; start += tiktokSpanDays * 86400000)
    spans.push({
      from: new Date(start).toISOString().slice(0, 10),
      to: new Date(Math.min(last, start + (tiktokSpanDays - 1) * 86400000)).toISOString().slice(0, 10),
    });
  return spans;
}
export function tiktokStatusFilter(level: 'campaign' | 'adgroup' | 'ad'): JsonObject[] {
  return [{field_name: level + '_status', filter_type: 'IN', filter_value: '["STATUS_ALL"]'}];
}
/**
 * Only an actual provider refusal that names this optional filter permits one read without it. TikTok does not
 * document the `filtering` shape for reports, so its refusal may name the parameter (`filtering`, `filter_type`,
 * `filter_value`), the sub-field (`field_name`, `campaign_status`) or the value (`STATUS_ALL`). A login, permission,
 * throttle or server failure is never about the parameter, and retrying without the filter would hide it.
 */
export function tiktokStatusFilterRefused(error: unknown): boolean {
  const e = error as {code?: string; message?: unknown; retryable?: boolean; details?: JsonObject};
  const status = e?.details?.http_status;
  if (
    !['UPSTREAM_ERROR', 'PLATFORM_ERROR', 'PROVIDER_REPORT_FAILED'].includes(e?.code ?? '') &&
    !Number.isInteger(status)
  )
    return false;
  if (typeof status === 'number' && (status === 401 || status === 403 || status === 429 || status >= 500)) return false;
  // A failure TikTok's return-code table calls transient (a throttle, a fault on its side) is retried as such.
  if (e.retryable === true) return false;
  if (
    ['credential', 'consent', 'role_or_asset_access', 'app_eligibility', 'rate_limit', 'api_version'].includes(
      e?.details?.layer,
    )
  )
    return false;
  const upstream = e?.details?.upstream;
  return [e?.message, upstream?.message, upstream?.error?.message, upstream?.error_message].some(
    message => typeof message === 'string' && /filter|field_name|_status|status_all/i.test(message),
  );
}
