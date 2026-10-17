import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {bad, fingerprint, obj} from './workspace-core.js';
import {workspaceOwner} from './spend-policy.js';
import {reportPlatforms} from './report-metrics.js';
import {normalizeAccount} from './scope.js';
import {activityReportErrors} from './report-errors.js';
import {redact} from './security.js';
import {optionalClientView} from './client-scope.js';
import {auditDetails, auditPage, newestAuditSeq} from './audit-repository.js';

// The audit projections are in the store layer (src/audit-repository.ts, ARC-02).
const safeText = (v: unknown, max = 200) => {
  if (typeof v !== 'string' || !v || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) return undefined;
  return String(redact(v)).replace(
    /\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
    '[REDACTED]',
  );
};
const identifier = (v: unknown, max = 100) => {
  const value = safeText(v, max);
  return value && /^[A-Za-z0-9_./:-]+$/.test(value) ? value : undefined;
};
function one(values: unknown[], max: number, normalize = (v: string) => v): string | undefined {
  const actual = values.filter(v => v !== null && v !== undefined);
  if (actual.some(v => !safeText(v, max))) throw Error('Ambiguous scope');
  const unique = new Set(actual.map(v => normalize(v as string)));
  if (unique.size > 1) throw Error('Conflicting scope');
  return unique.values().next().value;
}
function scope(metadata: JsonObject) {
  const gateway = one(
      [...metadata.gateways, metadata.platform ? reportPlatforms[metadata.platform]?.gateway : undefined],
      100,
    ),
    account = one(metadata.accounts, 200, v => (gateway ? normalizeAccount(gateway, v) : v)),
    connection = one(metadata.connections, 200);
  return {gateway, account_id: account, connection_id: connection};
}
function allowed(store: Store, actor: Actor, s: JsonObject, localActor?: unknown) {
  if (!s.gateway || !s.account_id) return localActor === actor.userId && !s.account_id;
  if (
    !safeText(s.gateway, 100) ||
    !safeText(s.account_id) ||
    (s.connection_id !== undefined && !safeText(s.connection_id))
  )
    return false;
  try {
    store.resolveConnection(actor, s.gateway, s.account_id, s.connection_id);
    return true;
  } catch (e) {
    if (e instanceof MirrorError) return false;
    throw e;
  }
}
function diagnosticProjection(d: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of [
    'operation',
    'platform',
    'connection_id',
    'account_id',
    'asset_kind',
    'code',
    'message',
    'next_action',
    'login_customer_id',
  ]) {
    const value = safeText(d[key], ['message', 'next_action'].includes(key) ? 1200 : 200);
    if (value !== undefined) out[key] = value;
  }
  if (d.login_customer_id === null) out.login_customer_id = null;
  if (typeof d.retryable === 'boolean') out.retryable = d.retryable;
  if (Number.isInteger(d.http_status) && d.http_status >= 100 && d.http_status <= 599) out.http_status = d.http_status;
  if (obj(d.provider)) {
    const provider: JsonObject = {};
    for (const key of ['code', 'message', 'request_id']) {
      const value = safeText(d.provider[key], key === 'message' ? 1200 : 200);
      if (value !== undefined) provider[key] = value;
    }
    if (Array.isArray(d.provider.errors))
      provider.errors = d.provider.errors.slice(0, 10).map((row: unknown) => {
        const error: JsonObject = {};
        if (obj(row))
          for (const key of ['code', 'message', 'field']) {
            const v = safeText(row[key], key === 'message' ? 1200 : 200);
            if (v) error[key] = v;
          }
        return error;
      });
    if (Object.keys(provider).length) out.provider = provider;
  }
  if (obj(d.request)) {
    const request: JsonObject = {};
    for (const key of ['stage', 'method', 'path']) {
      const v = safeText(d.request[key], key === 'path' ? 500 : 40);
      if (v) request[key] = key === 'path' ? v.split(/[?#]/)[0] : v;
    }
    if (Object.keys(request).length) out.request = request;
  }
  return out;
}
function diagnostics(store: Store, actor: Actor, row: JsonObject, event: JsonObject, owner: boolean) {
  const details = auditDetails(store, actor.tenantId, row.seq);
  const input: JsonObject = {
    event: event.event,
    connection_id: event.connection_id,
    request: {
      gateway: event.gateway,
      accountId: event.account_id,
      action: event.action,
      method: details.method,
      path: details.path,
    },
    ...(details.error ? {error: JSON.parse(details.error)} : {}),
    ...(details.diagnostics ? {diagnostics: JSON.parse(details.diagnostics)} : {}),
  };
  let bytes = 0;
  return activityReportErrors(input)
    .slice(0, 20)
    .filter(
      d =>
        owner ||
        allowed(store, actor, {
          gateway: reportPlatforms[d.platform]?.gateway,
          account_id: d.account_id,
          connection_id: d.connection_id,
        }),
    )
    .map(diagnosticProjection)
    .filter(d => {
      const size = Buffer.byteLength(JSON.stringify(d));
      if (bytes + size > 32768) return false;
      bytes += size;
      return true;
    });
}

/** Current-access metadata history. The retained append-only event and integrity chain are never rewritten. */
export function auditHistoryPage(store: Store, actor: Actor, input: JsonObject): JsonObject {
  store.assertActorActive(actor);
  const limit = input.limit ?? 100,
    search = input.search ?? '';
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof search !== 'string' || search.length > 200)
    bad('History pages contain 1–100 events and search is at most 200 characters.');
  for (const key of ['gateway', 'account_id', 'connection_id'])
    if (input[key] !== undefined && !safeText(input[key], key === 'gateway' ? 100 : 200))
      bad('Use an exact ' + key + '.');
  // The working client (SEC-08): only events naming an account the client profile binds, within current access.
  const client = optionalClientView(store, actor, input.profile_id);
  const filters = {
      search: search.trim().toLowerCase(),
      gateway: input.gateway ?? '',
      account_id: input.account_id ?? '',
      connection_id: input.connection_id ?? '',
      ...(client ? {profile_id: client.profile_id} : {}),
    },
    owner = workspaceOwner(store, actor),
    binding = fingerprint({
      tenant: actor.tenantId,
      user: actor.userId,
      role: actor.role,
      owner,
      session: store.sessionIdentity(actor) ?? null,
      filters,
      limit,
    });
  let ceiling = newestAuditSeq(store, actor.tenantId),
    before = Number.MAX_SAFE_INTEGER;
  if (input.cursor !== undefined)
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
        throw Error();
      const bytes = Buffer.from(input.cursor, 'base64url');
      if (bytes.toString('base64url') !== input.cursor) throw Error();
      const c = JSON.parse(bytes.toString('utf8'));
      if (
        !obj(c) ||
        c.version !== 1 ||
        c.binding !== binding ||
        !Number.isSafeInteger(c.ceiling) ||
        c.ceiling < 0 ||
        c.ceiling > ceiling ||
        !Number.isSafeInteger(c.before) ||
        c.before <= 0 ||
        c.before > c.ceiling
      )
        throw Error();
      ceiling = c.ceiling;
      before = c.before;
    } catch {
      bad(
        'Refresh history or use the returned cursor with the same identity, filters and page size.',
        'INVALID_CURSOR',
      );
    }
  const rows = auditPage(store, actor.tenantId, ceiling, before),
    events: JsonObject[] = [];
  let last: number | undefined,
    more = false,
    bytes = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (index === 500) {
      more = true;
      break;
    }
    const m = JSON.parse(row.metadata);
    let s: JsonObject;
    try {
      s = scope(m);
    } catch {
      last = row.seq;
      continue;
    }
    const name = identifier(m.event) ?? 'workspace_event',
      action = identifier(m.action, 200),
      requestId = identifier(row.request_id, 200);
    if (
      (!owner && !allowed(store, actor, s, m.actor)) ||
      (filters.gateway && s.gateway !== filters.gateway) ||
      (filters.account_id && (!s.gateway || s.account_id !== normalizeAccount(s.gateway, filters.account_id))) ||
      (filters.connection_id && s.connection_id !== filters.connection_id) ||
      (client && !client.has(s.gateway, s.account_id, s.connection_id)) ||
      (filters.search && ![name, action, requestId].filter(Boolean).join(' ').toLowerCase().includes(filters.search))
    ) {
      last = row.seq;
      continue;
    }
    if (events.length === limit) {
      more = true;
      break;
    }
    const event: JsonObject = {
      id: row.seq,
      at: row.created_at,
      event: name,
      ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)),
      ...(identifier(m.platform, 80) ? {platform: m.platform} : {}),
      ...(action ? {action} : {}),
      ...(requestId ? {request_id: requestId} : {}),
    };
    if (m.complete !== null) event.complete = m.complete === 1;
    if (Number.isSafeInteger(m.vendor_writes) && m.vendor_writes >= 0) event.vendor_writes = m.vendor_writes;
    if (identifier(m.error_code))
      event.error = {code: m.error_code, message: 'Inspect the scoped diagnostic or original work for details.'};
    event.diagnostics = diagnostics(store, actor, row, event, owner);
    const size = Buffer.byteLength(JSON.stringify(event));
    if (bytes + size > 262144) {
      more = true;
      break;
    }
    bytes += size;
    events.push(event);
    last = row.seq;
  }
  store.assertActorActive(actor);
  return {
    record_kind: 'audit_history',
    events,
    has_more: more,
    next_cursor:
      more && last
        ? Buffer.from(JSON.stringify({version: 1, binding, ceiling, before: last})).toString('base64url')
        : null,
    snapshot_sequence: ceiling,
    filters,
    source: 'AMCP append-only audit',
    website_path: '/activity',
    network_requests: 0,
    coverage: owner
      ? 'Workspace owner metadata; request bodies, receipts and arbitrary event fields are omitted.'
      : 'Currently accessible account metadata and your own unscoped events; unknown or conflicting scope is withheld.',
    meaning:
      'Newest events first within a fixed sequence boundary. Follow continuation even after an empty filtered page. Refresh to include new events. This projects retained AMCP events; it is not complete vendor history or a new integrity-chain verification.',
  };
}
