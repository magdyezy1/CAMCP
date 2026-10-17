import {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * The newest backup receipt of a workspace, with its age, for owner health (OPS-04). Receipts have random IDs, so the
 * newest is chosen by its verification time, not by document order. Kept apart from `src/backup.ts`, so that owner
 * health, which shares a module with the reviewed-write pause, does not put the backup code on the write path.
 */
export function lastBackupReceipt(store: Store, tenant: string, now = Date.now()): JsonObject | undefined {
  const receipt = store.repo('backup_receipt', tenant).newest('verified_at');
  if (!receipt) return;
  const at = Number(receipt.verified_at);
  return Number.isFinite(at)
    ? {...receipt, age_ms: Math.max(0, now - at), age_hours: Math.max(0, Math.round((now - at) / 360000) / 10)}
    : receipt;
}
