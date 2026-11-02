import {MirrorError} from './errors.js';
import {linkedinGuidedReporting} from './linkedin-guided-reports.js';
import {linkedInCampaignGroupMetadata, linkedInCampaignMetadata, linkedInCampaignPeriod} from './linkedin-reporting.js';
import {linkedinVersion} from './linkedin-version.js';
import {linkedinDetailParents, linkedInCreativeMetadata} from './linkedin-detail-parents.js';
import {invalidReportSource, optionalReadRefused, type ReportCollection, type ReportSource} from './report-source.js';
import {nativeDecimal, nativeDetailLookupLimit, nativeDetailLookupLimitedWarning} from './overview-native-detail.js';
import {linkedinReportPivots} from './workflows.js';
import type {JsonObject} from './types.js';

/** Shown when LinkedIn refused the campaign metadata read, so rows keep campaign IDs and unknown objectives. */
export const linkedinCampaignsUnavailableWarning =
  'LinkedIn campaign names and objectives could not be read, so rows show campaign IDs and objectives stay unknown unless confirmed in report settings.';
export const linkedinMetadataUnavailableWarning =
  'LinkedIn metadata could not be read, so some names, parents or objectives remain unknown.';

/** LinkedIn analytics report days in UTC. */
const reportZone = 'UTC';

/** Each job reads current metadata once per reported entity, retaining the authorization-bracketed lineage. */
async function metadata(
  c: ReportCollection,
  kind: 'campaign' | 'group' | 'creative',
  urns: string[],
  load: (urns: string[]) => Promise<Record<string, JsonObject>>,
): Promise<Record<string, JsonObject>> {
  const [key, field] = {
    campaign: ['linkedinCampaigns', 'campaigns'],
    group: ['linkedinGroups', 'groups'],
    creative: ['linkedinCreatives', 'creatives'],
  }[kind] as ['linkedinCampaigns' | 'linkedinGroups' | 'linkedinCreatives', string];
  const known: JsonObject = c.lookup?.[key] ?? {[field]: {}, lineage: []},
    records: Record<string, JsonObject> = known[field];
  for (const entry of known.lineage) c.lineage.push({...entry, cached: true});
  let missing = known.unavailable ? [] : [...new Set(urns)].filter(urn => !Object.hasOwn(records, urn));
  if (kind === 'creative') {
    const room = Math.max(0, nativeDetailLookupLimit - Object.keys(records).length);
    if (missing.length > room) known.limited = true;
    missing = missing.slice(0, room);
  }
  if (missing.length)
    try {
      const before = c.lineage.length,
        read = await load(missing);
      Object.assign(records, read);
      for (const urn of missing) if (!Object.hasOwn(records, urn)) records[urn] = {};
      known.lineage.push(...c.lineage.slice(before));
    } catch (error) {
      if (!optionalReadRefused(error)) throw error;
      known.unavailable = true;
    }
  if (c.lookup) Object.assign(c.lookup, {[key]: known});
  if (known.limited) c.warnings.push(nativeDetailLookupLimitedWarning);
  if (known.unavailable)
    c.warnings.push(kind === 'campaign' ? linkedinCampaignsUnavailableWarning : linkedinMetadataUnavailableWarning);
  return records;
}

/** LinkedIn detail retains native URN entity identities and numeric parent IDs in their shared positions. */
export function linkedinDetail(
  level: 'adset' | 'ad',
  rows: JsonObject[],
  meta: {
    campaigns: Record<string, JsonObject>;
    groups: Record<string, JsonObject>;
    creatives: Record<string, JsonObject>;
  },
  rounding: Record<string, number>,
): {rows: JsonObject[]; parents: Record<string, JsonObject>} {
  const out: JsonObject[] = [],
    parents: Record<string, JsonObject> = {};
  for (const row of rows) {
    const urn = row.pivotValues?.[0],
      kind = level === 'ad' ? 'sponsoredCreative' : 'sponsoredCampaign';
    if (
      typeof urn !== 'string' ||
      !new RegExp('^urn:li:' + kind + ':[1-9][0-9]{0,31}$').test(urn) ||
      row.pivotValues.length !== 1
    )
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not return the requested native entity pivot.');
    const creative = level === 'ad' ? meta.creatives[urn] : undefined,
      campaignUrn = level === 'ad' ? creative?.campaign : urn,
      campaign = campaignUrn ? meta.campaigns[campaignUrn] : undefined,
      groupUrn = campaign?.campaign_group,
      group = groupUrn ? meta.groups[groupUrn] : undefined,
      numericId = urn.split(':').at(-1)!,
      currentName = level === 'ad' ? creative?.name : campaign?.name,
      name = typeof currentName === 'string' && currentName.trim() && currentName.length <= 1000 ? currentName : null;
    parents[urn] = {
      ...(groupUrn ? {campaign_id: groupUrn.split(':').at(-1), campaign_name: group?.name ?? null} : {}),
      ...(level === 'ad' && campaignUrn
        ? {adset_id: campaignUrn.split(':').at(-1), adset_name: campaign?.name ?? null}
        : {}),
      ...(typeof campaign?.objective_type === 'string' ? {objective: campaign.objective_type} : {}),
    };
    out.push({
      entity_id: urn,
      entity_name: name ?? (level === 'ad' ? 'Ad ' + numericId : numericId),
      spend: nativeDecimal(row.costInLocalCurrency, 'spend', rounding),
      impressions: nativeDecimal(row.impressions, 'impressions', rounding),
      clicks: nativeDecimal(row.clicks, 'clicks', rounding),
      conversions: nativeDecimal(row.externalWebsiteConversions, 'conversions', rounding),
      conversion_value: nativeDecimal(row.conversionValueInLocalCurrency, 'conversion_value', rounding),
      reach: null,
      frequency: null,
    });
  }
  return {rows: out, parents};
}

