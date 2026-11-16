import {fail} from './family-kit.js';
import {listPageSize, object, text} from './ad-preview-kit.js';
import type {
  AdPreviewHooks,
  AdPreviewPage,
  AdPreviewRequest,
  AdPreviewRow,
  AdPreviewSelection,
} from './provider-adapter.js';
import type {JsonObject} from './types.js';

/**
 * X's part of amcp_ad_previews (src/ad-previews.ts; registered as the `previews` hooks of src/x-adapter.ts), qualified by package
 * r12-xpreview on the facts of docs/records/X-TWEET-PREVIEWS-PIN-2026-11-16.md.
 *
 * An ad of X is a promoted Tweet: the account's promoted Tweets (`GET promoted_tweets`: `line_item_ids` for a line item filter,
 * `promoted_tweet_ids` for named ones) name the Tweet each one promotes (`tweet_id`), and one Tweet can be promoted in several
 * line items. A dark (nullcast) Tweet can also be named by its own ID. Each Tweet is previewed once, by one `GET tweet_previews`
 * read with `tweet_type: PUBLISHED`, so an entry is a Tweet, with the promoted-Tweet IDs of this call that share it.
 *
 * What X's answer is trusted for: a Tweet named by its ID is first proven to be one of the account's own dark Tweets (`GET
 * tweets`, `timeline_type: NULLCAST`, which X answers for the account's default promotable user), because the preview read
 * itself documents only that the account is the authenticated user's, not whose Tweets it will preview; a Tweet that comes from the
 * account's own promoted Tweets is the account's by the path of that read. X's HTML is never passed through: its `preview` is
 * one `<iframe ... src='...'>` string, and only the src, when it is exactly https://ton.twimg.com/ads-manager/tweet-preview/
 * index.html, is returned, as a link.
 */
const promotedAction = 'x_accounts_account_id_promoted_tweets_get',
  lineItemsAction = 'x_accounts_account_id_line_items_get',
  tweetsAction = 'x_accounts_account_id_tweets_get',
  previewsAction = 'x_accounts_account_id_tweet_previews_get';

/** X documents up to 200 `tweet_ids` in one tweet_previews request (record X-TWEET-PREVIEWS-PIN-2026-11-16, TP2). */
export const xTweetPreviewBatch = 200;
/**
 * The page size of a read that names its IDs. X takes up to 200 IDs in each of those filters (`promoted_tweet_ids`, `line_item_ids`,
 * `tweet_ids`: R1 to R3 of the record) and a page of up to 1000 rows, so a page of 200 holds any answer to such a read. It is not
 * the number of IDs named: X can end a page that is exactly as large as its page size with a cursor, as a collection that cannot tell
 * whether another row follows does, and an answer with every ID named would then look incomplete. With the larger page, an answer
 * that still carries a cursor really is incomplete, and is refused.
 */
const namedPage = 200;
/** X states no expiry for a preview (TP5), so the answer says that and no `expires_at` is made up. */
export const xNoExpiry = 'X states no expiry for this preview link.';
/**
 * Why an entry has no link: a closed set, each with its sentence, never any text of X's. `not_returned`: X's answer has no entry for
 * the Tweet (its documented way of not previewing an ID, TP3). `link_not_accepted`: it has an entry that is not exactly one
 * iframe whose src is X's preview page, or two entries for the Tweet.
 */
export const xPreviewReasons = Object.freeze({
  not_returned: 'X returned no preview for this Tweet.',
  link_not_accepted: 'X returned a preview that AMCP does not accept as a safe link, so none is shown.',
});
type Reason = keyof typeof xPreviewReasons;

/** Where X's preview page is (TP4); the live answer of 2026-11-16 and the version 12 page agree, an older guide example does not. */
const previewHost = 'ton.twimg.com',
  previewPath = '/ads-manager/tweet-preview/index.html',
  /** What AMCP reads of one snippet; the example runs to a thousand characters or more (TP4), so this is a wide margin. */
  snippetLimit = 16384;

/**
 * The preview link of one `preview` snippet of X's answer, or null. The snippet must be one `<iframe ...>` start tag (X's
 * leaves its closing tag out, which is allowed) and nothing else: no other markup or text, no srcdoc, one src, quoted or
 * not, with no space, control character, angle bracket, backslash or fragment. The src must read as an https URL with no
 * user information or port whose host is exactly ton.twimg.com and whose path is exactly /ads-manager/tweet-preview/index.html.
 * `&amp;` is the only entity read, between parameters; the URL parser takes any other entity as the text it is (an HTML parser
 * would read `&sol;` as a slash, F-L3-13 of the other platforms' links), so none can be part of that exact host or path, and one
 * left after `&amp;` is read is no link. The link returned is the URL that was validated, in its normal form, never the text
 * of the snippet.
 */
