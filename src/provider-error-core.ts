/**
 * The values the provider error classification reads (PRV-01), a leaf below src/provider-error-taxonomy.ts, which
 * classifies refusals and declares their types, and the provider adapters (ARC-01 phase B, src/<provider>-adapter.ts),
 * whose wire profiles read each provider's documented error shapes: helpers that keep only closed-set provider values.
 */

export const errorObject = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
/** A closed-set provider token; free text is dropped. */
export const errorToken = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Z0-9_]{2,64}$/.test(v) ? v : undefined;
export const errorInteger = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
/** A provider correlation reference: at most 128 token characters, never free text. */
export const providerReference = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+=\/-]{0,127}$/.test(v) ? v : undefined;
export const errorMinute = 60000;
/** A provider wait, between one second and one day. */
export const boundedWait = (ms: number) => Math.max(1000, Math.min(86400000, Math.ceil(ms)));
/**
 * The longest estimated_time_to_regain_access (minutes) in X-Business-Use-Case-Usage, as milliseconds: Meta's
 * documented throttle header, which Meta's wire profile reads (src/meta-adapter.ts).
 */
export function metaRegainAccessMs(header: string | null): number | undefined {
  if (!header || header.length > 16384) return;
  let usage: unknown;
  try {
    usage = JSON.parse(header);
  } catch {
    return;
  }
  let longest: number | undefined;
  for (const entries of Object.values(errorObject(usage)).slice(0, 50))
    for (const entry of Array.isArray(entries) ? entries.slice(0, 50) : []) {
      const value = errorObject(entry).estimated_time_to_regain_access;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        longest = Math.max(longest ?? 0, value * errorMinute);
    }
  return longest;
}
