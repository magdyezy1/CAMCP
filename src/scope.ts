import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {ReadAuthorizer} from './provider-adapter.js';
import {MirrorError} from './errors.js';
import {Registry} from './catalog.js';
import {Store} from './store.js';
import {stable} from './security.js';
import {reviewedFamilies, familyOf} from './reviewed-families.js';
import {assertNotPersonalDataRead} from './personal-data.js';
import {assertGatewayOffered} from './provider-offering.js';
import {normalizeAccount} from './account-id.js';
import {providerOf} from './provider-adapters.js';
import {providerHooks} from './provider-hooks.js';

// The account ID form lives in the leaf src/account-id.ts, from the provider adapters (ARC-04 stage B).
export {normalizeAccount};
// Snapchat's scoped resource paths live in its leaf (src/snapchat-scope.ts), which its scope hooks read too.
export {snapchatOrganizationPixels, snapchatScopedResource} from './snapchat-scope.js';
function mismatch(field: string): never {
  throw new MirrorError(
    'ACCOUNT_SCOPE_MISMATCH',
    'The final request targets a resource outside the selected account binding.',
    {field},
    403,
  );
}

/**
 * The account collection reads whose results establish ownership of a standalone resource (observe() below), as
 * ready-to-send calls: each provider's own (ARC-01 phase B, its adapter's scope hooks). Meta object IDs do not reveal
 * their type, so Meta gets one call per collection.
 */
export function ownershipReads(
  gateway: string,
  path: string,
  account: string,
  connectionId: string,
  template?: string,
): {tool: string; arguments: JsonObject}[] {
  const call = (action: string, extra: JsonObject = {}) => ({
    tool: gateway,
    arguments: {action, account_id: account, connection_id: connectionId, ...extra},
  });
  return providerHooks(gateway)?.scope?.ownershipReads?.(path, account, connectionId, template, call) ?? [];
}
/**
 * The read authorizer of the plan's provider that claims it (ARC-01 phase B): at most one, or the request is refused
 * like two reviewed families claiming one request. Claims are exclusive by design (tests/provider-read-authorizers.test.mjs
 * holds them disjoint over every catalogued route); a conflict is a wiring defect, so nothing is sent.
 */
