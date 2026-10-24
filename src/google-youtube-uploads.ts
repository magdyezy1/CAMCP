import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {googleAdsCustomers} from './google-version.js';
import {defineFamily, fail, readOf} from './family-kit.js';

/**
 * YouTube video uploads made through the Google Ads API, v23 (pinned Discovery document: YouTubeVideoUploadService
 * UpdateYouTubeVideoUpload and RemoveYouTubeVideoUpload, and YouTubeVideoUpload; checked 2026-09-27). "Updates YouTube
 * video's metadata, but only for videos uploaded using this API": the title, description and channel are immutable, and
 * the privacy (PUBLIC or UNLISTED) is "only mutable for videos uploaded to the advertiser owned (brand) YouTube channel";
 * Google-managed channel videos stay UNLISTED. Removal "removes YouTube videos uploaded using this API".
 */
type Kind = 'update' | 'remove';
type Read = CompiledRequest & {googleUploadState?: {uploads: string[]}};
const maxRemovals = 20,
  privacies = ['PUBLIC', 'UNLISTED'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_GOOGLE_YOUTUBE_UPLOAD', message);
}
function unverified(message: string): never {
  return fail('YOUTUBE_UPLOAD_STATE_UNVERIFIED', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.');
  return id!;
};
export function googleUploadKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== 'google_ads_native_action' ||
    p.method !== 'POST' ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://googleads.googleapis.com')
  )
    return;
  const m = /^\/v\d+\/customers\/\d+\/youTubeVideoUploads:(update|remove)$/.exec(p.path);
  return m ? (m[1] as Kind) : undefined;
}
const uploadPattern = (p: CompiledRequest) =>
  new RegExp('^customers/' + account(p) + '/youTubeVideoUploads/[1-9][0-9]*$');
