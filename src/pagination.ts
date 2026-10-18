import type {CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import {providerOf} from './provider-adapters.js';
import {providerHooks} from './provider-hooks.js';
const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
/**
 * The request of the page after `response`, or null after the last page. Each provider's cursor rules are its adapter's
 * paging (ARC-01 phase B, src/<provider>-adapter.ts), which also refuses a cursor that would change the request's
 * scope; a provider without its own rules, or one whose rules leave a response to them, pages by the generic tokens.
 */
export function nextPage(plan: CompiledRequest, response: unknown): CompiledRequest | null {
  const d = obj(response),
    data = obj(d.data);
  const next = structuredClone(plan);
  const paged = providerHooks(plan.gateway)?.paging?.nextPage?.(plan, response, next);
  if (paged !== undefined) return paged;
  const token = d.nextPageToken ?? d.next_page_token ?? d.nextToken ?? data.nextToken;
  if (token) {
    const key =
      d.nextToken !== undefined || data.nextToken !== undefined
        ? 'nextToken'
        : (providerOf(plan.gateway)?.paging?.tokenParameter ?? 'pageToken');
    if (plan.method === 'POST') next.body = {...obj(plan.body), [key]: token};
    else next.query[key] = token;
    return next;
  }
  return null;
}
function arraySlots(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [prefix];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) =>
    Array.isArray(v) ? [prefix + '/' + k] : k === 'data' || k === 'result' ? arraySlots(v, prefix + '/' + k) : [],
  );
}
function at(root: any, path: string) {
  return path
    ? path
        .slice(1)
        .split('/')
        .reduce((v, k) => v?.[k], root)
    : root;
}
function put(root: any, path: string, value: any) {
  const parts = path.slice(1).split('/');
  const key = parts.pop()!;
  const parent = parts.reduce((v, k) => v[k], root);
  parent[key] = value;
}
/** The whole collection a request reads, when its provider reports one whole (TikTok integrated reports). */
function wholeCollection(plan: CompiledRequest) {
  const whole = providerHooks(plan.gateway)?.paging?.whole;
  return whole?.claims(plan) ? whole : undefined;
}
/**
 * Follows native pages and merges their row collections. Everything that is not a row collection (provider paging
 * objects, cursors, page counters) describes the last page read, so a visible cursor never points back at rows already
 * merged (a collection its provider reports whole, such as a TikTok integrated report, keeps its first page's counts).
 * A capped collection is truncated and carries `continuation`, the exact request of the first page not read.
 */
export async function paginate(
  plan: CompiledRequest,
  fetchPage: (plan: CompiledRequest) => Promise<unknown>,
  maxPages = 25,
): Promise<{data: unknown; pages: number; truncated: boolean; continuation?: CompiledRequest}> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100)
    throw new MirrorError('INVALID_PAGE_LIMIT', 'max_pages must be between 1 and 100.');
  // A collection its provider reports whole is started at its first page, and every page is checked across it.
  const whole = wholeCollection(plan),
    verify = whole?.start(plan);
  const first = await fetchPage(plan);
  verify?.(plan, first);
  let merged = structuredClone(first);
  let current = plan;
  let response = first;
  let pages = 1;
  const seen = new Set([stable({path: plan.path, query: plan.query, body: plan.body})]);
  const slots = arraySlots(first);
  while (true) {
    const next = nextPage(current, response);
    if (!next) return {data: merged, pages, truncated: false};
    // Without a row collection there is nothing to merge: a second page would silently replace the first.
    if (!slots.length)
      throw new MirrorError(
        'UNKNOWN_PAGINATION',
        'The platform advertises another page of a response without a row collection. Read it page by page.',
      );
    if (pages >= maxPages) return {data: merged, pages, truncated: true, continuation: next};
    const key = stable({path: next.path, query: next.query, body: next.body});
    if (seen.has(key)) throw new MirrorError('PAGINATION_LOOP', 'Platform repeated a page cursor.');
    seen.add(key);
    response = await fetchPage(next);
    verify?.(next, response);
    pages++;
    if (arraySlots(response).join('|') !== slots.join('|'))
      throw new MirrorError(
        'PAGINATION_SHAPE_CHANGED',
        'Row collections changed between pages; refusing to return a partial successful result.',
      );
    // The rows so far, on the skeleton of the page just read: its paging metadata is the current position. A whole
    // collection (a TikTok integrated report) keeps its first page's native counts (page 1 of total_page, total_number),
    // which describe the whole verified collection; it is never resumed mid-way.
    const rows = slots.map(slot => [at(merged, slot), at(response, slot)]);
    if (slots.length === 1 && slots[0] === '') {
      const [a, b] = rows[0]!;
      if (Array.isArray(a) && Array.isArray(b)) merged = [...a, ...b];
    } else {
      const skeleton = whole ? merged : structuredClone(response);
      slots.forEach((slot, i) => {
        const [a, b] = rows[i]!;
        if (Array.isArray(a) && Array.isArray(b)) put(skeleton, slot, [...a, ...b]);
      });
      merged = skeleton;
    }
    current = next;
    if (Buffer.byteLength(JSON.stringify(merged)) > 64 * 1024 * 1024)
      throw new MirrorError('AGGREGATE_TOO_LARGE', 'Aggregated data exceeds 64 MiB; split the query.');
  }
}
/** The top-level fields whose values differ from `from` to `to`; undefined when a field was removed or the shapes differ. */
function changedFields(from: unknown, to: unknown): JsonObject | undefined {
  const isObject = (v: unknown) => v === undefined || (!!v && typeof v === 'object' && !Array.isArray(v));
  if (!isObject(from) || !isObject(to)) return stable(from) === stable(to) ? {} : undefined;
  const a = obj(from),
    b = obj(to);
  if (Object.keys(a).some(k => a[k] !== undefined && b[k] === undefined)) return undefined;
  return Object.fromEntries(Object.entries(b).filter(([k, v]) => stable(v) !== stable(a[k])));
}
/**
 * The tool arguments that request `continuation`, the first page a capped aggregation did not read: the arguments that
 * produced `plan`, with each changed native paging value set wherever the caller supplied it (top level, params, query
 * or the request body), or in `params`/`query` when the caller did not. `sameParameter` decides which argument names
 * address a native parameter (delegated routes accept aliases). Undefined when the change cannot be expressed. The
 * caller must compile the result again and compare it with `continuation` before offering it.
 */
