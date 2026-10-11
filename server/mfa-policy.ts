import type {Store} from '../src/store.js';
import type {JsonObject} from '../src/types.js';
import {MirrorError} from '../src/errors.js';

/**
 * Who must use two-step verification (SEC-06 S3, owner decision P2: mandatory for owners and administrators of
 * write-enabled workspaces).
 *
 * - The deployment baseline: AMCP_REQUIRE_MFA (`admins` by default when the deployment allows reviewed writes, `off`
 *   otherwise; `everyone` is stricter, `off` is the rollback). Members it covers enroll within AMCP_MFA_GRACE_DAYS
 *   (default 14) of the later of the baseline's start and their membership.
 * - A workspace policy (`account_settings/security`), which an owner sets after a recent sign-in and only once their
 *   own account uses two-step verification: `admins` or `everyone`, with its own grace period. While it is on, the
 *   website also requires a two-step-verified session for owner-only changes and personal-data uploads.
 *
 * After the grace period a covered member without two-step verification can reach only sign-in, account and
 * enrollment routes. The administrator and reviewer doors and reviewer test accounts are never covered: they cannot
 * enroll (the administrator moves the workspace to an owner account instead, docs/USER-ACCOUNTS.md).
 */
export const mfaScopes = ['off', 'admins', 'everyone'] as const;
export type MfaScope = (typeof mfaScopes)[number];
export interface MfaBaseline {
  scope: MfaScope;
  since: number;
  graceMs: number;
}
const day = 86400000;
/** Reads AMCP_REQUIRE_MFA and AMCP_MFA_GRACE_DAYS; an unknown value stops start-up instead of guessing. */
export function mfaBaselineConfig(env: NodeJS.ProcessEnv, allowWrites: boolean): {scope: MfaScope; graceMs: number} {
  const scope = (env.AMCP_REQUIRE_MFA || (allowWrites ? 'admins' : 'off')) as MfaScope,
    days =
      env.AMCP_MFA_GRACE_DAYS === undefined || env.AMCP_MFA_GRACE_DAYS === '' ? 14 : Number(env.AMCP_MFA_GRACE_DAYS);
  if (!mfaScopes.includes(scope)) throw Error('AMCP_REQUIRE_MFA must be off, admins or everyone.');
  if (!Number.isInteger(days) || days < 0 || days > 90)
    throw Error('AMCP_MFA_GRACE_DAYS must be a whole number of days from 0 to 90.');
  return {scope, graceMs: days * day};
}
/** The baseline in force, recording when it first applied to this deployment (its grace period counts from then). */
export function mfaBaseline(store: Store, tenant: string, config: {scope: MfaScope; graceMs: number}): MfaBaseline {
  if (config.scope === 'off') return {...config, since: Date.now()};
  const row = store.db
    .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='account_settings' AND id='mfa_baseline'")
    .get(tenant) as {data: string} | undefined;
  let since = row ? Number(JSON.parse(row.data).since) : NaN;
  if (!Number.isFinite(since)) {
    since = Date.now();
    store.db
      .prepare(
        "INSERT INTO documents(tenant_id,kind,id,data) VALUES(?,'account_settings','mfa_baseline',?) ON CONFLICT(tenant_id,kind,id) DO NOTHING",
      )
      .run(tenant, JSON.stringify({since, scope: config.scope}));
  }
  return {...config, since};
}
/** A workspace's security settings (`account_settings/security`), with defaults. */
export function securitySettings(store: Store, tenant: string): JsonObject {
  const row = store.db
    .prepare("SELECT data,revision FROM documents WHERE tenant_id=? AND kind='account_settings' AND id='security'")
    .get(tenant) as {data: string; revision: number} | undefined;
  const data = row ? (JSON.parse(row.data) as JsonObject) : {};
  return {
    require_mfa: mfaScopes.includes(data.require_mfa) ? data.require_mfa : 'off',
    grace_until: Number.isFinite(data.grace_until) ? data.grace_until : null,
    invitation_hours: Number.isInteger(data.invitation_hours) ? data.invitation_hours : defaultInvitationHours,
    revision: row?.revision ?? 0,
    ...(data.updated_at ? {updated_at: data.updated_at, updated_by: data.updated_by} : {}),
  };
}
/** Invitations last 72 hours unless the owner sets 1 hour to 7 days (SEC-06 S4). */
export const defaultInvitationHours = 72;
const covers = (scope: unknown, role: unknown) =>
  scope === 'everyone' || (scope === 'admins' && (role === 'owner' || role === 'admin'));
/**
 * Whether two-step verification is required of a member of `tenant` with membership `role`, and from when it is
 * enforced (`by`: the earliest end of a grace period that applies). `workspacePolicy` is true while the workspace's own
 * policy covers the member.
 */
export function mfaRequirement(
  store: Store,
  baseline: MfaBaseline | undefined,
  tenant: string,
  userId: string,
  role: unknown,
): {required: boolean; by: number | null; workspacePolicy: boolean} {
  const settings = securitySettings(store, tenant),
    times: number[] = [];
  const workspacePolicy = covers(settings.require_mfa, role);
  if (workspacePolicy) times.push(Number(settings.grace_until ?? 0));
  if (baseline && covers(baseline.scope, role)) {
    const joined = store.db
      .prepare('SELECT created_at FROM workspace_memberships WHERE tenant_id=? AND user_id=?')
      .get(tenant, userId) as {created_at: number} | undefined;
    times.push(Math.max(baseline.since, Number(joined?.created_at ?? 0)) + baseline.graceMs);
  }
  return {required: times.length > 0, by: times.length ? Math.min(...times) : null, workspacePolicy};
}
/** Refuses to require two-step verification of others while the owner's own account does not use it (SEC-06 S3). */
export function assertPolicyOwnerEnrolled(hasMfa: boolean, scope: MfaScope) {
  if (scope !== 'off' && !hasMfa)
    throw new MirrorError(
      'MFA_ENROLLMENT_REQUIRED',
      'Turn on two-step verification for your own account before requiring it of others.',
      {},
      403,
    );
}
