import {MirrorError} from './errors.js';
import {deprecationEffective, deprecationNow} from './provider-deprecations.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * End cards in an Upgraded Smart+ ad (package r25-m4b-endcards; matrix A10). The pure parts of it: the list an ad names, the read of the
 * end cards it names, what a review keeps of that read, the checks of what the read returned, and the sentences the review says. The shape
 * rules of the list are src/tiktok-smart-plus-ads.ts's, and the edit of it is src/tiktok-smart-plus-ad-updates.ts's. A leaf: it imports
 * no other module of the family.
 *
 * What the pages say (API for Business v1.3, read 2026-11-22; the stable /portal/docs/<slug>/v1.3 form of each URL):
 * - "Create an Upgraded Smart+ Ad" (create-an-upgraded-smart-ad) and "Update an Upgraded Smart+ Ad" (update-an-upgraded-smart-ad): a top-level
 *   parameter `end_card_list` (an object[] beside `ad_text_list`, `page_list` and `interactive_add_on_list`, not inside `ad_configuration`):
 *   "A list of end cards. An end card is an interactive card at the end of your ad to encourage audiences to take action. Size range: 1–10."
 *   Each item is `{end_card_id}`: "End card ID. To create an end card and obtain the ID, use /creative/portfolio/create/ with
 *   creative_portfolio_type set to END_CARD, then retrieve the returned creative_portfolio_id. To find existing end cards in your ad account,
 *   use /creative/portfolio/list/, set the creative_portfolio_types filter to ["END_CARD"], and retrieve the returned creative_portfolio_id."
 *   Its notes: "Using end cards in your ads is currently an allowlist-only feature. To request access, contact your TikTok representative."
 *   and "Duplicate end cards are not allowed. Otherwise, an error will occur." and "You cannot use this field together with
 *   interactive_add_on_list. When you specify both end_card_list and interactive_add_on_list, interactive_add_on_list is ignored." The
 *   update page adds: "You can only use this field to update existing end cards in your ads."
 * - THE DATED REQUIREMENT, word for word on the create page and on "Use end cards in TikTok Ad Network ads" (use-end-cards-in-tiktok-ad-network-ads):
 *   "Starting February 22, 2027, if you are an allowlisted advertiser, end cards are required for eligible ad scenarios. To ensure a
 *   seamless integration, begin including end cards for these scenarios now." The pages define no "eligible ad scenario" beyond the one
 *   that guide documents: an Upgraded Smart+ web campaign (WEB_CONVERSIONS, WEBSITE, not a Search campaign; with no catalog or an
 *   e-commerce one), an ad group on the TikTok Ad Network (PLACEMENT_TYPE_NORMAL with PLACEMENT_PANGLE), a custom identity ad
 *   (CUSTOMIZED_USER) with at least one video, and no interactive add-ons. It documents no read of the allowlist, so AMCP never refuses a
 *   request for lacking an end card: TikTok's own refusal is definitive (nothing is created), and the review says what the page says, for
 *   that scenario (`endCardScenario`; src/provider-deprecations.ts, `tiktok_smart_plus_end_cards`; QUESTIONS L4 of M4b). A Spark Ad, which
 *   is every ad this contract creates, is outside it: its review has a caveat that TikTok decides, and no note about the date.
 * - "Get portfolios or end cards within an ad account" (get-portfolios-within-an-ad-account): GET /v1.3/creative/portfolio/list/ with
 *   `filtering.creative_portfolio_ids` (at most 100) and `page_size` 1 to 100 returns `creative_portfolios[]` of `creative_portfolio_id`,
 *   `creative_portfolio_type` (END_CARD for an end card) and a preview link, which the page says does not expire. No write depends on it, and a
 *   review holds no link (the owner's rule), so AMCP keeps the ID and the type, never the link.
 * - "Get Upgraded Smart+ Ads" returns `end_card_list` of `{end_card_id}` with the ad, the read-back of a create and of an edit.
 *
 * `ad_configuration.end_card_cta` is another field on the same pages: the call to action of the end card IMAGE of an Automotive catalog
 * carousel ad and of the catalog solution of TikTok Direct Messaging lead ads. It is catalog work (matrix C8 and A9, package smartcatalog),
 * and stays outside the contract.
 */
/** "Size range: 1–10" of end_card_list. */
export const maxEndCards = 10;
/** A portfolio ID (`creative_portfolio_id`), a string of digits as every portfolio ID this contract names. */
export const endCardIdPattern = /^[1-9][0-9]{0,31}$/;
/** The route the page names for finding the end cards of an ad account, and what a request for them asks (at most 100 IDs a read). */
export const endCardListPath = '/v1.3/creative/portfolio/list/';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** A provider token (a portfolio type) as a message may quote it: capitals, digits and underscores only. */
const token = (v: unknown) => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? v : undefined);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_AD', message, {field});
}

