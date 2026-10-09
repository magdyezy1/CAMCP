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
 * Rollback switches for the execute-integrity changes (WRT-04), read at call time. AMCP_WRITE_NOT_SENT_RELEASE=false
 * records every refusal after the claim as uncertain again, as before; AMCP_WRITE_TARGET_LOCK=false stops serializing
 * executes of one target; AMCP_WRITE_GROUP_PART_SECONDS sets the time each group part is given (0 turns the time budget
 * off, leaving the five-second expiry margin).
 */
export const releaseUnsentClaims = () => process.env.AMCP_WRITE_NOT_SENT_RELEASE !== 'false';
export const serializeTargets = () => process.env.AMCP_WRITE_TARGET_LOCK !== 'false';
export function groupPartSeconds(): number {
  const raw = process.env.AMCP_WRITE_GROUP_PART_SECONDS;
  const value = raw === undefined || raw === '' ? 15 : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 120 ? value : 15;
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
