import {MirrorError} from './errors.js';
import {invalidReportSource, nextDay, optionalReadRefused, reportList, type ReportSource} from './report-source.js';
import type {JsonObject} from './types.js';
import {zonedMidnight} from './workflows.js';
import {xActiveEntities, xActiveEntitiesMode, xActiveSet, xRefusedRead} from './x-active-entities.js';
import {mappedReportResult, type ReportResultRules} from './report-results.js';
import {overviewCapabilities} from './report-source.js';
import {reportStatus} from './report-status.js';
import {overviewEntityLevels} from './overview-levels.js';
import {collectXOverviewDetail} from './x-overview-detail.js';
import {overviewV4Activity} from './overview-v4.js';
import {mixedObjectiveGroup} from './report-objectives.js';
import {
  xCampaignObjectives,
  xCampaignReport,
  xObjectivesMixedWarning,
  xObjectivesUnavailableWarning,
} from './x-campaign-report.js';

/** Native analytics fields. App/web conversions are structured attribution channels, not a scalar to guess. */
export const xResultRules: ReportResultRules = {
  selectors: [
    {
      field: 'objective',
      required: true,
      values: Object.fromEntries(
        [
          ['REACH', 'impressions', 'Impressions'],
          ['ENGAGEMENTS', 'engagements', 'Engagements'],
          ['WEBSITE_CLICKS', 'url_clicks', 'Link clicks'],
          ['FOLLOWERS', 'follows', 'Follows'],
          ['VIDEO_VIEWS', 'video_total_views', 'Video views'],
        ].map(([objective, metric, label]) => [
          objective!,
          {
            id: 'x:' + metric,
            metric: metric!,
            label: label!,
            native_metric: 'native_metrics.' + metric,
            aggregation: 'sum' as const,
            unit: 'number' as const,
            ...(objective === 'REACH' ? {cost_multiplier: 1000 as const} : {}),
          },
        ]),
      ),
    },
  ],
};

/**
 * X's line item objectives, pinned from the X Ads API documentation (docs.x.com/x-ads-api/campaign-management, section
 * "Objective Based Campaigns", read 2026-11-06): an objective is set on a line item, X campaigns carry none, and the
 * section lists these eight values. The groups are AMCP's own reading of what each objective buys. WEBSITE_CONVERSIONS,
 * which AMCP's code has used for X, is not in that section (the page names it only as an example under target
 * bidding), so it is not pinned here and resolves through the shared inference as `provider_inferred`.
 */
export const xLineItemObjectives: Readonly<Record<string, string>> = Object.freeze({
  APP_ENGAGEMENTS: 'engagement',
  APP_INSTALLS: 'app_installs',
  FOLLOWERS: 'engagement',
  ENGAGEMENTS: 'engagement',
  REACH: 'awareness',
  VIDEO_VIEWS: 'video_views',
  PREROLL_VIEWS: 'video_views',
  WEBSITE_CLICKS: 'traffic',
  // AMCP's own value for a campaign whose line items differ; X never returns it.
  MIXED: mixedObjectiveGroup,
});
const xMixedObjective = 'MIXED';