/** The end card IDs of an `end_card_list`, in its order, for the items that name one (the shape rules refuse the rest). */
export const endCardIdsOf = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.filter((e): e is JsonObject => obj(e) && typeof e.end_card_id === 'string').map(e => e.end_card_id as string)
    : [];
/** What a read-back's list is, as a set: the sorted IDs, once each (TikTok states no order for the list). */
export const endCardProjection = (list: unknown): string[] =>
  [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map(e => (obj(e) && e.end_card_id !== undefined && e.end_card_id !== null ? String(e.end_card_id) : ''))
        .filter(Boolean),
    ),
  ].sort(order);
/** Whether a plan's body names end cards (a request that does not is reviewed, sent and read exactly as it was before this module). */
export const usesEndCards = (plan?: CompiledRequest): boolean =>
  !!plan && obj(plan.body) && plan.body.end_card_list !== undefined;

/**
 * The read of the end cards a request names: the portfolio list of the selected advertiser, filtered by their IDs, before the review and
 * again before execution. Marked, so that the review keeps of it what it compares (the IDs and the types) and never the preview link: no write
 * depends on it, and a review holds no link (the page says the link does not expire, so this is the owner's rule and not a need).
 */
export type EndCardMarked = CompiledRequest & {tiktokEndCards?: true};
export interface EndCardRead {
  path: string;
  query: JsonObject;
  action: string;
  endCards: true;
}
export function endCardReads(accountId: string | undefined, list: unknown): EndCardRead[] {
  const ids = [...new Set(endCardIdsOf(list))].sort(order);
  return ids.length
    ? [
        {
          path: endCardListPath,
          query: {advertiser_id: accountId, filtering: {creative_portfolio_ids: ids}, page: 1, page_size: 100},
          action: 'tiktok_creative_portfolio_list_get',
          endCards: true,
        },
      ]
    : [];
}
/** Whether a read is the end card read of a request (set where the read is built). */
export const isEndCardRead = (read: CompiledRequest): boolean => (read as EndCardMarked).tiktokEndCards === true;
/** The IDs a read was asked for, and the portfolios of its answer, for the check that every one asked for came back. */
export function endCardAnswer(
  read: CompiledRequest,
  data: JsonObject,
): {requested: string[]; returned: string[]} | undefined {
  if (!isEndCardRead(read)) return undefined;
  const filtering = obj(read.query.filtering) ? read.query.filtering : {},
    requested = Array.isArray(filtering.creative_portfolio_ids)
      ? (filtering.creative_portfolio_ids as unknown[]).map(String)
      : [],
    rows = obj(data.data) && Array.isArray(data.data.creative_portfolios) ? data.data.creative_portfolios : [];
  return {requested, returned: rows.map((r: unknown) => String(obj(r) ? r.creative_portfolio_id : undefined))};
}
/**
 * What a review keeps of the read: the ID and type of each end card asked for, sorted by ID, and nothing of any other portfolio the list
 * returns (another end card of the advertiser changing between prepare and execute is no change of this review). A fresh answer lists
 * `creative_portfolios`; a saved review's state already has `end_cards` (execute projects the saved state again, so this is idempotent).
 */
