/** Verification plan: the reads that show a write took effect, what each must contain, and how read-backs compare. */
import {Registry} from './catalog.js';
import {normalizeReviewState} from './review-state-core.js';
import {snapshotPlans} from './write-snapshots.js';
import {applyExecutionRisk} from './execution-risk.js';
import {fingerprint, obj} from './workspace-core.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {familyOf, familyOfRead} from './reviewed-families.js';
import {providerHooks} from './provider-hooks.js';

export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/**
 * Retire older value-bidding cache proofs without changing their original accepted mutation or receipt. The version is
 * the plan's provider's (`review.verificationVersion`, ARC-01 phase B: Google's value-bidding campaigns).
 */
export function googleValueVerificationVersion(plan: CompiledRequest): string | undefined {
  return providerHooks(plan.gateway)?.review?.verificationVersion?.(plan);
}
/** Retire a family's old partial proof in pending dependency chains, preserving the accepted receipt/key. */
export function verificationContractVersion(plan: CompiledRequest): string | undefined {
  return familyOf(plan)?.verificationCacheVersion ?? googleValueVerificationVersion(plan);
}
export const normalize = (v: any): any =>
  Array.isArray(v)
    ? normalizeReviewState(v.map(normalize))
    : obj(v)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), normalize(x)]))
      : v;
export function differing(expected: any, actual: any, path = '', out: string[] = []): string[] {
  if (obj(expected)) {
    for (const [key, value] of Object.entries(expected)) differing(value, actual?.[key], path + '/' + key, out);
  } else if (
    ((typeof expected === 'number' && typeof actual === 'string') ||
      (typeof expected === 'string' && typeof actual === 'number')) &&
    String(expected) === String(actual)
  )
    return out;
  else if (fingerprint(expected) !== fingerprint(actual ?? null)) out.push(path);
  return out;
}
export type Acknowledged = Record<string, {sent: unknown; echoed: unknown}>;
export function verificationReads(
  plan: CompiledRequest,
  result: JsonObject,
  registry: Registry,
  before: unknown[] = [],
): {
  read: CompiledRequest;
  expected: JsonObject;
  id: string;
  acknowledged?: Acknowledged;
  unobservable?: string[];
  /** Sent fields the read may omit: when it does, they are compared with the write response instead (inconclusive
   * when that has no echo), never passed silently and never failed for the omission alone. */
  readOptional?: string[];
  /** What the read shows beyond the expected fields, reported in the check and never compared. */
  observe?: (actual: unknown) => JsonObject | undefined;
}[] {
  // The provider's part of this plan (ARC-01 phase B, its adapter's `review`): the headers a verification read keeps
  // and the reads of a write no family verifies.
  const review = providerHooks(plan.gateway)?.review;
  const base = (path: string, query: JsonObject = {}): CompiledRequest => ({
    ...plan,
    path,
    method: 'GET',
    query,
    body: undefined,
    headers: review?.verificationHeaders ? review.verificationHeaders(plan) : {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    action: 'AMCP_VERIFY_READ',
  });
  const family = familyOf(plan);
  if (family?.verification) return family.verification(plan, result, before, base, applyExecutionRisk);
  if (plan.method === 'DELETE') return [];
  // A provider without verification reads of its own has none: its writes stay unverified rather than passed.
  return review?.verification?.(plan, result, base, request => snapshotPlans(request, registry)) ?? [];
}
export function entity(plan: CompiledRequest, data: JsonObject): JsonObject {
  const family = familyOfRead(plan);
  return family?.observed
    ? family.observed(plan, data, () => gatewayObserved(plan, data))
    : gatewayObserved(plan, data);
}
/**
 * What a verification read shows of its resource when no family projects it: the gateway's record, unwrapped by its
 * provider's adapter (`review.observed`); an absent resource, and a read of a provider without one, as they are.
 */
function gatewayObserved(plan: CompiledRequest, data: JsonObject): JsonObject {
  if (data.amcp_absent === true) return data;
  const observed = providerHooks(plan.gateway)?.review?.observed;
  return observed ? observed(plan, data) : data;
}
