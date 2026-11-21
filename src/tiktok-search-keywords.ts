import {stable} from './security.js';

/**
 * What the TikTok Search keyword code of this package shares (R2.5 M4, package r25-m4-search2): the match types and the bound of a keyword
 * list, the set a keyword list is compared as, the list a review keeps as state, and what a rejected keyword looks like. A leaf: nothing is
 * imported at load but `stable`.
 *
 * `tiktokSearchMatchTypes`, `tiktokSearchKeywordLimit` and `tiktokSearchKeywordSet` are, with the same names and the same behaviour, package
 * r25-m4-search's (stage 1: src/tiktok-search-recipe.ts, accepted at d714decc, after its lead review S3-3), which is not on this branch's
 * base: the two copies are the same, on purpose, so that the merge keeps one and points the other's imports at it. `tiktokSearchKeywordReviewSet`
 * and `tiktokSearchKeywordRejected` are this package's own (the lead's review S2-3 and S3-3).
 *
 * What TikTok's pages say of a Smart+ keyword (impl/r25-m4-search2-DOCS.md, P14, P15, P17, read 2026-11-21): an item is `keyword`, `match_type`,
 * `audit_status` (AUDITING, PASS or REJECTED) and `reject_info`, "returned only when audit_status is REJECTED". There is no per-keyword setting.
 */

/**
 * The match types of a Search keyword: exact, phrase and broad. The Smart+ create and update pages list them as the enum of `match_type`
 * (P14, P15, P17), the same as the manual pages.
 */
export const tiktokSearchMatchTypes: readonly string[] = ['PRECISE_WORD', 'PHRASE_WORD', 'BROAD_WORD'];
/** A Search ad group lists 1 to 1,000 keywords (the Smart+ create and update pages, P14 and P15). */
export const tiktokSearchKeywordLimit = 1000;

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const order = (a: unknown, b: unknown) => {
  const x = stable(a),
    y = stable(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The keywords of a Search ad group as a set, for the read-back (the adapter's verification and observed hooks). TikTok adds the review
 * status of each keyword to the list it reads back (`audit_status` in the `search_keywords` array of /adgroup/get/, "Create Manual Search
 * Ads Campaigns", read 2026-11-20, which names the field and not its values) and states no order, while the create sent a list of
 * {keyword, match_type}. What the write sent is compared with what is stored as the set of those pairs and nothing else (the lead's review
 * S3-3): every other field of an item is TikTok's own, as the status is, and the page names one more, `keyword_bid_type`, which defaults to
 * FOLLOW_ADGROUP, so a comparison that dropped only the status would stop every build at the ad group the day TikTok adds another. A
 * missing, an extra, a duplicated, a re-cased and a re-typed keyword still differ. The review's own state keeps its list as TikTok reads it,
 * less the volatile `audit_status` (tiktokSearchKeywordReviewSet).
 */
export function tiktokSearchKeywordSet(list: unknown[]): unknown[] {
  return list
    .map(item => {
      if (!obj(item)) return item;
      return Object.fromEntries(['keyword', 'match_type'].filter(key => key in item).map(key => [key, item[key]]));
    })
    .sort(order);
}

/**
 * The keywords of a Search ad group as a review keeps them for the state it compares between prepare and execute (src/tiktok-smart-plus-
 * adgroup-updates.ts): in one order, since TikTok states none, without the review status `audit_status` that moves by itself (AUDITING to PASS
 * between two reads is no change), and with everything else, `reject_info` included. A rejection is a change of what the ad group can serve on,
 * so a keyword that TikTok rejects between a prepare and its execute is a changed state; any other field an item gains is one too. This is not
 * the comparison of a write with its read-back, which is `tiktokSearchKeywordSet`.
 */
export function tiktokSearchKeywordReviewSet(list: unknown[]): unknown[] {
  return list
    .map(item => {
      if (!obj(item)) return item;
      const {audit_status: _status, ...rest} = item;
      return rest;
    })
    .sort(order);
}

/**
 * Whether a keyword is known to be rejected: TikTok returns `reject_info` "only when audit_status is REJECTED", and the review state carries no
 * `audit_status` (it is volatile), so the record of a rejection is what says so. An empty or null `reject_info` says nothing, and a keyword is
 * never taken for rejected on a doubt: a rejected keyword may be dropped from a list, any other may not (src/tiktok-smart-plus-adgroup-updates.ts).
 */
export function tiktokSearchKeywordRejected(item: unknown): boolean {
  if (!obj(item)) return false;
  const info = item.reject_info;
  return Array.isArray(info) ? info.length > 0 : obj(info) && Object.keys(info).length > 0;
}
