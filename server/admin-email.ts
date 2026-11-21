import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {memberAccessSetId, setMemberAccessSet} from '../src/access-sets.js';
import type {Store} from '../src/store.js';
import type {JsonObject} from '../src/types.js';
import {endMcpGrants} from './mcp-grants.js';
import {personGrants} from './mcp-grant-repository.js';
import {
  accountRow,
  approvePending,
  clearGrantMarker,
  endGrantedMembership,
  endPersonSessionsAndKeys,
  grantedMembership,
  grantedMemberships,
  insertGrantedMembership,
  membershipRow,
  raiseMembership,
  restoreMembership,
} from './website-repository.js';

/**
 * `AMCP_ADMIN_EMAIL` (r25-admin-email, the owner's request of 2026-11-21): one e-mail address whose verified sign-in
 * becomes a second owner of the deployment's workspace, beside the AMCP owner. This module holds the one definition of
 * "the address" (parsing and exact matching), the grant, and the end of a grant, so the configuration, the website store
 * and the account code agree. The owner's answers of 2026-11-21: a SECOND OWNER (not an administrator), and a grant that
 * ends by restoring the role the person held before it.
 */

/** The role the variable grants. One constant: the owner chose "second owner" over "administrator" on 2026-11-21. */
export const adminEmailRole = 'owner' as const;
/** What `workspace_memberships.granted_by` holds for a membership this variable made or raised. */
export const adminEmailGrantedBy = 'env:AMCP_ADMIN_EMAIL';
/** The roles a grant can restore: the ones a person can hold before it (a grant is never recorded over an owner). */
const restorable = ['admin', 'operator', 'viewer'];

/** What `loadConfig` throws for an unparseable value. It never repeats the value: an address is personal data. */
export const adminEmailProblem =
  'AMCP_ADMIN_EMAIL must hold exactly one e-mail address (no list, wildcard or domain). Correct or remove it.';
// One address: no whitespace or control characters, no list separators, wildcards, quotes, brackets or angle brackets,
// exactly one `@` and a dotted domain. It is a subset of what accountEmail (server/user-accounts.ts) accepts for an
// account, so a value that passes here can equal an account's address.
const plain = String.raw`[^\s\x00-\x1f\x7f@<>,;*?%"\\()\[\]]`;
const singleAddress = new RegExp('^' + plain + '+@' + plain + '+\\.' + plain + '+$');
/**
 * The configured address, trimmed and lower-cased as accountEmail does for every account, or undefined when the value
 * is unset, empty or blank. Anything else that is not exactly one address throws `adminEmailProblem`.
 */
export function adminEmailFrom(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (value.length > 254 || !singleAddress.test(value)) throw new Error(adminEmailProblem);
  return value.toLowerCase();
}
const digest = (text: string) => createHash('sha256').update(text).digest();
/**
 * Whether `candidate` is exactly the configured address, ignoring case and surrounding space. The comparison runs over
 * fixed-length digests in constant time, so its duration says nothing about how much of the address a guess had right.
 * Anything that is not a string, and a string longer than any address, never matches; without the setting nothing does.
 */
export function adminEmailMatches(configured: string | undefined, candidate: unknown): boolean {
  if (configured === undefined) return false;
  const text = typeof candidate === 'string' && candidate.length <= 1024 ? candidate.trim().toLowerCase() : '';
  return timingSafeEqual(digest(text), digest(configured)) && text !== '';
}

/**
 * Whether an account may hold the role the variable grants: its address is exactly the configured one, and it is neither
 * a test account nor disabled. The address of an account is always a verified one: it enters `amcp_users.email` only
 * through an e-mail link (registration, an address change, an invitation, owner setup) or a Google or Apple token whose
 * claim says the address is verified, never through Facebook (server/social-signin.ts returns no address for it).
 */
export function adminEmailEligible(configured: string | undefined, user: JsonObject): boolean {
  return adminEmailMatches(configured, user.email) && !user.disabled && !user.test_account;
}

/**
 * The grant (r25-admin-email item 2'): an account that is eligible becomes an owner of the deployment's workspace beside
 * the AMCP owner, and a pending account is approved. Called once the person is authenticated. The membership records its
 * source (`granted_by`) and the role held before it (`granted_from`: a role, `role:setId` for a member limited to a client
 * access set, or absent for none), which the end of the grant restores. An owner already holding the role (the AMCP owner,
 * or the person on an earlier sign-in) is left exactly as it is, with no marker and no audit row, so a second sign-in
 * changes nothing. The audit row names the user ID and never the address. Returns the account as it is afterwards.
 */
