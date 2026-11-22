import {MirrorError} from './errors.js';
import {tiktokPixelListPath} from './tiktok-custom-conversions.js';
import type {JsonObject} from './types.js';

/**
 * The tracking pixel of an Upgraded Smart+ ad, `ad_configuration.tracking_info.tracking_pixel_id` (T5, r25-m4-smartedits). API for
 * Business v1.3 "Create an Upgraded Smart+ Ad" and "Update an Upgraded Smart+ Ad" (https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-ad/v1.3
 * and .../update-an-upgraded-smart-ad/v1.3, read by the lead on 2026-11-20, impl/r25-m4-DOCS-EVIDENCE.md section 3) say that it is
 * "Valid only in any of the following scenarios": the objective is APP_PROMOTION (APP_INSTALL or APP_RETARGETING), or it is
 * LEAD_GENERATION and the ad group's promotion_target_type is not EXTERNAL_WEBSITE (the Instant Form); and that an ad group's own
 * pixel_id, when it has one, "must match it". No scenario names WEB_CONVERSIONS, Sales or TRAFFIC: a website ad's pixel is its ad
 * group's (`pixel_id`, with the CONVERT goal; src/tiktok-smart-plus-adgroups.ts). AMCP has no app promotion contract, and its lead
 * ad groups are INSTANT_PAGE ones, so the Instant Form case is the documented one it qualifies. TikTok reads an ad with no pixel as
 * "0" (the reads of 2026-11-21), which is therefore accepted as "none".
 *
 * The pixel is read from the advertiser's pixel list (it must be returned and not unbound; a shared pixel is reported), and it must
 * match the ad group's pixel when the ad group has one. A review reads the ad group for this: a create already does, and an edit
 * reads the ad's ad group once the edit names a pixel.
 */
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
/** The field every refusal of an ad's pixel names. */
export const tiktokAdPixelField = 'ad_configuration.tracking_info.tracking_pixel_id';

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_AD', message, {field});
}

/** The pixel an `ad_configuration` names: a numeric ID. "0" (none, as TikTok reads it) and no pixel at all are undefined. */
export function tiktokAdPixel(configuration: unknown): string | undefined {
  if (!obj(configuration) || !obj(configuration.tracking_info)) return undefined;
  const id = configuration.tracking_info.tracking_pixel_id;
  return numeric(id) ? id : undefined;
}
/**
 * The pixel an ad holds, as TikTok read it: any value but none ("0", no value, an empty value), however it is written, so that an
 * ad whose pixel is in a form this contract does not know is never read as having none (a restated configuration could clear it).
 */
export function tiktokHeldPixel(configuration: unknown): string | undefined {
  if (!obj(configuration) || !obj(configuration.tracking_info)) return undefined;
  const id = configuration.tracking_info.tracking_pixel_id;
  return id === undefined || id === null || id === '' || id === 0 || id === '0' ? undefined : String(id);
}
/** What a message may repeat of an ID TikTok returned: digits only, and otherwise the words `otherwise`. */
export const tiktokQuotedId = (v: unknown, otherwise: string) =>
  ['string', 'number'].includes(typeof v) && /^[0-9]{1,32}$/.test(String(v)) ? String(v) : otherwise;
/** The advertiser's pixel list read of one pixel, as a review reads it (the Smart+ ad group does the same). */
export const tiktokAdPixelRead = (accountId: string | undefined, pixel: string) => ({
  path: tiktokPixelListPath,
  query: {advertiser_id: accountId, pixel_id: pixel},
  action: 'tiktok_pixel_list_get',
});
const pixelRow = (state: unknown[], pixel: string) =>
  state
    .flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.pixels) ? s.data.pixels : []))
    .find((p: JsonObject) => String(p?.pixel_id) === pixel) as JsonObject | undefined;

/** How an ad group admits an ad-level pixel: the Instant Form lead group AMCP creates, a website group (its pixel is the group's), or neither. */
export type TiktokPixelGroupKind = 'instant_form' | 'website' | 'other';
export function tiktokPixelGroupKind(group: JsonObject): TiktokPixelGroupKind {
  if (group.promotion_type === 'LEAD_GENERATION' && group.promotion_target_type === 'INSTANT_PAGE')
    return 'instant_form';
  return group.promotion_type === 'WEBSITE' ? 'website' : 'other';
}
/** A website ad takes no pixel of its own at creation (its pixel is the ad group's), and no other ad group has a documented scenario. */
export function tiktokRefuseCreatedPixel(kind: TiktokPixelGroupKind): void {
  if (kind === 'website')
    invalid(
      tiktokAdPixelField,
      'A website ad takes no tracking pixel of its own: its pixel is the ad group’s (pixel_id on a CONVERT ad group), and TikTok documents no ad-level pixel for a website ad.',
    );
  if (kind === 'other') tiktokRefuseUndocumentedGroup();
}
/**
 * What an edit that names a pixel is refused with, by the kind of ad group the ad is in (r25-field3-livefix, item 4). TikTok applies an ad-level
 * pixel only to Instant Form lead ads and app promotion ads. The live check LV-20 (b) of 2026-11-21 sent `ad_configuration.tracking_info.
 * tracking_pixel_id` for a website Smart+ ad: TikTok answered code 0 and kept "0", and only the read-back caught it. Until then an edit of a website
 * ad's pixel was sent as a probe (`websitePixelProbe`); it is now refused before any request, as the create of a website ad with a pixel has been.
 * An Instant Form ad's pixel is the documented scenario and is not refused here.
 */
