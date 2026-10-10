import {MirrorError} from './errors.js';
import {fingerprint, optional} from './workspace-core.js';
import {missingScopes, providerGrant, requirementScopes} from './provider-grants.js';
import type {Store} from './store.js';
import type {Actor, Connection, JsonObject} from './types.js';

/**
 * Truthful account readiness (CON-03).
 *
 * A readiness check stores only actor-independent facts: which connection binding was read, whether the exact account
 * read succeeded, what the provider reported about the account and when. The viewer's role, the deployment write
 * setting, the owner's write pause, account write grants and recorded permissions are evaluated for each viewer when
 * the badge is shown, so one member's check never changes another member's view. Evidence older than
 * `readinessLifetimeMs` reads as stale. "Reconnect" or "reauthorize" advice appears only after a provider
 * authentication failure.
 */
export const readinessLifetimeMs = 15 * 60000;
export const readinessBinding = (connection: Connection) => fingerprint(connection);
export const readinessId = (connectionId: string, accountId: string) => fingerprint([connectionId, accountId]);

export type CheckStatus = 'passed' | 'blocked' | 'unknown';
export interface ReadinessCheck extends JsonObject {
  key: string;
  status: CheckStatus;
  message: string;
}
export const check = (
  key: string,
  pass: boolean | null,
  message: string,
  next?: string,
  extra: JsonObject = {},
): ReadinessCheck => ({
  key,
  status: pass === null ? 'unknown' : pass ? 'passed' : 'blocked',
  message,
  // A next step is advice for something not yet passed; a passed check carries none.
  ...(next && pass !== true ? {next_step: next} : {}),
  ...extra,
});

/** Whether readiness has an exact account read for this gateway; Sheets, Drive and resource-specific providers do not. */
export const readinessContract = (gateway: string) => providerGrant(gateway)?.accountReadContract === true;
export const notApplicableCheck = () =>
  check(
    'provider_read',
    null,
    'This connection has no account readiness read: it is a report destination, a media source or a provider with resource-specific checks.',
    undefined,
    {reason: 'not_applicable'},
  );

/** What AMCP recorded about the permissions the provider granted (website_connection.grants). */
export function recordedGrants(store: Store, c: Connection): JsonObject | undefined {
  const saved = optional(store, c.tenantId, 'website_connection', c.id)?.grants;
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as JsonObject) : undefined;
}

/**
 * The recorded-permission check for reads or reviewed writes. Meta's grants are known only after AMCP read
 * `/me/permissions`; until then the check is unknown, never passed. X records only the access type AMCP requested.
 */
export function recordedScopeCheck(store: Store, c: Connection, kind: 'read' | 'write'): ReadinessCheck {
  const grant = providerGrant(c.gateway),
    requirement = grant?.[kind] ?? null,
    grants = recordedGrants(store, c);
  if (!requirement) {
    if (kind === 'write' && grant?.grantSource === 'requested_access_type' && grants?.requested_access_type === 'read')
      return check(
        'provider_scopes',
        false,
        'This login was authorized for read access only.',
        'Reauthorize this login from Connections and allow write access.',
        {required_scopes: [], missing_scopes: ['write_access'], known: true},
      );
    return check(
      'provider_scopes',
      null,
      'This provider does not report its OAuth permissions to AMCP; its own check at execution decides.',
      undefined,
      {required_scopes: [], missing_scopes: [], known: false},
    );
  }
  const required = requirementScopes(requirement),
    missing = missingScopes(requirement, c.scopes),
    declined = Array.isArray(grants?.declined) ? missing.filter(s => (grants.declined as string[]).includes(s)) : [];
  // A scope never recorded is missing; a recorded Meta scope is granted only once Meta's permissions were read.
  if (!missing.length && grant?.grantSource === 'permissions_endpoint' && grants?.known !== true)
    return check(
      'provider_scopes',
      null,
      'The provider has not confirmed which permissions this login granted.',
      'Sync this login in Connections to read its current permissions.',
      {required_scopes: required, missing_scopes: [], known: false},
    );
  return check(
    'provider_scopes',
    missing.length === 0,
    missing.length ? 'A required permission is not recorded on this login.' : 'Required recorded OAuth permissions.',
    'Reauthorize this login from Connections and allow the missing permissions.',
    {
      required_scopes: required,
      missing_scopes: missing,
      ...(declined.length ? {declined_scopes: declined} : {}),
      known: true,
    },
  );
}

