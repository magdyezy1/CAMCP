import {MirrorError} from './errors.js';
import {mappedReportResult} from './report-results.js';
import {compileMicrosoft, microsoftGateway} from './microsoft-native.js';
import {
  assertMicrosoftWindowClosed,
  microsoftCompleteData,
  microsoftFallbackReportTimeZone,
  microsoftFallbackWarning,
  microsoftReportZone,
} from './microsoft-timezones.js';
import {microsoftDetail} from './overview-native-detail.js';
import {assertWritesNotPaused} from './owner-operations.js';
import {
  admitProviderJob,
  beginProviderJob,
  failedJobState,
  providerJobReceipt,
  settleProviderJob,
} from './provider-jobs.js';
import {reportList, type ReportSource} from './report-source.js';
import {accountTimezone} from './account-metadata.js';
import type {JsonObject} from './types.js';

/** Microsoft Advertising campaign performance report rows (decimal money in the account currency). */
export const microsoftReportSource: ReportSource = {
  platform: 'microsoft',
  resultRules: {
    selectors: [],
    default: {
      id: 'microsoft:conversions',
      metric: 'conversions',
      label: 'Primary conversions',
      native_metric: 'Conversions',
      aggregation: 'sum',
      unit: 'number',
    },
  },
  readResult(raw) {
    return mappedReportResult(microsoftReportSource.resultRules!, {}, raw, {spend: raw.Spend});
  },
  objectives: {
    name: 'Microsoft Advertising',
    values: {},
    missingReason: 'Microsoft Advertising reports have no objective field; choose one in the report.',
  },
  nativeMetricExamples: [
    'AllConversions',
    'AllRevenue',
    'Assists',
    'ViewThroughConversions',
    'QualityScore',
    'PhoneCalls',
    'ImpressionSharePercent',
  ],
  // RPT-07: its own report job collects the ad group and ad levels.
  nativeDetail: true,
  // The submission and the first poll.
  minimumRequestsPerPeriod: 2,
  // RPT-04 (owner policy P6): report days follow the account time zone, as Microsoft's report zone names it.
  timezoneRead: {zone: (data, gateway) => microsoftReportZone(accountTimezone(gateway, data)).timezone},
  /**
   * One Summary performance report job (campaign, or RPT-07 ad group and ad) in the account time zone: submitted once
   * as the reporting pipeline's provider job (RPT-06), then polled and downloaded in bounded pages.
   */
  async collect(c) {
    const {checkpoint, save, store} = c;
    // RPT-04 (owner policy P6): report days follow the account time zone. A checkpoint from an earlier London-zone
    // run keeps its own zone, so a resumed report is never re-labelled.
    const zone =
      checkpoint.report_id && checkpoint.report_time_zone === undefined
        ? microsoftReportZone(microsoftFallbackReportTimeZone)
        : microsoftReportZone(checkpoint.report_time_zone ?? c.timezone);
    c.timezone = zone.timezone;
    const date = (s: string) => {
      const [Year, Month, Day] = s.split('-').map(Number);
      return {Year, Month, Day};
    };
    let reportId = checkpoint.report_id;
    if (!reportId) {
      assertMicrosoftWindowClosed(c.range, zone.timezone);
      // RPT-06: the report submission is the reporting pipeline's provider job. It is admitted against the hourly
      // bound and recorded with a receipt in the checkpoint before it is sent; a resume whose earlier submission may
      // have reached Microsoft never submits again (only a definitive refusal, which created nothing, may).
      const tenant = c.actor.tenantId,
        earlier = checkpoint.provider_job_receipt;
      if (earlier !== undefined && providerJobReceipt(store, tenant, earlier)?.state !== 'rejected')
        throw new MirrorError(
          'PROVIDER_JOB_UNCERTAIN',
          'Microsoft may have received this report request, but its answer was lost. AMCP never submits a report job again automatically; run a new snapshot.',
          {receipt_id: earlier, submission_started: true, resubmission: 'never_automatic'},
          409,
        );
      assertWritesNotPaused(store, tenant, 'provider_jobs');
      admitProviderJob(store, microsoftGateway, c.account);
      const receipt = beginProviderJob(store, tenant, {
        gateway: microsoftGateway,
        account_id: c.account,
        connection_id: c.connection,
        actor: c.actor.userId,
        source: 'reporting_pipeline',
      });
      save({provider_job_receipt: receipt});
      let d: JsonObject;
      try {
        d = await microsoftCompleteData(() =>
          c.run(
            compileMicrosoft({
              action: 'SubmitGenerateReport',
              account_id: c.account,
              payload: {
                ReportRequest: {
                  // RPT-07: ad group and ad levels use the native performance reports that name their parents.
                  Type:
                    c.detail === 'adset'
                      ? 'AdGroupPerformanceReportRequest'
                      : c.detail === 'ad'
                        ? 'AdPerformanceReportRequest'
                        : 'CampaignPerformanceReportRequest',
                  Aggregation: 'Summary',
                  Format: 'Csv',
                  ReportName:
                    c.detail === 'adset'
                      ? 'AMCP ad group overview'
                      : c.detail === 'ad'
                        ? 'AMCP ad overview'
                        : 'AMCP campaign overview',
                  ReturnOnlyCompleteData: true,
                  Columns: [
                    ...new Set([
                      'AccountId',
                      'CampaignId',
                      'CampaignName',
                      ...(c.detail ? ['AdGroupId', 'AdGroupName'] : []),
                      ...(c.detail === 'ad' ? ['AdId', 'AdTitle'] : []),
                      'CurrencyCode',
                      'Spend',
                      'Impressions',
                      'Clicks',
                      'Conversions',
                      'Revenue',
                      ...c.extra,
                    ]),
                  ],
                  Scope: {AccountIds: [c.account]},
                  Time: {
                    CustomDateRangeStart: date(c.range.since),
                    CustomDateRangeEnd: date(c.range.until),
                    ReportTimeZone: zone.report_time_zone,
                  },
                },
              },
            }),
            false,
          ),
        );
      } catch (e) {
        // Microsoft's "complete data not yet available" (2004) is a refusal that created no report job.
        const refused = e instanceof MirrorError && e.code === 'REPORT_PENDING' && e.details.provider_code === '2004';
        settleProviderJob(store, tenant, receipt, refused ? 'rejected' : failedJobState(e), {
          code: e instanceof MirrorError ? e.code : 'INTERNAL_ERROR',
        });
        throw e;
      }
      reportId = d.ReportRequestId;
      settleProviderJob(store, tenant, receipt, reportId ? 'accepted' : 'uncertain', {
        job_id: reportId ? String(reportId) : null,
      });
      save({report_id: reportId, report_time_zone: zone.report_time_zone, provider_job_receipt: receipt});
    }
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const d = await microsoftCompleteData(() =>
        c.run(
          compileMicrosoft({
            action: 'PollGenerateReport',
            account_id: c.account,
            payload: {ReportRequestId: reportId},
            download_report: true,
            offset,
            limit: 100,
          }),
          false,
        ),
      );
      if (d.ReportRequestStatus?.Status === 'Pending' || d.status === 'Pending')
        throw new MirrorError(
          'REPORT_PENDING',
          'Microsoft is preparing the report.',
          {retry_after_ms: 30000, report_id: reportId},
          503,
          true,
        );
      if (!d.download_complete)
        throw new MirrorError('REPORT_DOWNLOAD_FAILED', 'Microsoft report is not complete.', {}, 502);
      c.raw.push(...reportList(d.rows));
      if (d.potentially_incomplete !== false) c.complete = false;
      if (!d.has_more) break;
      offset += d.rows.length;
      if (!d.rows.length || page === 99)
        throw new MirrorError('INCOMPLETE_REPORT', 'Microsoft report exceeded the row limit.');
    }
    c.resultDefinition = 'Microsoft conversions included in the Conversions column';
    c.context.report_time_zone = zone.report_time_zone;
    if (zone.fallback) c.warnings.push(microsoftFallbackWarning);
    if (c.detail) c.detailRows = microsoftDetail(c.detail, c.account, c.currency, c.raw, c.detailRounding);
  },
  normalize(raw, {field: n}) {
    return {
      id: raw.CampaignId,
      name: raw.CampaignName,
      currency: raw.CurrencyCode,
      metrics: {
        spend: n('Spend'),
        impressions: n('Impressions'),
        clicks: n('Clicks'),
        conversions: n('Conversions'),
        conversion_value: n('Revenue'),
      },
    };
  },
};
