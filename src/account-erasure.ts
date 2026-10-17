import {randomUUID} from 'node:crypto';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {scopeKey} from './security.js';
import type {JsonObject} from './types.js';
import {
  accountByEmail,
  accountById,
  accountExists,
  accountsPastRetention,
  auditRecordCount,
  deleteEmailedLink,
  deleteQueuedMail,
  deleteStepRows,
  deleteStepRowsOneByOne,
  deleteWorkspace,
  emailedLinks,
  erasureSteps,
  leasedJobRunning,
  otherActiveMembers,
  pendingClaimSince,
  sealedMailOutside,
  stepRowCount,
  tableExists as has,
  workspaceExists,
} from './erasure-repository.js';

/**
 * Account erasure (SEC-07 S4). Revoking access only set approved=0 and disabled=1, and nothing could delete an account,
 * its workspace or what it holds; the audit chain also forbade removing anything. An erasure now removes an account and
 * its own workspace in one step, run by the operator (`admin erase-account <email> --dry-run|--confirm`), by the person
 * (self-service deletion in Account, server/account-deletion.ts), by the worker's retention sweep (never-approved
 * sign-ups after 30 days and revoked accounts 90 days after revocation, owner decision P3) or again on a restored copy
 * from the erasure receipts:
 *
 * - every website session, emailed link, queued e-mail about the person, connector key and AI-client grant ends;
 * - every record of the account's own workspace goes: documents, connections (the saved logins; AMCP does not contact
 *   the provider, so the person removes AMCP's access there), jobs, write claims, media, memberships and the workspace;
 * - the person's memberships (with the client access set each limits them to), invitations, monitor subscriptions
 *   and notices and keys in other workspaces go, and the account, its sign-in identities and two-step secret are
 *   deleted; the document kinds that belong to a person are those src/document-kinds.ts declares with `person`;
 * - the workspace's audit records keep their place in the hash chain with a tombstone instead of their payload, and the
 *   deployment's audit gets `account_erased` with the counts and the tombstones' digest (Store.verifyAudit checks it);
 * - an `erasure_receipt` document in the deployment's workspace names the erased account and workspace by their random
 *   ids only, so the erasure can be re-applied to a restored backup.
 *
 * The deployment owner's account and an account whose workspace has other active members are refused: transfer or
 * remove them first. Audit records of other workspaces keep the person's random user id. Erasure is irreversible.
 *
 * After an erasure the write-ahead log is truncated at the store's next maintenance pass (Store.scheduleCheckpoint), so
 * the erased pages leave it promptly; freed pages are zeroed by `secure_delete`. Backups and volume snapshots taken
 * before the erasure are not rewritten: they expire on their own schedule (docs/OPERATIONS.md).
 */
export type ErasureReason =
  'operator_request' | 'self_service' | 'pending_retention' | 'revoked_retention' | 'restore_reapply';
export interface ErasureOptions {
  /** The deployment's workspace (AMCP_TENANT_ID): its owner is never erased, and it keeps the receipts. */
  deploymentTenant: string;
  reason: ErasureReason;
  /** Who erased: `cli`, `self` (the person, in Account), `system:retention` or `system:restore`. */
  by: string;
  /** Count what would go; change nothing. */
  dryRun?: boolean;
  /** Re-application on a restored copy: the original erasure. The shared-workspace check already passed then. */
  reapplies?: string;
}
export interface ErasureSelector {
  email?: string;
  userId?: string;
  tenantId?: string;
}

/** The account a selector names, and the workspace it owns. */
function target(store: Store, selector: ErasureSelector): {user?: JsonObject; tenant?: string} {
  const users = has(store, 'amcp_users'),
    user = !users
      ? undefined
      : selector.userId
        ? accountById(store, selector.userId)
        : selector.email
          ? accountByEmail(store, String(selector.email).trim().toLowerCase())
          : undefined;
  const tenant = user ? String(user.tenant_id) : selector.tenantId;
  return {
    user,
    tenant: tenant && workspaceExists(store, tenant) ? tenant : user ? tenant : undefined,
  };
}
/**
 * Sealed rows about the person that only their content identifies: e-mails queued in other workspaces (those of the
 * erased workspace go with it) and emailed links.
 */
