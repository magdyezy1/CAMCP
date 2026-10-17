import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Google Analytics 4's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * report RPCs and the audience export and report task queries are POST reads.
 */
export const ga4Hooks: ProviderHooks = Object.freeze({
  gateway: 'ga4_native_action',
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) =>
      /\/properties\/[^/:]+:(?:runReport|batchRunReports|runPivotReport|batchRunPivotReports|runRealtimeReport|checkCompatibility|runFunnelReport)$/.test(
        pathname,
      ) ||
      /^\/v1beta\/properties\/[^/:]+\/audienceExports\/[^/:]+:query$/.test(pathname) ||
      /^\/v1alpha\/properties\/[^/:]+\/reportTasks\/[^/:]+:query$/.test(pathname),
  }),
  // Readiness reads the selected property on the Admin API (CON-03).
  accountRead: Object.freeze({
    readiness: (id: string, read: (path: string, origin: string) => CompiledRequest) =>
      read('/v1beta/properties/' + id, 'https://analyticsadmin.googleapis.com'),
    names: (id: string, data: JsonObject) => data.name === 'properties/' + id,
  }),
  // A measurement asset sync read carries the sync's deadline.
  wire: Object.freeze({
    deadline: (plan: CompiledRequest) =>
      plan.action === 'AMCP_MEASUREMENT_ASSET_SYNC' && plan.readOnly && plan.method === 'GET'
        ? plan.measurementSyncDeadline
        : undefined,
  }),
});
