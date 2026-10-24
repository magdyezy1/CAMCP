import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {defineFamily, fail, readOf} from './family-kit.js';

/**
 * Claiming an organic Snap into an ad account, per Snap's "Claim Media" page (read 2026-09-30): POST
 * /v1/adaccounts/{ad_account_id}/claim_media_by_snap_reference?snap_id={snap_id} answers a `media_entity_id`; "Callers
 * must have permissions to both the target ad account and Snap"; GET /v1/media/{media_id} shows the claimed media, with
 * media_status READY once it can be used (PENDING_UPLOAD before). The captured catalog names the route twice. Claiming by
 * ad code stays blocked with its reason (src/withheld-writes.ts).
 */
type Read = CompiledRequest & {snapchatClaimPage?: true; snapchatClaimState?: true; snapchatClaimCheck?: string};
const route = /^\/v1\/adaccounts\/([\w-]+)\/claim_media_by_snap_reference$/,
  snapId = /^[A-Za-z0-9_-]{16,200}$/,
  mediaId = /^[\w-]{1,64}$/,
  marker = 'AMCP_SNAPCHAT_CLAIM_MEDIA_READ',
  source = 'https://developers.snap.com/marketing-api/Ads-API/claim-media';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_CLAIM_MEDIA', message, {source});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapchatClaimMediaKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'snapchat_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://adsapi.snapchat.com') &&
    [
      'snapchat_adaccounts_ad_account_id_claim_media_by_snap_reference_create',
      'snapchat_adaccounts_ad_account_id_claim_media_by_snap_reference_create_2',
    ].includes(p.action) &&
    route.test(p.path)
  );
}
const account = (p: CompiledRequest) => route.exec(p.path)![1]!;
/** Only the Snap ID, in the query as Snap documents it; no body. */
export function assertSnapchatClaimMedia(p: CompiledRequest): void {
  if (!snapchatClaimMediaKind(p)) return;
  assertNoMethodOverride(p);
  if (account(p) !== p.accountId) fail('ACCOUNT_SCOPE_MISMATCH', 'Claim into the selected ad account.', {}, 403);
  if (Object.keys(p.query).join() !== 'snap_id' || typeof p.query.snap_id !== 'string' || !snapId.test(p.query.snap_id))
    invalid('Name the Snap with snap_id (letters, digits, _ and -), and nothing else.');
  if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length))
    invalid('A claim takes the Snap ID only; send no payload.');
  if (Object.keys(p.headers).length) invalid('A claim takes no header overrides.');
}
function read(p: CompiledRequest, path: string): Read {
  return readOf<Read>(
    p,
    {action: marker, path, query: {}, clears: ['responseControls']},
    {snapchatClaimPage: true, snapchatClaimState: undefined, snapchatClaimCheck: undefined},
  );
}
export function snapchatClaimMediaSnapshots(p: CompiledRequest): Read[] {
  return [{...read(p, '/v1/adaccounts/' + account(p)), snapchatClaimState: true}];
}
export function isSnapchatClaimMediaRead(p: CompiledRequest): p is Read {
  return !!(p as Read).snapchatClaimState || !!(p as Read).snapchatClaimCheck;
}
/** The family's reads: the selected ad account, and the media the claim created. */
export function authorizeSnapchatClaimMedia(p: CompiledRequest, _c: Connection, selected: string): boolean {
  if (p.gateway !== 'snapchat_native_action' || p.action !== marker) return false;
  const r = p as Read;
  if (
    !r.snapchatClaimPage ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    Object.keys(p.query).length ||
    p.accountId !== selected
  )
    return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal claim read.', {}, 403);
  if (p.path === '/v1/adaccounts/' + selected) return true;
  if (r.snapchatClaimCheck && p.path === '/v1/media/' + r.snapchatClaimCheck) return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal claim read.', {}, 403);
}
function single(d: unknown, key: string, entity: string, wanted: string, label: string): JsonObject {
  if (
    !object(d) ||
    String(d.request_status).toUpperCase() !== 'SUCCESS' ||
    !Array.isArray(d[key]) ||
    d[key].length !== 1
  )
    unverified('Snapchat did not return ' + label + '.');
  const row = (d[key] as JsonObject[])[0]!,
    e = object(row) ? row[entity] : undefined;
  if (String(row?.sub_request_status).toUpperCase() !== 'SUCCESS' || !object(e) || e.id !== wanted)
    unverified('Snapchat did not return ' + label + '.');
  return e as JsonObject;
}
export async function readSnapchatClaimMedia(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  if (!(p as Read).snapchatClaimState) return request(p);
  const id = p.path.split('/')[3]!,
    a = single((await request(read(p, p.path))).data, 'adaccounts', 'adaccount', id, 'ad account ' + id);
  return {status: 200, headers: {}, data: {id, name: a.name ?? null, organization_id: a.organization_id ?? null}};
}
export function validateSnapchatClaimMediaState(p: CompiledRequest, r: TransportResult): void {
  if (!(p as Read).snapchatClaimState || r.status !== 200 || !object(r.data) || r.data.id !== p.accountId)
    unverified('Missing verified ad account state.');
}
export function snapchatClaimMediaImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const a = object(state[0]) ? state[0] : {};
  return {
    provider: 'snapchat',
    scope: 'claim_media',
    ad_account: {id: account(p), name: a.name ?? null},
    snap_id: p.query.snap_id,
    effect:
      'Claims the Snap into the media library of the selected ad account under a new media ID. Nothing serves until a creative uses it.',
    access: 'Snap refuses the claim unless this login can reach both the ad account and the Snap’s profile.',
    readiness: 'The media can be used once its media_status is READY; before that it is PENDING_UPLOAD.',
    verification: 'Reads the new media and checks that it belongs to the selected ad account.',
    source,
  };
}
const claimed = (d: unknown) =>
  object(d) &&
  String(d.request_status).toUpperCase() === 'SUCCESS' &&
  typeof d.media_entity_id === 'string' &&
  mediaId.test(d.media_entity_id)
    ? d.media_entity_id
    : undefined;
