import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {ownerAccess} from './spend-policy.js';
import type {Actor, JsonObject} from './types.js';

/**
 * Who may download report files from the website (SEC-05): Overview CSV, source evidence, PDF and Excel packs,
 * retained report files and detailed evidence workbooks. Operators, administrators and owners may; a viewer only when
 * the workspace owner allows viewer downloads. The role matrix said viewers have no exports, and Sheets export already
 * refused them, while the file routes checked only account access. Viewers still read the same reports on screen.
 */
const exportPolicyId = 'exports';

/** Whether the workspace owner lets viewers download report files (account_settings/exports). Off by default. */
export function viewerDownloadsAllowed(store: Store, tenant: string): boolean {
  return store.repo('account_settings', tenant).payload(exportPolicyId)?.viewer_downloads === true;
}

/** Whether this actor may download report files. */
export function downloadsAllowed(store: Store, actor: Actor): boolean {
  return actor.role !== 'reader' || viewerDownloadsAllowed(store, actor.tenantId);
}

/** Refuses a report-file download this actor's role does not allow. Nothing is generated after the refusal. */
export function assertDownloadAllowed(store: Store, actor: Actor): void {
  if (!downloadsAllowed(store, actor))
    throw new MirrorError(
      'FORBIDDEN',
      'An operator role is required to download report files. The workspace owner can allow viewers to download them in Settings.',
      {},
      403,
    );
}

/** The workspace owner's choice, audited. Requires `viewer_downloads` (boolean) and `confirmed: true`. */
export function saveExportPolicy(store: Store, actor: Actor, input: JsonObject): JsonObject {
  ownerAccess(store, actor, 'save_export_policy');
  if (typeof input.viewer_downloads !== 'boolean' || input.confirmed !== true)
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Choose whether viewers may download report files, and confirm the change.',
    );
  const policy = {viewer_downloads: input.viewer_downloads, updated_at: Date.now(), updated_by: actor.userId};
  store.transaction(() => {
    store.putDocument(actor.tenantId, 'account_settings', exportPolicyId, policy);
    store.appendAudit(actor.tenantId, randomUUID(), {
      event: 'export_policy_saved',
      viewer_downloads: policy.viewer_downloads,
      by: actor.userId,
    });
  });
  return {viewer_downloads: policy.viewer_downloads, updated_at: policy.updated_at};
}
