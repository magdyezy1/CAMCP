import type {Request} from 'express';
import {MirrorError} from '../src/errors.js';
import {eraseAccount, selfServiceDeletion, workspaceBusy, workspaceBusyError} from '../src/account-erasure.js';
import {connectionGateways, otherActiveMemberships} from '../src/connection-repository.js';
import type {JsonObject} from '../src/types.js';
import type {UserAccounts} from './user-accounts.js';
import type {WebSession} from './web-store.js';

/**
 * Self-service account deletion (SEC-07 S4(d), owner decision P3 of 2026-10-11: design to GDPR and KSA PDPL and offer
 * self-service deletion). Before it, a person could only ask the operator, who ran `admin erase-account`. The person now
 * deletes their own account in Account, with the same erasure (src/account-erasure.ts, reason `self_service`, by
 * `self`):
 *
 * - `GET /api/account/deletion` shows what would be deleted and whether it can be, changing nothing;
 * - `POST /api/account/delete` with `confirm` (the account's email address, or its name when it has none) erases the
 *   account, its own workspace and everything it holds, after a recent proof of identity ("Confirm it's you", SEC-06).
 *
 * Refused, before anything is deleted: door and reviewer sign-ins (no personal account), invited reviewer test accounts
 * (the AMCP owner or the retention sweep erases those), the AMCP owner's account, an account whose workspace other
 * active members use (AMCP cannot hand a workspace to another owner, so the person removes those members first), work
 * still running in the workspace (a leased job, or a write claimed in the last 15 minutes), and every deletion while
 * `AMCP_ACCOUNT_SELF_DELETION=off`. The erasure checks the shared workspace and running work again inside its own
 * transaction, so a member who joins or a job leased after these checks still stops it. The answer is the erasure receipt (random ids, time and
 * counts) and the platforms whose AMCP access the person should also remove; when e-mail is configured, a confirmation
 * naming the erasure id is queued to the deleted address (its sealed copy leaves the outbox once delivered or after 24
 * hours).
 */
