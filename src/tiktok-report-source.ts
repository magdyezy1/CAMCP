import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {overviewCapabilities, optionalReadRefused, reportList, type ReportSource} from './report-source.js';
import {tiktokDetailParents} from './tiktok-detail-parents.js';
import {tiktokGuidedReporting} from './tiktok-guided-reports.js';
import {tiktokCollectionCheck} from './tiktok-report-pagination.js';
import {tiktokNativeResult, collectTikTokCampaignResults} from './tiktok-report-results.js';
import {reportStatus} from './report-status.js';
import {overviewEntityLevels} from './overview-levels.js';
import {
  tiktokCampaignWindowDays,
  tiktokStatusFilter,
  tiktokStatusFilterRefused,
  tiktokStatusFilterRefusedWarning,
} from './tiktok-report-request.js';

/** RPT-04: TikTok campaign reporting reads `AUCTION_CAMPAIGN` data only. */
const tiktokAuctionOnlyWarning =
  'TikTok campaign reporting covers auction campaigns only (AUCTION_CAMPAIGN); Reach & Frequency and other reserved campaigns are not included.';
/** Shown when TikTok's ad group read failed, so result definitions fall back to the generic one. */
export const tiktokEventsUnavailableWarning =
  'TikTok ad group optimization events could not be read, so conversions use one generic result definition and campaigns optimizing for different events are not told apart.';

