import type {CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
/**
 * Reddit's page step (ARC-01 phase B): the request of the page after `response` (`next`, a copy of `plan`, with its
 * page token set), or null after the last page. Its next_url must keep the request's origin, path and every parameter
 * but page.token, or it is refused. A leaf, so that Reddit's adapter (its paging hook) and its creative family (the
 * account's profile reads) both take it without importing src/pagination.ts, which consults the provider hooks: Reddit's
 * write contract and state check are then its adapter's hooks without an import cycle.
 */
export function redditNextPage(
  plan: CompiledRequest,
  response: unknown,
  next: CompiledRequest,
): CompiledRequest | null {
  const token = redditNextToken(plan.path, plan.query, response);
  if (token === null) return null;
  next.query['page.token'] = token;
  return next;
}
/**
 * The page token of the page after `response`, or null after the last page: the check of redditNextPage on the route
 * `path` and the parameters `query` of the request alone, which the previews tool (src/reddit-ad-previews.ts) makes
 * without a compiled plan (V2-PRV-01 design note 4: it wrote this check a second time).
 */
export function redditNextToken(path: string, query: JsonObject, response: unknown): string | null {
  const d = obj(response);
  const link = d.pagination?.next_url;
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination must supply a valid absolute URL.');
  }
  if (url.origin !== 'https://ads-api.reddit.com' || url.username || url.password || url.hash || url.pathname !== path)
    throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination changed upstream scope.');
  const keys = new Set<string>();
  let token = '';
  for (const [key, value] of url.searchParams) {
    if (keys.has(key))
      throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination contains duplicate parameters.');
    keys.add(key);
    if (key === 'page.token') {
      token = value;
      continue;
    }
    if (query[key] === undefined || String(query[key]) !== value)
      throw new MirrorError(
        'UNSAFE_PAGINATION_LINK',
        'Reddit pagination changed account scope, page size or report filters.',
        {parameter: key},
      );
  }
  if (!keys.has('page.token'))
    throw new MirrorError('UNKNOWN_PAGINATION', 'Reddit supplied a next URL without a page token.');
  return token;
}
