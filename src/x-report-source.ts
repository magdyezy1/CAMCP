import {MirrorError} from './errors.js';
import {optionalReadRefused} from './overview-parents.js';
import {invalidReportSource, nextDay, reportList, type ReportSource} from './report-source.js';
import type {JsonObject} from './types.js';
import {zonedMidnight} from './workflows.js';
import {xActiveEntities, xActiveEntitiesMode, xActiveSet} from './x-active-entities.js';
import {
  xCampaignObjectives,
  xCampaignReport,
  xObjectivesMixedWarning,
  xObjectivesUnavailableWarning,
} from './x-campaign-report.js';

/** X campaign rows as xCampaignReport (src/x-campaign-report.ts) prepares them: the metrics are already shared ones. */
export const xReportSource: ReportSource = {
  platform: 'x',
  nativeMetricExamples: ['VIDEO', 'WEB_CONVERSION', 'MOBILE_CONVERSION'],
  // X analytics rows carry metric groups in their own shape, so requested metrics are not checked against them.
  nativeMetricCheck: false,
  // The campaign inventory and the active entities; the analytics requests are planned from them at run time.
  minimumRequestsPerPeriod: 2,
  /**
   * The account's campaign inventory, the campaigns X reports as active (RPT-03), their line item objectives (RPT-07)
   * and the bounded analytics of those campaigns, each kept with the checkpoint so a resumed run asks X the same.
   */
  async collect(c) {
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
        if (!(e instanceof MirrorError) || e.retryable || ![400, 404, 422].includes(e.status)) throw e;
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
      c.extra,
      q => c.run(c.plan('/12/stats/accounts/' + c.account, q), false),
      {
        checkpoint: checkpoint.x_report,
        save: x_report => save({...state, x_report}),
        ...(active ? {active, windows: mode === 'on'} : {}),
      },
    );
    c.raw = report.rows.map(row => ({...row, objective: objectives!.campaigns?.[row.id] ?? row.objective}));
    c.complete = report.complete;
    c.collectionComplete = report.complete;
    c.context.no_activity_count = report.no_activity_count;
    c.warnings.push(...report.warnings);
  },
  normalize(raw) {
    return {id: raw.id, name: raw.name, objective: raw.objective, metrics: raw.metrics ?? {}};
  },
};