export class AccountDeletion {
  constructor(readonly accounts: UserAccounts) {}
  private get web() {
    return this.accounts.web;
  }
  private get store() {
    return this.accounts.web.store;
  }
  /** The person's own account behind a session; the administrator and reviewer doors have none. */
  private person(s: WebSession): JsonObject {
    if (s.actor.userId === 'workspace-admin' || s.actor.userId === 'workspace-test')
      throw new MirrorError('ACCOUNT_DELETION_UNAVAILABLE', 'This sign-in has no personal account to delete.', {}, 403);
    return this.accounts.user(s.actor.userId);
  }
  /** Why the account cannot be deleted now, or undefined. Changes nothing. */
  private refusal(user: JsonObject, plan: JsonObject): MirrorError | undefined {
    if (!selfServiceDeletion(this.accounts.env))
      return new MirrorError(
        'ACCOUNT_DELETION_DISABLED',
        'Account deletion is handled by the AMCP owner on this deployment. Ask them to erase your account.',
        {},
        403,
      );
    // An invited reviewer test account is the owner's to erase (or the retention sweep's), as the docs promise; only
    // the website hid the panel before (wave 3a review).
    if (user.test_account)
      return new MirrorError(
        'ACCOUNT_DELETION_UNAVAILABLE',
        'A reviewer test account is erased by the AMCP owner, or by the retention sweep after its access is removed, not from Account. Ask the owner to remove it.',
        {},
        403,
      );
    if (String(user.tenant_id) === this.web.tenantId || (plan.refusal as JsonObject)?.code === 'ERASURE_REFUSED')
      return new MirrorError(
        'ACCOUNT_DELETION_OWNER',
        'The AMCP owner’s account cannot be deleted from Account. Move the deployment to another owner first.',
        {},
        409,
      );
    if ((plan.refusal as JsonObject)?.code === 'ERASURE_WORKSPACE_SHARED')
      return new MirrorError(
        'ERASURE_WORKSPACE_SHARED',
        'Other members still use your workspace, and AMCP cannot hand it to another owner. Remove them in Workspace members first; nothing was deleted.',
        {},
        409,
      );
    if (workspaceBusy(this.store, String(user.tenant_id))) return workspaceBusyError();
  }
  private plan(user: JsonObject) {
    return eraseAccount(
      this.store,
      {userId: String(user.id)},
      {deploymentTenant: this.web.tenantId, reason: 'self_service', by: 'self', dryRun: true},
    );
  }
  /** The platforms of the workspace's saved logins: AMCP never contacts them, so the person removes its access there. */
  private platforms(user: JsonObject): string[] {
    return connectionGateways(this.store, String(user.tenant_id))
      .map(r => r.gateway)
      .filter((g): g is string => typeof g === 'string' && /^[a-z0-9_]{1,64}$/.test(g));
  }
  /** The other workspaces the person is an active member of: those memberships end, the workspaces stay. */
  private otherWorkspaces(user: JsonObject): number {
    return otherActiveMemberships(this.store, String(user.id), String(user.tenant_id));
  }
  /** What an erasure removed or would remove, in the person's terms. */
  private summary(counts: JsonObject, otherWorkspaces: number): JsonObject {
    const n = (table: string) => Number(counts?.[table]) || 0;
    return {
      workspaces: n('tenants'),
      platform_logins: n('connections'),
      saved_records: n('documents'),
      files: n('retained_media') + n('media_staging'),
      connector_keys: n('api_keys'),
      sessions: n('amcp_web_sessions'),
      other_workspaces: otherWorkspaces,
    };
  }
  /** `GET /api/account/deletion`: whether the signed-in person can delete their account now, and what would go. */
  preview(req: Request): JsonObject {
    const user = this.person(this.web.requireSession(req)),
      plan = this.plan(user),
      refusal = this.refusal(user, plan);
    return {
      available: !refusal,
      ...(refusal ? {refusal: {code: refusal.code, message: refusal.message}} : {}),
      confirm_with: user.email ? 'email' : 'name',
      will_delete: this.summary(plan.counts as JsonObject, this.otherWorkspaces(user)),
      platforms: this.platforms(user),
    };
  }
  /**
   * `POST /api/account/delete`: erases the signed-in person's account; see the class comment. The checks run in this
   * order, each before any effect: availability (the refusals above), the typed confirmation, then recent proof of
   * identity, so "Confirm it's you" is only asked for a deletion that can go ahead.
   */
  delete(req: Request, input: JsonObject): JsonObject {
    const s = this.web.requireMutation(req),
      user = this.person(s),
      expected = user.email ? String(user.email).trim().toLowerCase() : String(user.name).trim(),
      typed = typeof input.confirm === 'string' ? input.confirm.trim() : '';
    const refusal = this.refusal(user, this.plan(user));
    if (refusal) throw refusal;
    if (!typed || (user.email ? typed.toLowerCase() : typed) !== expected) {
      if (user.email)
        throw new MirrorError(
          'ACCOUNT_DELETION_CONFIRMATION',
          'Type your account’s email address exactly to confirm. Nothing was deleted.',
          {},
          400,
        );
      throw new MirrorError(
        'ACCOUNT_DELETION_CONFIRMATION',
        'Type your account’s name exactly to confirm. Nothing was deleted.',
        {},
        400,
      );
    }
    // Deleting is irreversible: it needs a sign-in or "Confirm it's you" within the last 15 minutes (SEC-06).
    this.accounts.fresh(s);
    const platforms = this.platforms(user),
      otherWorkspaces = this.otherWorkspaces(user),
      receipt = eraseAccount(
        this.store,
        {userId: String(user.id)},
        {deploymentTenant: this.web.tenantId, reason: 'self_service', by: 'self'},
      );
    // Queued after the erasure, which would otherwise remove it as a message about the person.
    if (typeof user.email === 'string' && user.email)
      this.accounts.queueNotice(
        this.web.tenantId,
        user.email,
        'Your AMCP account was deleted',
        'Your AMCP account, its workspace and everything that workspace held were deleted at your request (erasure ' +
          receipt.erasure_id +
          ', ' +
          new Date(Number(receipt.erased_at)).toUTCString() +
          ').\n\nAMCP did not contact your advertising platforms: remove AMCP from the apps connected to each platform account you used.\n\nIf you did not ask for this, tell the AMCP owner at once.\n',
        'erased:' + receipt.erasure_id,
      );
    return {
      deleted: true,
      receipt: {
        erasure_id: receipt.erasure_id,
        erased_at: receipt.erased_at,
        reason: receipt.reason,
        deleted: this.summary(receipt.counts as JsonObject, otherWorkspaces),
      },
      platforms,
    };
  }
}
