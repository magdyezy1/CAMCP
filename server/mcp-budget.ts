import {principalOf} from '../src/actor-identity.js';
import {invalidCursor} from '../src/page-cursor.js';
import {sha256, stable} from '../src/security.js';
import {bad} from '../src/workspace-core.js';
import type {Actor, JsonObject} from '../src/types.js';

/**
 * The response budget of the v2 contract profile (V2-MCP-06): an MCP list result over a budget of JSON bytes is cut at a row
 * boundary, never inside a row, and says so: `truncated`, how many rows it holds of how many, and the `next_call` that
 * continues. Only the answers to MCP calls are cut, and only for a client on v2 (server/mcp.ts); the website's own calls, the
 * workers and every legacy client are answered whole, as before.
 *
 * - The budget starts at 64 KiB of the result envelope's JSON (`defaultBudgetBytes`) and a call may ask for more with
 *   `max_bytes`, up to `maxBudgetBytes`, or for less, down to `minBudgetBytes`. The text block of the MCP result repeats the
 *   envelope, so the wire carries it twice. `max_bytes` and `continuation` are arguments of this layer: server/mcp.ts takes them
 *   out before the call reaches a tool, so no tool schema lists them and every tool's own validation is as it was.
 * - The list is the largest array of the result's `data` (or `data` itself), at most three objects deep. A piece keeps whole rows
 *   up to the budget, always at least one, so a single row larger than the budget is still returned whole and said so.
 * - A truncated piece's `next_call` is the same call with `continuation`, and it is the only way forward: the piece's own paging
 *   fields (`next_offset`, `next_cursor`, the provider's `next_call`) are emptied, so a client that followed them could not skip
 *   the rows that were cut. The call is run again for each piece and the rows already given are skipped, which is why only calls
 *   that read are ever cut (src/call-kind.ts); the last piece carries the result's own paging again.
 * - The continuation is bound to the tenant, the AI client, the person, the access set, the tool and every argument, `max_bytes`
 *   included, and not to the access token: it survives a token refresh, as a task does. Another client, person, workspace or
 *   argument set, an altered token or a list that is no longer there is INVALID_CURSOR.
 */
export const defaultBudgetBytes = 65536,
  minBudgetBytes = 4096,
  maxBudgetBytes = 262144;

const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** What a v2 call asks of the budget: its arguments without the budget's own, the byte budget and the continuation. */
export interface BudgetRequest {
  /** The arguments the tool receives: everything but `continuation` and `max_bytes`. */
  args: JsonObject;
  maxBytes: number;
  /** Whether the caller named a budget: it is part of what a continuation is bound to. */
  asked: boolean;
  continuation?: string;
}
/** Takes `max_bytes` and `continuation` out of a call's arguments, refusing a value that is not what they take. */
export function budgetRequest(input: JsonObject): BudgetRequest {
  const {max_bytes: maxBytes, continuation, ...args} = input;
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < minBudgetBytes || maxBytes > maxBudgetBytes))
    bad('Use max_bytes as a whole number of bytes from 4096 to 262144.', 'INVALID_ARGUMENT', {
      field: 'max_bytes',
      minimum: minBudgetBytes,
      maximum: maxBudgetBytes,
    });
  if (continuation !== undefined && (typeof continuation !== 'string' || !continuation || continuation.length > 2048))
    throw invalidCursor('response continuation');
  return {
    args,
    maxBytes: maxBytes === undefined ? defaultBudgetBytes : (maxBytes as number),
    asked: maxBytes !== undefined,
    ...(continuation === undefined ? {} : {continuation: continuation as string}),
  };
}

/** The arguments of the call as a continuation repeats them, and as it is bound to them. */
const repeated = (request: BudgetRequest): JsonObject => ({
  ...request.args,
  ...(request.asked ? {max_bytes: request.maxBytes} : {}),
});
/** The binding of a continuation: who asked (tenant, client, person, access set) and what they asked (tool, arguments). */
export function budgetBinding(actor: Actor, tool: string, request: BudgetRequest): string {
  return sha256(
    stable({
      tenant: actor.tenantId,
      client: actor.userId,
      person: principalOf(actor),
      access_set: actor.accessSetId ?? null,
      tool,
      arguments: repeated(request),
    }),
  );
}
/** The continuation of a call, checked before the call runs: where the list was cut, or INVALID_CURSOR. Undefined without one. */
export function continuationOf(actor: Actor, tool: string, request: BudgetRequest): Continuation | undefined {
  return request.continuation === undefined
    ? undefined
    : decode(request.continuation, budgetBinding(actor, tool, request));
}
export interface Continuation {
  offset: number;
  path: string[];
}
const encode = (binding: string, offset: number, path: string[]) =>
  Buffer.from(JSON.stringify({version: 1, binding, offset, path})).toString('base64url');
