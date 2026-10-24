import {setTimeout as delay} from 'node:timers/promises';
import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {familyCodeError, type OneCodeRefusal, stateReadOf} from './family-kit.js';
import {stable, sha256} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

const gateway = 'x_ads_native_action';
const native = /^[a-z0-9]{1,32}$/,
  snowflake = /^[0-9]{1,25}$/,
  mediaKey = /^[0-9]+_[0-9]+$/;
// Poll, image conversation and video conversation cards have their own routes (Creatives reference, "Poll Cards",
// "Image Conversation Cards", "Video Conversation Cards"; checked 2026-09-27). X cannot edit poll cards.
const legacyRoute = /^\/cards\/(poll|image_conversation|video_conversation)\/([a-z0-9]+)$/,
  ctaTag = /^#[A-Za-z0-9_]{1,20}$/;
const conversationFields = [
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
];
const legacyFields: Record<string, string[]> = {
  image_conversation: conversationFields,
  video_conversation: [...conversationFields, 'poster_media_key', 'unlocked_video_media_key'],
};
// X returns the card media key but not the poster or unlock media keys.
const writeOnly = ['poster_media_key', 'unlocked_image_media_key', 'unlocked_video_media_key'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail: OneCodeRefusal = familyCodeError('X_CREATIVE_STATE_UNVERIFIED');
type Kind =
  'card_create' | 'card_update' | 'card_delete' | 'tweet_create' | 'tweet_rename' | 'library_create' | 'promotion';
export function xCreativeKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway) return;
  const route = p.path.replace(/^\/12\/accounts\/[a-z0-9]+/, '');
  if (route === '/cards' && p.method === 'POST') return 'card_create';
  if (/^\/cards\/[a-z0-9]+$/.test(route) && ['PUT', 'DELETE'].includes(p.method))
    return p.method === 'PUT' ? 'card_update' : 'card_delete';
  const legacy = legacyRoute.exec(route);
  if (legacy && (p.method === 'DELETE' || (p.method === 'PUT' && legacy[1] !== 'poll')))
    return p.method === 'PUT' ? 'card_update' : 'card_delete';
  if (route === '/tweet' && p.method === 'POST') return 'tweet_create';
  if (/^\/tweets\/[0-9]+\/name$/.test(route) && p.method === 'PUT') return 'tweet_rename';
  if (route === '/media_library' && p.method === 'POST') return 'library_create';
  if (route === '/promoted_tweets' && p.method === 'POST') return 'promotion';
}
/** The poll or conversation card type of a card edit or deletion; undefined for website cards. */
export function xLegacyCardType(p: CompiledRequest): string | undefined {
  return legacyRoute.exec(p.path.replace(/^\/12\/accounts\/[a-z0-9]+/, ''))?.[1];
}
const cardSuffix = (p: CompiledRequest) => {
  const type = xLegacyCardType(p);
  return '/cards/' + (type ? type + '/' : '') + p.path.split('/').at(-1);
};
export const xCreativeEdit = (p: CompiledRequest) =>
  ['card_update', 'card_delete', 'tweet_rename'].includes(xCreativeKind(p) ?? '');
