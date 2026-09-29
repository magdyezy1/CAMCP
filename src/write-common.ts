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