export function tiktokRefuseEditedPixel(kind: TiktokPixelGroupKind): void {
  if (kind === 'website')
    invalid(
      tiktokAdPixelField,
      'TikTok applies an ad-level pixel only to Instant Form lead ads and app promotion ads: on a website ad it accepts tracking_pixel_id and keeps "0" (checked live on 2026-11-21). A website ad’s pixel is its ad group’s: set pixel_id on a CONVERT ad group. Nothing was sent.',
    );
  if (kind === 'other') tiktokRefuseUndocumentedGroup();
}
export function tiktokRefuseUndocumentedGroup(): never {
  return invalid(
    tiktokAdPixelField,
    'TikTok documents tracking_pixel_id only for app promotion ads and for Instant Form lead generation ads; this ad’s ad group is neither, so an ad-level pixel is not qualified for it.',
  );
}
/**
 * What the ad group and the pixel list say of an ad's pixel, checked at review and again before execution: the ad group's own pixel,
 * when it has one other than "0", is the ad's ("must match it"); the pixel is returned for the advertiser and is not unbound.
 */
export function tiktokAdPixelPrerequisites(pixel: string, group: JsonObject, groupId: string, state: unknown[]): void {
  const own = group.pixel_id;
  if (own !== undefined && own !== null && String(own) !== '' && String(own) !== '0' && String(own) !== pixel)
    invalid(
      tiktokAdPixelField,
      'Ad group ' +
        groupId +
        ' uses ' +
        (tiktokQuotedId(own, '') ? 'pixel ' + tiktokQuotedId(own, '') : 'another pixel') +
        '; the ad’s pixel must match it (tracking_pixel_id ' +
        pixel +
        ').',
    );
  tiktokAdPixelListCheck(pixel, state);
}
/**
 * The check of the advertiser's pixel list alone: the pixel is returned for the advertiser and is not unbound. A pixel a website ad already holds and an edit restates
 * unchanged (`tiktokRestatesHeldPixel`) is judged by this only: the ad group's pixel is not its (r25-field3-livefix, item 4, the lead's review S3-2).
 */
export function tiktokAdPixelListCheck(pixel: string, state: unknown[]): void {
  const row = pixelRow(state, pixel);
  if (!row)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Pixel ' + pixel + ' was not returned for the selected advertiser.',
      {
        pixel_id: pixel,
      },
    );
  if (obj(row.asset_ownership) && row.asset_ownership.asset_relation_status === 'UNBOUND')
    invalid(tiktokAdPixelField, 'Pixel ' + pixel + ' has been unbound from this advertiser.');
}
/**
 * Whether an edit of a website ad (an ad group of kind `website`, with no catalog) names, in its configuration, the very pixel the ad already holds (a pixel attached in
 * TikTok's UI): a restatement, which keeps the ad's configuration editable, not an edit of its pixel (r25-field3-livefix, item 4, the lead's review S3-2 and decision). The
 * live check LV-20 (b) is about sending a pixel to a website ad, which TikTok accepts and keeps as "0"; it says nothing against keeping the one the ad has. The read-back
 * must still show it: a read-back of "0" is a mismatch, as for any edit of the configuration.
 */
export function tiktokRestatesHeldPixel(
  named: string | undefined,
  held: string | undefined,
  group: JsonObject,
): boolean {
  return (
    named !== undefined &&
    named === held &&
    tiktokPixelGroupKind(group) === 'website' &&
    !(group.catalog_id !== undefined && group.catalog_id !== null && !['', '0'].includes(String(group.catalog_id)))
  );
}
/** What a review says of a pixel an edit restates unchanged (`tracking_pixel.meaning`), and that the read-back must still show it. */
export const tiktokRestatedPixelMeaning =
  'The ad already holds this pixel, and the edit restates it unchanged. TikTok keeps "0" on a website ad when a pixel is sent to it, so the read-back must still show this pixel: a read-back that shows "0" is never reported as a success.';
/** The pixel as a review shows it: its ID and name, and whether the advertiser owns it (a shared pixel is reported, as for an ad group). */
export function tiktokAdPixelImpact(pixel: string, state: unknown[]): JsonObject {
  const row = pixelRow(state, pixel);
  return {
    pixel_id: pixel,
    name: row?.pixel_name ?? null,
    owned: obj(row?.asset_ownership) ? row.asset_ownership.ownership_status === true : null,
  };
}
