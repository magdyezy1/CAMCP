import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';

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
  wire: Object.freeze({
    boundedReport: reportRead,
    deadline: (plan: CompiledRequest, url: URL) => (reportRead(plan, url) ? plan.adjustReportDeadline : undefined),
  }),
});
