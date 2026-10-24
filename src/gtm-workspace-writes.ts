import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {defineFamily, fail, readOf} from './family-kit.js';
import {stable, sha256} from './security.js';
import {validateDiscoveryBody} from './discovery-body.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {pinnedJson} from './pinned-json.js';

const prefix = '/tagmanager/v2/';
const workspacePattern = 'accounts/[A-Za-z0-9_-]+/containers/[A-Za-z0-9_-]+/workspaces/[A-Za-z0-9_-]+';
export const gtmWorkspaceContracts = {
  BULK_UPDATE_WORKSPACE: {suffix: '/bulk_update', scope: 'edit.containers'},
  SYNC_WORKSPACE: {suffix: ':sync', scope: 'edit.containers'},
  QUICK_PREVIEW: {suffix: ':quick_preview', scope: 'edit.containerversions'},
  RESOLVE_WORKSPACE_CONFLICT: {suffix: ':resolve_conflict', scope: 'edit.containers'},
} as const;
type Workflow = keyof typeof gtmWorkspaceContracts;
// Entity, list and ContainerVersion use different keys for custom templates.
export const gtmWorkspaceEntities = {
  tag: {collection: 'tags', list: 'tag', id: 'tagId', model: 'Tag'},
  trigger: {collection: 'triggers', list: 'trigger', id: 'triggerId', model: 'Trigger'},
  variable: {collection: 'variables', list: 'variable', id: 'variableId', model: 'Variable'},
  folder: {collection: 'folders', list: 'folder', id: 'folderId', model: 'Folder'},
  customTemplate: {collection: 'templates', list: 'template', id: 'templateId', model: 'CustomTemplate'},
  client: {collection: 'clients', list: 'client', id: 'clientId', model: 'Client'},
  transformation: {
    collection: 'transformations',
    list: 'transformation',
    id: 'transformationId',
    model: 'Transformation',
  },
  zone: {collection: 'zones', list: 'zone', id: 'zoneId', model: 'Zone'},
  gtagConfig: {collection: 'gtag_config', list: 'gtagConfig', id: 'gtagConfigId', model: 'GtagConfig'},
  builtInVariable: {collection: 'built_in_variables', list: 'builtInVariable', id: 'type', model: 'BuiltInVariable'},
} as const;
type Kind = keyof typeof gtmWorkspaceEntities;
type Change = {kind: Kind; id: string; row: JsonObject; status: string};
type Inventory = Record<string, Record<string, JsonObject>>;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const simple = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v);
const empty = (v: unknown) => v == null || (obj(v) && Object.keys(v).length === 0);
function invalid(message: string): never {
  return fail('INVALID_GTM_REQUEST', message);
}
const schemas = (): JsonObject => pinnedJson('.mirror/VENDOR/gtm-v2.json').document.schemas;
export function gtmWorkspaceKind(p: CompiledRequest): Workflow | undefined {
  const action = p.action.split('/').at(-1) as Workflow,
    c = gtmWorkspaceContracts[action];
  return p.gateway === 'gtm_native_action' &&
    p.origin === 'https://tagmanager.googleapis.com' &&
    p.method === 'POST' &&
    c &&
    new RegExp('^' + prefix + workspacePattern + c.suffix + '$').test(p.path)
    ? action
    : undefined;
}
const root = (p: CompiledRequest) =>
  p.path.slice(prefix.length).replace(/(?:\/bulk_update|:sync|:quick_preview|:resolve_conflict)$/, '');
const container = (w: string) => w.split('/').slice(0, 4).join('/');
const identity = (kind: Kind, row: JsonObject) => row[gtmWorkspaceEntities[kind].id];
function bindings(row: JsonObject, w: string, workspace = true): void {
  const parts = w.split('/');
  for (const [k, v] of Object.entries({
    accountId: parts[1],
    containerId: parts[3],
    ...(workspace ? {workspaceId: parts[5]} : {}),
  }))
    if (row[k] !== undefined && row[k] !== v)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Tag Manager account, container and workspace bindings must agree.');
}
function parseChange(value: unknown): Change {
  if (!obj(value)) invalid('Each change must contain one native Entity and its changeStatus.');
  const keys = Object.keys(value).filter(k => k !== 'changeStatus');
  if (keys.length !== 1 || !Object.hasOwn(gtmWorkspaceEntities, keys[0]!) || !obj(value[keys[0]!]))
    invalid('An Entity must select exactly one supported native resource.');
  const kind = keys[0] as Kind,
    row = value[kind],
    id = identity(kind, row);
  if (!simple(id)) invalid('Every Entity requires its exact native ID, temporary new_N ID, or built-in variable type.');
  return {kind, id, row, status: value.changeStatus ?? 'none'};
}
const changes = (p: CompiledRequest) =>
  gtmWorkspaceKind(p) === 'BULK_UPDATE_WORKSPACE'
    ? ((p.body as JsonObject).changes.map(parseChange) as Change[])
    : gtmWorkspaceKind(p) === 'RESOLVE_WORKSPACE_CONFLICT'
      ? [parseChange(p.body)]
      : [];
