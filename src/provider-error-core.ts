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
 * The policy a refusal names (r25-field3-errors, AMCP-03): a provider that refuses a request for a rule of its own (an ad
 * policy, say) names the rule, the kind of rule and whether the advertiser may ask for an exemption. Closed-set words and a
 * boolean only.
 */
export interface ProviderErrorPolicy {
  name?: string;
  topic_type?: string;
  exemptible?: boolean;
}
/**
 * One error of a provider's refusal, reduced to closed-set tokens (G9, Round 2.5 M0): what a person or an agent needs to
 * find the mistake, and nothing a provider's text could use to instruct. A token that fails its pattern is dropped; the
 * provider's sentence never becomes one (it is `details.provider_message`, marked untrusted).
 * - `code`: the provider's error code (a closed-set word, or a non-negative integer such as Meta's 100 or TikTok's 40002);
 * - `enum`: the provider's enum name for the error (Google Ads' error code value);
 * - `subcode`: the provider's own refinement of the code, a non-negative integer (Meta's error_subcode);
 * - `operation_index`: the index of the failing operation in the request, an integer;
 * - `field_path`: where in the request, dotted names with list indices;
 * - `policy`: the rule a refusal names (see `ProviderErrorPolicy`);
 * - `trigger`: the text the provider says caused the error, kept only when it is the caller's own words: a string the
 *   request itself holds, at most `maxTriggerLength` characters, unchanged by the credential check and not a URL with a
 *   query or a fragment. A provider that names any other trigger leaves `trigger_withheld: true` and no text.
 */
export interface ProviderErrorToken {
  code?: string | number;
  enum?: string;
  subcode?: number;
  operation_index?: number;
  field_path?: string;
  policy?: ProviderErrorPolicy;
  trigger?: string;
  trigger_withheld?: true;
}
/** What a provider hook may offer for a token before it is checked: any value, of which only a valid one is kept. */
export type ProviderErrorCandidate = {readonly [K in keyof ProviderErrorToken]?: unknown};
/** The rows a refusal keeps, and the rows its message echoes. */
export const maxProviderErrors = 20;
export const maxEchoedErrors = 3;
/** The whole list of rows a refusal keeps is at most this many bytes of JSON; the rows after it are counted, not kept. */
export const maxProviderErrorBytes = 4096;
/** What a view, a journal or a status shows of a refusal's rows (the full list stays in the refusal's details). */
export const maxViewedErrors = 5;
export const maxViewedFieldPaths = 10;
export const maxTriggerLength = 120;
const wordToken = /^[A-Z][A-Z0-9_]{0,79}$/,
  fieldPathToken = /^[A-Za-z0-9_.[\]]{1,200}$/;
const maxIndex = 9999999;
/**
 * An absolute URL that carries a query or a fragment, anywhere in the text (lead review S3-1: the rule once looked at the start of the text only,
 * and "Shop now at https://shop.test/p?ref=1" passed): where a signed link or a token travels. The text is at most 240 units long when it is tested.
 */
