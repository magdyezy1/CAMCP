import {MirrorError} from './errors.js';
import {stable} from './security.js';
import {validateDiscoveryBody} from './discovery-body.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {pinnedJson} from './pinned-json.js';

/**
 * YouTube video ad assets of DV360 advertisers on Display & Video 360 API v4, per the pinned Discovery document (AdAsset,
 * adAssets.create, bulkCreate, get and list) and "Create ad assets" of the Demand Gen guide (checked 2026-09-27).
 * - Demand Gen ads reference ad assets by ID. YouTube video assets are created from a YouTube video ID; image assets are
 *   uploaded as media (not qualified here) and the API does not read them back.
 * - An optional attestation labels an asset as created or edited with AI where local rules require it.
 * - An asset serves nothing on its own.
 */
const origin = 'https://displayvideo.googleapis.com';
const single = /^\/v4\/advertisers\/([1-9]\d*)\/adAssets$/,
  bulk = /^\/v4\/advertisers\/([1-9]\d*)\/adAssets:bulkCreate$/;
const maxAssets = 25,
  attestations = ['NOT_SYNTHETIC', 'IS_SYNTHETIC'],
  gone = ['ENTITY_STATUS_ARCHIVED', 'ENTITY_STATUS_SCHEDULED_FOR_DELETION'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown) => /^[1-9]\d*$/.test(String(v ?? ''));
/** The 11-character ID of a YouTube video URL. */
const video = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v);
const models = (): Record<string, JsonObject> => pinnedJson('.mirror/VENDOR/dv360-v4.json').document.schemas;
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_DV360_AD_ASSET', message);
}

export function dv360AdAssetKind(p: CompiledRequest): 'create' | 'bulk' | undefined {
  if (
    p.gateway !== 'dv360_native_action' ||
    (p.origin !== undefined && p.origin !== origin) ||
    p.specialTransport ||
    p.method !== 'POST'
  )
    return;
  if (single.test(p.path)) return 'create';
  if (bulk.test(p.path)) return 'bulk';
  return;
}
const advertiserOf = (p: CompiledRequest) => p.path.split('/')[3]!.split(':')[0]!;
const assets = (p: CompiledRequest): JsonObject[] =>
  dv360AdAssetKind(p) === 'create' ? [(p.body as JsonObject).adAsset] : (p.body as JsonObject).adAssets;
const videoOf = (a: JsonObject): string => a.youtubeVideoAsset.youtubeVideoId;