export function endCardState(read: CompiledRequest, d: JsonObject): JsonObject | undefined {
  if (!isEndCardRead(read)) return undefined;
  const asked = new Set(endCardAnswer(read, {})!.requested),
    saved = obj(d.data) && Array.isArray(d.data.end_cards) ? d.data.end_cards : undefined,
    rows = saved ?? (obj(d.data) && Array.isArray(d.data.creative_portfolios) ? d.data.creative_portfolios : []);
  const kept = rows
    .filter(obj)
    .map(r => ({
      id: String(r.id ?? r.creative_portfolio_id),
      type: typeof (r.type ?? r.creative_portfolio_type) === 'string' ? (r.type ?? r.creative_portfolio_type) : null,
    }))
    .filter(r => asked.has(r.id))
    .sort((a, b) => order(a.id, b.id));
  return {data: {end_cards: kept}};
}
/**
 * The end cards a request names are the advertiser's, and end cards (checked against the state the review read, at prepare and again at
 * execute): a portfolio the list did not return is not the advertiser's, and one of another type is no end card.
 */
export function checkEndCardState(list: unknown, data: JsonObject[]): void {
  const rows = data.flatMap(d => (Array.isArray(d.end_cards) ? (d.end_cards as JsonObject[]) : []));
  endCardIdsOf(list).forEach((id, i) => {
    const row = rows.find(r => r.id === id);
    if (!row)
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'End card ' + id + ' was not returned for the selected advertiser.',
        {end_card_id: id},
      );
    if (row.type !== 'END_CARD')
      invalid(
        'end_card_list[' + i + '].end_card_id',
        'Portfolio ' +
          id +
          ' is ' +
          (token(row.type) ? 'a ' + token(row.type) : 'of another type') +
          ' portfolio, not an end card (END_CARD): end_card_id needs the ID of an end card of the selected advertiser.',
      );
  });
}

/**
 * Whether an ad group delivers to the TikTok Ad Network, where TikTok documents end cards ("Use end cards in TikTok Ad Network ads": the ad
 * group's `placement_type` is PLACEMENT_TYPE_NORMAL and its `placements` PLACEMENT_PANGLE): true for a group that names Pangle or whose
 * placements are automatic ("Create a regular Upgraded Smart+ Web Campaign": automatic placement spreads delivery over TikTok, the Global App
 * Bundle and Pangle), false for a group whose chosen placements leave Pangle out, undefined where its row says neither.
 */
export function deliversToAdNetwork(group: JsonObject | undefined): boolean | undefined {
  if (!group) return undefined;
  if (group.placement_type === 'PLACEMENT_TYPE_AUTOMATIC') return true;
  if (group.placement_type === 'PLACEMENT_TYPE_NORMAL' && Array.isArray(group.placements))
    return group.placements.includes('PLACEMENT_PANGLE');
  return undefined;
}

/**
 * The scenario TikTok documents end cards for ("Use end cards in TikTok Ad Network ads", read 2026-11-22): an Upgraded Smart+ web campaign
 * whose ad group is on Pangle placements (`PLACEMENT_TYPE_NORMAL` with `PLACEMENT_PANGLE`) and whose ad is under a custom identity
 * (`CUSTOMIZED_USER`; "Update an Upgraded Smart+ Ad" adds that such an ad cannot be created in an ad group whose placements include TikTok).
 * Every ad this contract creates is a Spark Ad (a post of a TikTok account, a Business Center or a creator), so none is in it. The first
 * version of the requirement's note judged the ad group's placement alone, and S3-1 of the lead's review found what that did: from 2027-02-22
 * the most common create, a Spark Ad in an ad group with automatic placement, was told to add end cards, which TikTok refuses with 40118 for an
 * advertiser that is not on its allowlist, in a scenario its pages do not document for a Spark Ad. The note now waits for the package that
 * creates custom identity ads (matrix A4, `smartcreative`), whose ads are this scenario. The campaign's own conditions (WEB_CONVERSIONS, not a
 * Search campaign) are not read by an ad create and are not judged here.
 */
export function endCardScenario(group: JsonObject | undefined, identityType: unknown): boolean {
  return (
    identityType === 'CUSTOMIZED_USER' &&
    group?.promotion_type === 'WEBSITE' &&
    group.placement_type === 'PLACEMENT_TYPE_NORMAL' &&
    Array.isArray(group.placements) &&
    group.placements.includes('PLACEMENT_PANGLE')
  );
}

/**
 * What the review says of end cards: one fixed sentence each, with its Arabic in web/locales/ar.json. The allowlist is TikTok's to decide
 * (the rule of the allowlist-gated capabilities of r25-m4b-COMMON: built and gated, never refused locally; 40118 is one of the nine
 * definitive refusals of src/tiktok-write-rejection.ts). TikTok documents end cards for custom identity ads on the TikTok Ad Network only, so
 * a request outside that scenario says so, and TikTok decides.
 */
