import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';

/**
 * Removing videos from a Meta ad account's video library, Marketing API ("Ad Account Advideos" reference, Deleting; read
 * 2026-09-29, and DELETE /advideos with `video_id` in Meta's official Business SDK at 25.0.3 and 26.0.2):
 * DELETE act_{ad_account_id}/advideos with the required `video_id` ("Ad account library video ID") "dissociate[s] a
 * Video from an AdAccount" and answers {success}. Meta does not say what becomes of creatives that use the video, so
 * AMCP reads every creative of the account first and refuses a video any of them names (deleted creatives aside). The
 * library list takes no ID filter, so both lists are read to their end, in bounded pages.
 */
type Read = CompiledRequest & {metaVideoState?: {video: string; creatives: boolean}};
const gateway = 'meta_native_action',
  maxPages = 10,
  pageSize = 100,
  videoPattern = /^[1-9][0-9]{0,31}$/;
const creativeFields = 'id,name,status,video_id,object_story_spec,asset_feed_spec,platform_customizations';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
const source = 'https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/';
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_META_AD_VIDEO', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function metaVideoKind(p: CompiledRequest): 'delete' | undefined {
  if (p.gateway !== gateway || (p.origin && p.origin !== 'https://graph.facebook.com') || p.specialTransport) return;
  return p.method === 'DELETE' && metaRoute('act_[1-9][0-9]{0,31}/advideos$').test(p.path) ? 'delete' : undefined;
}
const videoOf = (p: CompiledRequest) => String(p.query.video_id);
export function assertMetaVideo(p: CompiledRequest): void {
  if (!metaVideoKind(p)) return;
  if (account(p.path.split('/')[2]) !== account(p.accountId))
    fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected ad account.', {}, 403);
  if (Object.keys(p.headers).length || (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length)))
    invalid('Video removal takes only video_id, without a body or header overrides.');
  const extra = Object.keys(p.query).filter(k => k !== 'video_id');
  if (extra.length) invalid('Video removal takes only video_id; unqualified parameters: ' + extra.join(', ') + '.');
  if (typeof p.query.video_id !== 'string' || !videoPattern.test(p.query.video_id))
    invalid('video_id is the numeric ID of a video in the ad account library.');
}
export function assertMetaVideoScope(c: Connection, write = false): void {
  if (write ? !c.scopes.includes('ads_management') : !c.scopes.some(s => s === 'ads_management' || s === 'ads_read'))
    fail('INSUFFICIENT_SCOPE', 'Reconnect Meta with ads_management to remove ad videos.', {}, 403);
}
const list = (p: CompiledRequest, edge: string, fields: string): CompiledRequest => ({
  ...p,
  action: 'AMCP_META_VIDEO_READ',
  method: 'GET',
  path: metaPrefix + 'act_' + account(p.accountId) + edge,
  query: {fields, limit: String(pageSize)},
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
});
const read = (p: CompiledRequest, creatives: boolean): Read => ({
  ...list(p, '/advideos', 'id,title,created_time,updated_time'),
  metaVideoState: {video: videoOf(p), creatives},
});
export function metaVideoSnapshots(p: CompiledRequest): Read[] {
  return [read(p, true)];
}
export function isMetaVideoRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).metaVideoState;
}
/** Whether a creative's fields name the video anywhere (video_id keys in story, asset feed or customizations). */
function names(value: unknown, video: string, depth = 0): boolean {
  if (depth > 12) return false;
  if (Array.isArray(value)) return value.some(v => names(v, video, depth + 1));
  if (!object(value)) return false;
  return Object.entries(value).some(([k, v]) =>
    k === 'video_id' && (typeof v === 'string' || typeof v === 'number')
      ? String(v) === video
      : names(v, video, depth + 1),
  );
}
/** The video in the account library, and with a review the creatives of the account that name it. */
export async function readMetaVideos(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaVideoState;
  if (!s) return fetch(p);
  const all = async (first: CompiledRequest, label: string) => {
    const rows: JsonObject[] = [];
    let q = first;
    for (let page = 0; ; page++) {
      if (page >= maxPages)
        unverified('The ad account has more ' + label + ' than one review reads (' + maxPages * pageSize + ').');
      const r = await fetch(q),
        d = r.data;
      if (r.status !== 200 || !object(d) || !Array.isArray(d.data)) unverified('Meta did not list the ' + label + '.');
      for (const row of d.data as unknown[]) if (object(row)) rows.push(row);
      const after = object(d.paging) && object(d.paging.cursors) ? d.paging.cursors.after : undefined;
      if (!(object(d.paging) && d.paging.next)) return rows;
      if (typeof after !== 'string' || !after) unverified('Meta listed more ' + label + ' without a cursor.');
      q = {...q, query: {...q.query, after}};
    }
  };
  const videos = (await all({...(p as Read), metaVideoState: undefined} as Read, 'library videos')).filter(
    v => String(v.id) === s.video,
  );
  if (videos.length > 1) unverified('Meta listed video ' + s.video + ' more than once.');
  const v = videos[0];
  const out: JsonObject = {
    account_id: account(p.accountId),
    video: v
      ? {present: true, id: s.video, title: v.title ?? null, created_time: v.created_time ?? null}
      : {present: false, id: s.video},
  };
  if (s.creatives) {
    const creatives = await all(list(p, '/adcreatives', creativeFields), 'creatives');
    out.creatives_read = creatives.length;
    out.used_by = creatives
      .filter(c => c.status !== 'DELETED' && names(c, s.video))
      .map(c => String(c.id))
      .sort();
  }
  return {status: 200, headers: {}, data: out};
}
export function validateMetaVideoState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).metaVideoState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || !object(d.video) || s.creatives !== Array.isArray(d.used_by))
    unverified('Missing verified ad video state.');
}
export function metaVideoPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!metaVideoKind(p)) return;
  const s = states[0],
    video = object(s) && object(s.video) ? s.video : undefined;
  if (!video || !Array.isArray((s as JsonObject).used_by)) unverified('Missing verified ad video state.');
  if (video.present !== true)
    fail('STATE_NOT_FOUND', 'Video ' + videoOf(p) + ' is not in the library of the selected ad account.', {
      video_id: videoOf(p),
    });
  const used = (s as JsonObject).used_by as string[];
  if (used.length)
    fail(
      'MEDIA_IN_USE',
      'Video ' +
        videoOf(p) +
        ' is used by ' +
        used.length +
        ' creative(s) of the ad account. Meta does not document what removing it does to them.',
      {
        video_id: videoOf(p),
        creative_ids: used,
        source,
        next_action:
          'Delete or replace those creatives (and the ads using them) in separate reviews first, or keep the video.',
      },
      409,
    );
}
export function metaVideoImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!metaVideoKind(p)) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {};
  return {
    provider: 'meta',
    scope: 'ad_video',
    operation: 'delete',
    video: object(s.video) ? s.video : null,
    creatives_read: s.creatives_read ?? null,
    may_affect_serving: false,
    effect:
      'Removes the video from the ad account video library (Meta: "dissociate a Video from an AdAccount"). No creative of the account names it in its fields (a creative built from an existing post is checked by its own fields only); existing ads are not changed.',
    verification: 'Lists the library videos again and expects this video to be gone.',
    source,
  };
}
export function metaVideoOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && object(r.data) && r.data.success === true;
}
export function metaVideoVerification(p: CompiledRequest): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  return [{read: read(p, false), expected: {video: {present: false}}, id: 'ad video ' + videoOf(p)}];
}
export function metaVideoObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {video: object(data.video) ? {present: data.video.present} : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaVideoFamily: ReviewedFamily = {
  name: 'meta_ad_videos',
  files: ['src/meta-ad-videos.ts', ['tests/meta-ad-videos.test.mjs']],
  kind: metaVideoKind,
  assert: assertMetaVideo,
  scope: assertMetaVideoScope,
  snapshots: metaVideoSnapshots,
  isRead: isMetaVideoRead,
  reader: readMetaVideos,
  validateState: validateMetaVideoState,
  prerequisites: metaVideoPrerequisites,
  impact: metaVideoImpact,
  outcome: metaVideoOutcome,
  verification: metaVideoVerification,
  observed: metaVideoObserved,
  exemptFromSpendTextMatch: true,
};
