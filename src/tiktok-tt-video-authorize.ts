import {MirrorError} from './errors.js';
import {assertNoMethodOverride, object, responseData} from './write-common.js';
import type {ReviewedFamily, VerificationRead} from './reviewed-family.js';
import type {TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';
import {
  authorizedState,
  isAuthorizedRead,
  lookupOf,
  lookupsOf,
  readAuthorized,
  ttVideoAuthorizePath,
  ttVideoAuthorizeSource,
  ttVideoListPath,
  validateAuthorizedState,
} from './tiktok-tt-video-list.js';
import type {Marked} from './tiktok-tt-video-list.js';

/**
 * Applying the authorization code of a creator's post to an advertiser (package r25-m4b-smartpush, matrix A2), per API for Business
 * v1.3 "Apply an authorization code" (read 2026-11-21): POST /v1.3/tt_video/authorize/ with `advertiser_id`, `auth_code` ("The
 * authorization code for the Spark Ads post") and, for a duet, a stitch or a post that mentions another video, `original_post_auth_code`
 * (at most one video); "Replace '+' in your authorization code with '%2B'. Otherwise, you may get an invalid authorization code
 * error"; the answer is `code`, `message`, `request_id` and an EMPTY `data`. "After you get the authorization code from the post owner,
 * the authorization is not automatically in effect. You need to apply the code to connect the ad account with the Spark Ads post": the
 * creator's own steps in the TikTok app (Ad settings, Ad authorization, a duration, generate the code) stay outside the API, and AMCP
 * cannot do them. The post then reads AUTHORIZED (`ad_auth_status`) in "Get Spark Ad posts" and is used by an ad as `identity_type`
 * AUTH_CODE with the creator's `identity_id` and the post's `tiktok_item_id` (src/tiktok-smart-plus-ads.ts).
 *
 * The code is secret-like (src/secret-fields.ts; `auth_code` and `original_post_auth_code` are in src/security.ts's secret names): the
 * review keeps the digest of each code and no code, the body it stores, shows and audits has only the advertiser, and execute takes the
 * codes again in `arguments.payload`, compares their digests with the reviewed ones and sends them, with "+" spelled "%2B". TikTok's
 * answer has no post, so the read-back is the advertiser's list of authorized posts, which carries each post's code: the post whose
 * code has the reviewed digest is found, and its ID, creator identity and authorization status are what the review's checks show
 * (src/tiktok-tt-video-list.ts). The same read at prepare refuses a code that is already applied. An authorization that was applied
 * cannot be taken back except by unbinding the post once the authorization has ended (src/tiktok-tt-video-unbind.ts).
 */
const fields = ['auth_code', 'original_post_auth_code'] as const;
const codeShape = /^\S{4,1024}$/;

export const tiktokTtVideoAuthorizeKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === ttVideoAuthorizePath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_TT_VIDEO_AUTHORIZATION', message, {field, source: ttVideoAuthorizeSource});
}

/**
 * Validates the request before review; nothing here reads or contacts TikTok. At prepare the body carries the codes, which are then held
 * (the review keeps their digests, `plan.heldSecrets`); at execute it is the stored one, whose codes are the digests.
 */
export function assertTiktokTtVideoAuthorize(p: CompiledRequest): void {
  const body = object(p.body),
    held = p.heldSecrets;
  const extra = Object.keys(body).find(k => k !== 'advertiser_id' && !(fields as readonly string[]).includes(k));
  if (extra) invalid(extra, '"' + extra + '" is outside the qualified Spark Ads authorization contract.');
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== p.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if (held) {
    // The plan as stored: the codes are held by their digests, and none is in the body.
    if (typeof held.auth_code !== 'string') invalid('auth_code', 'The reviewed request holds no authorization code.');
    return;
  }
  for (const name of fields) {
    const value = body[name];
    if (value === undefined && name === 'original_post_auth_code') continue;
    if (typeof value !== 'string' || !codeShape.test(value))
      invalid(
        name,
        name === 'auth_code'
          ? 'auth_code must be the authorization code the creator copied from TikTok: 4 to 1024 visible characters, no spaces.'
          : 'original_post_auth_code must be the authorization code of the original post: 4 to 1024 visible characters, no spaces.',
      );
  }
  if (body.original_post_auth_code !== undefined && body.original_post_auth_code === body.auth_code)
    invalid(
      'original_post_auth_code',
      'original_post_auth_code is the code of the other post a duet, stitch or mention uses, not of the post itself.',
    );
}

/** The one read of the review: the advertiser's authorized posts, looked through for the post whose code has the reviewed digest. */
export function tiktokTtVideoAuthorizeSnapshots(
  p: CompiledRequest,
  stateRead: (path: string, query?: JsonObject) => CompiledRequest,
): CompiledRequest[] {
  const read: Marked = stateRead(ttVideoListPath, {advertiser_id: p.accountId});
  read.action = 'tiktok_tt_video_list_get';
  // The read is the lookup of this code's digest; it carries no code and none of the plan's other digests.
  read.tiktokAuthorized = {role: 'code', digest: p.heldSecrets?.auth_code ?? ''};
  read.heldSecrets = undefined;
  return [read];
}

