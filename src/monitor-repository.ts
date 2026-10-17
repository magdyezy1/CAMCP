import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * Report monitor notices and subscriptions (src/monitor-delivery.ts) in the store layer (ARC-02): the statements moved
 * here verbatim. Rows are returned as SQLite gives them (`data` is JSON text), as before. The e-mail worker's sweeps
 * (`expireNotices`, `deleteNoticesCreatedBefore`, `nextPendingNotice`) run across every workspace by design; every
 * other statement is bound to one workspace.
 */
/** An approved, enabled account's id, e-mail, version and test flag, or undefined. */
export function recipientAccount(store: Store, userId: string): JsonObject | undefined {
  return store
    .sql()
    .prepare('SELECT id,email,version,test_account FROM amcp_users WHERE id=? AND approved=1 AND disabled=0')
    .get(userId) as JsonObject | undefined;
}
/** The queued e-mail of a notice: its state, attempts, next attempt, expiry and last error, or undefined. */
export function noticeMail(store: Store, tenant: string, mailId: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(
      'SELECT state,attempts,available_at,expires_at,last_error FROM amcp_email_outbox WHERE id=? AND tenant_id=?',
    )
    .get(mailId, tenant) as JsonObject | undefined;
}
/** Queues a failed notice e-mail again (a confirmed recovery). */
export function requeueNoticeMail(store: Store, tenant: string, mailId: string, now = Date.now()) {
  store
    .sql()
    .prepare(
      "UPDATE amcp_email_outbox SET state='queued',available_at=?,last_error=NULL WHERE id=? AND tenant_id=? AND state='failed'",
    )
    .run(now, mailId, tenant);
}
/** Cancels a notice e-mail that has not been sent, clearing its sealed content. */
export function cancelNoticeMail(store: Store, tenant: string, mailId: string, reason: string) {
  store
    .sql()
    .prepare(
      "UPDATE amcp_email_outbox SET state='cancelled',secret='',lease_token=NULL,last_error=? WHERE id=? AND tenant_id=? AND state IN ('queued','sending','failed')",
    )
    .run(reason, mailId, tenant);
}
/** The 20 newest notices of a subscription (id, data, revision), newest first. */
export function subscriptionNotices(store: Store, tenant: string, subscriptionId: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id,data,revision FROM documents WHERE tenant_id=? AND kind='monitor_notice' AND json_extract(data,'$.subscription_id')=? ORDER BY json_extract(data,'$.created_at') DESC,id DESC LIMIT 20",
    )
    .all(tenant, subscriptionId) as JsonObject[];
}
/** The pending or queued notices (id, data) of a subscription. */
export function openSubscriptionNotices(store: Store, tenant: string, subscriptionId: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id,data FROM documents WHERE tenant_id=? AND kind='monitor_notice' AND json_extract(data,'$.subscription_id')=? AND json_extract(data,'$.state') IN ('pending','queued')",
    )
    .all(tenant, subscriptionId) as JsonObject[];
}
/** The pending or queued notices (id, data) of a monitor rule. */
export function openRuleNotices(store: Store, tenant: string, monitorId: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id,data FROM documents WHERE tenant_id=? AND kind='monitor_notice' AND json_extract(data,'$.monitor_id')=? AND json_extract(data,'$.state') IN ('pending','queued')",
    )
    .all(tenant, monitorId) as JsonObject[];
}
/** The enabled subscriptions (id, data) of a monitor rule's current version. */
export function currentRuleSubscriptions(
  store: Store,
  tenant: string,
  monitorId: string,
  ruleVersion: unknown,
): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id,data FROM documents WHERE tenant_id=? AND kind='monitor_subscription' AND json_extract(data,'$.monitor_id')=? AND json_extract(data,'$.enabled')=1 AND json_extract(data,'$.rule_version')=?",
    )
    .all(tenant, monitorId, ruleVersion as number) as JsonObject[];
}
/** How many of a workspace's notices have not expired at `now`. */
export function liveNoticeCount(store: Store, tenant: string, now = Date.now()): number {
  return Number(
    (
      store
        .sql()
        .prepare(
          "SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='monitor_notice' AND json_extract(data,'$.expires_at')>?",
        )
        .get(tenant, now) as JsonObject
    ).n,
  );
}
/** Expires every workspace's unsent notice e-mails and pending or queued notices whose lifetime ends by `before`. */
export function expireNotices(store: Store, before: number) {
  store
    .sql()
    .prepare(
      "UPDATE amcp_email_outbox SET state='expired',secret='',lease_token=NULL WHERE state IN ('queued','sending','failed') AND expires_at<=?",
    )
    .run(before);
  store
    .sql()
    .prepare(
      "UPDATE documents SET data=json_set(data,'$.state','expired'),revision=revision+1 WHERE kind='monitor_notice' AND json_extract(data,'$.state') IN ('pending','queued') AND json_extract(data,'$.expires_at')<=?",
    )
    .run(before);
}
/** Deletes every workspace's notices created before `before` (their 30-day retention, src/document-kinds.ts). */
export function deleteNoticesCreatedBefore(store: Store, before: number) {
  store
    .sql()
    .prepare("DELETE FROM documents WHERE kind='monitor_notice' AND json_extract(data,'$.created_at')<?")
    .run(before);
}
/** The oldest pending notice of any workspace that is due at `now` (tenant_id, id, data), or undefined. */
export function nextPendingNotice(store: Store, now = Date.now()): JsonObject | undefined {
  return store
    .sql()
    .prepare(
      "SELECT tenant_id,id,data FROM documents WHERE kind='monitor_notice' AND json_extract(data,'$.state')='pending' AND json_extract(data,'$.available_at')<=? ORDER BY json_extract(data,'$.created_at'),id LIMIT 1",
    )
    .get(now) as JsonObject | undefined;
}