/** TikTok integrated report rows (dimensions and metrics); conversions name the ad groups' optimization events. */
export const tiktokReportSource: ReportSource = {
  platform: 'tiktok',
  readStatus(raw, {level, metadata = raw.entity_metadata}) {
    const entity = level === 'ad' ? 'AD' : level === 'adset' ? 'ADGROUP' : 'CAMPAIGN';
    return reportStatus(
      metadata?.operation_status,
      {ENABLE: 'active', DISABLE: 'paused', DELETE: 'archived'},
      metadata?.secondary_status,
      metadata?.secondary_status === entity + '_STATUS_DELETE',
    );
  },
  requiresCompleteWindowDeclaration: true,
  overview: overviewCapabilities(overviewEntityLevels.tiktok!, {}, [], undefined, {requires_complete: true}),
  readResult: tiktokNativeResult,
  contract: {
    stamp: 'tiktok-collection-v2',
    notice: {
      id: 'tiktok_collection_v2',
      message:
        'TikTok reports now include campaigns deleted since the window and check TikTok’s own totals, so past windows can show more spend than before.',
    },
  },
  objectives: {
    name: 'TikTok',
    values: {
      REACH: 'awareness',
      RF_REACH: 'awareness',
      TRAFFIC: 'traffic',
      VIDEO_VIEWS: 'video_views',
      LEAD_GENERATION: 'leads',
      ENGAGEMENT: 'engagement',
      APP_PROMOTION: 'app_installs',
      APP_INSTALL: 'app_installs',
      WEB_CONVERSIONS: 'sales',
      PRODUCT_SALES: 'sales',
      APP_RETARGETING: null,
    },
    missingReason: 'TikTok returned no objective for this campaign.',
  },
  nativeMetricExamples: [
    'reach',
    'frequency',
    'video_play_actions',
    'video_watched_2s',
    'video_watched_6s',
    'video_views_p100',
    'likes',
    'comments',
    'shares',
    'follows',
    'total_purchase',
    'total_purchase_value',
  ],
  nativeMetricContainer: 'metrics',
  // The report, the campaign inventory and the ad group optimization events (RPT-04).
  minimumRequestsPerPeriod: 3,
  requestsPerPeriod: (level, contract) =>
    level === 'campaign'
      ? contract === 'overview-config-v4'
        ? 4
        : 3
      : contract === 'overview-config-v4'
        ? level === 'ad'
          ? 6
          : 5
        : 1,
  guided: tiktokGuidedReporting,
  validateRange(source, range) {
    if (
      (source.level ?? 'campaign') === 'campaign' &&
      (Date.parse(range.until) - Date.parse(range.since)) / 86400000 + 1 > tiktokCampaignWindowDays
    )
      throw new MirrorError(
        'INVALID_DATE_RANGE',
        'TikTok reports up to 365 days at a time without daily rows; choose 365 days or fewer.',
      );
  },
  /**
   * One BASIC auction campaign report over the period, the campaign inventory for objectives, and the ad group
   * optimization events (RPT-04), read once per source and job.
   */
  async collect(c) {
    const v4 = c.source?.reporting_contract === 'overview-config-v4';
    if (v4) c.attribution = c.source.report_options.attribution;
    const query: JsonObject = {
      advertiser_id: c.account,
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: ['campaign_id'],
      metrics: [...new Set(['campaign_name', 'spend', 'impressions', 'clicks', 'conversion', ...c.extra])],
      start_date: c.range.since,
      end_date: c.range.until,
      page: 1,
      page_size: 1000,
      enable_total_metrics: true,
      ...(c.lookup?.tiktokStatusFilter === 'refused' ? {} : {filtering: tiktokStatusFilter('campaign')}),
    };
    let d;
    try {
      d = await c.run(c.plan('/v1.3/report/integrated/get/', query));
    } catch (error) {
      if (!query.filtering || !tiktokStatusFilterRefused(error)) throw error;
      if (c.lookup) c.lookup.tiktokStatusFilter = 'refused';
      delete query.filtering;
      c.warnings.push(tiktokStatusFilterRefusedWarning);
      d = await c.run(c.plan('/v1.3/report/integrated/get/', query));
    }
    if (c.lookup?.tiktokStatusFilter === 'refused' && !c.warnings.includes(tiktokStatusFilterRefusedWarning))
      c.warnings.push(tiktokStatusFilterRefusedWarning);
    c.raw = reportList(d.data?.list ?? []);
    const checked = tiktokCollectionCheck(
      c.raw,
      d.data?.page_info?.total_number ?? 0,
      d.data?.total_metrics,
      query.metrics,
    );
    c.warnings.push(...checked.warnings);
    if (!checked.complete) {
      c.collectionComplete = false;
      c.complete = false;
    }
    const inventory = reportList(
      (
        await c.run(
          c.plan('/v1.3/campaign/get/', {
            advertiser_id: c.account,
            filtering: {primary_status: 'STATUS_ALL'},
            page: 1,
            page_size: 1000,
          }),
        )
      ).data?.list ?? [],
    );
    // RPT-04: TikTok's `conversion` follows each ad group's optimization event. One bounded ad group inventory read
    // per source and job (cached across periods, like the account lookup) names the events per campaign, so
    // summaries never add conversions of different events into one result. The read is optional: a non-retryable
    // failure (a refusal, or more pages than the bound) keeps the source with the generic result definition and a
    // warning; a retryable one retries the job.
    let adgroupEvents = c.lookup?.tiktokEvents;
    if (adgroupEvents?.lineage) c.lineage.push({...adgroupEvents.lineage, cached: true});
    if (!adgroupEvents) {
      try {
        const adgroups = reportList(
          (
            await c.run(
              c.plan('/v1.3/adgroup/get/', {
                advertiser_id: c.account,
                page: 1,
                page_size: 1000,
                ...(v4 ? {filtering: {primary_status: 'STATUS_ALL'}} : {}),
              }),
              true,
              'adgroups',
            )
          ).data?.list ?? [],
        );
        const events = new Map<string, Set<string>>(),
          groups: Record<string, JsonObject> = {};
        for (const group of adgroups) {
          const campaign = String(group.campaign_id ?? '');
          if (!campaign) continue;
          if (v4) {
            if (
              typeof group.adgroup_id !== 'string' ||
              !/^[1-9][0-9]{0,31}$/.test(group.adgroup_id) ||
              !/^[1-9][0-9]{0,31}$/.test(campaign) ||
              Object.hasOwn(groups, group.adgroup_id) ||
              (group.advertiser_id !== undefined && group.advertiser_id !== c.account)
            )
              throw new MirrorError(
                'REPORT_SHAPE_CHANGED',
                'TikTok returned malformed ad group result metadata.',
                {},
                502,
              );
            groups[group.adgroup_id] = group;
          }
          const event =
            [group.optimization_goal, group.optimization_event]
              .filter(v => typeof v === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(v))
              .join(' / ') || 'unknown';
          events.set(campaign, (events.get(campaign) ?? new Set()).add(event));
        }
        adgroupEvents = {
          events: Object.fromEntries([...events].map(([campaign, set]) => [campaign, [...set].sort()])),
          lineage: c.lineage.at(-1),
          ...(v4 ? {groups} : {}),
        };
      } catch (e) {
        if (!(e instanceof MirrorError) || e.retryable) throw e;
        if (v4 && e.code !== 'INCOMPLETE_REPORT' && !optionalReadRefused(e) && !tiktokDetailParents.bodyRefused?.(e))
          throw e;
        adgroupEvents = {events: {}, unavailable: true};
      }
      if (c.lookup) c.lookup.tiktokEvents = adgroupEvents;
    }
    if (adgroupEvents.unavailable) c.warnings.push(tiktokEventsUnavailableWarning);
    const campaignEvents = adgroupEvents.events;
    c.raw = c.raw.map(r => ({
      ...r,
      ...(v4 ? {entity_metadata: inventory.find(campaign => campaign.campaign_id === r.dimensions?.campaign_id)} : {}),
      objective_type: inventory.find(campaign => String(campaign.campaign_id) === String(r.dimensions?.campaign_id))
        ?.objective_type,
      optimization_events: Object.hasOwn(campaignEvents, String(r.dimensions?.campaign_id))
        ? campaignEvents[String(r.dimensions?.campaign_id)]
        : [],
    }));
    c.resultDefinition = 'TikTok conversion metric for the selected optimization goal';
    if (v4 && adgroupEvents.groups) await collectTikTokCampaignResults(c, adgroupEvents.groups);
    c.warnings.push(tiktokAuctionOnlyWarning);
  },
  normalize(raw, {value: readValue}) {
    const value = (v: unknown) => readValue(v === '-' ? null : v);
    const m = raw.metrics ?? {};
    // RPT-04: the result definition names the campaign's ad group optimization events; mixed events are held.
    const events: string[] = Array.isArray(raw.optimization_events) ? raw.optimization_events : [];
    let resultDefinition: string | undefined,
      mixedResult = false;
    if (events.length === 1) resultDefinition = 'TikTok conversions for optimization event ' + events[0];
    else if (events.length > 1) {
      resultDefinition = 'TikTok conversions mixing optimization events: ' + events.join(', ');
      mixedResult = true;
    }
    return {
      id: raw.dimensions?.campaign_id,
      name: m.campaign_name,
      objective: raw.objective_type,
      metrics: {
        spend: value(m.spend),
        impressions: value(m.impressions),
        clicks: value(m.clicks),
        conversions: value(m.conversion),
        reach: value(m.reach),
        frequency: value(m.frequency),
        video_views: value(m.video_play_actions),
        video_completions: value(m.video_views_p100),
        purchases: value(m.total_purchase),
        conversion_value: value(m.total_purchase_value),
      },
      resultDefinition,
      mixedResult,
    };
  },
  // Wave 4c round 6 (w4c-arc6-reporting): the native parents of its detailed ad group and ad rows (RPT-07).
  detailParents: tiktokDetailParents,
};
