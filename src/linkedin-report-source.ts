import {MirrorError} from './errors.js';
import {linkedinGuidedReporting} from './linkedin-guided-reports.js';
import {
  linkedInCampaignGroupMetadata,
  linkedInCampaignMetadata,
  linkedInCampaignPeriod,
  linkedInCreativeOldestDay,
  linkedInReportDate,
  linkedInSplitRead,
  linkedInRetainedRowsWarning,
  linkedInSplitMetricsWarning,
  linkedInSplitReachWarning,
  linkedInSplitBudgetWarning,
} from './linkedin-reporting.js';
import {linkedinVersion} from './linkedin-version.js';
import {linkedinDetailParents, linkedInCreativeMetadata} from './linkedin-detail-parents.js';
import {invalidReportSource, optionalReadRefused, type ReportCollection, type ReportSource} from './report-source.js';
import {nativeDecimal, nativeDetailLookupLimit, nativeDetailLookupLimitedWarning} from './overview-native-detail.js';
import {linkedinReportPivots} from './workflows.js';
import {mixedObjectiveGroup, resolveObjective} from './report-objectives.js';
import {metricNumber} from './report-metrics.js';
import {overviewCapabilities} from './report-source.js';
import {reportStatus} from './report-status.js';
import {metricRoundingRecord, parseProviderDecimal} from './provider-decimal.js';
import type {JsonObject} from './types.js';
import {
  mappedReportResult,
  selectReportResultDefinition,
  resolveReportResult,
  unavailableReportResult,
  groupReportResults,
} from './report-results.js';

/** Shown when LinkedIn refused the campaign metadata read, so rows keep campaign IDs and unknown objectives. */
export const linkedinCampaignsUnavailableWarning =
  'LinkedIn campaign names and objectives could not be read, so rows show campaign IDs and objectives stay unknown unless confirmed in report settings.';
export const linkedinMetadataUnavailableWarning =
  'LinkedIn metadata could not be read, so some names, parents or objectives remain unknown.';
export const linkedinMetadataLimitedWarning =
  'This LinkedIn source reports more than 2000 entities, so names, parents and objectives beyond that bound stay unknown.';

/** LinkedIn analytics report days in UTC. */
const reportZone = 'UTC';

/** Pinned native result fields; mixed groups keep each objective's results separate. */
export const linkedinResults: Readonly<Record<string, {field: string | null; label: string}>> = Object.freeze({
  BRAND_AWARENESS: {field: null, label: 'LinkedIn members reached (not additive)'},
  WEBSITE_VISIT: {field: 'landingPageClicks', label: 'LinkedIn landing page clicks'},
  WEBSITE_VISITS: {field: 'landingPageClicks', label: 'LinkedIn landing page clicks'},
  ENGAGEMENT: {field: 'clicks', label: 'Clicks (engagement result not in the API)'},
  VIDEO_VIEW: {field: 'videoViews', label: 'LinkedIn video views'},
  VIDEO_VIEWS: {field: 'videoViews', label: 'LinkedIn video views'},
  LEAD_GENERATION: {field: 'oneClickLeads', label: 'LinkedIn leads (one-click)'},
  WEBSITE_CONVERSION: {field: 'externalWebsiteConversions', label: 'LinkedIn website conversions'},
  WEBSITE_CONVERSIONS: {field: 'externalWebsiteConversions', label: 'LinkedIn website conversions'},
  JOB_APPLICANT: {field: 'landingPageClicks', label: 'LinkedIn landing page clicks'},
  JOB_APPLICANTS: {field: 'landingPageClicks', label: 'LinkedIn landing page clicks'},
  TALENT_LEAD: {field: 'talentLeads', label: 'LinkedIn talent leads'},
});
/** Native additive fields needed by the result table; approximate reach is valid only for short windows. */
export function linkedinBaseMetrics(windowDays: number, overviewV4 = false): string[] {
  return [
    'impressions',
    'clicks',
    'costInLocalCurrency',
    'landingPageClicks',
    'videoViews',
    'oneClickLeads',
    'qualifiedLeads',
    'externalWebsiteConversions',
    'talentLeads',
    'conversionValueInLocalCurrency',
    ...(overviewV4 ? ['sends'] : []),
    ...(windowDays <= 92 ? ['approximateMemberReach'] : []),
  ];
}
const windowDays = (range: {since: string; until: string}) =>
  (Date.parse(range.until) - Date.parse(range.since)) / 86400000 + 1;
