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
const byPlatform = new Map(reportSourceList.map(source => [source.platform, source]));

/** The report source of a platform ID, or undefined for a platform without one. */
export function reportSource(platform: string): ReportSource | undefined {
  return byPlatform.get(platform);
}

// Warnings of the platforms' own collection (ARC-04 stage F), which src/report-native.ts re-exports from here.
export {tiktokEventsUnavailableWarning} from './tiktok-report-source.js';
export {linkedinCampaignsUnavailableWarning} from './linkedin-report-source.js';
export {redditValueUnitWarning} from './reddit-report-source.js';
