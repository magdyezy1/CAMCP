import type {CompiledRequest} from './types.js';
import type {BodyDeletions} from './provider-adapter.js';
import {providerAdapters, providerOf} from './provider-adapters.js';
import {providerHooks} from './provider-hooks.js';
import {qualifiedProviderRead} from './provider-read-contracts.js';
import {familyOf} from './reviewed-families.js';
import {personalDataRead} from './personal-data.js';

/**
 * Whether a compiled request is a read by its own shape, not by the catalog's read-only flag (ARC-01 phase B: each
 * provider's documented exceptions are its adapter's read classification, src/<provider>-adapter.ts). Read-only
 * metadata is a compatibility observation, never sufficient execution authorization: the generic rules below refuse
 * mutation words in the path, method overrides and batches, and a POST is a read only where its provider's adapter
 * documents it.
 */
export function independentlyReadOnly(plan: CompiledRequest): boolean {
  // A read of submitted leads is personal data, never a qualified native read (SEC-04).
  if (personalDataRead(plan)) return false;
  const reads = providerHooks(plan.gateway)?.reads;
  // A route the catalog marks as a write is a read only when its provider documents it as a planning or preview read.
  if (!plan.readOnly && !reads?.plannedRead?.(plan)) return false;
  if (reads?.readOnly) return reads.readOnly(plan);
  let pathname: string;
  try {
    pathname = decodeURIComponent(plan.path);
  } catch {
    return false;
  }
  pathname = reads?.classifiedPath?.(plan) ?? pathname;
  if (/[?#\r\n\\]/.test(pathname)) return false;
  const tokens = pathname
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[\/_:.-]+/);
  if (
    !qualifiedProviderRead(plan) &&
    !reads?.wordExempt?.(plan) &&
    tokens.some(t =>
      [
        'update',
        'delete',
        'remove',
        'mutate',
        'activate',
        'deactivate',
        'publish',
        'unpublish',
        'revoke',
        'authorize',
        'authorization',
        'verify',
        'create',
        'insert',
        'patch',
        'set',
        'upload',
        'submit',
        'send',
      ].includes(t),
    )
  )
    return false;
  const queryAndBody = [plan.query, plan.body];
  for (const bag of queryAndBody)
    if (bag && typeof bag === 'object' && !Array.isArray(bag))
      for (const [key, v] of Object.entries(bag)) {
        if (
          ['method', '_method', 'http_method', 'method_override'].includes(key.toLowerCase()) &&
          !['GET', 'HEAD'].includes(String(v).toUpperCase())
        )
          return false;
        if (reads?.batch?.(key.toLowerCase())) return false;
      }
  let override: string | undefined;
  for (const [key, value] of Object.entries(plan.headers)) {
    if (key.toLowerCase() === 'x-http-method-override') {
      const method = value.toUpperCase();
      if (!['GET', 'HEAD'].includes(method) || (override !== undefined && override !== method)) return false;
      override = method;
    }
    if (
      key.toLowerCase() === 'x-restli-method' &&
      !['GET', 'BATCH_GET', 'FINDER', 'GET_ALL'].includes(value.toUpperCase())
    )
      return false;
  }
  const method = override ?? plan.method;
  if (['GET', 'HEAD'].includes(method)) return true;
  if (method !== 'POST') return false;
  return reads?.postRead?.(plan, pathname) ?? false;
}
/**
 * Deletions a provider takes as a body value on a route that is not a DELETE (WRT-02), by gateway: each provider's
 * adapter declares them (`deletions`, src/provider-adapters.ts). The catalog marks these routes non-destructive, so
 * without this table the owner's allow_deletion:false let them through. Each gateway maps a field (snake_case) to the
 * values that delete or remove; they match anywhere in the body, JSON Patch operations and REST.li `$set` patches
 * included. tests/deletion-policy-coverage.test.mjs holds every deletion value of the pinned provider documents against
 * this table, so a newly pinned value fails until it is classified or exempted there.
 */
export const bodyDeletionValues: Readonly<Record<string, BodyDeletions>> = Object.freeze(
  Object.fromEntries(providerAdapters.flatMap(a => (a.deletions ? [[a.gateway, a.deletions]] : []))),
);
const riskField = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/**
 * Where the body of a write deletes something by value: a value of `bodyDeletionValues`, or a `remove` operation by
 * resource name where the provider declares one (`{remove: 'customers/…'}`, nested under any operation wrapper).
 * Undefined when it does not.
 */
export function bodyDeletion(plan: CompiledRequest): string | undefined {
  const deletions = providerOf(plan.gateway)?.deletions;
  if (!deletions) return;
  const rule = deletions.fields,
    removePrefix = deletions.removePrefix;
  const deletes = (field: string, value: unknown) =>
    typeof value === 'string' && !!rule?.[riskField(field)]?.includes(value);
  const walk = (v: unknown, path: string, depth: number): string | undefined => {
    // A body nested deeper than this cannot be inspected; deny it the benefit of the doubt.
    if (depth > 64) return path || '/';
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) {
        const hit = walk(x, path + '/' + i, depth + 1);
        if (hit) return hit;
      }
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.path === 'string' && Object.hasOwn(o, 'value') && deletes(o.path.split('/').at(-1) ?? '', o.value))
      return path + '/value';
    for (const [k, x] of Object.entries(o)) {
      if (deletes(k, x)) return path + '/' + k;
      if (removePrefix !== undefined && k === 'remove' && typeof x === 'string' && x.startsWith(removePrefix))
        return path + '/' + k;
      const hit = walk(x, path + '/' + k, depth + 1);
      if (hit) return hit;
    }
  };
  return walk(plan.body, '/body', 0);
}
/**
 * `before`, the reviewed state when the caller has it, lets a family decide a deletion that depends on the current
 * state (a feed whose deletion rule is already on): the owner policy passes it at prepare and execute.
 */
export function applyExecutionRisk(plan: CompiledRequest, before?: unknown): CompiledRequest {
  const readOnly = independentlyReadOnly(plan);
  // An RPC that stays POST for remove operations (Google Ads :mutate): catalog method and risk flags cannot decide
  // whether the frozen operation deletes an association or entity.
  const rpcRemoval =
    providerOf(plan.gateway)?.deletions?.mutateRemovals === true &&
    plan.method === 'POST' &&
    plan.path.endsWith(':mutate') &&
    [
      ...(Array.isArray((plan.body as any)?.operations) ? (plan.body as any).operations : []),
      (plan.body as any)?.operation,
    ].some((op: any) => op && typeof op.remove === 'string');
  const family = familyOf(plan);
  const warnings = [
    ...plan.warnings,
    ...(family?.warnings?.(plan) ?? []),
    ...(plan.readOnly && !readOnly
      ? [
          'Catalog read-only metadata is not sufficient for this route; execution is treated as a mutation or an unqualified operation.',
        ]
      : []),
  ];
  return {
    ...plan,
    readOnly,
    // The family hook runs first, as it always has: some hooks read the operations and refuse a malformed request with
    // their own precise message before any later check.
    destructive:
      plan.destructive ||
      family?.destructive?.(plan, before) === true ||
      rpcRemoval ||
      (!readOnly && bodyDeletion(plan) !== undefined),
    requiresConfirmation: plan.requiresConfirmation || !readOnly,
    warnings: [...new Set(warnings)],
  };
}