/** LinkedIn adAnalytics at each native position; money in the verified account currency. */
export const linkedinReportSource: ReportSource = {
  platform: 'linkedin',
  objectives: {
    name: 'LinkedIn',
    values: {
      BRAND_AWARENESS: 'awareness',
      WEBSITE_VISIT: 'traffic',
      WEBSITE_VISITS: 'traffic',
      ENGAGEMENT: 'engagement',
      VIDEO_VIEW: 'video_views',
      VIDEO_VIEWS: 'video_views',
      LEAD_GENERATION: 'leads',
      WEBSITE_CONVERSION: 'sales',
      WEBSITE_CONVERSIONS: 'sales',
      JOB_APPLICANT: 'traffic',
      JOB_APPLICANTS: 'traffic',
      TALENT_LEAD: 'leads',
    },
    missingReason: 'LinkedIn returned no objective for this campaign.',
  },
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
  nativeDetail: true,
  fixedTimezone: reportZone,
  guided: linkedinGuidedReporting,
  requestHeaders: () => ({'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'}),
  // LinkedIn versions its API by header, not by path, so lineage names that header's value.
  versionHeader: 'LinkedIn-Version',
  /**
   * One complete ALL analytics response over the UTC period, after the account identity and currency checks,
   * then the reported entities' current metadata, read once per entity and job.
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
        pivot: linkedinReportPivots[(c.detail ?? 'campaign') as keyof typeof linkedinReportPivots],
        accounts: 'List(urn:li:sponsoredAccount:' + c.account + ')',
        dateRange: `(start:${date(c.range.since)},end:${date(c.range.until)})`,
        timeGranularity: 'ALL',
        fields: ['pivotValues', 'dateRange', ...fields].join(','),
      }),
      false,
    );
    c.raw = linkedInCampaignPeriod(
      d,
      c.range,
      linkedinReportPivots[(c.detail ?? 'campaign') as keyof typeof linkedinReportPivots],
    );
    const reported = c.raw.map(row => String(row.pivotValues[0]));
    const creatives =
      c.detail === 'ad'
        ? await metadata(c, 'creative', reported, async urns =>
            Object.fromEntries(
              (
                await linkedInCreativeMetadata(c.account, urns, query =>
                  c.run(c.plan('/rest/adAccounts/' + c.account + '/creatives', query), false, 'creative_metadata'),
                )
              ).map(row => [row.id, row]),
            ),
          )
        : {};
    const campaignUrns: string[] =
      c.detail === 'ad'
        ? reported.flatMap(urn => (creatives[urn]?.campaign ? [String(creatives[urn]!.campaign)] : []))
        : c.detail
          ? reported
          : [];
    const campaigns = await metadata(
      c,
      'campaign',
      campaignUrns,
      async urns =>
        (
          await linkedInCampaignMetadata(c.account, urns, query =>
            c.run(c.plan('/rest/adAccounts/' + c.account + '/adCampaigns', query), false, 'campaign_metadata'),
          )
        ).campaigns,
    );
    const groupUrns: string[] = c.detail
      ? campaignUrns.flatMap(urn => (campaigns[urn]?.campaign_group ? [String(campaigns[urn]!.campaign_group)] : []))
      : reported;
    const groups = await metadata(c, 'group', groupUrns, urns =>
      linkedInCampaignGroupMetadata(c.account, urns, plan => c.run(plan, false, 'campaign_group_metadata')),
    );
    if (c.detail) {
      // Preserve the native metric provenance previously provided by the guided detail capture.
      c.context.metric_mapping = {
        entity_id: '/pivotValues/0',
        spend: '/costInLocalCurrency',
        impressions: '/impressions',
        clicks: '/clicks',
        conversions: '/externalWebsiteConversions',
        conversion_value: '/conversionValueInLocalCurrency',
      };
      c.detailRows = linkedinDetail(
        c.detail as 'adset' | 'ad',
        c.raw,
        {campaigns, groups, creatives},
        c.detailRounding,
      );
    } else
      c.raw = c.raw.map(row => ({
        ...row,
        name: groups[String(row.pivotValues[0])]?.name,
        objectiveType: groups[String(row.pivotValues[0])]?.objective_type,
      }));
    c.attribution = 'unknown';
    c.resultDefinition = 'Attributed external website conversions';
    c.warnings.push(
      c.lookup?.linkedinCampaigns?.unavailable
        ? 'LinkedIn conversion-rule attribution windows are not independently verified. Campaign objectives should be confirmed in report settings.'
        : 'LinkedIn conversion-rule attribution windows are not independently verified; the verified-window preset is linkedin_campaign_conversion. Entity names and objectives are current metadata, not the values at delivery time.',
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
