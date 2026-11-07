import {MirrorError} from './errors.js';
import {nativeDetailLookupLimit, nativeDetailLookupLimitedWarning, redditDetail} from './overview-native-detail.js';
import {redditConversionValueDivisor} from './report-metrics.js';
import {nextDay, optionalReadRefused, reportList, type ReportSource} from './report-source.js';
import {redditReportWarning, savedRedditReportProblems} from './reddit-report-rules.js';
import type {JsonObject} from './types.js';
import {mappedReportResult, type ReportResultRules} from './report-results.js';
import {overviewCapabilities} from './report-source.js';
import {overviewEntityLevels} from './overview-levels.js';
import {reportStatus} from './report-status.js';

/** Only native fields in the captured v3 report enum. A conversion objective alone does not identify its event. */
export const redditResultRules: ReportResultRules = {
  selectors: [
    {
      field: 'objective',
      required: true,
      values: {
        IMPRESSIONS: {
          id: 'reddit:impressions',
          metric: 'impressions',
          label: 'Impressions',
          native_metric: 'IMPRESSIONS',
          aggregation: 'sum',
          unit: 'number',
          cost_multiplier: 1000,
        },
        CLICKS: {
          id: 'reddit:clicks',
          metric: 'clicks',
          label: 'Clicks',
          native_metric: 'CLICKS',
          aggregation: 'sum',
          unit: 'number',
        },
        VIDEO_VIEWABLE_IMPRESSIONS: {
          id: 'reddit:viewable_video_impressions',
          metric: 'video_viewable_impressions',
          label: 'Viewable video impressions',
          native_metric: 'VIDEO_VIEWABLE_IMPRESSIONS',
          aggregation: 'sum',
          unit: 'number',
        },
        CONVERSIONS: null,
        CATALOG_SALES: null,
        LEAD_GENERATION: null,
        APP_INSTALLS: null,
      },
    },
  ],
};

/** The report fields the rule table reads a result from, so the v4 request asks for every field the table pins (F-L5-21). */
const redditResultFields: string[] = redditResultRules.selectors.flatMap(selector =>
  Object.values(selector.values).flatMap(definition => (definition ? [definition.native_metric] : [])),
);

/**
 * ACC-06 interim: AMCP reads Reddit's CONVERSION_PURCHASE_TOTAL_VALUE as cents (redditConversionValueDivisor) while
 * SPEND is in micros; no primary field reference or closed-week read against the Reddit UI confirms that unit yet, so a
 * report that reads it says so until the authorized check is recorded (docs/acceptance/READ-ACCEPTANCE.md).
 */
export const redditValueUnitWarning =
  'Reddit conversion value and ROAS are unverified: AMCP reads CONVERSION_PURCHASE_TOTAL_VALUE as cents (divided by 100), a unit not yet checked against Reddit. Compare them with Reddit Ads Manager before relying on them.';

/** Reddit Ads reports days in UTC. */
const reportZone = 'UTC';