/** A code that is already applied is refused at prepare, and again at execute on the state read then. */
export function tiktokTtVideoAuthorizePrerequisites(_p: CompiledRequest, state: unknown[]): void {
  const found = lookupsOf(state, 'code').find(s => s.found === true);
  if (!found) return;
  const post = object(found.post);
  invalid(
    'auth_code',
    'This authorization code is already applied to the advertiser: its post ' +
      String(post.item_id) +
      ' is in the advertiser’s authorized posts' +
      (typeof post.ad_auth_status === 'string' ? ' (authorization status ' + post.ad_auth_status + ')' : '') +
      '. Applying it again would change nothing; ask the creator for a new code if the authorization has ended.',
  );
}

const authorizeEffect =
  'Applies the creator’s authorization code to this advertiser: the post becomes usable in Spark Ads as an authorization-code identity (identity_type AUTH_CODE) for as long as the authorization lasts. Nothing is created in a campaign. AMCP cannot undo it; a post whose authorization has ended is unbound with its own reviewed write.';
const creatorStep =
  'The creator generates the code in the TikTok app (Ad settings, Ad authorization, a duration): that step is outside the API, and so is the authorization’s end.';
export function tiktokTtVideoAuthorizeImpact(p: CompiledRequest): JsonObject {
  const held = p.heldSecrets ?? {};
  return {
    provider: 'tiktok',
    scope: 'spark_ads_authorization',
    operation: 'apply',
    may_affect_serving: false,
    effect: authorizeEffect,
    authorization_code: {
      shown: false,
      meaning: 'The review keeps only a digest of the code, and execute takes the code again in arguments.payload.',
    },
    original_post: held.original_post_auth_code !== undefined,
    creator_step: creatorStep,
    verification:
      'Reads the advertiser’s authorized posts and looks for the post whose code matches the digest; it shows the post’s ID, its creator identity and its authorization status.',
    source: ttVideoAuthorizeSource,
  };
}

/** TikTok's answer is `code` 0 and an empty `data`; anything else is a partial outcome. */
export function tiktokTtVideoAuthorizeOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return responseData(r).code === 0;
}

/** The read-back: the lookup again, expecting the post whose code has the reviewed digest. */
export function tiktokTtVideoAuthorizeVerification(
  p: CompiledRequest,
  _result: JsonObject,
  _before: unknown[],
  verificationRead: (path: string, query?: JsonObject) => CompiledRequest,
): VerificationRead[] {
  const read: Marked = {
    ...verificationRead(ttVideoListPath, {advertiser_id: p.accountId}),
    action: 'tiktok_tt_video_list_get',
    tiktokAuthorized: {role: 'code', digest: p.heldSecrets?.auth_code ?? ''},
    heldSecrets: undefined,
  };
  // The post the code authorized is what the person needs next: its ID and its creator's identity are what an ad names (identity_type
  // AUTH_CODE, identity_id, tiktok_item_id). They are shown in the check beside the comparison and are never compared.
  const observe = (actual: unknown): JsonObject | undefined => {
    const {authorized, ...post} = object(actual);
    return authorized === true ? {authorized_post: post} : undefined;
  };
  return [{read, expected: {authorized: true}, id: 'authorization', observe}];
}
export function tiktokTtVideoAuthorizeObserved(
  read: CompiledRequest,
  data: JsonObject,
  gatewayObserved: () => JsonObject,
) {
  if (!lookupOf(read)) return gatewayObserved();
  const s = object(data.tiktok_tt_video_authorizations),
    post = object(s.post);
  return {
    authorized: s.found === true ? true : s.complete === true ? false : null,
    ...(s.found === true ? post : {}),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokTtVideoAuthorizeFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_tt_video_authorizations',
  files: [
    'src/tiktok-tt-video-authorize.ts / src/tiktok-tt-video-list.ts',
    ['tests/tiktok-tt-video-authorize.test.mjs'],
  ],
  kind: tiktokTtVideoAuthorizeKind,
  assert: (plan, gatewayChecks) => {
    assertNoMethodOverride(plan);
    gatewayChecks();
    assertTiktokTtVideoAuthorize(plan);
  },
  secretFields: {fields, wire: value => value.replaceAll('+', '%2B')},
  snapshots: tiktokTtVideoAuthorizeSnapshots,
  isRead: read => isAuthorizedRead(read, 'code'),
  reader: readAuthorized,
  validateState: (read, result) => validateAuthorizedState(read, result),
  snapshotState: (read, data) => authorizedState(read, data),
  prerequisites: tiktokTtVideoAuthorizePrerequisites,
  impact: plan => tiktokTtVideoAuthorizeImpact(plan),
  outcome: tiktokTtVideoAuthorizeOutcome,
  verification: tiktokTtVideoAuthorizeVerification,
  observed: tiktokTtVideoAuthorizeObserved,
  // An authorization spends nothing and changes no budget, bid or status: the text match of the spend rule does not apply.
  exemptFromSpendTextMatch: true,
});
