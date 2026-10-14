/** Outcome stage: whether the provider's response to the one mutation shows that it took effect. */
import {gtmSafeConfiguration} from './gtm-workflow-writes.js';
import {type TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {microsoftGateway} from './microsoft-native.js';
import {familyOf} from './reviewed-families.js';
import {object} from './write-common.js';

export function writeOutcome(result: TransportResult, plan?: CompiledRequest, before: unknown[] = []): JsonObject {
  const errors: JsonObject[] = [];
  const walk = (value: unknown, path = '$') => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, path + '[' + i + ']'));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      // Microsoft batch errors can align with request items using null success
      // slots. This exception is exact and provider-specific; false/objects fail.
      if (
        plan?.gateway === microsoftGateway &&
        path === '$' &&
        (key === 'PartialErrors' || key === 'NestedPartialErrors') &&
        Array.isArray(v) &&
        v.every(item => item === null)
      )
        continue;
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
    data: plan?.gateway === 'gtm_native_action' ? gtmSafeConfiguration(result.data) : result.data,
    status: result.status,
    headers: result.headers,
    ...(result.headers['x-restli-id'] ? {created_id: result.headers['x-restli-id']} : {}),
    ...(errors.length
      ? {failures: plan?.gateway === 'gtm_native_action' ? gtmSafeConfiguration(errors) : errors, retry_safe: false}
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
  if (plan.gateway === 'meta_native_action')
    return /^\/v[^/]+\/act_/.test(plan.path) ? hasId(d.id) : d.success === true;
  if (plan.gateway === 'google_ads_native_action')
    return (
      Array.isArray(d.results) &&
      d.results.length === b.operations.length &&
      d.results.every((r: JsonObject, i: number) => {
        const op = b.operations[i],
          expected = op.remove ?? op.update?.resource_name ?? op.update?.resourceName;
        return (
          typeof r.resourceName === 'string' &&
          (expected
            ? r.resourceName === expected
            : r.resourceName.startsWith('customers/' + plan.accountId + '/' + last.replace(':mutate', '') + '/'))
        );
      })
    );
  if (plan.gateway === 'tiktok_native_action') {
    if (d.code !== 0) return false;
    if (!plan.path.endsWith('/create/')) return true;
    const kind = segments[2]!,
      data = object(d.data);
    if (kind === 'ad') {
      const ids = data.ad_ids ?? [data.ad_id];
      return Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string' && /^\d+$/.test(ids[0]);
    }
    return (
      hasId(data[kind + '_id']) ||
      (Array.isArray(data[kind + '_ids']) && data[kind + '_ids'].length > 0 && data[kind + '_ids'].every(hasId))
    );
  }
  if (plan.gateway === 'snapchat_native_action') {
    if (String(d.request_status).toUpperCase() !== 'SUCCESS') return false;
    const kind = [...segments]
        .reverse()
        .find(k => ['campaigns', 'adsquads', 'ads', 'creatives', 'lead_generation_forms', 'segments'].includes(k))!,
      rows = d[kind];
    if (plan.method === 'DELETE') return Array.isArray(rows) && rows.length === 0;
    const singular = kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1),
      expected = Array.isArray(b[kind]) ? b[kind].length : 1;
    return (
      Array.isArray(rows) &&
      rows.length === expected &&
      rows.every(
        (r, i) =>
          String(r.sub_request_status).toUpperCase() === 'SUCCESS' &&
          hasId(r[singular]?.id) &&
          (plan.method === 'POST' || String(r[singular].id) === String(plan.method === 'PUT' ? b[kind][i].id : last)),
      )
    );
  }
  if (plan.gateway === 'linkedin_native_action')
    return result.status === 201 ? hasId(result.headers['x-restli-id']) : result.status === 204;
  if (plan.gateway === 'x_ads_native_action')
    return Array.isArray(d.data)
      ? plan.method === 'POST' && d.data.length > 0 && d.data.every(r => hasId(r.id))
      : hasId(d.data?.id) && (plan.method === 'POST' || String(d.data.id) === last);
  if (plan.gateway === 'dv360_native_action') {
    if (plan.method === 'DELETE')
      return (result.status === 200 && result.data !== null && Object.keys(d).length === 0) || result.status === 204;
    const kind = plan.method === 'POST' ? last : segments.at(-2)!,
      key: Record<string, string> = {
        campaigns: 'campaignId',
        insertionOrders: 'insertionOrderId',
        lineItems: 'lineItemId',
        creatives: 'creativeId',
      };
    return hasId(d[key[kind]!]) && (plan.method === 'POST' || String(d[key[kind]!]) === last);
  }
  return false;
}