const selectedMetrics = (days: number, v4: boolean, extra: string[] = []) =>
  [...new Set([...linkedinBaseMetrics(days, v4), ...extra])].filter(
    field => days <= 92 || field !== 'approximateMemberReach',
  );
const omittedCost = (row: JsonObject) =>
  row.costInLocalCurrency === undefined && metricNumber(row.impressions) === 0 && metricNumber(row.clicks) === 0;
const rowReach = (row: JsonObject) =>
  !row.dateRange ||
  windowDays({since: linkedInReportDate(row.dateRange.start), until: linkedInReportDate(row.dateRange.end)}) <= 92
    ? row.approximateMemberReach
    : null;
const nativeObjective = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;

/** Only delivered campaigns can supply a group's shared objective. An unknown delivered objective stays visible. */
export function linkedinGroupObjective(
  group: {objective_type?: unknown} | undefined,
  campaigns: {objective_type: unknown; delivered: boolean}[],
): {native: string | null; mixed: boolean; objectives: string[]} {
  const own = nativeObjective(group?.objective_type);
  if (own) return {native: own, mixed: false, objectives: [own]};
  const objectives = [
    ...new Set(campaigns.filter(c => c.delivered).map(c => nativeObjective(c.objective_type) ?? 'unknown')),
  ].sort();
  if (objectives.length > 1) return {native: 'MIXED', mixed: true, objectives};
  return {native: objectives[0] === 'unknown' ? null : (objectives[0] ?? null), mixed: false, objectives};
}
const delivered = (row: JsonObject) =>
  ['impressions', 'clicks', 'costInLocalCurrency'].some(key => (metricNumber(row[key]) ?? 0) > 0);
function groupResults(rows: JsonObject[], campaigns: Record<string, JsonObject>, rounding: Record<string, number>) {
  const grouped = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const objective = nativeObjective(campaigns[String(row.pivotValues[0])]?.objective_type) ?? 'unknown';
    grouped.set(objective, [...(grouped.get(objective) ?? []), row]);
  }
  return [...grouped]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([objective, values]) => {
      const result = linkedinResults[objective] ?? {
          field: 'externalWebsiteConversions',
          label: 'Attributed external website conversions',
        },
        numbers = result.field ? values.map(row => nativeDecimal(row[result.field!], 'conversions', rounding)) : [null];
      let value: string | null = null;
      if (numbers.every(n => n !== null)) {
        const sum = numbers.reduce((total, n) => total + parseProviderDecimal(n!, {field: 'conversions'}).scaled, 0n),
          fraction = (sum % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
        value = (sum / 1000000000n).toString() + (fraction ? '.' + fraction : '');
      }
      return {
        objective,
        group: resolveObjective({platform: 'linkedin', table: linkedinReportSource.objectives, native: objective})
          .group,
        result_definition: result.label,
        value,
      };
    });
}

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
  {
    const limit = kind === 'creative' ? nativeDetailLookupLimit : 2000,
      room = Math.max(0, limit - Object.keys(records).length);
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
  if (known.limited)
    c.warnings.push(kind === 'creative' ? nativeDetailLookupLimitedWarning : linkedinMetadataLimitedWarning);
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
  overviewV4 = false,
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
      name = typeof currentName === 'string' && currentName.trim() && currentName.length <= 1000 ? currentName : null,
      result = linkedinResults[String(campaign?.objective_type)],
      costOmitted = omittedCost(row);
    parents[urn] = {
      ...(overviewV4 ? {entity_metadata: level === 'ad' ? creative : campaign} : {}),
      ...(groupUrn ? {campaign_id: groupUrn.split(':').at(-1), campaign_name: group?.name ?? null} : {}),
      ...(level === 'ad' && campaignUrn
        ? {adset_id: campaignUrn.split(':').at(-1), adset_name: campaign?.name ?? null}
        : {}),
      ...(typeof campaign?.objective_type === 'string' ? {objective: campaign.objective_type} : {}),
      ...(campaign?.campaign_type ? {format: campaign.campaign_type} : {}),
    };
    out.push({
      entity_id: urn,
      entity_name: name ?? (level === 'ad' ? 'Ad ' + numericId : numericId),
      spend: costOmitted ? '0' : nativeDecimal(row.costInLocalCurrency, 'spend', rounding),
      impressions: nativeDecimal(row.impressions, 'impressions', rounding),
      clicks: nativeDecimal(row.clicks, 'clicks', rounding),
      conversions:
        result?.field === null
          ? null
          : nativeDecimal(row[result?.field ?? 'externalWebsiteConversions'], 'conversions', rounding),
      conversion_value: nativeDecimal(row.conversionValueInLocalCurrency, 'conversion_value', rounding),
      reach: nativeDecimal(rowReach(row), 'reach', rounding),
      frequency: null,
      additional_metrics: {
        leads: nativeDecimal(row.oneClickLeads, 'leads', rounding),
        ...Object.fromEntries(
          ['oneClickLeads', 'qualifiedLeads']
            .filter(field => Object.hasOwn(row, field))
            .map(field => [
              'native_linkedin_' + field,
              nativeDecimal(row[field], 'native_linkedin_' + field, rounding),
            ]),
        ),
      },
      ...(result ? {result_definition: result.label} : {}),
      ...(costOmitted || row.omitted_as_zero?.includes('spend') ? {omitted_as_zero: ['spend']} : {}),
    });
  }
  return {rows: out, parents};
}