function sealedRows(
  store: Store,
  user: JsonObject | undefined,
  tenant: string,
): {outbox: string[]; challenges: string[]; unchecked: number} {
  const box = store.keyring,
    email = typeof user?.email === 'string' ? user.email.toLowerCase() : undefined,
    out = {outbox: [] as string[], challenges: [] as string[], unchecked: 0};
  if (!user) return out;
  const open = (sealed: string, scope: string): JsonObject | undefined => {
    if (!box) {
      out.unchecked++;
      return;
    }
    try {
      return box.open<JsonObject>(sealed, scope);
    } catch {
      out.unchecked++;
    }
  };
  if (has(store, 'amcp_email_outbox'))
    for (const row of sealedMailOutside(store, tenant)) {
      const payload = open(row.secret, scopeKey('account-auth', 'mail:' + row.id));
      if (payload && email && JSON.stringify(payload).toLowerCase().includes(email)) out.outbox.push(row.id);
    }
  if (has(store, 'amcp_account_challenges'))
    for (const row of emailedLinks(store)) {
      const data = open(row.secret, scopeKey('account-auth', row.hash));
      if (data && (data.userId === user.id || (!!email && String(data.email ?? '').toLowerCase() === email)))
        out.challenges.push(row.hash);
    }
  return out;
}

/** Writes that may still be in flight in a workspace this long after their claim was taken. */
const claimWindowMs = 15 * 60000;
/**
 * Whether work is still running in a workspace: a leased job, or a reviewed write claimed in the last 15 minutes. A
 * self-service deletion waits for it (ACCOUNT_DELETION_BUSY).
 */
export function workspaceBusy(store: Store, tenant: string, now = Date.now()): boolean {
  return leasedJobRunning(store, tenant, now) || pendingClaimSince(store, tenant, now - claimWindowMs);
}
export const workspaceBusyError = () =>
  new MirrorError(
    'ACCOUNT_DELETION_BUSY',
    'Work is still running in your workspace. Try again in a few minutes; nothing was deleted.',
    {retry_after_ms: 60000},
    409,
    true,
  );
/** Whether another active member uses the account's own workspace (its erasure is refused then). */
const sharedWith = (store: Store, tenant: string, user: JsonObject | undefined) =>
  otherActiveMembers(store, tenant, String(user?.id ?? '')) > 0;
const sharedError = () =>
  new MirrorError(
    'ERASURE_WORKSPACE_SHARED',
    'Other active members use this account’s workspace. Remove them or move their work first; nothing was erased.',
    {},
    409,
  );

/**
 * Plans (with `dryRun`) or carries out the erasure of one account and its workspace. The plan counts the rows of each
 * table that would go and the audit records that would be tombstoned; nothing is changed. Returns the receipt.
 */