export function continuationArguments(
  plan: CompiledRequest,
  continuation: CompiledRequest,
  args: JsonObject,
  delegated: boolean,
  sameParameter: (argument: string, native: string) => boolean = (a, n) => a === n,
): JsonObject | undefined {
  if (continuation.path !== plan.path || continuation.method !== plan.method || continuation.gateway !== plan.gateway)
    return undefined;
  const query = changedFields(plan.query, continuation.query),
    body = changedFields(plan.body, continuation.body);
  if (!query || !body || (!Object.keys(query).length && !Object.keys(body).length)) return undefined;
  const next: JsonObject = structuredClone(args),
    bodyKey =
      providerOf(plan.gateway)?.paging?.bodyArgument ?? (next.payload === undefined && next.body ? 'body' : 'payload');
  const place = (key: string, value: unknown, bags: unknown[], fallback: string) => {
    let placed = false;
    for (const bag of bags)
      if (bag && typeof bag === 'object' && !Array.isArray(bag))
        for (const name of Object.keys(bag))
          if (sameParameter(name, key)) {
            // Every name the caller used for it (an alias included) carries the new value, so none conflict.
            (bag as JsonObject)[name] = value;
            placed = true;
          }
    if (!placed) {
      if (next[fallback] !== undefined && (!next[fallback] || typeof next[fallback] !== 'object')) return false;
      next[fallback] = {...obj(next[fallback]), [key]: value};
    }
    return true;
  };
  const controls = new Set(['action', 'operation', 'arguments', 'params', 'query', 'payload', 'body', 'request']);
  const top = Object.fromEntries(Object.entries(next).filter(([k]) => !controls.has(k)));
  for (const [key, value] of Object.entries(query))
    if (!place(key, value, [top, next.params, next.query], delegated ? 'params' : 'query')) return undefined;
  for (const [key, value] of Object.entries(body))
    if (!place(key, value, [next[bodyKey], next.params], bodyKey)) return undefined;
  Object.assign(next, top);
  return next;
}
const requestKey = (p: CompiledRequest) => stable({path: p.path, query: p.query, body: p.body});
/**
 * The `next_call` of a capped aggregation: the same tool and arguments, asking for the first page not read, so following
 * it returns exactly the remaining rows. It is offered only when `compile` turns it back into that exact request.
 * A collection its provider reports whole (TikTok integrated reports) is read again from page one, with every page.
 */
export function nextPageCall(
  plan: CompiledRequest,
  continuation: CompiledRequest,
  args: JsonObject,
  data: unknown,
  options: {
    delegated: boolean;
    compile: (call: JsonObject) => CompiledRequest;
    sameParameter?: (argument: string, native: string) => boolean;
  },
): JsonObject | undefined {
  const tool = options.delegated ? {operation: plan.action.split('/')[0]} : {};
  let next: JsonObject | undefined, expected: CompiledRequest, pages: number;
  const whole = wholeCollection(plan);
  if (whole) {
    pages = whole.pages(data);
    if (!Number.isSafeInteger(pages) || pages < 2 || pages > 100) return undefined;
    next = {...args, max_pages: pages};
    expected = plan;
  } else {
    next = continuationArguments(plan, continuation, args, options.delegated, options.sameParameter);
    pages = Number(args.max_pages ?? 25);
    expected = continuation;
  }
  if (!next) return undefined;
  // A tool whose public schema has no aggregation controls (delegated operations) continues one page at a time.
  const {aggregate_pages, paginate: _paginate, allPages, max_pages, ...single} = next;
  const aggregated = [aggregate_pages, _paginate, allPages].some(Boolean),
    candidates: [JsonObject, number][] = [[next, pages]];
  if (aggregated && !whole) candidates.push([single, 1]);
  for (const [candidate, requests] of candidates) {
    const call = options.delegated ? {...tool, arguments: candidate} : candidate;
    try {
      if (requestKey(options.compile(call)) !== requestKey(expected)) continue;
    } catch {
      continue;
    }
    return {
      tool: plan.gateway,
      arguments: call,
      effects: {provider_requests: requests, saves: [], advertising_writes: 0},
      meaning: whole
        ? whole.meaning
        : requests === 1 && candidate === single
          ? 'Reads the first page after the last one merged here. The provider paging fields in data describe the last page read.'
          : 'Reads the pages after the last one merged here (at most max_pages provider reads). The provider paging fields in data describe the last page read.',
    };
  }
  return undefined;
}
