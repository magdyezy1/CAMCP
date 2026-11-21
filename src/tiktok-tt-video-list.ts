import {MirrorError} from './errors.js';
import {secretDigest, secretSpellings} from './secret-fields.js';
import type {TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * The reads of the Spark Ads posts a creator authorized to an advertiser, shared by the family that applies an authorization code and
 * the one that unbinds a post (package r25-m4b-smartpush, matrix A2). API for Business v1.3 "Get Spark Ad posts" (read 2026-11-21):
 * GET /v1.3/tt_video/list/, `page` and `page_size` (1-50), and each row has `user_info` (`tiktok_name`, `identity_id`, `identity_type`
 * AUTH_CODE), `item_info` (`item_id`, `item_type`, `text`, `status`, and the post's `auth_code`) and `auth_info` (`ad_auth_status`,
 * `auth_start_time`, `auth_end_time`). The page returns the code of every authorized post, and "Apply an authorization code" answers
 * with an empty `data`, so the post an applied code authorized is found by the digest of the code (src/secret-fields.ts): the list is
 * read a page at a time, the digest of each row's code is compared with the reviewed one, and what leaves this module is the row's facts,
 * never a code. "Get Spark Ad posts" and its sibling "Get info about a Spark Ad post" (which takes the code in its query) are not used
 * for the read-back for that reason: the review keeps no code to put in a query.
 */
export const ttVideoAuthorizePath = '/v1.3/tt_video/authorize/';
export const ttVideoUnbindPath = '/v1.3/tt_video/unbind/';
export const ttVideoListPath = '/v1.3/tt_video/list/';
export const ttVideoAuthorizeSource = 'https://business-api.tiktok.com/portal/docs/apply-an-authorization-code/v1.3';
export const ttVideoUnbindSource = 'https://business-api.tiktok.com/portal/docs/unbind-a-spark-ad-post/v1.3';
/** "Get Spark Ad posts": page_size 1-50. */
export const ttVideoPageSize = 50;
/** The most pages one lookup reads (1,000 posts): an advertiser with more is refused as incomplete, never judged on part of its list. */
export const ttVideoMaxPages = 20;

/** What a marked read looks for: the post whose code has this digest, or the post with this ID. */
export type Lookup = {role: 'code'; digest: string} | {role: 'post'; item_id: string};
export type Marked = CompiledRequest & {tiktokAuthorized?: Lookup};
export const lookupOf = (read: CompiledRequest): Lookup | undefined => (read as Marked).tiktokAuthorized;
/** A read of the list that looks for this role of post: each family claims the reads of its own role (a read has one family). */
export const isAuthorizedRead = (read: CompiledRequest, role: Lookup['role']): boolean =>
  read.gateway === 'tiktok_native_action' && read.path === ttVideoListPath && lookupOf(read)?.role === role;

const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** A creator's handle, or null when it is not one: TikTok's text is shown only where it is a token of its own alphabet. */
const handle = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : null);
const token = (v: unknown) => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? v : null);
/** What a review keeps and shows of an authorized post: its facts, and never its code or a link. */
export function postFacts(row: JsonObject): JsonObject {
  const item = obj(row.item_info) ? row.item_info : {},
    auth = obj(row.auth_info) ? row.auth_info : {},
    user = obj(row.user_info) ? row.user_info : {};
  return {
    item_id: String(item.item_id ?? ''),
    item_type: token(item.item_type),
    identity_id: user.identity_id === undefined || user.identity_id === null ? null : String(user.identity_id),
    tiktok_name: handle(user.tiktok_name),
    ad_auth_status: token(auth.ad_auth_status),
    auth_end_time:
      typeof auth.auth_end_time === 'string' && auth.auth_end_time.length <= 32 ? auth.auth_end_time : null,
  };
}
/** The code of a row matches a digest: as the person copied it, and as the page spells "+" ("%2B"), whichever way TikTok lists it. */
function matchesCode(row: JsonObject, digest: string): boolean {
  const code = obj(row.item_info) ? row.item_info.auth_code : undefined;
  if (typeof code !== 'string' || !code) return false;
  // The spellings of src/secret-fields.ts: the rule that scrubs a reply of the code is the rule that finds the code in the list.
  return secretSpellings(code).some(spelling => secretDigest(spelling) === digest);
}
const unverified = (message: string): never => {
  throw new MirrorError('INCOMPLETE_STATE', message, {}, 502);
};