export function snapchatClaimMediaOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && !!claimed(r.data);
}
export function snapchatClaimMediaVerification(p: CompiledRequest, result: JsonObject) {
  const id = claimed(result.data);
  if (!id) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no claimed media.');
  return [
    {
      read: {...read(p, '/v1/media/' + id), snapchatClaimCheck: id} as Read,
      expected: {media: {id, ad_account_id: account(p)}},
      id: 'media ' + id,
    },
  ];
}
export function snapchatClaimMediaObserved(r: CompiledRequest, data: JsonObject): JsonObject {
  const row = Array.isArray(data.media) && data.media.length === 1 && object(data.media[0]) ? data.media[0] : {},
    m = object(row.media) ? row.media : {};
  return {
    media:
      m.id === (r as Read).snapchatClaimCheck && String(row.sub_request_status).toUpperCase() === 'SUCCESS'
        ? {id: m.id, ad_account_id: m.ad_account_id ?? null, media_status: m.media_status ?? null}
        : null,
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const snapchatClaimMediaFamily: ReviewedFamily = defineFamily({
  name: 'snapchat_claim_media',
  files: ['src/snapchat-claim-media.ts', ['tests/snapchat-claim-media.test.mjs']],
  kind: snapchatClaimMediaKind,
  assert: plan => assertSnapchatClaimMedia(plan),
  authorize: authorizeSnapchatClaimMedia,
  snapshots: snapchatClaimMediaSnapshots,
  isRead: isSnapchatClaimMediaRead,
  reader: (r, next) => readSnapchatClaimMedia(r, next),
  validateState: (r, result, gateway) =>
    (r as Read).snapchatClaimState ? validateSnapchatClaimMediaState(r, result) : gateway(),
  snapshotState: (r, data, gateway) => ((r as Read).snapchatClaimState ? data : gateway()),
  impact: snapchatClaimMediaImpact,
  outcome: snapchatClaimMediaOutcome,
  verification: snapchatClaimMediaVerification,
  observed: (r, data, gateway) =>
    data.amcp_absent !== true && (r as Read).snapchatClaimCheck ? snapchatClaimMediaObserved(r, data) : gateway(),
  created: (_plan, response) => {
    const id = claimed(response);
    return id ? ['media/' + id] : [];
  },
  exemptFromSpendTextMatch: true,
  exemptFromActivationScan: true,
  activates: () => false,
  destructive: () => false,
});