const urlWithQuery = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*[?#]/;
/** Control and invisible format characters: the Unicode tag characters spell ASCII a model reads and a person does not see. */
const invisibleCharacter = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
/**
 * The string values a request holds, at most `maxTriggerLength` characters each, read in the order the request has them from at most 20,000
 * values. A list is walked by index (lead review S4-1: spreading a list of about 130,000 values into push() throws, and the refusal lost every
 * row). `request` is the request as the caller redacted it (lead review S3-2: the value of a secret key is not the caller's own text to quote),
 * or a function that gives it, called once and only when a trigger has to be checked.
 */
function heldStrings(request: unknown): ReadonlySet<string> {
  const held = new Set<string>(),
    stack: unknown[] = [typeof request === 'function' ? (request as () => unknown)() : request];
  for (let visited = 0; stack.length && visited < 20000; visited++) {
    const node = stack.pop();
    if (typeof node === 'string') {
      if (node.length <= 2 * maxTriggerLength) held.add(node);
    } else if (node && typeof node === 'object') {
      const children: unknown[] = Array.isArray(node) ? node : Object.values(node);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  return held;
}
/**
 * A provider's trigger as a row quotes it, or undefined (r25-field3-errors, AMCP-03): a trigger is the provider's choice of
 * words, so it is quoted only when it is the caller's own text and nothing in it can be mistaken for a credential, a link
 * that carries one or an instruction a person cannot see.
 */
function triggerText(
  raw: string,
  clean: (token: string) => boolean,
  held: () => ReadonlySet<string>,
): string | undefined {
  // A character is at most two UTF-16 units, so a longer string is surely too long, and the code points are counted only for the rest.
  if (
    raw.length > 2 * maxTriggerLength ||
    [...raw].length > maxTriggerLength ||
    invisibleCharacter.test(raw) ||
    urlWithQuery.test(raw) ||
    !clean(raw)
  )
    return undefined;
  return held().has(raw) ? raw : undefined;
}
const policyWord = (v: unknown, clean: (token: string) => boolean): string | undefined =>
  typeof v === 'string' && wordToken.test(v) && clean(v) ? v : undefined;
function rowOf(
  raw: unknown,
  clean: (token: string) => boolean,
  held: () => ReadonlySet<string>,
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
  if (Number.isSafeInteger(row.subcode) && row.subcode >= 0) token.subcode = row.subcode;
  if (Number.isSafeInteger(row.operation_index) && row.operation_index >= 0 && row.operation_index <= maxIndex)
    token.operation_index = row.operation_index;
  if (typeof row.field_path === 'string' && fieldPathToken.test(row.field_path) && clean(row.field_path))
    token.field_path = row.field_path;
  const policy = errorObject(row.policy),
    kept: ProviderErrorPolicy = {};
  if (policyWord(policy.name, clean)) kept.name = policy.name;
  if (policyWord(policy.topic_type, clean)) kept.topic_type = policy.topic_type;
  if (typeof policy.exemptible === 'boolean') kept.exemptible = policy.exemptible;
  if (Object.keys(kept).length) token.policy = kept;
  // A row that holds nothing but a withheld trigger says nothing a person can use: it is no row.
  if (!Object.keys(token).length) return undefined;
  if (typeof row.trigger === 'string' && row.trigger) {
    const trigger = triggerText(row.trigger, clean, held);
    if (trigger !== undefined) token.trigger = trigger;
    else token.trigger_withheld = true;
  } else if (row.trigger_withheld === true) token.trigger_withheld = true; // a row made once keeps its mark when it is checked again
  return token;
}
/**
 * A row of closed-set tokens from what a provider hook found, or undefined when no token passes its pattern. `clean` is a
 * further test a string token must pass (the review's S2-2: it is the credential check of src/provider-error-taxonomy.ts):
 * one that fails is dropped like a token that fails its pattern, and its row keeps the rest. `request` is the request the
 * provider refused: the only place a trigger may come from.
 */
export function providerErrorToken(
  raw: unknown,
  clean: (token: string) => boolean = () => true,
  request?: unknown,
): ProviderErrorToken | undefined {
  return rowOf(raw, clean, () => heldStrings(request));
}
/**
 * The valid rows of a list a provider hook built, in order: at most `maxProviderErrors` rows and `maxProviderErrorBytes`
 * bytes of them, whole rows only, and how many valid rows were left out.
 */
export function providerErrorRows(
  rows: unknown,
  clean: (token: string) => boolean = () => true,
  request?: unknown,
): {rows: ProviderErrorToken[]; omitted: number} {
  let held: ReadonlySet<string> | undefined;
  const valid = (Array.isArray(rows) ? rows : [])
      .map(row => rowOf(row, clean, () => (held ??= heldStrings(request))))
      .filter((row): row is ProviderErrorToken => row !== undefined),
    kept: ProviderErrorToken[] = [];
  let bytes = 2;
  for (const row of valid) {
    const size = Buffer.byteLength(JSON.stringify(row)) + (kept.length ? 1 : 0);
    if (kept.length >= maxProviderErrors || bytes + size > maxProviderErrorBytes) break;
    kept.push(row);
    bytes += size;
  }
  return {rows: kept, omitted: valid.length - kept.length};
}
/** The valid rows of a list a provider hook built (see `providerErrorRows`). */
export const providerErrorTokens = (
  rows: unknown,
  clean?: (token: string) => boolean,
  request?: unknown,
): ProviderErrorToken[] => providerErrorRows(rows, clean, request).rows;
/**
 * The rows of a refusal as a view, a status or a journal shows them: the first `maxViewedErrors`, and how many more the
 * refusal has (its own count of rows left out, and the rows beyond five).
 */
export function viewProviderErrors(details: {provider_errors?: unknown; provider_errors_omitted?: unknown}): {
  provider_errors?: ProviderErrorToken[];
  provider_errors_omitted?: number;
} {
  const rows: ProviderErrorToken[] = Array.isArray(details.provider_errors) ? details.provider_errors : [],
    omitted =
      Math.max(0, rows.length - maxViewedErrors) +
      (Number.isSafeInteger(details.provider_errors_omitted) ? Number(details.provider_errors_omitted) : 0);
  return {
    ...(rows.length ? {provider_errors: rows.slice(0, maxViewedErrors)} : {}),
    ...(omitted > 0 ? {provider_errors_omitted: omitted} : {}),
  };
}
/**
 * The rows a journal keeps: the first `maxViewedErrors`, tokens only. A trigger is the caller's own request text and a journal
 * keeps no request, so a journal row never has one (nor the mark that one was withheld); every value is checked again.
 */
export function journalErrorRows(rows: unknown, clean?: (token: string) => boolean): ProviderErrorToken[] {
  return providerErrorRows(
    (Array.isArray(rows) ? rows : []).slice(0, maxViewedErrors).map(row => {
      const {trigger: _trigger, trigger_withheld: _withheld, ...tokens} = errorObject(row);
      return tokens;
    }),
    clean,
  ).rows;
}
/**
 * A provider check as a view shows it (the compact review of a plan step, `amcp_write status`): what it came to, the rows
 * and field paths of a rejection, the HTTP status and the provider's request reference, and never the provider's whole answer.
 * `message` adds the provider's own sentence (a plan's view carries it as its error does; a status never carries a message).
 */
export function providerCheckView(check: unknown, message = false): Record<string, unknown> | undefined {
  const c = errorObject(check);
  if (typeof c.status !== 'string') return undefined;
  const paths: unknown[] = Array.isArray(c.field_paths) ? c.field_paths : [];
  return {
    status: c.status,
    ...(c.checked_at !== undefined ? {checked_at: c.checked_at} : {}),
    ...(c.default === true ? {default: true} : {}),
    ...(typeof c.reason === 'string' ? {reason: c.reason} : {}),
    ...(c.http_status !== undefined ? {http_status: c.http_status} : {}),
    ...(typeof c.request_id === 'string' ? {request_id: c.request_id} : {}),
    ...(paths.length ? {field_paths: paths.slice(0, maxViewedFieldPaths)} : {}),
    ...(paths.length > maxViewedFieldPaths ? {field_paths_omitted: paths.length - maxViewedFieldPaths} : {}),
    ...viewProviderErrors(c),
    ...(message && typeof c.provider_message === 'string' ? {provider_message: c.provider_message} : {}),
    ...(typeof c.response_omitted_bytes === 'number' ? {response_omitted_bytes: c.response_omitted_bytes} : {}),
  };
}
/**
 * A check view for a reader who is not the one who prepared the review (lead review S3-3): a trigger is the request's own text, which the record
 * shows only to the credential that prepared it (WRT-08: request bodies are not shown to other members), so each trigger becomes the mark that
 * one was withheld, and the rest of the row is read as it is.
 */
export function withholdTriggers(view: Record<string, unknown>): Record<string, unknown> {
  const rows: unknown[] = Array.isArray(view.provider_errors) ? view.provider_errors : [],
    quoted = (row: unknown): row is Record<string, unknown> =>
      !!row && typeof row === 'object' && typeof (row as Record<string, unknown>).trigger === 'string';
  if (!rows.some(quoted)) return view;
  return {
    ...view,
    provider_errors: rows.map(row => {
      if (!quoted(row)) return row;
      const {trigger: _trigger, ...rest} = row;
      return {...rest, trigger_withheld: true};
    }),
  };
}
/**
 * The provider's own sentence for a refusal, as `details.provider_message` keeps it: cleaned as `echoedText` cleans, at
 * most 200 characters. It is third-party text: the envelope marks it untrusted and it is never part of a message.
 */
export const providerMessageText = (raw: unknown): string | undefined => echoedText(raw, 200);
/**
 * Text a message or a field repeats from outside AMCP's own words, cleaned (the review's S3-4): control characters, the
 * Unicode line and paragraph separators and the invisible format characters (category Cf: Unicode tag characters, which spell
 * ASCII a model reads and a person does not see, bidi controls and zero-width characters) become spaces, runs of white
 * space one space; at most `max` code points, so the cut never leaves half of a character; a lone surrogate, which no
 * well-formed text holds, becomes U+FFFD. Undefined when nothing is left.
 */
export function echoedText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
      .replace(/ {2,}/g, ' ')
      .trim(),
    cut = wellFormed([...cleaned].slice(0, max).join('')).trim();
  return cut || undefined;
}
// String.prototype.toWellFormed is in every Node this runs on (20 and later) and not yet in the TypeScript library of its target.
const wellFormed = (text: string): string => (text as string & {toWellFormed(): string}).toWellFormed();
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