const authFailures = new Set([
  'REAUTHORIZATION_REQUIRED',
  'TOKEN_REFRESH_FAILED',
  'AUTH_EXPIRED',
  'CREDENTIALS_REQUIRED',
]);
/** Failures caused by the caller's own access, which are never stored as shared account evidence. */
const callerFailures = new Set([
  'FORBIDDEN',
  'ACCOUNT_FORBIDDEN',
  'ACCOUNT_REQUIRED',
  'ACCOUNT_SCOPE_MISMATCH',
  'AMBIGUOUS_CONNECTION',
  'CONNECTION_REQUIRED',
  'CONNECTION_CHANGED',
  'CONNECTION_AUTHORITY_CHANGED',
  'SIGN_IN_REQUIRED',
  'MEMBERSHIP_REQUIRED',
  'RATE_LIMITED',
]);
/** A failed account read, with advice that matches its cause. */
export function providerReadFailure(e: unknown): {check: ReadinessCheck; shared: boolean} {
  const code = e instanceof MirrorError ? e.code : 'PROVIDER_READ_FAILED',
    message = e instanceof MirrorError ? e.message : 'Provider account read failed.',
    extra = {code},
    // The provider-error layer (PRV-01) names who must act when the code alone does not.
    layer = e instanceof MirrorError ? e.details.layer : undefined;
  if (code === 'READINESS_CONTRACT_UNAVAILABLE') return {check: notApplicableCheck(), shared: false};
  if (authFailures.has(code) || layer === 'credential')
    return {
      check: check(
        'provider_read',
        false,
        message,
        'The provider no longer accepts this login. Reauthorize it from Connections; this keeps its selections and saved reports.',
        extra,
      ),
      shared: true,
    };
  // A permission the provider names (PROVIDER_PERMISSION_MISSING, PRV-01) is a missing grant like a missing scope.
  if (code === 'INSUFFICIENT_SCOPE' || code === 'PROVIDER_PERMISSION_MISSING' || layer === 'consent')
    return {
      check: check(
        'provider_read',
        false,
        message,
        'Reauthorize this login from Connections and allow the missing permission.',
        extra,
      ),
      shared: true,
    };
  if (code === 'PROVIDER_ACCESS_DENIED')
    return {
      check: check(
        'provider_read',
        false,
        message,
        'The provider denied this login access to the account. Ask an account administrator to grant it, then check again.',
        extra,
      ),
      shared: true,
    };
  // A provider throttle is temporary and says nothing lasting about the account, so it is never shared.
  if ((e instanceof MirrorError && e.retryable) || code === 'PLATFORM_RATE_LIMIT' || layer === 'rate_limit')
    return {
      check: check(
        'provider_read',
        null,
        message,
        'The provider did not answer this time. Check again shortly.',
        extra,
      ),
      shared: false,
    };
  return {
    check: check(
      'provider_read',
      false,
      message,
      'Inspect the provider diagnostic and check the account again.',
      extra,
    ),
    shared: !callerFailures.has(code),
  };
}

/** The shared evidence of one exact account read. Nothing in it depends on who asked. */
export function sharedEvidence(
  c: Connection,
  accountId: string,
  read: ReadinessCheck,
  account: JsonObject | undefined,
): JsonObject {
  return {
    schema: 2,
    connection_id: c.id,
    account_id: accountId,
    connection_fingerprint: readinessBinding(c),
    checked_at: Date.now(),
    live_read: read.status === 'passed',
    provider_read: read,
    ...(account ? {account} : {}),
    coverage: 'Exact account read only. Role, write grants and permissions are evaluated for each viewer.',
  };
}