export function eraseAccount(store: Store, selector: ErasureSelector, options: ErasureOptions): JsonObject {
  const {user, tenant} = target(store, selector);
  if (!tenant) throw new MirrorError('NOT_FOUND', 'Account not found.', {}, 404);
  const refusal =
    tenant === options.deploymentTenant
      ? new MirrorError(
          'ERASURE_REFUSED',
          'The deployment owner’s account and workspace cannot be erased. Move ownership first.',
          {},
          409,
        )
      : !options.reapplies && sharedWith(store, tenant, user)
        ? sharedError()
        : undefined;
  // The refusals that can change while the erasure runs (a member accepts an invitation, a job is leased) are checked
  // again just before the first deletion and inside the erasure transaction, so nothing is deleted from a workspace
  // that became shared or busy after the checks above (a self-service deletion makes that race the person's own).
  const recheck = () => {
    if (!options.reapplies && sharedWith(store, tenant, user)) throw sharedError();
    if (options.reason === 'self_service' && workspaceBusy(store, tenant)) throw workspaceBusyError();
  };
  const plan = erasureSteps(store, user, tenant).filter(step => has(store, step.table)),
    sealed = sealedRows(store, user, tenant),
    counts: Record<string, number> = {};
  for (const step of plan) counts[step.table] = stepRowCount(store, step);
  counts.amcp_email_outbox = (counts.amcp_email_outbox ?? 0) + sealed.outbox.length;
  if (has(store, 'amcp_account_challenges')) counts.amcp_account_challenges = sealed.challenges.length;
  counts.tenants = workspaceExists(store, tenant) ? 1 : 0;
  const auditRecords = auditRecordCount(store, tenant);
  const ids = {user_id: user?.id ?? null, tenant_id: tenant};
  if (options.dryRun)
    return {
      status: refusal ? 'refused' : 'planned',
      ...ids,
      counts,
      audit_records_to_tombstone: auditRecords,
      ...(sealed.unchecked ? {sealed_rows_unchecked: sealed.unchecked} : {}),
      ...(refusal ? {refusal: {code: refusal.code, message: refusal.message}} : {}),
    };
  if (refusal) throw refusal;
  const erasure = randomUUID(),
    at = Date.now();
  recheck();
  // Media chunks first, one per statement; a failure after them leaves an account the next erasure finishes.
  for (const step of plan.filter(s => s.oneByOne)) deleteStepRowsOneByOne(store, step);
  const receipt = store.transaction(() => {
    recheck();
    // The rows are selected again inside the transaction, so a key or session created since the plan goes too.
    for (const step of erasureSteps(store, user, tenant).filter(s => !s.oneByOne && has(store, s.table)))
      deleteStepRows(store, step);
    for (const id of sealed.outbox) deleteQueuedMail(store, id);
    for (const hash of sealed.challenges) deleteEmailedLink(store, hash);
    deleteWorkspace(store, tenant);
    const tombstones = store.tombstoneAudit(tenant, erasure),
      receipt: JsonObject = {
        erasure_id: erasure,
        status: 'erased',
        ...ids,
        reason: options.reason,
        by: options.by,
        erased_at: at,
        ...(options.reapplies ? {reapplies: options.reapplies} : {}),
        counts,
        tombstoned_rows: tombstones.tombstoned_rows,
      };
    store.ensureTenant(options.deploymentTenant);
    store.putDocument(options.deploymentTenant, 'erasure_receipt', erasure, receipt);
    store.appendAudit(options.deploymentTenant, 'erasure/' + erasure, {
      event: 'account_erased',
      erasure,
      ...ids,
      reason: options.reason,
      by: options.by,
      ...(options.reapplies ? {reapplies: options.reapplies} : {}),
      ...tombstones,
    });
    return receipt;
  });
  // The erased pages still sit in the write-ahead log until a checkpoint; truncate it at the next maintenance pass.
  store.scheduleCheckpoint();
  return receipt;
}

/** The erasures recorded in a deployment, oldest first: ids, reason and time only. */
export function erasureReceipts(store: Store, deploymentTenant: string): JsonObject[] {
  return store
    .documents(deploymentTenant, 'erasure_receipt')
    .map(r => ({
      erasure_id: r.erasure_id,
      user_id: r.user_id,
      tenant_id: r.tenant_id,
      reason: r.reason,
      erased_at: r.erased_at,
    }))
    .sort((a, b) => Number(a.erased_at) - Number(b.erased_at));
}

/**
 * Re-applies erasure receipts to a restored copy (SEC-07 S4): an account or workspace a receipt names that the copy
 * still holds is erased again, with the original erasure noted. Returns one line per receipt.
 */
export function reapplyErasures(store: Store, receipts: unknown, deploymentTenant: string): JsonObject[] {
  const ids = /^[\w.:-]{1,200}$/;
  if (
    !Array.isArray(receipts) ||
    receipts.length > 100000 ||
    receipts.some(
      r =>
        !r ||
        typeof r !== 'object' ||
        typeof r.erasure_id !== 'string' ||
        !ids.test(r.erasure_id) ||
        (r.user_id !== null && (typeof r.user_id !== 'string' || !ids.test(r.user_id))) ||
        typeof r.tenant_id !== 'string' ||
        !ids.test(r.tenant_id),
    )
  )
    throw new MirrorError(
      'INVALID_ERASURE_RECEIPTS',
      'Erasure receipts must be the JSON list `admin erasure-receipts` prints.',
    );
  return (receipts as JsonObject[]).map(r => {
    const present =
      (r.user_id && has(store, 'amcp_users') && accountExists(store, r.user_id)) || workspaceExists(store, r.tenant_id);
    if (!present) return {erasure_id: r.erasure_id, status: 'absent'};
    const receipt = eraseAccount(
      store,
      r.user_id ? {userId: r.user_id, tenantId: r.tenant_id} : {tenantId: r.tenant_id},
      {
        deploymentTenant,
        reason: 'restore_reapply',
        by: 'system:restore',
        reapplies: r.erasure_id,
      },
    );
    return {erasure_id: r.erasure_id, status: 'reapplied', reapplied_as: receipt.erasure_id};
  });
}

