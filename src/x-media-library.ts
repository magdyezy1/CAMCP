import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';

/**
 * Media library and account media of an X Ads account, Ads API v12 (Creatives reference, "Media Library" and "Account
 * Media"; docs.x.com copy read on 2026-09-27). PUT media_library/:media_key changes the name (up to 100 characters), file
 * name (255) and, for videos, the title (70), description (200) and poster image; DELETE removes the item from the library;
 * DELETE account_media/:id removes an account media asset such as a PREROLL video. X does not say what happens to cards
 * and media creatives that use a deleted item, so AMCP refuses to delete media they still use.
 */
type Kind = 'library_update' | 'library_delete' | 'account_media_delete';
type State = {mediaKey?: string; accountMediaId?: string; posterKey?: string; usage?: boolean; optional?: boolean};
type Read = CompiledRequest & {xMediaState?: State};
const gateway = 'x_ads_native_action',
  mediaKey = /^[0-9]{1,3}_[0-9]{1,25}$/;
const limits: Record<string, number> = {name: 100, file_name: 255, title: 70, description: 200},
  videoOnly = ['title', 'description', 'poster_media_key'],
  moving = ['VIDEO', 'GIF'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_X_MEDIA_LIBRARY', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function xMediaKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport) return;
  if (
    ['PUT', 'DELETE'].includes(p.method) &&
    /^\/12\/accounts\/[a-z0-9]{1,32}\/media_library\/[A-Za-z0-9_]{1,48}$/.test(p.path)
  )
    return p.method === 'PUT' ? 'library_update' : 'library_delete';
  if (p.method === 'DELETE' && /^\/12\/accounts\/[a-z0-9]{1,32}\/account_media\/[a-z0-9]{1,32}$/.test(p.path))
    return 'account_media_delete';
  return;
}
const account = (p: CompiledRequest) => p.path.split('/')[3]!,
  targetOf = (p: CompiledRequest) => p.path.split('/')[5]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
