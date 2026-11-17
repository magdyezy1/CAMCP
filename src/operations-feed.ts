import {operationCategory, operationKinds, operationStates} from './operation-types.js';
export {operationKinds, operationStates} from './operation-types.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {ownsRecord} from './actor-identity.js';
import {MirrorError} from './errors.js';
import {bad, fingerprint} from './workspace-core.js';
import {reportPlatforms} from './report-metrics.js';
import {assertAccountWrite} from './write-access.js';
import {normalizeAccount} from './scope.js';
import {incidentAttention} from './report-monitors.js';
import {reportRunScope} from './report-runs.js';
import {writeHandoff, writeRecordState} from './write-records.js';
import {feedDocumentKinds, operationsFeedRows} from './operations-feed-repository.js';
import {optionalClientView} from './client-scope.js';

/** A report source names its platform rather than its gateway. */
const sourceGateway = (s: JsonObject) => s.gateway ?? reportPlatforms[s.platform]?.gateway;
const scanLimit = 500;
// In operationKinds order: each feed kind is the record kind of the operation kind at the same index.
const feedKinds = [
  ...feedDocumentKinds,
  'workbook_report',
  'workbook_schedule',
  'write_review',
  'monitor_notice',
  'connection',
];
// The feed query projects only metadata in SQLite (src/operations-feed-repository.ts, ARC-02).

/** A failed notice can be recovered only within its 24 hours; afterwards it stays undelivered, for the record. */
const noticeState = (p: JsonObject, at: number) =>
  p.state === 'expired' || (typeof p.expires_at === 'number' && p.expires_at <= at) ? 'undelivered' : 'failed';
