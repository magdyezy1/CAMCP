import {MirrorError} from './errors.js';
import {driveDownloadUrl, downloadDriveMedia, MAX_MEDIA_BYTES} from './drive-media.js';
import {mediaLinkUrl} from './media-link.js';
import {createHash} from 'node:crypto';
import type {ContractProfile} from './contract-profile.js';
import {stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';

export const mediaPlatforms = ['meta', 'tiktok', 'snapchat', 'google_ads', 'linkedin', 'x_ads', 'dv360'];
/** How each media platform is named to people. */
export const mediaPlatformNames: Readonly<Record<string, string>> = Object.freeze({
  meta: 'Meta',
  tiktok: 'TikTok',
  snapchat: 'Snapchat',
  google_ads: 'Google Ads',
  linkedin: 'LinkedIn',
  x_ads: 'X',
  dv360: 'Display & Video 360',
});
/** The largest image amcp_media uploads to each platform; a DV360 Demand Gen ad asset takes up to 5120 KB. */
export function mediaImageLimit(platform: string, adAsset = false): number {
  if (platform === 'google_ads') return 5 * 1024 * 1024;
  if (platform === 'meta') return 30 * 1024 * 1024;
  if (platform === 'linkedin') return 20 * 1024 * 1024;
  if (platform === 'dv360') return adAsset ? 5120 * 1024 : 10 * 1024 * 1024;
  return 5 * 1024 * 1024;
}
/** Platforms that take video only as MP4. */
export const mp4OnlyPlatforms: readonly string[] = ['x_ads', 'linkedin'];
export const mediaInstructions =
  'AMCP server-side media imports: never download media in the MCP client. Put a public HTTPS link or a Google Drive share link in payload.url on a native upload action (a file uploaded on the AMCP website goes through amcp_media with its source_id), or use amcp_native_action platform_media_upload with action UPLOAD_FROM_URL. amcp_write prepare returns the frozen upload review; amcp_write execute accepts it. A native dry_run:false import prepares only; follow its returned next_call after review. Meta creative creation is supported. Returned image hashes, video IDs, URNs and asset resource names can be used in creative/ad payloads. Missing Page IDs, destinations and account write grants remain explicit prerequisites.';
/**
 * The instructions the help of a native upload gives a client of one contract profile. Under v2 (V2-MCP-06) a native import
 * with dry_run:false saves nothing and is refused with MEDIA_REVIEW_REQUIRED, so the sentence that says it prepares the review
 * is replaced by what it does; the listing's own text (mediaInstructions) is legacy's and is not changed.
 */
const nativeImportLegacy = 'A native dry_run:false import prepares only; follow its returned next_call after review.',
  nativeImportV2 =
    'Under the v2 contract profile a native dry_run:false import saves nothing: it is refused with MEDIA_REVIEW_REQUIRED, and its next_call, amcp_media prepare for the same file, prepares the review to follow.';
export const mediaInstructionsFor = (profile: ContractProfile): string =>
  profile === 'v2' ? mediaInstructions.replace(nativeImportLegacy, nativeImportV2) : mediaInstructions;
export function mediaDiscovery(gateway?: string, profile: ContractProfile = 'legacy'): JsonObject | undefined {
  if (!gateway) return;
  if (gateway !== 'amcp_native_action' && !mediaPlatforms.includes(gateway.replace(/_native_action$/, ''))) return;
  return {
    instructions: mediaInstructionsFor(profile),
    platforms: mediaPlatforms,
    source:
      'A file uploaded on the AMCP website (source_id), a public HTTPS link, a public Drive URL, or a private file selected in a separate Drive connection',
    client_download_required: false,
    maximum_bytes: MAX_MEDIA_BYTES,
    review_tool: 'amcp_write',
    workflow_actions: [
      'UPLOAD_FROM_URL',
      'UPLOAD_FROM_URL_VIA_SESSION',
      'QUEUE_GOOGLE_DRIVE_IMPORT',
      'FINALIZE_UPLOAD_SESSION',
    ],
    limitations: [
      'One selected account per review',
      'Private files require drive_connection_id and a selected Drive file; folders are not imported',
      'Provider dimensions, duration, codecs, permissions and app approvals still apply',
      'Google videos create UNLISTED videos on the account Google-managed YouTube channel',
      'LinkedIn organization/person owners require an exact administrator resource binding',
      'DV360 uploads creative assets by default; dv360_target ad_asset uploads a Demand Gen image ad asset (up to 5120 KB), which the API cannot read back',
      'Binary upload APIs for other catalog providers are not implemented',
    ],
  };
}
export function mediaPlatform(value: unknown): string {
  const p =
    ({google: 'google_ads', x: 'x_ads', twitter: 'x_ads'} as Record<string, string>)[String(value)] ?? String(value);
  if (!mediaPlatforms.includes(p))
    throw new MirrorError(
      'MEDIA_PLATFORM_UNSUPPORTED',
      'This platform has no qualified binary advertising-media upload API in AMCP.',
      {supported_platforms: mediaPlatforms},
    );
  return p;
}
export function mediaRoute(
  plan: CompiledRequest,
): {platform: string; media_type?: string; existing_media_id?: string; dv360_target?: string} | undefined {
  if (plan.method !== 'POST') return;
  const path = plan.path,
    p = plan.gateway.replace(/_native_action$/, '');
  if (p === 'meta' && /^\/v\d+\.0\/act_[^/]+\/ad(images|videos)$/.test(path))
    return {platform: p, media_type: path.endsWith('adimages') ? 'image' : 'video'};
  if (p === 'tiktok' && /^\/v1\.3\/file\/(image|video)\/ad\/upload\/$/.test(path))
    return {platform: p, media_type: path.includes('/image/') ? 'image' : 'video'};
  if (p === 'snapchat') {
    const existing = /^\/v1\/media\/([\w-]+)\/upload$/.exec(path);
    if (existing) return {platform: p, existing_media_id: existing[1]};
    // The chunked upload of an existing allocation; AMCP performs INIT, ADD and FINALIZE itself.
    const chunked = /^\/(?:us\/)?v1\/media\/([\w-]+)\/multipart-upload-v2$/.exec(path);
    if (chunked && plan.query.action === 'INIT') return {platform: p, existing_media_id: chunked[1]};
    if (/^\/v1\/adaccounts\/[^/]+\/media$/.test(path)) return {platform: p};
  }
  if (p === 'x_ads' && path === '/1.1/media/upload.json') return {platform: p};
  if (p === 'linkedin' && ['/rest/images', '/rest/videos'].includes(path) && plan.query.action === 'initializeUpload')
    return {platform: p, media_type: path.endsWith('images') ? 'image' : 'video'};
  if (p === 'google_ads' && /^\/v\d+\/customers\/[^/]+\/assets:mutate$/.test(path))
    return {platform: p, media_type: 'image'};
  if (p === 'google_ads' && /^\/v\d+\/customers\/[^/]+\/youTubeVideoUploads:create$/.test(path))
    return {platform: p, media_type: 'video'};
  if (p === 'dv360' && /^\/(?:upload\/)?v4\/advertisers\/[^/]+\/assets$/.test(path)) return {platform: p};
  // Demand Gen image ad assets; YouTube video ad assets are created by video ID instead.
  if (p === 'dv360' && /^\/(?:upload\/)?v4\/advertisers\/[^/]+\/adAssets:uploadAdAsset$/.test(path))
    return {platform: p, media_type: 'image', dv360_target: 'ad_asset'};
}
const sourceKeys = ['drive_url', 'url', 'image_url', 'video_url', 'file_url', 'source'];
/**
 * The amcp_media file a native payload's link names: a Google Drive link, or any other public HTTPS link, each checked
 * by its own rules before anything is fetched. (A file uploaded on the website goes through amcp_media source_id.)
 */
export function mediaFileInput(value: string): {drive_url: string} | {source_url: string} {
  let host = '';
  try {
    host = new URL(value).hostname;
  } catch {}
  if (/(^|\.)(drive|docs)\.google\.com$/.test(host)) {
    driveDownloadUrl(value);
    return {drive_url: value};
  }
  mediaLinkUrl(value);
  return {source_url: value};
}
/** Only explicit import inputs are consumed. Never silently drop native mutations. */
export function nativeMediaInput(plan: CompiledRequest, connectionId?: string): JsonObject | undefined {
  const route = mediaRoute(plan);
  if (!route) return;
  const body = (plan.body as JsonObject) ?? {};
  // Normal Google asset mutations continue through their own contract.
  if (route.platform === 'google_ads' && route.media_type === 'image' && !sourceKeys.some(k => body[k] !== undefined))
    return;
  const sources = sourceKeys.filter(k => body[k] !== undefined).map(k => body[k]);
  if (!sources.length)
    throw new MirrorError(
      'MEDIA_SOURCE_REQUIRED',
      'Put the file’s link in payload.url: a public HTTPS link or a Google Drive share link (a file uploaded on the AMCP website goes through amcp_media with its source_id). AMCP fetches and transfers it on the server; do not download it in the MCP client.',
      {
        example: {
          action: plan.action,
          account_id: plan.accountId,
          payload: {url: 'https://drive.google.com/file/d/FILE_ID/view'},
        },
        review_tool: 'amcp_write',
      },
    );
  if (sources.some(v => typeof v !== 'string' || v !== sources[0]))
    throw new MirrorError('CONFLICTING_PARAMETER', 'Media source URL aliases must identify the same file.');
  const adAsset = route.dv360_target === 'ad_asset',
    allowed = new Set([
      ...sourceKeys,
      'name',
      'title',
      'file_name',
      'filename',
      'upload_type',
      'media_type',
      'type',
      'advertiser_id',
      'ad_account_id',
      'account_id',
      'owner_urn',
      'drive_connection_id',
      ...(adAsset ? ['adAssetType', 'syntheticContentAttestationStatus'] : []),
    ]);
  for (const k of Object.keys(body))
    if (!allowed.has(k))
      throw new MirrorError(
        'UNSUPPORTED_MEDIA_PARAMETER',
        'This server-side import does not consume this native field. Remove it or use its dedicated native contract.',
        {parameter: k},
      );
  if (adAsset && body.adAssetType !== undefined && body.adAssetType !== 'AD_ASSET_TYPE_IMAGE')
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'DV360 uploads only AD_ASSET_TYPE_IMAGE ad assets; YouTube video ad assets are created by video ID with DV360_ADVERTISERS_AD_ASSETS_CREATE.',
    );
  if (
    adAsset &&
    body.syntheticContentAttestationStatus !== undefined &&
    !['NOT_SYNTHETIC', 'IS_SYNTHETIC'].includes(body.syntheticContentAttestationStatus)
  )
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'syntheticContentAttestationStatus is NOT_SYNTHETIC or IS_SYNTHETIC; omit it when there is no attestation.',
    );
  if (
    Object.keys(plan.query).some(k => !(['linkedin', 'snapchat'].includes(route.platform) && k === 'action')) ||
    plan.headers['X-HTTP-Method-Override'] ||
    (plan.headers['X-RestLi-Method'] && !['ACTION', 'CREATE'].includes(plan.headers['X-RestLi-Method'].toUpperCase()))
  )
    throw new MirrorError(
      'UNSUPPORTED_MEDIA_PARAMETER',
      'Media imports cannot contain query mutations or method overrides.',
    );
  if (body.upload_type !== undefined && !['UPLOAD_BY_URL', 'UPLOAD_BY_FILE'].includes(body.upload_type))
    throw new MirrorError('INVALID_ARGUMENT', 'Unsupported media upload type.');
  const names = ['name', 'title', 'file_name', 'filename'].filter(k => body[k] !== undefined).map(k => body[k]);
  if (names.some(n => typeof n !== 'string' || n !== names[0]))
    throw new MirrorError('CONFLICTING_PARAMETER', 'Media name aliases must agree.');
  const declared = body.media_type ?? (typeof body.type === 'string' ? body.type.toLowerCase() : undefined);
  if (route.media_type && declared && route.media_type !== declared)
    throw new MirrorError('MEDIA_TYPE_MISMATCH', 'The requested media type conflicts with the native upload route.');
  return {
    action: 'prepare',
    platform: route.platform,
    account_id: plan.accountId,
    ...mediaFileInput(sources[0]),
    ...(connectionId ? {connection_id: connectionId} : {}),
    ...(names.length ? {name: names[0]} : {}),
    ...((route.media_type ?? declared) ? {media_type: route.media_type ?? declared} : {}),
    ...(route.existing_media_id ? {existing_media_id: route.existing_media_id} : {}),
    ...(route.dv360_target ? {dv360_target: route.dv360_target} : {}),
    ...(body.syntheticContentAttestationStatus ? {synthetic_content: body.syntheticContentAttestationStatus} : {}),
    ...(body.owner_urn ? {owner_urn: body.owner_urn} : {}),
    ...(body.drive_connection_id ? {drive_connection_id: body.drive_connection_id} : {}),
  };
}
export function workflowMediaInput(args: JsonObject, connectionId?: string): JsonObject {
  const targets = args.target_platforms;
  if (targets !== undefined && (!Array.isArray(targets) || targets.length !== 1))
    throw new MirrorError(
      'MEDIA_TARGET_REQUIRED',
      'Prepare one account per review. Repeat the same Drive link for each desired platform; no client download is needed.',
    );
  const target = targets?.[0];
  if (
    target &&
    ((args.platform !== undefined && mediaPlatform(args.platform) !== mediaPlatform(target.platform)) ||
      (args.account_id !== undefined && args.account_id !== target.account_id))
  )
    throw new MirrorError('CONFLICTING_PARAMETER', 'Media target aliases must agree.');
  const platform = mediaPlatform(target?.platform ?? args.platform),
    account = args.account_id ?? target?.account_id;
  if (typeof account !== 'string' || !account)
    throw new MirrorError('ACCOUNT_REQUIRED', 'Select an advertising account for the upload.');
  const supported = new Set([
    'action',
    'platform',
    'account_id',
    'target_platforms',
    'url',
    'google_drive_file_id',
    'google_drive_resource_key',
    'file_name',
    'file_type',
    'file_size_bytes',
    'media_type',
    'owner_urn',
    'dry_run',
    'confirmed',
    'idempotency_key',
    'wait_for_completion',
    'timeout_ms',
  ]);
  for (const k of Object.keys(args))
    if (!supported.has(k))
      throw new MirrorError('UNSUPPORTED_MEDIA_PARAMETER', 'This URL import does not consume this parameter.', {
        parameter: k,
      });
  if (!['UPLOAD_FROM_URL', 'UPLOAD_FROM_URL_VIA_SESSION', 'QUEUE_GOOGLE_DRIVE_IMPORT'].includes(args.action))
    throw new MirrorError(
      'MEDIA_ACTION_UNSUPPORTED',
      'Use UPLOAD_FROM_URL with a public link or a Google Drive link, then execute the returned review with amcp_write. The MCP client does not need a local file or signed upload URL.',
    );
  let url = args.url;
  if (args.google_drive_file_id !== undefined) {
    if (typeof args.google_drive_file_id !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(args.google_drive_file_id))
      throw new MirrorError('INVALID_DRIVE_LINK', 'Invalid Drive file ID.');
    const share = new URL('https://drive.google.com/file/d/' + args.google_drive_file_id + '/view');
    if (args.google_drive_resource_key !== undefined)
      share.searchParams.set('resourcekey', args.google_drive_resource_key);
    if (url !== undefined && stable(driveDownloadUrl(url).href) !== stable(driveDownloadUrl(share.href).href))
      throw new MirrorError(
        'CONFLICTING_PARAMETER',
        'Drive file ID and URL must identify the same file and resource key.',
      );
    url = share.href;
  } else if (args.google_drive_resource_key !== undefined)
    throw new MirrorError('INVALID_DRIVE_LINK', 'Provide google_drive_file_id with google_drive_resource_key.');
  if (typeof url !== 'string')
    throw new MirrorError(
      'MEDIA_SOURCE_REQUIRED',
      'Provide url: a public HTTPS link or a Google Drive share link. AMCP performs the transfer.',
    );
  const file = mediaFileInput(url);
  if (args.owner_urn && target?.owner_urn && args.owner_urn !== target.owner_urn)
    throw new MirrorError('CONFLICTING_PARAMETER', 'Owner URNs must agree.');
  return {
    action: 'prepare',
    platform,
    account_id: account,
    ...file,
    ...(connectionId ? {connection_id: connectionId} : {}),
    ...(args.file_name ? {name: args.file_name} : {}),
    ...(args.media_type ? {media_type: args.media_type} : {}),
    ...(args.file_type ? {expected_mime: args.file_type} : {}),
    ...(args.file_size_bytes ? {expected_size: args.file_size_bytes} : {}),
    ...((args.owner_urn ?? target?.owner_urn) ? {owner_urn: args.owner_urn ?? target.owner_urn} : {}),
  };
}
export function mediaPreview(input: JsonObject): JsonObject {
  mediaFileInput(input.drive_url ?? input.source_url);
  return {
    success: true,
    dry_run: true,
    executed: false,
    client_download_required: false,
    transfer:
      'AMCP server fetches the file (a public link or Google Drive), freezes its bytes for review, and uses the platform upload API.',
    request: input,
    next_call: {tool: 'amcp_media', arguments: input},
    confirmation_required: true,
  };
}
export function mediaNext(result: JsonObject): JsonObject {
  if (!result.review_id || result.executed || result.already_in_library || result.confirmation_required !== true)
    return result;
  return {
    ...result,
    client_download_required: false,
    next_call: {
      tool: 'amcp_write',
      arguments: {
        action: 'execute',
        review_id: result.review_id,
        idempotency_key: result.idempotency_key,
        confirmed: true,
      },
    },
  };
}
/** Drive inspections in progress: at most one per workspace and four per process, each streaming up to the media limit. */
const inspecting = new Map<string, number>();
/** Hashes and counts a download and keeps only the leading bytes that identify its type, never the file. */
function digestSink() {
  const hash = createHash('sha256'),
    head: Buffer[] = [];
  let size = 0,
    kept = 0;
  return {
    sink: {
      write(bytes: Uint8Array) {
        hash.update(bytes);
        size += bytes.length;
        if (kept < 64) {
          const part = Buffer.from(bytes.subarray(0, 64 - kept));
          head.push(part);
          kept += part.length;
        }
      },
      finish: () => Buffer.concat(head),
    },
    digest: () => ({size, sha256: hash.digest('hex')}),
  };
}
export async function inspectDrive(link: string, fetcher: typeof fetch, workspace = ''): Promise<JsonObject> {
  const url = driveDownloadUrl(link),
    total = [...inspecting.values()].reduce((a, b) => a + b, 0);
  if (inspecting.has(workspace) || total >= 4)
    throw new MirrorError(
      'MEDIA_INSPECTION_BUSY',
      inspecting.has(workspace)
        ? 'This workspace is already inspecting a Drive file. Try again when it finishes.'
        : 'The server is inspecting other Drive files. Try again shortly.',
      {},
      429,
      true,
    );
  inspecting.set(workspace, 1);
  try {
    const counter = digestSink(),
      file = await downloadDriveMedia(link, fetcher, counter.sink),
      {size, sha256: digest} = counter.digest();
    return {
      files: [
        {
          google_drive_file_id: url.searchParams.get('id'),
          ...(url.searchParams.has('resourcekey')
            ? {google_drive_resource_key: url.searchParams.get('resourcekey')}
            : {}),
          url: link,
          media_type: file.kind,
          mime_type: file.mime,
          size_bytes: size,
          sha256: digest,
        },
      ],
      client_download_required: false,
      next_operation: 'platform_media_upload',
      supported_platforms: mediaPlatforms,
    };
  } finally {
    inspecting.delete(workspace);
  }
}
