import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {audit, bad, fingerprint, optional, read, update, validate, writer} from './workspace-core.js';
import {reportPlatforms} from './report-metrics.js';
import {MirrorError} from './errors.js';
import {
  monitorNotifications,
  notificationActions,
  queueMonitorTransition,
  cancelMonitorRuleNotices,
} from './monitor-delivery.js';
export const monitorActions = [
  ...notificationActions,
  'monitors',
  'monitor',
  'save_monitor',
  'set_monitor_state',
  'incidents',
  'incident',
  'acknowledge_incident',
  'snooze_incident',
  'resume_incident',
  'evaluate_monitors',
];
export function incidentAttention(p: JsonObject, at = Date.now()): string {
  if (p.state !== 'resolved' && p.superseded_by_version) return 'superseded';
  return p.state !== 'resolved' && Number.isFinite(p.snoozed_until) && p.snoozed_until > at ? 'snoozed' : p.state;
}
const publicMonitor = ({actor_binding, ...p}: JsonObject) => ({
  ...p,
  ...(p.monitor_id
    ? {
        record_kind: 'incident',
        attention_state: incidentAttention(p),
        website_path: '/monitors?incident_id=' + encodeURIComponent(p.id),
        next_call: {tool: 'amcp_workspace', arguments: {action: 'incident', id: p.id}},
      }
    : {record_kind: 'monitor', website_path: '/monitors?monitor_id=' + encodeURIComponent(p.id)}),
});
function access(store: Store, actor: Actor, p: JsonObject) {
  store.resolveConnection(actor, reportPlatforms[p.platform]!.gateway, p.account_id, p.connection_id);
}
export function evaluateMonitors(store: Store, actor: Actor, reportId: string) {
  const report = read(store, actor, 'overview_report', reportId),
    outcomes: JsonObject[] = [];
  for (const source of report.config.sources)
    store.resolveConnection(actor, reportPlatforms[source.platform]!.gateway, source.account_id, source.connection_id);
  if (!['complete', 'partial', 'failed'].includes(report.state)) bad('Evaluate a finished snapshot.');
  // Index retained row age once. Refiltering the complete report for every rule and summary is quadratic.
  const groupKey = (s: JsonObject) =>
    JSON.stringify([
      s.platform,
      s.account_id,
      s.currency,
      s.timezone,
      s.result_definition,
      s.attribution,
      s.date_from,
      s.date_to,
      s.objective_group,
    ]);
  const captured = new Map<string, number>();
  for (const row of report.rows ?? []) {
    const key = groupKey(row),
      observed = Number.isFinite(row.captured_at) ? row.captured_at : 0;
    captured.set(key, Math.min(captured.get(key) ?? Infinity, observed));
  }
  const monitors = store.documents(actor.tenantId, 'report_monitor').filter(p => p.active);
  for (const p of monitors) {
    if (
      !report.config.sources.some(
        (s: JsonObject) =>
          s.platform === p.platform && s.connection_id === p.connection_id && s.account_id === p.account_id,
      )
    )
      continue;
    const remember = (status: string) => {
      store.assertActorActive(actor);
      store.putDocument(actor.tenantId, 'report_monitor', p.id, {
        ...p,
        last_evaluation: {status, report_id: reportId, evaluated_at: Date.now()},
      });
    };
    let owner: Actor;
    try {
      owner = store.restoreJobActor(actor.tenantId, 'monitor:' + p.id, p.actor_binding);
      access(store, owner, p);
    } catch {
      outcomes.push({monitor_id: p.id, status: 'access_required'});
      remember('access_required');
      continue;
    }
    const groups = (report.summary ?? []).filter(
      (s: JsonObject) =>
        s.platform === p.platform &&
        s.account_id === p.account_id &&
        s.currency === p.currency &&
        s.timezone === p.timezone &&
        s.result_definition === p.result_definition &&
        s.attribution === p.attribution,
    );
    const eligible = groups
      .map((s: JsonObject) => ({...s, observed_at: captured.get(groupKey(s)) ?? 0}))
      .filter(
        (s: JsonObject) =>
          s.complete &&
          Number.isFinite(s.metrics[p.metric]) &&
          s.observed_at > 0 &&
          s.observed_at <= Date.now() &&
          Date.now() - s.observed_at <= p.max_age_hours * 3600000,
      );
    if (!eligible.length) {
      outcomes.push({
        monitor_id: p.id,
        status: 'data_unavailable',
        report_id: reportId,
        meaning: 'Missing, stale or incomplete evidence never resolves an open incident.',
      });
      remember('data_unavailable');
      continue;
    }
    const firstOutcome = outcomes.length;
    for (const g of eligible) {
      const value = g.metrics[p.metric],
        breached = p.comparison === 'above' ? value > Number(p.threshold) : value < Number(p.threshold);
      // One incident per rule revision and measurement window. A new snapshot updates evidence, never duplicates it.
      const id = fingerprint({
          monitor: p.id,
          revision: p.rule_version,
          window: [g.date_from, g.date_to],
          objective: g.objective_group,
        }),
        old = optional(store, actor.tenantId, 'report_incident', id);
      if (old && old.observed_at > g.observed_at) {
        outcomes.push({id, state: old.state, ignored: 'older_evidence'});
        continue;
      }
      if (old?.last_report_id === reportId) {
        outcomes.push({id, state: old.state, deduplicated: true});
        continue;
      }
      if (!breached && !old) {
        outcomes.push({monitor_id: p.id, status: 'within_threshold', value});
        continue;
      }
      const state = breached ? (old?.state === 'acknowledged' ? 'acknowledged' : 'open') : 'resolved';
      const incident = {
        ...(old ?? {}),
        monitor_id: p.id,
        rule_version: p.rule_version,
        monitor_name: p.name,
        state,
        platform: p.platform,
        connection_id: p.connection_id,
        account_id: p.account_id,
        currency: p.currency,
        timezone: p.timezone,
        result_definition: p.result_definition,
        attribution: p.attribution,
        metric: p.metric,
        comparison: p.comparison,
        threshold: p.threshold,
        value,
        date_from: g.date_from,
        date_to: g.date_to,
        opened_at: old?.opened_at ?? Date.now(),
        updated_at: Date.now(),
        observed_at: g.observed_at,
        last_report_id: reportId,
        evidence: [
          ...(old?.evidence ?? []).filter((e: JsonObject) => e.report_id !== reportId),
          {report_id: reportId, captured_at: g.observed_at, value, source_hash: fingerprint(g)},
        ].slice(-20),
        resolved_at: state === 'resolved' ? Date.now() : null,
        ...(state === 'resolved' || old?.state === 'resolved'
          ? {snoozed_until: null, acknowledged_at: null, acknowledged_by: null}
          : {}),
        delivery: 'workspace_inbox',
        automatic_advertising_changes: false,
        notification_episode: (old?.notification_episode ?? 1) + (breached && old?.state === 'resolved' ? 1 : 0),
      };
      store.assertActorActive(owner);
      const email_notices_queued = store.transaction(() => {
        store.putDocument(actor.tenantId, 'report_incident', id, incident);
        return queueMonitorTransition(store, actor.tenantId, p, {...incident, id}, old);
      });
      outcomes.push({id, monitor_id: p.id, state, value, report_id: reportId, email_notices_queued});
    }
    const evaluated = outcomes.slice(firstOutcome);
    remember(
      evaluated.some(o => ['open', 'acknowledged'].includes(o.state))
        ? 'incident_active'
        : evaluated.every(o => o.ignored === 'older_evidence')
          ? 'older_evidence_ignored'
          : 'within_threshold',
    );
  }
  return {report_id: reportId, outcomes, network_requests: 0, delivery: 'workspace_inbox'};
}
export function monitorOperation(store: Store, actor: Actor, input: JsonObject): JsonObject {
  store.assertActorActive(actor);
  if (notificationActions.includes(input.action)) return monitorNotifications(store, actor, input);
  if (input.action === 'evaluate_monitors') return evaluateMonitors(store, actor, input.report_id);
  if (input.action === 'incident' || input.action === 'monitor') {
    const p = read(store, actor, input.action === 'incident' ? 'report_incident' : 'report_monitor', input.id);
    access(store, actor, p);
    return publicMonitor(p);
  }
  if (input.action === 'monitors' || input.action === 'incidents') {
    const kind = input.action === 'monitors' ? 'report_monitor' : 'report_incident';
    const state = input.state ?? 'all',
      search = input.search ?? '';
    if (
      !(
        kind === 'report_monitor'
          ? ['all', 'active', 'paused']
          : ['all', 'open', 'acknowledged', 'snoozed', 'resolved', 'superseded']
      ).includes(state)
    )
      bad('Choose a valid inbox or monitor state.');
    if (typeof search !== 'string' || search.length > 200) bad('Search is limited to 200 characters.');
    for (const key of ['account_id', 'connection_id', 'gateway'])
      if (input[key] !== undefined && typeof input[key] !== 'string') bad('Use an exact ' + key + '.');
    const rows = store
      .documents(actor.tenantId, kind)
      .filter(p => {
        try {
          access(store, actor, p);
          return true;
        } catch (e) {
          if (!(e instanceof MirrorError)) throw e;
          return false;
        }
      })
      .filter(
        p =>
          (state === 'all' ||
            state === (kind === 'report_monitor' ? (p.active ? 'active' : 'paused') : incidentAttention(p))) &&
          (!input.account_id || p.account_id === input.account_id) &&
          (!input.connection_id || p.connection_id === input.connection_id) &&
          (!input.gateway || reportPlatforms[p.platform]?.gateway === input.gateway) &&
          [p.name, p.monitor_name, p.account_id, p.platform]
            .join(' ')
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      )
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.id.localeCompare(b.id));
    const offset = input.offset ?? 0,
      limit = input.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      bad('Use an offset and a limit of 1–100.');
    return {
      [input.action]: rows.slice(offset, offset + limit).map(publicMonitor),
      total: rows.length,
      has_more: offset + limit < rows.length,
      next_offset: offset + limit < rows.length ? offset + limit : null,
      offset,
      website_path: '/monitors',
    };
  }
  writer(store, actor);
  if (input.action === 'save_monitor') {
    const p = input.monitor;
    validate(p ?? {}, [
      'name',
      'platform',
      'connection_id',
      'account_id',
      'currency',
      'timezone',
      'result_definition',
      'attribution',
      'metric',
      'comparison',
      'threshold',
      'max_age_hours',
    ]);
    if (!reportPlatforms[p.platform] || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100)
      bad('Name the monitor and choose a reporting platform.');
    if (
      !['spend', 'clicks', 'conversions', 'cpa'].includes(p.metric) ||
      !['above', 'below'].includes(p.comparison) ||
      !/^\d+(\.\d{1,6})?$/.test(String(p.threshold)) ||
      Number(p.threshold) > Number.MAX_SAFE_INTEGER
    )
      bad('Use an additive metric or CPA, above/below and a nonnegative decimal threshold.');
    for (const k of ['currency', 'timezone', 'result_definition', 'attribution'])
      if (typeof p[k] !== 'string' || !p[k].trim() || p[k] === 'unknown' || p[k].length > 200)
        bad('Declare the exact ' + k + ' from a retained report.');
    if (!/^[A-Z]{3}$/.test(p.currency)) bad('Use an ISO currency.');
    try {
      new Intl.DateTimeFormat('en', {timeZone: p.timezone});
    } catch {
      bad('Use an IANA timezone.');
    }
    if (!Number.isInteger(p.max_age_hours) || p.max_age_hours < 1 || p.max_age_hours > 168)
      bad('Evidence age must be 1–168 hours.');
    if (input.confirmed !== true) bad('Confirm the monitor rule and its workspace inbox destination.');
    access(store, actor, p);
    const id = input.id ?? randomUUID(),
      old = optional(store, actor.tenantId, 'report_monitor', id);
    if (old) access(store, actor, old);
    if (!old && store.documents(actor.tenantId, 'report_monitor').length >= 100) bad('Limit reached: 100 monitors.');
    return store.transaction(() => {
      const result = update(
        store,
        actor,
        'report_monitor',
        id,
        {
          ...p,
          threshold: String(p.threshold),
          active: old?.active ?? true,
          rule_version: (old?.rule_version ?? 0) + 1,
          actor_binding: store.bindJobActor(actor, 'monitor:' + id),
          updated_at: Date.now(),
          delivery: 'workspace_inbox',
        },
        input.revision,
      );
      // Revised rules cannot evaluate old-version incident IDs. Retain their factual state and evidence,
      // but explicitly retire their attention instead of presenting them as current unresolved alerts.
      const superseded = old
        ? Number(
            store.db
              .prepare(
                "UPDATE documents SET data=json_set(data,'$.superseded_by_version',?,'$.superseded_at',?,'$.snoozed_until',NULL,'$.updated_at',?),revision=revision+1 WHERE tenant_id=? AND kind='report_incident' AND json_extract(data,'$.monitor_id')=? AND coalesce(json_extract(data,'$.rule_version'),0)<? AND json_extract(data,'$.state')!='resolved' AND json_extract(data,'$.superseded_by_version') IS NULL",
              )
              .run(result.rule_version, Date.now(), Date.now(), actor.tenantId, id, result.rule_version).changes,
          )
        : 0;
      audit(store, actor, 'monitor_saved', {id, rule_version: result.rule_version, superseded_incidents: superseded});
      if (old) cancelMonitorRuleNotices(store, actor.tenantId, id);
      return {...publicMonitor(result), superseded_incidents: superseded};
    });
  }
  const kind = ['acknowledge_incident', 'snooze_incident', 'resume_incident'].includes(input.action)
      ? 'report_incident'
      : 'report_monitor',
    p = read(store, actor, kind, input.id);
  access(store, actor, p);
  if (kind === 'report_incident') {
    if (p.state === 'resolved') bad('This incident is already resolved by evidence.');
    if (p.superseded_by_version) bad('This rule version has been superseded. Inspect the current monitor rule.');
    const at = Date.now();
    if (
      input.action === 'snooze_incident' &&
      (!Number.isInteger(input.snooze_hours) || input.snooze_hours < 1 || input.snooze_hours > 168)
    )
      bad('Snooze for a whole number of hours from 1 to 168.');
    const change =
      input.action === 'acknowledge_incident'
        ? {state: 'acknowledged', acknowledged_by: actor.userId, acknowledged_at: at}
        : input.action === 'snooze_incident'
          ? {snoozed_until: at + input.snooze_hours * 3600000, snoozed_by: actor.userId}
          : {snoozed_until: null};
    return store.transaction(() => {
      const result = update(store, actor, kind, p.id, {...p, ...change, updated_at: at}, input.revision);
      audit(
        store,
        actor,
        input.action === 'acknowledge_incident'
          ? 'incident_acknowledged'
          : input.action === 'snooze_incident'
            ? 'incident_snoozed'
            : 'incident_resumed',
        {id: p.id, ...(input.action === 'snooze_incident' ? {snoozed_until: change.snoozed_until} : {})},
      );
      return publicMonitor(result);
    });
  }
  if (input.action !== 'set_monitor_state') bad('Choose a supported monitor operation.');
  if (input.confirmed !== true || typeof input.active !== 'boolean') bad('Confirm whether to enable this monitor.');
  return store.transaction(() => {
    const result = update(
      store,
      actor,
      kind,
      p.id,
      {...p, active: input.active, actor_binding: store.bindJobActor(actor, 'monitor:' + p.id), updated_at: Date.now()},
      input.revision,
    );
    if (!input.active) cancelMonitorRuleNotices(store, actor.tenantId, p.id);
    return publicMonitor(result);
  });
}
