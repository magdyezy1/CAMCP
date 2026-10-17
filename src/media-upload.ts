import {nativeAuthority} from './native-authority.js';
import {createHash, randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {MirrorError} from './errors.js';
import {fail} from './family-kit.js';
import {websiteUploadDeadline, withWebsiteUploadDeadline} from './media-retention.js';
import {Registry} from './catalog.js';
import {Store, MEDIA_LEASE_MS} from './store.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport, trackDispatch, type BinaryUpload, type TransportResult} from './transport.js';
import {releaseUnsentClaims} from './write-common.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {writeOutcome} from './write-outcome.js';
import {validateState} from './write-state.js';
import {normalizeSnapshot, reviewStateHash, changedStateFields} from './review-state.js';
import {downloadDriveFile, downloadPrivateDrive, driveAccess, listDriveFolder} from './private-drive.js';
import {createMediaVariant, variantPresets, inspectMediaPlacement} from './media-variants.js';
import {placementPreflight} from './media-specs.js';
import {downloadDriveMedia, mediaType, driveDownloadUrl} from './drive-media.js';
import {guardInput, sha256, stable} from './security.js';
import type {ExecutionPolicy} from './preflight.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from './types.js';
import {ownership, ownsRecord} from './actor-identity.js';
import {mediaImageLimit, mediaPlatformNames, mediaPlatforms, mp4OnlyPlatforms} from './media-routing.js';
import {
  describeFit,
  effectiveFitLimits,
  fitMediaToPlatform,
  type FittedMedia,
  type MediaTransform,
} from './media-fit.js';
import {cachedFit, cachedFitFacts, cacheFit, type FitSource} from './media-fit-cache.js';
import {serverPushEnabled} from './campaign-background.js';
import {downloadMediaLink, type LinkRequest} from './media-link.js';
import {MediaSources} from './media-sources.js';
import {retainedMediaId} from './retained-media.js';
import {assertAccountWrite} from './write-access.js';
import {linkedinVersion} from './linkedin-version.js';
import {assertLinkedInOrganization} from './linkedin-posts.js';
import {
  linkedInTransfer,
  linkedInPartId,
  linkedInResumeReason,
  assertLinkedInResume,
  assertLinkedInWaiting,
} from './linkedin-media-resume.js';
import {assertWritesNotPaused} from './owner-operations.js';
import {googleAdsCustomers} from './google-version.js';
import {metaPrefix} from './meta-version.js';
import {creativeLibrary} from './creative-library.js';
import {optionalClientView} from './client-scope.js';

const platforms = mediaPlatforms;
/** Snapchat simple uploads take up to 32 MB; larger files are sent in parts well under the 32 MB part limit (either unit). */
const snapchatSimpleLimit = 32_000_000,
  snapchatPartSize = 16 * 1024 * 1024;
const configured = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
};
/**
 * After its claim a transfer may continue this long (AMCP_MEDIA_TRANSFER_WINDOW_MINUTES, 5–180, default 60), always
 * within a website upload's absolute 30-minute deadline; the five-minute review governs confirmation only (MED-01 D).
 */
export const MEDIA_TRANSFER_WINDOW_MS = configured('AMCP_MEDIA_TRANSFER_WINDOW_MINUTES', 60, 5, 180) * 60000;
/**
 * Why a queued upload failed before any claim (MED-02 review): busy media capacity clears with time, so the same
 * review may be queued again; these other refusals repeat until the upload is prepared again.
 */
export const mediaBusyCodes: ReadonlySet<string> = new Set([
  'MEDIA_MEMORY_BUSY',
  'MEDIA_UPLOAD_BUSY',
  'MEDIA_PROCESSOR_BUSY',
]);
const repeatsBeforeClaim = new Set(['UPLOAD_DEADLINE_TOO_CLOSE', 'MEDIA_CHANGED', 'REVIEW_CHANGED', 'REVIEW_EXPIRED']);
/** Deadline-aware start (MED-01 C): a budget per provider request, a throughput floor and a margin, all configurable. */
const transferStepMs = configured('AMCP_MEDIA_STEP_BUDGET_MS', 5000, 500, 120000),
  transferBytesPerSecond = configured('AMCP_MEDIA_TRANSFER_BYTES_PER_SECOND', 1048576, 65536, 1073741824),
  transferMarginMs = configured('AMCP_MEDIA_DEADLINE_MARGIN_MS', 15000, 0, 600000);
/** The provider requests a reviewed transfer of `bytes` makes after its claim, platform by platform. */
export function mediaTransferSteps(
  p: Pick<UploadPlan, 'platform' | 'kind' | 'existing_media_id' | 'library_media'>,
  bytes: number,
) {
  const parts = (unit: number) => Math.max(1, Math.ceil(bytes / unit));
  if (p.library_media) return 1;
  if (p.platform === 'google_ads') return p.kind === 'video' ? 1 + parts(4 * 1024 * 1024) : 1;
  if (p.platform === 'snapchat')
    return (p.existing_media_id ? 0 : 1) + (bytes > snapchatSimpleLimit ? 2 + parts(snapchatPartSize) : 1);
  if (p.platform === 'linkedin') return p.kind === 'video' ? 2 + parts(4 * 1024 * 1024) : 2;
  if (p.platform === 'x_ads') return p.kind === 'video' ? 3 + parts(4 * 1024 * 1024) : 2;
  return 1;
}
/** A conservative estimate of how long the transfer takes: requests, bytes at the throughput floor, and a margin. */
export function mediaTransferEstimateMs(
  p: Pick<UploadPlan, 'platform' | 'kind' | 'existing_media_id' | 'library_media'>,
  bytes: number,
) {
  return (
    mediaTransferSteps(p, bytes) * transferStepMs +
    Math.ceil((Math.max(0, bytes) * 1000) / transferBytesPerSecond) +
    transferMarginMs
  );
}
/** When a transfer claimed at `now` must have finished: its window, never after the website upload deadline. */
export const mediaTransferDeadline = (p: Pick<UploadPlan, 'upload_expires_at'>, now: number) =>
  Math.min(now + MEDIA_TRANSFER_WINDOW_MS, p.upload_expires_at ?? Number.MAX_SAFE_INTEGER);
export const mediaTool = {
  name: 'amcp_media',
  description:
    'Use this to put an image or video into an ad account as a reviewed upload: a file uploaded on the AMCP website (source_id; list returns them under sources), a public HTTPS link (source_url), or a public or selected private Google Drive file (drive_url). prepare fetches and encrypts the exact file for a five-minute review, capped by the original website upload’s absolute 30-minute deadline; fit_to_platform:true first scales media larger than 1080 on its short side or 1920 on its long side down to fit (never cropped), re-encodes an image above the platform limit and converts MOV to MP4 for X and LinkedIn, and request.transform says what changed; execute uploads those frozen bytes after explicit confirmation. Supports PNG/JPEG and MP4/MOV across Meta, TikTok, Snapchat, Google Ads, LinkedIn, X and DV360 (X/LinkedIn video: MP4). Google videos are uploaded as UNLISTED on the account Google-managed YouTube channel. Normal native media actions and platform_media_upload use this same server transfer; the MCP client never downloads bytes. status reads provider processing state; prepare_library reviews adding an X video to its account library once processing succeeds. Never publishes ads or posts. Uses operator role, account write grants and durable idempotency. Files up to the configured media limit (128 MiB by default) with lower platform image limits. Private files use a separate selected Google Drive connection. variant creates an encrypted, expiring preview with explicit contain/crop presets; prepare accepts variant_id. execute_async queues the frozen confirmed review; job_status shows durable progress. list returns account-scoped receipts and current temporary/retained sources. Website uploads, their thumbnails, variants and review copies expire 30 minutes after upload starts and cannot be retained; provider-hosted assets and metadata receipts are separate. retain_source makes an encrypted durable copy of one separately imported link/Drive original only for a current workspace owner, with source_id, confirmed:true and the exact expected_sha256; it keeps the temporary upload expiry and shares the unchanged file count/byte quota. Returned lib- source IDs work wherever source_id is accepted. remove_source permanently removes a retained original only with current owner authority, confirmed:true and its exact expected_sha256; provider uploads, historical receipts, frozen reviews and existing backups are separate. library searches retained metadata with search/tag/account filters and identity-bound cursors; asset shows exact verified campaign usage and current source expiry. asset_usage reads bounded current Meta v26 scalar image/video references (1–100 ads per page with an exact encrypted cursor) or complete Google v25 original-image asset links (1–1000 links, default 50, no cursor) in the original upload account, including ads outside retained plans. Google requires the exact account asset resource and uploaded SHA-256, adwords and current account access; its default ad_images view covers App, Demand Gen and Responsive Search. Explicit reference_view performance_max separately reads configured Performance Max image asset-group links, with native enabled/paused/removed status and exact group/campaign identity; asset groups are not individual ads. Explicit reference_view performance_max_brand separately inspects campaign-level LOGO/LANDSCAPE_LOGO links with explicitly enabled brand guidelines and exact Performance Max campaign identity; campaign links are not ads or asset groups. Responsive Display, Google video and other associations remain outside these views. Complete repeated collections and bracketed asset/customer reads must match; missing enabled flags/types stay unknown and removed links are counted separately. Meta requires ads_read or ads_management and current account access; reads require no upload write grant. Missing formats, historical assignment, delivery and performance attribution remain unknown. Keep the original asset, identity and login exact. Preserve page size and cursor for Meta; Google requires a fresh complete bounded read. Snapchat image/video asset_usage also supports the original-account snapchat_top_snap view: exact account/media UUIDs and uploaded SHA-256, current Snapchat Marketing API permission, complete repeated creative collections and bracketed original account/media observations. limit bounds all examined creatives at 1–1000 (default 50); each original-media discovery is capped at 1000 media rows. Native page size is 50. One read shares 84 attempts, 4102 rows, 8 MiB and 60 seconds. Any cursor, partial collection, changed source or foreign identity is refused. Only literal creative.top_snap_media_id is inspected; creative packaging/review and media-processing statuses do not establish ad delivery. Nested media, icons, previews, dynamic templates, lead-form media and other associations remain outside this view. It creates no snapshot or ownership/write grant and needs no upload write grant. This creates no plan or provider mutation. asset_performance lists compatible guided Meta, Google Ads, Snapchat or standard TikTok ad snapshots (LinkedIn: creative snapshots), or joins exact verified ad IDs (LinkedIn: exact sponsoredCreative URNs, never converted) with asset_id, plan_id and report_id; Google preserves the full customer/ad-group/ad resource identity and Smart+ remains separate; it preserves measurement definitions and does not establish historical creative assignment. save_asset_metadata updates local names/tags with operator role, confirmed:true and current metadata_revision passed as revision (0 when absent); it never changes provider media. recovery exposes safe continuation; resume supports Google video offsets and LinkedIn confirmed-part boundaries within the original review, never an uncertain part or finalization. reuse requires a fresh provider availability check. DV360 uploads creative assets by default; dv360_target ad_asset uploads a PNG/JPEG image (up to 5120 KB) as a Demand Gen image ad asset, optionally labelled with synthetic_content, and returns its assetId. inspect_eligibility checks source dimensions, duration and codec against a placement preset before any provider upload; it does not certify provider policy approval.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: [
          'prepare',
          'prepare_library',
          'execute',
          'resume',
          'execute_async',
          'job_status',
          'status',
          'recovery',
          'cancel',
          'variant',
          'inspect_eligibility',
          'retain_source',
          'remove_source',
          'list',
          'library',
          'asset',
          'save_asset_metadata',
          'asset_performance',
          'asset_usage',
          'reuse',
          'plan',
        ],
      },
      platform: {type: 'string', enum: platforms},
      account_id: {type: 'string'},
      connection_id: {type: 'string'},
      drive_url: {type: 'string'},
      drive_connection_id: {type: 'string'},
      variant_id: {type: 'string'},
      source_id: {
        type: 'string',
      },
      source_url: {
        type: 'string',
      },
      destinations: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          required: ['platform', 'account_id'],
          properties: {
            platform: {type: 'string', enum: platforms},
            account_id: {type: 'string'},
            connection_id: {type: 'string'},
            owner_urn: {type: 'string'},
            dv360_target: {type: 'string', enum: ['creative_asset', 'ad_asset']},
          },
          additionalProperties: false,
        },
      },
      expected_sha256: {
        type: 'string',
      },
      fit_to_platform: {
        type: 'boolean',
      },
      stage_fits: {type: 'boolean'},
      preset: {type: 'string', enum: Object.keys(variantPresets)},
      fit: {type: 'string', enum: ['contain', 'crop']},
      reuse_existing: {type: 'boolean'},
      asset_id: {type: 'string'},
      reference_view: {
        type: 'string',
        enum: ['ad_images', 'performance_max', 'performance_max_brand', 'snapchat_top_snap'],
      },
      plan_id: {
        type: 'string',
      },
      report_id: {
        type: 'string',
      },
      search: {type: 'string', maxLength: 200},
      tag: {type: 'string', maxLength: 40},
      original_sha256: {type: 'string'},
      cursor: {
        type: 'string',
        maxLength: 24000,
      },
      revision: {type: 'integer', minimum: 0},
      metadata: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: {type: 'string', minLength: 1, maxLength: 160},
          tags: {type: 'array', maxItems: 20, items: {type: 'string', minLength: 1, maxLength: 40}},
        },
      },
      offset: {type: 'integer', minimum: 0},
      recovery_offset: {type: 'integer', minimum: 0},
      include_assets: {type: 'boolean'},
      profile_id: {type: 'string'},
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 1000,
      },
      name: {type: 'string'},
      media_type: {type: 'string', enum: ['image', 'video']},
      expected_mime: {type: 'string'},
      expected_size: {type: 'integer', minimum: 1},
      existing_media_id: {type: 'string'},
      owner_urn: {type: 'string'},
      dv360_target: {type: 'string', enum: ['creative_asset', 'ad_asset']},
      synthetic_content: {type: 'string', enum: ['NOT_SYNTHETIC', 'IS_SYNTHETIC']},
      review_id: {type: 'string'},
      idempotency_key: {
        type: 'string',
      },
      confirmed: {type: 'boolean'},
    },
    additionalProperties: false,
  },
};
export const readOnlyMediaTool = {
  ...mediaTool,
  description:
    'Use this to inspect account-scoped retained media metadata, original-source availability, verified AMCP plan usage and compatible retained ad performance. Actions: list, library, asset, asset_performance and asset_usage. asset_usage reads bounded current Meta v26 scalar image/video references (1–100 ads per page, encrypted cursor) or complete Google v25 original-image asset links (1–1000 links, default 50, no cursor) in the original upload account. Google requires an exact account asset resource, uploaded SHA-256, adwords and current access; ad_images is the default selected App, Demand Gen and Responsive Search view. Explicit reference_view performance_max separately inspects configured image asset-group links with native enabled/paused/removed status and exact parent identity; groups are not individual ads. Explicit reference_view performance_max_brand separately inspects campaign-level LOGO/LANDSCAPE_LOGO links with explicitly enabled brand guidelines and exact Performance Max campaign identity; campaign links are not ads or asset groups. Responsive Display, Google video and other associations remain outside these views. Both complete collections and original asset/customer brackets must match. Missing link flags/types stay unknown and removed links are separate. Meta requires ads_read or ads_management and current account access; missing formats and historical attribution remain unknown. Keep the original asset, identity and login exact. Preserve page size and cursor for Meta; Google requires a fresh complete bounded read. Snapchat image/video asset_usage also supports the original-account snapchat_top_snap view: exact account/media UUIDs and uploaded SHA-256, current Snapchat Marketing API permission, complete repeated creative collections and bracketed original account/media observations. limit bounds all examined creatives at 1–1000 (default 50); each original-media discovery is capped at 1000 media rows. Native page size is 50. One read shares 84 attempts, 4102 rows, 8 MiB and 60 seconds. Any cursor, partial collection, changed source or foreign identity is refused. Only literal creative.top_snap_media_id is inspected; creative packaging/review and media-processing statuses do not establish ad delivery. Nested media, icons, previews, dynamic templates, lead-form media and other associations remain outside this view. It creates no snapshot or ownership/write grant and needs no upload write grant. This deployment exposes media reads only; uploading, source retention/removal and metadata changes require their separately enabled workflow.',
  inputSchema: {
    ...mediaTool.inputSchema,
    properties: {
      ...mediaTool.inputSchema.properties,
      action: {type: 'string', enum: ['list', 'library', 'asset', 'asset_performance', 'asset_usage']},
    },
  },
};
const responseId = (value: unknown, pattern = /^[A-Za-z0-9_-]+$/) => {
  if (typeof value !== 'string' || !pattern.test(value))
    fail('MEDIA_RESPONSE_INVALID', 'The provider did not return a valid media identifier.');
  return value as string;
};
interface UploadPlan {
  platform: string;
  account_id: string;
  connection_id: string;
  name: string;
  mime: string;
  kind: 'image' | 'video';
  filename: string;
  size: number;
  sha256: string;
  read: CompiledRequest;
  source_drive?: {connection_id: string; url: string};
  existing_media_id?: string;
  owner_urn?: string;
  dv360_target?: 'ad_asset';
  synthetic_content?: string;
  library_media?: {id: string; key: string; source_review_id: string};
  /** Where the file's bytes came from: the original's provenance and hash (MED-04 B), or an earlier review's label. */
  origin?: MediaOrigin | LegacyOrigin;
  upload_expires_at?: number;
  /** How fit_to_platform changed the file, shown for review. */
  transform?: ReviewedTransform;
}
/** A fit as its review shows it: the changes, and those changes in words for this platform. */
type ReviewedTransform = MediaTransform & {reasons: string[]};
/** A fit, and whether its output is kept as a cached copy for later reviews (MED-03 C). */
type StagedFit = FittedMedia & {staged?: boolean};
/**
 * The checks every file a platform receives must pass, on its facts alone, so a plan's preflight can apply them to a
 * cached copy without reading or preparing it (MED-03 C): the planned SHA-256, MP4 for X and LinkedIn, only images as
 * DV360 ad assets, a LinkedIn video owner and the platform's image byte limit.
 */