const refKinds: Record<string, Kind> = {
  parentFolderId: 'folder',
  firingTriggerId: 'trigger',
  blockingTriggerId: 'trigger',
  enablingTriggerId: 'trigger',
  disablingTriggerId: 'trigger',
};
function walkReferences(value: unknown, visit: (id: string, kind: Kind | undefined) => string, key = ''): any {
  if (Array.isArray(value)) return value.map(v => walkReferences(v, visit, key));
  if (obj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walkReferences(v, visit, k)]));
  return typeof value === 'string' && /^new_\d+$/.test(value)
    ? visit(
        value,
        refKinds[key] ?? (Object.entries(gtmWorkspaceEntities).find(([, r]) => r.id === key)?.[0] as Kind | undefined),
      )
    : value;
}
function validateChange(c: Change, w: string, bulk: boolean): void {
  if (!['added', 'updated', 'deleted', ...(bulk ? [] : ['none'])].includes(c.status))
    invalid('Use an explicit added, updated or deleted changeStatus (none is also valid for conflict resolution).');
  validateDiscoveryBody(gtmWorkspaceEntities[c.kind].model, schemas(), c.row);
  bindings(c.row, w);
  if (c.row.tagManagerUrl !== undefined || c.row.uniqueTriggerId !== undefined)
    invalid('Provider-generated links and trigger metadata are output-only.');
  const added = bulk && c.status === 'added',
    builtin = c.kind === 'builtInVariable';
  if (builtin) {
    if (!schemas().BuiltInVariable.properties.type.enum.includes(c.id) || c.id === 'builtInVariableTypeUnspecified')
      invalid('Select a documented built-in variable type.');
  } else if (added ? !/^new_\d+$/.test(c.id) : !/^\d+$/.test(c.id))
    invalid('Bulk creates need new_N IDs; existing entities need their native numeric IDs.');
  if (
    c.row.path !== undefined &&
    (added || c.row.path !== w + '/' + gtmWorkspaceEntities[c.kind].collection + '/' + c.id)
  )
    invalid('Entity path must identify the existing entity in this workspace; omit paths on creates.');
  if (c.status !== 'deleted') {
    if (!['builtInVariable', 'gtagConfig'].includes(c.kind) && (typeof c.row.name !== 'string' || !c.row.name.trim()))
      invalid('Provide a complete named entity configuration.');
    if (
      ['tag', 'variable', 'trigger', 'client', 'transformation', 'gtagConfig'].includes(c.kind) &&
      (typeof c.row.type !== 'string' || !c.row.type)
    )
      invalid('Provide the native entity type.');
    if (c.kind === 'customTemplate' && (typeof c.row.templateData !== 'string' || !c.row.templateData))
      invalid('Custom templates require explicit templateData.');
  }
  if (
    c.status === 'deleted' &&
    Object.keys(c.row).some(
      k =>
        ![gtmWorkspaceEntities[c.kind].id, 'path', 'accountId', 'containerId', 'workspaceId', 'fingerprint'].includes(
          k,
        ),
    )
  )
    invalid('Deletion selects identity and fingerprint only; it cannot also edit fields.');
  if (added && c.row.fingerprint !== undefined) invalid('A new entity has no existing fingerprint.');
}
export function assertGtmWorkspace(p: CompiledRequest): void {
  const action = gtmWorkspaceKind(p);
  if (!action) return;
  const w = root(p);
  if (w.split('/')[1] !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'Selected account and workspace path must agree.');
  if (
    Object.keys(p.query).some(k => action !== 'RESOLVE_WORKSPACE_CONFLICT' || k !== 'fingerprint') ||
    (p.query.fingerprint !== undefined && (typeof p.query.fingerprint !== 'string' || !p.query.fingerprint))
  )
    invalid('Only conflict resolution accepts its native entity fingerprint.');
  if (action === 'SYNC_WORKSPACE' || action === 'QUICK_PREVIEW') {
    if (!empty(p.body)) invalid('Workspace sync and preview accept an empty body.');
    return;
  }
  if (!obj(p.body)) invalid('Provide the native workspace request body.');
  if (
    action === 'BULK_UPDATE_WORKSPACE' &&
    (!Array.isArray(p.body.changes) ||
      !p.body.changes.length ||
      p.body.changes.length > 100 ||
      Object.keys(p.body).some(k => k !== 'changes'))
  )
    invalid('A bulk update requires 1–100 explicitly reviewed Entity changes.');
  const edits = changes(p),
    seen = new Set<string>(),
    temporary = new Map<string, Kind>(),
    names = new Set<string>();
  for (const edit of edits) {
    validateChange(edit, w, action === 'BULK_UPDATE_WORKSPACE');
    const key = edit.kind + '/' + edit.id;
    if (seen.has(key)) invalid('Only one change per entity is allowed.');
    seen.add(key);
    if (edit.status === 'added' && edit.kind !== 'builtInVariable') {
      if (temporary.has(edit.id)) invalid('Temporary IDs must be unique across the whole batch.');
      temporary.set(edit.id, edit.kind);
      const label = edit.kind + '/' + (edit.row.name ?? edit.row.type);
      if (names.has(label))
        invalid(
          'Created entities require distinct names per type (Google tag configs require distinct types) so unordered receipts can be reconciled.',
        );
      names.add(label);
    }
  }
  for (const edit of edits)
    walkReferences(edit.row, (id, kind) => {
      if (!kind || temporary.get(id) !== kind)
        invalid('A temporary reference must resolve to a matching entity created in this same batch.');
      return id;
    });
}
function read(p: CompiledRequest, path: string): CompiledRequest {
  return readOf(
    p,
    {
      action: 'AMCP_GTM_WORKSPACE_READ',
      path: prefix + path,
      query: {},
      clears: ['specialTransport', 'responseControls'],
    },
    {gtmState: undefined, gtmWorkspaceState: undefined},
  );
}
export function gtmWorkspaceSnapshots(p: CompiledRequest): CompiledRequest[] {
  return [
    {
      ...read(p, root(p)),
      gtmWorkspaceState: {latest: ['SYNC_WORKSPACE', 'QUICK_PREVIEW'].includes(gtmWorkspaceKind(p)!)},
    },
  ];
}
function responseObject(r: TransportResult): JsonObject {
  if (r.status !== 200 || !obj(r.data) || r.data.error)
    fail('STATE_READ_FAILED', 'Workspace state requires a successful native object response.');
  return r.data;
}
function scopedRow(kind: Kind, row: unknown, w: string, version = false): JsonObject {
  if (!obj(row) || !simple(identity(kind, row))) fail('STATE_TARGET_MISMATCH', 'Workspace entity identity is missing.');
  bindings(row, w, !version);
  const id = identity(kind, row),
    collection = gtmWorkspaceEntities[kind].collection;
  if (kind === 'builtInVariable' && !schemas().BuiltInVariable.properties.type.enum.includes(id))
    fail('STATE_TARGET_MISMATCH', 'Unknown built-in variable type.');
  if (!version) {
    if (
      typeof row.path !== 'string' ||
      !row.path.startsWith(w + '/' + collection + '/') ||
      !simple(row.path.slice((w + '/' + collection + '/').length)) ||
      (kind !== 'builtInVariable' && row.path !== w + '/' + collection + '/' + id)
    )
      fail('STATE_TARGET_MISMATCH', 'Workspace list returned a foreign entity.');
  } else if (row.path !== undefined) {
    const parts = typeof row.path === 'string' ? row.path.split('/') : [];
    if (
      parts.slice(0, 4).join('/') !== container(w) ||
      !['workspaces', 'versions'].includes(parts[4] ?? '') ||
      !simple(parts[5]) ||
      parts[6] !== collection ||
      parts.length !== 8 ||
      !simple(parts[7]) ||
      (kind !== 'builtInVariable' && parts[7] !== id)
    )
      fail('STATE_TARGET_MISMATCH', 'Version entity has a foreign or inconsistent native path.');
  }
  return row;
}
function emptyInventory(): Inventory {
  return Object.fromEntries(Object.keys(gtmWorkspaceEntities).map(k => [k, {}]));
}
function versionEntities(version: JsonObject, w: string): Inventory {
  if (
    version.accountId !== w.split('/')[1] ||
    version.containerId !== w.split('/')[3] ||
    !simple(version.containerVersionId) ||
    version.deleted === true
  )
    fail('STATE_TARGET_MISMATCH', 'Container version must belong to the selected container and not be deleted.');
  if (version.path !== undefined && version.path !== container(w) + '/versions/' + version.containerVersionId)
    fail('STATE_TARGET_MISMATCH', 'Container version path is not its exact native identity.');
  if (version.container !== undefined) {
    if (!obj(version.container)) fail('STATE_TARGET_MISMATCH', 'Malformed version container.');
    bindings(version.container, w, false);
  }
  const entities = emptyInventory();
  let count = 0;
  for (const kind of Object.keys(gtmWorkspaceEntities) as Kind[]) {
    const rows = version[kind] ?? [];
    if (!Array.isArray(rows) || rows.length > 1000)
      fail('INCOMPLETE_STATE', 'Version entities exceed supported bounds.');
    for (const row of rows) {
      scopedRow(kind, row, w, true);
      const id = identity(kind, row);
      if (entities[kind]![id]) fail('STATE_TARGET_MISMATCH', 'Version contains duplicate entity IDs.');
      entities[kind]![id] = row;
    }
    count += rows.length;
  }
  if (count > 5000) fail('STATE_TOO_LARGE', 'Workspace contracts support at most 5000 entities.');
  return entities;
}
function entityKey(c: Change) {
  return c.kind + '/' + c.id;
}
function statusData(raw: unknown, w: string): JsonObject {
  if (!obj(raw) || Object.keys(raw).some(k => !['workspaceChange', 'mergeConflict', 'requestId'].includes(k)))
    fail('STATE_READ_FAILED', 'Unrecognized workspace status envelope.');
  const status: JsonObject = {workspaceChange: raw.workspaceChange ?? [], mergeConflict: raw.mergeConflict ?? []};
  if (
    !Array.isArray(status.workspaceChange) ||
    !Array.isArray(status.mergeConflict) ||
    status.workspaceChange.length > 5000 ||
    status.mergeConflict.length > 5000
  )
    fail('STATE_TOO_LARGE', 'Malformed or oversized workspace status.');
  const seen = new Set<string>();
  for (const entity of status.workspaceChange) {
    const c = parseChange(entity);
    scopedRow(c.kind, c.row, w);
    if (!['added', 'updated', 'deleted', 'none'].includes(c.status) || seen.has(entityKey(c)))
      fail('STATE_TARGET_MISMATCH', 'Duplicate or unknown workspace change.');
    seen.add(entityKey(c));
  }
  seen.clear();
  for (const conflict of status.mergeConflict) {
    if (!obj(conflict) || Object.keys(conflict).some(k => !['entityInWorkspace', 'entityInBaseVersion'].includes(k)))
      fail('STATE_READ_FAILED', 'Malformed merge conflict.');
    const c = parseChange(conflict.entityInWorkspace);
    scopedRow(c.kind, c.row, w);
    if (seen.has(entityKey(c))) fail('STATE_TARGET_MISMATCH', 'Duplicate merge conflict.');
    seen.add(entityKey(c));
    if (conflict.entityInBaseVersion) {
      const b = parseChange(conflict.entityInBaseVersion);
      scopedRow(b.kind, b.row, w, true);
      if (entityKey(b) !== entityKey(c))
        fail('STATE_TARGET_MISMATCH', 'Conflict entities must identify the same native entity.');
    }
  }
  status.workspaceChange.sort((a: unknown, b: unknown) =>
    entityKey(parseChange(a)).localeCompare(entityKey(parseChange(b)), 'en'),
  );
  status.mergeConflict.sort((a: JsonObject, b: JsonObject) =>
    entityKey(parseChange(a.entityInWorkspace)).localeCompare(entityKey(parseChange(b.entityInWorkspace)), 'en'),
  );
  return status;
}
const conflictKeys = (status: JsonObject) =>
  status.mergeConflict.map((c: JsonObject) => entityKey(parseChange(c.entityInWorkspace))).sort();
