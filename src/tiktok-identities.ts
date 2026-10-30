import {assertNoMethodOverride, object} from './write-common.js';
import {normalizeAccount} from './account-id.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';

/**
 * TikTok custom identities, per API for Business v1.3 "Create an identity", "Get info about an identity" and
 * "Get info about images" (checked 2026-09-26). A CUSTOMIZED_USER identity supplies the display name and avatar
 * of non-Spark ads; creating one starts no delivery and spends nothing. TikTok-account identities (AUTH_CODE, TT_USER,
 * BC_AUTH_TT) are outside this contract; deleting an unused custom identity is tiktok_deletions (src/tiktok-deletions.ts).
 */
export const tiktokIdentityPath = '/v1.3/identity/create/',
  tiktokImageInfoPath = '/v1.3/file/image/ad/info/';
// The same image ID shape the media workflow accepts from /file/image/ad/upload/.
const imageId = /^[A-Za-z0-9_\/-]{1,512}$/;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

export const tiktokIdentityKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokIdentityPath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_IDENTITY', message, {field});
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokIdentity(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(k => !['advertiser_id', 'display_name', 'image_uri'].includes(k));
  if (extra) invalid(extra, '"' + extra + '" is outside the qualified identity contract.');
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if (typeof body.display_name !== 'string' || !body.display_name.trim())
    invalid('display_name', 'display_name must be nonempty text.');
  if ([...body.display_name].length > 100)
    invalid('display_name', 'display_name has a documented maximum of 100 characters.');
  if (body.image_uri !== undefined && (typeof body.image_uri !== 'string' || !imageId.test(body.image_uri)))
    invalid('image_uri', 'image_uri must be a TikTok image ID from /file/image/ad/upload/.');
}

/** The avatar, when given, is read from the advertiser's asset library before review and before execution. */
export function tiktokIdentityImage(plan: CompiledRequest): string | undefined {
  const image = obj(plan.body) ? plan.body.image_uri : undefined;
  return typeof image === 'string' ? image : undefined;
}

/** An avatar must be in this advertiser's library and square, as the create documentation requires. */
export function tiktokIdentityImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const image = tiktokIdentityImage(plan);
  let avatar: JsonObject | null = null;
  if (image !== undefined) {
    const rows = state
      .flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : []))
      .filter((r: JsonObject) => r?.image_id === image);
    if (rows.length !== 1)
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        "The avatar image is not in the selected advertiser's asset library.",
        {image_uri: image},
      );
    const {width, height} = rows[0];
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || width !== height)
      invalid('image_uri', 'The avatar image must be square (1:1); TikTok reports ' + width + '×' + height + '.');
    avatar = {image_id: image, width, height};
  }
  return {
    provider: 'tiktok',
    effect:
      'Creates a custom identity (display name and avatar) that new ads can reference. It starts no delivery and cannot be edited through this contract.',
    identity_type: 'CUSTOMIZED_USER',
    display_name: (plan.body as JsonObject).display_name,
    avatar,
    source: 'https://business-api.tiktok.com/portal/docs/create-an-identity/v1.3',
  };
}

/** Review evidence keeps stable image facts; the signed image_url expires within an hour. */
export function tiktokImageState(data: JsonObject): JsonObject {
  return {
    list: (Array.isArray(data.data?.list) ? data.data.list : []).map((r: JsonObject) => ({
      image_id: r?.image_id,
      width: r?.width,
      height: r?.height,
      signature: r?.signature,
    })),
  };
}

/**
 * Identity info returns the display name and type. It reports the avatar only as a derived profile_image_url,
 * never the image ID that was sent, so image_uri is listed as unobservable rather than compared.
 */
export function tiktokIdentityVerification(
  plan: CompiledRequest,
  result: JsonObject,
): {path: string; query: JsonObject; expected: JsonObject; id: string; unobservable?: string[]}[] {
  const id = obj(result.data) && obj(result.data.data) ? result.data.data.identity_id : undefined;
  if (typeof id !== 'string' || !id) return [];
  const b = plan.body as JsonObject;
  return [
    {
      path: '/v1.3/identity/info/',
      query: {advertiser_id: plan.accountId, identity_id: id, identity_type: 'CUSTOMIZED_USER'},
      expected: {identity_id: id, identity_type: 'CUSTOMIZED_USER', display_name: b.display_name},
      id,
      ...(b.image_uri !== undefined ? {unobservable: ['image_uri']} : {}),
    },
  ];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokIdentityFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_identities',
  files: ['src/tiktok-identities.ts', ['tests/tiktok-identities.test.mjs']],
  kind: tiktokIdentityKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokIdentity(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) => {
    const id = normalizeAccount(plan.gateway, plan.accountId!);
    const reads = [stateRead('/v1.3/advertiser/info/', {advertiser_ids: [id]})],
      image = tiktokIdentityImage(plan);
    if (image !== undefined) {
      const read = stateRead(tiktokImageInfoPath, {advertiser_id: id, image_ids: [image]});
      read.action = 'tiktok_file_image_ad_info_get';
      reads.push(read);
    }
    return reads;
  },
  impact: tiktokIdentityImpact,
  verification: (plan, result, before, verificationRead) =>
    tiktokIdentityVerification(plan, result).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_identity_info_get'},
    })),
});