export function assertXMedia(p: CompiledRequest): void {
  const kind = xMediaKind(p);
  if (!kind) return;
  if (account(p) !== p.accountId) fail('ACCOUNT_SCOPE_MISMATCH', 'The request must use the selected account.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers ?? {}).length)
    invalid('Media library writes take their parameters in the body, without query or header overrides.');
  if (kind !== 'account_media_delete' && !mediaKey.test(targetOf(p)))
    invalid('The path names a media library key such as 3_1234567890.');
  if (kind !== 'library_update') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length)) invalid('A deletion takes no body.');
    return;
  }
  const b = p.body;
  if (!object(b) || !Object.keys(b).length) invalid('Send name, file_name, title, description or poster_media_key.');
  const extra = Object.keys(b).filter(k => !(k in limits) && k !== 'poster_media_key');
  if (extra.length)
    invalid(
      (extra.includes('media_key') ? 'The media key is in the path and never changes. ' : '') +
        'Unqualified fields: ' +
        extra.join(', ') +
        '.',
    );
  for (const [k, max] of Object.entries(limits)) {
    if (b[k] === undefined) continue;
    const v = b[k];
    if (typeof v !== 'string' || !v.trim() || v !== v.trim() || [...v].length > max || /[\u0000-\u001f\u007f]/.test(v))
      invalid(k + ' has 1–' + max + ' characters without surrounding spaces or control characters.');
  }
  if (
    b.poster_media_key !== undefined &&
    (typeof b.poster_media_key !== 'string' || !mediaKey.test(b.poster_media_key))
  )
    invalid('poster_media_key is the media key of an image in the media library.');
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): Read {
  return stateReadOf<Read>(p, 'AMCP_X_MEDIA_READ', '/12/accounts/' + account(p) + path, query, {
    xMediaState: undefined,
  });
}
const stateRead = (p: CompiledRequest, state: State): Read => ({...read(p, ''), xMediaState: state});
/** One marked read of the account; the reader adds the item, the poster image and, for deletions, what still uses the item. */
export function xMediaSnapshots(p: CompiledRequest): Read[] {
  const kind = xMediaKind(p)!,
    poster = body(p).poster_media_key;
  return [
    stateRead(
      p,
      kind === 'account_media_delete'
        ? {accountMediaId: targetOf(p), usage: true}
        : {
            mediaKey: targetOf(p),
            ...(kind === 'library_update' && typeof poster === 'string' ? {posterKey: poster} : {}),
            ...(kind === 'library_delete' ? {usage: true} : {}),
          },
    ),
  ];
}
export function isXMediaRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).xMediaState;
}
const notFound = (e: unknown) => e instanceof MirrorError && e.code === 'UPSTREAM_ERROR' && e.status === 404;
const mediaView = (m: JsonObject) => ({
  present: true,
  key: String(m.media_key),
  type: m.media_type ?? null,
  status: m.media_status ?? null,
  name: m.name ?? null,
  fileName: m.file_name ?? null,
  title: m.title ?? null,
  description: m.description ?? null,
  posterKey: m.poster_media_key ?? null,
  tweeted: m.tweeted === true,
  deleted: m.deleted === true,
  gone: m.deleted === true,
});
/** True when a string anywhere in the card (components, media_keys, legacy media fields) is the key. */
function mentions(v: unknown, key: string, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof v === 'string') return v === key;
  if (Array.isArray(v)) return v.some(x => mentions(x, key, depth + 1));
  return object(v) && Object.values(v).some(x => mentions(x, key, depth + 1));
}
export async function readXMedia(
  p: CompiledRequest,
  send: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).xMediaState;
  if (!s) return send(p);
  let requests = 0;
  const get = async (q: Read) => {
    if (++requests > 30) unverified('Media reads exceeded their bound.');
    const r = await send(q),
      d = r.data;
    if (r.status !== 200 || !object(d) || (Array.isArray(d.errors) && d.errors.length))
      unverified('X returned a failed or unrecognized read.');
    return d as JsonObject;
  };
  const one = async (path: string, query: JsonObject, label: string, id: string) => {
    try {
      return (await get(read(p, path, query))).data;
    } catch (e) {
      if (!notFound(e)) throw e;
      if (!s.optional) fail('STATE_NOT_FOUND', label + ' ' + id + ' is not in the selected account.', {id}, 404);
      return null;
    }
  };
  const all = async (path: string, query: JsonObject, pages: number, label: string) => {
    const rows: JsonObject[] = [];
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= pages) unverified('The account has more ' + label + ' than one review reads.');
      const listed = await get(read(p, path, {...query, ...(cursor ? {cursor} : {})}));
      if (!Array.isArray(listed.data)) unverified('X did not list the ' + label + '.');
      for (const row of listed.data as unknown[]) {
        if (!object(row)) unverified('A row of the ' + label + ' is malformed.');
        if (row.deleted !== true) rows.push(row);
      }
      if (!listed.next_cursor) return rows;
      if (typeof listed.next_cursor !== 'string' || listed.next_cursor === cursor)
        unverified('Pagination of the ' + label + ' is repeated or malformed.');
      cursor = listed.next_cursor;
    }
  };
  const acct = await get(read(p, ''));
  if (!object(acct.data) || String(acct.data.id) !== account(p)) unverified('X returned another account.');
  const out: JsonObject = {accountId: account(p)};
  if (s.mediaKey) {
    const m = await one('/media_library/' + s.mediaKey, {}, 'Media', s.mediaKey);
    if (m === null) out.media = {present: false, key: s.mediaKey, gone: true};
    else {
      if (!object(m) || String(m.media_key) !== s.mediaKey)
        fail('STATE_TARGET_MISMATCH', 'X returned other media for ' + s.mediaKey + '.', {media_key: s.mediaKey}, 409);
      out.media = mediaView(m);
    }
  }
  if (s.posterKey) {
    const m = await one('/media_library/' + s.posterKey, {}, 'Poster image', s.posterKey);
    if (!object(m) || String(m.media_key) !== s.posterKey)
      fail(
        'STATE_TARGET_MISMATCH',
        'X returned other media for poster ' + s.posterKey + '.',
        {media_key: s.posterKey},
        409,
      );
    out.poster = mediaView(m);
  }
  if (s.accountMediaId) {
    const m = await one('/account_media/' + s.accountMediaId, {with_deleted: true}, 'Account media', s.accountMediaId);
    if (m === null) out.accountMedia = {present: false, id: s.accountMediaId, gone: true};
    else {
      if (!object(m) || String(m.id) !== s.accountMediaId)
        fail(
          'STATE_TARGET_MISMATCH',
          'X returned other account media for ' + s.accountMediaId + '.',
          {account_media_id: s.accountMediaId},
          409,
        );
      out.accountMedia = {
        present: true,
        id: s.accountMediaId,
        creativeType: m.creative_type ?? null,
        videoKey: m.video_id ?? null,
        deleted: m.deleted === true,
        gone: m.deleted === true,
      };
    }
  }
  if (s.usage) {
    let assets = s.accountMediaId ? [s.accountMediaId] : [];
    const media = object(out.media) ? out.media : undefined;
    if (media?.present && moving.includes(String(media.type)))
      assets = (await all('/account_media', {count: 1000}, 5, 'account media'))
        .filter(r => String(r.video_id) === s.mediaKey)
        .map(r => String(r.id))
        .sort();
    const creatives = assets.length
      ? (await all('/media_creatives', {count: 1000}, 5, 'media creatives'))
          .filter(r => assets.includes(String(r.account_media_id)))
          .map(r => String(r.id))
          .sort()
      : [];
    const cards = s.mediaKey
      ? (await all('/cards', {count: 200, include_legacy_cards: true}, 10, 'cards'))
          .filter(r => mentions(r, s.mediaKey!))
          .map(r => String(r.card_uri ?? r.id))
          .sort()
      : [];
    out.usage = {accountMedia: s.mediaKey ? assets : [], mediaCreatives: creatives, cards};
  }
  return {status: 200, headers: {}, data: out};
}
export function validateXMediaState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).xMediaState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !!s.mediaKey !== object(d.media) ||
    !!s.accountMediaId !== object(d.accountMedia) ||
    !!s.posterKey !== object(d.poster) ||
    !!s.usage !== object(d.usage)
  )
    unverified('Missing verified media state.');
}
export function xMediaPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = xMediaKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s)) unverified('Missing verified media state.');
  const item = kind === 'account_media_delete' ? s.accountMedia : s.media,
    label = kind === 'account_media_delete' ? 'Account media ' : 'Media ';
  if (!object(item) || item.present !== true) unverified('Missing verified media state.');
  if (item.deleted === true) invalid(label + targetOf(p) + ' is deleted.');
  if (kind !== 'library_update') {
    const u = object(s.usage) ? s.usage : undefined;
    if (!u) unverified('Missing verified media usage.');
    const users = [
      ...(u.cards as string[]).map(x => 'card ' + x),
      ...(u.mediaCreatives as string[]).map(x => 'media creative ' + x),
    ];
    if (users.length)
      fail(
        'MEDIA_IN_USE',
        label + targetOf(p) + ' is used by ' + users.join(', ') + '; delete or change those first.',
        {cards: u.cards, media_creatives: u.mediaCreatives, account_media: u.accountMedia ?? []},
        409,
      );
    return;
  }
  const b = body(p);
  if (videoOnly.some(k => b[k] !== undefined) && !moving.includes(String(item.type)))
    invalid(
      'title, description and poster_media_key apply to videos and GIFs; media ' +
        targetOf(p) +
        ' is ' +
        String(item.type) +
        '.',
    );
  if (b.poster_media_key !== undefined) {
    const poster = s.poster;
    if (
      !object(poster) ||
      poster.type !== 'IMAGE' ||
      poster.deleted === true ||
      poster.status !== 'TRANSCODE_COMPLETED'
    )
      invalid('poster_media_key must be a ready image of the media library.');
  }
  const current: JsonObject = {
    name: item.name,
    file_name: item.fileName,
    title: item.title,
    description: item.description,
    poster_media_key: item.posterKey,
  };
  if (Object.keys(b).every(k => b[k] === current[k])) invalid('Media ' + targetOf(p) + ' already has these values.');
}
export function xMediaImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = xMediaKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    b = body(p),
    item =
      kind === 'account_media_delete'
        ? object(s.accountMedia)
          ? s.accountMedia
          : null
        : object(s.media)
          ? s.media
          : null;
  return {
    provider: 'x',
    scope: kind === 'account_media_delete' ? 'account_media' : 'media_library',
    operation: kind,
    before: item,
    after: kind === 'library_update' ? b : null,
    usage: object(s.usage) ? s.usage : null,
    may_affect_serving: false,
    effect:
      kind === 'library_update'
        ? 'Changes how the media is named and, for videos, its title, description or poster; cards and ads keep using the same media.'
        : kind === 'library_delete'
          ? 'Removes the media from the media library; no card or media creative uses it.' +
            (item?.tweeted === true ? ' X reports it was used in Tweets, which AMCP does not change or check.' : '')
          : 'Removes the account media asset; no media creative uses it.',
    verification:
      kind === 'library_update'
        ? 'Reads the media again and compares the values sent.'
        : 'Reads the item again and expects it to be deleted or gone.',
    source: 'https://docs.x.com/x-ads-api/creatives/reference',
  };
}
export function xMediaOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = xMediaKind(p)!,
    d = r.data,
    t = object(d) && object(d.data) ? d.data : undefined,
    b = body(p);
  if (
    ![200, 201].includes(r.status) ||
    !t ||
    (Array.isArray((d as JsonObject).errors) && (d as JsonObject).errors.length)
  )
    return false;
  if (kind === 'account_media_delete') return String(t.id) === targetOf(p) && t.deleted === true;
  if (String(t.media_key) !== targetOf(p)) return false;
  if (kind === 'library_delete') return t.deleted === true;
  return t.deleted !== true && Object.keys(b).every(k => t[k] === b[k]);
}
export function xMediaVerification(p: CompiledRequest): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = xMediaKind(p)!,
    id = targetOf(p),
    b = body(p);
  if (kind === 'account_media_delete')
    return [
      {
        read: stateRead(p, {accountMediaId: id, optional: true}),
        expected: {accountMedia: {gone: true}},
        id: 'account media ' + id,
      },
    ];
  const names: Record<string, string> = {
    name: 'name',
    file_name: 'fileName',
    title: 'title',
    description: 'description',
    poster_media_key: 'posterKey',
  };
  const expected: JsonObject =
    kind === 'library_delete'
      ? {gone: true}
      : {gone: false, ...Object.fromEntries(Object.keys(b).map(k => [names[k]!, b[k]]))};
  return [{read: stateRead(p, {mediaKey: id, optional: true}), expected: {media: expected}, id: 'media ' + id}];
}
export function xMediaObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {
    ...(object(data.media) ? {media: data.media} : {}),
    ...(object(data.accountMedia) ? {accountMedia: data.accountMedia} : {}),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xMediaFamily: ReviewedFamily = defineFamily({
  name: 'x_media_library',
  files: ['src/x-media-library.ts', ['tests/x-media-library.test.mjs']],
  kind: xMediaKind,
  assert: assertXMedia,
  snapshots: xMediaSnapshots,
  isRead: isXMediaRead,
  reader: readXMedia,
  validateState: validateXMediaState,
  prerequisites: xMediaPrerequisites,
  impact: xMediaImpact,
  outcome: xMediaOutcome,
  verification: xMediaVerification,
  observed: xMediaObserved,
  exemptFromSpendTextMatch: true,
});
