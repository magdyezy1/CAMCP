import type {ReviewVolatile} from './review-state-core.js';
import {flatResourceTelemetry} from './review-flat-telemetry.js';

/**
 * What changes by itself in the answers of Google's two review gateways (R2.5 M1, L5-02). A leaf, so each gateway's adapter
 * and the family modules that compare their own states share one table.
 *
 * Google Ads: its answers are query results whose rows hold the fields the query selected (src/google-ads-adapter.ts
 * keeps `results` and nothing of the envelope), so only the standard update time of a Google API resource (`update_time`,
 * AIP-148) applies.
 *
 * Business Profile: its resources are flat, so the flat-resource names apply.
 */
export const googleAdsReviewVolatile: ReviewVolatile = Object.freeze(['update_time']);
export const googleBusinessReviewVolatile: ReviewVolatile = flatResourceTelemetry;
