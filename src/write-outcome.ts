/**
 * Outcome stage: whether the provider's response to the one mutation shows that it took effect. Each provider's response
 * contract is its adapter's (ARC-01 phase B, wave 4c: `writes.confirms`, `emptyErrors` and `outcomeData`, moved
 * verbatim from here); the stage keeps the generic error walk, the families' outcome first and the outcome's shape.
 */
import {type TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {familyOf} from './reviewed-families.js';
import {object} from './write-common.js';
import {providerHooks} from './provider-hooks.js';

export function writeOutcome(result: TransportResult, plan?: CompiledRequest, before: unknown[] = []): JsonObject {
  const errors: JsonObject[] = [],
    provider = providerHooks(plan?.gateway)?.writes;
  const walk = (value: unknown, path = '$') => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, path + '[' + i + ']'));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      // A provider's top-level error field that holds none under its contract (Microsoft's batch errors can align
      // with request items using null success slots). The exception is exact and provider-specific.
      if (path === '$' && provider?.emptyErrors?.(key, v) === true) continue;
      const nonempty =
        v !== null &&
        v !== false &&
        v !== '' &&
        v !== 0 &&
        (!Array.isArray(v) || v.length > 0) &&
        (!v || typeof v !== 'object' || Object.keys(v).length > 0);
      if (
        (nonempty && /error|fail/i.test(key)) ||
        (/^(?:is_)?success$/.test(key) && v === false) ||
        (/status$/i.test(key) &&
          ((typeof v === 'string' && /ERROR|FAIL|PARTIAL/i.test(v)) || (typeof v === 'number' && v >= 400)))
      )
        errors.push({path: path + '.' + key, value: v});
      else walk(v, path + '.' + key);
    }
  };
  walk(result.data);
  if (
    !plan &&
    result.status !== 204 &&
    result.status !== 205 &&
    !result.headers['x-restli-id'] &&
    (result.data === null || typeof result.data !== 'object' || !Object.keys(result.data).length)
  )
    errors.push({path: '$', value: 'Provider returned no verifiable mutation result.'});
  if (plan && !confirmedMutationResult(plan, result, before))
    errors.push({
      path: '$',
      value: 'The response does not confirm every mutation under this provider response contract.',
    });
  const outcome = {
    success: errors.length === 0,
    executed: true,
    outcome: errors.length ? 'partial_or_failed' : 'succeeded',
    // What the provider shows of the response (Tag Manager's safe configuration).
    data: provider?.outcomeData ? provider.outcomeData(result.data) : result.data,
    status: result.status,
    headers: result.headers,
    ...(result.headers['x-restli-id'] ? {created_id: result.headers['x-restli-id']} : {}),
    ...(errors.length
      ? {failures: provider?.outcomeData ? provider.outcomeData(errors) : errors, retry_safe: false}
      : {}),
    ...(plan ? (familyOf(plan)?.receipt?.(plan, result) ?? {}) : {}),
  };
  const safe = plan && familyOf(plan)?.safeOutcome;
  return safe ? safe(outcome, plan, result) : outcome;
}
function confirmedMutationResult(plan: CompiledRequest, result: TransportResult, before: unknown[]): boolean {
  const family = familyOf(plan);
  if (family?.outcome) return family.outcome(plan, result, before);
  const d = object(result.data),
    b = object(plan.body),
    segments = plan.path.split('/'),
    last = segments.at(-1)!,
    hasId = (v: unknown) =>
      (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isSafeInteger(v));
  // The provider's response contract (its adapter's `writes.confirms`); a provider without one confirms nothing.
  return (
    providerHooks(plan.gateway)?.writes?.confirms?.(plan, result, {data: d, body: b, segments, last, hasId}) ?? false
  );
}
