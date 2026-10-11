/** Small helpers the reviewed-write stages share. */
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/** A provider identifier: a non-empty string or a safe integer. */
/** A provider response body as an object ({} when it is not one). */
export const responseData = (result: {data?: unknown}): JsonObject => object(result.data);
export const hasProviderId = (v: unknown): boolean =>
  (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isSafeInteger(v));
export const object = (v: unknown): JsonObject =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {};
export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export function fail(code: string, message: string, details: JsonObject = {}): never {
  throw new MirrorError(code, message, details);
}
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
  return new MirrorError(
    e.code,
    e.message,
    {...e.details, submission: 'not_sent', review_id: reviewId},
    e.status,
    e.retryable,
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
    e.message,
    {
      ...e.details,
      review_id: reviewId,
      next_call: {tool: 'amcp_write', arguments: {action: 'status', review_id: reviewId}},
    },
    e.status,
    e.retryable,
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