export function xPreviewLink(snippet: unknown): string | null {
  if (typeof snippet !== 'string' || snippet.length > snippetLimit) return null;
  const tag = /^\s*<iframe\b([^<>]*)>\s*(?:<\/iframe\s*>\s*)?$/i.exec(snippet);
  if (!tag) return null;
  const attributes = new Map<string, string>();
  let rest = tag[1]!;
  while (rest.length) {
    const leading = /^\s+/.exec(rest);
    if (!leading) return null;
    rest = rest.slice(leading[0].length);
    if (!rest) break;
    const attribute = /^([a-z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/i.exec(rest);
    if (!attribute || attributes.has(attribute[1]!.toLowerCase())) return null;
    attributes.set(attribute[1]!.toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    rest = rest.slice(attribute[0].length);
  }
  const src = attributes.get('src');
  if (!src || attributes.has('srcdoc') || /[\x00-\x20\x7f<>#\\]/.test(src)) return null;
  const decoded = src.replaceAll('&amp;', '&');
  if (/&#?\w+;/.test(decoded)) return null;
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname !== previewHost ||
    url.pathname !== previewPath ||
    url.href.length > snippetLimit
  )
    return null;
  return url.href;
}

/** `ids` in order, in batches of at most `size` (X's 200 `tweet_ids` of one request). */
export function xPreviewBatches<T>(ids: readonly T[], size = xTweetPreviewBatch): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < ids.length; at += size) batches.push(ids.slice(at, at + size));
  return batches;
}

/** An entity of X's own (campaign, line item, promoted Tweet): lower-case letters and digits. */
const entityId = /^[a-z0-9]{1,32}$/,
  /**
   * A Tweet's own ID has 15 digits or more. X's entity IDs are short lower-case base 36 (the documentation's examples have 5 to 11
   * characters), so the two are told apart by their shape. If one were ever taken for the other, the ID would not be in the list it
   * is looked up in and would be reported not found: nothing is previewed on a guess.
   */
  tweetIdOf = /^[1-9][0-9]{14,24}$/,
  /** A Tweet ID as X's lists state it (src/x-portfolio.ts takes the same). */
  listedTweetId = /^[1-9][0-9]{0,24}$/;
// Declared as functions with an explicit `never`, so that a check that ends in one narrows what follows it.
function invalidList(): never {
  return fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
}
function foreign(): never {
  return fail('ACCOUNT_SCOPE_MISMATCH', 'Not in this account');
}

/** What X's own filters of a preview call are: its IDs, never anything the tool's pattern would let through. */
function normalize(kind: 'ad' | 'campaign' | 'adset', values: string[]): string[] {
  if (kind === 'ad') return [...new Set(values)];
  for (const value of values)
    if (!entityId.test(value))
      fail(
        'INVALID_ARGUMENT',
        'X preview filters use X’s own IDs: campaign IDs in campaign_ids and line item IDs in adset_ids.',
      );
  return values;
}

/**
 * One X collection as its documents give it: `data` of at most `limit` rows, the account of the request (when the answer echoes
 * it) and an explicit `next_cursor`, null (or X's older "0") at the end. Anything else is not a list that can be continued.
 */
function collection(response: unknown, account: string, limit: number): {rows: unknown[]; next: string | null} {
  if (!object(response) || !Array.isArray(response.data) || response.data.length > limit) return invalidList();
  const echoed =
    object(response.request) && object(response.request.params) ? response.request.params.account_id : undefined;
  if (echoed !== undefined && echoed !== account) return foreign();
  const next = response.next_cursor;
  if (next === null || next === '' || next === '0' || next === 0) return {rows: response.data, next: null};
  if (typeof next !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(next)) return invalidList();
  return {rows: response.data, next};
}

/** A promoted Tweet of X's list, as AMCP reads it: its ID, the Tweet it promotes, its line item and its own status. */
interface Promotion {
  id: string;
  tweet: string;
  line: string | undefined;
  status: string | undefined;
}
function promotion(raw: unknown, account: string): Promotion {
  if (
    !object(raw) ||
    typeof raw.id !== 'string' ||
    !entityId.test(raw.id) ||
    typeof raw.tweet_id !== 'string' ||
    !listedTweetId.test(raw.tweet_id) ||
    (raw.line_item_id !== undefined && (typeof raw.line_item_id !== 'string' || !entityId.test(raw.line_item_id))) ||
    (raw.deleted !== undefined && typeof raw.deleted !== 'boolean')
  )
    return invalidList();
  if (raw.account_id !== undefined && raw.account_id !== account) return foreign();
  return {
    id: raw.id,
    tweet: raw.tweet_id,
    line: raw.line_item_id,
    // A deleted promotion is archived (X lists one only when asked to); an ACTIVE or PAUSED one is as it says; the rest (DRAFT)
    // is selected by "all" alone. The status is the promoted Tweet's own: a paused line item above it is not considered.
    status:
      raw.deleted === true
        ? 'archived'
        : ({ACTIVE: 'active', PAUSED: 'paused'} as Record<string, string | undefined>)[String(raw.entity_status)],
  };
}

/** One entry of the answer: a Tweet, the promoted-Tweet IDs of this call that share it, and the name X gave a dark Tweet. */
interface Ad {
  tweet: string;
  promoted: string[];
  name: string | null;
}

async function select(request: AdPreviewRequest): Promise<AdPreviewSelection> {
  const {account, wanted, statuses, campaigns, adsets, base, read, matches, pageSelection, notListed} = request;
  const ads = new Map<string, Ad>(),
    tweetOf = new Map<string, string>(),
    campaignOf = new Map<string, string>(),
    asked = new Set<string>();
  const add = (tweet: string, promoted?: string, name: string | null = null) => {
    const ad = ads.get(tweet) ?? {tweet, promoted: [], name};
    if (promoted !== undefined && !ad.promoted.includes(promoted)) ad.promoted.push(promoted);
    ad.name ??= name;
    ads.set(tweet, ad);
  };
  const asRow = (p: Promotion): AdPreviewRow => ({
    id: p.id,
    name: null,
    status: p.status,
    ...(p.line === undefined ? {} : {adset: p.line}),
    ...(p.line === undefined || !campaignOf.has(p.line) ? {} : {campaign: campaignOf.get(p.line)!}),
  });
  /** The campaign of each line item a page names, from the account's line items (a promoted Tweet names no campaign). */
  const resolveCampaigns = async (lines: (string | undefined)[]) => {
    const unknown = [...new Set(lines.filter((line): line is string => line !== undefined && !asked.has(line)))];
    if (!unknown.length) return;
    for (const line of unknown) asked.add(line);
    const listed = collection(
      await read({
        action: lineItemsAction,
        ...base,
        query: {line_item_ids: unknown.join(','), with_deleted: true, with_draft: true, count: namedPage},
      }),
      account,
      unknown.length,
    );
    if (listed.next !== null) return invalidList();
    for (const raw of listed.rows) {
      if (
        !object(raw) ||
        typeof raw.id !== 'string' ||
        !unknown.includes(raw.id) ||
        campaignOf.has(raw.id) ||
        typeof raw.campaign_id !== 'string' ||
        !entityId.test(raw.campaign_id)
      )
        return invalidList();
      if (raw.account_id !== undefined && raw.account_id !== account) return foreign();
      campaignOf.set(raw.id, raw.campaign_id);
    }
  };

  let paging: JsonObject = {},
    missing: string[] = [];
  if (wanted) {
    // Named IDs: a promoted-Tweet ID is read from the account's promoted Tweets (deleted ones listed, as named IDs ignore
    // statuses); a Tweet ID is proven among the account's own dark Tweets before anything is previewed, unless the Tweet is the
    // one of a promoted Tweet named with it. An ID of neither shape is never sent to X.
    const promotedNamed = wanted.filter(id => !tweetIdOf.test(id) && entityId.test(id)),
      tweetNamed = wanted.filter(id => tweetIdOf.test(id)),
      found = new Map<string, Promotion>(),
      resolved = new Set<string>();
    if (promotedNamed.length) {
      const listed = collection(
        await read({
          action: promotedAction,
          ...base,
          query: {promoted_tweet_ids: promotedNamed.join(','), with_deleted: true, count: namedPage},
        }),
        account,
        promotedNamed.length,
      );
      if (listed.next !== null) invalidList();
      for (const raw of listed.rows) {
        const row = promotion(raw, account);
        if (!promotedNamed.includes(row.id) || found.has(row.id)) invalidList();
        found.set(row.id, row);
      }
      if (campaigns.length) await resolveCampaigns([...found.values()].map(row => row.line));
    }
    const chosen = new Map([...found].filter(([, row]) => matches(asRow(row), true))),
      covered = new Set([...chosen.values()].map(row => row.tweet)),
      lookup = tweetNamed.filter(id => !covered.has(id)),
      dark = new Map<string, string | null>();
    // A Tweet has no campaign or line item: with either filter it cannot match, so it is not even looked for.
    if (lookup.length && !campaigns.length && !adsets.length) {
      const listed = collection(
        await read({
          action: tweetsAction,
          ...base,
          query: {
            tweet_ids: lookup.join(','),
            tweet_type: 'PUBLISHED',
            timeline_type: 'NULLCAST',
            include_mentions_and_replies: true,
            count: namedPage,
          },
        }),
        account,
        lookup.length,
      );
      if (listed.next !== null) invalidList();
      for (const raw of listed.rows) {
        // A Tweet's ID is its string (`id_str`, or a string `tweet_id`): a number in a JSON answer may not be the ID it was
        // written as, so it names nothing. The IDs a row gives must agree, and be among those asked for.
        const ids = object(raw)
            ? [raw.id_str, raw.tweet_id].filter((value): value is string => typeof value === 'string')
            : [],
          [first] = ids;
        if (
          !object(raw) ||
          first === undefined ||
          ids.some(id => id !== first || !lookup.includes(id)) ||
          dark.has(first) ||
          raw.nullcast === false
        )
          invalidList();
        dark.set(first, text(raw.name));
      }
    }
    for (const id of wanted) {
      const row = found.get(id);
      if (row) {
        if (chosen.has(id)) {
          add(row.tweet, row.id);
          resolved.add(id);
        }
      } else if (dark.has(id)) {
        add(id, undefined, dark.get(id));
        resolved.add(id);
      } else if (covered.has(id)) {
        add(id);
        resolved.add(id);
      }
    }
    missing = wanted.filter(id => !resolved.has(id));
  } else {
    // The account's promoted Tweets, a native page of 100 at a time on X's own cursor, filtered by status, campaign and line
    // item. A line item filter goes to X as well (it is documented, up to 200 IDs) and is applied again to what comes back.
    const deleted = statuses.includes('archived') || statuses.includes('all');
    const pageOf = async (after: string | null, _page: number): Promise<AdPreviewPage> => {
      const listed = collection(
        await read({
          action: promotedAction,
          ...base,
          query: {
            count: listPageSize,
            with_deleted: deleted,
            ...(adsets.length ? {line_item_ids: adsets.join(',')} : {}),
            ...(after ? {cursor: after} : {}),
          },
        }),
        account,
        listPageSize,
      );
      const rows = listed.rows.map(raw => promotion(raw, account));
      if (campaigns.length) await resolveCampaigns(rows.map(row => row.line));
      for (const row of rows) tweetOf.set(row.id, row.tweet);
      return {rows: rows.map(asRow), after: listed.next, more: listed.next !== null};
    };
    const selected = await pageSelection(pageOf);
    paging = selected.paging;
    for (const row of selected.chosen) add(tweetOf.get(row.id)!, row.id);
  }

  /** X's `preview` values by Tweet: one read for every Tweet of this call (at most ten), in batches of at most 200. */
  let answers: Promise<Map<string, unknown[]>> | undefined;
  const answered = () =>
    (answers ??= (async () => {
      const previews = new Map<string, unknown[]>();
      for (const batch of xPreviewBatches([...ads.keys()])) {
        const response = await read({
          action: previewsAction,
          ...base,
          query: {tweet_ids: batch.join(','), tweet_type: 'PUBLISHED'},
        });
        if (!object(response) || !Array.isArray(response.data) || response.data.length > 1000) return invalidList();
        const echoed =
          object(response.request) && object(response.request.params) ? response.request.params.account_id : undefined;
        if (echoed !== undefined && echoed !== account) return foreign();
        // An entry for a Tweet that was not asked for is not read; two for one Tweet cannot both be its preview.
        for (const item of response.data)
          if (object(item) && typeof item.tweet_id === 'string' && batch.includes(item.tweet_id))
            previews.set(item.tweet_id, [...(previews.get(item.tweet_id) ?? []), item.preview]);
      }
      return previews;
    })());
  return {
    rows: [...ads.values()].map(ad => ({id: ad.tweet, name: ad.name})),
    preview: async row => {
      const ad = ads.get(row.id)!,
        entries = (await answered()).get(row.id) ?? [],
        link = entries.length === 1 ? xPreviewLink(entries[0]) : null,
        without = (reason: Reason) => ({
          tweet_id: ad.tweet,
          promoted_tweet_ids: ad.promoted,
          links: [],
          reason,
          note: xPreviewReasons[reason],
        });
      if (!entries.length) return without('not_returned');
      if (link === null) return without('link_not_accepted');
      return {tweet_id: ad.tweet, promoted_tweet_ids: ad.promoted, links: [link], expires: xNoExpiry};
    },
    extra: {...paging, ...notListed(missing)},
  };
}

export const xAdPreviews: AdPreviewHooks = Object.freeze({platform: 'x_ads', normalize, select});
