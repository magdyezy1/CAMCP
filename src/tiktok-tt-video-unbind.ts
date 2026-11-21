import {MirrorError} from './errors.js';
import {assertNoMethodOverride, object, responseData} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import type {TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';
import {
  authorizedState,
  isAuthorizedRead,
  lookupOf,
  lookupsOf,
  readAuthorized,
  ttVideoListPath,
  ttVideoUnbindPath,
  ttVideoUnbindSource,
  validateAuthorizedState,
} from './tiktok-tt-video-list.js';
import type {Marked} from './tiktok-tt-video-list.js';

/**
 * Unbinding a creator's post from an advertiser (package r25-m4b-smartpush, matrix A2), per API for Business v1.3 "Unbind a Spark Ad
 * post" (read 2026-11-21): POST /v1.3/tt_video/unbind/ with `advertiser_id` and `item_id`; "Use this endpoint to unbind a Spark Ad post
 * after the authorization has expired or has been revoked. To unbind a Spark Ad post is to remove the post from the list of authorized
 * Spark Ad posts for the ad account"; the answer has an empty `data`. It is a destructive write, as a deletion is: allow_deletion:false
 * refuses it, the owner's destructive tier asks destructive_confirmed, and website approval asks a member (src/write-approval.ts).
 *
 * The review reads the advertiser's authorized posts (src/tiktok-tt-video-list.ts) and refuses a post that is not among them, and one
 * whose authorization is not over: AUTHORIZED is still in effect, and the page documents the unbind for EXPIRED and, as the
 * authorization the creator took back, CANCEL; APPLYING, NORESPONSE and REJECTED were never granted and are not a case it documents.
 * It also reads the advertiser's Upgraded Smart+ ads ("Get Upgraded Smart+ Ads": `page` and `page_size` up to 100) and lists those whose
 * creatives name the post: they cannot deliver without the authorization. TikTok's page says that read returns only the creatives an ad
 * selected explicitly, so an ad that added the post automatically is not among them (the impact says so). An advertiser with more
 * ads than AMCP reads (`maxAdPages` pages) is refused as incomplete. The read-back reads the list again: the post must be gone.
 */
export const tiktokTtVideoUnbindKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === ttVideoUnbindPath;

const adsPath = '/v1.3/smart_plus/ad/get/',
  adsPageSize = 100,
  maxAdPages = 30;
/** The authorization statuses after which the page documents an unbind: it ran out, or the creator took it back. */
const ended: readonly string[] = ['EXPIRED', 'CANCEL'];
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_TT_VIDEO_UNBIND', message, {field, source: ttVideoUnbindSource});
}
function unverified(message: string): never {
  throw new MirrorError('INCOMPLETE_STATE', message, {}, 502);
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokTtVideoUnbind(p: CompiledRequest): void {
  const body = object(p.body);
  const extra = Object.keys(body).find(k => k !== 'advertiser_id' && k !== 'item_id');
  if (extra) invalid(extra, '"' + extra + '" is outside the qualified Spark Ads unbind contract.');
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== p.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if (!numeric(body.item_id)) invalid('item_id', 'item_id must be the numeric ID of an authorized Spark Ads post.');
}

type Users = Marked & {tiktokTtVideoUsers?: {item_id: string}};
const usersOf = (read: CompiledRequest) => (read as Users).tiktokTtVideoUsers;
const isUsersRead = (read: CompiledRequest): boolean =>
  read.gateway === 'tiktok_native_action' && read.path === adsPath && usersOf(read) !== undefined;
/** The post's row in the authorized list, and the advertiser's Smart+ ads, which are read for the ones that name the post. */
export function tiktokTtVideoUnbindSnapshots(
  p: CompiledRequest,
  stateRead: (path: string, query?: JsonObject) => CompiledRequest,
): CompiledRequest[] {
  const item_id = String(object(p.body).item_id);
  const post: Marked = stateRead(ttVideoListPath, {advertiser_id: p.accountId});
  post.action = 'tiktok_tt_video_list_get';
  post.tiktokAuthorized = {role: 'post', item_id};
  const users: Users = stateRead(adsPath, {advertiser_id: p.accountId});
  users.action = 'tiktok_smart_plus_ad_get';
  users.tiktokTtVideoUsers = {item_id};
  return [post, users];
}
/** Every read of this family is one of its two markers. */
export const isTiktokTtVideoUnbindRead = (read: CompiledRequest): boolean =>
  isAuthorizedRead(read, 'post') || isUsersRead(read);

/**
 * The Smart+ ads whose creatives name the post, read a page at a time: each ad's ID and status, and whether the whole list was read.
 * A page that TikTok does not confirm is a read that failed.
 */
export async function readTiktokTtVideoUnbind(
  read: CompiledRequest,
  next: (read: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const marker = usersOf(read);
  if (!marker) return readAuthorized(read, next);
  const plain = {...read, tiktokTtVideoUsers: undefined} as CompiledRequest,
    ads: JsonObject[] = [];
  let complete = false;
  for (let page = 1; page <= maxAdPages && !complete; page++) {
    const r = await next({...plain, query: {...plain.query, page, page_size: adsPageSize}}),
      d = obj(r.data) ? r.data : {},
      data = obj(d.data) ? d.data : {};
    if (r.status !== 200 || d.code !== 0 || !Array.isArray(data.list))
      unverified('TikTok did not confirm success with its list of Upgraded Smart+ ads.');
    // The page that was asked for is the page that was answered, as for the list of authorized posts.
    if (Number(obj(data.page_info) ? data.page_info.page : page) !== page)
      unverified('TikTok answered another page of its list of Upgraded Smart+ ads than the one asked for.');
    for (const row of data.list as unknown[])
      if (
        obj(row) &&
        Array.isArray(row.creative_list) &&
        row.creative_list.some(
          (c: unknown) =>
            obj(c) && obj(c.creative_info) && String(c.creative_info.tiktok_item_id ?? '') === marker.item_id,
        )
      )
        ads.push({
          smart_plus_ad_id: String(row.smart_plus_ad_id),
          operation_status: typeof row.operation_status === 'string' ? row.operation_status : null,
        });
    const pages = Number(obj(data.page_info) ? (data.page_info.total_page ?? 1) : 1);
    if (!Number.isInteger(pages) || pages < 1) unverified('TikTok’s list of Upgraded Smart+ ads has no page count.');
    if (page >= pages) complete = true;
  }
  ads.sort((a, b) => (String(a.smart_plus_ad_id) < String(b.smart_plus_ad_id) ? -1 : 1));
  return {
    status: 200,
    headers: {},
    data: {tiktok_tt_video_users: {item_id: marker.item_id, complete, ads}},
  };
}
export function validateTiktokTtVideoUnbindState(read: CompiledRequest, r: TransportResult): void {
  const marker = usersOf(read);
  if (!marker) return validateAuthorizedState(read, r);
  const s = obj(r.data) ? r.data.tiktok_tt_video_users : undefined;
  if (r.status !== 200 || !obj(s) || s.item_id !== marker.item_id || !Array.isArray(s.ads))
    unverified('Missing the list of Upgraded Smart+ ads that use the post.');
  if (s.complete !== true)
    unverified(
      'TikTok lists more than ' +
        maxAdPages * adsPageSize +
        ' Upgraded Smart+ ads for this advertiser, more than AMCP reads at once, so it cannot show which of them use the post.',
    );
}
export function tiktokTtVideoUnbindState(read: CompiledRequest, data: JsonObject): JsonObject | undefined {
  if (isUsersRead(read)) return obj(data.tiktok_tt_video_users) ? data : {tiktok_tt_video_users: {}};
  return authorizedState(read, data);
}

const postOf = (state: unknown[]) => lookupsOf(state, 'post')[0],
  usersIn = (state: unknown[]) =>
    state.map(s => (obj(s) ? s.tiktok_tt_video_users : undefined)).find((s): s is JsonObject => obj(s));
/** At prepare and again at execute: the post is listed, and its authorization is over. */
export function tiktokTtVideoUnbindPrerequisites(p: CompiledRequest, state: unknown[]): void {
  const item = String(object(p.body).item_id),
    found = postOf(state);
  if (!found || found.found !== true)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Post ' + item + ' is not among the selected advertiser’s authorized Spark Ads posts.',
      {item_id: item},
    );
  const status = object(found.post).ad_auth_status;
  if (status === 'AUTHORIZED')
    invalid(
      'item_id',
      'The authorization of post ' +
        item +
        ' is still in effect (AUTHORIZED). TikTok documents an unbind for an authorization that has expired or been revoked; ask the creator to revoke it, or wait for it to end.',
    );
  if (typeof status !== 'string' || !ended.includes(status))
    invalid(
      'item_id',
      'The authorization status of post ' +
        item +
        ' is ' +
        (typeof status === 'string' ? status : 'not known') +
        ', and TikTok documents an unbind only after the authorization expired (EXPIRED) or was revoked (CANCEL).',
    );
}

const unbindEffect =
  'Removes the post from the advertiser’s list of authorized Spark Ads posts. AMCP cannot undo it: the creator would have to generate a new authorization code, which is applied with its own review. Spark Ads that use it cannot deliver without the authorization.';
const adsNote =
  'TikTok’s list of Upgraded Smart+ ads returns only the creatives an ad selected explicitly, so an ad that added this post automatically is not listed.';
export function tiktokTtVideoUnbindImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const found = postOf(state),
    users = usersIn(state);
  if (!found || !users) unverified('Missing the reads of the post and of the ads that use it.');
  const ads = (Array.isArray(users.ads) ? users.ads : []) as JsonObject[];
  return {
    provider: 'tiktok',
    scope: 'spark_ads_authorization',
    operation: 'delete',
    may_affect_serving: ads.some(a => a.operation_status === 'ENABLE'),
    effect: unbindEffect,
    post: object(found.post),
    ads_using_post: ads,
    ads_complete: users.complete === true,
    ads_note: adsNote,
    verification: 'Reads the advertiser’s authorized posts again: the post must no longer be among them.',
    source: ttVideoUnbindSource,
  };
}

