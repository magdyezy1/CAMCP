import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';
import {extendAdjustTool} from './adjust-extensions.js';
// Wave 4c round 6 (w4c-arc6-tables).
import {deepFrozen} from './frozen-facts.js';

const reportPaths = [
  '/reports-service/filters_data',
  '/reports-service/events',
  '/reports-service/report',
  '/reports-service/pivot_report',
];
/** One of AMCP's bounded Adjust report reads, on the Report Service of automate.adjust.com. */
const reportRead = (plan: CompiledRequest, url: URL) =>
  plan.action === 'AMCP_ADJUST_REPORT_READ' &&
  plan.adjustReportRead === true &&
  plan.readOnly &&
  plan.method === 'GET' &&
  url.origin === 'https://automate.adjust.com' &&
  reportPaths.includes(plan.path);

/**
 * Adjust's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). On the wire, AMCP's report reads are
 * bounded: they carry their own deadline, their bytes are checked whole and their numbers keep their source text.
 */
export const adjustHooks: ProviderHooks = Object.freeze({
  gateway: 'adjust_native_action',
  // Wave 4c (transport and catalog): its tool takes the reporting operations AMCP adds to the captured definition.
  catalog: Object.freeze({tools: Object.freeze({adjust_native_action: extendAdjustTool})}),
  wire: Object.freeze({
    boundedReport: reportRead,
    deadline: (plan: CompiledRequest, url: URL) => (reportRead(plan, url) ? plan.adjustReportDeadline : undefined),
  }),
  // Wave 4c round 6 (w4c-arc6-versions): what tools/list and amcp_tool_help say of its gateway (src/tool-notes.ts).
  notes: Object.freeze({
    description:
      'Adjust gateway: adjust_reporting (apps, events, filters, reports and pivots) and adjust_list_assets (the Adjust bindings configured in AMCP) run.',
  }),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables (src/provider-hooks.ts orders them). The captured
  // operations AMCP cannot run (src/unavailable-operations.ts), each offering the Adjust reads AMCP runs.
  unavailable: deepFrozen(
    (adjust => ({
      adjust_ad_spend: {reason: 'AMCP sends no ad spend to Adjust.', alternatives: adjust},
      adjust_app_automation: {reason: 'AMCP does not manage Adjust apps or app secrets.', alternatives: adjust},
      adjust_campaign_api: {reason: 'AMCP does not read or change Adjust trackers or partners.', alternatives: adjust},
      adjust_deeplinks: {reason: 'AMCP does not read or create Adjust deep links.', alternatives: adjust},
    }))([
      {
        tool: 'adjust_native_action',
        arguments: {operation: 'adjust_reporting'},
        meaning: 'Adjust apps, events, filters, reports and pivots: the Adjust reads AMCP runs.',
      },
      {
        tool: 'adjust_native_action',
        arguments: {operation: 'adjust_list_assets'},
        meaning: 'The Adjust connections and app bindings configured in AMCP.',
      },
    ]),
  ),
});
