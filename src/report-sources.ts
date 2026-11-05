import type {ReportSource} from './report-source.js';
import {googleReportSource, searchConsoleReportSource} from './google-report-source.js';
import {metaReportSource} from './meta-report-source.js';
import {tiktokReportSource} from './tiktok-report-source.js';
import {snapchatReportSource} from './snapchat-report-source.js';
import {linkedinReportSource} from './linkedin-report-source.js';
import {xReportSource} from './x-report-source.js';
import {microsoftReportSource} from './microsoft-report-source.js';
import {appleReportSource} from './apple-report-source.js';
import {redditReportSource} from './reddit-report-source.js';
import {ga4ReportSource} from './ga4-report-source.js';
import {registerNativeDetailLevels} from './overview-levels.js';

/**
 * The report sources (ARC-04 stage F): one per reporting platform, in the order of reportPlatforms
 * (src/report-metrics.ts). A registry of provider facts, like the provider adapter registry: shared reporting code
 * consults it and names no platform's row shape itself (tools/architecture-map.mjs counts it with the provider modules).
 */
export const reportSourceList: readonly ReportSource[] = Object.freeze([
  googleReportSource,
  metaReportSource,
  tiktokReportSource,
  snapchatReportSource,
  linkedinReportSource,
  xReportSource,
  microsoftReportSource,
  appleReportSource,
  redditReportSource,
  ga4ReportSource,
  searchConsoleReportSource,
]);
// Native detail levels are source-owned facts; this registry is the allowed provider/shared composition boundary.
for (const source of reportSourceList)
  if (source.nativeDetail && source.overview) registerNativeDetailLevels(source.platform, source.overview.levels);
const byPlatform = new Map(reportSourceList.map(source => [source.platform, source]));

/**
 * The report sources with guided reporting (ARC-04 stage F), in the order amcp_reporting capture_presets lists their
 * presets (src/report-presets.ts).
 */
export const guidedReportSources: readonly ReportSource[] = Object.freeze([
  googleReportSource,
  snapchatReportSource,
  tiktokReportSource,
  linkedinReportSource,
  metaReportSource,
]);

/** The report source of a platform ID, or undefined for a platform without one. */
export function reportSource(platform: string): ReportSource | undefined {
  return byPlatform.get(platform);
}

// Warnings of the platforms' own collection (ARC-04 stage F), which src/report-native.ts re-exports from here.
export {tiktokEventsUnavailableWarning} from './tiktok-report-source.js';
export {linkedinCampaignsUnavailableWarning} from './linkedin-report-source.js';
export {redditValueUnitWarning} from './reddit-report-source.js';
// The guided reporting facts amcp_reporting's tool definition and actions read from here (ARC-01 reporting): the Meta
// attribution windows its capture_preset schema lists, and Google's read-only serving diagnostics.
export {metaAttributionWindows} from './meta-attribution-windows.js';
export {googleServingDiagnostics} from './google-serving-diagnostics.js';
// The platforms' guided reporting facts (ARC-04 stage F), which src/report-breakdowns.ts re-exports from here.
export {googleReportAdNetworks} from './google-reporting.js';
export {
  metaAgeBuckets,
  metaGenders,
  metaPublisherPlatforms,
  metaBreakdownPresets,
  metaBreakdownKey,
} from './meta-guided-reports.js';
