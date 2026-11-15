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
/**
 * A row of closed-set tokens from what a provider hook found, or undefined when no token passes its pattern. `clean` is a
 * further test a string token must pass (the review's S2-2: it is the credential check of src/provider-error-taxonomy.ts):
 * one that fails is dropped like a token that fails its pattern, and its row keeps the rest.
 */
export function providerErrorToken(
  raw: unknown,
  clean: (token: string) => boolean = () => true,
): ProviderErrorToken | undefined {
  const row = errorObject(raw),
    token: ProviderErrorToken = {};
  if (
    typeof row.code === 'string'
      ? wordToken.test(row.code) && clean(row.code)
      : Number.isSafeInteger(row.code) && row.code >= 0
  )
    token.code = row.code;
  if (typeof row.enum === 'string' && wordToken.test(row.enum) && clean(row.enum)) token.enum = row.enum;
  if (Number.isSafeInteger(row.operation_index) && row.operation_index >= 0 && row.operation_index <= maxIndex)
    token.operation_index = row.operation_index;
  if (typeof row.field_path === 'string' && fieldPathToken.test(row.field_path) && clean(row.field_path))
    token.field_path = row.field_path;
  return Object.keys(token).length ? token : undefined;
}
/** The valid rows of a list a provider hook built, in order, at most `maxProviderErrors`. */
export const providerErrorTokens = (rows: unknown, clean?: (token: string) => boolean): ProviderErrorToken[] =>
  (Array.isArray(rows) ? rows : [])
    .map(row => providerErrorToken(row, clean))
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
/** The longest echo of a refusal's rows in a message: what the `{refusal}` slot holds, cut at a row boundary. */
export const maxEchoLength = 160;
const maxPathSegments = 8;
const pathSegment = /^([A-Za-z][A-Za-z0-9_]{0,63})(?:\[(\d{1,7})\])?$/;
/** A request's name for a field, with the case and the underscores that differ between a provider's proto name and its JSON. */
const looseName = (name: string) => name.replace(/_/g, '').toLowerCase();
/**
 * A request value as the provider reads it: a string that holds a JSON object or list (Meta takes its object parameters as
 * JSON text) is that object or list.
 */
function opened(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 1000000) return value;
  const head = value.trimStart()[0];
  if (head !== '{' && head !== '[') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
/**
 * Whether the field path of a refusal is a place in the request AMCP sent (the review's S2-1): a path is the provider's
 * choice of words, so it is quoted in a message only when the request holds it. At most eight segments, each a name of at
 * most 64 characters with at most one list index; each is looked up among the request's own names without case or
 * underscores (a provider's proto name against the JSON AMCP sent), through a parameter that holds JSON text. Only the last
 * segment may be missing from the request, the field a refusal says it lacks, and only under a parent the request holds: a
 * lone name the request never held is nothing to quote.
 */
export function fieldPathInRequest(path: string, request: unknown): boolean {
  const segments = path.split('.');
  if (segments.length > maxPathSegments) return false;
  let node: unknown = request;
  for (const [position, segment] of segments.entries()) {
    const parts = pathSegment.exec(segment),
      parent = opened(node),
      lastBelowRoot = position === segments.length - 1 && position > 0;
    if (!parts || !parent || typeof parent !== 'object' || Array.isArray(parent)) return false;
    const [, name = '', listIndex] = parts,
      key = Object.keys(parent).find(k => looseName(k) === looseName(name));
    if (key === undefined) return lastBelowRoot;
    node = (parent as Record<string, unknown>)[key];
    if (listIndex !== undefined) {
      const list = opened(node),
        index = Number(listIndex);
      if (!Array.isArray(list)) return false;
      if (index >= list.length) return lastBelowRoot;
      node = list[index];
    }
  }
  return true;
}
/** What a refusal's provider and request can vouch for when a message quotes its rows. */
export interface ProviderEcho {
  /** Whether the provider's own schema holds this row's code and enum: words are the provider's choice, not AMCP's. */
  readonly known?: (row: ProviderErrorToken) => boolean;
  /** The request AMCP sent, in which the field paths of the rows are looked up. */
  readonly request?: unknown;
}
/** One row as a message quotes it: its number, the words the provider vouches for, then the place or the operation. */
function describeRow(row: ProviderErrorToken, echo: ProviderEcho): string {
  const words = (typeof row.code === 'string' || row.enum !== undefined) && echo.known?.(row) === true,
    what = [
      typeof row.code === 'number' ? 'code ' + row.code : undefined,
      words ? [row.code, row.enum].filter(Boolean).join(' ') : undefined,
    ]
      .filter(Boolean)
      .join(' '),
    operation = row.operation_index !== undefined ? 'at operation ' + row.operation_index : '',
    place =
      row.field_path !== undefined && echo.request !== undefined && fieldPathInRequest(row.field_path, echo.request)
        ? 'at ' + row.field_path
        : operation;
  // A row too long with its place is quoted with its operation, and then with its words alone; never cut in the middle.
  for (const parts of [[what, place], [what, operation], [what]]) {
    const text = parts.filter(Boolean).join(' ');
    if (text && text.length <= maxEchoLength) return text;
  }
  return '';
}
/**
 * What a message says of a refusal's rows: only what AMCP can check against its own data (the review's S2-1). A number is
 * quoted (Meta's and TikTok's codes); words are quoted when the provider's schema holds them (`echo.known`); a place when
 * the request holds it (`fieldPathInRequest`), else the operation's index; whatever else the rows hold stays in the
 * details, which the envelope marks untrusted. At most `maxEchoedErrors` rows, each once, and `maxEchoLength` characters,
 * ending at a row boundary. Empty when nothing can be quoted: the message then keeps its old words.
 */
export function describeProviderErrors(rows: readonly ProviderErrorToken[], echo: ProviderEcho = {}): string {
  const described: string[] = [];
  let length = 0;
  for (const row of rows) {
    const text = describeRow(row, echo);
    if (!text || described.includes(text)) continue;
    const joined = length + (described.length ? 2 : 0) + text.length;
    if (described.length >= maxEchoedErrors || joined > maxEchoLength) break;
    described.push(text);
    length = joined;
  }
  return described.join('; ');
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
