import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {evidenceDate} from './evidence-dates.js';

/** The REST.li dateRange of a guided analytics read over the evidence's declared days. */
function linkedinSourceRange(sem: JsonObject) {
  const date = (value: string) => {
    evidenceDate(value);
    const [year, month, day] = value.split('-').map(Number);
    return '(year:' + year + ',month:' + month + ',day:' + day + ')';
  };
  return '(start:' + date(sem.date_from) + ',end:' + date(sem.date_to) + ')';
}

/**
 * DEC-01: an allocation models LinkedIn campaign evidence only as it was captured: its original URNs, the UTC daily
 * analytics mapping and the verified account currency (LinkedIn's guided reporting declares it;
 * src/report-allocation.ts asks it). Its refusal is authored allocation copy (tools/check-locales.mjs).
 */
export function linkedinAllocationEvidence(report: JsonObject) {
  if (
    report.source_collection !== 'linkedin_analytics' ||
    report.source_request?.action !== 'linkedin_rest_ad_analytics_get' ||
    report.source_request.account_id !== report.account_id ||
    report.source_request.connection_id !== report.connection_id ||
    report.source_request.query?.pivot !== 'CAMPAIGN' ||
    report.source_request.query?.q !== 'analytics' ||
    report.source_request.query?.timeGranularity !== 'DAILY' ||
    report.source_request.query?.accounts !== 'List(urn:li:sponsoredAccount:' + report.account_id + ')' ||
    report.semantics?.timezone !== 'UTC' ||
    report.semantics?.conversion_definition !== 'externalWebsiteConversions' ||
    report.source_request.query?.dateRange !== linkedinSourceRange(report.semantics) ||
    report.mapping?.entity_id !== '/pivotValues/0' ||
    report.mapping?.date?.path !== '/dateRange/start' ||
    report.mapping?.date?.format !== 'linkedin_utc_date' ||
    report.mapping?.spend !== '/costInLocalCurrency' ||
    report.mapping?.conversions !== '/externalWebsiteConversions' ||
    report.native_account_evidence?.account_id !== report.account_id ||
    report.native_account_evidence?.currency !== report.semantics?.currency ||
    !Array.isArray(report.native_account_evidence?.checks) ||
    report.native_account_evidence.checks.length !== 2 ||
    report.native_account_evidence.checks.some(
      (check: JsonObject) =>
        check.source_request?.action !== 'linkedin_rest_ad_accounts_ad_account_id_get' ||
        check.source_request.account_id !== report.account_id ||
        check.source_request.connection_id !== report.connection_id ||
        check.source_request.path_params?.ad_account_id !== report.account_id ||
        typeof check.source_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(check.source_hash),
    ) ||
    report.native_account_evidence.checks[0].source_hash !== report.native_account_evidence.checks[1].source_hash
  )
    bad(
      'Retain the original LinkedIn campaign URNs, UTC daily analytics mapping and verified account currency evidence.',
      'SCENARIO_EVIDENCE_REQUIRED',
    );
}