/** Reddit Ads report rows, in upper- or lower-case field names; spend in micros, conversion value in cents (ACC-06). */
export const redditReportSource: ReportSource = {
  platform: 'reddit',
  readStatus(raw, {metadata = raw.entity_metadata}) {
    return reportStatus(
      metadata?.configured_status,
      {ACTIVE: 'active', PAUSED: 'paused', ARCHIVED: 'archived', DELETED: 'archived'},
      metadata?.effective_status,
    );
  },
  overview: overviewCapabilities(overviewEntityLevels.reddit!),
  resultRules: redditResultRules,
  readResult(raw, context) {
    const native = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toUpperCase(), value]));
    return mappedReportResult(redditResultRules, {objective: context.objective ?? raw.objective}, native, {
      spend: raw.SPEND ?? raw.spend,
      spend_divisor: 1e6,
    });
  },
  objectives: {
    name: 'Reddit',
    values: {
      IMPRESSIONS: 'awareness',
      CLICKS: 'traffic',
      VIDEO_VIEWABLE_IMPRESSIONS: 'video_views',
      LEAD_GENERATION: 'leads',
      CONVERSIONS: 'sales',
      CATALOG_SALES: 'sales',
      APP_INSTALLS: 'app_installs',
    },
    missingReason: 'Reddit returned no objective for this campaign.',
  },
  nativeMetricExamples: [
    'VIDEO_STARTED',
    'VIDEO_VIEWABLE_IMPRESSIONS',
    'CONVERSION_PURCHASE_TOTAL_ITEMS',
    'CONVERSION_PURCHASE_TOTAL_VALUE',
  ],
  // RPT-07: its own account report collects the ad group and ad levels.
  nativeDetail: true,
  // The report and the campaign inventory.
  minimumRequestsPerPeriod: 2,
  requestsPerPeriod: (level, contract) =>
    level === 'campaign' ? 2 : contract === 'overview-config-v4' ? (level === 'ad' ? 4 : 3) : 1,
  fixedTimezone: reportZone,
  // PRV-04: saved report queries that Reddit's 2026-12-08 breakdown rules will refuse.
  savedQueryRules: {
    problems: savedRedditReportProblems,
    warning: (id, problems, schedules) => redditReportWarning(id, problems, schedules),
  },
  /**
   * One account report over the UTC period by campaign (RPT-07: by campaign and ad group, or ad, for the detailed
   * levels), the account's campaigns for names and objectives, and for the detailed levels its ad group and ad lists.
   */
  async collect(c) {
    c.timezone = reportZone;
    const d = await c.run(
      c.plan(
        '/api/v3/ad_accounts/' + c.account + '/reports',
        {},
        {
          data: {
            starts_at: c.range.since + 'T00:00:00Z',
            ends_at: nextDay(c.range.until) + 'T00:00:00Z',
            // The v3 request is unchanged; v4 also asks for the field of each result the table pins, so a video views
            // campaign has its viewable video impressions (F-L5-21).
            fields: [
              ...new Set([
                'SPEND',
                'IMPRESSIONS',
                'CLICKS',
                ...(c.source.reporting_contract === 'overview-config-v4' ? redditResultFields : []),
                ...c.extra,
              ]),
            ],
            // RPT-07: ad group and ad levels break down by their parents too (Reddit allows up to three).
            breakdowns:
              c.detail === 'adset'
                ? ['CAMPAIGN_ID', 'AD_GROUP_ID']
                : c.detail === 'ad'
                  ? ['CAMPAIGN_ID', 'AD_GROUP_ID', 'AD_ID']
                  : ['CAMPAIGN_ID'],
          },
        },
      ),
    );
    c.raw = reportList(d.data?.metrics ?? []);
    const campaigns = reportList((await c.run(c.plan('/api/v3/ad_accounts/' + c.account + '/campaigns'))).data ?? []);
    if (c.detail) {
      // Current names from the account's own ad group and ad lists (200 IDs per request, bounded); the report rows
      // already name the parents, and a listed record that disagrees refuses the source.
      const detail = c.detail,
        lists = {campaigns, adGroups: [] as JsonObject[], ads: [] as JsonObject[]},
        wanted = (key: string) =>
          [...new Set(c.raw.map(r => String(r[key] ?? '')))].filter(id => /^[1-9][0-9]{0,31}$/.test(id));
      const named = async (kind: 'ad_groups' | 'ads', ids: string[]) => {
        if (ids.length > nativeDetailLookupLimit) c.warnings.push(nativeDetailLookupLimitedWarning);
        const out: JsonObject[] = [];
        for (let at = 0; at < Math.min(ids.length, nativeDetailLookupLimit); at += 200) {
          const batch = ids.slice(at, Math.min(at + 200, nativeDetailLookupLimit));
          const rows = reportList(
            (
              await c.run(
                c.plan('/api/v3/ad_accounts/' + c.account + '/' + kind, {id: batch.join(','), 'page.size': 200}),
                true,
                'detail_names',
              )
            ).data ?? [],
          );
          if (rows.some(r => !batch.includes(String(r.id))))
            throw new MirrorError('REPORT_SHAPE_CHANGED', 'Reddit returned an unrequested entity.', {}, 502);
          out.push(...rows);
        }
        return out;
      };
      try {
        lists.adGroups = await named('ad_groups', wanted('ad_group_id'));
        if (detail === 'ad') lists.ads = await named('ads', wanted('ad_id'));
      } catch (e) {
        // As for Apple: only a provider refusal keeps IDs; AMCP access refusals and malformed lists fail the source.
        if (!optionalReadRefused(e)) throw e;
        lists.adGroups = lists.ads = [];
        c.warnings.push(
          'Reddit ad group and ad names could not be read, so rows show IDs; parents still come from the report.',
        );
      }
      c.detailRows = redditDetail(
        detail,
        c.raw,
        lists,
        c.account,
        c.detailRounding,
        c.source.reporting_contract === 'overview-config-v4',
      );
    }
    c.raw = c.raw.map(r => ({
      ...r,
      ...(c.source.reporting_contract === 'overview-config-v4'
        ? {entity_metadata: campaigns.find(campaign => campaign.id === r.campaign_id)}
        : {}),
      campaign_name: campaigns.find(campaign => campaign.id === r.campaign_id)?.name,
      objective: campaigns.find(campaign => campaign.id === r.campaign_id)?.objective,
    }));
    c.warnings.push(
      'Reddit report dates are UTC; monetary conversion values and spend retain their distinct native units in source fields.',
    );
    // ACC-06 interim: the conversion value unit is unverified until the authorized closed-week check is done.
    if (c.extra.includes('CONVERSION_PURCHASE_TOTAL_VALUE')) c.warnings.push(redditValueUnitWarning);
    // The result definition stays 'unknown' on purpose (ACC-06): no primary Reddit reference states which purchases
    // and attribution windows these fields count, so sales recommendations keep asking for review (report-metrics).
    // The closed-week check that settles the value unit also names the definition.
  },
  normalize(raw, {value}) {
    return {
      id: raw.campaign_id ?? raw.CAMPAIGN_ID,
      name: raw.campaign_name,
      objective: raw.objective,
      metrics: {
        spend: value(raw.SPEND ?? raw.spend, 1e6),
        impressions: value(raw.IMPRESSIONS ?? raw.impressions),
        clicks: value(raw.CLICKS ?? raw.clicks),
        purchases: value(raw.CONVERSION_PURCHASE_TOTAL_ITEMS ?? raw.conversion_purchase_total_items),
        conversion_value: value(
          raw.CONVERSION_PURCHASE_TOTAL_VALUE ?? raw.conversion_purchase_total_value,
          redditConversionValueDivisor,
        ),
      },
    };
  },
};