/** The account-read check from stored evidence, as of `now`. */
export function evidenceReadCheck(
  evidence: JsonObject | undefined,
  c: Connection,
  now = Date.now(),
): {check: ReadinessCheck; stale: boolean; valid: boolean} {
  const valid =
    !!evidence &&
    evidence.connection_fingerprint === readinessBinding(c) &&
    Number.isSafeInteger(evidence.checked_at) &&
    evidence.checked_at <= now;
  if (!valid) return {check: check('provider_read', null, 'No current account read.'), stale: false, valid};
  const stale = now - evidence!.checked_at > readinessLifetimeMs;
  if (stale)
    return {
      check: check(
        'provider_read',
        null,
        'The last account read is older than 15 minutes.',
        'Check the account again for current evidence.',
        {reason: 'stale'},
      ),
      stale,
      valid,
    };
  // Documents written before readiness kept shared facts only store the read among caller-specific checks.
  const stored =
    evidence!.provider_read ?? (evidence!.checks as JsonObject[] | undefined)?.find(x => x.key === 'provider_read');
  return {
    check: stored
      ? (stored as ReadinessCheck)
      : check(
          'provider_read',
          evidence!.live_read === true ? true : null,
          'Provider confirmed the exact selected account.',
        ),
    stale,
    valid,
  };
}

/**
 * Readiness of one selected account for this viewer, from shared evidence (Home dashboard). `write` asks for the
 * reviewed-write prerequisites, which are evaluated for this viewer only.
 */
export function readinessView(
  store: Store,
  actor: Actor,
  c: Connection,
  accountId: string,
  options: {allowWrites: boolean; paused: boolean; write: boolean; now?: number},
): JsonObject {
  const now = options.now ?? Date.now(),
    contract = readinessContract(c.gateway),
    evidence = contract ? optional(store, actor.tenantId, 'readiness', readinessId(c.id, accountId)) : undefined,
    read = contract ? evidenceReadCheck(evidence, c, now) : {check: notApplicableCheck(), stale: false, valid: false},
    checks: ReadinessCheck[] = [
      check(
        'connection',
        c.enabled,
        c.enabled ? 'Connection enabled.' : 'Connection disabled.',
        'Select accounts for this login in Connections.',
      ),
    ];
  if (options.write)
    checks.push(
      check(
        'deployment_writes',
        options.allowWrites,
        'Deployment write setting.',
        'Enable reviewed writes in server configuration.',
      ),
      check(
        'writes_not_paused',
        !options.paused,
        'Owner write pause.',
        'An owner paused reviewed writes of this workspace; ask an owner to resume them.',
      ),
      check('operator', actor.role !== 'reader', 'MCP operator role.', 'Use an operator connector.'),
      check(
        'account_grant',
        c.writeAccounts?.includes(accountId) === true,
        'Account write grant.',
        'Grant this account write access in Connections.',
      ),
      recordedScopeCheck(store, c, 'write'),
    );
  checks.push(read.check);
  return {
    connection_id: c.id,
    account_id: accountId,
    readiness: contract ? 'account_read' : 'not_applicable',
    checked_at: read.valid ? evidence!.checked_at : null,
    age_ms: read.valid ? now - evidence!.checked_at : null,
    stale: read.stale,
    expires_at: read.valid ? evidence!.checked_at + readinessLifetimeMs : null,
    live_read: read.valid && !read.stale && read.check.status === 'passed',
    ...(read.valid && evidence!.account ? {account: evidence!.account} : {}),
    checks,
    ready: contract && checks.every(x => x.status === 'passed'),
    blocked: checks.some(x => x.status === 'blocked'),
    coverage: 'Exact prerequisites for this viewer; unknown and stale checks are not passed.',
  };
}