function handoff(kind: string, id: string, p: JsonObject, state: string) {
  const encoded = encodeURIComponent(id);
  if (kind === 'write') return writeHandoff(id);
  // The rule's own email-notice section holds the delivery history and its one confirmed retry; the incident beside it.
  if (kind === 'notice')
    return {
      website_path:
        '/monitors?monitor_id=' +
        encodeURIComponent(String(p.monitor_id ?? '')) +
        '&incident_id=' +
        encodeURIComponent(String(p.incident_id ?? '')),
      next_call: {tool: 'amcp_workspace', arguments: {action: 'monitor_notifications', id: p.monitor_id}},
      next_safe_action:
        state === 'undelivered'
          ? 'This notice is past its 24 hours and cannot be sent again. The incident itself stays in the monitoring inbox.'
          : 'Inspect this notice on its monitor rule. Where recovery is offered, it resends the original notice once within its 24 hours; the incident itself stays in the monitoring inbox.',
    };
  if (kind === 'connection')
    return {
      website_path: '/connections?connection_id=' + encoded,
      next_call: {
        tool: 'amcp_workspace',
        arguments: {action: 'dashboard', sections: ['connections'], connection_id: id},
      },
      next_safe_action:
        state === 'disabled'
          ? 'An administrator turns this connection on again from Connections; reads and reviewed changes through it stop until then.'
          : state === 'refresh_failed'
            ? 'AMCP renews this login again after a back-off. If it keeps failing, an administrator chooses Retry or reauthorizes it in place from Connections.'
            : 'Ask an administrator to reauthorize this login in place from Connections (Manage, then Reauthorize). It keeps the connection, its selections and saved reports; no provider request is sent until then.',
    };
  if (kind === 'workbook_schedule')
    return {
      website_path: '/operations?workbook_schedule_id=' + encoded,
      next_call: {tool: 'amcp_workspace', arguments: {action: 'report_schedule', id}},
      next_safe_action:
        'Inspect the current query revision, clock settings and future occurrences before changing this local reporting schedule.',
    };
  if (kind === 'workbook_report')
    return {
      website_path: '/operations?run_id=' + encoded,
      next_call: {tool: 'amcp_workspace', arguments: {action: 'report_run', id}},
      next_safe_action:
        'Inspect this original workbook run, retained query revision and current access before retrieving results or resuming collection.',
    };
  if (kind === 'campaign')
    return {
      website_path: '/campaigns?id=' + encoded,
      next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id}},
      next_safe_action: 'Inspect the original plan, step receipts and required approvals before continuing.',
    };
  if (kind === 'upload')
    return {
      website_path: '/media?review_id=' + encoded,
      next_call: {tool: 'amcp_media', arguments: {action: 'recovery', review_id: id}},
      next_safe_action:
        'Inspect this original review and retained receipt. Recovery decides whether the same upload can resume.',
    };
  if (kind === 'incident')
    return {
      website_path: '/monitors?incident_id=' + encoded,
      next_call: {tool: 'amcp_workspace', arguments: {action: 'incident', id}},
      next_safe_action: 'Inspect the measurement context and evidence before acknowledging or deferring attention.',
    };
  if (kind === 'schedule')
    return {
      website_path: '/schedules?schedule_id=' + encoded,
      next_call: {tool: 'amcp_reporting_overview', arguments: {action: 'preview_schedule', id}},
      next_safe_action: 'Inspect the schedule, current access and destination before resuming delivery.',
    };
  return {
    website_path: '/reporting-overview?report_id=' + encodeURIComponent(kind === 'export' ? p.report_id : id),
    next_call: {
      tool: 'amcp_reporting_overview',
      arguments: {action: kind === 'export' ? 'export_status' : 'get', id, ...(kind === 'report' ? {limit: 1} : {})},
    },
    next_safe_action:
      kind === 'export'
        ? 'Inspect the original delivery job and destination receipt before an explicit retry.'
        : 'Inspect collection evidence, completeness and retained delivery receipts.',
  };
}
export function operationsPage(store: Store, actor: Actor, input: JsonObject, allowWrites: boolean) {
  store.assertActorActive(actor);
  const kind = input.kind ?? 'all',
    state = input.state ?? 'all',
    search = input.search ?? '',
    limit = input.limit ?? 30;
  if (!['all', ...operationKinds].includes(kind) || !operationStates.includes(state))
    bad('Choose a supported operation kind and attention state.');
  if (typeof search !== 'string' || search.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    bad('Use a search up to 200 characters and a page size of 1–100.');
  for (const key of ['account_id', 'connection_id'])
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 200))
      bad('Use an exact ' + key + '.');
  // The working client (SEC-08): only work naming an account the client profile binds, within current access.
  const client = optionalClientView(store, actor, input.profile_id);
  const filters = {
    kind,
    state,
    search: search.trim().toLowerCase(),
    account_id: input.account_id ?? '',
    connection_id: input.connection_id ?? '',
    ...(client ? {profile_id: client.profile_id} : {}),
  };
  const binding = fingerprint({
    tenant: actor.tenantId,
    user: actor.userId,
    role: actor.role,
    session: store.sessionIdentity(actor) ?? null,
    filters,
  });
  let after: JsonObject | null = null;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 1024) throw Error();
      after = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (
        after?.version !== 1 ||
        after.binding !== binding ||
        !Number.isSafeInteger(after.at) ||
        after.at < 0 ||
        !feedKinds.includes(after.kind) ||
        typeof after.id !== 'string' ||
        after.id.length > 160
      )
        throw Error();
    } catch {
      bad('Use the next_cursor from this identity and exact set of filters, or refresh the feed.', 'INVALID_CURSOR');
    }
  }
  const selectedKind = feedKinds[operationKinds.indexOf(kind)] ?? null;
  const at = Date.now();
  const rows = operationsFeedRows(
    store,
    actor.tenantId,
    at,
    selectedKind,
    after as {at: number; kind: string; id: string} | null,
  );

  const operations: JsonObject[] = [];
  let last: JsonObject | undefined,
    hasMore = false;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (index === scanLimit) {
      hasMore = true;
      break;
    }
    const p = JSON.parse(row.metadata),
      k = operationKinds[feedKinds.indexOf(row.kind)]!;
    let permitted = true;
    if (k === 'campaign' && !ownsRecord(actor, p) && actor.role !== 'admin') permitted = false;
    // An upload review stays with the credential that prepared it, like every write review: its recovery refuses others.
    if (k === 'upload' && (p.user_id !== actor.userId || actor.role === 'reader' || !allowWrites)) permitted = false;
    // A standalone review is its maker's (the credential, or the same person), or an administrator's (WRT-08).
    if (k === 'write' && p.user_id !== actor.userId && !ownsRecord(actor, p) && actor.role !== 'admin')
      permitted = false;
    // A monitor notice is its subscriber's own, like its delivery history (OPS-06).
    if (k === 'notice' && (!actor.ownerUserId || p.user_id !== actor.ownerUserId)) permitted = false;
    let scopes = typeof p.scopes === 'string' ? JSON.parse(p.scopes) : p.scopes;
    // A login's state is for administrators only; its accounts name it, without reading them (OPS-06).
    if (k === 'connection') {
      const accounts = typeof p.accounts === 'string' ? JSON.parse(p.accounts) : p.accounts;
      scopes = (Array.isArray(accounts) ? accounts : [])
        .filter((a: unknown): a is string => typeof a === 'string')
        .map((account_id: string) => ({gateway: p.gateway, connection_id: row.id, account_id}));
      if (actor.role !== 'admin') permitted = false;
    }
    if (['workbook_report', 'workbook_schedule'].includes(k)) {
      try {
        scopes = [reportRunScope(store, actor, p)];
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        permitted = false;
        scopes = [];
      }
    }
    if (k !== 'connection' && (!Array.isArray(scopes) || !scopes.length || scopes.length > 50)) permitted = false;
    if (permitted && k !== 'connection') {
      try {
        for (const s of scopes) {
          const gateway = sourceGateway(s);
          if (
            !gateway ||
            typeof s.account_id !== 'string' ||
            !s.account_id ||
            typeof s.connection_id !== 'string' ||
            !s.connection_id
          ) {
            permitted = false;
            break;
          }
          const c = store.resolveConnection(actor, gateway, s.account_id, s.connection_id);
          if (k === 'upload') assertAccountWrite(store, c, normalizeAccount(gateway, s.account_id));
        }
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        permitted = false;
      }
    }
    const attentionState =
      k === 'incident'
        ? incidentAttention(p, at)
        : k === 'write'
          ? writeRecordState(p, at)
          : k === 'notice'
            ? noticeState(p, at)
            : (p.state ?? 'unknown');
    const group = operationCategory(k, attentionState);
    const matches =
      permitted &&
      (state === 'all' || state === group) &&
      ((k === 'connection' &&
        !filters.account_id &&
        !client &&
        (!filters.connection_id || filters.connection_id === row.id)) ||
        scopes.some(
          (s: JsonObject) =>
            (!filters.account_id || s.account_id === filters.account_id) &&
            (!filters.connection_id || s.connection_id === filters.connection_id) &&
            (!client || client.has(sourceGateway(s), s.account_id, s.connection_id)),
        )) &&
      (!filters.search ||
        [row.id, p.name, ...scopes.map((s: JsonObject) => s.account_id)]
          .join(' ')
          .toLowerCase()
          .includes(filters.search));
    if (matches && operations.length === limit) {
      hasMore = true;
      break;
    }
    last = row;
    if (!matches) continue;
    operations.push({
      key: k + ':' + row.id,
      kind: k,
      id: row.id,
      revision: row.revision,
      name: String(p.name ?? row.id).slice(0, 200),
      state: attentionState,
      source_state: k === 'write' ? (p.claim_state ?? 'none') : (p.source_state ?? p.state),
      category: group,
      updated_at: row.at || null,
      accounts: [...new Set(scopes.map((s: JsonObject) => s.account_id))].slice(0, 50),
      ...(typeof p.error_code === 'string' && /^[A-Z0-9_]{1,100}$/.test(p.error_code)
        ? {error_code: p.error_code}
        : {}),
      // What the read-only check of an uncertain write found, the person's or the worker's (R2.5 M2): a closed token.
      ...(k === 'write' && ['appears_applied', 'appears_not_applied', 'indeterminate'].includes(p.reconciliation)
        ? {reconciliation: {classification: p.reconciliation, automatic: p.reconciliation_automatic === 1}}
        : {}),
      ...(k === 'incident' && attentionState === 'snoozed' ? {snoozed_until: p.snoozed_until} : {}),
      ...(['schedule', 'workbook_schedule'].includes(k) && ['active', 'attention'].includes(p.state)
        ? {next_run_at: p.next_run_at}
        : {}),
      ...handoff(k, row.id, p, attentionState),
      automatic_retry_of_mutation: false,
    });
  }
  store.assertActorActive(actor);
  return {
    operations,
    has_more: hasMore,
    next_cursor:
      hasMore && last
        ? Buffer.from(JSON.stringify({version: 1, binding, at: last.at, kind: last.kind, id: last.id})).toString(
            'base64url',
          )
        : null,
    coverage: operationKinds,
    filters,
    network_requests: 0,
    captured_at: at,
    website_path: '/operations',
    meaning:
      'Retained campaign plans, upload reviews, reporting snapshots, export jobs, overview schedules, incidents, workbook report runs/schedules, standalone reviewed writes and your failed monitor email notices with identifiable account scope within current access, and for administrators logins that need reauthorization, keep failing to renew or are turned off. This is a live metadata feed, not an immutable audit history. Updates can move rows between pages; refresh to see the latest state. An empty page can still have a continuation. Each continuation checks current access again.',
  };
}
