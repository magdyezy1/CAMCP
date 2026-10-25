import {googleReportAdNetworks} from './google-reporting.js';
import type {GuidedReporting} from './report-source.js';

/**
 * Google Ads' guided reporting (ARC-04 stage F): what the shared guided modules (src/report-breakdowns.ts and the
 * modules above it) ask Google instead of naming it. Google's report source declares it.
 */
export const googleGuidedReporting: GuidedReporting = {
  // RPT-07 P1: campaign × native ad network (segments.ad_network_type), kept as the literal documented AdNetworkType.
  dimensions: {native_ad_network: v => typeof v === 'string' && googleReportAdNetworks.includes(v)},
};
