import {MirrorError} from './errors.js';
import {linkedinGuidedReporting} from './linkedin-guided-reports.js';
import {linkedInCampaignMetadata, linkedInCampaignPeriod} from './linkedin-reporting.js';
import {linkedinVersion} from './linkedin-version.js';
import {linkedinDetailParents} from './linkedin-detail-parents.js';
import {invalidReportSource, optionalReadRefused, type ReportSource} from './report-source.js';

/** Shown when LinkedIn refused the campaign metadata read, so rows keep campaign IDs and unknown objectives. */
export const linkedinCampaignsUnavailableWarning =
  'LinkedIn campaign names and objectives could not be read, so rows show campaign IDs and objectives stay unknown unless confirmed in report settings.';

/** LinkedIn analytics report days in UTC. */
const reportZone = 'UTC';

/** LinkedIn adAnalytics rows pivoted by campaign (its URN in pivotValues); money in the account currency. */
export const linkedinReportSource: ReportSource = {
  platform: 'linkedin',
  nativeMetricExamples: [
    'videoViews',
    'videoCompletions',
    'likes',
    'comments',
    'shares',
    'externalWebsiteConversions',
    'externalWebsitePostClickConversions',
    'externalWebsitePostViewConversions',
    'conversionValueInLocalCurrency',
    'oneClickLeads',
  ],
  minimumRequestsPerPeriod: 1,
  fixedTimezone: reportZone,
  guided: linkedinGuidedReporting,
  requestHeaders: () => ({'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'}),
  // LinkedIn versions its API by header, not by path, so lineage names that header's value.
  versionHeader: 'LinkedIn-Version',
  /**
   * One complete campaign analytics response over the UTC period, after the account identity and currency checks,
   * then the reported campaigns' current names and objectives (RPT-07), read once per campaign and job.
   */
  async collect(c) {
    c.timezone = reportZone;
    if (String(c.metadata.id ?? '') !== c.account)
      throw new MirrorError('REPORT_ACCOUNT_MISMATCH', 'LinkedIn returned a different or missing account ID.');
    if (typeof c.currency !== 'string' || !/^[A-Z]{3}$/.test(c.currency))
      throw new MirrorError('REPORT_CURRENCY_MISMATCH', 'LinkedIn did not return a valid native account currency.');
    const date = (s: string) => {
      const [year, month, day] = s.split('-').map(Number);
      return `(year:${year},month:${month},day:${day})`;
    };
    const fields = [
      ...new Set(['impressions', 'clicks', 'costInLocalCurrency', 'externalWebsiteConversions', ...c.extra]),
    ];
    if (fields.length > 18)
      invalidReportSource('LinkedIn permits at most 18 selected metrics with campaign identifiers.');
    const d = await c.run(
      c.plan('/rest/adAnalytics', {
        q: 'analytics',
        pivot: 'CAMPAIGN',
        accounts: 'List(urn:li:sponsoredAccount:' + c.account + ')',
        dateRange: `(start:${date(c.range.since)},end:${date(c.range.until)})`,
        timeGranularity: 'ALL',
        fields: ['pivotValues', 'dateRange', ...fields].join(','),
      }),
      false,
    );
    c.raw = linkedInCampaignPeriod(d, c.range);
    // RPT-07: names and objectives of the reported campaigns, read from the account's own campaigns after the
    // analytics response (cached per job; a later period reads only campaigns not seen before).
    const known = c.lookup?.linkedinCampaigns ?? {campaigns: {}, lineage: []};
    for (const entry of known.lineage) c.lineage.push({...entry, cached: true});
    const missing = known.unavailable
      ? []
      : c.raw.map(r => String(r.pivotValues[0])).filter(urn => !Object.hasOwn(known.campaigns, urn));
    if (missing.length)
      try {
        const before = c.lineage.length,
          read = await linkedInCampaignMetadata(c.account, missing, query =>
            c.run(c.plan('/rest/adAccounts/' + c.account + '/adCampaigns', query), false, 'campaign_metadata'),
          );
        known.lineage.push(...c.lineage.slice(before));
        for (const urn of missing) known.campaigns[urn] = read.campaigns[urn] ?? {name: null, objective_type: null};
      } catch (e) {
        // Only a provider refusal of this optional read keeps IDs. A foreign account, malformed or partial metadata,
        // a retryable failure, or a revoked connection, changed login or scope refusal fails the source.
        if (!optionalReadRefused(e)) throw e;
        known.unavailable = true;
      }
    if (c.lookup) c.lookup.linkedinCampaigns = known;
    if (known.unavailable) c.warnings.push(linkedinCampaignsUnavailableWarning);
    c.raw = c.raw.map(r => {
      const campaign = known.campaigns[String(r.pivotValues[0])];
      return {
        ...r,
        ...(campaign?.name ? {name: campaign.name} : {}),
        ...(campaign?.objective_type ? {objectiveType: campaign.objective_type} : {}),
      };
    });
    c.attribution = 'unknown';
    c.resultDefinition = 'Attributed external website conversions';
    c.warnings.push(
      known.unavailable
        ? 'LinkedIn conversion-rule attribution windows are not independently verified. Campaign objectives should be confirmed in report settings.'
        : 'LinkedIn conversion-rule attribution windows are not independently verified; the verified-window preset is linkedin_campaign_conversion. Campaign names and objectives are current campaign metadata, not the values at delivery time.',
    );
  },
  normalize(raw, {field: n}) {
    return {
      id: raw.pivotValues?.[0]?.split(':').at(-1),
      name: raw.name,
      objective: raw.objectiveType,
      metrics: {
        spend: n('costInLocalCurrency'),
        impressions: n('impressions'),
        clicks: n('clicks'),
        conversions: n('externalWebsiteConversions'),
        conversion_value: n('conversionValueInLocalCurrency'),
        leads: n('oneClickLeads'),
        video_views: n('videoViews'),
        video_completions: n('videoCompletions'),
      },
    };
  },
  // Wave 4c round 6 (w4c-arc6-reporting): the native parents of its detailed creative rows (RPT-07).
  detailParents: linkedinDetailParents,
};