function assertPlatformFile(
  input: JsonObject,
  file: {sha256: string; size: number; mime: string; kind: 'image' | 'video'},
  adAsset: boolean,
) {
  const imageLimit = mediaImageLimit(input.platform, adAsset),
    mp4Only = mp4OnlyPlatforms.includes(input.platform);
  if (input.expected_sha256 !== undefined && input.expected_sha256 !== file.sha256)
    fail('MEDIA_CHANGED', 'The file to upload is not the one planned (expected_sha256). Plan the push again.', {
      expected_sha256: input.expected_sha256,
      actual_sha256: file.sha256,
    });
  if (mp4Only && file.mime === 'video/quicktime')
    fail('MEDIA_TYPE_UNSUPPORTED', 'Use MP4 video for X and LinkedIn, or add fit_to_platform:true to convert it.');
  if (adAsset && file.kind !== 'image')
    fail(
      'MEDIA_TYPE_UNSUPPORTED',
      'DV360 uploads only images as ad assets; YouTube video ad assets are created by video ID with DV360_ADVERTISERS_AD_ASSETS_CREATE.',
    );
  if (
    input.platform === 'linkedin' &&
    file.kind === 'video' &&
    !/^urn:li:(?:organization|person):[A-Za-z0-9_-]+$/.test(input.owner_urn ?? '')
  )
    fail(
      'LINKEDIN_VIDEO_OWNER_REQUIRED',
      'Specify the organization/person owner and its administrator resource binding for this LinkedIn video.',
    );
  if (file.kind === 'image' && file.size > imageLimit)
    fail(
      'MEDIA_TOO_LARGE',
      'Image exceeds the platform import limit.' +
        (input.fit_to_platform === true ? '' : ' Add fit_to_platform:true to resize and re-encode it.'),
      {maximum_bytes: imageLimit},
    );
}
/**
 * Where the bytes a review uploads came from (MED-04 B): the provenance of the original, not only the path AMCP read it
 * by. A website upload, a link import, a Drive import (direct or a source_id) or an owner-retained original, with the
 * original's own SHA-256, size and type, so lineage survives the original's expiry and a fitted or variant upload still
 * names the file it was made from. New reviews carry it in their fingerprint; reviews prepared earlier keep theirs.
 */
export interface MediaOrigin {
  kind: 'website_upload' | 'link_import' | 'drive_import' | 'retained_original';
  /** The upload or retained original (src-… or lib-…) when the file was named by source_id. */
  source_id?: string;
  filename?: string;
  original_sha256: string;
  original_size: number;
  original_mime: string;
  /** The host a link import came from (never the full link). */
  link_host?: string;
  /** How a retained original first reached AMCP, and the import it was retained from. */
  imported_from?: 'website_upload' | 'link_import' | 'drive_import';
  original_source_id?: string;
  /** The preset copy actually uploaded, made from the original above. */
  variant?: {variant_id: string; preset: string; fit: string; source_sha256: string};
}
/** The origin shapes of reviews prepared before MED-04, kept as they were so their fingerprints still hold. */
type LegacyOrigin = {kind: 'upload'; source_id: string; filename: string} | {kind: 'link'; host: string};
/** A completed upload or import record as its reviews name its provenance. */
function sourceOrigin(r: JsonObject): MediaOrigin {
  const retained = retainedMediaId.test(r.id),
    imported = r.origin === 'link' ? 'link_import' : r.origin === 'drive' ? 'drive_import' : 'website_upload';
  return {
    kind: retained ? 'retained_original' : imported,
    source_id: r.id,
    filename: r.filename,
    original_sha256: r.sha256,
    original_size: r.size,
    original_mime: r.mime,
    ...(typeof r.link_host === 'string' ? {link_host: r.link_host} : {}),
    ...(retained
      ? {
          imported_from: imported,
          ...(typeof r.original_source_id === 'string' ? {original_source_id: r.original_source_id} : {}),
        }
      : {}),
  };
}
/** A file AMCP downloaded itself (a public link or a Drive link) as its review names its provenance. */
const downloadedOrigin = (kind: 'link_import' | 'drive_import', bytes: Buffer, mime: string, host?: string) =>
  ({
    kind,
    original_sha256: sha256(bytes),
    original_size: bytes.length,
    original_mime: mime,
    ...(host ? {link_host: host} : {}),
  }) satisfies MediaOrigin;
/**
 * The receipt's source label for how the file reached AMCP: `amcp_upload` (a website upload), `link_import`,
 * `server_drive_import`, or `retained_original` (an owner-retained library copy). Reviews prepared before MED-04 keep
 * their earlier labels.
 */
export const receiptSource = (p: Pick<UploadPlan, 'origin'>) => {
  const kind = p.origin?.kind;
  if (kind === 'upload' || kind === 'website_upload') return 'amcp_upload';
  if (kind === 'link' || kind === 'link_import') return 'link_import';
  if (kind === 'retained_original') return 'retained_original';
  return 'server_drive_import';
};
/** The original's SHA-256 a receipt keeps for lineage, when its review recorded one (MED-04 B). */
const receiptLineage = (p: Pick<UploadPlan, 'origin'>) =>
  p.origin && 'original_sha256' in p.origin ? {original_sha256: p.origin.original_sha256} : {};
interface UploadResult {
  media_id: string;
  media_key?: string;
  ready: boolean;
  processing_status: string;
  library_id?: string;
  data?: unknown;
}