export function grantAdminEmailRole(
  store: Store,
  tenant: string,
  configured: string | undefined,
  user: JsonObject,
): JsonObject {
  if (!adminEmailEligible(configured, user)) return user;
  return store.transaction(() => {
    // The account is read again inside the transaction: it may have been disabled or changed since the caller read it.
    const current = accountRow(store, user.id);
    if (!current || !adminEmailEligible(configured, current)) return user;
    const approving = approvePending(store, current.id),
      row = membershipRow(store, tenant, current.id),
      holds = !!row && row.active === 1 && row.role === adminEmailRole;
    let previous: string | null = null;
    if (!holds) {
      store.ensureTenant(tenant);
      if (row && row.active === 1) {
        // An owner is never limited to a client access set: the limit is set aside and comes back with the old role.
        const set = memberAccessSetId(store, tenant, String(current.id));
        previous = String(row.role) + (set ? ':' + set : '');
        if (set) setMemberAccessSet(store, tenant, String(current.id), null);
      }
      if (row) raiseMembership(store, tenant, current.id, adminEmailRole, adminEmailGrantedBy, previous);
      else insertGrantedMembership(store, tenant, current.id, adminEmailRole, adminEmailGrantedBy);
    }
    if (approving || !holds)
      store.appendAudit(tenant, randomUUID(), {
        event: 'admin_email_owner_granted',
        user_id: current.id,
        role: adminEmailRole,
        previous_role: previous === null ? null : previous.split(':')[0],
        ...(approving ? {approved: true} : {}),
      });
    return accountRow(store, current.id)!;
  });
}

/**
 * Ends one grant (r25-admin-email item 3'): the membership goes back to the role the person held before it, with the
 * client access set it had, or ends when they held none. Their website sessions, connector tokens and AI-client
 * connections of this workspace stop, as a role change or a removal does (server/account-security.ts changeMember).
 * A membership that is no longer the role the variable made (changed by hand, or already ended) is never touched: only
 * its stale marker goes. Returns whether a grant ended.
 */
function endAdminEmailGrant(store: Store, tenant: string, userId: string): boolean {
  return store.transaction(() => {
    const row = grantedMembership(store, tenant, userId, adminEmailGrantedBy);
    if (!row) return false;
    if (!(row.active === 1 && row.role === adminEmailRole)) {
      clearGrantMarker(store, tenant, userId);
      return false;
    }
    const [before, set] = typeof row.granted_from === 'string' ? row.granted_from.split(':') : [],
      restored = before && restorable.includes(before) ? before : null;
    if (restored) {
      restoreMembership(store, tenant, userId, restored);
      if (set) setMemberAccessSet(store, tenant, userId, set);
    } else endGrantedMembership(store, tenant, userId);
    endPersonSessionsAndKeys(store, tenant, userId);
    endMcpGrants(store, personGrants, [tenant, userId], 'membership_change');
    store.appendAudit(tenant, randomUUID(), {
      event: 'admin_email_owner_revoked',
      user_id: userId,
      restored_role: restored,
    });
    return true;
  });
}

/**
 * Ends every grant the variable no longer justifies (item 3'), at start-up and when a person's session is read: the
 * variable is unset or names another address, the account's address changed, or the account was disabled or became a
 * test account, or the membership belongs to a workspace that is no longer the deployment's. `userId` limits it to one
 * person. A role given by hand has no marker and is never looked at. Returns how many grants ended.
 */
export function reconcileAdminEmailGrants(
  store: Store,
  tenant: string,
  configured: string | undefined,
  userId?: string,
): number {
  let ended = 0;
  for (const row of grantedMemberships(store, adminEmailGrantedBy, userId)) {
    const justified =
      row.tenant_id === tenant &&
      row.active === 1 &&
      row.role === adminEmailRole &&
      row.email != null &&
      adminEmailEligible(configured, row);
    if (!justified && endAdminEmailGrant(store, String(row.tenant_id), String(row.user_id))) ended++;
  }
  return ended;
}