export function assertDV360AdAsset(p: CompiledRequest): void {
  const kind = dv360AdAssetKind(p);
  if (!kind) return;
  if (advertiserOf(p) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The request must use the selected advertiser.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Ad asset requests take no query or header overrides.');
  const b = p.body;
  if (!obj(b)) invalid('Provide the native request object.');
  validateDiscoveryBody(kind === 'create' ? 'CreateAdAssetRequest' : 'BulkCreateAdAssetsRequest', models(), b, true);
  if (kind === 'create' && (Object.keys(b).length !== 1 || !obj(b.adAsset))) invalid('Creation takes {adAsset}.');
  if (
    kind === 'bulk' &&
    (Object.keys(b).length !== 1 || !Array.isArray(b.adAssets) || !b.adAssets.length || b.adAssets.length > maxAssets)
  )
    invalid('Bulk creation takes {adAssets} with 1 to ' + maxAssets + ' assets.');
  const seen = new Set<string>();
  for (const a of assets(p)) {
    if (
      !obj(a) ||
      Object.keys(a).some(k => !['adAssetType', 'youtubeVideoAsset', 'syntheticContentAttestationStatus'].includes(k))
    )
      invalid(
        'An ad asset sets adAssetType, youtubeVideoAsset and optionally syntheticContentAttestationStatus; IDs, names and status are assigned by DV360.',
      );
    if (a.adAssetType !== 'AD_ASSET_TYPE_YOUTUBE_VIDEO')
      invalid(
        'Only YouTube video assets are created this way; image assets are uploaded as media, which is not qualified.',
      );
    if (
      !obj(a.youtubeVideoAsset) ||
      Object.keys(a.youtubeVideoAsset).some(k => k !== 'youtubeVideoId') ||
      !video(a.youtubeVideoAsset.youtubeVideoId)
    )
      invalid('youtubeVideoAsset.youtubeVideoId is the 11-character ID of the YouTube video URL.');
    if (
      a.syntheticContentAttestationStatus !== undefined &&
      !attestations.includes(a.syntheticContentAttestationStatus)
    )
      invalid('syntheticContentAttestationStatus is NOT_SYNTHETIC or IS_SYNTHETIC.');
    if (seen.has(videoOf(a))) invalid('YouTube video ' + videoOf(a) + ' is listed twice.');
    seen.add(videoOf(a));
  }
}

const read = (p: CompiledRequest, path: string, query: JsonObject): CompiledRequest => ({
  ...p,
  action: 'AMCP_DV360_AD_ASSET_READ',
  method: 'GET',
  path,
  query,
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  queryArrayEncoding: undefined,
  dv360AdAssetState: undefined,
});
/** One filtered read per video: the advertiser's ad assets of that YouTube video. */
export function dv360AdAssetReads(p: CompiledRequest): CompiledRequest[] {
  return assets(p).map(a => ({
    ...read(p, '/v4/advertisers/' + advertiserOf(p) + '/adAssets', {
      filter: 'youtubeVideoAsset.youtubeVideoId="' + videoOf(a) + '"',
      pageSize: 100,
    }),
    dv360AdAssetState: {youtubeVideoId: videoOf(a)},
  }));
}
export function isDV360AdAssetRead(p: CompiledRequest): boolean {
  return p.gateway === 'dv360_native_action' && !!p.dv360AdAssetState;
}
export function validateDV360AdAssetState(read: CompiledRequest, r: TransportResult): void {
  const d = r.data,
    v = read.dv360AdAssetState!.youtubeVideoId;
  if (
    r.status !== 200 ||
    !obj(d) ||
    d.error ||
    d.nextPageToken ||
    (d.adAssets !== undefined && !Array.isArray(d.adAssets))
  )
    fail('INCOMPLETE_STATE', 'DV360 did not return the ad assets of YouTube video ' + v + ' in one page.', {}, 502);
  for (const a of d.adAssets ?? [])
    if (
      !obj(a) ||
      !obj(a.youtubeVideoAsset) ||
      a.youtubeVideoAsset.youtubeVideoId !== v ||
      !numeric(a.adAssetId) ||
      a.adAssetType !== 'AD_ASSET_TYPE_YOUTUBE_VIDEO'
    )
      fail('STATE_TARGET_MISMATCH', 'DV360 returned a different ad asset for YouTube video ' + v + '.', {}, 409);
}
/** The review state: the video and its assets by ID and status. It accepts its own output. */
export function dv360AdAssetReviewState(read: CompiledRequest, d: JsonObject): JsonObject {
  if (typeof d.youtubeVideoId === 'string' && Array.isArray(d.assets)) return d;
  return {
    youtubeVideoId: read.dv360AdAssetState!.youtubeVideoId,
    assets: (Array.isArray(d.adAssets) ? d.adAssets : [])
      .map((a: JsonObject) => ({adAssetId: String(a.adAssetId), entityStatus: a.entityStatus ?? null}))
      .sort((x: JsonObject, y: JsonObject) => (x.adAssetId < y.adAssetId ? -1 : x.adAssetId > y.adAssetId ? 1 : 0)),
  };
}
export function validateDV360AdAssetPrerequisites(plan: CompiledRequest, states: unknown[]): void {
  if (!dv360AdAssetKind(plan)) return;
  const existing = states.flatMap(s =>
    obj(s) && Array.isArray(s.assets)
      ? s.assets
          .filter((a: JsonObject) => !gone.includes(a.entityStatus))
          .map((a: JsonObject) => ({youtube_video_id: s.youtubeVideoId, ad_asset_id: a.adAssetId}))
      : [],
  );
  if (existing.length)
    fail(
      'CONFIGURATION_EXISTS',
      'These YouTube videos are already ad assets of the advertiser; reference the existing assets: ' +
        existing.map(e => e.youtube_video_id + ' (' + e.ad_asset_id + ')').join(', ') +
        '.',
      {assets: existing},
    );
}
export function dv360AdAssetImpact(plan: CompiledRequest): JsonObject | undefined {
  if (!dv360AdAssetKind(plan)) return;
  return {
    provider: 'dv360',
    scope: 'ad_assets',
    youtube_videos: assets(plan).map(a => ({
      youtube_video_id: videoOf(a),
      synthetic_content_attestation: a.syntheticContentAttestationStatus ?? null,
    })),
    may_affect_serving: false,
    effect: 'Creates YouTube video ad assets that Demand Gen ads can reference. An asset serves nothing on its own.',
    verification: 'Reads each new ad asset by ID and compares its type, video and attestation.',
    source: 'https://developers.google.com/display-video/api/guides/tasks/serve-demand-gen-ad/create-ad-assets',
  };
}
const created = (plan: CompiledRequest, d: unknown): JsonObject[] =>
  dv360AdAssetKind(plan) === 'create'
    ? obj(d)
      ? [d]
      : []
    : obj(d) && Array.isArray(d.adAssets)
      ? d.adAssets.filter(obj)
      : [];
export function dv360AdAssetOutcome(plan: CompiledRequest, r: TransportResult): boolean {
  if (r.status !== 200 || !obj(r.data) || r.data.error) return false;
  const made = created(plan, r.data),
    wanted = assets(plan).map(videoOf);
  return (
    made.length === wanted.length &&
    made.every(
      a => numeric(a.adAssetId) && a.adAssetType === 'AD_ASSET_TYPE_YOUTUBE_VIDEO' && obj(a.youtubeVideoAsset),
    ) &&
    stable(made.map(a => a.youtubeVideoAsset.youtubeVideoId).sort()) === stable([...wanted].sort())
  );
}
/** One read per new asset, by the ID in the receipt. */
export function dv360AdAssetVerification(
  plan: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const made = created(plan, result.data);
  return assets(plan).map(a => {
    const v = videoOf(a),
      c = made.find(x => obj(x.youtubeVideoAsset) && x.youtubeVideoAsset.youtubeVideoId === v),
      id = String(c?.adAssetId ?? '');
    if (!numeric(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no ad asset for YouTube video ' + v + '.');
    return {
      read: read(plan, '/v4/advertisers/' + advertiserOf(plan) + '/adAssets/' + id, {}),
      expected: {
        adAssetId: id,
        adAssetType: 'AD_ASSET_TYPE_YOUTUBE_VIDEO',
        youtubeVideoAsset: {youtubeVideoId: v},
        ...(a.syntheticContentAttestationStatus
          ? {syntheticContentAttestationStatus: a.syntheticContentAttestationStatus}
          : {}),
      },
      id: 'ad asset ' + id,
    };
  });
}