export const tiktokEndCardAllowlistNotice =
  'End cards are an allowlist-only feature of TikTok: an advertiser that is not on its allowlist is refused with code 40118, and nothing is created or changed.';
export const tiktokEndCardPlacementNote =
  'TikTok documents end cards for TikTok Ad Network ads, and this ad group does not deliver to the TikTok Ad Network: TikTok decides whether it accepts end cards on this ad.';
/** For an ad that is not under a custom identity, a Spark Ad: every ad this contract creates or edits (S3-1 of the lead's review). */
export const tiktokEndCardScenarioNote =
  'TikTok documents end cards for TikTok Ad Network ads under a custom identity. This is a Spark Ad from a TikTok post, outside that scenario: TikTok decides whether it accepts end cards on this ad.';
/** What a refusal 40118 of a request that uses end cards says to do. */
export const tiktokEndCardAllowlistRefusal =
  'TikTok refused this request with code 40118: the advertiser is not on its allowlist for a feature the request uses, and nothing was created or changed. If the request uses end_card_list, end cards are allowlist-only: ask TikTok to allowlist this advertiser for end cards.';

/**
 * What the review says from the day TikTok requires end cards for advertisers on its allowlist (the dated entry `tiktok_smart_plus_end_cards`
 * of src/provider-deprecations.ts): the day is that entry's, and "if TikTok has allowlisted this advertiser" is the sentence's own condition,
 * because no read of the allowlist exists and the pages define no eligible scenario beyond TikTok Ad Network ads under a custom identity. It
 * is a note and never a refusal (QUESTIONS L4 of M4b: never a local refusal on a guess).
 */
export const tiktokEndCardRequirementNote =
  'From 2027-02-22 TikTok requires end cards for advertisers on its allowlist, in the ad scenarios it calls eligible, and documents them for TikTok Ad Network ads under a custom identity. This ad is in that scenario and the request has no end_card_list: if TikTok has allowlisted this advertiser, it may refuse this ad; add end_card_list with an end card of this advertiser.';
export const endCardRequirementId = 'tiktok_smart_plus_end_cards';
/**
 * The requirement's note for a create that names no end card (`endCardImpact` asks only then): only in the scenario the page documents
 * (`endCardScenario`: a custom identity on a website ad group of Pangle placements), and only from the day. A Spark Ad, an Instant Form ad
 * group, an ad group that is not on Pangle placements and an ad group that was not read are outside it, and carry no note. This contract
 * creates no custom identity ad, so the note does not appear until a package that does (matrix A4) passes its identity here.
 */
export function endCardRequirement(
  group: JsonObject | undefined,
  identityType: unknown,
  now = deprecationNow(),
): JsonObject {
  if (!endCardScenario(group, identityType) || !deprecationEffective(endCardRequirementId, now)) return {};
  return {end_card_requirement: tiktokEndCardRequirementNote};
}
/**
 * The review's part for the end cards of a request, with the ad group the ad is in (its row, where the review read it) and the identity type
 * of its creatives (undefined where they differ, or the request is an edit, which has neither at hand and edits Spark Ads only): what the
 * request names, with the caveat that it is a Spark Ad outside TikTok's scenario and, where the ad group is not on the Ad Network, that too;
 * or, for a create that names no end card, the requirement's note, which only the scenario itself carries. The allowlist sentence is inside
 * the first, so that it never meets the review's own `allowlist` of an edit that also keeps a creative by its ad_material_id.
 */
export function endCardImpact(
  list: unknown,
  group?: JsonObject,
  identityType?: unknown,
  now = deprecationNow(),
): JsonObject {
  const ids = endCardIdsOf(list);
  if (!ids.length) return endCardRequirement(group, identityType, now);
  return {
    end_cards: {
      count: ids.length,
      end_card_ids: ids,
      allowlist: tiktokEndCardAllowlistNotice,
      ...(identityType !== 'CUSTOMIZED_USER' ? {scenario_note: tiktokEndCardScenarioNote} : {}),
      ...(deliversToAdNetwork(group) === false ? {placement_note: tiktokEndCardPlacementNote} : {}),
    },
  };
}
