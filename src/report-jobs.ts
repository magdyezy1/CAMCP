import type {NativeReportJob} from './report-job.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {xReportJob} from './x-report-download.js';
import {tiktokReportJob} from './tiktok-report-jobs.js';
import {criteoReportJob} from './criteo-report-jobs.js';
import {metaReportJob} from './meta-insights-jobs.js';
import {microsoftReportJob} from './microsoft-report-download.js';

/**
 * The asynchronous report jobs (ARC-04 stage F): one per gateway whose report jobs the native read path serves. A
 * registry of provider facts, like the report source and provider adapter registries: the compiler and MirrorService
 * consult the job of a request's gateway instead of importing each provider's job module, so shared code names no
 * provider's report job (tools/architecture-map.mjs counts it with the provider modules).
 */
export const reportJobList: readonly NativeReportJob[] = Object.freeze([
  xReportJob,
  tiktokReportJob,
  criteoReportJob,
  metaReportJob,
  microsoftReportJob,
]);
const byGateway = new Map(reportJobList.map(job => [job.gateway, job]));

/** The report job of a request's gateway, or undefined for a gateway without one. */
export function reportJob(gateway: unknown): NativeReportJob | undefined {
  return typeof gateway === 'string' ? byGateway.get(gateway) : undefined;
}

/** A compiled request with its gateway's report-job controls (Compiler.compile), or the request unchanged. */
export function reportJobPlan(request: CompiledRequest, input: JsonObject): CompiledRequest {
  const plan = reportJob(request.gateway)?.plan;
  return plan ? plan(request, input) : request;
}