/** LinkedIn adAnalytics at each native position; money in the verified account currency. */
export const linkedinReportSource: ReportSource = {
  platform: 'linkedin',
  readStatus(raw, {metadata = raw.entity_metadata}) {
    return reportStatus(metadata?.status, {
      ACTIVE: 'active',
      PAUSED: 'paused',
      ARCHIVED: 'archived',
      CANCELED: 'archived',
      CANCELLED: 'archived',
      REMOVED: 'archived',
      PENDING_DELETION: 'archived',
    });
  },
  overview: {
    ...overviewCapabilities([
      {
        id: 'campaign',
        label: 'Campaign group',
        native_type: 'sponsoredCampaignGroup',
        preset: 'linkedin_campaign_group',
      },
      {id: 'adset', label: 'Campaign', native_type: 'sponsoredCampaign', preset: 'linkedin_campaign'},
      {id: 'ad', label: 'Creative', native_type: 'sponsoredCreative', preset: 'linkedin_creative'},
    ]),
    scope_id_prefixes: {
      campaign: 'urn:li:sponsoredCampaignGroup:',
      adset: 'urn:li:sponsoredCampaign:',
      ad: 'urn:li:sponsoredCreative:',
    },
  },
  resultRules: {
    selectors: [
      {
        field: 'format',
        values: {
          SPONSORED_INMAILS: {
            id: 'linkedin:sends',
            metric: 'sends',
            label: 'Sends',
            native_metric: 'sends',
            aggregation: 'sum',
            unit: 'number',
          },
        },
      },
      {
        field: 'objective',
        required: true,
        values: Object.fromEntries(
          Object.entries(linkedinResults).map(([objective, rule]) => {
            const reach = objective === 'BRAND_AWARENESS',
              field = reach ? 'approximateMemberReach' : rule.field!;
            return [
              objective,
              {
                id: 'linkedin:' + field,
                metric: reach ? 'reach' : field,
                label: rule.label,
                native_metric: field,
                aggregation: reach ? 'non_additive' : 'sum',
                unit: 'number',
                ...(reach ? {cost_multiplier: 1000} : {}),
              },
            ];
          }),
        ),
      },
    ],
  },
  readResult(raw, context) {
    if (Array.isArray(raw.amcp_result_groups)) {
      if (raw.amcp_result_groups.length !== 1) return unavailableReportResult('mixed_goals');
      const {definition, result, source, cost_source, unavailable_reason, rounding} = raw.amcp_result_groups[0];
      return {definition, result, source, cost_source, unavailable_reason, rounding};
    }
    const selection = {objective: context.objective ?? raw.objectiveType, format: context.format ?? raw.type},
      selected = selectReportResultDefinition(linkedinReportSource.resultRules!, selection),
      spend = omittedCost(raw) || raw.omitted_as_zero?.includes('spend') ? '0' : raw.costInLocalCurrency;
    if (selected.definition?.native_metric === 'approximateMemberReach' && windowDays(context.range) > 92)
      return resolveReportResult(selected.definition, {value: null, spend}, 'mapped');
    if (!selected.definition) return unavailableReportResult(selected.unavailable_reason!);
    return mappedReportResult(linkedinReportSource.resultRules!, selection, raw, {spend});
  },
  contract: {
    stamp: 'linkedin-levels-v2',
    notice: {
      id: 'linkedin_levels_v2',
      message:
        'LinkedIn reports now show campaign groups in the campaign position, LinkedIn campaigns in the ad set position and creatives in the ad position. Earlier snapshots keep the levels they recorded.',
    },
  },
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
      MIXED: mixedObjectiveGroup,
    },
    reason: (native, inputs) =>
      native === 'MIXED'
        ? 'This campaign group’s campaigns have different objectives: {list}.'.replace('{list}', () =>
            (inputs.group_objectives ?? []).join(', '),
          )
        : null,
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
  requestsPerPeriod(level, contract, context) {
    if (contract !== 'overview-config-v4') return level === 'campaign' ? 2 : 1;
    const fields = selectedMetrics(context ? windowDays(context.range) : 1, true, context?.source.native_metrics),
      fragments = Math.ceil(fields.length / 18);
    return fragments * (level === 'campaign' ? 2 : 1) + (level === 'ad' ? 3 : 2);
  },
  nativeDetail: true,
  fixedTimezone: reportZone,
  guided: linkedinGuidedReporting,
  requestHeaders: () => ({'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'}),
  // LinkedIn versions its API by header, not by path, so lineage names that header's value.
  versionHeader: 'LinkedIn-Version',
  validateRange(source, range) {
    if (source.level !== 'ad') return;
    const now = new Date();
    if (range.since < linkedInCreativeOldestDay(now))
      throw new MirrorError(
        'INVALID_DATE_RANGE',
        'LinkedIn’s creative level covers the current month and the previous five calendar months; choose a later start.',
      );
    if (range.until > now.toISOString().slice(0, 10))
      throw new MirrorError('INVALID_DATE_RANGE', 'LinkedIn creative reporting cannot include future UTC days.');
  },
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
    const days = windowDays(c.range),
      fields = selectedMetrics(days, c.source?.reporting_contract === 'overview-config-v4', c.extra);
    if (new Set(c.extra).size > 18)
      invalidReportSource('LinkedIn permits at most 18 selected metrics with campaign identifiers.');
    if (days > 92) c.warnings.push('LinkedIn reports reach only for windows of 92 days or less.');
    const warn = (message: string) => {
      if (!c.warnings.includes(message)) c.warnings.push(message);
    };
    // One period shares the split allowance across metric fragments and its group/campaign projections.
    let analyticsRemaining = 32;
    const analytics = async (pivot: string, selected: string[]) => {
      let joined: Map<string, JsonObject> | undefined,
        complete = true,
        split = false;
      const key = (row: JsonObject) =>
        JSON.stringify([
          row.pivotValues[0],
          linkedInReportDate(row.dateRange.start),
          linkedInReportDate(row.dateRange.end),
        ]);
      for (let start = 0; start < selected.length; start += 18) {
        if (analyticsRemaining === 0) {
          complete = c.complete = c.collectionComplete = false;
          c.quality.pages_collected = false;
          warn(linkedInSplitBudgetWarning);
          break;
        }
        const batch = selected.slice(start, start + 18);
        let result: Awaited<ReturnType<typeof linkedInSplitRead>>;
        try {
          result = await linkedInSplitRead(
            c.range,
            async range => {
              analyticsRemaining--;
              const response = await c.run(
                c.plan('/rest/adAnalytics', {
                  q: 'analytics',
                  pivot,
                  accounts: 'List(urn:li:sponsoredAccount:' + c.account + ')',
                  dateRange: `(start:${date(range.since)},end:${date(range.until)})`,
                  timeGranularity: 'ALL',
                  fields: ['pivotValues', 'dateRange', ...batch].join(','),
                }),
                false,
              );
              return linkedInCampaignPeriod(response, range, pivot, true);
            },
            analyticsRemaining,
          );
        } catch (error) {
          const upstream =
            error instanceof MirrorError ? (error.details.upstream as JsonObject | undefined) : undefined;
          if (
            error instanceof MirrorError &&
            (error.details.http_status ?? error.status) === 400 &&
            [error.details.provider_code, upstream?.code, upstream?.message, upstream?.error?.code].includes(
              'DATE_TOO_EARLY',
            )
          )
            throw new MirrorError(
              'INVALID_DATE_RANGE',
              'LinkedIn keeps this data for a limited time, and this window starts too early. Choose a later start.',
              error.details,
              error.status,
              false,
              {},
            );
          if (joined && error instanceof MirrorError && error.code === 'REPORT_DATE_MISMATCH')
            throw new MirrorError(
              'REPORT_SHAPE_CHANGED',
              'LinkedIn returned different entity or date keys between metric requests.',
            );
          throw error;
        }
        const rows = result.rows;
        if (result.partial || result.limited) {
          complete = c.complete = c.collectionComplete = false;
          c.quality.pages_collected = false;
          if (result.partial) warn(result.partial);
          if (result.limited) warn(linkedInRetainedRowsWarning);
        }
        if (result.split) {
          split = true;
          warn(linkedInSplitReachWarning);
        }
        if (result.unavailable) warn(linkedInSplitMetricsWarning);
        for (const [field, count] of Object.entries(result.rounding ?? {})) {
          if (!batch.includes(field)) continue;
          const metric = 'native_linkedin_' + field;
          c.detailRounding[metric] = (c.detailRounding[metric] ?? 0) + count;
        }
        if (!joined) joined = new Map(rows.map(row => [key(row), {...row}]));
        else {
          if (rows.length !== joined.size || rows.some(row => !joined!.has(key(row))))
            throw new MirrorError(
              'REPORT_SHAPE_CHANGED',
              'LinkedIn returned different entity or date keys between metric requests.',
            );
          for (const row of rows)
            for (const field of batch) if (Object.hasOwn(row, field)) joined.get(key(row))![field] = row[field];
        }
      }
      const rows = [...(joined?.values() ?? [])];
      if (split) for (const row of rows) row.approximateMemberReach = null;
      return {rows, complete, split};
    };
    const primary = await analytics(
      linkedinReportPivots[(c.detail ?? 'campaign') as keyof typeof linkedinReportPivots],
      fields,
    );
    c.raw = primary.rows;
    const companion = c.detail ? undefined : await analytics('CAMPAIGN', fields),
      campaignRows = companion?.rows ?? [];
    const reported = c.raw.map(row => String(row.pivotValues[0]));
    const creatives =
      c.detail === 'ad'
        ? await metadata(c, 'creative', reported, async urns =>
            Object.fromEntries(
              (
                await linkedInCreativeMetadata(
                  c.account,
                  urns,
                  query =>
                    c.run(c.plan('/rest/adAccounts/' + c.account + '/creatives', query), false, 'creative_metadata'),
                  c.source?.reporting_contract === 'overview-config-v4',
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
          : campaignRows.map(row => String(row.pivotValues[0]));
    const campaigns = await metadata(
      c,
      'campaign',
      campaignUrns,
      async urns =>
        (
          await linkedInCampaignMetadata(
            c.account,
            urns,
            query => c.run(c.plan('/rest/adAccounts/' + c.account + '/adCampaigns', query), false, 'campaign_metadata'),
            c.source?.reporting_contract === 'overview-config-v4',
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
      c.detailRows = linkedinDetail(
        c.detail as 'adset' | 'ad',
        c.raw,
        {campaigns, groups, creatives},
        c.detailRounding,
        c.source?.reporting_contract === 'overview-config-v4',
      );
    } else {
      const memberships = new Map<string, JsonObject[]>();
      let unassigned = companion?.complete === false;
      for (const campaign of campaignRows) {
        const parent = campaigns[String(campaign.pivotValues[0])]?.campaign_group;
        if (typeof parent === 'string') memberships.set(parent, [...(memberships.get(parent) ?? []), campaign]);
        else if (delivered(campaign)) unassigned = true;
      }
      c.raw = c.raw.map(row => {
        const urn = String(row.pivotValues[0]),
          members = memberships.get(urn) ?? [],
          // One member set decides both a group's objective and its results: the campaigns that delivered. A campaign
          // without delivery that only carries attributed results is listed apart, as another result.
          deliveredMembers = members.filter(delivered),
          // Unassigned delivered campaigns prevent a confident shared objective for any group lacking its own.
          objective = linkedinGroupObjective(
            groups[urn],
            unassigned
              ? []
              : members.map(campaign => ({
                  objective_type: campaigns[String(campaign.pivotValues[0])]?.objective_type,
                  delivered: delivered(campaign),
                })),
          ),
          otherResults = groupResults(
            members.filter(member => !delivered(member)),
            campaigns,
            c.detailRounding,
          ).filter(result => result.value !== null && result.value !== '0');
        const v4 = c.source?.reporting_contract === 'overview-config-v4',
          types = new Set(members.map(member => campaigns[String(member.pivotValues[0])]?.campaign_type)),
          type = types.size === 1 ? [...types][0] : null,
          nativeGroups = v4
            ? groupReportResults(
                deliveredMembers.map(member => {
                  const metadata = campaigns[String(member.pivotValues[0])];
                  return {
                    resolved: linkedinReportSource.readResult!(
                      {...member, type: metadata?.campaign_type},
                      {
                        level: 'adset',
                        range: c.range,
                        objective: metadata?.objective_type,
                      },
                    ),
                    currency: c.currency,
                    scope: JSON.stringify([c.account, urn, c.range, c.attribution, metadata?.objective_type]),
                    spend: omittedCost(member) ? '0' : (member.costInLocalCurrency ?? null),
                  };
                }),
              )
            : [];
        return {
          ...row,
          name: groups[urn]?.name,
          objectiveType: objective.native,
          ...(v4
            ? {
                type,
                entity_metadata: groups[urn],
                amcp_result_groups: nativeGroups.length > 1 ? nativeGroups : undefined,
              }
            : {}),
          ...(objective.mixed
            ? {
                group_objectives: objective.objectives,
                results_by_objective: groupResults(deliveredMembers, campaigns, c.detailRounding),
              }
            : {}),
          ...(otherResults.length ? {other_results: otherResults} : {}),
        };
      });
    }
    c.context.metric_mapping = {
      entity_id: '/pivotValues/0',
      spend: '/costInLocalCurrency',
      impressions: '/impressions',
      clicks: '/clicks',
      conversions: {
        by_objective: {
          ...Object.fromEntries(
            Object.entries(linkedinResults).map(([objective, result]) => [
              objective,
              result.field ? '/' + result.field : null,
            ]),
          ),
          unknown: '/externalWebsiteConversions',
          MIXED: null,
        },
      },
      conversion_value: '/conversionValueInLocalCurrency',
      reach: days <= 92 && !primary.split ? '/approximateMemberReach' : null,
    };
    const rounded = metricRoundingRecord(c.detailRounding);
    if (rounded) c.quality.metric_rounding = rounded;
    c.attribution = 'unknown';
    c.resultDefinition = 'Attributed external website conversions';
    c.warnings.push(
      c.lookup?.linkedinCampaigns?.unavailable
        ? 'LinkedIn conversion-rule attribution windows are not independently verified. Campaign objectives should be confirmed in report settings.'
        : 'LinkedIn conversion-rule attribution windows are not independently verified; the verified-window preset is linkedin_campaign_conversion. Entity names and objectives are current metadata, not the values at delivery time.',
    );
  },
  normalize(raw, {value, field: n, omitted}) {
    const mixed = raw.objectiveType === 'MIXED',
      result = linkedinResults[String(raw.objectiveType)],
      costOmitted = omittedCost(raw);
    if (costOmitted || raw.omitted_as_zero?.includes('spend')) omitted.add('spend');
    return {
      id: raw.pivotValues?.[0]?.split(':').at(-1),
      name: raw.name,
      objective: raw.objectiveType,
      ...(result ? {resultDefinition: result.label} : {}),
      ...(mixed
        ? {objectiveGroup: mixedObjectiveGroup, resultDefinition: 'Mixed', resultsByObjective: raw.results_by_objective}
        : {}),
      ...(raw.other_results ? {otherResults: raw.other_results} : {}),
      metrics: {
        spend: costOmitted ? 0 : n('costInLocalCurrency'),
        impressions: n('impressions'),
        clicks: n('clicks'),
        conversions: mixed || result?.field === null ? null : n(result?.field ?? 'externalWebsiteConversions'),
        reach: value(rowReach(raw)),
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
