import type {JsonObject} from './types.js';

/** BASIC reporting limits, pinned in the wave-5 provider documentation record (v1.3). */
export const tiktokSpanDays = 30;
export const tiktokCampaignWindowDays = 365;
export const tiktokStatusFilterRefusedWarning =
  'TikTok refused the deleted-objects filter, so campaigns deleted since this window may be missing.';

/** Inclusive ISO calendar dates: UTC arithmetic advances dates without changing the advertiser's day boundary. */
export function tiktokDailySpans(from: string, to: string): {from: string; to: string}[] {
  const spans = [];
  const last = Date.parse(to);
  for (let start = Date.parse(from); start <= last; start += tiktokSpanDays * 86400000)
    spans.push({
      from: new Date(start).toISOString().slice(0, 10),
      to: new Date(Math.min(last, start + (tiktokSpanDays - 1) * 86400000)).toISOString().slice(0, 10),
    });
  return spans;
}
export function tiktokStatusFilter(level: 'campaign' | 'adgroup' | 'ad'): JsonObject[] {
  return [{field_name: level + '_status', filter_type: 'IN', filter_value: '["STATUS_ALL"]'}];
}
/** Only an actual refusal naming this optional filter permits one read without it. */
export function tiktokStatusFilterRefused(error: unknown): boolean {
  const e = error as {code?: string; message?: unknown; details?: JsonObject};
  if (
    !['UPSTREAM_ERROR', 'PLATFORM_ERROR', 'PROVIDER_REPORT_FAILED'].includes(e?.code ?? '') &&
    !Number.isInteger(e?.details?.http_status)
  )
    return false;
  const upstream = e?.details?.upstream;
  return [e?.message, upstream?.message, upstream?.error?.message, upstream?.error_message].some(
    message => typeof message === 'string' && /filtering|field_name|_status/i.test(message),
  );
}
