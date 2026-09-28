import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * X poll, image conversation and video conversation cards, per X Ads API v12 Creatives reference ("Poll Cards", "Image
 * Conversation Cards", "Video Conversation Cards", checked 2026-09-27). A poll has two to four choices of up to 25
 * characters and stays open duration_in_minutes (5–10080), which "starts as soon as the card is created and not when it is
 * added to a Tweet"; a poll with media needs the PROMOTED_MEDIA_POLLS account feature, and "It is not possible to update
 * (PUT) poll cards". Conversation cards have one to four CTA hashtags (up to 20 characters after #) with the Tweet text
 * each posts, a thank-you text of up to 23 characters and a title of up to 23 characters when there is no second CTA; the
 * image or video comes from the account's media library. Only creation is covered: editing or deleting a card that
 * promoted Tweets use needs the Tweet usage scan of the website card contract.
 */
type Kind = 'poll' | 'image_conversation' | 'video_conversation';
type Media = {key: string; role: string; types: string[]};
type State = {kind: Kind; media: Media[]; features: boolean; card?: string};
type Read = CompiledRequest & {xConversationCardState?: State};
const gateway = 'x_ads_native_action',
  route = /^\/12\/accounts\/([a-z0-9]{1,32})\/cards\/(poll|image_conversation|video_conversation)$/;
const mediaKey = /^[0-9]{1,4}_[0-9]{1,25}$/,
  cardId = /^[a-z0-9]{1,32}$/,
  ctaTag = /^#[A-Za-z0-9_]{1,20}$/,
  nameMax = 80,
  tweetMax = 280;
const allowed: Record<Kind, string[]> = {
  poll: ['name', 'duration_in_minutes', 'first_choice', 'second_choice', 'third_choice', 'fourth_choice', 'media_key'],
  image_conversation: [
    'name',
    'media_key',
    'first_cta',
    'first_cta_tweet',
    'second_cta',
    'second_cta_tweet',
    'third_cta',
    'third_cta_tweet',
    'fourth_cta',
    'fourth_cta_tweet',
    'title',
    'thank_you_text',
    'thank_you_url',
    'unlocked_image_media_key',
  ],
  video_conversation: [
    'name',
    'media_key',
    'poster_media_key',
    'first_cta',
    'first_cta_tweet',
    'second_cta',
    'second_cta_tweet',
    'third_cta',
    'third_cta_tweet',
    'fourth_cta',
    'fourth_cta_tweet',
    'title',
    'thank_you_text',
    'thank_you_url',
    'unlocked_image_media_key',
    'unlocked_video_media_key',
  ],
};
// Fields X returns and verification compares; media keys are write-only on polls.
const compared: Record<Kind, string[]> = {
  poll: ['name', 'first_choice', 'second_choice', 'third_choice', 'fourth_choice', 'duration_in_minutes'],
  image_conversation: [
    'name',
    'media_key',
    'first_cta',
    'first_cta_tweet',
    'second_cta',
    'second_cta_tweet',
    'third_cta',
    'third_cta_tweet',
    'fourth_cta',
    'fourth_cta_tweet',
    'title',
    'thank_you_text',
    'thank_you_url',
  ],
  video_conversation: [
    'name',
    'media_key',
    'first_cta',
    'first_cta_tweet',
    'second_cta',
    'second_cta_tweet',
    'third_cta',
    'third_cta_tweet',
    'fourth_cta',
    'fourth_cta_tweet',
    'title',
    'thank_you_text',
    'thank_you_url',
  ],
};
const ordinals = ['first', 'second', 'third', 'fourth'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && !!v.trim() && v === v.trim() && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_X_CONVERSATION_CARD', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function xConversationCardKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== gateway ||
    p.method !== 'POST' ||
    p.specialTransport ||
    (p.origin !== undefined && p.origin !== 'https://ads-api.x.com')
  )
    return;
  return route.exec(p.path)?.[2] as Kind | undefined;
}
const accountOf = (p: CompiledRequest) => /^\/12\/accounts\/([a-z0-9]{1,32})(?:\/|$)/.exec(p.path)?.[1];
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
function mediaOf(p: CompiledRequest): Media[] {
  const kind = xConversationCardKind(p)!,
    b = body(p),
    out: Media[] = [];
  const add = (field: string, role: string, types: string[]) => {
    if (typeof b[field] === 'string') out.push({key: b[field], role, types});
  };
  if (kind === 'poll') add('media_key', 'poll media', ['IMAGE', 'VIDEO']);
  if (kind === 'image_conversation') {
    add('media_key', 'card image', ['IMAGE']);
    add('unlocked_image_media_key', 'unlock image', ['IMAGE']);
  }
  if (kind === 'video_conversation') {
    add('media_key', 'card video', ['VIDEO']);
    add('poster_media_key', 'poster image', ['IMAGE']);
    add('unlocked_image_media_key', 'unlock image', ['IMAGE']);
    add('unlocked_video_media_key', 'unlock video', ['VIDEO']);
  }
  return out;
}
export function assertXConversationCard(p: CompiledRequest): void {
  const kind = xConversationCardKind(p);
  if (!kind) return;
  if (accountOf(p) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The request must use the selected account.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers ?? {}).length)
    invalid('Card creation takes its parameters in the body, without query or header overrides.');
  const b = p.body;
  if (!object(b)) invalid('Provide the native card parameters.');
  const extra = Object.keys(b).filter(k => !allowed[kind].includes(k));
  if (extra.length) invalid('Unqualified fields for a ' + kind.replace('_', ' ') + ' card: ' + extra.join(', ') + '.');
  if (!text(b.name, nameMax)) invalid('name has 1–' + nameMax + ' characters without surrounding spaces.');
  for (const k of Object.keys(b).filter(k => k.endsWith('media_key')))
    if (typeof b[k] !== 'string' || !mediaKey.test(b[k]))
      invalid(k + ' is a media key of the media library, such as 3_957113581522141184.');
  if (kind === 'poll') {
    if (!Number.isInteger(b.duration_in_minutes) || b.duration_in_minutes < 5 || b.duration_in_minutes > 10080)
      invalid('duration_in_minutes is a whole number of minutes from 5 to 10080.');
    const choices = ordinals.map(o => b[o + '_choice']);
    choices.forEach((c, i) => {
      if (c !== undefined && !text(c, 25)) invalid(ordinals[i] + '_choice has 1–25 characters.');
    });
    if (choices[0] === undefined || choices[1] === undefined) invalid('A poll needs first_choice and second_choice.');
    if (choices[3] !== undefined && choices[2] === undefined) invalid('fourth_choice needs third_choice.');
    const set = choices.filter(c => c !== undefined);
    if (new Set(set.map(c => String(c).toLowerCase())).size !== set.length) invalid('Poll choices must differ.');
    return;
  }
  for (const [i, o] of ordinals.entries()) {
    const cta = b[o + '_cta'],
      tweet = b[o + '_cta_tweet'];
    if (cta === undefined && tweet === undefined) {
      if (i === 0) invalid('A conversation card needs first_cta and first_cta_tweet.');
      continue;
    }
    if (typeof cta !== 'string' || !ctaTag.test(cta))
      invalid(o + '_cta is a hashtag: # and 1–20 letters, digits or underscores.');
    if (!text(tweet, tweetMax))
      invalid(o + '_cta_tweet is the Tweet text of ' + o + '_cta, 1–' + tweetMax + ' characters.');
    if (i > 1 && b[ordinals[i - 1] + '_cta'] === undefined) invalid(o + '_cta needs ' + ordinals[i - 1] + '_cta.');
  }
  const tags = ordinals
    .map(o => b[o + '_cta'])
    .filter(c => c !== undefined)
    .map(c => String(c).toLowerCase());
  if (new Set(tags).size !== tags.length) invalid('CTA hashtags must differ.');
  if (b.media_key === undefined)
    invalid(
      'media_key names the ' +
        (kind === 'image_conversation' ? 'image' : 'video') +
        ' of the card in the media library.',
    );
  if (!text(b.thank_you_text, 23)) invalid('thank_you_text has 1–23 characters.');
  if (b.title !== undefined && !text(b.title, 23)) invalid('title has 1–23 characters.');
  if (b.title === undefined && b.second_cta === undefined) invalid('A card with one CTA needs a title.');
  if (b.thank_you_url !== undefined) {
    let u: URL | undefined;
    try {
      u = new URL(String(b.thank_you_url));
    } catch {
      u = undefined;
    }
    if (!u || u.protocol !== 'https:' || String(b.thank_you_url).length > 1024)
      invalid('thank_you_url is an https URL of up to 1024 characters.');
  }
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}, state?: State): Read {
  return {
    ...p,
    action: 'AMCP_X_CONVERSATION_CARD_READ',
    method: 'GET',
    path: '/12/accounts/' + accountOf(p) + path,
    query,
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    xConversationCardState: state,
  };
}
/** One marked read of the account; the reader adds each media item and, for a poll with media, the account features. */
export function xConversationCardSnapshots(p: CompiledRequest): Read[] {
  const kind = xConversationCardKind(p)!;
  return [
    read(p, '', {}, {kind, media: mediaOf(p), features: kind === 'poll' && typeof body(p).media_key === 'string'}),
  ];
}
export function isXConversationCardRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).xConversationCardState;
}
const notFound = (e: unknown) => e instanceof MirrorError && e.code === 'UPSTREAM_ERROR' && e.status === 404;
export async function readXConversationCards(
  p: CompiledRequest,
  send: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).xConversationCardState;
  if (!s) return send(p);
  let requests = 0;
  const get = async (q: Read) => {
    if (++requests > 10) unverified('Card reads exceeded their bound.');
    const r = await send(q),
      d = r.data;
    if (r.status !== 200 || !object(d) || (Array.isArray(d.errors) && d.errors.length))
      unverified('X returned a failed or unrecognized read.');
    return d as JsonObject;
  };
  if (s.card) {
    let c: unknown;
    try {
      c = (await get(read(p, '/cards/' + s.kind + '/' + s.card, {with_deleted: true}))).data;
    } catch (e) {
      if (!notFound(e)) throw e;
      c = null;
    }
    if (c === null) return {status: 200, headers: {}, data: {card: {present: false, id: s.card}}};
    if (!object(c) || String(c.id) !== s.card)
      fail('STATE_TARGET_MISMATCH', 'X returned another card for ' + s.card + '.', {card_id: s.card}, 409);
    const view: JsonObject = {present: c.deleted !== true, id: s.card, card_uri: c.card_uri ?? null};
    for (const k of compared[s.kind]) view[k] = c[k] === undefined || c[k] === null ? null : String(c[k]);
    return {status: 200, headers: {}, data: {card: view}};
  }
  const acct = await get(read(p, ''));
  if (!object(acct.data) || String(acct.data.id) !== accountOf(p)) unverified('X returned another account.');
  const out: JsonObject = {accountId: accountOf(p)!, media: []};
  for (const m of s.media) {
    let row: unknown;
    try {
      row = (await get(read(p, '/media_library/' + m.key))).data;
    } catch (e) {
      if (!notFound(e)) throw e;
      row = null;
    }
    (out.media as JsonObject[]).push(
      object(row) && String(row.media_key) === m.key
        ? {
            key: m.key,
            role: m.role,
            type: row.media_type ?? null,
            status: row.media_status ?? null,
            deleted: row.deleted === true,
          }
        : {key: m.key, role: m.role, missing: true},
    );
  }
  if (s.features) {
    const f = await get(read(p, '/features'));
    if (!Array.isArray(f.data)) unverified('X did not list the account features.');
    out.media_polls = (f.data as unknown[]).includes('PROMOTED_MEDIA_POLLS');
  }
  return {status: 200, headers: {}, data: out};
}
export function validateXConversationCardState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).xConversationCardState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    (s.card ? !object(d.card) : !Array.isArray(d.media) || s.features !== (typeof d.media_polls === 'boolean'))
  )
    unverified('Missing verified card state.');
}
export function xConversationCardPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = xConversationCardKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !Array.isArray(s.media)) unverified('Missing verified card state.');
  for (const want of mediaOf(p)) {
    const m = (s.media as JsonObject[]).find(x => object(x) && x.key === want.key && x.role === want.role);
    if (!m || m.missing === true || m.deleted === true)
      fail(
        'STATE_NOT_FOUND',
        'Media ' + want.key + ' (' + want.role + ') is not in the media library of the account.',
        {media_key: want.key},
      );
    if (!want.types.includes(String(m.type)) || m.status !== 'TRANSCODE_COMPLETED')
      invalid(
        'Media ' +
          want.key +
          ' must be a ready ' +
          want.types.join(' or ').toLowerCase() +
          ' for the ' +
          want.role +
          '; it is ' +
          String(m.type) +
          ' (' +
          String(m.status) +
          ').',
      );
  }
  if (kind === 'poll' && typeof body(p).media_key === 'string' && s.media_polls !== true)
    invalid(
      'Polls with media need the PROMOTED_MEDIA_POLLS feature, which this account does not have; drop media_key for a text poll.',
    );
}
export function xConversationCardImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = xConversationCardKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    b = body(p);
  return {
    provider: 'x',
    scope: kind + '_card',
    operation: 'create',
    name: b.name,
    media: s.media ?? [],
    may_affect_serving: false,
    effect:
      kind === 'poll'
        ? 'Creates a poll card. The poll opens now, not when a Tweet uses it, and closes after ' +
          String(b.duration_in_minutes) +
          ' minutes; X cannot edit poll cards.'
        : 'Creates a ' +
          kind.replace('_', ' ') +
          ' card with ' +
          ordinals.filter(o => b[o + '_cta'] !== undefined).length +
          ' CTA hashtag(s). It reaches no one until a promoted Tweet uses it.',
    verification:
      'Reads the new card and compares the fields sent' +
      (kind === 'poll' ? ' (media keys are write-only on polls)' : '') +
      '.',
    source: 'https://docs.x.com/x-ads-api/creatives/reference',
  };
}
export function xConversationCardOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  return (
    r.status === 200 &&
    object(d) &&
    object(d.data) &&
    typeof d.data.id === 'string' &&
    cardId.test(d.data.id) &&
    typeof d.data.card_uri === 'string' &&
    /^card:\/\/[0-9]+$/.test(d.data.card_uri) &&
    d.data.deleted !== true
  );
}
export function xConversationCardVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = xConversationCardKind(p)!,
    id = result.data?.data?.id,
    b = body(p);
  if (typeof id !== 'string' || !cardId.test(id))
    fail('VERIFICATION_UNSUPPORTED', 'The creation receipt has no card ID.');
  const expected: JsonObject = {present: true};
  for (const k of compared[kind]) if (b[k] !== undefined) expected[k] = String(b[k]);
  return [
    {
      read: read(p, '/cards/' + kind + '/' + id, {with_deleted: true}, {kind, media: [], features: false, card: id}),
      expected: {card: expected},
      id,
    },
  ];
}
export function xConversationCardObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {card: object(data.card) ? data.card : {present: false}};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xConversationCardFamily: ReviewedFamily = {
  name: 'x_conversation_cards',
  files: ['src/x-conversation-cards.ts', ['tests/x-conversation-cards.test.mjs']],
  kind: xConversationCardKind,
  assert: assertXConversationCard,
  snapshots: xConversationCardSnapshots,
  isRead: isXConversationCardRead,
  reader: readXConversationCards,
  validateState: validateXConversationCardState,
  prerequisites: xConversationCardPrerequisites,
  impact: xConversationCardImpact,
  outcome: xConversationCardOutcome,
  verification: xConversationCardVerification,
  observed: xConversationCardObserved,
  exemptFromSpendTextMatch: true,
};
