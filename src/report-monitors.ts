import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {audit, bad, fingerprint, optional, read, update, validate, writer} from './workspace-core.js';
import {reportPlatforms} from './report-metrics.js';
export const monitorActions = [
  'monitors',
  'save_monitor',
  'set_monitor_state',
  'incidents',
  'acknowledge_incident',
  'evaluate_monitors',
];
const publicMonitor = ({actor_binding, ...p}: JsonObject) => p;
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
        ...(state === 'resolved' ? {resolved_at: Date.now()} : {}),
        delivery: 'workspace_inbox',
        automatic_advertising_changes: false,
      };
      store.assertActorActive(owner);
      store.putDocument(actor.tenantId, 'report_incident', id, incident);
      outcomes.push({id, monitor_id: p.id, state, value, report_id: reportId});
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
  if (input.action === 'evaluate_monitors') return evaluateMonitors(store, actor, input.report_id);
  if (input.action === 'monitors' || input.action === 'incidents') {
    const kind = input.action === 'monitors' ? 'report_monitor' : 'report_incident';
    const rows = store
      .documents(actor.tenantId, kind)
      .filter(p => {
        try {
          access(store, actor, p);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    const offset = input.offset ?? 0,
      limit = input.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      bad('Use an offset and a limit of 1–100.');
    return {
      [input.action]: rows.slice(offset, offset + limit).map(publicMonitor),
      total: rows.length,
      has_more: offset + limit < rows.length,
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
    if (!old && store.documents(actor.tenantId, 'report_monitor').length >= 100) bad('Limit reached: 100 monitors.');
    const result = update(
      store,
      actor,
      'report_monitor',
      id,
      {
        ...p,
        threshold: String(p.threshold),
        active: true,
        rule_version: (old?.rule_version ?? 0) + 1,
        actor_binding: store.bindJobActor(actor, 'monitor:' + id),
        updated_at: Date.now(),
        delivery: 'workspace_inbox',
      },
      input.revision,
    );
    audit(store, actor, 'monitor_saved', {id, rule_version: result.rule_version});
    return publicMonitor(result);
  }
  const kind = input.action === 'acknowledge_incident' ? 'report_incident' : 'report_monitor',
    p = read(store, actor, kind, input.id);
  access(store, actor, p);
  if (input.action === 'acknowledge_incident') {
    if (p.state === 'resolved') bad('This incident is already resolved by evidence.');
    return update(
      store,
      actor,
      kind,
      p.id,
      {...p, state: 'acknowledged', acknowledged_by: actor.userId, acknowledged_at: Date.now()},
      input.revision,
    );
  }
  if (input.confirmed !== true || typeof input.active !== 'boolean') bad('Confirm whether to enable this monitor.');
  return publicMonitor(
    update(
      store,
      actor,
      kind,
      p.id,
      {...p, active: input.active, actor_binding: store.bindJobActor(actor, 'monitor:' + p.id), updated_at: Date.now()},
      input.revision,
    ),
  );
}