/** The rows already given and where the list is, from a continuation issued for this binding; INVALID_CURSOR otherwise. */
function decode(token: string, binding: string): {offset: number; path: string[]} {
  try {
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) throw Error();
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (
      parsed?.version !== 1 ||
      parsed.binding !== binding ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 1 ||
      !Array.isArray(parsed.path) ||
      parsed.path.length > 3 ||
      parsed.path.some((key: unknown) => typeof key !== 'string' || !key || key.length > 120)
    )
      throw Error();
    return {offset: parsed.offset, path: parsed.path};
  } catch {
    throw invalidCursor('response continuation');
  }
}

interface Located {
  path: string[];
  rows: unknown[];
}
/** The lists of a value, at most three objects deep; a list is not searched for lists. */
function lists(value: unknown, path: string[], found: Located[]) {
  if (Array.isArray(value)) {
    if (value.length) found.push({path, rows: value});
  } else if (isObject(value) && path.length < 3)
    for (const [key, child] of Object.entries(value)) lists(child, [...path, key], found);
}
/** The largest list of the result's data, by its JSON. */
function largest(data: unknown): Located | undefined {
  const found: Located[] = [];
  lists(data, [], found);
  let best: Located | undefined,
    bestSize = -1;
  for (const candidate of found) {
    const bytes = size(candidate.rows);
    if (bytes > bestSize) [best, bestSize] = [candidate, bytes];
  }
  return best;
}
const at = (data: unknown, path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (isObject(v) ? v[key] : undefined), data);
/** A copy of `data` with the list at `path` replaced; the objects along the way are copied, nothing is changed in place. */
function replaced(data: unknown, path: string[], rows: unknown[]): unknown {
  if (!path.length) return rows;
  const [key, ...rest] = path;
  return {...(data as JsonObject), [key!]: replaced((data as JsonObject)[key!], rest, rows)};
}
const dotted = (path: string[]) => 'data' + path.map(key => '.' + key).join('');

/** The paging fields a truncated piece empties, and the flag it raises, in the result's own `data` when that is an object. */
function truncatedData(data: unknown, next: JsonObject): unknown {
  if (!isObject(data)) return data;
  const out: JsonObject = {...data};
  for (const key of ['next_offset', 'next_cursor']) if (key in out) out[key] = null;
  if ('has_more' in out) out.has_more = true;
  out.truncated = true;
  out.next_call = next;
  return out;
}

/**
 * The answer to one v2 call: the envelope whole when it fits (and carries no continuation), else the piece the budget allows.
 * `envelope` is the tool's own result, `{success: true, data, meta}`; the piece is a new envelope with `meta.budget`.
 */
export function budgeted(options: {
  tool: string;
  actor: Actor;
  request: BudgetRequest;
  given?: Continuation;
  envelope: JsonObject;
}): JsonObject {
  const {tool, actor, request, given, envelope} = options,
    binding = budgetBinding(actor, tool, request);
  const data = envelope.data;
  // A continuation that is not of a list this call still returns is not a continuation of this call.
  const list = given ? (at(data, given.path) as unknown) : undefined,
    located: Located | undefined = given
      ? Array.isArray(list) && list.length >= given.offset
        ? {path: given.path, rows: list}
        : undefined
      : largest(data);
  if (given && !located) throw invalidCursor('response continuation');
  if (!located || (!given && size(envelope) <= request.maxBytes)) return envelope;
  const offset = given?.offset ?? 0,
    rows = located.rows.slice(offset),
    total = located.rows.length;
  const piece = (kept: number, truncated: boolean): JsonObject => {
    const budget: JsonObject = {
      truncated,
      max_bytes: request.maxBytes,
      path: dotted(located.path),
      rows_total: total,
      rows_before: offset,
      rows_returned: kept,
      rows_omitted: total - offset - kept,
    };
    const next: JsonObject | undefined = truncated
      ? {
          tool,
          arguments: {...repeated(request), continuation: encode(binding, offset + kept, located.path)},
        }
      : undefined;
    if (next) budget.next_call = next;
    const cut = replaced(data, located.path, rows.slice(0, kept));
    return {
      ...envelope,
      data: next ? truncatedData(cut, next) : cut,
      meta: {...(isObject(envelope.meta) ? envelope.meta : {}), budget},
    };
  };
  const whole = piece(rows.length, false);
  if (size(whole) <= request.maxBytes) return whole;
  // The most whole rows that fit, at least one: a row is never cut, and one larger than the budget is said to be over it.
  let low = 1,
    high = rows.length - 1;
  if (high < 1) {
    (whole.meta as JsonObject).budget.over_budget = true;
    return whole;
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(piece(middle, true)) <= request.maxBytes) low = middle;
    else high = middle - 1;
  }
  const chosen = piece(low, true);
  if (size(chosen) > request.maxBytes) (chosen.meta as JsonObject).budget.over_budget = true;
  return chosen;
}
