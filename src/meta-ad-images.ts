import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {fail, stateReadOf} from './family-kit.js';

/**
 * Deleting ad images from a Meta ad account's library, Marketing API v25.0 ("Ad Image" reference, Deleting; checked
 * 2026-09-27): DELETE act_{ad_account_id}/adimages with the image `hash` answers {success}. "You can only delete ad images
 * not currently being used in an ad creative", so Meta refuses images in use; that reply is a failure never resubmitted.
 * An image reads with status ACTIVE, INTERNAL or DELETED; the list takes `hashes`.
 */
type Read = CompiledRequest & {metaImageState?: {hash: string; optional?: boolean}};
const gateway = 'meta_native_action',
  hashPattern = /^[0-9a-f]{32}$/;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
function invalid(message: string): never {
  return fail('INVALID_META_AD_IMAGE', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function metaImageKind(p: CompiledRequest): 'delete' | undefined {
  if (p.gateway !== gateway || (p.origin && p.origin !== 'https://graph.facebook.com') || p.specialTransport) return;
  return p.method === 'DELETE' && metaRoute('act_[1-9][0-9]{0,31}/adimages$').test(p.path) ? 'delete' : undefined;
}
const hashOf = (p: CompiledRequest) => String(p.query.hash);
export function assertMetaImage(p: CompiledRequest): void {
  if (!metaImageKind(p)) return;
  if (account(p.path.split('/')[2]) !== account(p.accountId))
    fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected ad account.', {}, 403);
  if (Object.keys(p.headers).length || (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length)))
    invalid('Image deletion takes only the hash, without a body or header overrides.');
  const extra = Object.keys(p.query).filter(k => k !== 'hash');
  if (extra.length) invalid('Image deletion takes only hash; unqualified parameters: ' + extra.join(', ') + '.');
  if (typeof p.query.hash !== 'string' || !hashPattern.test(p.query.hash))
    invalid('hash is the 32-character image hash from the ad account library.');
}
export function assertMetaImageScope(c: Connection, write = false): void {
  if (write ? !c.scopes.includes('ads_management') : !c.scopes.some(s => s === 'ads_management' || s === 'ads_read'))
    fail('INSUFFICIENT_SCOPE', 'Reconnect Meta with ads_management to delete ad images.', {}, 403);
}
const read = (p: CompiledRequest, hash: string, optional = false): Read =>
  stateReadOf<Read>(
    p,
    'AMCP_META_IMAGE_READ',
    metaPrefix + 'act_' + account(p.accountId) + '/adimages',
    {hashes: JSON.stringify([hash]), fields: 'hash,id,name,status,account_id,created_time'},
    {metaImageState: {hash, optional}},
  );
export function metaImageSnapshots(p: CompiledRequest): Read[] {
  return [read(p, hashOf(p))];
}
export function isMetaImageRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).metaImageState;
}
/** The image by hash in the account library; absent or DELETED reads as gone. */
export async function readMetaImage(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaImageState;
  if (!s) return fetch(p);
  const r = await fetch({...(p as Read), metaImageState: undefined} as Read),
    d = r.data;
  if (r.status !== 200 || !object(d) || !Array.isArray(d.data)) unverified('Meta did not list the ad images.');
  // Another page could hold the image: an image missing from this page is not gone (nor absent from the library).
  // Deliberately stricter than that case: the read names one hash, so a next page is unexpected even when this page
  // holds the image, and a later page could list the same hash again (refused below when it is on one page). The
  // review fails closed and is prepared again rather than trusting part of the answer.
  if (object(d.paging) && d.paging.next) unverified('Meta listed the ad images on more than one page.');
  const rows = (d.data as unknown[]).filter(x => object(x) && x.hash === s.hash) as JsonObject[];
  if (rows.length > 1) unverified('Meta listed image ' + s.hash + ' more than once.');
  const row = rows[0];
  if (row && row.account_id !== undefined && account(row.account_id) !== account(p.accountId))
    fail('STATE_TARGET_MISMATCH', 'Meta listed an image of another ad account.', {}, 409);
  const image = row
    ? {
        present: true,
        hash: s.hash,
        id: row.id ?? null,
        name: row.name ?? null,
        status: row.status ?? null,
        gone: row.status === 'DELETED',
      }
    : {present: false, hash: s.hash, gone: true};
  return {status: 200, headers: {}, data: {account_id: account(p.accountId), image}};
}
export function validateMetaImageState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data;
  if (!(p as Read).metaImageState || r.status !== 200 || !object(d) || !object(d.image))
    unverified('Missing verified ad image state.');
}
export function metaImagePrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!metaImageKind(p)) return;
  const s = states[0],
    image = object(s) && object(s.image) ? s.image : undefined;
  if (!image) unverified('Missing verified ad image state.');
  if (image.present !== true)
    fail('STATE_NOT_FOUND', 'Image ' + hashOf(p) + ' is not in the library of the selected ad account.', {
      hash: hashOf(p),
    });
  if (image.gone === true) invalid('Image ' + hashOf(p) + ' is already deleted.');
}
export function metaImageImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!metaImageKind(p)) return;
  const first = state[0],
    image = object(first) && object(first.image) ? first.image : null;
  return {
    provider: 'meta',
    scope: 'ad_image',
    operation: 'delete',
    image,
    may_affect_serving: false,
    effect:
      'Deletes the image from the ad account library. Meta refuses images that an ad creative still uses; existing ads are not changed.',
    verification: 'Lists the image by hash again and expects it to be gone or DELETED.',
    source: 'https://developers.facebook.com/docs/marketing-api/reference/ad-image/',
  };
}
export function metaImageOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && object(r.data) && r.data.success === true;
}
export function metaImageVerification(p: CompiledRequest): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  return [{read: read(p, hashOf(p), true), expected: {image: {gone: true}}, id: 'ad image ' + hashOf(p)}];
}
export function metaImageObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {image: object(data.image) ? data.image : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaImageFamily: ReviewedFamily = {
  name: 'meta_ad_images',
  files: ['src/meta-ad-images.ts', ['tests/meta-ad-images.test.mjs']],
  kind: metaImageKind,
  assert: assertMetaImage,
  scope: assertMetaImageScope,
  snapshots: metaImageSnapshots,
  isRead: isMetaImageRead,
  reader: readMetaImage,
  validateState: validateMetaImageState,
  prerequisites: metaImagePrerequisites,
  impact: metaImageImpact,
  outcome: metaImageOutcome,
  verification: metaImageVerification,
  observed: metaImageObserved,
  exemptFromSpendTextMatch: true,
};
