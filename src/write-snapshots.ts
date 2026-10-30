/** Snapshot plan stage: the reads that record the state a reviewed write depends on. */
import {Registry} from './catalog.js';
import {applyExecutionRisk} from './execution-risk.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {familyOf} from './reviewed-families.js';
import {fail} from './write-common.js';
// Each provider's state reads (ARC-01 phase B, wave 4c): its adapter's `writes` snapshot hooks and the versioning
// headers its reads keep, asked where this stage named the provider; the stage imports no provider module.
import {providerHooks} from './provider-hooks.js';

/** A state read of the account or resources a reviewed write depends on, made by the write's own connection. */
/**
 * A read-only request of `path` for the plan's account and connection, as every state read is built. It keeps the
 * write's headers its provider's reads keep (LinkedIn's versioning headers, `review.verificationHeaders`), none else.
 */
export const stateRead = (
  plan: CompiledRequest,
  path: string,
  query: JsonObject = {},
  body?: JsonObject,
  method = 'GET',
): CompiledRequest =>
  applyExecutionRisk({
    ...plan,
    action: 'AMCP_STATE_READ',
    method,
    path,
    query,
    body,
    headers: stateHeaders(plan),
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
  });
function stateHeaders(plan: CompiledRequest): Record<string, string> {
  const keep = providerHooks(plan.gateway)?.review?.verificationHeaders;
  return keep ? keep(plan) : {};
}

/** Reads are explicitly derived from the target, never supplied by the caller as proof. */
export function snapshotPlans(plan: CompiledRequest, registry: Registry): CompiledRequest[] {
  const base = (path: string, query: JsonObject = {}, body?: JsonObject, method = 'GET'): CompiledRequest =>
    stateRead(plan, path, query, body, method);
  const family = familyOf(plan);
  if (family?.snapshots) return family.snapshots(plan, base, applyExecutionRisk);
  // The provider's own state reads, where this stage named it (X's targeting criteria, Google Ads' mutations, TikTok's
  // campaign writes, Meta's account-edge creations and node edits, Snapchat's updates and patches).
  const writes = providerHooks(plan.gateway)?.writes,
    own = writes?.snapshots?.(plan, base);
  if (own) return own;
  const catalog = registry.catalogs.get(plan.gateway);
  const samePath = [
    ...(catalog?.actions ?? []),
    ...registry.data.supplemental.filter(a => a.gateway === plan.gateway),
  ].some(
    a =>
      a.method === 'GET' &&
      a.path &&
      new RegExp(
        '^' +
          a.path
            .split('?')[0]!
            .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
            .replace(/\{[^}]+\}/g, '[^/]+') +
          '$',
      ).test(plan.path),
  );
  // The account a path names (Snapchat's, X's, LinkedIn's and DV360's account paths).
  const account = writes?.accountPath?.exec(plan.path)?.[0];
  // A provider's own reads of a create by its account (Snapchat's: outside an account, and its owned dependencies).
  const accountReads = writes?.accountSnapshots?.(plan, base, account);
  if (accountReads) return accountReads;
  // On collection creates, snapshot the account. On edits/deletes, the catalog must expose a matching GET.
  if (plan.method === 'POST' && account && plan.path.slice(account.length).split('/').filter(Boolean).length === 1)
    return [base(account)];
  if (samePath && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(plan.method)) return [base(plan.path)];
  fail(
    'WRITE_CONTRACT_UNAVAILABLE',
    'This operation lacks an implemented target-state read. It remains available as a local dry run.',
  );
}
