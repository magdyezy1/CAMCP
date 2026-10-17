import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, optional} from './workspace-core.js';
import {reportPlatforms} from './report-metrics.js';
import {sha256} from './security.js';
import {
  cancelNoticeMail,
  currentRuleSubscriptions,
  deleteNoticesCreatedBefore,
  expireNotices,
  liveNoticeCount,
  nextPendingNotice,
  noticeMail,
  openRuleNotices,
  openSubscriptionNotices,
  recipientAccount,
  requeueNoticeMail,
  subscriptionNotices,
} from './monitor-repository.js';

export const notificationActions = ['monitor_notifications', 'set_monitor_notifications', 'retry_monitor_notification'];
const day = 86400000;
const subscriptionId = (actor: Actor, monitor: string) => fingerprint({user: actor.ownerUserId, monitor});
export const monitorMailId = (id: string) => sha256('notice:monitor:' + id);
function access(store: Store, actor: Actor, monitor: JsonObject) {
  store.assertActorActive(actor);
  store.resolveConnection(actor, reportPlatforms[monitor.platform]!.gateway, monitor.account_id, monitor.connection_id);
}
function recipient(store: Store, actor: Actor) {
  store.assertActorActive(actor);
  if (!actor.ownerUserId || actor.testAccount)
    bad('Sign in with a verified personal account to enable email notices.', 'NOTIFICATION_ACCOUNT_REQUIRED');
  const user = recipientAccount(store, actor.ownerUserId);
  if (!user?.email || user.test_account)
    bad('A verified account email is required for notices.', 'NOTIFICATION_ACCOUNT_REQUIRED');
  return user;
}
function currentSubscription(store: Store, tenant: string, sub: JsonObject, monitor: JsonObject) {
  if (!sub.enabled || sub.rule_version !== monitor.rule_version)
    bad('Enable notices for the current rule version.', 'NOTIFICATION_SUBSCRIPTION_CHANGED');
  const actor = store.restoreJobActor(tenant, 'monitor-subscription:' + sub.id, sub.actor_binding);
  access(store, actor, monitor);
  const user = recipient(store, actor);
  if (user.id !== sub.user_id || fingerprint(user.email) !== sub.email_hash || user.version !== sub.account_version)
    bad('The recipient account changed. Confirm a new subscription.', 'NOTIFICATION_RECIPIENT_CHANGED');
  return {actor, user};
}
function deliveryRow(store: Store, tenant: string, n: JsonObject) {
  return noticeMail(store, tenant, monitorMailId(n.id));
}
function publicNotice(store: Store, tenant: string, n: JsonObject) {
  const mail = deliveryRow(store, tenant, n),
    state = mail?.state ?? n.state;
  return {
    record_kind: 'monitor_notice',
    id: n.id,
    monitor_id: n.monitor_id,
    incident_id: n.incident_id,
    event: n.event,
    state,
    created_at: n.created_at,
    expires_at: n.expires_at,
    attempts: mail?.attempts ?? 0,
    next_attempt_at: state === 'queued' ? mail?.available_at : null,
    reason: mail?.last_error ?? n.reason ?? null,
    retry_available:
      state === 'failed' && n.retryable === true && (mail?.attempts ?? 0) < 10 && n.expires_at > Date.now() + 60000,
    notification_version: fingerprint({revision: n.revision, mail: mail ?? null}),
    website_path: '/monitors?incident_id=' + encodeURIComponent(n.incident_id),
    next_call: {tool: 'amcp_workspace', arguments: {action: 'monitor_notifications', id: n.monitor_id}},
  };
}
export function monitorNotifications(store: Store, actor: Actor, input: JsonObject): JsonObject {
  store.assertActorActive(actor);
  if (input.action === 'retry_monitor_notification') {
    const n = store.document(actor.tenantId, 'monitor_notice', input.notification_id),
      monitor = store.document(actor.tenantId, 'report_monitor', n.monitor_id);
    access(store, actor, monitor);
    if (n.user_id !== actor.ownerUserId) bad('Only the subscribed recipient can recover this notice.', 'FORBIDDEN');
    return store.transaction(() => {
      const view = publicNotice(store, actor.tenantId, n);
      if (input.confirmed !== true) bad('Confirm recovery of this original notice.');
      if (view.notification_version !== input.notification_version)
        bad('Refresh this notice before recovery.', 'REVISION_CONFLICT');
      if (!view.retry_available)
        bad(
          'This notice cannot be retried. Inspect its reason and future incidents.',
          'NOTIFICATION_RETRY_UNAVAILABLE',
        );
      const checked = authorizeMonitorNotice(store, actor.tenantId, n);
      if (checked.defer_until)
        bad('This incident is snoozed. Resume attention before recovery.', 'NOTIFICATION_DEFERRED');
      // Requeued: no longer a failed notice in Operations until its delivery fails again (OPS-06).
      store.putDocument(actor.tenantId, 'monitor_notice', n.id, {
        ...n,
        attempt_limit: 10,
        delivery_state: null,
        delivery_error: null,
      });
      requeueNoticeMail(store, actor.tenantId, monitorMailId(n.id), Date.now());
      store.appendAudit(actor.tenantId, n.id, {event: 'monitor_notice_retried', user_id: actor.ownerUserId});
      return publicNotice(store, actor.tenantId, store.document(actor.tenantId, 'monitor_notice', n.id));
    });
  }
  const monitor = store.document(actor.tenantId, 'report_monitor', input.id);
  access(store, actor, monitor);
  const id = subscriptionId(actor, monitor.id);
  let sub = optional(store, actor.tenantId, 'monitor_subscription', id),
    user: JsonObject | undefined,
    reason: string | null = null;
  try {
    user = recipient(store, actor);
  } catch (e) {
    reason = (e as {code?: string}).code ?? 'NOTIFICATION_ACCOUNT_REQUIRED';
  }
  const version = fingerprint({
    monitor: monitor.rule_version,
    sub: sub?.revision ?? 0,
    user: user ? {id: user.id, version: user.version, email_hash: fingerprint(user.email)} : null,
  });
  if (input.action === 'set_monitor_notifications') {
    if (input.confirmed !== true || typeof input.enabled !== 'boolean')
      bad('Confirm whether to enable email notices to your own verified address.');
    if (input.subscription_version !== version)
      bad('Refresh the current rule and subscription before saving.', 'REVISION_CONFLICT');
    if (!user)
      bad('Sign in with a verified personal account to change email notices.', 'NOTIFICATION_ACCOUNT_REQUIRED');
    if (input.recipient !== undefined || input.email !== undefined || input.to !== undefined)
      bad('Notices can only go to your own verified account email.');
    if (!sub && store.repo('monitor_subscription', actor.tenantId).count() >= 1000)
      bad('The workspace has reached 1,000 saved monitor subscriptions.', 'NOTIFICATION_LIMIT');
    store.transaction(() => {
      // Reconfirmation intentionally creates a new generation; old pending notices cannot move to it.
      store.putDocument(actor.tenantId, 'monitor_subscription', id, {
        monitor_id: monitor.id,
        user_id: user!.id,
        enabled: input.enabled,
        rule_version: monitor.rule_version,
        generation: (sub?.generation ?? 0) + 1,
        email_hash: fingerprint(user!.email),
        account_version: user!.version,
        actor_binding: store.bindJobActor(actor, 'monitor-subscription:' + id),
        updated_at: Date.now(),
      });
      cancelSubscriptionNotices(store, actor.tenantId, id);
      store.appendAudit(actor.tenantId, id, {
        event: 'monitor_subscription_changed',
        enabled: input.enabled,
        monitor_id: monitor.id,
        user_id: user!.id,
      });
    });
    return monitorNotifications(store, actor, {...input, action: 'monitor_notifications'});
  }
  let enabled = false;
  if (sub?.enabled) {
    try {
      currentSubscription(store, actor.tenantId, sub, monitor);
      enabled = true;
    } catch (e) {
      reason = (e as {code?: string}).code ?? 'NOTIFICATION_ACCESS_REQUIRED';
    }
  }
  const notices = user ? subscriptionNotices(store, actor.tenantId, id) : [];
  return {
    record_kind: 'monitor_notifications',
    monitor_id: monitor.id,
    enabled,
    eligible: !!user,
    reason,
    subscription_version: version,
    rule_version: monitor.rule_version,
    destination: 'Your verified account email',
    website_path: '/monitors?monitor_id=' + encodeURIComponent(monitor.id),
    next_call: {tool: 'amcp_workspace', arguments: {action: 'monitor_notifications', id: monitor.id}},
    delivery_requires_configured_email_worker: true,
    meaning:
      'Explicit opt-in for future openings, reopenings and resolutions. Email contains a generic notice and a sign-in link. Five automatic attempts; one confirmed recovery allows up to ten total, within the original 24-hour lifetime. Provider acceptance does not prove inbox delivery.',
    deliveries: notices.map(n =>
      publicNotice(store, actor.tenantId, {...JSON.parse(n.data), id: n.id, revision: n.revision}),
    ),
  };
}
function cancelSubscriptionNotices(store: Store, tenant: string, id: string) {
  const rows = openSubscriptionNotices(store, tenant, id);
  for (const r of rows)
    cancelMonitorNotice(store, tenant, {...JSON.parse(r.data), id: r.id}, 'NOTIFICATION_SUBSCRIPTION_CHANGED');
}
export function cancelMonitorNotice(store: Store, tenant: string, n: JsonObject, reason: string) {
  cancelNoticeMail(store, tenant, monitorMailId(n.id), reason);
  store.putDocument(tenant, 'monitor_notice', n.id, {...n, state: 'cancelled', reason});
}
export function cancelMonitorRuleNotices(store: Store, tenant: string, id: string) {
  const rows = openRuleNotices(store, tenant, id);
  for (const r of rows)
    cancelMonitorNotice(store, tenant, {...JSON.parse(r.data), id: r.id}, 'NOTIFICATION_RULE_CHANGED');
}
/** Called inside the incident transaction. Intent only: no mail recipient, body or network call is persisted here. */
export function queueMonitorTransition(
  store: Store,
  tenant: string,
  monitor: JsonObject,
  incident: JsonObject,
  previous?: JsonObject,
) {
  if (previous?.state === incident.state || (incident.state !== 'resolved' && previous?.state === 'acknowledged'))
    return 0;
  const event = incident.state === 'resolved' ? 'resolved' : 'opened';
  const subs = currentRuleSubscriptions(store, tenant, monitor.id, monitor.rule_version);
  let remaining = 1000 - liveNoticeCount(store, tenant, Date.now()),
    queued = 0;
  for (const row of subs) {
    if (remaining <= 0) {
      store.appendAudit(tenant, monitor.id, {event: 'monitor_notice_capacity', retained_inbox: true});
      break;
    }
    const sub = {...JSON.parse(row.data), id: row.id};
    try {
      currentSubscription(store, tenant, sub, monitor);
    } catch {
      continue;
    }
    const id = fingerprint({
      subscription: sub.id,
      generation: sub.generation,
      incident: incident.id,
      episode: incident.notification_episode,
      event,
    });
    if (optional(store, tenant, 'monitor_notice', id)) continue;
    store.putDocument(tenant, 'monitor_notice', id, {
      subscription_id: sub.id,
      generation: sub.generation,
      monitor_id: monitor.id,
      user_id: sub.user_id,
      incident_id: incident.id,
      episode: incident.notification_episode,
      event,
      state: 'pending',
      attempt_limit: 5,
      created_at: Date.now(),
      available_at: Date.now(),
      expires_at: Date.now() + day,
    });
    remaining--;
    queued++;
  }
  return queued;
}
/** Run again immediately before provider dispatch, including every retry and reclaimed lease. */
export function authorizeMonitorNotice(store: Store, tenant: string, n: JsonObject) {
  if (!['pending', 'queued'].includes(n.state) || n.expires_at <= Date.now() + 60000)
    bad('The original notice expired or was cancelled.', 'NOTIFICATION_EXPIRED');
  const monitor = store.document(tenant, 'report_monitor', n.monitor_id),
    sub = store.document(tenant, 'monitor_subscription', n.subscription_id),
    incident = store.document(tenant, 'report_incident', n.incident_id);
  if (
    !monitor.active ||
    sub.generation !== n.generation ||
    sub.user_id !== n.user_id ||
    sub.monitor_id !== monitor.id ||
    incident.monitor_id !== monitor.id ||
    incident.rule_version !== monitor.rule_version ||
    incident.notification_episode !== n.episode ||
    incident.superseded_by_version ||
    (n.event === 'opened' ? incident.state !== 'open' : incident.state !== 'resolved')
  )
    bad('The current rule, subscription or incident no longer calls for this notice.', 'NOTIFICATION_SUPERSEDED');
  const {user} = currentSubscription(store, tenant, sub, monitor),
    owner = store.restoreJobActor(tenant, 'monitor:' + monitor.id, monitor.actor_binding);
  access(store, owner, monitor);
  if (
    !Number.isFinite(incident.observed_at) ||
    incident.observed_at > Date.now() ||
    Date.now() - incident.observed_at > monitor.max_age_hours * 3600000
  )
    bad('The incident evidence is stale.', 'NOTIFICATION_EVIDENCE_STALE');
  const source = store.document(tenant, 'overview_report', incident.last_report_id);
  if (
    !source.config?.sources?.some(
      (s: JsonObject) =>
        s.platform === monitor.platform &&
        s.account_id === monitor.account_id &&
        s.connection_id === monitor.connection_id,
    )
  )
    bad('The supporting snapshot is no longer available in this scope.', 'NOTIFICATION_EVIDENCE_CHANGED');
  return {
    user,
    defer_until: n.event === 'opened' && incident.snoozed_until > Date.now() ? incident.snoozed_until : null,
  };
}
export function pruneMonitorNotices(store: Store) {
  expireNotices(store, Date.now() + 60000);
  // Metadata expires after 30 days; intent creation and original delivery lifetime remain independently bounded.
  deleteNoticesCreatedBefore(store, Date.now() - 30 * day);
}
export function nextMonitorNotice(store: Store) {
  const row = nextPendingNotice(store, Date.now());
  if (!row) return;
  const n = {...JSON.parse(row.data), id: row.id};
  try {
    const checked = authorizeMonitorNotice(store, row.tenant_id, n);
    if (checked.defer_until) {
      store.putDocument(row.tenant_id, 'monitor_notice', n.id, {
        ...n,
        available_at: Math.min(checked.defer_until, n.expires_at),
      });
      return;
    }
    return {tenant: row.tenant_id as string, notice: n, email: checked.user.email as string};
  } catch (e) {
    cancelMonitorNotice(store, row.tenant_id, n, (e as {code?: string}).code ?? 'NOTIFICATION_ACCESS_REQUIRED');
    return;
  }
}
