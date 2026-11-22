/** Small helpers the reviewed-write stages share. */
import {MirrorError} from './errors.js';
import {fail} from './family-kit.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/** A provider identifier: a non-empty string or a safe integer. */
/** A provider response body as an object ({} when it is not one). */
export const responseData = (result: {data?: unknown}): JsonObject => object(result.data);
export const hasProviderId = (v: unknown): boolean =>
  (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isSafeInteger(v));
export const object = (v: unknown): JsonObject =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {};
export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export {fail};
/**
 * Rollback switches and tuning for the execute-integrity changes (WRT-04), read at call time.
 * AMCP_WRITE_NOT_SENT_RELEASE=false records every refusal after the claim as uncertain again, as before;
 * AMCP_WRITE_TARGET_LOCK=false stops serializing executes of one target, and AMCP_WRITE_TARGET_WAIT_MS bounds how long
 * a second execute of a target waits for the first (default 10 s); AMCP_WRITE_GROUP_PART_SECONDS fixes the time each
 * group part is given (0 turns the time budget off, leaving the five-second expiry margin).
 */
export const releaseUnsentClaims = () => process.env.AMCP_WRITE_NOT_SENT_RELEASE !== 'false';
export const serializeTargets = () => process.env.AMCP_WRITE_TARGET_LOCK !== 'false';
const setting = (name: string, fallback: number, max: number) => {
  const raw = process.env[name],
    value = raw === undefined || raw === '' ? fallback : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= max ? value : fallback;
};
export const targetWaitMs = () => setting('AMCP_WRITE_TARGET_WAIT_MS', 10000, 60000);
/**
 * The seconds a group gives each part to execute: the configured value when set, otherwise twice the slowest part's
 * own preparation (which reads the same state execute reads again), and at least three seconds.
 */
export function groupPartSeconds(slowestPrepareMs = 0): number {
  const fixed = setting('AMCP_WRITE_GROUP_PART_SECONDS', -1, 120);
  if (fixed >= 0) return fixed;
  return Math.max(3, Math.ceil((2 * Math.max(0, slowestPrepareMs)) / 100) / 10);
}
/** The same refusal, marked as one that sent nothing: the review stays valid and may be executed again. */
export function notSent(e: unknown, reviewId: string): unknown {
  if (!(e instanceof MirrorError)) return e;
  // The copy keeps the template and slot values of a message that has them (G9), so its translation still applies.
  return new MirrorError(
    e.code,
    e.localization?.key ?? e.message,
    {...e.details, submission: 'not_sent', review_id: reviewId},
    e.status,
    e.retryable,
    e.localization?.values,
  );
}
/**
 * The same failure of a dispatched write, naming the read-only status call that follows its retained record (WRT-08):
 * the outcome is uncertain and the request is never sent again; status, then reconcile, read without writing.
 */
export function uncertainNext(e: unknown, reviewId: string): unknown {
  if (!(e instanceof MirrorError) || e.details.next_call !== undefined) return e;
  return new MirrorError(
    e.code,
    e.localization?.key ?? e.message,
    {
      ...e.details,
      review_id: reviewId,
      next_call: {tool: 'amcp_write', arguments: {action: 'status', review_id: reviewId}},
    },
    e.status,
    e.retryable,
    e.localization?.values,
  );
}
/**
 * The refusal of a review a campaign plan retired (r25-field3-errors, the third re-review P2 and C1; the mark is retireReview of
 * src/write-record-repository.ts): the plan went on from it (it amended the step, prepared it again, was cancelled or was continued as another plan), so it
 * is never executed, by anyone, whether or not the owner requires a distinct approver. Raised before anything is claimed or sent. It names the step in its
 * plan, which is where the plan's own review, if the step has one, is executed, under the plan's approvals and checks.
 */
export function retiredRefusal(retired: unknown, reviewId: string): never {
  const mark = object(retired),
    plan = typeof mark.plan_id === 'string' ? mark.plan_id : undefined,
    step = typeof mark.step_id === 'string' ? mark.step_id : undefined;
  return fail(
    'REVIEW_RETIRED',
    'This review was retired by its campaign plan, which went on from it (it amended the step, prepared the step again, was cancelled or was continued as another plan), so it is never executed. Nothing was submitted. Read the step in its plan (details.next_call): the plan’s own review is the one to execute, through the plan.',
    {
      review_id: reviewId,
      ...(plan ? {plan_id: plan} : {}),
      ...(step ? {step_id: step} : {}),
      ...(typeof mark.reason === 'string' ? {reason: mark.reason} : {}),
      ...(plan && step
        ? {next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: plan, step_id: step}}}
        : {}),
    },
    409,
  );
}
/**
 * Refuses a method override on a reviewed write: an HTTP method override, or a REST.li method other than those the
 * reviewed writes use (CREATE, PARTIAL_UPDATE, DELETE).
 */
export function assertNoMethodOverride(plan: CompiledRequest): void {
  if (
    plan.headers['X-HTTP-Method-Override'] ||
    (plan.headers['X-RestLi-Method'] &&
      !['CREATE', 'PARTIAL_UPDATE', 'DELETE'].includes(plan.headers['X-RestLi-Method'].toUpperCase()))
  )
    fail('WRITE_CONTRACT_UNAVAILABLE', 'This REST.li method override is not qualified for reviewed execution.');
}
/**
 * 404 is evidence of absence only for a derived optional target, never for its parent or permission failures. A
 * lifecycle rule for every family's AMCP_STATE_OPTIONAL reads (the measurement providers', DV360's, Tag Manager's and
 * Apple's), moved with ARC-01 wave 4c from src/measurement-writes.ts, which re-exports it, so the review imports no
 * provider module for it.
 */
export function optionalMissingState(read: CompiledRequest, e: unknown): TransportResult | undefined {
  if (
    read.action === 'AMCP_STATE_OPTIONAL' &&
    read.method === 'GET' &&
    e instanceof MirrorError &&
    e.code === 'UPSTREAM_ERROR' &&
    e.status === 404
  )
    return {data: {amcp_absent: true, path: read.path}, status: 404, headers: {}};
  return undefined;
}