const day = 86400000;
/**
 * Retention of accounts (SEC-07 S4, owner decision P3 of 2026-10-11, GDPR and KSA PDPL): `AMCP_PENDING_ACCOUNT_DAYS`
 * erases sign-ups never approved after that many days (default 30, 1 to 365, or `off`); `AMCP_REVOKED_ACCOUNT_DAYS`
 * erases accounts whose access was revoked that long ago (default 90, 1 to 3650, or `off`). An unknown value stops the
 * website and the worker.
 */
export function accountRetention(env: NodeJS.ProcessEnv): {pendingMs: number | null; revokedMs: number | null} {
  const period = (name: string, fallback: number, max: number) => {
    const value = env[name]?.trim();
    if (value === 'off') return null;
    const days = value === undefined || value === '' ? fallback : Number(value);
    if (!Number.isInteger(days) || days < 1 || days > max)
      throw Error(name + ' must be a whole number of days from 1 to ' + max + ', or off.');
    return days * day;
  };
  return {
    pendingMs: period('AMCP_PENDING_ACCOUNT_DAYS', 30, 365),
    revokedMs: period('AMCP_REVOKED_ACCOUNT_DAYS', 90, 3650),
  };
}
/**
 * `AMCP_ACCOUNT_SELF_DELETION` (owner decision P3): `on` (the default) lets a person delete their own account in
 * Account; `off` is the rollback, after which deletion is the operator's (`admin erase-account`). Another value stops
 * the website.
 */
export function selfServiceDeletion(env: NodeJS.ProcessEnv): boolean {
  const value = env.AMCP_ACCOUNT_SELF_DELETION?.trim();
  if (value === undefined || value === '' || value === 'on') return true;
  if (value === 'off') return false;
  throw Error('AMCP_ACCOUNT_SELF_DELETION must be on or off.');
}
/** The accounts past each retention period, oldest first; `shared` selects those whose workspace others use. */
const pastRetention = accountsPastRetention;
/**
 * Accounts the retention sweep erases now: never approved and older than `pendingMs`, or revoked `revokedMs` ago, at
 * most 100 of each. A pending account with a membership in another workspace (invited by that workspace's administrator
 * and still awaiting the owner's approval) is kept: erasing it would also remove that membership. An account whose own
 * workspace other active members use is not selected either (retentionBlockedAccounts counts them): its erasure is
 * refused, and selecting it again every hour let 100 such accounts hold back every later one.
 */
export function accountsDueForErasure(
  store: Store,
  deploymentTenant: string,
  retention: {pendingMs: number | null; revokedMs: number | null},
  now = Date.now(),
): {pending: string[]; revoked: string[]} {
  if (!has(store, 'amcp_users')) return {pending: [], revoked: []};
  return pastRetention(store, deploymentTenant, retention, now, false, 100);
}
/**
 * How many accounts are past their retention period but kept because other active members use their workspace: the
 * AMCP owner removes those members (or the account's owner moves their work) before the sweep can erase them.
 */
export function retentionBlockedAccounts(
  store: Store,
  deploymentTenant: string,
  retention: {pendingMs: number | null; revokedMs: number | null},
  now = Date.now(),
): number {
  if (!has(store, 'amcp_users')) return 0;
  const blocked = pastRetention(store, deploymentTenant, retention, now, true, 1000);
  return blocked.pending.length + blocked.revoked.length;
}