/** TikTok's answer is `code` 0 and an empty `data`. */
export const tiktokTtVideoUnbindOutcome = (_p: CompiledRequest, r: TransportResult): boolean =>
  responseData(r).code === 0;

/** The read-back: the list again, expecting the post gone. */
export function tiktokTtVideoUnbindVerification(
  p: CompiledRequest,
  _result: JsonObject,
  _before: unknown[],
  verificationRead: (path: string, query?: JsonObject) => CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const item_id = String(object(p.body).item_id),
    read: Marked = {
      ...verificationRead(ttVideoListPath, {advertiser_id: p.accountId}),
      action: 'tiktok_tt_video_list_get',
      tiktokAuthorized: {role: 'post', item_id},
    };
  return [{read, expected: {unbound: true}, id: item_id}];
}
export function tiktokTtVideoUnbindObserved(
  read: CompiledRequest,
  data: JsonObject,
  gatewayObserved: () => JsonObject,
) {
  if (!lookupOf(read)) return gatewayObserved();
  const s = object(data.tiktok_tt_video_authorizations);
  return {unbound: s.found === true ? false : s.complete === true ? true : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokTtVideoUnbindFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_tt_video_unbinds',
  files: ['src/tiktok-tt-video-unbind.ts', ['tests/tiktok-tt-video-authorize.test.mjs']],
  kind: tiktokTtVideoUnbindKind,
  assert: (plan, gatewayChecks) => {
    assertNoMethodOverride(plan);
    gatewayChecks();
    assertTiktokTtVideoUnbind(plan);
  },
  snapshots: tiktokTtVideoUnbindSnapshots,
  isRead: isTiktokTtVideoUnbindRead,
  reader: readTiktokTtVideoUnbind,
  validateState: (read, result) => validateTiktokTtVideoUnbindState(read, result),
  snapshotState: (read, data) => tiktokTtVideoUnbindState(read, data),
  prerequisites: tiktokTtVideoUnbindPrerequisites,
  impact: (plan, state) => tiktokTtVideoUnbindImpact(plan, state),
  outcome: tiktokTtVideoUnbindOutcome,
  verification: tiktokTtVideoUnbindVerification,
  observed: tiktokTtVideoUnbindObserved,
  // An unbind stops what an authorization allowed and spends nothing, so the budget/bid/status text match does not apply.
  exemptFromSpendTextMatch: true,
  // Every request this family claims is destructive: allow_deletion:false, the destructive tier and website approval apply.
  destructive: () => true,
});