export class MediaUploadService {
  private executionContext = new AsyncLocalStorage<number>();
  constructor(
    private registry: Registry,
    private store: Store,
    private transport: NativeTransport,
    private credentials: CredentialProvider,
    private policy: ExecutionPolicy,
    private fetcher: typeof fetch = fetch,
    private linkRequest?: LinkRequest,
  ) {
    this.sources = new MediaSources(store, policy.allowWrites, linkRequest, {
      download: (actor, connection, fileId, folderId, sink) =>
        downloadDriveFile(store, credentials, actor, connection, fileId, folderId, fetcher, sink),
      list: (actor, connection, folderId) => listDriveFolder(store, credentials, actor, connection, folderId, fetcher),
    });
  }
  readonly sources: MediaSources;
  private access(actor: Actor, platform: string, account: string, connectionId?: string): Connection {
    this.store.assertActorActive(actor);
    if (!this.policy.allowWrites)
      fail('LIVE_WRITES_DISABLED', 'Reviewed media uploads are disabled in this deployment.');
    if (actor.role === 'reader')
      throw new MirrorError('FORBIDDEN', 'An operator connector is required for media uploads.', {}, 403);
    const gateway = platform + '_native_action',
      c = this.store.resolveConnection(actor, gateway, account, connectionId);
    assertAccountWrite(this.store, c, account);
    return c;
  }
  private accountRead(platform: string, account: string): CompiledRequest {
    const p: CompiledRequest = {
      gateway: platform + '_native_action',
      accountId: account,
      action: 'AMCP_MEDIA_ACCOUNT_READ',
      method: 'GET',
      path: '',
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'AMCP media upload account contract',
      warnings: [],
    };
    switch (platform) {
      case 'meta':
        p.path = metaPrefix + 'act_' + account;
        p.query = {fields: 'id,account_status,currency'};
        break;
      case 'snapchat':
        p.path = '/v1/adaccounts/' + account;
        break;
      case 'tiktok':
        p.path = '/v1.3/advertiser/info/';
        p.query = {advertiser_ids: [account]};
        break;
      case 'google_ads':
        p.path = googleAdsCustomers + account + '/googleAds:search';
        p.method = 'POST';
        p.body = {query: 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'};
        break;
      case 'linkedin':
        p.path = '/rest/adAccounts/' + account;
        p.headers = {'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'};
        break;
      case 'x_ads':
        p.path = '/12/accounts/' + account;
        break;
      case 'dv360':
        p.path = '/v4/advertisers/' + account;
        break;
      default:
        fail('MEDIA_PLATFORM_UNSUPPORTED', 'Select a supported media platform.');
    }
    return p;
  }
  private async state(actor: Actor, p: UploadPlan): Promise<unknown> {
    if (p.source_drive) driveAccess(this.store, actor, p.source_drive.connection_id, p.source_drive.url);
    const c = this.access(actor, p.platform, p.account_id, p.connection_id);
    new ScopeGuard(this.registry, this.store).authorize(p.read, c);
    this.ownerScope(p, c);
    const auth = await this.credentials.get(c),
      current = this.access(actor, p.platform, p.account_id, p.connection_id);
    new ScopeGuard(this.registry, this.store).authorize(p.read, current);
    this.ownerScope(p, current);
    const access = nativeAuthority(this.store, this.registry, actor, p.read, current, auth, () => {
      const c = this.access(actor, p.platform, p.account_id, p.connection_id);
      this.ownerScope(p, c);
      if (p.source_drive) driveAccess(this.store, actor, p.source_drive.connection_id, p.source_drive.url);
    });
    const r = await this.transport.request(p.read, access(), auth, undefined, {beforeAttempt: access});
    access();
    validateState(p.read, r);
    return normalizeSnapshot(p.read, r.data);
  }
  private ownerScope(p: UploadPlan, c: Connection) {
    if (
      p.platform === 'linkedin' &&
      p.kind === 'video' &&
      !/^urn:li:(?:organization|person):[A-Za-z0-9_-]+$/.test(p.owner_urn ?? '')
    )
      fail(
        'LINKEDIN_VIDEO_OWNER_REQUIRED',
        'Prepare LinkedIn video with an explicit organization/person owner and its exact binding.',
      );
    if (p.owner_urn?.startsWith('urn:li:organization:')) assertLinkedInOrganization(c, p.account_id, p.owner_urn);
    if (p.owner_urn && p.owner_urn !== 'urn:li:sponsoredAccount:' + p.account_id) {
      const [, kind, id] = /^urn:li:([^:]+):(.+)$/.exec(p.owner_urn)!;
      new ScopeGuard(this.registry, this.store).authorize(
        {
          ...p.read,
          path:
            '/rest/' +
            (kind === 'organization' ? 'organizations' : kind === 'person' ? 'people' : 'adAccounts') +
            '/' +
            id,
        },
        c,
      );
    }
  }
  /** The one file a call names: an upload (source_id), a public link (source_url), a variant or a Drive file. */
  private async source(input: JsonObject, actor: Actor, stageId: string) {
    const named = ['source_id', 'source_url', 'drive_url', 'variant_id'].filter(k => input[k] !== undefined);
    if (named.length !== 1 || (input.drive_connection_id !== undefined && named[0] !== 'drive_url'))
      fail(
        'INVALID_ARGUMENT',
        'Name one file: source_id (an upload), source_url (a public HTTPS link), drive_url or variant_id.',
        {files_named: named},
      );
    const sink = this.store.mediaSink(actor.tenantId, stageId, () => this.store.assertActorActive(actor));
    if (input.source_id !== undefined) {
      const {bytes, mime, kind, extension, record} = this.sources.file(actor, input.source_id);
      const upload_expires_at = websiteUploadDeadline(record);
      if (upload_expires_at !== undefined) this.store.capStagedMediaExpiry(actor.tenantId, stageId, upload_expires_at);
      return {
        bytes,
        mime,
        kind,
        extension,
        source_drive: undefined,
        upload_expires_at,
        // The exact original a fitted copy may be cached from (MED-03 C).
        fit_source: {id: record.id as string, sha256: record.sha256 as string},
        // The original's provenance, not only "an upload": a link or Drive import keeps its label (MED-04 B).
        origin: sourceOrigin(record) as UploadPlan['origin'],
      };
    }
    if (input.source_url !== undefined) {
      const {bytes, mime, kind, extension, host} = await downloadMediaLink(input.source_url, {
        request: this.linkRequest,
        sink,
      });
      return {
        bytes,
        mime,
        kind,
        extension,
        source_drive: undefined,
        upload_expires_at: undefined,
        origin: downloadedOrigin('link_import', bytes, mime, host) as UploadPlan['origin'],
      };
    }
    if (input.variant_id) {
      const v = this.variant(actor, input.variant_id),
        bytes = this.store.stagedMedia(actor.tenantId, v.id);
      if (sha256(bytes) !== v.sha256) fail('MEDIA_CHANGED', 'Variant integrity check failed.');
      if (v.upload_expires_at !== undefined)
        this.store.capStagedMediaExpiry(actor.tenantId, stageId, v.upload_expires_at);
      // A variant names the original it was made from and itself (MED-04 B); one made earlier keeps its label.
      const origin =
        v.origin && typeof v.origin.original_sha256 === 'string'
          ? {
              ...v.origin,
              variant: {variant_id: v.id, preset: v.preset, fit: v.fit, source_sha256: v.source_sha256},
            }
          : v.origin;
      return {
        bytes,
        ...mediaType(bytes),
        source_drive: v.drive_connection_id ? {connection_id: v.drive_connection_id, url: v.drive_url} : undefined,
        upload_expires_at: v.upload_expires_at,
        ...(origin ? {origin: origin as UploadPlan['origin']} : {}),
      };
    }
    let selected = input.drive_connection_id;
    if (!selected) {
      const id = driveDownloadUrl(input.drive_url).searchParams.get('id')!,
        matches = this.store
          .connectionsFor(actor)
          .filter(c => c.gateway === 'google_drive_native_action' && c.enabled && c.accounts.includes(id)),
        defaults = matches.filter(c => c.isDefault);
      if (matches.length > 1 && defaults.length !== 1)
        fail(
          'DRIVE_CONNECTION_REQUIRED',
          'This file is selected in multiple Drive logins; choose drive_connection_id.',
        );
      selected = matches.length === 1 ? matches[0]!.id : defaults[0]?.id;
    }
    const downloaded = selected
      ? {
          ...(await downloadPrivateDrive(
            this.store,
            this.credentials,
            actor,
            selected,
            input.drive_url,
            this.fetcher,
            sink,
          )),
          source_drive: {connection_id: selected, url: input.drive_url},
          upload_expires_at: undefined,
        }
      : {
          ...(await downloadDriveMedia(input.drive_url, this.fetcher, sink)),
          source_drive: undefined,
          upload_expires_at: undefined,
        };
    return {
      ...downloaded,
      origin: downloadedOrigin('drive_import', downloaded.bytes, downloaded.mime) as UploadPlan['origin'],
    };
  }
  /**
   * The file as one platform receives it: fitted when fit_to_platform asks (`fits` shares one conversion between
   * platforms with the same limits), then refused for anything the platform does not take.
   */
  private async platformFile<
    F extends {
      bytes: Buffer;
      mime: string;
      kind: 'image' | 'video';
      extension: string;
      upload_expires_at?: number;
      fit_source?: FitSource;
    },
  >(
    input: JsonObject,
    source: F,
    adAsset: boolean,
    actor: Actor,
    fits = new Map<string, Promise<StagedFit>>(),
    stageFits = false,
  ): Promise<{file: F; transform?: ReviewedTransform; width?: number; height?: number; fit_staged?: boolean}> {
    const imageLimit = mediaImageLimit(input.platform, adAsset),
      mp4Only = mp4OnlyPlatforms.includes(input.platform);
    let file = source,
      transform: ReviewedTransform | undefined,
      size: {width?: number; height?: number} = {},
      staged = false;
    if (input.fit_to_platform === true) {
      // Platforms whose limits differ only where this file is unaffected (an image limit for a video) share one fit.
      const limits = effectiveFitLimits(source, {imageBytes: imageLimit, mp4Only}),
        key = limits.imageBytes + ':' + limits.mp4Only;
      // A copy cached by the plan of this original and limits is used as it is (MED-03 C); otherwise the fit is
      // converted once per limit group, and a plan that asks for it (stage_fits) keeps the output for its reviews.
      if (!fits.has(key))
        fits.set(
          key,
          withWebsiteUploadDeadline(source.upload_expires_at, async (): Promise<StagedFit> => {
            const hit = source.fit_source
              ? await cachedFit(this.store, actor.tenantId, source.fit_source, limits)
              : undefined;
            if (hit) {
              this.store.noteMedia(actor.tenantId, 'fit_cache_hits');
              return {...hit, staged: true};
            }
            const fitted = await fitMediaToPlatform(source.bytes, limits);
            if (fitted.transform) this.store.noteMedia(actor.tenantId, 'fit_conversions');
            return {
              ...fitted,
              staged:
                stageFits &&
                !!source.fit_source &&
                (await cacheFit(
                  this.store,
                  actor.tenantId,
                  source.fit_source,
                  limits,
                  fitted,
                  this.fitDeadline(actor, source.fit_source),
                )),
            };
          }),
        );
      const fitted = await fits.get(key)!;
      staged = fitted.staged === true;
      this.store.assertActorActive(actor);
      size = {width: fitted.width, height: fitted.height};
      if (fitted.transform) {
        const {bytes, mime, kind, extension} = fitted;
        file = {...source, bytes, mime, kind, extension};
        transform = {
          ...fitted.transform,
          reasons: describeFit(fitted.transform.steps, mediaPlatformNames[input.platform]!),
        };
      }
    }
    if (input.preset) {
      const eligibility = await withWebsiteUploadDeadline(source.upload_expires_at, () =>
        inspectMediaPlacement(file.bytes, input.preset),
      );
      if (!eligibility.eligible_for_preset)
        fail('MEDIA_PLACEMENT_MISMATCH', 'The source does not meet the selected placement preset.', eligibility);
    }
    if (
      (input.media_type !== undefined && input.media_type !== file.kind) ||
      (input.expected_mime !== undefined && input.expected_mime !== file.mime) ||
      (input.expected_size !== undefined && input.expected_size !== file.bytes.length)
    )
      fail('MEDIA_TYPE_MISMATCH', 'The downloaded file does not match the declared type, MIME type or size.', {
        actual_type: file.kind,
        actual_mime: file.mime,
        actual_size: file.bytes.length,
      });
    assertPlatformFile(
      input,
      {sha256: sha256(file.bytes), size: file.bytes.length, mime: file.mime, kind: file.kind},
      adAsset,
    );
    return {file, transform, ...size, ...(staged ? {fit_staged: true} : {})};
  }
  /** When a fitted copy of `source` must lapse: with the original's own staging; a retained original has none. */
  private fitDeadline(actor: Actor, source: FitSource): number | undefined {
    return source.id.startsWith('src-') ? (this.store.stagedSourceExpiry(actor.tenantId, source.id) ?? 0) : undefined;
  }
  /**
   * Upload receipts that already hold exactly this file in this account (MED-03 D): the same connection, SHA-256,
   * DV360 target and LinkedIn owner, provider-ready at its last check. Reusing one still requires a fresh check.
   */
  private matchingReceipts(
    actor: Actor,
    p: Pick<UploadPlan, 'platform' | 'account_id' | 'connection_id' | 'sha256' | 'dv360_target' | 'owner_urn'>,
  ) {
    return this.assets(actor, {
      platform: p.platform,
      account_id: p.account_id,
      connection_id: p.connection_id,
    }).filter(
      a =>
        a.sha256 === p.sha256 &&
        a.ready === true &&
        (a.dv360_target ?? null) === (p.dv360_target ?? null) &&
        (a.owner_urn ?? null) ===
          (p.owner_urn ?? (p.platform === 'linkedin' ? 'urn:li:sponsoredAccount:' + p.account_id : null)),
    );
  }
  /**
   * What pushing an upload to several accounts would do, without calling any platform: for each destination, access
   * and the exact file it would receive (SHA-256, size, dimensions, every change), and the upload receipts that already
   * hold that exact file in that account (MED-03 D). Each ready destination is then prepared with that expected_sha256
   * (or reused after a fresh check) and executed as its own review. Nothing is staged unless `stage_fits` asks to keep
   * each changed output for those reviews (MED-03 C), so they do not convert the original again.
   */
  private async planPush(input: JsonObject, actor: Actor) {
    const destinations = input.destinations;
    if (!Array.isArray(destinations) || !destinations.length || destinations.length > 20)
      fail('INVALID_ARGUMENT', 'plan takes 1 to 20 destinations, each {platform, account_id, connection_id?}.');
    if (input.source_id === undefined || ['source_url', 'drive_url', 'variant_id'].some(k => input[k] !== undefined))
      fail('INVALID_ARGUMENT', 'plan works on an upload: pass its source_id.');
    if (input.fit_to_platform !== undefined && typeof input.fit_to_platform !== 'boolean')
      fail('INVALID_ARGUMENT', 'fit_to_platform is true or false.');
    if (input.stage_fits !== undefined && typeof input.stage_fits !== 'boolean')
      fail('INVALID_ARGUMENT', 'stage_fits is true or false.');
    const original = this.sources.file(actor, input.source_id),
      source = {
        ...original,
        upload_expires_at: websiteUploadDeadline(original.record),
        fit_source: {id: original.record.id as string, sha256: original.record.sha256 as string},
      },
      fits = new Map<string, Promise<StagedFit>>(),
      planned: JsonObject[] = [];
    for (const d of destinations as JsonObject[]) {
      try {
        if (
          !d ||
          typeof d !== 'object' ||
          !platforms.includes(d.platform) ||
          typeof d.account_id !== 'string' ||
          Object.keys(d).some(
            k => !['platform', 'account_id', 'connection_id', 'owner_urn', 'dv360_target'].includes(k),
          )
        )
          fail(
            'INVALID_ARGUMENT',
            'A destination is {platform, account_id, connection_id?, owner_urn?, dv360_target?}.',
          );
        const account = normalizeAccount(d.platform + '_native_action', d.account_id),
          c = this.access(actor, d.platform, account, d.connection_id);
        if (
          d.platform === 'linkedin' &&
          typeof d.owner_urn === 'string' &&
          d.owner_urn.startsWith('urn:li:organization:')
        )
          assertLinkedInOrganization(c, account, d.owner_urn);
        const {file, transform, width, height, fit_staged} = await this.platformFile(
            {...d, fit_to_platform: input.fit_to_platform},
            source,
            d.dv360_target === 'ad_asset',
            actor,
            fits,
            input.stage_fits === true,
          ),
          digest = sha256(file.bytes),
          receipts = this.matchingReceipts(actor, {
            platform: d.platform,
            account_id: account,
            connection_id: c.id,
            sha256: digest,
            ...(d.dv360_target === 'ad_asset' ? {dv360_target: 'ad_asset' as const} : {}),
            ...(typeof d.owner_urn === 'string' ? {owner_urn: d.owner_urn} : {}),
          }),
          plannedWidth = width ?? source.record.width ?? null,
          plannedHeight = height ?? source.record.height ?? null,
          // Advisory only (MED-06): the file as this destination receives it, against the provider's recorded
          // placement specifications. It never refuses the destination; the provider's own processing decides.
          placementCheck = placementPreflight(
            d.platform,
            {
              kind: file.kind,
              width: plannedWidth,
              height: plannedHeight,
              duration: file.kind === 'video' ? (source.record.duration ?? null) : null,
              size: file.bytes.length,
            },
            d.dv360_target === 'ad_asset' ? {target: 'ad_asset'} : {},
          );
        planned.push({
          platform: d.platform,
          account_id: account,
          connection_id: c.id,
          ready: true,
          file: {
            sha256: digest,
            size: file.bytes.length,
            mime: file.mime,
            width: plannedWidth,
            height: plannedHeight,
          },
          ...(placementCheck ? {placement_check: placementCheck} : {}),
          transform: transform ?? null,
          ...(fit_staged ? {fit_staged: true} : {}),
          // This exact file is already in the account: prepare with reuse_existing:true reuses it after a fresh
          // availability check instead of uploading it again (MED-03 D).
          existing_receipts: receipts.slice(0, 5).map(a => ({
            asset_id: a.id,
            media_id: a.media_id ?? null,
            sha256: a.sha256,
            processing_status: a.processing_status ?? null,
          })),
        });
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        planned.push({
          platform: d?.platform,
          account_id: d?.account_id,
          ready: false,
          error: {code: e.code, message: e.message},
        });
      }
    }
    return {
      source_id: input.source_id,
      fit_to_platform: input.fit_to_platform === true,
      ...(input.stage_fits === true ? {stage_fits: true} : {}),
      destinations: planned,
      executed: false,
      next_step:
        'For each ready destination: amcp_media prepare with this source_id, fit_to_platform and expected_sha256 set to its file.sha256 (add reuse_existing:true to reuse a listed existing receipt after a fresh availability check), then execute that review.',
    };
  }
  /**
   * A planned media step checked without preparing it again (MED-03 C), for a plan's preflight: account access and its
   * write grant, the original's access and integrity, and the exact file the platform would receive (the original, or
   * the copy its plan cached) against the step's expected_sha256 and every platform check. Nothing is read from a
   * provider, converted or staged. Undefined when a step cannot be checked this way (another kind of file, no expected
   * SHA-256, or a fitted file whose cached copy is gone): the caller prepares it as before.
   */
  async plannedMedia(actor: Actor, input: JsonObject): Promise<JsonObject | undefined> {
    if (
      typeof input.source_id !== 'string' ||
      typeof input.expected_sha256 !== 'string' ||
      !platforms.includes(input.platform) ||
      typeof input.account_id !== 'string' ||
      [
        'source_url',
        'drive_url',
        'variant_id',
        'preset',
        'existing_media_id',
        'media_type',
        'expected_mime',
        'expected_size',
      ].some(k => input[k] !== undefined)
    )
      return undefined;
    const account = normalizeAccount(input.platform + '_native_action', input.account_id),
      c = this.access(actor, input.platform, account, input.connection_id),
      adAsset = input.dv360_target === 'ad_asset';
    if (
      input.platform === 'linkedin' &&
      typeof input.owner_urn === 'string' &&
      input.owner_urn.startsWith('urn:li:organization:')
    )
      assertLinkedInOrganization(c, account, input.owner_urn);
    const record = this.sources.describe(actor, input.source_id);
    let file: {sha256: string; size: number; mime: string; kind: 'image' | 'video'} = {
        sha256: record.sha256,
        size: record.size,
        mime: record.mime,
        kind: record.kind,
      },
      cached = false;
    if (input.fit_to_platform === true) {
      const facts = await cachedFitFacts(
        this.store,
        actor.tenantId,
        {id: record.id, sha256: record.sha256},
        effectiveFitLimits(record as {kind: 'image' | 'video'; mime: string}, {
          imageBytes: mediaImageLimit(input.platform, adAsset),
          mp4Only: mp4OnlyPlatforms.includes(input.platform),
        }),
      );
      if (facts) {
        file = facts;
        cached = true;
        // A plan that found the original already fitting kept no copy: its expected file is the original itself.
      } else if (input.expected_sha256 !== record.sha256) return undefined;
    }
    assertPlatformFile(input, file, adAsset);
    return {
      sha256: file.sha256,
      size_bytes: file.size,
      mime: file.mime,
      source_id: record.id,
      fit_cached: cached,
      prepared: false,
    };
  }
  variant(actor: Actor, id: string) {
    this.store.assertActorActive(actor);
    const v = this.store.document(actor.tenantId, 'media_variant', id);
    if (!ownsRecord(actor, v) && actor.role !== 'admin')
      fail('FORBIDDEN', 'The media preview belongs to another actor.');
    if (v.expires_at <= Date.now()) fail('REVIEW_EXPIRED', 'The preview expired. Create another variant.');
    if (v.drive_connection_id) driveAccess(this.store, actor, v.drive_connection_id, v.drive_url);
    return v;
  }
  private assets(actor: Actor, input: JsonObject) {
    return this.store.documents(actor.tenantId, 'workspace_asset').filter(a => {
      if (!a.platform || !a.connection_id || !a.account_id) return false;
      try {
        this.store.resolveConnection(actor, a.platform + '_native_action', a.account_id, a.connection_id);
        return (
          (!input.platform || a.platform === input.platform) &&
          (!input.connection_id || a.connection_id === input.connection_id) &&
          (!input.account_id || a.account_id === normalizeAccount(a.platform + '_native_action', input.account_id))
        );
      } catch {
        return false;
      }
    });
  }
  private recoveryRecord(actor: Actor, review: JsonObject) {
    const p = review.plan as UploadPlan,
      claim = this.store.db
        .prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?')
        .get(actor.tenantId, review.id) as JsonObject | undefined,
      job = this.unsentJob(actor, review, !!claim),
      notSent = !!job,
      session = this.store.uploadSession(actor.tenantId, review.id),
      progress = Object.fromEntries(
        [
          'media_id',
          'resource_name',
          'bytes_confirmed',
          'total_bytes',
          'parts_confirmed',
          'finalization_started',
          'updated_at',
        ]
          .filter(k => review.progress?.[k] !== undefined)
          .map(k => [k, review.progress[k]]),
      );
    let reason: string | undefined;
    if (p.platform === 'linkedin' && p.kind === 'video') {
      const c = this.access(actor, p.platform, p.account_id, p.connection_id);
      reason = linkedInResumeReason(p, session, this.store.connectionCredentials(c), c.scopes);
      if (!reason) {
        try {
          this.ownerScope(p, c);
          if (p.source_drive) driveAccess(this.store, actor, p.source_drive.connection_id, p.source_drive.url);
        } catch {
          reason = 'source_or_owner_access_changed';
        }
      }
      // Encrypted part receipts are authoritative even if a crash preceded the public progress update.
      if (
        session?.version === 1 &&
        Array.isArray(session.uploaded_part_ids) &&
        Array.isArray(session.upload_instructions)
      ) {
        progress.parts_confirmed = session.uploaded_part_ids.length;
        progress.bytes_confirmed = session.uploaded_part_ids.length
          ? Math.min(session.upload_instructions[session.uploaded_part_ids.length - 1]?.lastByte + 1, p.size)
          : 0;
      }
    }
    const available =
      !!claim &&
      claim.state !== 'complete' &&
      p.kind === 'video' &&
      !!session &&
      (review.transfer_expires_at ?? review.expires_at) > Date.now() &&
      ((p.platform === 'google_ads' && !session.finalization_started) || (p.platform === 'linkedin' && !reason));
    return {
      review_id: review.id,
      idempotency_key: review.id,
      fingerprint: review.fingerprint,
      state_hash: review.state_hash,
      request: Object.fromEntries(
        [
          'platform',
          'account_id',
          'connection_id',
          'name',
          'mime',
          'kind',
          'filename',
          'size',
          'sha256',
          'existing_media_id',
          'owner_urn',
          'dv360_target',
          'synthetic_content',
          'library_media',
        ]
          .filter(k => p[k as keyof UploadPlan] !== undefined)
          .map(k => [k, p[k as keyof UploadPlan]]),
      ),
      journal: this.store.operationJournal(actor.tenantId, review.id),
      progress,
      // A background job that failed before any claim sent nothing: it is not_submitted and may be executed again,
      // never reported as queued (MED-02). With a claim, the claim's state is the only authority.
      state: claim?.state ?? (notSent ? 'not_submitted' : review.job_id ? 'queued' : 'unsubmitted'),
      job_id: review.job_id ?? null,
      ...(notSent
        ? {
            not_submitted: {
              job_error_code: job?.error?.code ?? null,
              provider_requests_sent: false,
              busy: mediaBusyCodes.has(job?.error?.code),
            },
          }
        : {}),
      resume_available: available,
      ...(reason ? {resume_blocked_reason: reason} : {}),
      can_execute:
        !claim &&
        (!review.job_id || (notSent && !repeatsBeforeClaim.has(job?.error?.code))) &&
        review.expires_at > Date.now(),
      expires_at: review.expires_at,
      // Set at the claim: how long a qualified resume may continue (never past a website upload's deadline).
      ...(review.transfer_expires_at ? {transfer_expires_at: review.transfer_expires_at} : {}),
    };
  }
  /** The background job of a review that has no claim, when it ended without sending anything. */
  private unsentJob(actor: Actor, review: JsonObject, claimed: boolean): JsonObject | undefined {
    if (claimed || !review.job_id) return undefined;
    try {
      const job = this.store.job(actor.tenantId, review.job_id);
      return job.state === 'failed' ? job : undefined;
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'NOT_FOUND') return undefined;
      throw e;
    }
  }
  private async reuse(actor: Actor, asset: JsonObject) {
    const review = this.store.document(actor.tenantId, 'media_review', asset.review_id),
      plan = review.plan as UploadPlan;
    this.access(actor, plan.platform, plan.account_id, plan.connection_id);
    const fresh = await this.status(actor, plan, asset);
    if (fresh.status_source !== 'provider')
      fail(
        'MEDIA_AVAILABILITY_UNVERIFIED',
        'This provider has no qualified availability lookup for this media type. Prepare a reviewed fresh upload instead.',
        {platform: plan.platform, media_id: asset.media_id},
      );
    if (fresh.ready !== true)
      fail('MEDIA_NOT_READY', 'The provider has not confirmed that this media is ready.', {
        media_id: asset.media_id,
        processing_status: fresh.processing_status,
      });
    return {
      ...fresh,
      reused: true,
      executed: false,
      availability_source: 'provider',
      availability_checked_at: Date.now(),
    };
  }
  /**
   * The size of the file an operation works on, when AMCP already holds it (a frozen review, an upload or retained
   * original, a variant), so its media admission reserves for that size (MED-02). Undefined for a link or Drive file
   * not downloaded yet, which reserves the worst case. Only sizes the reservation; every access check still follows.
   */
  private admissionSize(actor: Actor, input: JsonObject): number | undefined {
    try {
      if (['execute', 'resume'].includes(input.action) && typeof input.review_id === 'string') {
        const plan = this.store.document(actor.tenantId, 'media_review', input.review_id).plan;
        // Attaching media already on the platform holds no file bytes: the smallest reservation.
        return plan?.library_media ? 1 : plan?.size;
      }
      if (typeof input.source_id === 'string' && /^(src|lib)-[0-9a-f-]{36}$/.test(input.source_id))
        return this.store.document(
          actor.tenantId,
          input.source_id.startsWith('lib-') ? 'retained_media_source' : 'media_source',
          input.source_id,
        ).size;
      if (typeof input.variant_id === 'string' && input.source_url === undefined && input.drive_url === undefined)
        return this.store.document(actor.tenantId, 'media_variant', input.variant_id).size;
    } catch (e) {
      if (!(e instanceof MirrorError && e.code === 'NOT_FOUND')) throw e;
    }
    return undefined;
  }
  async call(input: JsonObject, actor: Actor): Promise<JsonObject> {
    this.store.assertActorActive(actor);
    if (!['prepare', 'plan', 'variant', 'inspect_eligibility', 'execute', 'resume'].includes(input.action))
      return this.handle(input, actor);
    const lease = this.store.mediaAdmission(actor.tenantId, this.admissionSize(actor, input)),
      lock = 'media-execution:' + actor.tenantId + ':' + input.review_id,
      lockOwner = randomUUID(),
      executing = ['execute', 'resume'].includes(input.action);
    if (executing && !this.store.acquireLock(lock, lockOwner, MEDIA_LEASE_MS)) {
      lease.release();
      throw new MirrorError('MEDIA_UPLOAD_BUSY', 'This frozen upload is already executing.', {}, 409, true);
    }
    let ended = false,
      lost: unknown,
      lastWall = Date.now(),
      lastTick = performance.now();
    const check = () => {
      if (ended) return;
      if (lost) throw lost;
      try {
        const wall = Date.now(),
          tick = performance.now();
        if (wall < lastWall || tick - lastTick >= MEDIA_LEASE_MS)
          throw new MirrorError(
            'MEDIA_ADMISSION_LOST',
            'The media lease lost its timing boundary. Inspect retained receipts before resuming.',
          );
        if (executing && !this.store.renewLock(lock, lockOwner, MEDIA_LEASE_MS))
          throw new MirrorError(
            'MEDIA_UPLOAD_LEASE_LOST',
            'Another worker owns this upload or its lease expired. Inspect retained receipts before resuming.',
          );
        lease.check();
        lastWall = wall;
        lastTick = tick;
      } catch (e) {
        lost = e;
        throw e;
      }
    };
    const timer = setInterval(() => {
      try {
        check();
      } catch {
        /* The next boundary fails closed; accepted receipts are retained first. */
      }
    }, 15000);
    timer.unref();
    this.store.bindActorCheck(actor, check);
    try {
      const result = await this.handle(input, actor);
      this.store.assertActorActive(actor);
      return result;
    } finally {
      ended = true;
      clearInterval(timer);
      lease.release();
      if (executing) this.store.releaseLock(lock, lockOwner);
    }
  }
  private async handle(input: JsonObject, actor: Actor): Promise<JsonObject> {
    guardInput(input);
    for (const key of Object.keys(input))
      if (!Object.hasOwn(mediaTool.inputSchema.properties, key))
        fail('INVALID_ARGUMENT', 'Unknown media parameter.', {parameter: key});
    if (input.stage_fits !== undefined && input.action !== 'plan')
      fail('INVALID_ARGUMENT', 'stage_fits applies to plan only.', {parameter: 'stage_fits'});
    this.store.assertActorActive(actor);
    if (input.action === 'retain_source')
      return this.sources.retain(actor, input.source_id, {
        confirmed: input.confirmed,
        expected_sha256: input.expected_sha256,
      });
    if (input.action === 'remove_source')
      return this.sources.remove(actor, input.source_id, {
        confirmed: input.confirmed,
        expected_sha256: input.expected_sha256,
      });
    if (input.action === 'list') {
      const offset = input.offset ?? 0,
        limit = input.limit ?? 50,
        // Recovery reviews page on their own cursor (MED-05); without one they follow `offset`, as before.
        recoveryOffset = input.recovery_offset ?? offset;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(recoveryOffset) ||
        recoveryOffset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail('INVALID_ARGUMENT', 'Invalid media pagination.');
      if (input.include_assets !== undefined && typeof input.include_assets !== 'boolean')
        fail('INVALID_ARGUMENT', 'include_assets is true or false.');
      // A page that shows only recovery and sources (the website's media page) leaves the receipts out. The working
      // client (SEC-08) keeps receipts and recovery of the accounts its profile binds, within current access.
      const client = optionalClientView(this.store, actor, input.profile_id),
        ofClient = (platform: string, account: unknown, connection: unknown) =>
          !client || client.has(platform + '_native_action', account, connection),
        withAssets = input.include_assets !== false,
        assets = withAssets
          ? this.assets(actor, input).filter(a => ofClient(a.platform, a.account_id, a.connection_id))
          : [];
      const reviews = this.store
        .documents(actor.tenantId, 'media_review')
        .filter(r => r.user_id === actor.userId)
        .filter(r => {
          const p = r.plan;
          try {
            this.access(actor, p.platform, p.account_id, p.connection_id);
            return (
              (!input.platform || p.platform === input.platform) &&
              (!input.connection_id || p.connection_id === input.connection_id) &&
              (!input.account_id ||
                p.account_id === normalizeAccount(p.platform + '_native_action', input.account_id)) &&
              ofClient(p.platform, p.account_id, p.connection_id)
            );
          } catch {
            return false;
          }
        })
        .map(r => this.recoveryRecord(actor, r))
        .filter(
          r => r.state !== 'complete' && (r.expires_at > Date.now() || ['pending', 'uncertain'].includes(r.state)),
        )
        .sort((a, b) => b.expires_at - a.expires_at);
      return {
        ...(withAssets
          ? {
              assets: assets.slice(offset, offset + limit),
              total: assets.length,
              has_more: offset + limit < assets.length,
            }
          : {}),
        recovery_reviews: reviews.slice(recoveryOffset, recoveryOffset + limit),
        recovery_total: reviews.length,
        recovery_has_more: recoveryOffset + limit < reviews.length,
        variants: this.store
          .documents(actor.tenantId, 'media_variant')
          .filter(v => (ownsRecord(actor, v) || actor.role === 'admin') && v.expires_at > Date.now())
          .filter(v => {
            try {
              this.variant(actor, v.id);
              return true;
            } catch {
              return false;
            }
          })
          .map(({drive_url, ...v}) => v),
        presets: variantPresets,
        sources: this.sources.list(actor),
        // Whether a push of several uploads runs on the server (amcp_campaign run_background, MED-03 B).
        server_push: serverPushEnabled(),
      };
    }
    if (['library', 'asset', 'save_asset_metadata', 'asset_performance'].includes(input.action))
      return creativeLibrary(this.store, actor, input);
    if (input.action === 'reuse') {
      const asset = this.assets(actor, input).find(a => a.id === input.asset_id);
      if (!asset) fail('MEDIA_NOT_READY', 'Select an upload receipt in an accessible account.');
      return this.reuse(actor, asset!);
    }
    if (input.action === 'plan') return this.planPush(input, actor);
    if (input.action === 'inspect_eligibility') {
      if (actor.role === 'reader') fail('FORBIDDEN', 'An operator is required to stage media.');
      const id = randomUUID();
      this.store.reserveMedia(actor.tenantId, id, Date.now() + 300000);
      try {
        const file = await this.source(input, actor, id);
        return {
          ...(await withWebsiteUploadDeadline(file.upload_expires_at, () =>
            inspectMediaPlacement(file.bytes, input.preset),
          )),
          sha256: sha256(file.bytes),
          size_bytes: file.bytes.length,
          executed: false,
        };
      } finally {
        this.store.removeStagedMedia(actor.tenantId, id);
      }
    }
    if (input.action === 'variant') {
      if (actor.role === 'reader') fail('FORBIDDEN', 'An operator is required to stage media.');
      if (input.variant_id !== undefined || !['source_id', 'source_url', 'drive_url'].some(k => input[k] !== undefined))
        fail('INVALID_ARGUMENT', 'Name the original file: source_id, source_url or drive_url.');
      const id = randomUUID();
      let expires = Date.now() + 300000;
      this.store.reserveMedia(actor.tenantId, id, expires);
      try {
        const file = await this.source(input, actor, id),
          converted = await withWebsiteUploadDeadline(file.upload_expires_at, () =>
            createMediaVariant(file.bytes, input.preset, input.fit),
          ),
          {bytes, ...metadata} = converted;
        if (file.upload_expires_at !== undefined) {
          expires = Math.min(expires, file.upload_expires_at);
          this.store.capStagedMediaExpiry(actor.tenantId, id, expires);
        }
        this.store.assertActorActive(actor);
        if (input.drive_connection_id) driveAccess(this.store, actor, input.drive_connection_id, input.drive_url);
        this.store.stageMedia(actor.tenantId, id, bytes);
        const record = {
          ...metadata,
          ...ownership(actor),
          drive_url: input.drive_url,
          drive_connection_id: file.source_drive?.connection_id ?? null,
          sha256: sha256(bytes),
          source_sha256: sha256(file.bytes),
          ...(file.upload_expires_at !== undefined ? {upload_expires_at: file.upload_expires_at} : {}),
          ...('origin' in file && file.origin ? {origin: file.origin} : {}),
          size: bytes.length,
          expires_at: expires,
          preview_url: '/api/media/variants/' + id + '/preview',
        };
        this.store.putDocument(actor.tenantId, 'media_variant', id, record);
        return {...record, id, variant_id: id, executed: false, client_download_required: false};
      } catch (e) {
        this.store.removeStagedMedia(actor.tenantId, id);
        throw e;
      }
    }
    if (input.action === 'prepare') {
      if (
        !platforms.includes(input.platform) ||
        typeof input.account_id !== 'string' ||
        !['source_id', 'source_url', 'drive_url', 'variant_id'].some(k => typeof input[k] === 'string')
      )
        fail(
          'INVALID_ARGUMENT',
          'prepare requires platform, account_id and one file: source_id, source_url, drive_url or variant_id.',
        );
      if (input.fit_to_platform !== undefined && typeof input.fit_to_platform !== 'boolean')
        fail('INVALID_ARGUMENT', 'fit_to_platform is true or false.');
      if (input.review_id !== undefined || input.idempotency_key !== undefined || input.confirmed !== undefined)
        fail('INVALID_ARGUMENT', 'Preparation cannot execute an upload.');
      const account = normalizeAccount(input.platform + '_native_action', input.account_id);
      if (!/^[A-Za-z0-9_-]+$/.test(account)) fail('INVALID_ARGUMENT', 'Invalid account ID.');
      const c = this.access(actor, input.platform, account, input.connection_id),
        reviewId = randomUUID();
      let expires = Date.now() + 300000;
      if (
        input.platform === 'linkedin' &&
        typeof input.owner_urn === 'string' &&
        input.owner_urn.startsWith('urn:li:organization:')
      )
        assertLinkedInOrganization(c, account, input.owner_urn);
      if (
        input.platform === 'linkedin' &&
        input.media_type === 'video' &&
        !/^urn:li:(?:organization|person):[A-Za-z0-9_-]+$/.test(input.owner_urn ?? '')
      )
        fail(
          'LINKEDIN_VIDEO_OWNER_REQUIRED',
          'LinkedIn video upload requires an explicitly bound organization or person owner; a sponsoredAccount URN is not a video owner.',
        );
      if (
        input.name !== undefined &&
        (typeof input.name !== 'string' ||
          !input.name.trim() ||
          input.name.length > 80 ||
          /[\x00-\x1f\/\\]/.test(input.name))
      )
        fail('INVALID_ARGUMENT', 'Use a media name of 1–80 characters without paths or control characters.');
      if (
        input.dv360_target !== undefined &&
        (input.platform !== 'dv360' || !['creative_asset', 'ad_asset'].includes(input.dv360_target))
      )
        fail(
          'INVALID_ARGUMENT',
          'dv360_target selects a DV360 creative asset (the default) or a Demand Gen image ad asset.',
        );
      const adAsset = input.dv360_target === 'ad_asset';
      // An existing Snapchat allocation must be owned before any Drive download.
      if (input.existing_media_id !== undefined) {
        if (
          input.platform !== 'snapchat' ||
          typeof input.existing_media_id !== 'string' ||
          !/^[-\w]+$/.test(input.existing_media_id)
        )
          fail('INVALID_ARGUMENT', 'existing_media_id identifies an existing Snapchat media allocation.');
        new ScopeGuard(this.registry, this.store).authorize(
          {...this.accountRead(input.platform, account), path: '/v1/media/' + input.existing_media_id},
          c,
        );
      }
      if (
        input.synthetic_content !== undefined &&
        (!adAsset || !['NOT_SYNTHETIC', 'IS_SYNTHETIC'].includes(input.synthetic_content))
      )
        fail('INVALID_ARGUMENT', 'synthetic_content (NOT_SYNTHETIC or IS_SYNTHETIC) labels a DV360 image ad asset.');
      if (adAsset && input.media_type !== undefined && input.media_type !== 'image')
        fail(
          'MEDIA_TYPE_UNSUPPORTED',
          'DV360 uploads only images as ad assets; YouTube video ad assets are created by video ID with DV360_ADVERTISERS_AD_ASSETS_CREATE.',
        );
      this.store.reserveMedia(actor.tenantId, reviewId, expires);
      try {
        const {file, transform} = await this.platformFile(
          input,
          await this.source(input, actor, reviewId),
          adAsset,
          actor,
        );
        if (file.upload_expires_at !== undefined) {
          expires = Math.min(expires, file.upload_expires_at);
          this.store.capStagedMediaExpiry(actor.tenantId, reviewId, expires);
        }
        const name = input.name?.trim() ?? 'AMCP media',
          p: UploadPlan = {
            platform: input.platform,
            account_id: account,
            connection_id: c.id,
            name,
            mime: file.mime,
            kind: file.kind,
            filename: name + '.' + file.extension,
            size: file.bytes.length,
            sha256: sha256(file.bytes),
            read: this.accountRead(input.platform, account),
            ...(file.source_drive ? {source_drive: file.source_drive} : {}),
            ...(file.upload_expires_at !== undefined ? {upload_expires_at: file.upload_expires_at} : {}),
            ...('origin' in file && file.origin ? {origin: file.origin} : {}),
            ...(transform ? {transform} : {}),
            ...(adAsset
              ? {
                  dv360_target: 'ad_asset' as const,
                  ...(input.synthetic_content ? {synthetic_content: input.synthetic_content} : {}),
                }
              : {}),
          };
        if (input.existing_media_id !== undefined) {
          if (
            p.platform !== 'snapchat' ||
            typeof input.existing_media_id !== 'string' ||
            !/^[-\w]+$/.test(input.existing_media_id)
          )
            fail('INVALID_ARGUMENT', 'existing_media_id identifies an existing Snapchat media allocation.');
          p.existing_media_id = input.existing_media_id;
          p.read = {...p.read, path: '/v1/media/' + p.existing_media_id};
          new ScopeGuard(this.registry, this.store).authorize(p.read, c);
        }
        if (input.owner_urn !== undefined) {
          if (
            p.platform !== 'linkedin' ||
            typeof input.owner_urn !== 'string' ||
            !/^urn:li:(?:sponsoredAccount|organization|person):[A-Za-z0-9_-]+$/.test(input.owner_urn)
          )
            fail('INVALID_ARGUMENT', 'owner_urn requires a LinkedIn account, organization or person URN.');
          if (input.owner_urn !== 'urn:li:sponsoredAccount:' + account) {
            const [, kind, owner] = /^urn:li:([^:]+):(.+)$/.exec(input.owner_urn)!;
            new ScopeGuard(this.registry, this.store).authorize(
              {
                ...p.read,
                path:
                  '/rest/' +
                  (kind === 'organization' ? 'organizations' : kind === 'person' ? 'people' : 'adAccounts') +
                  '/' +
                  owner,
              },
              c,
            );
          }
          p.owner_urn = input.owner_urn;
        }
        if (p.platform === 'dv360' && Buffer.byteLength(p.filename) > 240)
          fail('INVALID_ARGUMENT', 'DV360 filenames must fit in 240 UTF-8 bytes.');
        const matches = this.matchingReceipts(actor, p);
        if (input.reuse_existing === true && matches.length) {
          const reused = await this.reuse(actor, matches[0]!);
          this.store.removeStagedMedia(actor.tenantId, reviewId);
          return reused;
        }
        const state = await this.state(actor, p),
          stateHash = reviewStateHash(state),
          fingerprint = sha256(stable({tenant: actor.tenantId, user: actor.userId, plan: p}));
        this.access(actor, p.platform, account, c.id);
        this.store.stageMedia(actor.tenantId, reviewId, file.bytes);
        this.store.putDocument(actor.tenantId, 'media_review', reviewId, {
          user_id: actor.userId,
          created_at: Date.now(),
          plan: p,
          state,
          state_hash: stateHash,
          fingerprint,
          expires_at: expires,
        });
        this.store.appendAudit(actor.tenantId, reviewId, {
          event: 'media_prepared',
          plan: p,
          fingerprint,
          state_hash: stateHash,
        });
        return {
          success: true,
          executed: false,
          review_id: reviewId,
          upload_session_id: reviewId,
          idempotency_key: reviewId,
          expires_at: new Date(expires).toISOString(),
          request: p,
          before_state: state,
          state_hash: stateHash,
          fingerprint,
          matching_assets: matches.map(a => ({asset_id: a.id, media_id: a.media_id, sha256: a.sha256})),
          confirmation_required: true,
          steps: [
            'Upload the reviewed file to ' + p.platform,
            ...(p.platform === 'google_ads' && p.kind === 'video'
              ? ['Create an UNLISTED video on the Google-managed YouTube channel for this advertising account']
              : []),
            ...(p.platform === 'x_ads' ? ['Register it in the selected account media library'] : []),
          ],
        };
      } catch (e) {
        this.store.removeStagedMedia(actor.tenantId, reviewId);
        throw e;
      }
    }
    if (
      !['prepare_library', 'execute', 'resume', 'execute_async', 'job_status', 'status', 'recovery', 'cancel'].includes(
        input.action,
      ) ||
      typeof input.review_id !== 'string'
    )
      fail('INVALID_ARGUMENT', 'Use prepare, execute, status or cancel with a review_id.');
    if (
      [
        'platform',
        'account_id',
        'connection_id',
        'drive_url',
        'name',
        'media_type',
        'expected_mime',
        'expected_size',
        'existing_media_id',
        'owner_urn',
        'dv360_target',
        'synthetic_content',
        'drive_connection_id',
        'variant_id',
        'source_id',
        'source_url',
        'fit_to_platform',
        'destinations',
        'expected_sha256',
        'preset',
        'fit',
        'reuse_existing',
        'asset_id',
        'offset',
        'limit',
      ].some(k => input[k] !== undefined)
    )
      fail('INVALID_ARGUMENT', 'This action uses the frozen media review.');
    const review = this.store.document(actor.tenantId, 'media_review', input.review_id),
      p = review.plan as UploadPlan;
    if (review.user_id !== actor.userId)
      throw new MirrorError('FORBIDDEN', 'This media review belongs to another actor.', {}, 403);
    this.access(actor, p.platform, p.account_id, p.connection_id);
    const fingerprint = sha256(stable({tenant: actor.tenantId, user: actor.userId, plan: p}));
    if (fingerprint !== review.fingerprint) fail('REVIEW_CHANGED', 'Media review failed its integrity check.');
    const previous = this.store.db
      .prepare('SELECT state,result,fingerprint FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, input.review_id) as JsonObject | undefined;
    if (input.action === 'prepare_library') return this.prepareLibrary(actor, p, review, input.review_id, previous);
    if (input.action === 'job_status') {
      if (!review.job_id) fail('NOT_FOUND', 'No background upload was queued for this review.');
      const job = this.store.job(actor.tenantId, review.job_id);
      return {
        review_id: input.review_id,
        job_id: job.id,
        state: job.state,
        error: job.error,
        // Failed before any claim: nothing reached the platform, and execute_async queues the same review again,
        // unless the refusal would repeat (retry_available:false: prepare the upload again).
        not_submitted: job.state === 'failed' && !previous,
        ...(job.state === 'failed' && !previous
          ? {
              busy: mediaBusyCodes.has(job.error?.code),
              retry_available: !repeatsBeforeClaim.has(job.error?.code) && review.expires_at > Date.now(),
            }
          : {}),
        result: job.result,
        progress: review.progress ?? {},
        journal: this.store.operationJournal(actor.tenantId, input.review_id),
        expires_at: review.expires_at,
      };
    }
    if (input.action === 'cancel') {
      if (previous) fail('UPLOAD_ALREADY_SUBMITTED', 'An upload already submitted cannot be cancelled locally.');
      if (review.job_id)
        this.store.db
          .prepare(
            "UPDATE jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE tenant_id=? AND id=? AND state IN ('queued','running')",
          )
          .run(actor.tenantId, review.job_id);
      this.store.removeStagedMedia(actor.tenantId, input.review_id);
      this.store.putDocument(actor.tenantId, 'media_review', input.review_id, {...review, expires_at: 0});
      return {success: true, cancelled: true};
    }
    if (input.action === 'recovery') return this.recoveryRecord(actor, review);
    if (input.action === 'status') {
      const receipt = previous?.result ? JSON.parse(previous.result) : undefined;
      if (previous?.state !== 'complete' || !receipt?.media_id)
        fail('MEDIA_NOT_UPLOADED', 'There is no completed upload receipt for this review.');
      return this.status(actor, p, receipt);
    }
    if (input.confirmed !== true || (input.idempotency_key ?? input.review_id) !== input.review_id)
      fail(
        'CONFIRMATION_REQUIRED',
        'Use the returned review_id (and, when given, the same idempotency_key) with confirmed:true.',
      );
    const resumable = this.store.uploadSession(actor.tenantId, input.review_id),
      resuming = input.action === 'resume';
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        fail('IDEMPOTENCY_CONFLICT', 'This key is bound to a different request.');
      if (previous.state === 'complete') return {...JSON.parse(previous.result), replayed: true};
      if (!resuming)
        fail(
          'WRITE_OUTCOME_UNCERTAIN',
          'This upload was already submitted. Inspect its allocated media; never reupload with a new key automatically.',
        );
    }
    if (resuming) {
      if (
        !previous ||
        !['google_ads', 'linkedin'].includes(p.platform) ||
        p.kind !== 'video' ||
        !resumable ||
        resumable.finalization_started
      )
        fail(
          'RECOVERY_NOT_SAFE',
          'Only a retained video transfer with confirmed part boundaries and no finalization attempt can resume within its original review. Inspect other uncertain outcomes.',
        );
      if (p.platform === 'linkedin') {
        const c = this.access(actor, p.platform, p.account_id, p.connection_id);
        assertLinkedInResume(p, resumable, this.store.connectionCredentials(c), c.scopes);
      }
    }
    // The five-minute review governs confirmation only. A resume continues within the transfer window set at the
    // claim (MED-01 Stage D), which never outlasts a website upload's absolute deadline; older reviews keep theirs.
    const confirmBy = resuming ? (review.transfer_expires_at ?? review.expires_at) : review.expires_at;
    if (confirmBy <= Date.now()) fail('REVIEW_EXPIRED', 'Prepare and review the media again.');
    if (input.action === 'execute_async') {
      return this.store.transaction(() => {
        const current = this.store.document(actor.tenantId, 'media_review', input.review_id),
          // No claim exists here (a claimed review was refused above), so a failed job sent nothing: queue it again.
          unsent = this.unsentJob(actor, current, false);
        if (unsent && repeatsBeforeClaim.has(unsent.error?.code))
          fail(
            'MEDIA_RETRY_UNAVAILABLE',
            'This upload stopped before anything was sent, for a reason that queueing it again would repeat. Prepare the upload again; upload the file again first when its 30-minute window is nearly over.',
            {previous_error_code: unsent.error.code, provider_requests_sent: false},
          );
        if (current.job_id && !unsent)
          return {
            review_id: input.review_id,
            job_id: current.job_id,
            state: this.store.job(actor.tenantId, current.job_id).state,
          };
        const jobId = this.store.enqueue(actor.tenantId, 'media_upload', {
          review_id: input.review_id,
          // The worker retries contention only until the review expires (worker.ts).
          review_expires_at: review.expires_at,
        });
        if (unsent)
          this.store.appendAudit(actor.tenantId, input.review_id, {
            event: 'media_upload_requeued',
            previous_job_id: unsent.id,
            previous_error_code: unsent.error?.code ?? null,
            job_id: jobId,
            actor: actor.userId,
          });
        this.store.putDocument(actor.tenantId, 'media_review', input.review_id, {
          ...current,
          job_id: jobId,
          actor_binding: this.store.bindJobActor(actor, 'media-job:' + input.review_id),
        });
        return {
          review_id: input.review_id,
          job_id: jobId,
          state: 'queued',
          expires_at: new Date(review.expires_at).toISOString(),
          next_call: {tool: 'amcp_media', arguments: {action: 'job_status', review_id: input.review_id}},
        };
      });
    }
    const bytes = p.library_media ? Buffer.alloc(0) : this.store.stagedMedia(actor.tenantId, input.review_id);
    if (!p.library_media && (bytes.length !== p.size || sha256(bytes) !== p.sha256 || mediaType(bytes).mime !== p.mime))
      fail('REVIEW_CHANGED', 'The staged media failed its integrity check.');
    const expectedState = normalizeSnapshot(p.read, review.state),
      current = await this.state(actor, p),
      actual = reviewStateHash(current),
      expected = reviewStateHash(expectedState);
    if (actual !== expected)
      fail('STATE_CHANGED', 'Provider configuration changed. Prepare a new media review.', {
        expected_state_hash: expected,
        actual_state_hash: actual,
        changed_fields: changedStateFields(expectedState, current),
      });
    if (confirmBy <= Date.now()) fail('REVIEW_EXPIRED', 'Media review expired during verification.');
    assertWritesNotPaused(this.store, actor.tenantId);
    // Before any claim or provider request: refuse a transfer that cannot finish before its deadline (MED-01 Stage C).
    const startedAt = Date.now(),
      transferBy = resuming ? confirmBy : mediaTransferDeadline(p, startedAt),
      remainingBytes = resuming ? Math.max(0, p.size - (Number(review.progress?.bytes_confirmed) || 0)) : p.size,
      estimate = mediaTransferEstimateMs(p, remainingBytes);
    if (startedAt + estimate > transferBy) {
      this.store.noteMedia(actor.tenantId, 'deadline_too_close_refusals');
      throw new MirrorError(
        'UPLOAD_DEADLINE_TOO_CLOSE',
        'Too little time is left before this upload’s deadline to send it safely, so nothing was sent. Upload the file again for a new 30-minute window, then prepare it again.',
        {
          review_id: input.review_id,
          remaining_ms: Math.max(0, transferBy - startedAt),
          estimated_ms: estimate,
          deadline: new Date(transferBy).toISOString(),
          provider_requests_sent: false,
        },
        409,
      );
    }
    const held = !resuming && !p.library_media;
    if (held) this.store.holdStagedTransfer(actor.tenantId, input.review_id, transferBy);
    let claim: {fresh: boolean; result?: unknown};
    try {
      claim = resuming ? {fresh: true} : this.store.claim(actor.tenantId, input.review_id, fingerprint);
    } catch (e) {
      // This execution holds no claim: its review copy goes back to the review's own expiry instead of occupying
      // staging (and the workspace's review caps) for the whole transfer window (MED-01 review).
      if (held)
        try {
          this.store.capStagedMediaExpiry(actor.tenantId, input.review_id, review.expires_at);
        } catch {
          // Already expired or removed: nothing is held.
        }
      throw e;
    }
    if (!claim.fresh) return {...(claim.result as JsonObject), replayed: true};
    if (!resuming)
      this.store.putDocument(actor.tenantId, 'media_review', input.review_id, {
        ...this.store.document(actor.tenantId, 'media_review', input.review_id),
        transfer_expires_at: transferBy,
      });
    let allocated: JsonObject = resuming ? {...review.progress} : {};
    const record = (data: JsonObject) => {
      if (data.session) {
        this.store.saveUploadSession(actor.tenantId, input.review_id, data.session, transferBy);
        delete data.session;
      }
      if (data.finalization_started) {
        const session = this.store.uploadSession(actor.tenantId, input.review_id);
        if (session)
          this.store.saveUploadSession(
            actor.tenantId,
            input.review_id,
            {...session, finalization_started: true},
            transferBy,
          );
      }
      allocated = {...allocated, ...data};
      const current = this.store.document(actor.tenantId, 'media_review', input.review_id);
      this.store.putDocument(actor.tenantId, 'media_review', input.review_id, {
        ...current,
        progress: {...allocated, updated_at: Date.now()},
      });
      this.store.journal(
        actor.tenantId,
        input.review_id,
        data.bytes_confirmed !== undefined ? 'transferring' : 'allocated',
        allocated,
      );
      this.store.appendAudit(actor.tenantId, input.review_id, {event: 'media_allocated', ...allocated});
    };
    let receipt: JsonObject;
    // Whether any upload request left AMCP (WRT-04): a refusal before the first one releases the claim instead.
    const dispatch = {sent: false};
    try {
      const out = await trackDispatch(dispatch, () =>
        this.executionContext.run(transferBy, () =>
          this.upload(actor, p, bytes, record, resuming ? resumable : undefined),
        ),
      );
      const transferMs = Math.max(0, Date.now() - startedAt);
      this.store.noteMedia(actor.tenantId, 'transfers_completed');
      this.store.noteMedia(actor.tenantId, 'transfer_ms_total', transferMs);
      this.store.noteMedia(actor.tenantId, 'transfer_bytes_total', remainingBytes);
      receipt = {
        success: true,
        executed: true,
        ...out,
        ...this.references(p, out),
        ready: false,
        status_source: 'upload_receipt',
        handoff_status: 'pending_verification',
        review_id: input.review_id,
        fingerprint,
        sha256: p.sha256,
        platform: p.platform,
        account_id: p.account_id,
        connection_id: p.connection_id,
        media_type: p.kind,
        client_download_required: false,
        next_call: {tool: 'amcp_media', arguments: {action: 'status', review_id: input.review_id}},
      };
      this.store.transaction(() => {
        // The journal keeps the measured duration (no URLs or bytes) to tune the deadline estimate.
        this.store.complete(actor.tenantId, input.review_id, receipt, {transfer_ms: transferMs, total_bytes: p.size});
        this.store.putDocument(actor.tenantId, 'workspace_asset', input.review_id, {
          ...receipt,
          name: p.name,
          mime_type: p.mime,
          size_bytes: p.size,
          source: receiptSource(p),
          ...receiptLineage(p),
          upload_session_id: input.review_id,
        });
        this.store.removeStagedMedia(actor.tenantId, input.review_id);
        this.store.appendAudit(actor.tenantId, input.review_id, {event: 'media_uploaded', receipt});
      });
    } catch (e) {
      const error =
        e instanceof MirrorError
          ? e
          : new MirrorError(
              'WRITE_OUTCOME_UNCERTAIN',
              'Upload did not complete. Inspect the allocated media before any retry.',
              {},
              502,
            );
      // Nothing was sent (owner decision D12): the claim is released and the staged file kept, so the same review can
      // be executed again inside its window. A resumed transfer keeps its original uncertain claim.
      const unsent =
        !resuming &&
        !dispatch.sent &&
        !Object.keys(allocated).length &&
        releaseUnsentClaims() &&
        this.store.release(actor.tenantId, input.review_id, fingerprint, {
          code: error.code,
          kind: 'media',
          gateway: p.platform + '_native_action',
          account_id: p.account_id,
          connection_id: p.connection_id,
        });
      if (unsent)
        throw new MirrorError(
          error.code,
          error.message,
          {...error.details, review_id: input.review_id, submission: 'not_sent', retry_safe: true},
          error.status,
          error.retryable,
        );
      this.store.uncertain(actor.tenantId, input.review_id);
      const retained = this.store.uploadSession(actor.tenantId, input.review_id);
      if (!retained || retained.finalization_started) this.store.removeStagedMedia(actor.tenantId, input.review_id);
      this.store.appendAudit(actor.tenantId, input.review_id, {
        event: 'media_upload_incomplete',
        code: error.code,
        ...allocated,
      });
      throw new MirrorError(
        error.code,
        error.message,
        {...error.details, ...allocated, review_id: input.review_id, retry_safe: false},
        error.status,
        false,
      );
    }
    // Commit the mutation receipt before this fallible read. A processing/read failure
    // must never turn a completed upload into an uncertain, repeatable mutation.
    try {
      const checked = await this.status(actor, p, receipt);
      return {...checked, executed: true};
    } catch (e) {
      this.access(actor, p.platform, p.account_id, p.connection_id);
      const failed = e instanceof MirrorError && e.code === 'MEDIA_PROCESSING_FAILED',
        out = {
          ...receipt,
          ready: false,
          handoff_status: failed ? 'processing_failed' : 'inconclusive',
          ...(failed ? {processing_failed: true, next_call: undefined} : {}),
          verification_error: {
            code: e instanceof MirrorError ? e.code : 'MEDIA_VERIFICATION_FAILED',
            retry_safe: false,
          },
          automatic_retry_of_upload: false,
        };
      if (!failed)
        this.store.putDocument(actor.tenantId, 'workspace_asset', input.review_id, {
          ...this.store.document(actor.tenantId, 'workspace_asset', input.review_id),
          ...out,
        });
      return out;
    }
  }
  private async send(
    actor: Actor,
    p: UploadPlan,
    path: string,
    body?: JsonObject,
    options: {
      method?: string;
      query?: JsonObject;
      origin?: string;
      upload?: BinaryUpload;
      readOnly?: boolean;
      headers?: Record<string, string>;
      beforeAttempt?: () => unknown;
    } = {},
  ): Promise<TransportResult> {
    options.beforeAttempt?.();
    if (!options.readOnly && p.source_drive)
      driveAccess(this.store, actor, p.source_drive.connection_id, p.source_drive.url);
    const c = this.access(actor, p.platform, p.account_id, p.connection_id),
      auth = await this.credentials.get(c),
      current = this.access(actor, p.platform, p.account_id, p.connection_id);
    this.ownerScope(p, current);
    if (p.existing_media_id) new ScopeGuard(this.registry, this.store).authorize(p.read, current);
    if (
      !options.readOnly &&
      this.executionContext.getStore() !== undefined &&
      this.executionContext.getStore()! <= Date.now()
    )
      fail('REVIEW_EXPIRED', 'Media review expired before the next upload step.');
    const plan: CompiledRequest = {
      ...p.read,
      action: 'AMCP_REVIEWED_MEDIA',
      method: options.method ?? 'POST',
      path,
      body,
      query: options.query ?? {},
      headers: {...p.read.headers, ...options.headers},
      origin: options.origin,
      readOnly: options.readOnly ?? false,
    };
    const access = nativeAuthority(this.store, this.registry, actor, p.read, current, auth, () => {
      options.beforeAttempt?.();
      if (!options.readOnly) assertWritesNotPaused(this.store, actor.tenantId);
      const c = this.access(actor, p.platform, p.account_id, p.connection_id);
      this.ownerScope(p, c);
      if (!options.readOnly && p.source_drive)
        driveAccess(this.store, actor, p.source_drive.connection_id, p.source_drive.url);
      if (
        !options.readOnly &&
        this.executionContext.getStore() !== undefined &&
        this.executionContext.getStore()! <= Date.now()
      )
        fail('REVIEW_EXPIRED', 'Media review expired before the next upload step.');
    });
    const response = await this.transport.request(plan, access(), auth, options.upload, {beforeAttempt: access});
    if (plan.readOnly) access();
    const emptyFinalize =
      p.platform === 'linkedin' &&
      path === '/rest/videos' &&
      options.query?.action === 'finalizeUpload' &&
      [200, 204].includes(response.status) &&
      response.data !== null &&
      typeof response.data === 'object' &&
      !Array.isArray(response.data) &&
      Object.keys(response.data).length === 0;
    const googleStart =
      p.platform === 'google_ads' &&
      path.startsWith('/resumable/upload/') &&
      response.status === 200 &&
      response.headers['x-goog-upload-url'];
    if (
      !options.readOnly &&
      !emptyFinalize &&
      !googleStart &&
      response.data !== null &&
      writeOutcome(response).success !== true
    )
      fail('MEDIA_RESPONSE_INVALID', 'Provider did not confirm this upload step.');
    return response;
  }
  private async upload(
    actor: Actor,
    p: UploadPlan,
    bytes: Buffer,
    record: (v: JsonObject) => void,
    session?: JsonObject,
  ): Promise<UploadResult> {
    const binary = (field: string, part = bytes): BinaryUpload => ({
      field,
      bytes: part,
      filename: p.filename,
      mime: p.mime,
    });
    const send = async (path: string, body?: JsonObject, options?: Parameters<MediaUploadService['send']>[4]) =>
      this.send(actor, p, path, body, options);
    if (p.library_media) return this.attachLibrary(actor, p, p.library_media.id, p.library_media.key);
    if (p.platform === 'meta') {
      const r = await send(
          metaPrefix + 'act_' + p.account_id + '/' + (p.kind === 'image' ? 'adimages' : 'advideos'),
          p.kind === 'image' ? {bytes: bytes.toString('base64'), name: p.name} : {title: p.name},
          {...(p.kind === 'video' ? {upload: binary('source')} : {})},
        ),
        d = r.data as JsonObject;
      const images = d.images && (Object.values(d.images) as JsonObject[]),
        id =
          p.kind === 'video'
            ? responseId(d.id, /^\d+$/)
            : images?.length === 1
              ? responseId(images[0]!.hash)
              : fail('MEDIA_RESPONSE_INVALID', 'Meta did not return one uploaded image hash.');
      record({media_id: id});
      if (p.kind === 'video')
        this.store.rememberResource(this.access(actor, p.platform, p.account_id, p.connection_id), p.account_id, id);
      return {
        media_id: id,
        ready: p.kind === 'image',
        processing_status: p.kind === 'image' ? 'AVAILABLE' : 'PROCESSING',
      };
    }
    if (p.platform === 'google_ads') {
      if (p.kind === 'video') {
        const started = session
          ? {headers: {'x-goog-upload-url': session.url, 'x-goog-upload-chunk-granularity': session.granularity}}
          : await send(
              '/resumable/upload' + googleAdsCustomers + p.account_id + '/youTubeVideoUploads:create',
              {
                customerId: p.account_id,
                youTubeVideoUpload: {videoTitle: p.name, videoDescription: '', videoPrivacy: 'UNLISTED'},
              },
              {
                headers: {
                  'X-Goog-Upload-Protocol': 'resumable',
                  'X-Goog-Upload-Command': 'start',
                  'X-Goog-Upload-Header-Content-Length': String(bytes.length),
                },
              },
            );
        record({
          upload_session_created: true,
          session: session ?? {
            url: started.headers['x-goog-upload-url'],
            granularity: started.headers['x-goog-upload-chunk-granularity'] ?? '262144',
          },
        });
        const c = this.access(actor, p.platform, p.account_id, p.connection_id),
          auth = await this.credentials.get(c);
        this.access(actor, p.platform, p.account_id, p.connection_id);
        const access = nativeAuthority(this.store, this.registry, actor, p.read, c, auth, () => {
          assertWritesNotPaused(this.store, actor.tenantId);
          this.access(actor, p.platform, p.account_id, p.connection_id);
          if (p.source_drive) driveAccess(this.store, actor, p.source_drive.connection_id, p.source_drive.url);
          if (this.executionContext.getStore()! <= Date.now())
            fail('REVIEW_EXPIRED', 'The media review expired before the next chunk.');
        });
        access();
        const finished = await this.transport.uploadGoogleVideo(
          started.headers['x-goog-upload-url'] ?? '',
          bytes,
          auth.accessToken ?? '',
          {
            resume: !!session,
            beforeFinalize: () => record({finalization_started: true}),
            granularity: started.headers['x-goog-upload-chunk-granularity']
              ? Number(started.headers['x-goog-upload-chunk-granularity'])
              : undefined,
            beforeChunk: access,
            progress: n => record({bytes_confirmed: n, total_bytes: bytes.length}),
          },
        );
        const id = responseId(
          (finished.data as JsonObject)?.resourceName,
          new RegExp('^customers/' + p.account_id + '/youTubeVideoUploads/[A-Za-z0-9_-]+$'),
        );
        record({media_id: id});
        return {media_id: id, ready: false, processing_status: 'UPLOADED'};
      }
      const d = (
        await send(googleAdsCustomers + p.account_id + '/assets:mutate', {
          operations: [{create: {name: p.name, type: 'IMAGE', imageAsset: {data: bytes.toString('base64')}}}],
          partialFailure: false,
        })
      ).data as JsonObject;
      const id = responseId(
        d.results?.length === 1 ? d.results[0].resourceName : undefined,
        new RegExp('^customers/' + p.account_id + '/assets/[0-9]+$'),
      );
      record({media_id: id});
      return {media_id: id, ready: true, processing_status: 'AVAILABLE'};
    }
    if (p.platform === 'tiktok') {
      const kind = p.kind,
        body = {
          advertiser_id: p.account_id,
          upload_type: 'UPLOAD_BY_FILE',
          file_name: p.filename,
          [kind + '_signature']: createHash('md5').update(bytes).digest('hex'),
        };
      const d = (await send('/v1.3/file/' + kind + '/ad/upload/', body, {upload: binary(kind + '_file')}))
        .data as JsonObject;
      const data = Array.isArray(d.data) ? (d.data.length === 1 ? d.data[0] : {}) : d.data;
      if (d.code !== 0) fail('MEDIA_RESPONSE_INVALID', 'TikTok upload failed.');
      const id = responseId(data?.[kind + '_id'], /^[A-Za-z0-9_\/-]{1,512}$/);
      record({media_id: id});
      return {media_id: id, ready: true, processing_status: 'UPLOADED'};
    }
    if (p.platform === 'dv360' && p.dv360_target === 'ad_asset') {
      // adAssets.upload takes only AD_ASSET_TYPE_IMAGE; get and list return YouTube video assets only, so the receipt is the evidence.
      const d = (
          await send(
            '/upload/v4/advertisers/' + p.account_id + '/adAssets:uploadAdAsset',
            {
              filename: p.filename,
              adAssetType: 'AD_ASSET_TYPE_IMAGE',
              ...(p.synthetic_content ? {syntheticContentAttestationStatus: p.synthetic_content} : {}),
            },
            {query: {uploadType: 'multipart'}, upload: {...binary('media'), format: 'related'}},
          )
        ).data as JsonObject,
        a = d.adAsset;
      const id = responseId(a?.adAssetId, /^[1-9]\d*$/);
      record({media_id: id});
      if (
        a.adAssetType !== 'AD_ASSET_TYPE_IMAGE' ||
        (a.name !== undefined && a.name !== 'advertisers/' + p.account_id + '/adAssets/' + id) ||
        a.youtubeVideoAsset !== undefined ||
        (a.syntheticContentAttestationStatus !== undefined &&
          a.syntheticContentAttestationStatus !==
            (p.synthetic_content ?? 'SYNTHETIC_CONTENT_ATTESTATION_STATUS_UNSPECIFIED'))
      )
        fail('MEDIA_RESPONSE_INVALID', 'DV360 did not confirm this image ad asset of the selected advertiser.');
      return {
        media_id: id,
        ready: true,
        processing_status: 'UPLOADED',
        data: {
          adAsset: {
            adAssetId: id,
            adAssetType: a.adAssetType,
            ...(a.entityStatus !== undefined ? {entityStatus: a.entityStatus} : {}),
            ...(a.syntheticContentAttestationStatus !== undefined
              ? {syntheticContentAttestationStatus: a.syntheticContentAttestationStatus}
              : {}),
          },
        },
      };
    }
    if (p.platform === 'dv360') {
      const d = (
        await send(
          '/upload/v4/advertisers/' + p.account_id + '/assets',
          {filename: p.filename},
          {query: {uploadType: 'multipart'}, upload: {...binary('media'), format: 'related'}},
        )
      ).data as JsonObject;
      const id = responseId(d.asset?.mediaId, /^\d+$/);
      record({media_id: id});
      return {media_id: id, ready: true, processing_status: 'UPLOADED', data: {asset: d.asset}};
    }
    if (p.platform === 'snapchat') {
      const path = '/v1/adaccounts/' + p.account_id + '/media',
        body = {media: [{name: p.name, type: p.kind.toUpperCase(), ad_account_id: p.account_id}]};
      let id = p.existing_media_id;
      if (!id) {
        const created = (await send(path, body)).data as JsonObject,
          row = created.media?.length === 1 ? created.media[0] : undefined;
        if (
          String(created.request_status).toUpperCase() !== 'SUCCESS' ||
          String(row?.sub_request_status).toUpperCase() !== 'SUCCESS' ||
          row.media.ad_account_id !== p.account_id
        )
          fail('MEDIA_RESPONSE_INVALID', 'Snapchat did not confirm the account-bound media allocation.');
        id = responseId(row.media.id);
      }
      record({media_id: id});
      const c = this.access(actor, p.platform, p.account_id, p.connection_id);
      this.store.rememberResource(c, p.account_id, 'media/' + id);
      const d = (
        bytes.length > snapchatSimpleLimit
          ? await this.snapchatChunks(p, id, bytes, send, binary, record)
          : (await send('/v1/media/' + id + '/upload', {}, {upload: binary('file')})).data
      ) as JsonObject;
      if (
        String(d.request_status).toUpperCase() !== 'SUCCESS' ||
        d.result?.id !== id ||
        d.result?.ad_account_id !== p.account_id
      )
        fail('MEDIA_RESPONSE_INVALID', 'Snapchat did not confirm this media upload.');
      return {
        media_id: id,
        ready: d.result.media_status === 'READY',
        processing_status: d.result.media_status ?? 'PROCESSING',
      };
    }
    if (p.platform === 'linkedin') {
      const c = this.access(actor, p.platform, p.account_id, p.connection_id),
        auth = await this.credentials.get(c);
      const access = nativeAuthority(
        this.store,
        this.registry,
        actor,
        p.read,
        this.access(actor, p.platform, p.account_id, p.connection_id),
        auth,
        () => {
          assertWritesNotPaused(this.store, actor.tenantId);
          this.ownerScope(p, this.access(actor, p.platform, p.account_id, p.connection_id));
          if (p.source_drive) driveAccess(this.store, actor, p.source_drive.connection_id, p.source_drive.url);
          if (this.executionContext.getStore() !== undefined && this.executionContext.getStore()! <= Date.now())
            fail('REVIEW_EXPIRED', 'Media review expired before the next upload step.');
        },
      );
      const linkedInSend = (body: JsonObject, action: string) =>
        send('/rest/' + (p.kind === 'image' ? 'images' : 'videos'), body, {query: {action}, beforeAttempt: access});
      const request = {
        owner: p.owner_urn ?? 'urn:li:sponsoredAccount:' + p.account_id,
        mediaLibraryMetadata: {associatedAccount: 'urn:li:sponsoredAccount:' + p.account_id, assetName: p.name},
        ...(p.kind === 'video' ? {fileSizeBytes: p.size, uploadCaptions: false, uploadThumbnail: false} : {}),
      };
      if (session) {
        assertLinkedInResume(p, session, auth, c.scopes);
        access();
        const response = await send('/rest/videos/' + encodeURIComponent(session.media_id), undefined, {
          method: 'GET',
          readOnly: true,
          beforeAttempt: access,
        });
        assertLinkedInWaiting(p, session, response.data);
        access();
      }
      const d = session
          ? {
              value: {
                video: session.media_id,
                uploadToken: session.upload_token,
                uploadInstructions: session.upload_instructions,
                uploadUrlsExpireAt: session.upload_urls_expire_at,
              },
            }
          : ((await linkedInSend({initializeUploadRequest: request}, 'initializeUpload')).data as JsonObject),
        v = d.value,
        id = responseId(v?.[p.kind], new RegExp('^urn:li:' + p.kind + ':[A-Za-z0-9_-]+$'));
      record({media_id: id});
      const instructions =
        p.kind === 'image'
          ? [{uploadUrl: v.uploadUrl, firstByte: 0, lastByte: bytes.length - 1}]
          : v.uploadInstructions;
      if (!Array.isArray(instructions) || !instructions.length || instructions.length > 32)
        fail('MEDIA_RESPONSE_INVALID', 'LinkedIn returned invalid upload instructions.');
      let offset = 0;
      for (const part of instructions) {
        if (
          !part ||
          typeof part !== 'object' ||
          typeof part.uploadUrl !== 'string' ||
          part.firstByte !== offset ||
          !Number.isSafeInteger(part.lastByte) ||
          part.lastByte < offset ||
          part.firstByte >= bytes.length
        )
          fail('MEDIA_RESPONSE_INVALID', 'LinkedIn upload byte ranges do not cover the reviewed file.');
        offset = Math.min(part.lastByte + 1, bytes.length);
      }
      if (offset !== bytes.length) fail('MEDIA_RESPONSE_INVALID', 'LinkedIn upload ranges omit file bytes.');
      if (p.kind === 'video' && typeof v.uploadToken !== 'string')
        fail('MEDIA_RESPONSE_INVALID', 'LinkedIn did not return its upload token.');
      const transfer: JsonObject = session ?? linkedInTransfer(p, auth, c.scopes, id, v, instructions),
        ids: string[] = transfer.uploaded_part_ids;
      // Keep signed instructions and part receipts encrypted. Public progress contains counts only.
      record({
        session: transfer,
        bytes_confirmed: ids.length ? Math.min(instructions[ids.length - 1].lastByte + 1, bytes.length) : 0,
        total_bytes: bytes.length,
        parts_confirmed: ids.length,
      });
      for (let index = ids.length; index < instructions.length; index++) {
        const part = instructions[index];
        access();
        if (
          v.uploadUrlsExpireAt !== undefined &&
          (!Number.isSafeInteger(v.uploadUrlsExpireAt) || v.uploadUrlsExpireAt <= Date.now())
        )
          fail(
            'MEDIA_UPLOAD_URL_EXPIRED',
            'LinkedIn upload instructions expired. Inspect the allocated media before preparing another upload.',
          );
        // Persist intent before binary egress. A timeout/crash cannot make an uncertain PUT repeatable.
        transfer.part_in_flight = index;
        record({session: transfer});
        access();
        const etag = await this.transport.uploadLinkedIn(
          part.uploadUrl,
          bytes.subarray(part.firstByte, part.lastByte + 1),
          p.mime,
          p.kind === 'image' ? auth.accessToken : undefined,
        );
        if (p.kind === 'video') {
          if (!linkedInPartId(etag))
            fail('MEDIA_RESPONSE_INVALID', 'LinkedIn upload did not return a valid part identifier.');
          ids.push(etag!);
        }
        transfer.part_in_flight = null;
        record({
          session: transfer,
          bytes_confirmed: Math.min(part.lastByte + 1, bytes.length),
          total_bytes: bytes.length,
          parts_confirmed: p.kind === 'video' ? ids.length : 1,
        });
      }
      if (p.kind === 'video') {
        access();
        record({finalization_started: true});
        await linkedInSend(
          {finalizeUploadRequest: {video: id, uploadToken: v.uploadToken, uploadedPartIds: ids}},
          'finalizeUpload',
        );
      }
      return {media_id: id, ready: false, processing_status: 'PROCESSING'};
    }
    if (p.platform === 'x_ads') {
      const origin = 'https://upload.x.com',
        path = '/1.1/media/upload.json',
        category = p.kind === 'image' ? 'tweet_image' : 'amplify_video';
      let d: JsonObject;
      if (p.kind === 'image')
        d = (await send(path, {media_category: category}, {origin, upload: binary('media')})).data as JsonObject;
      else {
        d = (
          await send(
            path,
            {command: 'INIT', total_bytes: bytes.length, media_type: p.mime, media_category: category},
            {origin},
          )
        ).data as JsonObject;
        const id = responseId(d.media_id_string, /^\d+$/);
        record({media_id: id});
        for (let offset = 0, index = 0; offset < bytes.length; offset += 4 * 1024 * 1024, index++)
          await send(
            path,
            {command: 'APPEND', media_id: id, segment_index: index},
            {origin, upload: binary('media', bytes.subarray(offset, offset + 4 * 1024 * 1024))},
          );
        d = (await send(path, {command: 'FINALIZE', media_id: id}, {origin})).data as JsonObject;
        if (d.media_id_string !== id) fail('MEDIA_RESPONSE_INVALID', 'X finalized a different media identifier.');
      }
      const id = responseId(d.media_id_string, /^\d+$/);
      record({media_id: id});
      // Processing may outlive this MCP request. status reports readiness without
      // issuing a hidden library write or retrying the upload.
      const processing = d.processing_info?.state ?? 'succeeded';
      if (processing === 'failed') fail('MEDIA_PROCESSING_FAILED', 'X rejected processing of the uploaded media.');
      if (processing !== 'succeeded')
        return {media_id: id, media_key: d.media_key, ready: false, processing_status: processing};
      return this.attachLibrary(actor, p, id, d.media_key ?? id);
    }
    return fail('MEDIA_PLATFORM_UNSUPPORTED', 'Unsupported upload platform.');
  }
  private async attachLibrary(actor: Actor, p: UploadPlan, id: string, key: string): Promise<UploadResult> {
    responseId(key, /^[0-9]+_[0-9]+$/);
    const library = (
      await this.send(actor, p, '/12/accounts/' + p.account_id + '/media_library', {
        media_key: key,
        name: p.name,
        file_name: p.filename,
      })
    ).data as JsonObject;
    const libraryId = responseId(library.data?.media_key, /^[0-9]+_[0-9]+$/);
    if (libraryId !== key || libraryId.split('_').at(-1) !== id || library.data.deleted === true)
      fail('MEDIA_RESPONSE_INVALID', 'X registered a different or deleted media identifier.');
    const ready = library.data.media_status === 'TRANSCODE_COMPLETED';
    return {
      media_id: id,
      media_key: libraryId,
      library_id: libraryId,
      ready,
      processing_status: library.data.media_status ?? 'UNKNOWN',
    };
  }
  private async prepareLibrary(
    actor: Actor,
    p: UploadPlan,
    source: JsonObject,
    sourceId: string,
    previous?: JsonObject,
  ): Promise<JsonObject> {
    if (p.platform !== 'x_ads' || p.kind !== 'video' || p.library_media || previous?.state !== 'complete')
      fail('MEDIA_NOT_UPLOADED', 'This action requires a completed X video upload.');
    const receipt = JSON.parse(previous!.result);
    if (receipt.library_id) return {...receipt, executed: false, already_in_library: true};
    const pending = source.library_review_id
      ? this.store.document(actor.tenantId, 'media_review', source.library_review_id)
      : undefined;
    const view = (r: JsonObject, id: string) => ({
      success: true,
      executed: false,
      review_id: id,
      idempotency_key: id,
      expires_at: new Date(r.expires_at).toISOString(),
      request: r.plan,
      before_state: r.state,
      state_hash: r.state_hash,
      fingerprint: r.fingerprint,
      confirmation_required: true,
    });
    if (pending) {
      const claimed = this.store.db
        .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
        .get(actor.tenantId, source.library_review_id) as JsonObject | undefined;
      if (claimed) {
        if (claimed.state === 'complete')
          return {...JSON.parse(claimed.result), executed: false, already_in_library: true};
        fail('WRITE_OUTCOME_UNCERTAIN', 'A library attachment was already submitted. Inspect the account library.');
      }
      if (pending.expires_at > Date.now()) return view(pending, source.library_review_id);
    }
    const status = await this.status(actor, p, receipt),
      data = status.data;
    if (data?.media_id_string !== receipt.media_id || data.processing_info?.state !== 'succeeded')
      fail(
        'MEDIA_NOT_READY',
        'The X video is still processing or failed processing. Check status before preparing the library attachment.',
      );
    const plan: UploadPlan = {
        ...p,
        library_media: {
          id: receipt.media_id,
          key: responseId(data.media_key ?? receipt.media_id, /^(?:[0-9]+_)?[0-9]+$/),
          source_review_id: sourceId,
        },
      },
      state = await this.state(actor, plan),
      id = randomUUID();
    const review = {
      user_id: actor.userId,
      plan,
      state,
      state_hash: reviewStateHash(state),
      fingerprint: sha256(stable({tenant: actor.tenantId, user: actor.userId, plan})),
      expires_at: Date.now() + 300000,
    };
    this.store.transaction(() => {
      // Do not replace a concurrently prepared review after the asynchronous reads.
      const current = this.store.document(actor.tenantId, 'media_review', sourceId);
      if (current.library_review_id !== source.library_review_id)
        fail('LIBRARY_REVIEW_EXISTS', 'A library review was just prepared. Call prepare_library again to retrieve it.');
      this.store.putDocument(actor.tenantId, 'media_review', id, review);
      this.store.putDocument(actor.tenantId, 'media_review', sourceId, {...source, library_review_id: id});
      this.store.appendAudit(actor.tenantId, id, {event: 'media_library_prepared', source_review_id: sourceId, plan});
    });
    return view(review, id);
  }
  private async status(actor: Actor, p: UploadPlan, receipt: JsonObject): Promise<JsonObject> {
    receipt = {...receipt};
    delete receipt.next_call;
    const finish = (out: JsonObject) => {
      out.availability_checked_at = Date.now();
      out.handoff_status = out.ready === true && out.status_source === 'provider' ? 'verified' : 'pending_processing';
      const failed = ['ERROR', 'FAILED', 'PROCESSING_FAILED', 'REJECTED'].includes(
        String(out.processing_status).toUpperCase(),
      );
      if (failed) {
        delete out.next_call;
        out.ready = false;
        out.processing_failed = true;
        out.handoff_status = 'processing_failed';
      }
      this.store.putDocument(actor.tenantId, 'workspace_asset', receipt.review_id, {
        ...out,
        name: p.name,
        media_type: p.kind,
        mime_type: p.mime,
        size_bytes: p.size,
        source: receiptSource(p),
        ...receiptLineage(p),
        upload_session_id: receipt.review_id,
      });
      if (failed)
        fail(
          'MEDIA_PROCESSING_FAILED',
          'The platform rejected media processing. Inspect the retained upload before preparing a replacement.',
          {
            media_id: receipt.media_id,
            review_id: receipt.review_id,
            processing_status: out.processing_status,
            retry_safe: false,
          },
        );
      return out;
    };
    const poll = {tool: 'amcp_media', arguments: {action: 'status', review_id: receipt.review_id}};
    let r: TransportResult;
    if (p.platform === 'x_ads' && receipt.library_id) {
      const key = responseId(receipt.library_id, /^[0-9]+_[0-9]+$/),
        d = (
          await this.send(actor, p, '/12/accounts/' + p.account_id + '/media_library/' + key, undefined, {
            method: 'GET',
            readOnly: true,
          })
        ).data as JsonObject;
      if (
        d.data?.media_key !== key ||
        d.data.deleted === true ||
        (d.data.account_id !== undefined && d.data.account_id !== p.account_id)
      )
        fail('MEDIA_NOT_AVAILABLE', 'The exact registered X media is no longer accessible in the selected account.');
      const ready = d.data.media_status === 'TRANSCODE_COMPLETED';
      return finish({
        ...receipt,
        executed: false,
        ready,
        processing_status: d.data.media_status ?? 'UNKNOWN',
        status_source: 'provider',
        ...(!ready ? {next_call: poll} : {}),
      });
    }
    if (p.platform === 'meta' && p.kind === 'image') {
      const hash = responseId(receipt.media_id);
      const d = (
        await this.send(actor, p, metaPrefix + 'act_' + p.account_id + '/adimages', undefined, {
          method: 'GET',
          readOnly: true,
          query: {hashes: [hash], fields: 'hash', limit: 100},
        })
      ).data as JsonObject;
      if (!Array.isArray(d.data) || !d.data.some((image: JsonObject) => image.hash === hash))
        fail('MEDIA_NOT_AVAILABLE', 'The uploaded image is no longer accessible in the selected Meta account.');
      return finish({
        ...receipt,
        ready: true,
        executed: false,
        status_source: 'provider',
        processing_status: 'AVAILABLE',
        availability_checked_at: Date.now(),
      });
    }
    if (p.platform === 'google_ads' && p.kind === 'image') {
      const resource = responseId(receipt.media_id, new RegExp('^customers/' + p.account_id + '/assets/[0-9]+$')),
        d = (
          await this.send(
            actor,
            p,
            googleAdsCustomers + p.account_id + '/googleAds:search',
            {query: "SELECT asset.resource_name, asset.type FROM asset WHERE asset.resource_name = '" + resource + "'"},
            {readOnly: true},
          )
        ).data as JsonObject;
      if (
        d.results?.length !== 1 ||
        d.results[0].asset?.resourceName !== resource ||
        d.results[0].asset.type !== 'IMAGE'
      )
        fail('MEDIA_NOT_AVAILABLE', 'The uploaded image asset is no longer accessible.');
      return finish({
        ...receipt,
        ready: true,
        executed: false,
        status_source: 'provider',
        processing_status: 'AVAILABLE',
        availability_checked_at: Date.now(),
      });
    }
    if (p.platform === 'tiktok') {
      const id = responseId(receipt.media_id, /^[A-Za-z0-9_\/-]{1,512}$/),
        d = (
          await this.send(actor, p, '/v1.3/file/' + p.kind + '/ad/info/', undefined, {
            method: 'GET',
            readOnly: true,
            query: {advertiser_id: p.account_id, [p.kind + '_ids']: [id]},
          })
        ).data as JsonObject;
      if (
        d.code !== 0 ||
        !Array.isArray(d.data?.list) ||
        !d.data.list.some((v: JsonObject) => v[p.kind + '_id'] === id)
      )
        fail('MEDIA_NOT_AVAILABLE', 'The uploaded file is no longer accessible in the selected TikTok account.');
      return finish({
        ...receipt,
        ready: true,
        executed: false,
        status_source: 'provider',
        processing_status: 'AVAILABLE',
        availability_checked_at: Date.now(),
      });
    }
    if (p.platform === 'google_ads' && p.kind === 'video') {
      const resource = responseId(
        receipt.media_id,
        new RegExp('^customers/' + p.account_id + '/youTubeVideoUploads/[A-Za-z0-9_-]+$'),
      );
      r = await this.send(
        actor,
        p,
        googleAdsCustomers + p.account_id + '/googleAds:search',
        {
          query:
            "SELECT you_tube_video_upload.resource_name, you_tube_video_upload.video_id, you_tube_video_upload.state FROM you_tube_video_upload WHERE you_tube_video_upload.resource_name = '" +
            resource +
            "'",
        },
        {readOnly: true},
      );
      const d = r.data as JsonObject,
        v = d.results?.length === 1 ? d.results[0].youTubeVideoUpload : undefined;
      if (!v || v.resourceName !== resource)
        fail('MEDIA_RESPONSE_INVALID', 'Google did not return the exact uploaded video.');
      const ready = v.state === 'PROCESSED';
      if (ready) responseId(v.videoId, /^[A-Za-z0-9_-]{11}$/);
      const assetCall = {
        tool: 'amcp_write',
        arguments: {
          action: 'prepare',
          gateway: 'google_ads_native_action',
          connection_id: p.connection_id,
          arguments: {
            action: 'google_ads_v23_asset_mutate_assets',
            account_id: p.account_id,
            payload: {
              operations: [
                {create: {name: p.name, type: 'YOUTUBE_VIDEO', youtubeVideoAsset: {youtubeVideoId: v.videoId}}},
              ],
            },
          },
        },
      };
      return finish({
        ...receipt,
        executed: false,
        ready,
        processing_status: v.state,
        status_source: 'provider',
        ...(ready ? {video_id: v.videoId, youtube_video_id: v.videoId, next_call: assetCall} : {next_call: poll}),
      });
    }
    if (p.platform === 'snapchat')
      r = await this.send(actor, p, '/v1/media/' + receipt.media_id, undefined, {method: 'GET', readOnly: true});
    else if (p.platform === 'meta' && p.kind === 'video')
      r = await this.send(actor, p, metaPrefix + receipt.media_id, undefined, {
        method: 'GET',
        readOnly: true,
        query: {fields: 'id,status'},
      });
    else if (p.platform === 'linkedin')
      r = await this.send(
        actor,
        p,
        '/rest/' + (p.kind === 'image' ? 'images' : 'videos') + '/' + encodeURIComponent(receipt.media_id),
        undefined,
        {method: 'GET', readOnly: true},
      );
    else if (p.platform === 'x_ads' && p.kind === 'video')
      r = await this.send(actor, p, '/1.1/media/upload.json', undefined, {
        method: 'GET',
        readOnly: true,
        origin: 'https://upload.x.com',
        query: {command: 'STATUS', media_id: receipt.media_id},
      });
    else return {...receipt, executed: false, status_source: 'upload_receipt'};
    const d = r.data as JsonObject,
      state =
        p.platform === 'meta'
          ? d.status?.video_status
          : p.platform === 'linkedin'
            ? d.status
            : p.platform === 'x_ads'
              ? d.processing_info?.state
              : d.media?.[0]?.media?.media_status;
    const id = p.platform === 'x_ads' ? d.media_id_string : p.platform === 'snapchat' ? d.media?.[0]?.media?.id : d.id;
    if (
      id !== receipt.media_id ||
      (p.platform === 'snapchat' &&
        (d.request_status !== 'SUCCESS' ||
          d.media?.length !== 1 ||
          d.media[0].sub_request_status !== 'SUCCESS' ||
          d.media[0].media.ad_account_id !== p.account_id)) ||
      (p.platform === 'linkedin' &&
        (d.owner !== (p.owner_urn ?? 'urn:li:sponsoredAccount:' + p.account_id) ||
          (d.mediaLibraryMetadata?.associatedAccount !== undefined &&
            d.mediaLibraryMetadata.associatedAccount !== 'urn:li:sponsoredAccount:' + p.account_id)))
    )
      fail('MEDIA_RESPONSE_INVALID', 'The platform did not return the exact uploaded media in the selected account.');
    const ready = ['ready', 'AVAILABLE', 'succeeded', 'READY'].includes(state),
      out = {
        ...receipt,
        executed: false,
        ready,
        ...(p.platform === 'linkedin' ? {owner_urn: d.owner} : {}),
        ...(p.platform === 'x_ads'
          ? {
              data: {
                media_id_string: d.media_id_string,
                media_key: d.media_key,
                processing_info: {state: d.processing_info?.state},
              },
            }
          : {}),
        processing_status: state ?? 'UNKNOWN',
        status_source: 'provider',
        ...(!ready ? {next_call: poll} : {}),
        ...(p.platform === 'x_ads' && ready && !receipt.library_id
          ? {
              ready: false,
              next_call: {tool: 'amcp_media', arguments: {action: 'prepare_library', review_id: receipt.review_id}},
            }
          : {}),
      };
    return finish(out);
  }
  /**
   * Snapchat chunked upload ("Upload large media files", Media of the Ads API, checked 2026-09-27): INIT names the file,
   * its size and the number of parts; each part (at most 32 MB, at most 32 parts) is added to the returned add path in any
   * order, then the finalize path completes the media. Parts go only to paths of the allocated media.
   */
  private async snapchatChunks(
    p: UploadPlan,
    id: string,
    bytes: Buffer,
    send: (
      path: string,
      body?: JsonObject,
      options?: Parameters<MediaUploadService['send']>[4],
    ) => Promise<TransportResult>,
    binary: (field: string, part?: Buffer) => BinaryUpload,
    record: (v: JsonObject) => void,
  ): Promise<JsonObject> {
    const parts = Math.ceil(bytes.length / snapchatPartSize);
    if (parts > 32) fail('MEDIA_TOO_LARGE', 'Snapchat takes at most 32 parts.', {maximum_bytes: 32 * snapchatPartSize});
    const fields = {format: 'fields' as const, field: '', bytes: Buffer.alloc(0), filename: p.filename, mime: p.mime};
    const init = (
      await send(
        '/v1/media/' + id + '/multipart-upload-v2',
        {file_name: p.filename, file_size: String(bytes.length), number_of_parts: String(parts)},
        {query: {action: 'INIT'}, upload: fields},
      )
    ).data as JsonObject;
    const step = (v: unknown, action: string) => {
      const m =
        typeof v === 'string'
          ? /^(\/(?:[a-z]{2}\/)?v1\/media\/([\w-]+)\/multipart-upload-v2)\?action=([A-Z]+)$/.exec(v)
          : null;
      if (!m || m[2] !== id || m[3] !== action)
        return fail('MEDIA_RESPONSE_INVALID', 'Snapchat returned a chunked upload path for another media or action.');
      return m[1]!;
    };
    if (
      String(init.request_status).toUpperCase() !== 'SUCCESS' ||
      typeof init.upload_id !== 'string' ||
      !/^[\w-]{1,128}$/.test(init.upload_id)
    )
      fail('MEDIA_RESPONSE_INVALID', 'Snapchat did not start this chunked upload.');
    const add = step(init.add_path, 'ADD'),
      finish = step(init.finalize_path, 'FINALIZE'),
      upload = init.upload_id as string;
    record({upload_id: upload, parts_total: parts, total_bytes: bytes.length});
    for (let i = 0; i < parts; i++) {
      const part = bytes.subarray(i * snapchatPartSize, Math.min(bytes.length, (i + 1) * snapchatPartSize));
      const r = (
        await send(
          add,
          {part_number: String(i + 1), upload_id: upload},
          {query: {action: 'ADD'}, upload: binary('file', part)},
        )
      ).data as JsonObject;
      if (
        r !== null &&
        typeof r === 'object' &&
        r.request_status !== undefined &&
        String(r.request_status).toUpperCase() !== 'SUCCESS'
      )
        fail('MEDIA_RESPONSE_INVALID', 'Snapchat did not accept part ' + (i + 1) + '.');
      record({parts_confirmed: i + 1, bytes_confirmed: Math.min(bytes.length, (i + 1) * snapchatPartSize)});
    }
    record({finalization_started: true});
    return (await send(finish, {upload_id: upload}, {query: {action: 'FINALIZE'}, upload: fields})).data as JsonObject;
  }
  private references(p: UploadPlan, out: UploadResult): JsonObject {
    const id = out.media_id;
    if (p.platform === 'meta')
      return p.kind === 'image'
        ? {
            image_hash: id,
            meta_image_hash: id,
            creative_reference: {
              object_story_spec: {
                page_id: '<required Page ID>',
                link_data: {image_hash: id, link: '<required destination URL>'},
              },
            },
            required_inputs: ['Page ID with advertising permission', 'Destination URL for a website creative'],
          }
        : {video_id: id, meta_video_id: id};
    if (p.platform === 'tiktok') return {[p.kind + '_id']: id, ['tiktok_' + p.kind + '_id']: id};
    if (p.platform === 'google_ads')
      return p.kind === 'image'
        ? {google_asset_resource_name: id, uploaded_asset: {resource_name: id}}
        : {
            google_video_upload_resource_name: id,
            video_privacy: 'UNLISTED',
            channel: 'Google-managed channel associated with the advertising account',
          };
    if (p.platform === 'snapchat') return {snapchat_media_id: id, creative_reference: {top_snap_media_id: id}};
    if (p.platform === 'linkedin')
      return {
        linkedin_media_urn: id,
        [p.kind]: id,
        owner_urn: p.owner_urn ?? 'urn:li:sponsoredAccount:' + p.account_id,
      };
    if (p.platform === 'dv360' && p.dv360_target === 'ad_asset')
      return {
        dv360_ad_asset_id: id,
        dv360_target: 'ad_asset',
        ad_asset: out.data && (out.data as JsonObject).adAsset,
        creative_reference: {assetId: id},
        usage:
          'Use {assetId} in Demand Gen image fields: marketingImages, squareMarketingImages, portraitMarketingImages, logoImages, logo, companionBanner or carousel card images. DV360 checks the size and dimensions of each slot.',
      };
    if (p.platform === 'dv360') return {dv360_media_id: id, asset: out.data && (out.data as JsonObject).asset};
    return {x_media_key: out.media_key ?? id};
  }
}
