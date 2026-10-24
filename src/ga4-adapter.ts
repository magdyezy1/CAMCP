import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {assertMeasurementWrite, validateMeasurementState} from './measurement-writes.js';
// Writes and campaigns (wave 4c).
import {assertMeasurementScopes} from './measurement-writes.js';

const withoutJobError = (value: JsonObject) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'errorMessage'));
/**
 * A failed GA4 export is a readable job resource, not a failed HTTP read: its native errorMessage is preserved for
 * verification and set aside for the success check, while API error envelopes, malformed errors and incomplete
 * responses are still rejected.
 */
function ga4JobEnvelope(read: CompiledRequest, result: TransportResult, data: JsonObject): TransportResult {
  const ga4Job = /^\/v1(?:alpha|beta)\/properties\/\d+\/(?:audienceExports|reportTasks)\/[^/]+$/.test(read.path);
  let jobData = data;
  if (ga4Job && data.state === 'FAILED' && typeof data.errorMessage === 'string') jobData = withoutJobError(jobData);
  if (ga4Job && data.reportMetadata?.state === 'FAILED' && typeof data.reportMetadata.errorMessage === 'string')
    jobData = {...jobData, reportMetadata: withoutJobError(data.reportMetadata)};
  return jobData !== data ? {...result, data: jobData} : result;
}

/**
 * Google Analytics 4's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * report RPCs and the audience export and report task queries are POST reads. Its writes follow the measurement
 * resource contract (src/measurement-writes.ts); a resource's 404 is its documented absence, a failed job is a readable
 * state, and the resource checks every state read's target.
 */
export const ga4Hooks: ProviderHooks = Object.freeze({
  gateway: 'ga4_native_action',
  checks: Object.freeze({
    routeWrite: assertMeasurementWrite,
    state: Object.freeze({
      settled(read: CompiledRequest, result: TransportResult) {
        if (result.status !== 404) return false;
        validateMeasurementState(read, result);
        return true;
      },
      envelope: ga4JobEnvelope,
      ownTarget: true as const,
      target: (read: CompiledRequest, result: TransportResult) => validateMeasurementState(read, result),
    }),
  }),
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
  // Writes and campaigns (wave 4c): a review's write needs the Analytics edit permission (src/write-review.ts).
  writes: Object.freeze({writePermission: assertMeasurementScopes}),
});
