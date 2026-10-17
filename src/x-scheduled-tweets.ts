import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail} from './family-kit.js';

/**
 * Scheduled Tweets of an X Ads account, Ads API v12 (Creatives reference and guide, "Scheduled Tweets"; docs.x.com copy
 * read on 2026-09-27). POST schedules a Tweet of a promotable user (`scheduled_at` "at least 5 minutes in the future"; text
 * unless media; a card or up to 4 images, 1 GIF or 1 video; promoted-only by default); "edits can be made until the Tweet's
 * scheduled_at time"; DELETE removes it before it is published. At that time X publishes the Tweet and fills `tweet_id`;
 * `scheduled_status` is SCHEDULED or FAILED. Like AMCP's other Tweet contracts this one stays promoted-only
 * (nullcast=true), and it does not move the publication time: a new time is a new scheduled Tweet.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {
  tweetId?: string;
  userId?: string;
  cardUri?: string;
  mediaKeys?: string[];
  associations?: boolean;
  optional?: boolean;
};
type Read = CompiledRequest & {xScheduledState?: State};
const gateway = 'x_ads_native_action',
  snowflake = /^[1-9][0-9]{0,24}$/,
  mediaKey = /^[0-9]{1,3}_[1-9][0-9]{0,24}$/,
  cardUri = /^card:\/\/[1-9][0-9]{0,24}$/;
const margin = 10 * 60 * 1000;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_X_SCHEDULED_TWEET', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function xScheduledKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== 'https://ads-api.x.com')) return;
  if (p.method === 'POST' && /^\/12\/accounts\/[a-z0-9]{1,32}\/scheduled_tweets$/.test(p.path)) return 'create';
  if (
    ['PUT', 'DELETE'].includes(p.method) &&
    /^\/12\/accounts\/[a-z0-9]{1,32}\/scheduled_tweets\/[0-9]{1,25}$/.test(p.path)
  )
    return p.method === 'PUT' ? 'update' : 'delete';
  return;
}
const account = (p: CompiledRequest) => p.path.split('/')[3]!,
  tweetOf = (p: CompiledRequest) => p.path.split('/')[5]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
const iso = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const keysOf = (v: unknown): string[] =>
  v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v.map(String) : String(v).split(',');
function tweetText(v: unknown): void {
  if (
    typeof v !== 'string' ||
    [...v].length > 280 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) ||
    (v !== '' && !v.trim())
  )
    invalid('text has at most 280 characters without control characters.');
}
export function assertXScheduled(p: CompiledRequest): void {
  const kind = xScheduledKind(p);
  if (!kind) return;
  if (account(p) !== p.accountId) fail('ACCOUNT_SCOPE_MISMATCH', 'The request must use the selected account.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers ?? {}).length)
    invalid('Scheduled Tweet writes take their parameters in the body, without query or header overrides.');
  if (kind !== 'create' && !snowflake.test(tweetOf(p))) invalid('The path names a scheduled Tweet ID.');
  if (kind === 'delete') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length)) invalid('A deletion takes no body.');
    return;
  }
  const b = p.body;
  if (!object(b)) invalid('Provide the native scheduled Tweet parameters.');
  const allowed =
    kind === 'create'
      ? ['as_user_id', 'scheduled_at', 'text', 'card_uri', 'media_keys', 'nullcast']
      : ['text', 'card_uri', 'media_keys', 'nullcast'];
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  if (extra.length)
    invalid(
      (kind === 'update' && extra.includes('scheduled_at')
        ? 'The publication time does not change here; delete the scheduled Tweet and schedule a new one. '
        : '') +
        'Unqualified fields: ' +
        extra.join(', ') +
        '.',
    );
  if (kind === 'update' && !Object.keys(b).length) invalid('Send text, card_uri, media_keys or nullcast.');
  if (kind === 'create') {
    if (typeof b.as_user_id !== 'string' || !snowflake.test(b.as_user_id))
      invalid('as_user_id is the user ID of a promotable user of the account.');
    const at =
      typeof b.scheduled_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?Z$/.test(b.scheduled_at)
        ? Date.parse(b.scheduled_at)
        : NaN;
    if (!Number.isFinite(at)) invalid('scheduled_at is an ISO 8601 UTC time such as 2030-01-01T09:00:00Z.');
    if (at < Date.now() + margin)
      invalid('scheduled_at must be at least 10 minutes ahead (X requires 5 at execution).');
  }
  if (b.nullcast !== undefined && b.nullcast !== true)
    invalid('This contract schedules promoted-only Tweets: nullcast is true (the default).');
  if (b.text !== undefined) tweetText(b.text);
  if (b.card_uri !== undefined && (typeof b.card_uri !== 'string' || (b.card_uri !== '' && !cardUri.test(b.card_uri))))
    invalid('card_uri is a card URI such as card://1234567890, or an empty string to remove the card.');
  if (b.media_keys !== undefined) {
    if (typeof b.media_keys !== 'string')
      invalid('media_keys is the comma-separated string of media keys, or an empty string to remove the media.');
    const ids = keysOf(b.media_keys);
    if (ids.length > 4 || ids.some(x => !mediaKey.test(x)) || new Set(ids).size !== ids.length)
      invalid('media_keys names at most four distinct media keys without spaces.');
  }
  if (typeof b.card_uri === 'string' && b.card_uri && keysOf(b.media_keys).length)
    invalid('A scheduled Tweet has a card or media, not both.');
  if (kind === 'create' && !(typeof b.text === 'string' && b.text.trim()) && !keysOf(b.media_keys).length)
    invalid('A scheduled Tweet needs text or media.');
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): Read {
  return {
    ...p,
    action: 'AMCP_X_SCHEDULED_TWEET_READ',
    method: 'GET',
    path: '/12/accounts/' + account(p) + path,
    query,
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    xScheduledState: undefined,
  };
}
const stateRead = (p: CompiledRequest, state: State): Read => ({...read(p, ''), xScheduledState: state});
/** One marked read of the account; the reader adds the scheduled Tweet, its author, card and media, and for deletions its promotions. */
export function xScheduledSnapshots(p: CompiledRequest): Read[] {
  const kind = xScheduledKind(p)!,
    b = body(p),
    attachments = {
      ...(typeof b.card_uri === 'string' && b.card_uri ? {cardUri: b.card_uri} : {}),
      ...(typeof b.media_keys === 'string' && b.media_keys ? {mediaKeys: keysOf(b.media_keys)} : {}),
    };
  if (kind === 'create') return [stateRead(p, {userId: String(b.as_user_id), ...attachments})];
  return [stateRead(p, {tweetId: tweetOf(p), ...attachments, ...(kind === 'delete' ? {associations: true} : {})})];
}
export function isXScheduledRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).xScheduledState;
}
const notFound = (e: unknown) => e instanceof MirrorError && e.code === 'UPSTREAM_ERROR' && e.status === 404;
function view(t: JsonObject): JsonObject {
  const card = t.card_uri === undefined || t.card_uri === '' ? null : t.card_uri;
  return {
    present: true,
    gone: t.deleted === true,
    id: String(t.id_str ?? t.id),
    userId: t.user_id === undefined || t.user_id === null ? null : String(t.user_id),
    text: t.text ?? '',
    cardUri: card,
    mediaKeys: keysOf(t.media_keys).sort(),
    nullcast: t.nullcast ?? null,
    scheduledAt: iso(t.scheduled_at),
    status: t.scheduled_status ?? null,
    tweetId: t.tweet_id ?? null,
    completedAt: t.completed_at ?? null,
  };
}
export async function readXScheduled(
  p: CompiledRequest,
  send: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).xScheduledState;
  if (!s) return send(p);
  let requests = 0;
  const get = async (q: Read) => {
    if (++requests > 20) unverified('Scheduled Tweet reads exceeded their bound.');
    const r = await send(q),
      d = r.data;
    if (r.status !== 200 || !object(d) || (Array.isArray(d.errors) && d.errors.length))
      unverified('X returned a failed or unrecognized read.');
    return d as JsonObject;
  };
  const acct = await get(read(p, ''));
  if (!object(acct.data) || String(acct.data.id) !== account(p)) unverified('X returned another account.');
  const out: JsonObject = {accountId: account(p)};
  let userId = s.userId;
  if (s.tweetId) {
    let t: unknown;
    try {
      t = (await get(read(p, '/scheduled_tweets/' + s.tweetId))).data;
    } catch (e) {
      if (!notFound(e)) throw e;
      if (!s.optional)
        fail(
          'STATE_NOT_FOUND',
          'Scheduled Tweet ' + s.tweetId + ' is not a scheduled Tweet of the selected account.',
          {scheduled_tweet_id: s.tweetId},
          404,
        );
      t = null;
    }
    if (t === null) out.tweet = {present: false, gone: true, id: s.tweetId};
    else {
      if (!object(t) || String(t.id_str ?? t.id) !== s.tweetId)
        fail(
          'STATE_TARGET_MISMATCH',
          'X returned another scheduled Tweet for ' + s.tweetId + '.',
          {scheduled_tweet_id: s.tweetId},
          409,
        );
      out.tweet = view(t);
      userId = (out.tweet as JsonObject).userId as string | undefined;
    }
  }
  if (s.optional) return {status: 200, headers: {}, data: out};
  const users = await get(read(p, '/promotable_users', {count: 1000}));
  if (!Array.isArray(users.data) || users.next_cursor)
    unverified('The promotable users of the account are incomplete.');
  const author = (users.data as unknown[]).find(u => object(u) && String(u.user_id) === userId);
  out.author = object(author)
    ? {userId: String(author.user_id), type: author.promotable_user_type ?? null, deleted: author.deleted === true}
    : null;
  if (s.cardUri) {
    const cards = await get(read(p, '/cards/all', {card_uris: s.cardUri}));
    const rows = Array.isArray(cards.data)
      ? (cards.data as unknown[]).filter(c => object(c) && c.card_uri === s.cardUri)
      : [];
    out.card = rows.length === 1 && object(rows[0]) ? {cardUri: s.cardUri, deleted: rows[0].deleted === true} : null;
  }
  if (s.mediaKeys) {
    const media: JsonObject[] = [];
    for (const key of s.mediaKeys) {
      let m: unknown;
      try {
        m = (await get(read(p, '/media_library/' + key))).data;
      } catch (e) {
        if (!notFound(e)) throw e;
        m = null;
      }
      media.push(
        object(m) && String(m.media_key) === key
          ? {key, type: m.media_type ?? null, status: m.media_status ?? null, deleted: m.deleted === true}
          : {key, missing: true},
      );
    }
    out.media = media;
  }
  if (s.associations) {
    const rows: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 5) unverified('The account has more scheduled promoted Tweets than one review reads.');
      const listed = await get(read(p, '/scheduled_promoted_tweets', {count: 1000, ...(cursor ? {cursor} : {})}));
      if (!Array.isArray(listed.data)) unverified('X did not list the scheduled promoted Tweets.');
      for (const row of listed.data as unknown[]) {
        if (!object(row)) unverified('A scheduled promoted Tweet row is malformed.');
        if (row.deleted !== true && String(row.scheduled_tweet_id) === s.tweetId) rows.push(String(row.line_item_id));
      }
      if (!listed.next_cursor) break;
      if (typeof listed.next_cursor !== 'string' || listed.next_cursor === cursor)
        unverified('Scheduled promoted Tweet pagination is repeated or malformed.');
      cursor = listed.next_cursor;
    }
    out.promotedIn = [...new Set(rows)].sort();
  }
  return {status: 200, headers: {}, data: out};
}
export function validateXScheduledState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).xScheduledState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !!s.tweetId !== object(d.tweet) ||
    (!s.optional && !('author' in d)) ||
    !!s.cardUri !== 'card' in d ||
    !!s.mediaKeys !== Array.isArray(d.media) ||
    !!s.associations !== Array.isArray(d.promotedIn)
  )
    unverified('Missing verified scheduled Tweet state.');
}
/** The Tweet as it would be after the request: the current one with the fields sent. */
function desired(p: CompiledRequest, current?: JsonObject): JsonObject {
  const b = body(p),
    next: JsonObject = current
      ? {text: current.text, cardUri: current.cardUri, mediaKeys: current.mediaKeys, nullcast: current.nullcast}
      : {text: '', cardUri: null, mediaKeys: [], nullcast: true};
  if (b.text !== undefined) next.text = b.text;
  if (b.card_uri !== undefined) next.cardUri = b.card_uri || null;
  if (b.media_keys !== undefined) next.mediaKeys = keysOf(b.media_keys).sort();
  if (b.nullcast !== undefined) next.nullcast = b.nullcast;
  return next;
}
export function xScheduledPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = xScheduledKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s)) unverified('Missing verified scheduled Tweet state.');
  const t = object(s.tweet) ? s.tweet : undefined;
  if (kind !== 'create') {
    if (!t || t.present !== true) unverified('Missing verified scheduled Tweet state.');
    if (t.gone === true || t.status !== 'SCHEDULED' || t.tweetId !== null || t.completedAt !== null)
      invalid(
        'Scheduled Tweet ' +
          tweetOf(p) +
          ' is ' +
          (t.gone === true
            ? 'deleted'
            : t.status === 'SCHEDULED'
              ? 'already published'
              : 'not scheduled (' + String(t.status) + ')') +
          '; only a scheduled Tweet that is not yet published changes.',
      );
    if (kind === 'delete') return;
    if (Date.parse(String(t.scheduledAt)) < Date.now() + margin)
      invalid('Scheduled Tweet ' + tweetOf(p) + ' publishes within 10 minutes; it can no longer be changed safely.');
  }
  const author = s.author;
  if (!object(author) || author.deleted === true || author.type !== 'FULL')
    invalid('The author must be a FULL promotable user of the account.');
  const next = desired(p, t);
  if (!String(next.text).trim() && !(next.mediaKeys as string[]).length)
    invalid('The scheduled Tweet needs text or media.');
  if (next.cardUri && (next.mediaKeys as string[]).length)
    invalid('A scheduled Tweet has a card or media, not both; remove the other one in the same request.');
  if (typeof s.card !== 'undefined') {
    const c = s.card;
    if (!object(c) || c.deleted === true)
      invalid('Card ' + String(body(p).card_uri) + ' is not an available card of the account.');
  }
  if (Array.isArray(s.media)) {
    for (const m of s.media as JsonObject[])
      if (
        m.missing === true ||
        m.deleted === true ||
        m.status !== 'TRANSCODE_COMPLETED' ||
        !['IMAGE', 'GIF', 'VIDEO'].includes(String(m.type))
      )
        invalid('Media ' + String(m.key) + ' is not ready media of the media library.');
    if ((s.media as JsonObject[]).length > 1 && (s.media as JsonObject[]).some(m => m.type !== 'IMAGE'))
      invalid('Use up to four images, one GIF or one video.');
  }
  if (
    kind === 'update' &&
    t &&
    ['text', 'cardUri', 'mediaKeys', 'nullcast'].every(k => JSON.stringify(next[k]) === JSON.stringify(t[k]))
  )
    invalid('Scheduled Tweet ' + tweetOf(p) + ' already has these values.');
}
export function xScheduledImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = xScheduledKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    t = object(s.tweet) ? s.tweet : null,
    b = body(p);
  const at = kind === 'create' ? iso(b.scheduled_at) : (t?.scheduledAt ?? null),
    promoted = Array.isArray(s.promotedIn) ? s.promotedIn : [];
  return {
    provider: 'x',
    scope: 'scheduled_tweet',
    operation: kind,
    before: t,
    after: kind === 'delete' ? null : {...desired(p, t ?? undefined), scheduledAt: at},
    author: object(s.author) ? s.author : null,
    promoted_in_line_items: promoted,
    may_affect_serving: kind === 'delete' && promoted.length > 0,
    effect:
      kind === 'create'
        ? 'X publishes a promoted-only Tweet at ' + String(at) + '; it serves only where a line item promotes it.'
        : kind === 'update'
          ? 'Changes the Tweet X publishes at ' + String(at) + '.'
          : 'Removes the scheduled Tweet; X will not publish it.' +
            (promoted.length
              ? ' Line items ' + promoted.join(', ') + ' schedule its promotion and will have nothing to promote.'
              : ''),
    verification:
      kind === 'delete'
        ? 'Reads the scheduled Tweet again and expects it to be gone.'
        : 'Reads the scheduled Tweet again and compares its text, card, media and nullcast.',
    source: 'https://docs.x.com/x-ads-api/creatives/reference',
  };
}
export function xScheduledOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = xScheduledKind(p)!,
    d = r.data,
    t = object(d) && object(d.data) ? d.data : undefined,
    b = body(p);
  if (
    ![200, 201].includes(r.status) ||
    !t ||
    (Array.isArray((d as JsonObject).errors) && (d as JsonObject).errors.length)
  )
    return false;
  const id = String(t.id_str ?? t.id);
  if (!snowflake.test(id)) return false;
  if (kind === 'delete') return id === tweetOf(p);
  if (kind === 'update' && id !== tweetOf(p)) return false;
  const got = view(t),
    sent: JsonObject = {};
  if (b.text !== undefined) sent.text = b.text;
  if (b.card_uri !== undefined) sent.cardUri = b.card_uri || null;
  if (b.media_keys !== undefined) sent.mediaKeys = keysOf(b.media_keys).sort();
  if (b.nullcast !== undefined) sent.nullcast = b.nullcast;
  if (
    kind === 'create' &&
    (got.userId !== b.as_user_id ||
      got.scheduledAt !== iso(b.scheduled_at) ||
      got.status !== 'SCHEDULED' ||
      got.nullcast !== true)
  )
    return false;
  return Object.keys(sent).every(k => JSON.stringify(got[k]) === JSON.stringify(sent[k]));
}
export function xScheduledVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = xScheduledKind(p)!,
    created = result.data?.data,
    id = kind === 'create' ? String(created?.id_str ?? created?.id ?? '') : tweetOf(p);
  if (!snowflake.test(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no scheduled Tweet to verify.');
  if (kind === 'delete')
    return [
      {read: stateRead(p, {tweetId: id, optional: true}), expected: {tweet: {gone: true}}, id: 'scheduled Tweet ' + id},
    ];
  const first = before[0],
    current = object(first) && object(first.tweet) ? first.tweet : undefined,
    b = body(p);
  const expected: JsonObject = {
    gone: false,
    ...desired(p, kind === 'update' ? current : undefined),
    ...(kind === 'create' ? {userId: b.as_user_id, scheduledAt: iso(b.scheduled_at)} : {}),
  };
  return [
    {read: stateRead(p, {tweetId: id, optional: true}), expected: {tweet: expected}, id: 'scheduled Tweet ' + id},
  ];
}
export function xScheduledObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {tweet: object(data.tweet) ? data.tweet : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xScheduledFamily: ReviewedFamily = defineFamily({
  name: 'x_scheduled_tweets',
  files: ['src/x-scheduled-tweets.ts', ['tests/x-scheduled-tweets.test.mjs']],
  kind: xScheduledKind,
  assert: assertXScheduled,
  snapshots: xScheduledSnapshots,
  isRead: isXScheduledRead,
  reader: readXScheduled,
  validateState: validateXScheduledState,
  prerequisites: xScheduledPrerequisites,
  impact: xScheduledImpact,
  outcome: xScheduledOutcome,
  verification: xScheduledVerification,
  observed: xScheduledObserved,
  exemptFromSpendTextMatch: true,
});
