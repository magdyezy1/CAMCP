import {stable} from './security.js';

/**
 * What the TikTok Search keyword code of this package shares (R2.5 M4, package r25-m4-search2): the match types and the bound of a keyword
 * list, and the set a keyword list is compared as. A leaf: nothing is imported at load but `stable`.
 *
 * These three names and this behaviour are those of package r25-m4-search's src/tiktok-search-recipe.ts (stage 1: `tiktokSearchMatchTypes`,
 * `tiktokSearchKeywordLimit`, `tiktokSearchKeywordSet`), which is not on this branch's base: the two copies are the same, on purpose, so that
 * the merge keeps one and points the other's imports at it (the lead's note for stage 2). Nothing else of that module is copied here.
 */

/**
 * The match types of a Search keyword: exact, phrase and broad. TikTok's manual pages name them ("Create a manual ad group", read
 * 2026-11-20, DOCS-EVIDENCE section 6). That the Smart+ Search pages use the same enum is UNVERIFIED (the lead's session did not record
 * them): TikTok refuses a value it does not know with a code AMCP records as a rejection (src/tiktok-write-rejection.ts).
 */
export const tiktokSearchMatchTypes: readonly string[] = ['PRECISE_WORD', 'PHRASE_WORD', 'BROAD_WORD'];
/** A Search ad group lists 1 to 1,000 keywords ("Create Manual Search Ads Campaigns" and the Sales/Web Smart+ Search page, read 2026-11-20). */
export const tiktokSearchKeywordLimit = 1000;

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The keywords of a Search ad group as a set, for the read-back and for the state a review keeps. TikTok adds the review status of each
 * keyword to the list it reads back (`audit_status` in the `search_keywords` array of an ad group read; its pages name the field and not its
 * values) and states no order, while a create sent a list of {keyword, match_type}. What a write sent is compared with what is stored as
 * the set of its items: without the status, in one order.
 */
export function tiktokSearchKeywordSet(list: unknown[]): unknown[] {
  return list
    .map(item => {
      if (!obj(item)) return item;
      const {audit_status: _status, ...rest} = item;
      return rest;
    })
    .sort((a, b) => {
      const x = stable(a),
        y = stable(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
}