export const xPromotion = (p: CompiledRequest) => xCreativeKind(p) === 'promotion';
export function xCreativeWarnings(p: CompiledRequest): string[] {
  if (xPromotion(p))
    return [
      'X promotion creates an ACTIVE association and may serve immediately under an active line item/campaign. There is no qualified paused promotion or promotion-update contract. Keep the nullcast Tweet unpromoted to stage it. Execution requires spend_change_confirmed=true.',
    ];
  if (xCreativeEdit(p))
    return [
      'Creative edits may remove or disrupt referencing promoted Tweets. AMCP blocks known use unless the complete affected-ad list is explicitly reviewed with creative_edit_confirmed=true. Recovery requires fresh reads and new reviewed promotions; original IDs and safe vendor retries are not guaranteed.',
    ];
  return [];
}
export function assertXCreative(p: CompiledRequest) {
  const kind = xCreativeKind(p);
  if (!kind) return;
  const b = p.body === undefined ? {} : p.body;
  function invalid(message: string, details: JsonObject = {}): never {
    throw new MirrorError('INVALID_X_CREATIVE', message, details);
  }
  if (!object(b)) invalid('Provide a native object payload.');
  const allowed: Record<Kind, string[]> = {
    card_create: ['name', 'components'],
    card_update: ['name', 'components'],
    card_delete: [],
    tweet_create: ['as_user_id', 'text', 'card_uri', 'nullcast', 'name'],
    tweet_rename: ['name'],
    library_create: ['media_key', 'name', 'file_name'],
    promotion: ['line_item_id', 'tweet_ids'],
  };
  const fields = kind === 'card_update' && xLegacyCardType(p) ? legacyFields[xLegacyCardType(p)!]! : allowed[kind];
  for (const key of Object.keys(b))
    if (!fields.includes(key))
      invalid('This field is not qualified for this X creative route.', {
        field: key,
        ...(key === 'entity_status'
          ? {next_action: 'Remove entity_status. Promotion is an activation action, not a paused ad create.'}
          : key === 'card_type'
            ? {next_action: 'Omit card_type; X derives the card format from its ordered components.'}
            : {}),
      });
  const text = (key: string, max: number, required = true) => {
    if (!required && b[key] === undefined) return;
    if (typeof b[key] !== 'string' || !b[key].trim() || Array.from(b[key]).length > max)
      invalid('Provide a nonempty ' + key + ' of at most ' + max + ' characters.', {field: key});
  };
  if (['card_create', 'tweet_rename'].includes(kind)) text('name', 80);
  if (['card_update', 'tweet_create'].includes(kind)) text('name', 80, false);
  if (kind === 'card_update' && !Object.keys(b).length)
    invalid(
      xLegacyCardType(p)
        ? 'Provide the conversation card fields to update.'
        : 'Provide a name or complete ordered components to update.',
    );
  if (kind === 'card_update' && xLegacyCardType(p)) {
    for (const o of ['first', 'second', 'third', 'fourth']) {
      if (b[o + '_cta'] !== undefined && (typeof b[o + '_cta'] !== 'string' || !ctaTag.test(b[o + '_cta'])))
        invalid(o + '_cta is a hashtag: # and 1–20 letters, digits or underscores.', {field: o + '_cta'});
      text(o + '_cta_tweet', 280, false);
    }
    text('thank_you_text', 23, false);
    text('title', 23, false);
    for (const k of Object.keys(b).filter(k => k.endsWith('media_key')))
      if (typeof b[k] !== 'string' || !mediaKey.test(b[k]))
        invalid(k + ' is a media key of the media library.', {field: k});
    if (b.thank_you_url !== undefined) {
      let u: URL | undefined;
      try {
        u = new URL(String(b.thank_you_url));
      } catch {
        u = undefined;
      }
      if (!u || u.protocol !== 'https:') invalid('thank_you_url is an https URL.', {field: 'thank_you_url'});
    }
  }
  if (kind === 'card_create' || (kind === 'card_update' && b.components !== undefined)) {
    const components = b.components;
    if (
      !Array.isArray(components) ||
      components.length !== 2 ||
      components[0]?.type !== 'MEDIA' ||
      components[1]?.type !== 'DETAILS'
    )
      invalid(
        'This contract supports one image/video website card: MEDIA followed by DETAILS. Other formats need a separate qualified contract.',
      );
    const [media, details] = components;
    if (
      Object.keys(media).some(k => !['type', 'media_key'].includes(k)) ||
      typeof media.media_key !== 'string' ||
      !mediaKey.test(media.media_key)
    )
      invalid('MEDIA requires the exact registered media_key.');
    if (
      Object.keys(details).some(k => !['type', 'title', 'destination'].includes(k)) ||
      typeof details.title !== 'string' ||
      !details.title.trim() ||
      Array.from(details.title).length > 70
    )
      invalid('DETAILS requires a headline of at most 70 characters.');
    const d = details.destination;
    if (!object(d) || d.type !== 'WEBSITE' || Object.keys(d).some(k => !['type', 'url'].includes(k)))
      invalid('Use a WEBSITE destination.');
    let url: URL;
    try {
      url = new URL(d.url);
    } catch {
      return invalid('Provide an absolute website destination URL.');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      invalid('Use an HTTP(S) website destination without embedded credentials.');
  }
  if (kind === 'tweet_create') {
    if (typeof b.as_user_id !== 'string' || !snowflake.test(b.as_user_id))
      invalid('as_user_id must be the exact string ID of an account promotable user.');
    if (typeof b.card_uri !== 'string' || !/^card:\/\/[0-9]+$/.test(b.card_uri))
      invalid('Use the card_uri returned by the selected account card create.');
    text('text', 280);
    if (b.nullcast !== true)
      invalid('This ad-build contract requires nullcast=true. An unpromoted nullcast Tweet is the staging state.');
  }
  if (kind === 'library_create') {
    if (typeof b.media_key !== 'string' || !mediaKey.test(b.media_key)) invalid('Provide the exact upload media_key.');
    text('name', 100, false);
    text('file_name', 255, false);
  }
  if (kind === 'promotion') {
    if (typeof b.line_item_id !== 'string' || !native.test(b.line_item_id)) invalid('Provide an exact line_item_id.');
    if (typeof b.tweet_ids !== 'string') invalid('tweet_ids must contain 1–4 comma-separated string IDs.');
    const ids = b.tweet_ids.split(',');
    if (
      !ids.length ||
      ids.length > 4 ||
      new Set(ids).size !== ids.length ||
      ids.some((id: string) => !snowflake.test(id))
    )
      invalid('Provide 1–4 unique decimal Tweet IDs without spaces.');
  }
}
export function xRead(p: CompiledRequest, suffix: string, query: JsonObject = {}): CompiledRequest {
  const account = /^\/12\/accounts\/[a-z0-9]+/.exec(p.path)?.[0];
  if (!account) fail('The X account path is invalid.');
  return stateReadOf(p, 'AMCP_X_CREATIVE_READ', account + suffix, query);
}
/** inspect is local: these are the entry reads; account users and line items determine further reads. */
export function xCreativeSnapshots(p: CompiledRequest): CompiledRequest[] {
  const b = (p.body ?? {}) as JsonObject,
    kind = xCreativeKind(p),
    reads = [xRead(p, '')];
  if (kind === 'card_update' || kind === 'card_delete') reads.push(xRead(p, cardSuffix(p)));
  if (kind === 'card_update' && xLegacyCardType(p))
    for (const k of Object.keys(b).filter(k => k.endsWith('media_key'))) reads.push(xRead(p, '/media_library/' + b[k]));
  if (kind === 'card_create' || kind === 'card_update')
    for (const c of b.components ?? []) if (c.type === 'MEDIA') reads.push(xRead(p, '/media_library/' + c.media_key));
  if (kind === 'tweet_create')
    reads.push(xRead(p, '/cards/all', {card_uris: b.card_uri}), xRead(p, '/promotable_users'));
  if (kind === 'tweet_rename' || kind === 'promotion') reads.push(xRead(p, '/promotable_users'));
  if (kind === 'promotion') reads.push(xRead(p, '/line_items/' + b.line_item_id));
  if (xCreativeEdit(p)) reads.push(xRead(p, '/line_items', {count: 1000, with_deleted: false}));
  return reads;
}
export const xId = (r: JsonObject): string | undefined =>
  typeof r.id_str === 'string' && snowflake.test(r.id_str)
    ? r.id_str
    : typeof r.id === 'string' && native.test(r.id)
      ? r.id
      : typeof r.id === 'number' && Number.isSafeInteger(r.id) && r.id >= 0
        ? String(r.id)
        : undefined;
function rowAccount(row: JsonObject, p: CompiledRequest) {
  if (row.account_id !== undefined && row.account_id !== p.accountId)
    fail('X returned a resource from a different account.');
}
function tweetView(row: JsonObject) {
  const user = row.user?.id_str ?? row.user?.id ?? row.user_id;
  return {
    id_str: xId(row),
    name: row.name ?? null,
    text: row.full_text ?? row.text,
    card_uri: row.card_uri ?? null,
    nullcast:
      row.nullcast ?? (row.scopes?.followers === false ? true : row.scopes?.followers === true ? false : undefined),
    as_user_id:
      typeof user === 'string'
        ? user
        : typeof user === 'number' && Number.isSafeInteger(user)
          ? String(user)
          : undefined,
  };
}
type Read = (p: CompiledRequest) => Promise<TransportResult>;
export function xReader(p: CompiledRequest, send: Read) {
  let requests = 0,
    rowsRead = 0;
  const started = performance.now();
  const data = async (suffix: string, query: JsonObject = {}) => {
    if (++requests > 250 || performance.now() - started > 60000)
      throw new MirrorError(
        'X_CREATIVE_DISCOVERY_LIMIT',
        'Creative checks exceeded their bounded read budget; narrow the account or retry the read later.',
      );
    let r: TransportResult;
    try {
      r = await send(xRead(p, suffix, query));
    } catch (e) {
      // Preserve the creative contract's failure signal when transport rejects a
      // nominally successful envelope. Authentication and retryable failures keep
      // their original recovery instructions.
      if (e instanceof MirrorError && e.code === 'PLATFORM_ERROR' && e.details.http_status === 200)
        fail('X did not return a complete successful creative response.', {...e.details, provider_error_code: e.code});
      throw e;
    }
    const d = r.data;
    if (
      r.status !== 200 ||
      !object(d) ||
      d.error ||
      (d.errors != null && (!Array.isArray(d.errors) || d.errors.length > 0)) ||
      d.partial_failure ||
      d.success === false ||
      !Object.hasOwn(d, 'data')
    )
      fail('X did not return a complete successful creative response.');
    if (
      ['next', 'next_token', 'next_page_token', 'nextLink', 'paging', 'pagination', 'partial', 'truncated'].some(
        k => d[k] != null && d[k] !== false,
      )
    )
      fail('X returned unsupported pagination or incomplete-result metadata.');
    return d;
  };
  const list = async (suffix: string, query: JsonObject = {}) => {
    const rows: JsonObject[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 25; page++) {
      const d = await data(suffix, {
        ...(['/tweets', '/line_items', '/promoted_tweets'].includes(suffix) ? {count: 1000} : {}),
        ...query,
        ...(cursor ? {cursor} : {}),
      });
      if (!Array.isArray(d.data) || d.data.some((r: unknown) => !object(r)))
        fail('X did not return its native collection.');
      for (const r of d.data) {
        rowAccount(r, p);
        rows.push(r);
        if (++rowsRead > 20000)
          throw new MirrorError('X_CREATIVE_DISCOVERY_LIMIT', 'Creative discovery reached its row limit.');
      }
      if (d.next_cursor === null || d.next_cursor === undefined || d.next_cursor === '0' || d.next_cursor === 0) {
        if (d.total_count !== undefined && (!Number.isSafeInteger(d.total_count) || d.total_count !== rows.length))
          fail('X collection totals do not reconcile.');
        return rows;
      }
      if (typeof d.next_cursor !== 'string' || d.next_cursor.length > 2048 || seen.has(d.next_cursor))
        fail('X returned an invalid or repeated cursor.');
      seen.add(d.next_cursor);
      cursor = d.next_cursor;
    }
    throw new MirrorError('X_CREATIVE_DISCOVERY_LIMIT', 'Creative discovery exceeded the page limit.');
  };
  const single = async (suffix: string, id: string, key = 'id', withDeleted = false) => {
    const d = await data(suffix, withDeleted ? {with_deleted: true} : {}),
      row = /^\/cards\/(?:(?:poll|image_conversation|video_conversation)\/)?[a-z0-9]+$/.test(suffix)
        ? oneCard(d.data)
        : d.data;
    if (!object(row) || d.next_cursor) fail('X did not return one complete resource.');
    rowAccount(row, p);
    if (String(row[key]) !== id || (!withDeleted && row.deleted === true))
      fail('X did not confirm the exact requested resource.', {resource_id: id});
    return row;
  };
  const users = async () => {
    const rows = await list('/promotable_users'),
      ids = rows.map(r => r.user_id ?? r.id_str ?? r.id);
    if (
      !ids.length ||
      ids.length > 100 ||
      ids.some(id => typeof id !== 'string' || !snowflake.test(id)) ||
      new Set(ids).size !== ids.length
    )
      fail('The account promotable users are incomplete or ambiguous.');
    return ids as string[];
  };
  const tweets = async (ids: string[], userIds?: string[]) => {
    const found = new Map<string, JsonObject>(),
      wanted = new Set(ids);
    for (const user of userIds ?? (await users()))
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200).filter(id => !found.has(id));
        if (!batch.length) continue;
        const rows = await list('/tweets', {
          tweet_ids: batch.join(','),
          tweet_type: 'PUBLISHED',
          timeline_type: 'ALL',
          include_mentions_and_replies: true,
          user_id: user,
          count: 200,
        });
        const seen = new Set<string>();
        for (const row of rows) {
          const id = xId(row),
            view = tweetView(row);
          if (
            !id ||
            !batch.includes(id) ||
            seen.has(id) ||
            view.as_user_id !== user ||
            typeof view.text !== 'string' ||
            (row.truncated === true && !row.full_text)
          )
            fail('X returned an ambiguous or incomplete Tweet.');
          seen.add(id);
          if (found.has(id) && stable(found.get(id)) !== stable(row)) fail('X returned conflicting Tweet records.');
          found.set(id, row);
        }
      }
    if (found.size !== wanted.size)
      fail('Not every requested Tweet could be read under the selected account.', {
        missing_tweet_ids: ids.filter(id => !found.has(id)),
      });
    return ids.map(id => found.get(id)!);
  };
  const promotions = async (lineItem: string) => {
    const rows = await list('/promoted_tweets', {line_item_ids: lineItem, with_deleted: false}),
      seen = new Set<string>();
    for (const r of rows) {
      if (
        typeof r.id !== 'string' ||
        !native.test(r.id) ||
        typeof r.tweet_id !== 'string' ||
        !snowflake.test(r.tweet_id) ||
        r.line_item_id !== lineItem ||
        seen.has(r.id)
      )
        fail('The per-line-item promoted Tweet read returned an ambiguous binding.');
      seen.add(r.id);
    }
    return rows.filter(r => r.deleted !== true);
  };
  return {single, list, users, tweets, promotions};
}
function mediaReady(row: JsonObject) {
  if (row.media_status !== 'TRANSCODE_COMPLETED')
    throw new MirrorError('MEDIA_NOT_READY', 'The registered media is not ready for a card.', {
      media_key: row.media_key,
      media_status: row.media_status,
    });
}
export async function readXCreativeState(p: CompiledRequest, send: Read): Promise<unknown[]> {
  const read = xReader(p, send),
    kind = xCreativeKind(p),
    b = (p.body ?? {}) as JsonObject,
    states: unknown[] = [];
  states.push({account: await read.single('', p.accountId!)});
  let card: JsonObject | undefined;
  if (kind === 'card_update' || kind === 'card_delete') {
    card = await read.single(cardSuffix(p), p.path.split('/').at(-1)!);
    states.push({card});
  }
  const legacy = kind === 'card_update' ? xLegacyCardType(p) : undefined;
  if (legacy)
    for (const k of Object.keys(b).filter(k => k.endsWith('media_key'))) {
      const media = await read.single('/media_library/' + b[k], b[k], 'media_key');
      mediaReady(media);
      const want =
        k === 'media_key'
          ? legacy === 'image_conversation'
            ? 'IMAGE'
            : 'VIDEO'
          : k === 'unlocked_video_media_key'
            ? 'VIDEO'
            : 'IMAGE';
      if (media.media_type !== want)
        throw new MirrorError(
          'INVALID_X_CREATIVE',
          'Media ' +
            b[k] +
            ' is ' +
            String(media.media_type) +
            '; ' +
            k +
            ' needs ' +
            (want === 'IMAGE' ? 'an image' : 'a video') +
            '.',
          {field: k},
        );
      states.push({
        media: {
          media_key: media.media_key,
          media_type: media.media_type,
          media_status: media.media_status,
          deleted: media.deleted ?? false,
        },
      });
    }
  if (kind === 'card_create' || kind === 'card_update')
    for (const component of b.components ?? [])
      if (component.type === 'MEDIA') {
        const media = await read.single('/media_library/' + component.media_key, component.media_key, 'media_key');
        mediaReady(media);
        states.push({
          media: {
            media_key: media.media_key,
            media_type: media.media_type,
            media_status: media.media_status,
            deleted: media.deleted ?? false,
          },
        });
      }
  if (kind === 'tweet_create') {
    const cards = await read.list('/cards/all', {card_uris: b.card_uri});
    if (cards.length !== 1 || cards[0]!.card_uri !== b.card_uri || cards[0]!.deleted === true)
      fail('The selected account did not return the exact card URI.');
    const users = await read.list('/promotable_users'),
      selected = users.filter(u => u.user_id === b.as_user_id);
    if (selected.length !== 1 || selected[0]!.promotable_user_type !== 'FULL')
      fail(
        'as_user_id must be a FULL promotable user of this account; retweets-only access cannot create an original Tweet.',
      );
    states.push({card: cards[0], promotable_user: b.as_user_id});
  }
  if (kind === 'promotion') {
    const parent = await read.single('/line_items/' + b.line_item_id, b.line_item_id);
    if (typeof parent.campaign_id !== 'string' || !native.test(parent.campaign_id))
      fail('X did not identify the parent campaign.');
    states.push({
      line_item: parent,
      campaign: await read.single('/campaigns/' + parent.campaign_id, parent.campaign_id),
    });
    const tweets = await read.tweets(b.tweet_ids.split(','));
    states.push({tweets: tweets.map(tweetView).sort((a, b) => a.id_str!.localeCompare(b.id_str!))});
    const uris = [...new Set(tweets.flatMap(t => (t.card_uri == null ? [] : [t.card_uri])))];
    if (uris.some(uri => typeof uri !== 'string' || !/^card:\/\/[0-9]+$/.test(uri)))
      fail('A promoted Tweet has an unrecognized card reference.');
    if (uris.length) {
      const cards = await read.list('/cards/all', {card_uris: uris.join(',')});
      if (
        cards.length !== uris.length ||
        new Set(cards.map(c => c.card_uri)).size !== uris.length ||
        cards.some(c => !uris.includes(c.card_uri) || c.deleted === true)
      )
        fail('The promotion card dependencies are missing or ambiguous.');
      states.push({cards: cards.sort((a, b) => a.card_uri.localeCompare(b.card_uri))});
    }
  }
  if (kind === 'tweet_rename') {
    const id = p.path.split('/').at(-2)!;
    states.push({tweet: tweetView((await read.tweets([id]))[0]!)});
  }
  if (xCreativeEdit(p)) {
    const items = await read.list('/line_items', {with_deleted: false}),
      seen = new Set<string>(),
      ads: JsonObject[] = [];
    for (const item of items) {
      if (typeof item.id !== 'string' || !native.test(item.id) || seen.has(item.id))
        fail('X line-item discovery is ambiguous.');
      seen.add(item.id);
      if (item.deleted !== true) ads.push(...(await read.promotions(item.id)));
    }
    let affected: JsonObject[];
    if (kind === 'tweet_rename') affected = ads.filter(ad => ad.tweet_id === p.path.split('/').at(-2));
    else {
      if (typeof card?.card_uri !== 'string' || !/^card:\/\/[0-9]+$/.test(card.card_uri))
        fail('The current card URI is missing.');
      const ids = [...new Set(ads.map(ad => String(ad.tweet_id)))],
        tweets = ids.length ? await read.tweets(ids) : [],
        matches = new Set<string>();
      for (const tweet of tweets) {
        if (tweet.card_uri != null && (typeof tweet.card_uri !== 'string' || !/^card:\/\/[0-9]+$/.test(tweet.card_uri)))
          fail('Card usage cannot be checked from an unrecognized Tweet card reference.');
        if (tweet.card_uri === card.card_uri) {
          matches.add(xId(tweet)!);
          continue;
        }
        const urls = tweet.entities?.urls;
        if (tweet.card_uri == null && !Array.isArray(urls))
          fail('Card usage cannot be ruled out from an incomplete Tweet.');
        for (const entry of urls ?? []) {
          const value = entry.expanded_url;
          if (typeof value !== 'string') fail('A Tweet link cannot be resolved from provider metadata.');
          let url: URL;
          try {
            url = new URL(value);
          } catch {
            continue;
          }
          if (['cards.x.com', 'cards.twitter.com'].includes(url.hostname)) {
            if (card.preview_url === value) matches.add(xId(tweet)!);
            else if (!card.preview_url) fail('Legacy card links require verified card ownership before editing.');
          }
        }
      }
      affected = ads.filter(ad => matches.has(ad.tweet_id));
    }
    states.push({
      x_creative_usage: affected
        .map(a => ({
          promoted_tweet_id: a.id,
          line_item_id: a.line_item_id,
          tweet_id: a.tweet_id,
          entity_status: a.entity_status ?? null,
        }))
        .sort((a, b) => a.promoted_tweet_id.localeCompare(b.promoted_tweet_id)),
    });
  }
  return states;
}
export function xCreativeImpact(
  p: CompiledRequest,
  states: unknown[],
  override = false,
  connectionId?: string,
): JsonObject | undefined {
  if (!xCreativeEdit(p)) return;
  const usage = (states.find(s => object(s) && Array.isArray(s.x_creative_usage)) as JsonObject | undefined)
    ?.x_creative_usage;
  if (!Array.isArray(usage)) fail('Creative usage was not verified.');
  const groups = new Map<string, Set<string>>();
  for (const row of usage) {
    if (!groups.has(row.line_item_id)) groups.set(row.line_item_id, new Set());
    groups.get(row.line_item_id)!.add(row.tweet_id);
  }
  const recovery: JsonObject[] = [];
  for (const [line, ids] of groups) {
    const values = [...ids].sort();
    for (let i = 0; i < values.length; i += 4)
      recovery.push({
        tool: 'amcp_write',
        arguments: {
          action: 'prepare',
          gateway,
          connection_id: connectionId,
          arguments: {
            action: 'x_accounts_account_id_promoted_tweets_post',
            account_id: p.accountId,
            payload: {line_item_id: line, tweet_ids: values.slice(i, i + 4).join(',')},
          },
        },
      });
  }
  const impact = {
    affected_ads: usage,
    recovery_plan: recovery,
    creative_edit_confirmed: override,
    automatic_repromotion: false,
    warning: xCreativeWarnings(p)[0],
    recovery_requirement:
      'Read each line item first. Re-promote only confirmed missing associations after a fresh review and spend confirmation. Original promoted IDs and vendor idempotence are not guaranteed.',
  };
  if (usage.length && !override)
    throw new MirrorError(
      'CREATIVE_IN_USE',
      'This creative is referenced by promoted Tweets. Editing it may delete or disrupt these ads. Review the affected list and explicitly acknowledge the destructive risk.',
      {
        ...impact,
        override_parameter: 'creative_edit_confirmed',
        next_action:
          'Prepare a new review with creative_edit_confirmed=true, inspect this same list, then also provide the flag when executing.',
      },
    );
  return impact;
}
// X's single-card GET/PUT/DELETE examples wrap the exact resource in a one-row array.
// Other collection results must not be silently reduced to their first element.
function oneCard(data: unknown): JsonObject | undefined {
  return object(data) ? data : Array.isArray(data) && data.length === 1 && object(data[0]) ? data[0] : undefined;
}
export function xCreativeOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = xCreativeKind(p),
    raw = object(r.data) ? r.data.data : undefined,
    d = kind === 'card_update' || kind === 'card_delete' ? oneCard(raw) : raw,
    b = (p.body ?? {}) as JsonObject;
  if (r.status < 200 || r.status >= 300) return false;
  if (kind === 'promotion')
    return (
      Array.isArray(d) &&
      d.every(object) &&
      d.length === b.tweet_ids.split(',').length &&
      new Set(d.map(x => x.id)).size === d.length &&
      new Set(d.map(x => x.tweet_id)).size === d.length &&
      d.every(
        x =>
          typeof x.id === 'string' &&
          native.test(x.id) &&
          x.line_item_id === b.line_item_id &&
          b.tweet_ids.split(',').includes(x.tweet_id) &&
          x.entity_status === 'ACTIVE' &&
          x.deleted !== true,
      )
    );
  if (!object(d)) return false;
  if (kind === 'library_create') return d.media_key === b.media_key && d.deleted !== true;
  if (kind === 'tweet_create' || kind === 'tweet_rename')
    return !!xId(d) && (kind === 'tweet_create' || xId(d) === p.path.split('/').at(-2));
  if (kind === 'card_create')
    return !!xId(d) && typeof d.card_uri === 'string' && /^card:\/\/[0-9]+$/.test(d.card_uri) && d.deleted !== true;
  if (kind === 'card_update' || kind === 'card_delete')
    return xId(d) === p.path.split('/').at(-1) && (kind === 'card_delete' ? d.deleted === true : d.deleted !== true);
  return false;
}
function differences(expected: any, actual: any, path = '', out: string[] = []): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) out.push(path);
    else expected.forEach((v, i) => differences(v, actual[i], path + '/' + i, out));
  } else if (object(expected))
    for (const [k, v] of Object.entries(expected)) differences(v, actual?.[k], path + '/' + k, out);
  else if (expected !== actual) out.push(path);
  return out;
}
function comparedFields(expected: any, actual: any): any {
  if (Array.isArray(expected))
    return Array.isArray(actual) ? actual.map((v, i) => comparedFields(expected[i], v)) : actual;
  return object(expected)
    ? Object.fromEntries(Object.keys(expected).map(k => [k, comparedFields(expected[k], actual?.[k])]))
    : actual;
}
export async function verifyXCreative(
  p: CompiledRequest,
  result: JsonObject,
  send: Read,
): Promise<{status: string; checks: JsonObject[]}> {
  const kind = xCreativeKind(p),
    read = xReader(p, send),
    b = (p.body ?? {}) as JsonObject,
    raw = result.data.data,
    d = kind === 'card_update' || kind === 'card_delete' ? oneCard(raw)! : raw;
  const check = (id: string, expected: JsonObject, actual: JsonObject) => {
    const changed = differences(expected, actual);
    return {
      resource_id: id,
      status: changed.length ? 'mismatch' : 'verified',
      changed_fields: changed,
      expected_hash: sha256(stable(expected)),
      actual_hash: sha256(stable(comparedFields(expected, actual))),
      checked_fields: Object.keys(expected),
    };
  };
  let checks: JsonObject[] = [];
  if (kind === 'promotion') {
    const rows = await read.promotions(b.line_item_id);
    checks = d.map((record: JsonObject) => {
      const row = rows.find(r => r.id === record.id && r.tweet_id === record.tweet_id);
      return row
        ? check(
            record.id,
            {tweet_id: record.tweet_id, line_item_id: b.line_item_id, entity_status: 'ACTIVE', deleted: false},
            {...row, deleted: row.deleted ?? false},
          )
        : {
            resource_id: record.id,
            status: 'pending',
            code: 'X_PROMOTION_NOT_VISIBLE',
            line_item_id: b.line_item_id,
            tweet_id: record.tweet_id,
          };
    });
  } else if (kind === 'tweet_create' || kind === 'tweet_rename') {
    const id = xId(d)!;
    checks = [
      check(id, b, tweetView((await read.tweets([id], kind === 'tweet_create' ? [b.as_user_id] : undefined))[0]!)),
    ];
  } else if (kind === 'library_create') {
    const row = await read.single('/media_library/' + b.media_key, b.media_key, 'media_key');
    mediaReady(row);
    checks = [check(b.media_key, b, row)];
  } else if (kind === 'card_create' || kind === 'card_update' || kind === 'card_delete') {
    const id = xId(d)!,
      row = await read.single(
        kind === 'card_create' ? '/cards/' + id : cardSuffix(p),
        id,
        'id',
        kind === 'card_delete',
      );
    checks = [
      check(
        id,
        kind === 'card_delete'
          ? {deleted: true}
          : xLegacyCardType(p)
            ? Object.fromEntries(Object.entries(b).filter(([k]) => !writeOnly.includes(k)))
            : b,
        row,
      ),
    ];
  } else return {status: 'unsupported', checks: []};
  return {
    status: checks.some(c => c.status === 'pending')
      ? 'pending'
      : checks.every(c => c.status === 'verified')
        ? 'verified'
        : 'mismatch',
    checks,
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xCreativeFamily: ReviewedFamily = {
  name: 'x_creatives',
  files: ['src/x-creative-writes.ts', ['tests/x-creative-writes.test.ts', 'tests/x-legacy-card-edits.test.mjs']],
  kind: xCreativeKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertXCreative(plan);
  },
  snapshots: xCreativeSnapshots,
  state: (plan, readers) =>
    readXCreativeState(plan, readers.guarded('Creative dependency checks must be read-only.').read),
  impact: (plan, state, review) => {
    const x = xCreativeImpact(plan, state, review.creativeEditConfirmed, review.connectionId);
    return x && {provider: 'x', ...x};
  },
  outcome: xCreativeOutcome,
  verify: async (plan, v) => {
    let verified!: Awaited<ReturnType<typeof verifyXCreative>>;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await delay(attempt * 250);
      verified = await verifyXCreative(plan, v.result, v.guarded('X verification must remain read-only.'));
      if (!xPromotion(plan) || verified.status !== 'pending') break;
    }
    return {status: verified.status, checks: verified.checks};
  },
  spendConfirmation: {
    needed: plan => xPromotion(plan),
    message:
      'X promotion may serve immediately. Review the parent delivery state and provide spend_change_confirmed=true.',
  },
  activates: plan => !!xPromotion(plan),
  destructive: plan => !!xCreativeEdit(plan),
  warnings: plan => xCreativeWarnings(plan),
  creativeEditConfirmation: plan => !!xCreativeEdit(plan),
  stateAsRead: true,
};