/**
 * Reads the advertiser's authorized posts a page at a time until the lookup's post is found or the list ends, and answers with what
 * was found, whether the whole list was read, and the post's facts (never its code). A page that TikTok does not confirm is a read
 * that failed. `next` performs one read.
 */
export async function readAuthorized(
  read: CompiledRequest,
  next: (read: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const lookup = lookupOf(read);
  if (!lookup) return next(read);
  const plain = {...read, tiktokAuthorized: undefined} as CompiledRequest;
  let found: JsonObject | undefined,
    complete = false;
  for (let page = 1; page <= ttVideoMaxPages && !found && !complete; page++) {
    const r = await next({...plain, query: {...plain.query, page, page_size: ttVideoPageSize}}),
      d = obj(r.data) ? r.data : {},
      data = obj(d.data) ? d.data : {};
    if (r.status !== 200 || d.code !== 0 || !Array.isArray(data.list))
      unverified('TikTok did not confirm success with its list of authorized posts.');
    // The page that was asked for is the page that was answered: a list that reads page 1 again would be read as every page.
    if (Number(obj(data.page_info) ? data.page_info.page : page) !== page)
      unverified('TikTok answered another page of its list of authorized posts than the one asked for.');
    const row = (data.list as unknown[]).find(
      (x): x is JsonObject =>
        obj(x) &&
        (lookup.role === 'code'
          ? matchesCode(x, lookup.digest)
          : String(obj(x.item_info) ? x.item_info.item_id : '') === lookup.item_id),
    );
    if (row) found = postFacts(row);
    const pages = Number(obj(data.page_info) ? (data.page_info.total_page ?? 1) : 1);
    if (!Number.isInteger(pages) || pages < 1) unverified('TikTok’s list of authorized posts has no page count.');
    if (page >= pages) complete = true;
  }
  return {
    status: 200,
    headers: {},
    data: {
      tiktok_tt_video_authorizations: {
        role: lookup.role,
        found: !!found,
        complete: !!found || complete,
        ...(found ? {post: found} : {}),
      },
    },
  };
}
/** What a marked read keeps: the answer of `readAuthorized` as it is (it holds no code), so that saved states project to themselves. */
export function authorizedState(read: CompiledRequest, data: JsonObject): JsonObject | undefined {
  if (!lookupOf(read)) return undefined;
  return obj(data.tiktok_tt_video_authorizations) ? data : {tiktok_tt_video_authorizations: {}};
}
/** A marked read's answer is the lookup's, and a list that was not read to its end proves nothing of what is not in it. */
export function validateAuthorizedState(read: CompiledRequest, r: TransportResult): void {
  const lookup = lookupOf(read),
    s = obj(r.data) ? r.data.tiktok_tt_video_authorizations : undefined;
  if (r.status !== 200 || !obj(s) || s.role !== lookup?.role || typeof s.found !== 'boolean')
    unverified('Missing the list of the advertiser’s authorized posts.');
  if (!s.found && s.complete !== true)
    unverified(
      'TikTok lists more than ' +
        ttVideoMaxPages * ttVideoPageSize +
        ' authorized posts for this advertiser, more than AMCP reads at once, so it cannot show that the post is not among them.',
    );
}
/** The lookups of the review's state, by role. */
export const lookupsOf = (state: unknown[], role: Lookup['role']): JsonObject[] =>
  state
    .map(s => (obj(s) ? s.tiktok_tt_video_authorizations : undefined))
    .filter((s): s is JsonObject => obj(s) && s.role === role);