function uploads(p: CompiledRequest): string[] {
  const b = googleJson(p.body) ?? {};
  return googleUploadKind(p) === 'update'
    ? [String(b.youTubeVideoUpload?.resourceName)]
    : ((b.resourceNames ?? []) as unknown[]).map(String);
}
export function assertGoogleUploads(p: CompiledRequest): void {
  const kind = googleUploadKind(p);
  if (!kind) return;
  if (p.path.split('/')[3] !== account(p))
    fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected customer.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('These reviews take no query or header overrides.');
  const b = googleJson(p.body);
  if (!object(b)) invalid('Send the native request object.');
  if (kind === 'update') {
    if (Object.keys(b).some(k => !['youTubeVideoUpload', 'updateMask'].includes(k)) || b.updateMask !== 'videoPrivacy')
      invalid(
        'Send {youTubeVideoUpload: {resourceName, videoPrivacy}, updateMask: "videoPrivacy"}: the title, description and channel cannot change.',
      );
    const u = b.youTubeVideoUpload;
    if (
      !object(u) ||
      Object.keys(u).some(k => !['resourceName', 'videoPrivacy'].includes(k)) ||
      typeof u.resourceName !== 'string' ||
      !uploadPattern(p).test(u.resourceName)
    )
      invalid('youTubeVideoUpload is {resourceName: customers/{customer}/youTubeVideoUploads/{upload}, videoPrivacy}.');
    if (!privacies.includes(u.videoPrivacy)) invalid('videoPrivacy is PUBLIC or UNLISTED.');
    return;
  }
  if (
    Object.keys(b).some(k => k !== 'resourceNames') ||
    !Array.isArray(b.resourceNames) ||
    !b.resourceNames.length ||
    b.resourceNames.length > maxRemovals
  )
    invalid('Send resourceNames with 1–' + maxRemovals + ' uploads.');
  if (
    b.resourceNames.some((r: unknown) => typeof r !== 'string' || !uploadPattern(p).test(r)) ||
    new Set(b.resourceNames).size !== b.resourceNames.length
  )
    invalid('resourceNames lists distinct customers/{customer}/youTubeVideoUploads/{upload} of the selected customer.');
}
const quote = (v: string[]) => v.map(n => "'" + n + "'").join(', ');
function read(p: CompiledRequest, query: string): Read {
  return readOf<Read>(
    p,
    {
      action: 'AMCP_GOOGLE_YOUTUBE_UPLOAD_READ',
      method: 'POST',
      path: googleAdsCustomers + account(p) + '/googleAds:search',
      body: {query},
      query: {},
      clears: ['responseControls'],
    },
    {googleUploadState: undefined},
  );
}
const customerQuery = 'SELECT customer.id FROM customer LIMIT 1';
export function googleUploadSnapshots(p: CompiledRequest): Read[] {
  return [{...read(p, customerQuery), googleUploadState: {uploads: [...uploads(p)].sort()}}];
}
export function isGoogleUploadRead(p: CompiledRequest): p is Read {
  return !!(p as Read).googleUploadState;
}
const rows = (r: TransportResult): JsonObject[] => {
  const d = r.data;
  if (r.status !== 200 || !object(d) || (d.results !== undefined && !Array.isArray(d.results)) || d.nextPageToken)
    unverified('Google returned a failed, paged or unrecognized search response.');
  const out = (d.results ?? []) as unknown[];
  if (out.some(v => !object(v))) unverified('A search row is malformed.');
  return out as JsonObject[];
};
/** The uploads named, and the video assets of the customer that point at their videos. */
export async function readGoogleUploads(
  p: CompiledRequest,
  send: (p: Read) => Promise<TransportResult>,
): Promise<TransportResult> {
  const c = (p as Read).googleUploadState;
  if (!c) return send(p);
  const customer = rows(await send({...(p as Read), googleUploadState: undefined}));
  if (customer.length !== 1 || !object(customer[0]!.customer) || String(customer[0]!.customer.id) !== account(p))
    unverified('Verify the selected customer.');
  const found: JsonObject = {};
  for (const r of rows(
    await send(
      read(
        p,
        'SELECT you_tube_video_upload.resource_name, you_tube_video_upload.video_upload_id, you_tube_video_upload.channel_id, you_tube_video_upload.video_id, you_tube_video_upload.state, you_tube_video_upload.video_privacy FROM you_tube_video_upload WHERE you_tube_video_upload.resource_name IN (' +
          quote(c.uploads) +
          ')',
      ),
    ),
  )) {
    const v = object(r.youTubeVideoUpload) ? r.youTubeVideoUpload : {},
      name = String(v.resourceName);
    if (!c.uploads.includes(name) || Object.hasOwn(found, name)) unverified('An upload row is foreign or repeated.');
    found[name] = {
      videoId: v.videoId ?? null,
      channelId: v.channelId || null,
      state: v.state ?? null,
      videoPrivacy: v.videoPrivacy ?? null,
    };
  }
  const videos = Object.values(found)
    .map(u => (u as JsonObject).videoId)
    .filter((v): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(v));
  const assets: JsonObject = {};
  if (videos.length)
    for (const r of rows(
      await send(
        read(
          p,
          "SELECT asset.resource_name, asset.youtube_video_asset.youtube_video_id FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' AND asset.youtube_video_asset.youtube_video_id IN (" +
            quote(videos) +
            ')',
        ),
      ),
    )) {
      const v = object(r.asset) ? r.asset : {},
        video = String(v.youtubeVideoAsset?.youtubeVideoId ?? '');
      if (!videos.includes(video)) unverified('A video asset row is foreign.');
      (assets[video] as string[] | undefined)?.push(String(v.resourceName)) ??
        (assets[video] = [String(v.resourceName)]);
    }
  return {status: 200, headers: {}, data: {customer: {id: account(p)}, uploads: found, assets}};
}
export function validateGoogleUploadState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data;
  if (
    !(p as Read).googleUploadState ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.customer) ||
    d.customer.id !== account(p) ||
    !object(d.uploads) ||
    !object(d.assets)
  )
    unverified('Complete YouTube upload state is missing.');
}
export function googleUploadPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = googleUploadKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.uploads)) unverified('Complete YouTube upload state is missing.');
  for (const name of uploads(p)) {
    const u = s.uploads[name];
    if (!object(u))
      fail(
        'STATE_TARGET_MISMATCH',
        'Upload ' + name + ' is not a YouTube video upload of the selected customer.',
        {upload: name},
        409,
      );
    if (kind === 'remove') continue;
    if (!u.channelId)
      invalid(
        'Upload ' +
          name +
          ' went to the Google-managed channel, where videos stay UNLISTED; only brand channel videos change privacy.',
      );
    if (!['UPLOADED', 'PROCESSED'].includes(String(u.state)))
      invalid('Upload ' + name + ' is ' + String(u.state) + '; privacy changes need an uploaded video.');
    if (u.videoPrivacy === googleJson(p.body).youTubeVideoUpload.videoPrivacy)
      invalid('Upload ' + name + ' is already ' + String(u.videoPrivacy) + '.');
  }
}
/** Removal deletes the YouTube video. */
export function googleUploadRemoves(p: CompiledRequest): boolean {
  return googleUploadKind(p) === 'remove';
}
export function googleUploadImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = googleUploadKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    found = object(s.uploads) ? s.uploads : {},
    assets = object(s.assets) ? s.assets : {};
  const items = uploads(p).map(n => {
    const u = found[n];
    const video = object(u) ? u.videoId : null;
    return {
      upload: n,
      before: object(u) ? u : null,
      video_assets: typeof video === 'string' ? (assets[video] ?? []) : [],
    };
  });
  const used = items.some(i => (i.video_assets as unknown[]).length > 0);
  return {
    provider: 'google',
    scope: 'youtube_video_upload',
    operation: kind,
    uploads: items,
    may_affect_serving: kind === 'remove' ? used : true,
    irreversible: kind === 'remove',
    ...(kind === 'update' ? {privacy: googleJson(p.body).youTubeVideoUpload.videoPrivacy} : {}),
    effect:
      kind === 'remove'
        ? 'Deletes these videos from YouTube. ' +
          (used
            ? 'Video assets of the account point at them; ads using them stop showing the video.'
            : 'No video asset of the account points at them.')
        : 'Changes who can find the video on YouTube: PUBLIC videos appear in search and on the channel; UNLISTED videos play only by link or in ads.',
    verification:
      kind === 'remove'
        ? 'Reads the uploads again and expects them to be gone or unavailable.'
        : 'Reads the upload again and compares its privacy.',
    source: 'https://developers.google.com/google-ads/api/reference/rpc/v25/YouTubeVideoUploadService',
  };
}
export function googleUploadOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = googleUploadKind(p)!,
    d = r.data,
    names = uploads(p);
  if (r.status !== 200 || !object(d)) return false;
  if (kind === 'update') return d.resourceName === names[0];
  return (
    Array.isArray(d.resourceNames) &&
    d.resourceNames.length === names.length &&
    names.every(n => d.resourceNames.includes(n))
  );
}
export function googleUploadVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = googleUploadKind(p)!,
    names = uploads(p),
    probe: Read = {...read(p, customerQuery), googleUploadState: {uploads: [...names].sort()}};
  const privacy = kind === 'update' ? googleJson(p.body).youTubeVideoUpload.videoPrivacy : undefined;
  return [
    {
      read: probe,
      expected: {
        uploads: Object.fromEntries(
          names.map(n => [n, kind === 'remove' ? {gone: true} : {gone: false, videoPrivacy: privacy}]),
        ),
      },
      id: names.join(','),
    },
  ];
}
export function googleUploadObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const found = object(data.uploads) ? data.uploads : {},
    names = (read as Read).googleUploadState?.uploads ?? [];
  return {
    uploads: Object.fromEntries(
      names.map(n => {
        const u = found[n];
        return [n, object(u) ? {gone: u.state === 'UNAVAILABLE', videoPrivacy: u.videoPrivacy} : {gone: true}];
      }),
    ),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleUploadFamily: ReviewedFamily = defineFamily({
  name: 'google_youtube_uploads',
  files: ['src/google-youtube-uploads.ts', ['tests/google-youtube-uploads.test.mjs']],
  kind: googleUploadKind,
  assert: assertGoogleUploads,
  scope: assertGoogleAdsScope,
  snapshots: googleUploadSnapshots,
  isRead: isGoogleUploadRead,
  reader: readGoogleUploads,
  validateState: validateGoogleUploadState,
  prerequisites: googleUploadPrerequisites,
  impact: googleUploadImpact,
  outcome: googleUploadOutcome,
  verification: googleUploadVerification,
  observed: googleUploadObserved,
  exemptFromSpendTextMatch: true,
  destructive: googleUploadRemoves,
});