function withoutTelemetry(value: unknown): any {
  if (Array.isArray(value)) return value.map(withoutTelemetry);
  if (!obj(value)) return value;
  const out = Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !['requestId', 'request_id', 'tagManagerUrl'].includes(k))
      .map(([k, v]) => [k, withoutTelemetry(v)]),
  );
  for (const key of ['firingTriggerId', 'blockingTriggerId', 'enablingTriggerId', 'disablingTriggerId'])
    if (Array.isArray(out[key])) out[key] = [...out[key]].sort();
  return out;
}
/** A server-derived read fan-out. Every page is sent through the caller's grant,
 * account, credential and cancellation checks; no request from response URLs. */
export async function readGtmWorkspace(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  if (!p.gtmWorkspaceState) return request(p);
  let bytes = 0;
  const w = root(p),
    fetch = async (path: string, query: JsonObject = {}) => {
      const data = responseObject(await request({...read(p, path), query}));
      bytes += Buffer.byteLength(JSON.stringify(data));
      if (bytes > 16 * 1024 * 1024)
        fail('STATE_TOO_LARGE', 'Workspace reads exceeded the 16 MiB cumulative response bound.');
      return data;
    };
  const workspace = await fetch(w);
  if (workspace.path !== w) fail('STATE_TARGET_MISMATCH', 'Workspace identity did not match.');
  bindings(workspace, w);
  const status = statusData(await fetch(w + '/status'), w),
    entities = emptyInventory();
  let total = 0;
  let latest: JsonObject | null = null,
    version: JsonObject | null = null;
  const latestHeader = async () => {
    try {
      const h = await fetch(container(w) + '/version_headers:latest');
      bindings(h, w, false);
      if (
        !simple(h.containerVersionId) ||
        !['/versions/', '/version_headers/'].some(k => h.path === container(w) + k + h.containerVersionId) ||
        h.deleted === true
      )
        fail('STATE_TARGET_MISMATCH', 'Latest version header did not identify the selected container.');
      return h;
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'UPSTREAM_ERROR' && e.status === 404) return null;
      throw e;
    }
  };
  if (p.gtmWorkspaceState.latest) {
    latest = await latestHeader();
    if (latest) {
      version = await fetch(container(w) + '/versions/' + latest.containerVersionId);
      versionEntities(version, w);
      if (version.containerVersionId !== latest.containerVersionId)
        fail('STATE_TARGET_MISMATCH', 'Version changed identity while reading.');
    }
  }
  for (const [kind, model] of Object.entries(gtmWorkspaceEntities) as [Kind, (typeof gtmWorkspaceEntities)[Kind]][]) {
    const tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const data = await fetch(w + '/' + model.collection, token ? {pageToken: token} : {});
      if (
        Object.keys(data).some(k => ![model.list, 'nextPageToken', 'requestId'].includes(k)) ||
        (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')
      )
        fail('STATE_READ_FAILED', 'Unrecognized workspace collection envelope.');
      const rows = data[model.list] ?? [];
      if (!Array.isArray(rows)) fail('STATE_READ_FAILED', 'Malformed workspace collection.');
      for (const row of rows) {
        scopedRow(kind, row, w);
        const id = identity(kind, row);
        if (entities[kind]![id]) fail('STATE_TARGET_MISMATCH', 'Duplicate entity across workspace pages.');
        entities[kind]![id] = row;
        if (++total > 5000 || Object.keys(entities[kind]!).length > 1000)
          fail('STATE_TOO_LARGE', 'Workspace contracts support 1000 entities per kind, 5000 total.');
      }
      if (!data.nextPageToken) break;
      if (page === 99 || tokens.has(data.nextPageToken))
        fail('INCOMPLETE_STATE', 'Incomplete or repeated workspace pagination.');
      token = data.nextPageToken;
      tokens.add(token!);
    }
  }
  const finalStatus = statusData(await fetch(w + '/status'), w),
    finalWorkspace = await fetch(w);
  if (
    stable(withoutTelemetry(status)) !== stable(withoutTelemetry(finalStatus)) ||
    stable(withoutTelemetry(workspace)) !== stable(withoutTelemetry(finalWorkspace)) ||
    (p.gtmWorkspaceState.latest && stable(withoutTelemetry(latest)) !== stable(withoutTelemetry(await latestHeader())))
  )
    fail('STATE_CHANGED', 'Workspace or latest version changed during the complete state read.');
  const data = withoutTelemetry({
    amcpWorkspaceSnapshot: 1,
    path: w,
    workspace,
    status,
    entities,
    latestVersion: version,
    latestVersionId: latest?.containerVersionId ?? null,
  });
  if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024)
    fail('STATE_TOO_LARGE', 'The retained workspace snapshot exceeds 8 MiB.');
  return {status: 200, headers: {}, data};
}
export function validateGtmWorkspaceState(p: CompiledRequest, response: TransportResult): void {
  const d = responseObject(response);
  if (d.amcpWorkspaceSnapshot !== 1 || d.path !== root(p) || !obj(d.entities) || !obj(d.status))
    fail('STATE_READ_FAILED', 'A complete server-derived workspace snapshot is required.');
  bindings(d.workspace, root(p));
  statusData(d.status, root(p));
  for (const kind of Object.keys(gtmWorkspaceEntities) as Kind[]) {
    if (!obj(d.entities[kind])) fail('INCOMPLETE_STATE', 'Missing workspace entity collection.');
    for (const [id, row] of Object.entries(d.entities[kind])) {
      scopedRow(kind, row, root(p));
      if (identity(kind, row as JsonObject) !== id)
        fail('STATE_TARGET_MISMATCH', 'Workspace entity index is inconsistent.');
    }
  }
}
export function validateGtmWorkspacePrerequisites(p: CompiledRequest, states: unknown[]): void {
  const action = gtmWorkspaceKind(p);
  if (!action) return;
  const s = states[0] as JsonObject,
    edits = changes(p);
  if (action !== 'RESOLVE_WORKSPACE_CONFLICT' && s.status.mergeConflict.length)
    fail('STATE_CONFLICT', 'Resolve the existing workspace conflicts with a separate reviewed resolution first.');
  for (const c of edits) {
    const current = s.entities[c.kind][c.id];
    if (action === 'BULK_UPDATE_WORKSPACE' && (c.status === 'added' ? !!current : !current))
      fail(
        c.status === 'added' ? 'CONFIGURATION_EXISTS' : 'STATE_NOT_FOUND',
        'The change status does not match current workspace membership.',
      );
    if (c.row.fingerprint !== undefined && current && c.row.fingerprint !== current.fingerprint)
      fail('STATE_CHANGED', 'The supplied entity fingerprint is stale.');
    if (c.status !== 'added' && c.status !== 'deleted' && current)
      for (const key of Object.keys(configuration(current)))
        if (!Object.hasOwn(c.row, key))
          fail(
            'INCOMPLETE_GTM_REPLACEMENT',
            'Workspace replacements must explicitly preserve or clear every existing configuration field. Read the entity and supply its complete intended configuration.',
          );
  }
  if (action === 'RESOLVE_WORKSPACE_CONFLICT') {
    const c = edits[0]!,
      conflict = s.status.mergeConflict.find(
        (m: JsonObject) => entityKey(parseChange(m.entityInWorkspace)) === entityKey(c),
      );
    if (!conflict) fail('STATE_CONFLICT_NOT_FOUND', 'The selected entity has no current merge conflict.');
    const native = parseChange(conflict.entityInWorkspace).row.fingerprint;
    if (native !== undefined) {
      if (typeof native !== 'string' || !native) fail('STATE_READ_FAILED', 'Conflict entity fingerprint is malformed.');
      if (p.query.fingerprint !== undefined && p.query.fingerprint !== native)
        fail('STATE_CHANGED', 'The supplied conflict fingerprint is stale.');
      p.query.fingerprint = native;
    } else if (p.query.fingerprint !== undefined) invalid('This conflicted entity has no native fingerprint.');
  }
}
// Configuration comparisons strip resource location/ETag fields only. Arrays of
// parameters and tag sequencing remain ordered; trigger membership is a set.
function protoValue(value: unknown): any {
  if (Array.isArray(value)) return value.map(protoValue);
  if (!obj(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([k, v]) => [k, protoValue(v)])
      .filter(
        ([, v]) =>
          v !== null &&
          v !== undefined &&
          v !== '' &&
          v !== false &&
          v !== 0 &&
          !(Array.isArray(v) && v.length === 0) &&
          !(obj(v) && Object.keys(v).length === 0),
      ),
  );
}
function configuration(row: JsonObject): JsonObject {
  const result = withoutTelemetry(
    Object.fromEntries(
      Object.entries(row).filter(
        ([k]) => !['path', 'accountId', 'containerId', 'workspaceId', 'fingerprint', 'uniqueTriggerId'].includes(k),
      ),
    ),
  );
  for (const key of ['firingTriggerId', 'blockingTriggerId', 'enablingTriggerId', 'disablingTriggerId'])
    if (Array.isArray(result[key])) result[key] = [...result[key]].sort();
  return protoValue(result);
}
function fieldHashes(kind: Kind, row: JsonObject): JsonObject {
  const result: JsonObject = {},
    properties = schemas()[gtmWorkspaceEntities[kind].model].properties;
  for (const [key, model] of Object.entries(properties) as [string, JsonObject][]) {
    if (
      ['path', 'accountId', 'containerId', 'workspaceId', 'fingerprint', 'tagManagerUrl', 'uniqueTriggerId'].includes(
        key,
      )
    )
      continue;
    let value =
      row[key] ??
      (model.type === 'array'
        ? []
        : model.type === 'boolean'
          ? false
          : model.type === 'integer' || model.type === 'number'
            ? 0
            : model.type === 'string'
              ? ''
              : {});
    if (Object.hasOwn(refKinds, key) && Array.isArray(value)) value = [...value].sort();
    result[key] = sha256(stable(protoValue(value)));
  }
  return result;
}
function projected(entities: Inventory): Inventory {
  return Object.fromEntries(
    Object.entries(entities).map(([kind, rows]) => [
      kind,
      Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, configuration(row)])),
    ]),
  );
}
function merged(s: JsonObject): Inventory {
  const rows = s.latestVersion ? versionEntities(s.latestVersion, s.path) : emptyInventory();
  for (const entity of s.status.workspaceChange) {
    const c = parseChange(entity);
    if (c.status === 'deleted') delete rows[c.kind]![c.id];
    else if (c.status !== 'none') rows[c.kind]![c.id] = c.row;
  }
  return projected(rows);
}
function matches(expected: unknown, actual: unknown): boolean {
  if (obj(expected)) return obj(actual) && Object.entries(expected).every(([k, v]) => matches(v, actual[k]));
  return stable(expected) === stable(actual);
}
function bulkReceipt(
  p: CompiledRequest,
  d: JsonObject,
  s: JsonObject,
): {edits: Change[]; ids: Map<string, string>} | undefined {
  if (Object.keys(d).some(k => !['changes', 'requestId'].includes(k)) || !Array.isArray(d.changes ?? [])) return;
  const edits = changes(p).filter(c => c.status !== 'deleted'),
    received: Change[] = [];
  try {
    for (const item of d.changes ?? []) {
      const c = parseChange(item);
      scopedRow(c.kind, c.row, root(p));
      if (c.status === 'deleted') return;
      received.push(c);
    }
  } catch {
    return;
  }
  if (received.length !== edits.length || new Set(received.map(entityKey)).size !== received.length) return;
  const ids = new Map<string, string>(),
    matched: Change[] = [];
  for (const edit of edits) {
    const candidates = received.filter(
      c =>
        c.kind === edit.kind &&
        (edit.status === 'added' && edit.kind !== 'builtInVariable'
          ? edit.row.name !== undefined
            ? c.row.name === edit.row.name
            : c.row.type === edit.row.type
          : c.id === edit.id),
    );
    if (candidates.length !== 1) return;
    const found = candidates[0]!;
    if (edit.status === 'added' && s.entities[edit.kind][found.id]) return;
    if (edit.status === 'added' && edit.kind !== 'builtInVariable') {
      if (!/^\d+$/.test(found.id)) return;
      ids.set(edit.id, found.id);
    }
    matched.push(found);
  }
  if (new Set(matched.map(entityKey)).size !== matched.length) return;
  for (let i = 0; i < edits.length; i++) {
    const wanted = walkReferences(configuration(edits[i]!.row), id => ids.get(id) ?? id);
    if (!matches(wanted, configuration(matched[i]!.row))) return;
  }
  return {edits: matched, ids};
}
function cleanSyncStatus(d: JsonObject): boolean {
  return (
    obj(d.syncStatus) &&
    Object.keys(d.syncStatus).every(k => ['syncError', 'mergeConflict'].includes(k)) &&
    ['syncError', 'mergeConflict'].every(k => d.syncStatus[k] === undefined || d.syncStatus[k] === false)
  );
}
export function gtmWorkspaceOutcome(p: CompiledRequest, r: TransportResult, before: unknown[]): boolean {
  const a = gtmWorkspaceKind(p),
    d = r.data,
    s = before[0] as JsonObject;
  if (!a || r.status !== 200 || !obj(d) || !s) return false;
  if (a === 'RESOLVE_WORKSPACE_CONFLICT') return empty(d);
  if (a === 'BULK_UPDATE_WORKSPACE') return !!bulkReceipt(p, d, s);
  if (!cleanSyncStatus(d)) return false;
  if (a === 'SYNC_WORKSPACE')
    return (
      Object.keys(d).every(k => ['syncStatus', 'mergeConflict', 'requestId'].includes(k)) &&
      Array.isArray(d.mergeConflict ?? []) &&
      !(d.mergeConflict ?? []).length
    );
  if (
    Object.keys(d).some(k => !['syncStatus', 'containerVersion', 'compilerError', 'requestId'].includes(k)) ||
    (d.compilerError !== undefined && d.compilerError !== false) ||
    !obj(d.containerVersion)
  )
    return false;
  try {
    return stable(projected(versionEntities(d.containerVersion, root(p)))) === stable(merged(s));
  } catch {
    return false;
  }
}
export function gtmWorkspaceReceipt(p: CompiledRequest, r: TransportResult): JsonObject {
  const a = gtmWorkspaceKind(p),
    d = r.data;
  if (!a || !obj(d)) return {};
  if (
    a === 'SYNC_WORKSPACE' &&
    (d.syncStatus?.mergeConflict === true || (Array.isArray(d.mergeConflict) && d.mergeConflict.length))
  )
    return {
      provider_effect: 'synchronization_returned_conflicts',
      retry_safe: false,
      recovery: {
        action: 'read_workspace_status_and_review_each_resolution',
        message:
          'Synchronization may already have applied changes. Resolve the retained conflicts with separate reviewed requests; do not replay sync.',
      },
    };
  return a === 'QUICK_PREVIEW'
    ? {verification_scope: 'temporary_preview_configuration_and_workspace', published: false}
    : {};
}
export function gtmWorkspaceVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const a = gtmWorkspaceKind(p)!,
    s = before[0] as JsonObject,
    d = result.data,
    expected: JsonObject = {conflictKeys: []},
    targets: {kind: string; id: string}[] = [];
  if (a === 'SYNC_WORKSPACE' || a === 'QUICK_PREVIEW') {
    const entities = merged(s);
    expected.entities = entities;
    expected.membership = Object.fromEntries(
      Object.entries(entities).map(([k, rows]) => [k, Object.keys(rows).sort()]),
    );
    expected.latestVersionId = s.latestVersionId;
  } else {
    expected.entities = {};
    expected.presence = {};
    expected.fieldHashes = {};
    const receipt = a === 'BULK_UPDATE_WORKSPACE' ? bulkReceipt(p, d, s) : undefined;
    if (a === 'BULK_UPDATE_WORKSPACE' && !receipt)
      fail('VERIFICATION_UNSUPPORTED', 'Bulk receipt could not be reconciled.');
    for (const c of changes(p)) {
      const id = receipt?.ids.get(c.id) ?? c.id;
      targets.push({kind: c.kind, id});
      (expected.presence[c.kind] ??= {})[id] = c.status !== 'deleted';
      if (c.status !== 'deleted') {
        const wanted = walkReferences(c.row, id => receipt?.ids.get(id) ?? id);
        (expected.entities[c.kind] ??= {})[id] = configuration(wanted);
        const hashes = fieldHashes(c.kind, wanted);
        (expected.fieldHashes[c.kind] ??= {})[id] = Object.fromEntries(
          Object.keys(wanted)
            .filter(k => hashes[k] !== undefined)
            .map(k => [k, hashes[k]]),
        );
      }
    }
    if (a === 'RESOLVE_WORKSPACE_CONFLICT')
      expected.conflictKeys = conflictKeys(s.status).filter((k: string) => k !== entityKey(changes(p)[0]!));
  }
  const request = gtmWorkspaceSnapshots(p)[0]!;
  request.gtmWorkspaceState!.targets = targets;
  return [{read: request, expected, id: root(p)}];
}
export function gtmWorkspaceObserved(p: CompiledRequest, d: JsonObject): JsonObject {
  const entities = projected(d.entities),
    presence: JsonObject = {};
  for (const {kind, id} of p.gtmWorkspaceState?.targets ?? []) (presence[kind] ??= {})[id] = !!entities[kind]?.[id];
  return {
    entities,
    presence,
    fieldHashes: Object.fromEntries(
      Object.entries(d.entities as Inventory).map(([k, rows]) => [
        k,
        Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, fieldHashes(k as Kind, row)])),
      ]),
    ),
    membership: Object.fromEntries(Object.entries(entities).map(([k, rows]) => [k, Object.keys(rows).sort()])),
    conflictKeys: conflictKeys(d.status),
    latestVersionId: d.latestVersionId,
  };
}
export function gtmWorkspaceDestructive(p: CompiledRequest): boolean {
  const a = gtmWorkspaceKind(p);
  return (
    !!a &&
    (a === 'SYNC_WORKSPACE' ||
      a === 'QUICK_PREVIEW' ||
      (obj(p.body) &&
        (Array.isArray(p.body.changes) ? p.body.changes : [p.body]).some(
          (c: JsonObject) => c.changeStatus === 'deleted',
        )))
  );
}

