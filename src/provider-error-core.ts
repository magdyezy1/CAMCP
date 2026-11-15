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
/**
 * One error of a provider's refusal, reduced to closed-set tokens (G9, Round 2.5 M0): what a person or an agent needs to
 * find the mistake, and nothing a provider's text could use to instruct. A token that fails its pattern is dropped; the
 * provider's sentence never becomes one (it is `details.provider_message`, marked untrusted).
 * - `code`: the provider's error code (a closed-set word, or a non-negative integer such as Meta's 100 or TikTok's 40002);
 * - `enum`: the provider's enum name for the error (Google Ads' error code value);
 * - `operation_index`: the index of the failing operation in the request, an integer;
 * - `field_path`: where in the request, dotted names with list indices.
 */
export interface ProviderErrorToken {
  code?: string | number;
  enum?: string;
  operation_index?: number;
  field_path?: string;
}
/** What a provider hook may offer for a token before it is checked: any value, of which only a valid one is kept. */
export type ProviderErrorCandidate = {readonly [K in keyof ProviderErrorToken]?: unknown};
/** The rows a refusal keeps, and the rows its message echoes. */
export const maxProviderErrors = 20;
export const maxEchoedErrors = 3;
const wordToken = /^[A-Z][A-Z0-9_]{0,79}$/,
  fieldPathToken = /^[A-Za-z0-9_.[\]]{1,200}$/;
const maxIndex = 9999999;
/** A row of closed-set tokens from what a provider hook found, or undefined when no token passes its pattern. */
export function providerErrorToken(raw: unknown): ProviderErrorToken | undefined {
  const row = errorObject(raw),
    token: ProviderErrorToken = {};
  if (typeof row.code === 'string' ? wordToken.test(row.code) : Number.isSafeInteger(row.code) && row.code >= 0)
    token.code = row.code;
  if (typeof row.enum === 'string' && wordToken.test(row.enum)) token.enum = row.enum;
  if (Number.isSafeInteger(row.operation_index) && row.operation_index >= 0 && row.operation_index <= maxIndex)
    token.operation_index = row.operation_index;
  if (typeof row.field_path === 'string' && fieldPathToken.test(row.field_path)) token.field_path = row.field_path;
  return Object.keys(token).length ? token : undefined;
}
/** The valid rows of a list a provider hook built, in order, at most `maxProviderErrors`. */
export const providerErrorTokens = (rows: unknown): ProviderErrorToken[] =>
  (Array.isArray(rows) ? rows : [])
    .map(providerErrorToken)
    .filter((row): row is ProviderErrorToken => row !== undefined)
    .slice(0, maxProviderErrors);
/**
 * The provider's own sentence for a refusal, as `details.provider_message` keeps it: control characters (and the Unicode
 * line and paragraph separators) become spaces, runs of white space one space, at most 200 characters. It is third-party
 * text: the envelope marks it untrusted and it is never part of a message.
 */
export function providerMessageText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 200)
    .trim();
  return text || undefined;
}
/**
 * What a message says of a refusal's rows, from tokens only: the code and enum, then where (`at <field path>`, or the
 * operation when no path is known), the first `maxEchoedErrors` rows joined by "; ".
 */
export function describeProviderErrors(rows: readonly ProviderErrorToken[]): string {
  return rows
    .slice(0, maxEchoedErrors)
    .map(row => {
      const what = [typeof row.code === 'number' ? 'code ' + row.code : row.code, row.enum].filter(Boolean).join(' '),
        where =
          row.field_path !== undefined
            ? 'at ' + row.field_path
            : row.operation_index !== undefined
              ? 'at operation ' + row.operation_index
              : '';
      return [what, where].filter(Boolean).join(' ');
    })
    .join('; ');
}
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
