import {MirrorError} from './errors.js';
import {reportList, type ReportSource} from './report-source.js';

/** RPT-04: TikTok campaign reporting reads `AUCTION_CAMPAIGN` data only. */
const tiktokAuctionOnlyWarning =
  'TikTok campaign reporting covers auction campaigns only (AUCTION_CAMPAIGN); Reach & Frequency and other reserved campaigns are not included.';
/** Shown when TikTok's ad group read failed, so result definitions fall back to the generic one. */
export const tiktokEventsUnavailableWarning =
  'TikTok ad group optimization events could not be read, so conversions use one generic result definition and campaigns optimizing for different events are not told apart.';

/** TikTok integrated report rows (dimensions and metrics); conversions name the ad groups' optimization events. */
export const tiktokReportSource: ReportSource = {
  platform: 'tiktok',
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
  /**
   * One BASIC auction campaign report over the period, the campaign inventory for objectives, and the ad group
   * optimization events (RPT-04), read once per source and job.
   */
  async collect(c) {
    const d = await c.run(
      c.plan('/v1.3/report/integrated/get/', {
        advertiser_id: c.account,
        report_type: 'BASIC',
        data_level: 'AUCTION_CAMPAIGN',
        dimensions: ['campaign_id'],
        metrics: [...new Set(['campaign_name', 'spend', 'impressions', 'clicks', 'conversion', ...c.extra])],
        start_date: c.range.since,
        end_date: c.range.until,
        page: 1,
        page_size: 1000,
      }),
    );
    c.raw = reportList(d.data?.list ?? []);
    const inventory = reportList(
      (await c.run(c.plan('/v1.3/campaign/get/', {advertiser_id: c.account, page: 1, page_size: 1000}))).data?.list ??
        [],
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
              c.plan('/v1.3/adgroup/get/', {advertiser_id: c.account, page: 1, page_size: 1000}),
              true,
              'adgroups',
            )
          ).data?.list ?? [],
        );
        const events = new Map<string, Set<string>>();
        for (const group of adgroups) {
          const campaign = String(group.campaign_id ?? '');
          if (!campaign) continue;
          const event =
            [group.optimization_goal, group.optimization_event]
              .filter(v => typeof v === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(v))
              .join(' / ') || 'unknown';
          events.set(campaign, (events.get(campaign) ?? new Set()).add(event));
        }
        adgroupEvents = {
          events: Object.fromEntries([...events].map(([campaign, set]) => [campaign, [...set].sort()])),
          lineage: c.lineage.at(-1),
        };
      } catch (e) {
        if (!(e instanceof MirrorError) || e.retryable) throw e;
        adgroupEvents = {events: {}, unavailable: true};
      }
      if (c.lookup) c.lookup.tiktokEvents = adgroupEvents;
    }
    if (adgroupEvents.unavailable) c.warnings.push(tiktokEventsUnavailableWarning);
    const campaignEvents = adgroupEvents.events;
    c.raw = c.raw.map(r => ({
      ...r,
      objective_type: inventory.find(campaign => String(campaign.campaign_id) === String(r.dimensions?.campaign_id))
        ?.objective_type,
      optimization_events: Object.hasOwn(campaignEvents, String(r.dimensions?.campaign_id))
        ? campaignEvents[String(r.dimensions?.campaign_id)]
        : [],
    }));
    c.resultDefinition = 'TikTok conversion metric for the selected optimization goal';
    c.warnings.push(tiktokAuctionOnlyWarning);
  },
  normalize(raw, {value}) {
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
};
