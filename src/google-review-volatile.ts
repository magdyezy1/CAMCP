import type {ReviewVolatile} from './review-state-core.js';
import {flatResourceTelemetry} from './review-flat-telemetry.js';

/**
 * What changes by itself in the answers of Google's two review gateways (R2.5 M1, L5-02). A leaf, so each gateway's adapter
 * and the family modules that compare their own states share one table.
 *
 * Google Ads: its answers are query results whose rows hold the fields the query selected (src/google-ads-adapter.ts
 * keeps `results` and nothing of the envelope), so the standard update time of a Google API resource (`update_time`,
 * AIP-148) applies, and the two fields Google fills on every text asset of an ad (r25-field-gverify, 2026-11-19):
 *   - `policy_summary_info`: Google's policy review of the asset (review status, approval status, policy findings);
 *   - `asset_performance_label`: Google's performance label of the asset.
 * Both belong to the v25 `AdTextAsset` message, the element of every list of text assets of an ad: the headlines and
 * descriptions of a responsive search ad, and the text lists of the responsive display, Demand Gen, video, app, local and
 * Smart campaign ads. Sources: the pinned schemas `GoogleAdsGoogleadsV25Common__AdTextAsset` and
 * `GoogleAdsGoogleadsV25Common__AdAssetPolicySummary` (.mirror/VENDOR/google-ads-v25.json) and the `AdTextAsset` page of
 * the Google Ads API v25 reference on developers.google.com. A request sends an asset's text and pin (`text`,
 * `pinned_field`); Google answers every asset with these two as well and moves them on by itself while it reviews and
 * ranks the asset. A list read back exactly as it was sent therefore still differs from what was sent, and an edit
 * prepared before a review completes finds another state at execute.
 *
 * Only these names are left out, at any depth, in the read-back of a write and in the state hash of a review alike. The
 * text, the pin, the order and the length of a list, and every field this table does not name, stay compared: a field a
 * table does not name is never excused. The pinned `Asset` resource holds `policy_summary_info` too, in
 * `field_type_policy_summaries` (read only), where it is the same policy review. Should Google make either name something
 * a request chooses, revisit this entry; tests/review-volatile-tables.test.mjs states why each name is here.
 *
 * Business Profile: its resources are flat, so the flat-resource names apply.
 */
export const googleAdsReviewVolatile: ReviewVolatile = Object.freeze([
  'update_time',
  'policy_summary_info',
  'asset_performance_label',
]);
export const googleBusinessReviewVolatile: ReviewVolatile = flatResourceTelemetry;
