import type {JsonObject} from './types.js';

const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The continuation of a Snapchat list, read once (V2-PRV-01 design note 4: the previews tool and the report readers each
 * wrote this check, with slightly different parameter sets). A leaf, so that a module of the adapter's own chain and the
 * report modules (src/snapchat-evidence.ts, which refuses with its report sentences) can both use it without a cycle.
 *
 * `paging` holds nothing but `next_link`, which, when present, is a same-origin link to the route `path` with every
 * parameter of the request (`query`) unchanged and one `cursor`, within 8,192 characters and with no userinfo or fragment.
 * The cursor is the only thing taken from it; an upstream URL is never followed.
 *   `{}`                no further page
 *   `{token}`           the cursor of the next page
 *   `{refused: ...}`    the paging object holds more than the link (`metadata`), or the link is not the request's (`link`)
 */
export function snapchatContinuation(
  data: JsonObject,
  path: string,
  query: JsonObject,
): {token?: string; refused?: 'metadata' | 'link'} {
  if (data.paging === undefined) return {};
  if (!obj(data.paging) || Object.keys(data.paging).some(k => k !== 'next_link')) return {refused: 'metadata'};
  if (data.paging.next_link === undefined) return {};
  try {
    const link = data.paging.next_link;
    if (typeof link !== 'string' || !link || link.length > 8192) throw Error();
    const u = new URL(link),
      token = u.searchParams.get('cursor');
    if (
      u.origin !== 'https://adsapi.snapchat.com' ||
      u.username ||
      u.password ||
      u.hash ||
      u.pathname !== path ||
      [...u.searchParams.keys()].some(
        k =>
          u.searchParams.getAll(k).length !== 1 ||
          (k !== 'cursor' && (!Object.hasOwn(query, k) || u.searchParams.get(k) !== String(query[k]))),
      ) ||
      typeof token !== 'string' ||
      !token ||
      token.length > 4096 ||
      /[\x00-\x20\x7f]/.test(token)
    )
      throw Error();
    return {token};
  } catch {
    return {refused: 'link'};
  }
}