/** What a workspace workflow changes, as prepare returns it for review. */
export function gtmWorkspaceImpact(plan: CompiledRequest): JsonObject {
  return {
    provider: 'gtm',
    workflow: gtmWorkspaceKind(plan),
    effect:
      'Changes this workspace without publishing. Sync and quick preview can replace or remove unmodified entities using the latest version; bulk deletions and conflict resolutions can discard workspace edits.',
    verification:
      'Reads every entity collection with bounded pagination. Quick preview checks the temporary version receipt and workspace contents, without treating it as a saved or published version. It does not verify browser tag execution or consent.',
    limits:
      '100 changes per bulk call; 1000 entities per kind, 5000 per workspace and 100 pages per collection. Temporary creates need unique names per kind for unambiguous unordered receipt matching.',
    recovery:
      'Sync conflicts, partial receipts and lost responses retain the submission claim. Read workspace status, preserve completed changes, and prepare each correction separately.',
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const gtmWorkspaceFamily: ReviewedFamily = defineFamily({
  name: 'gtm_workspace',
  files: ['src/gtm-workspace-writes.ts', ['tests/gtm-workspace-writes.test.ts']],
  kind: gtmWorkspaceKind,
  assert: plan => {
    assertNoMethodOverride(plan);
    assertGtmWorkspace(plan);
  },
  snapshots: gtmWorkspaceSnapshots,
  isRead: (read: CompiledRequest) => read.gateway === 'gtm_native_action' && !!read.gtmWorkspaceState,
  reader: (read, next) => readGtmWorkspace(read, next),
  validateState: validateGtmWorkspaceState,
  snapshotState: (read, data, gateway) => gateway(),
  prerequisites: (plan, state) => validateGtmWorkspacePrerequisites(plan, state),
  impact: gtmWorkspaceImpact,
  outcome: gtmWorkspaceOutcome,
  receipt: gtmWorkspaceReceipt,
  verification: gtmWorkspaceVerification,
  observed: gtmWorkspaceObserved,
  destructive: plan => !!gtmWorkspaceDestructive(plan),
  ownsConcurrency: true,
});