export function claimingAuthorizer(
  plan: CompiledRequest,
  authorizers: readonly ReadAuthorizer[] = providerHooks(plan.gateway)?.scope?.authorizers ?? [],
): ReadAuthorizer | undefined {
  const claiming = authorizers.filter(a => a.claims(plan));
  if (claiming.length > 1)
    throw new MirrorError(
      'READ_AUTHORIZER_CONFLICT',
      'Two read authorizers claim this request (' + claiming.map(a => a.name).join(', ') + '); nothing was sent.',
      {authorizers: claiming.map(a => a.name)},
      500,
    );
  return claiming[0];
}
/** This guard runs on every final page, before token refresh or authenticated egress. */
export class ScopeGuard {
  constructor(
    private registry: Registry,
    private store: Store,
  ) {}
  authorize(plan: CompiledRequest, connection: Connection): string {
    // No request reaches a provider this deployment does not offer (a parked one, ARC-01 and P9): not a read, a review's
    // state read, an execute of an earlier review or a verification read, before credentials are fetched.
    assertGatewayOffered(plan.gateway);
    if (connection.gateway !== plan.gateway)
      throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Connection gateway does not match request.', {}, 403);
    // Submitted leads stay out of reach: no resource binding below may open them (SEC-04).
    assertNotPersonalDataRead(plan);
    // The provider's part of this guard (ARC-01 phase B, src/<provider>-adapter.ts): a public read, its scope checks,
    // its read authorizers and its resource scope. Everything else here, and the order, is this guard's.
    const scope = providerHooks(plan.gateway)?.scope;
    if (scope?.publicRead?.(plan)) return 'public_ad_library';
    const id = normalizeAccount(
      plan.gateway,
      plan.accountId ?? (connection.accounts.length === 1 ? connection.accounts[0] : ''),
    );
    if (!id || !connection.accounts.some(a => normalizeAccount(plan.gateway, a) === id))
      throw new MirrorError('ACCOUNT_REQUIRED', 'Select an explicitly bound account for this request.', {}, 403);
    let decoded: string;
    try {
      decoded = decodeURIComponent(plan.path);
    } catch {
      throw new MirrorError('INVALID_PATH', 'Malformed path encoding.');
    }
    const compare = (value: unknown, field: string) => {
      for (const item of Array.isArray(value) ? value : [value])
        if (normalizeAccount(plan.gateway, item) !== id) mismatch(field);
    };
    // Where this provider's requests name an account (ARC-01 phase B: its adapter's account model); every place it
    // names is compared here with the bound account.
    const model = providerOf(plan.gateway)?.account;
    const walk = (value: unknown, field = '$'): void => {
      // An account reference inside any string: Google's customers/{id} (customer-level RPCs use customers/{id}:method,
      // whose colon ends the ID as the slash does in customers/{id}/resources) and LinkedIn's sponsored account URNs.
      if (typeof value === 'string' && model?.references)
        for (const m of value.matchAll(model.references)) compare(m[1], field);
      if (Array.isArray(value)) {
        value.forEach(v => walk(v, field));
        return;
      }
      if (value && typeof value === 'object' && model?.patchFields && plan.method === 'PATCH') {
        const patch = value as JsonObject;
        if (typeof patch.path === 'string' && model.fields?.has(patch.path.split('/').at(-1)!)) {
          if (patch.op === 'remove' || patch.value === undefined) mismatch('account patch');
          compare(patch.value, 'account patch');
        }
      }
      if (value && typeof value === 'object')
        for (const [key, v] of Object.entries(value)) {
          if (/^(?:access_token|oauth_token|refresh_token|client_secret|developer_token|authorization)$/i.test(key))
            throw new MirrorError(
              'CREDENTIAL_PARAMETER_FORBIDDEN',
              'Credentials must come from the encrypted connection provider.',
              {field: key},
              403,
            );
          if (model?.fields?.has(key)) {
            let candidate = v;
            if (typeof v === 'string' && v.startsWith('[')) {
              try {
                candidate = JSON.parse(v);
              } catch {
                mismatch(key);
              }
            }
            compare(candidate, key);
          }
          walk(v, field + '.' + key);
        }
    };
    walk(plan.query);
    walk(plan.body);
    walk(decoded, 'path');
    // The provider's own scope checks (Google's generation scope, Meta's label scope) refuse before any authorizer.
    scope?.assert?.(plan, connection);
    // Exactly one read authorizer may claim a request; it runs where the chain ran it, before or after the reviewed
    // families' own authorizers, and false leaves the request to the checks below.
    const authorizer = claimingAuthorizer(plan);
    if (authorizer?.stage === 'before_families' && authorizer.authorize(plan, connection, id, this.store)) return id;
    for (const family of reviewedFamilies()) if (family.authorize?.(plan, connection, id, this.store)) return id;
    if (authorizer?.stage === 'after_families' && authorizer.authorize(plan, connection, id, this.store)) return id;
    // A path that names the bound account, where the provider's account model says paths name it.
    const match = model?.path?.exec(decoded);
    if (match) {
      compare(match[1], 'path');
      return id;
    }
    // The provider's own resource scope: a site, location or account filter its requests name, a vendor-declared
    // account parameter, a mandatory account header, or ownership established from an account-scoped list.
    if (
      scope?.resource?.(plan, connection, id, {decoded, compare, mismatch, store: this.store, registry: this.registry})
    )
      return id;
    // Administrative provisioning can declare otherwise unscoped Business/Profile resources.
    for (const binding of connection.resourceBindings ?? []) {
      if (normalizeAccount(plan.gateway, binding.accountId) !== id) continue;
      if (
        (decoded === binding.pathPrefix ||
          decoded.startsWith(binding.pathPrefix + '/') ||
          decoded.startsWith(binding.pathPrefix + ':')) &&
        Object.entries(binding.query ?? {}).every(([k, v]) => stable(plan.query[k]) === stable(v))
      )
        return id;
    }
    const reads = ownershipReads(
      plan.gateway,
      decoded,
      id,
      connection.id,
      this.registry.action(plan.gateway, plan.action)?.path ?? undefined,
    );
    throw new MirrorError(
      'RESOURCE_SCOPE_REQUIRED',
      'Resource ownership is not established. ' +
        (reads.length
          ? 'List it through ' +
            (reads.length === 1 ? 'its account collection' : 'the account collection of its type') +
            ' with this connection (details.ownership_reads); the IDs that read returns are usable for five minutes. Page through the collection if the ID is not on the first page.'
          : 'Read its account-scoped collection first, or have an administrator provision an exact resource binding.'),
      {
        gateway: plan.gateway,
        path: plan.path,
        account_id: id,
        ...(reads.length ? {ownership_reads: reads, ...(reads.length === 1 ? {next_call: reads[0]} : {})} : {}),
      },
      403,
    );
  }
  observe(plan: CompiledRequest, connection: Connection, data: unknown): void {
    if (!plan.readOnly) return;
    const id = this.authorize(plan, connection);
    for (const family of reviewedFamilies()) family.observe?.(plan, connection, id, data, this.store);
    // Only named entity collections are ownership evidence, as each provider defines them (its scope hooks); never
    // learn from arbitrary nested IDs, reports, user supplied state, search results or unscoped account lists.
    providerHooks(plan.gateway)?.scope?.observe?.(plan, connection, id, data, this.store);
  }
  /** Called only after a verified successful mutation, never on caller-supplied data. */
  observeCreated(plan: CompiledRequest, connection: Connection, data: unknown): void {
    if (plan.readOnly || plan.method !== 'POST') return;
    const id = normalizeAccount(plan.gateway, plan.accountId),
      d = data as JsonObject;
    for (const created of familyOf(plan)?.created?.(plan, d) ?? [])
      this.store.rememberResource(connection, id, created);
    // Other qualified gateways carry the account in every child path/body. Those that use global IDs need this extra,
    // connection-bound observation (their scope hooks).
    providerHooks(plan.gateway)?.scope?.observeCreated?.(plan, connection, id, d, this.store);
  }
}