/** X campaign rows as xCampaignReport (src/x-campaign-report.ts) prepares them: the metrics are already shared ones. */
export const xReportSource: ReportSource = {
  platform: 'x',
  readActivity(raw) {
    return raw.native_metrics
      ? overviewV4Activity(raw.native_metrics, ['billed_charge_local_micro', 'impressions', 'clicks'])
      : overviewV4Activity(raw.metrics ?? {}, ['spend', 'impressions', 'clicks']);
  },
  readStatus(raw, {metadata = raw.entity_metadata}) {
    return reportStatus(
      metadata?.entity_status,
      {ACTIVE: 'active', PAUSED: 'paused'},
      metadata?.effective_status,
      metadata?.deleted === true,
    );
  },
  overview: {
    // The build before V2 reports X campaigns only; its detail levels are new (F-L10-11).
    ...overviewCapabilities(overviewEntityLevels.x!, {}, [], undefined, {levels: ['campaign']}),
    scope_id_pattern: '^[A-Za-z0-9]{1,32}$',
  },
  nativeDetail: true,
  resultRules: xResultRules,
  readResult(raw, context) {
    return mappedReportResult(xResultRules, {objective: context.objective ?? raw.objective}, raw, {
      spend: raw.native_metrics?.billed_charge_local_micro,
      spend_divisor: 1e6,
    });
  },
  objectives: {
    name: 'X',
    values: xLineItemObjectives,
    reason: (native, inputs) =>
      native === xMixedObjective
        ? inputs.line_item_objectives?.length
          ? 'This campaign’s line items have different objectives: {list}.'.replace('{list}', () =>
              inputs.line_item_objectives.join(', '),
            )
          : 'This campaign’s line items have different objectives.'
        : null,
    missingReason: 'X returned no shared campaign objective from its line items; choose one in the report.',
  },
  nativeMetricExamples: ['VIDEO', 'WEB_CONVERSION', 'MOBILE_CONVERSION'],
  // X analytics rows carry metric groups in their own shape, so requested metrics are not checked against them.
  nativeMetricCheck: false,
  // The campaign inventory and the active entities; the analytics requests are planned from them at run time.
  minimumRequestsPerPeriod: 2,
  requestsPerPeriod: (level, contract, context) => {
    if (level === 'campaign') return contract === 'overview-config-v4' ? (xActiveEntitiesMode() === 'off' ? 4 : 5) : 2;
    const days = context ? (Date.parse(context.range.until) - Date.parse(context.range.since)) / 86400000 + 1 : 1,
      weeks = Math.ceil((days * 24 + 2) / 168),
      scope = level === 'ad' ? context?.source.ad_ids : context?.source.adset_ids,
      batches = Math.max(1, Math.ceil((scope?.length ?? 0) / 20));
    // Inventory and fanout beyond the known first batch remain bounded by the running collection and sync planner.
    return (
      (level === 'ad' || context?.source.ad_ids?.length ? 3 : 2) +
      weeks * batches * 3 +
      (xActiveEntitiesMode() === 'off' ? 0 : 1)
    );
  },
  /**
   * The account's campaign inventory, the campaigns X reports as active (RPT-03), their line item objectives (RPT-07)
   * and the bounded analytics of those campaigns, each kept with the checkpoint so a resumed run asks X the same.
   */
  async collect(c) {
    if (c.detail) return collectXOverviewDetail(c);
    const {checkpoint, save} = c;
    if (!c.timezone) invalidReportSource('X account timezone is required.');
    const inventory =
      checkpoint.x_inventory ??
      reportList(
        (await c.run(c.plan('/12/accounts/' + c.account + '/campaigns', {count: 1000, with_deleted: true}))).data ?? [],
      );
    const start = zonedMidnight(c.range.since, c.timezone!),
      end = zonedMidnight(nextDay(c.range.until), c.timezone!),
      mode = xActiveEntitiesMode();
    // RPT-03: the inventory names campaigns; X active entities decide which campaigns and windows are requested.
    let active = xActiveSet(checkpoint.x_active),
      fallback = checkpoint.x_active_fallback === true;
    if (mode !== 'off' && !active && !fallback)
      try {
        active = await xActiveEntities(start, end, q =>
          c.run(c.plan('/12/stats/accounts/' + c.account + '/active_entities', q), false, 'active_entities'),
        );
      } catch (e) {
        // A rejected read keeps the bounded inventory path (fails closed above 100 requests); a malformed or
        // partial response is never narrowed and fails the source.
        if (!xRefusedRead(e)) throw e;
        fallback = true;
      }
    if (fallback)
      c.warnings.push(
        'X refused the active-entities read; every listed campaign was requested instead (at most 100 analytics requests).',
      );
    // RPT-07: objectives come from the account's line items (one bounded read, kept with the checkpoint so a resumed
    // run uses the same answer). A refused or oversized read keeps objectives unknown with a warning.
    let objectives: JsonObject | undefined = checkpoint.x_objectives;
    if (!objectives)
      try {
        objectives = xCampaignObjectives(
          inventory,
          reportList(
            (
              await c.run(
                c.plan('/12/accounts/' + c.account + '/line_items', {count: 1000, with_deleted: true}),
                true,
                'line_item_objectives',
              )
            ).data ?? [],
          ),
        );
      } catch (e) {
        // Only a provider refusal (HTTP 400/403/404) or a line item collection above the page bound
        // (INCOMPLETE_REPORT) keeps objectives unknown. A malformed line item, a retryable failure, or a removed
        // connection, changed login or scope refusal fails the source, as for the LinkedIn campaign metadata read.
        if (!(e instanceof MirrorError && e.code === 'INCOMPLETE_REPORT' && !e.retryable) && !optionalReadRefused(e))
          throw e;
        objectives = {unavailable: true, campaigns: {}};
      }
    if (objectives.unavailable) c.warnings.push(xObjectivesUnavailableWarning);
    else if (Object.values(objectives.campaigns ?? {}).includes(null)) c.warnings.push(xObjectivesMixedWarning);
    const state = {
      x_inventory: inventory,
      ...(active ? {x_active: active} : {}),
      ...(fallback ? {x_active_fallback: true} : {}),
      x_objectives: objectives,
    };
    if (
      !checkpoint.x_inventory ||
      (active && !checkpoint.x_active) ||
      (fallback && !checkpoint.x_active_fallback) ||
      !checkpoint.x_objectives
    )
      save(state);
    const report = await xCampaignReport(
      inventory,
      start,
      end,
      c.source.reporting_contract === 'overview-config-v4' ? [...new Set(['VIDEO', ...c.extra])] : c.extra,
      q => c.run(c.plan('/12/stats/accounts/' + c.account, q), false),
      {
        checkpoint: checkpoint.x_report,
        ...(c.source.reporting_contract === 'overview-config-v4' ? {exact: true as const} : {}),
        save: x_report => save({...state, x_report}),
        ...(active ? {active, windows: mode === 'on'} : {}),
      },
    );
    c.raw = report.rows.map(row => {
      // A campaign whose line items differ (null here, with its objectives in `mixed`) is the shared mixed group.
      const shared = Object.hasOwn(objectives!.campaigns ?? {}, row.id) ? objectives!.campaigns[row.id] : undefined,
        differing =
          shared === null
            ? (Object.hasOwn(objectives!.mixed ?? {}, row.id) && objectives!.mixed[row.id]) || []
            : undefined;
      return {
        ...row,
        objective: differing ? xMixedObjective : (shared ?? row.objective),
        ...(differing ? {line_item_objectives: differing} : {}),
        ...(c.source.reporting_contract === 'overview-config-v4'
          ? {entity_metadata: inventory.find((entity: JsonObject) => entity.id === row.id)}
          : {}),
      };
    });
    c.complete = report.complete;
    c.collectionComplete = report.complete;
    c.context.no_activity_count = report.no_activity_count;
    c.warnings.push(...report.warnings);
  },
  normalize(raw, reader) {
    const fields: Record<string, string> = {
      spend: 'billed_charge_local_micro',
      impressions: 'impressions',
      clicks: 'clicks',
      engagements: 'engagements',
      video_views: 'video_total_views',
    };
    for (const [common, native] of Object.entries(fields))
      if (raw.provider_omitted?.includes(native)) reader.omitted.add(common);
    return {
      id: raw.id,
      name: raw.name,
      objective: raw.objective,
      ...(raw.objective === xMixedObjective ? {objectiveGroup: mixedObjectiveGroup} : {}),
      metrics: Object.fromEntries(
        Object.entries(raw.metrics ?? {}).map(([key, value]) => {
          const native = fields[key];
          return [
            key,
            native && Object.hasOwn(raw.native_metrics ?? {}, native)
              ? reader.value(raw.native_metrics[native], key === 'spend' ? 1e6 : 1)
              : reader.value(value),
          ];
        }),
      ),
    };
  },
};
