import {MirrorError} from './errors.js';
import {ga4Quality, summarizeGA4Quality} from './report-quality.js';
import {overviewCapabilities, invalidReportSource, reportList, type ReportSource} from './report-source.js';
import type {CompiledRequest, JsonObject} from './types.js';

/** GA4 runReport rows by session campaign; conversions are key events. */
export const ga4ReportSource: ReportSource = {
  platform: 'ga4',
  overview: overviewCapabilities([{id: 'campaign', label: 'Campaign / resource', native_type: 'campaign_or_resource'}]),
  objectives: {
    name: 'GA4',
    values: {},
    missingReason: 'GA4 has no campaign objective.',
  },
  nativeMetricExamples: [
    'engagedSessions',
    'engagementRate',
    'bounceRate',
    'screenPageViews',
    'averageSessionDuration',
    'eventCount',
    'ecommercePurchases',
    'purchaseRevenue',
  ],
  // The collection reads the property itself (its currency and time zone).
  accountLookup: false,
  // GA4 marks access-restricted metrics null; the null is kept as the native metric.
  nullNativeMetrics: true,
  // The property, the metric report and the name report.
  minimumRequestsPerPeriod: 3,
  // RPT-02: a rolling window in the account zone reads the property's own time zone.
  timezoneRead: {
    plan: (gateway, account): CompiledRequest => ({
      gateway,
      accountId: account,
      action: 'AMCP_CAMPAIGN_REPORT',
      method: 'GET',
      path: '/v1beta/properties/' + account,
      query: {},
      origin: 'https://analyticsadmin.googleapis.com',
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'Reporting time zone for a rolling window, bounded property scope',
      warnings: [],
    }),
    zone: data => data.timeZone ?? null,
  },
  /**
   * The property (its currency and time zone), then two bounded runReport collections: metrics by session campaign ID
   * (aggregated by GA4 itself) and sessions by campaign ID and name for the labels, with GA4's quality metadata.
   */
  async collect(c) {
    const qualityPages: JsonObject[] = [];
    c.metadata = await c.run(
      c.plan('/v1beta/properties/' + c.account, {}, undefined, 'https://analyticsadmin.googleapis.com'),
      false,
    );
    c.currency = c.metadata.currencyCode ?? null;
    c.timezone = c.metadata.timeZone ?? null;
    const metrics = [...new Set(['sessions', 'totalUsers', 'keyEvents', 'totalRevenue', ...c.extra])];
    if (metrics.length > 10)
      invalidReportSource(
        'GA4 allows at most 10 metrics per request. Create separate saved reports for incompatible or additional metrics.',
      );
    const page = async (dimensions: string[], names: string[]) => {
      const out: {dims: string[]; metrics: JsonObject}[] = [];
      for (let offset = 0; offset < 10000; offset += 1000) {
        const d = await c.run(
          c.plan(
            '/v1beta/properties/' + c.account + ':runReport',
            {},
            {
              dateRanges: [{startDate: c.range.since, endDate: c.range.until}],
              dimensions: dimensions.map(name => ({name})),
              metrics: names.map(name => ({name})),
              offset: String(offset),
              limit: '1000',
              keepEmptyRows: true,
              returnPropertyQuota: true,
            },
          ),
          false,
        );
        qualityPages.push(ga4Quality(d.metadata ?? {}, dimensions, offset));
        const restricted = new Set(
          (d.metadata?.schemaRestrictionResponse?.activeMetricRestrictions ?? []).map((v: JsonObject) => v.metricName),
        );
        const rows = reportList(d.rows ?? []);
        out.push(
          ...rows.map(r => ({
            dims: reportList(r.dimensionValues ?? []).map(v => String(v.value ?? '')),
            metrics: Object.fromEntries(
              reportList(d.metricHeaders ?? []).map((h: JsonObject, i: number) => [
                String(h.name),
                restricted.has(h.name) ? null : (r.metricValues as JsonObject[] | undefined)?.[i]?.value,
              ]),
            ),
          })),
        );
        if (d.metadata?.dataLossFromOtherRow || d.metadata?.subjectToThresholding) c.complete = false;
        if (offset + rows.length >= Number(d.rowCount ?? rows.length)) break;
        if (!rows.length || offset === 9000)
          throw new MirrorError('INCOMPLETE_REPORT', 'GA4 report exceeded the row limit.');
      }
      return out;
    };
    // Metrics come from an ID-only report so GA4 aggregates them itself. One campaign ID can carry
    // several campaign names -- a rename mid-flight, or inconsistent utm_campaign casing -- and
    // summing those rows here would double count users and corrupt ratio metrics such as
    // engagementRate and bounceRate. The name is resolved from a separate sessions-only report.
    const totals = await page(['sessionCampaignId'], metrics),
      labels = await page(['sessionCampaignId', 'sessionCampaignName'], ['sessions']);
    const best = new Map<string, {name: string; sessions: number}>(),
      variants = new Map<string, Set<string>>();
    for (const row of labels) {
      const id = row.dims[0] ?? '',
        name = row.dims[1] ?? '',
        sessions = Number(row.metrics.sessions ?? 0);
      if (!variants.has(id)) variants.set(id, new Set());
      variants.get(id)!.add(name);
      const top = best.get(id);
      if (!top || sessions > top.sessions) best.set(id, {name, sessions});
    }
    // sessionCampaignId can come from manual tagging or linked advertising integrations. (other)
    // is GA4's cardinality overflow bucket. Neither is one campaign, so neither inherits a name.
    const unattributed = (id: string) => !id || id === '(not set)' || id === '(other)';
    const drifted = [...variants].filter(([id, names]) => !unattributed(id) && names.size > 1).map(([id]) => id);
    c.raw = totals.map(row => {
      const id = row.dims[0] ?? '';
      return {
        campaign_id: unattributed(id) ? id || '(not set)' : id,
        campaign_name: unattributed(id) ? id || '(not set)' : (best.get(id)?.name ?? id),
        ...row.metrics,
      };
    });
    if (totals.some(row => unattributed(row.dims[0] ?? ''))) {
      // Owner policy P6: sessions without a campaign ID limit attribution scope; they do not make GA4 incomplete.
      // Sampling, thresholding, (other)-row data loss, restrictions and truncation still do (summarizeGA4Quality).
      c.scopeLimitations.push('ga4_unattributed_sessions');
      c.warnings.push(
        'GA4 returned unassigned or aggregated session campaign IDs. Check linked advertising integrations, tagging and attribution; missing utm_id is only one possible cause.',
      );
    }
    if (drifted.length)
      c.warnings.push(
        drifted.length +
          ' GA4 campaign ID' +
          (drifted.length === 1 ? '' : 's') +
          ' appeared under more than one campaign name in this range (' +
          drifted.slice(0, 5).join(', ') +
          '). The name with the most sessions is shown; metrics were aggregated by ID at the provider.',
      );
    const quality = (c.quality = summarizeGA4Quality(qualityPages));
    if (!quality.measurement_complete) c.complete = false;
    for (const row of c.raw) for (const metric of quality.restricted_metrics) row[metric] = null;
    if (quality.sampled) c.warnings.push('GA4 sampled this report; sampling counts are retained in source quality.');
    if (quality.restricted_metrics.length)
      c.warnings.push(
        'GA4 access restrictions make these metrics unavailable: ' + quality.restricted_metrics.join(', '),
      );
    if (quality.thresholded || quality.data_loss)
      c.warnings.push('GA4 thresholding or high-cardinality aggregation limits this report.');
    if (quality.empty_reasons.length)
      c.warnings.push('GA4 empty response reasons: ' + quality.empty_reasons.join('; '));
    if (quality.truncated)
      c.warnings.push(
        'GA4 left data out of this report (' +
          quality.truncation_types.join(', ') +
          "); the truncated dates and GA4's explanation are in source quality.",
      );
    c.resultDefinition =
      'GA4 key events attributed to session campaign ID from manual tagging or linked advertising integrations';
  },
  normalize(raw, {field: n}) {
    return {
      id: raw.campaign_id,
      name: raw.campaign_name,
      metrics: {
        sessions: n('sessions'),
        users: n('totalUsers'),
        conversions: n('keyEvents'),
        conversion_value: n('totalRevenue'),
        purchases: n('ecommercePurchases'),
      },
    };
  },
};
