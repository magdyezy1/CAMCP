import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {snapchatReportId} from './snapchat-evidence.js';

/**
 * DEC-01: an allocation models parent-bound Snapchat ad-squad evidence only with the exact campaign ownership it was
 * read under (Snapchat's guided reporting declares it; src/report-allocation.ts asks it). Its refusal is authored
 * allocation copy (tools/check-locales.mjs).
 */
export function snapchatAllocationEvidence(report: JsonObject) {
  if (
    !snapchatReportId(report.source_request?.path_params?.campaign_id) ||
    report.source_request?.action !== 'snapchat_campaign_stats_get' ||
    report.source_request?.query?.breakdown !== 'adsquad' ||
    report.native_account_evidence?.parent_campaign?.id !== report.source_request.path_params.campaign_id ||
    report.native_account_evidence.parent_campaign.account_id !== report.account_id
  )
    bad('Retain exact Snapchat campaign ownership and ad-squad source evidence.', 'SCENARIO_EVIDENCE_REQUIRED');
}
