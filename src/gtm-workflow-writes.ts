import {MirrorError} from './errors.js';
import {sha256} from './security.js';
import {validateDiscoveryBody} from './discovery-body.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {pinnedJson} from './pinned-json.js';

const prefix = '/tagmanager/v2/',
  account = 'accounts/[A-Za-z0-9_-]+',
  container = account + '/containers/[A-Za-z0-9_-]+',
  workspace = container + '/workspaces/[A-Za-z0-9_-]+';
const entities = {
  CLIENT: ['clients', 'client', 'clientId'],
  FOLDER: ['folders', 'folder', 'folderId'],
  TAG: ['tags', 'tag', 'tagId'],
  TEMPLATE: ['templates', 'template', 'templateId'],
  TRANSFORMATION: ['transformations', 'transformation', 'transformationId'],
  TRIGGER: ['triggers', 'trigger', 'triggerId'],
  VARIABLE: ['variables', 'variable', 'variableId'],
  ZONE: ['zones', 'zone', 'zoneId'],
} as const;
type Contract = {
  method: string;
  path: RegExp;
  scope: string;
  admin?: boolean;
  queries: string[];
  entity?: readonly [string, string, string];
};
const route = (
  method: string,
  path: string,
  queries: string[] = [],
  scope = 'edit.containers',
  admin = false,
): Contract => ({
  method,
  path: new RegExp('^' + prefix + path + '$'),
  queries,
  scope: 'https://www.googleapis.com/auth/tagmanager.' + scope,
  admin,
});
export const gtmWorkflowContracts: Record<string, Contract> = {
  ...Object.fromEntries(
    Object.entries(entities).map(([name, e]) => [
      'REVERT_' + name,
      {...route('POST', workspace + '/' + e[0] + '/[A-Za-z0-9_-]+:revert', ['fingerprint']), entity: e},
    ]),
  ),
  CREATE_BUILT_IN_VARIABLES: route('POST', workspace + '/built_in_variables', ['type']),
  DELETE_BUILT_IN_VARIABLES: route('DELETE', workspace + '/built_in_variables', ['type']),
  REVERT_BUILT_IN_VARIABLE: route('POST', workspace + '/built_in_variables:revert', ['type']),
  MOVE_ENTITIES_TO_FOLDER: route('POST', workspace + '/folders/[A-Za-z0-9_-]+:move_entities_to_folder', [
    'tagId',
    'triggerId',
    'variableId',
  ]),
  SET_LATEST_CONTAINER_VERSION: route('POST', container + '/versions/[A-Za-z0-9_-]+:set_latest', [], 'edit.containers'),
  UNDELETE_CONTAINER_VERSION: route(
    'POST',
    container + '/versions/[A-Za-z0-9_-]+:undelete',
    [],
    'edit.containerversions',
  ),
  IMPORT_TEMPLATE_FROM_GALLERY: route('POST', workspace + '/templates:import_from_gallery', [
    'galleryOwner',
    'galleryRepository',
    'gallerySha',
    'acknowledgePermissions',
  ]),
  REAUTHORIZE_ENVIRONMENT: route('POST', container + '/environments/[A-Za-z0-9_-]+:reauthorize', [], 'publish', true),
  UPDATE_ACCOUNT: route('PUT', account, ['fingerprint'], 'manage.accounts', true),
  CREATE_USER_PERMISSION: route('POST', account + '/user_permissions', [], 'manage.users', true),
  UPDATE_USER_PERMISSION: route('PUT', account + '/user_permissions/[A-Za-z0-9_-]+', [], 'manage.users', true),
  DELETE_USER_PERMISSION: route('DELETE', account + '/user_permissions/[A-Za-z0-9_-]+', [], 'manage.users', true),
};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const empty = (v: unknown) => v == null || (obj(v) && Object.keys(v).length === 0);
const simple = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v);
function fail(code: string, message: string): never {
  throw new MirrorError(code, message);
}
const invalid = (message: string): never => fail('INVALID_GTM_REQUEST', message);
const document = (): JsonObject => pinnedJson('.mirror/VENDOR/gtm-v2.json').document;
export function gtmWorkflowKind(p: CompiledRequest): string | undefined {
  const a = p.action.split('/').at(-1)!,
    c = gtmWorkflowContracts[a];
  return p.gateway === 'gtm_native_action' &&
    p.origin === 'https://tagmanager.googleapis.com' &&
    c?.method === p.method &&
    c.path.test(p.path)
    ? a
    : undefined;
}
const target = (p: CompiledRequest) =>
  p.path
    .slice(prefix.length)
    .replace(/:(revert|move_entities_to_folder|set_latest|undelete|import_from_gallery|reauthorize)$/, '');
const workspaceOf = (p: CompiledRequest) => target(p).match(new RegExp('^' + workspace))?.[0];
const containerOf = (p: CompiledRequest) => target(p).match(new RegExp('^' + container))?.[0];
function keys(v: JsonObject, allowed: string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) invalid('Request contains an unqualified or output-only field.');
}
function bound(v: JsonObject, resource: string): void {
  const parts = resource.split('/'),
    bindings: JsonObject = {
      accountId: parts[1],
      ...(parts[2] === 'containers' ? {containerId: parts[3]} : {}),
      ...(parts[4] === 'workspaces' ? {workspaceId: parts[5]} : {}),
    };
  for (const [k, x] of Object.entries(v)) {
    if (bindings[k] !== undefined && String(x) !== bindings[k])
      fail('ACCOUNT_SCOPE_MISMATCH', 'Tag Manager resource bindings must match the exact selected parent.');
    if (k === 'path' && typeof x === 'string' && x !== resource)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Tag Manager path must match the exact resource.');
  }
}
export function assertGtmWorkflowActor(p: CompiledRequest, actor: Actor): void {
  const a = gtmWorkflowKind(p);
  if (a && gtmWorkflowContracts[a]!.admin && actor.role !== 'admin')
    fail('FORBIDDEN', 'Account administration and environment reauthorization require an AMCP administrator.');
}
export function assertGtmWorkflow(p: CompiledRequest): void {
  const a = gtmWorkflowKind(p);
  if (!a) return;
  const c = gtmWorkflowContracts[a]!,
    b = obj(p.body) ? p.body : {},
    resource = target(p);
  if (resource.split('/')[1] !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'Selected account and Tag Manager path must agree.');
  if (Object.keys(p.query).some(k => !c.queries.includes(k)))
    invalid("Only this workflow's documented query fields are accepted.");
  if (p.query.fingerprint !== undefined && (typeof p.query.fingerprint !== 'string' || !p.query.fingerprint))
    invalid('fingerprint must be a nonempty native value.');
  if (a === 'UPDATE_ACCOUNT') {
    if (!obj(p.body)) invalid('Provide the native Account body.');
    keys(b, ['name', 'shareData', 'accountId', 'path']);
    bound(b, resource);
    if (typeof b.name !== 'string' || !b.name.trim() || typeof b.shareData !== 'boolean')
      invalid('Provide explicit account name and shareData; do not implicitly change data sharing.');
    validateDiscoveryBody('Account', document().schemas, b);
    return;
  }
  if (a === 'CREATE_USER_PERMISSION' || a === 'UPDATE_USER_PERMISSION') {
    if (!obj(p.body)) invalid('Provide the complete UserPermission body.');
    keys(b, ['emailAddress', 'accountAccess', 'containerAccess', 'accountId', 'path']);
    bound(b, resource);
    validateDiscoveryBody('UserPermission', document().schemas, b);
    if (
      typeof b.emailAddress !== 'string' ||
      !/^\S+@[^\s@]+\.[^\s@]+$/.test(b.emailAddress) ||
      b.emailAddress.length > 254 ||
      !obj(b.accountAccess) ||
      !['noAccess', 'user', 'admin'].includes(b.accountAccess.permission) ||
      !Array.isArray(b.containerAccess) ||
      b.containerAccess.length > 100
    )
      invalid('Provide an explicit emailAddress, accountAccess and complete containerAccess array.');
    if (
      b.containerAccess.some(
        (v: JsonObject) =>
          !simple(v.containerId) || !['noAccess', 'read', 'edit', 'approve', 'publish'].includes(v.permission),
      ) ||
      new Set(b.containerAccess.map((v: JsonObject) => v.containerId)).size !== b.containerAccess.length
    )
      invalid('Container grants must be distinct IDs with explicit permissions.');
    return;
  }
  if (!empty(p.body))
    invalid(
      'This workflow accepts an empty native body only. Configuration edits need their separate reviewed operation.',
    );
  if (a.includes('BUILT_IN_VARIABLE')) {
    const types = a === 'REVERT_BUILT_IN_VARIABLE' ? [p.query.type] : p.query.type,
      allowed = document().schemas.BuiltInVariable.properties.type.enum;
    if (
      !Array.isArray(types) ||
      !types.length ||
      types.length > 150 ||
      types.some(t => typeof t !== 'string' || t === 'builtInVariableTypeUnspecified' || !allowed.includes(t)) ||
      new Set(types).size !== types.length
    )
      invalid('Specify distinct documented built-in variable types; revert accepts one type.');
  }
  if (a === 'MOVE_ENTITIES_TO_FOLDER') {
    const lists = Object.values(p.query);
    if (
      !lists.length ||
      lists.some(v => !Array.isArray(v) || !v.length || v.some(x => !simple(x)) || new Set(v).size !== v.length) ||
      lists.reduce((n, v) => n + v.length, 0) > 100
    )
      invalid('Choose 1–100 distinct tagId, triggerId or variableId entries in this workspace.');
  }
  if (a === 'IMPORT_TEMPLATE_FROM_GALLERY') {
    if (
      !simple(p.query.galleryOwner) ||
      typeof p.query.galleryRepository !== 'string' ||
      !p.query.galleryRepository ||
      !/^[A-Za-z0-9_.-]+$/.test(p.query.galleryRepository) ||
      !/^\w{40}$/.test(p.query.gallerySha ?? '') ||
      !/^[a-fA-F0-9]+$/.test(p.query.gallerySha)
    )
      invalid(
        'Gallery imports require an owner, repository and exact 40-character commit SHA. Latest is not a frozen version.',
      );
    if (p.query.acknowledgePermissions !== true)
      invalid("Review the pinned template's permissions and explicitly supply acknowledgePermissions=true.");
  }
}
function read(
  p: CompiledRequest,
  resource: string,
  kind: 'resource' | 'collection' | 'status' | 'latest' = 'resource',
  key?: string,
  optional = false,
): CompiledRequest {
  return {
    ...p,
    path: prefix + resource,
    action: optional ? 'AMCP_STATE_OPTIONAL' : 'AMCP_GTM_WORKFLOW_STATE',
    method: 'GET',
    query: {},
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    specialTransport: undefined,
    responseControls: undefined,
    gtmState: {kind, ...(key ? {key} : {})},
  };
}
function moved(p: CompiledRequest) {
  const w = workspaceOf(p)!;
  return Object.entries(p.query).flatMap(([key, ids]) =>
    (ids as string[]).map(
      id => w + '/' + {tagId: 'tags', triggerId: 'triggers', variableId: 'variables'}[key] + '/' + id,
    ),
  );
}
export function gtmWorkflowSnapshots(p: CompiledRequest): CompiledRequest[] {
  const a = gtmWorkflowKind(p)!,
    resource = target(p),
    c = gtmWorkflowContracts[a]!;
  if (c.entity)
    return [
      read(p, resource, 'resource', undefined, true),
      read(p, workspaceOf(p)!),
      read(p, workspaceOf(p)! + '/status', 'status'),
    ];
  if (a.includes('BUILT_IN_VARIABLE'))
    return [
      read(p, workspaceOf(p)! + '/built_in_variables', 'collection', 'builtInVariable'),
      read(p, workspaceOf(p)!),
    ];
  if (a === 'MOVE_ENTITIES_TO_FOLDER')
    return [
      read(p, resource.endsWith('/folders/0') ? workspaceOf(p)! : resource),
      ...moved(p).map(path => read(p, path)),
    ];
  if (a === 'SET_LATEST_CONTAINER_VERSION')
    return [read(p, resource), read(p, containerOf(p)! + '/version_headers:latest', 'latest', undefined, true)];
  if (a === 'IMPORT_TEMPLATE_FROM_GALLERY')
    return [read(p, workspaceOf(p)!), read(p, workspaceOf(p)! + '/templates', 'collection', 'template')];
  if (a.includes('USER_PERMISSION'))
    return [
      read(p, a.startsWith('CREATE_') ? 'accounts/' + p.accountId : resource),
      read(p, 'accounts/' + p.accountId + '/user_permissions', 'collection', 'userPermission'),
      ...((obj(p.body) ? p.body.containerAccess : []) ?? []).map((v: JsonObject) =>
        read(p, 'accounts/' + p.accountId + '/containers/' + v.containerId),
      ),
    ];
  return [read(p, resource)];
}
function exact(d: unknown, resource: string): d is JsonObject {
  if (!obj(d) || d.path !== resource) return false;
  try {
    bound(d, resource);
    return true;
  } catch {
    return false;
  }
}
function collectionRows(p: CompiledRequest, d: JsonObject): JsonObject[] {
  const key = p.gtmState!.key!,
    rows = d[key] ?? [];
  if (
    !Array.isArray(rows) ||
    (d[key] === undefined && Object.keys(d).some(k => !['nextPageToken', 'requestId'].includes(k)))
  )
    fail('STATE_READ_FAILED', 'Missing or malformed Tag Manager collection.');
  const resource = p.path.slice(prefix.length),
    seen = new Set<string>();
  for (const row of rows) {
    const identity = key === 'builtInVariable' ? row?.type : row?.path;
    if (
      !obj(row) ||
      !simple(key === 'builtInVariable' ? identity : row.path?.slice(resource.length + 1)) ||
      seen.has(identity) ||
      typeof row.path !== 'string' ||
      !row.path.startsWith(resource + '/') ||
      !exact(row, row.path)
    )
      fail('STATE_TARGET_MISMATCH', 'Collection membership has duplicate or foreign identities.');
    if (key === 'builtInVariable' && !document().schemas.BuiltInVariable.properties.type.enum.includes(row.type))
      fail('STATE_TARGET_MISMATCH', 'Unknown built-in variable identity.');
    seen.add(identity);
  }
  return rows;
}
export function validateGtmWorkflowState(p: CompiledRequest, response: TransportResult, allowPage = false): void {
  const d = response.data,
    marker = p.gtmState;
  if (!marker) return;
  if (
    response.status === 404 &&
    p.action === 'AMCP_STATE_OPTIONAL' &&
    obj(d) &&
    d.amcp_absent === true &&
    d.path === p.path
  )
    return;
  if (response.status !== 200 || !obj(d) || d.error)
    fail('STATE_READ_FAILED', 'Tag Manager state needs a successful native response.');
  if (marker.kind === 'collection') {
    collectionRows(p, d);
    if ((d.nextPageToken !== undefined && typeof d.nextPageToken !== 'string') || (!allowPage && d.nextPageToken))
      fail('INCOMPLETE_STATE', 'Tag Manager collection is incomplete.');
    return;
  }
  const resource = p.path.slice(prefix.length);
  if (marker.kind === 'status') {
    if (
      Object.keys(d).some(k => !['workspaceChange', 'mergeConflict'].includes(k)) ||
      ['workspaceChange', 'mergeConflict'].some(k => d[k] !== undefined && !Array.isArray(d[k]))
    )
      fail('STATE_READ_FAILED', 'Malformed workspace status.');
    const owner = resource.slice(0, -7);
    for (const change of d.workspaceChange ?? []) {
      const records = Object.entries(change).filter(([k]) => k !== 'changeStatus');
      if (records.length !== 1 || !obj(records[0]![1]) || !(records[0]![1] as JsonObject).path?.startsWith(owner + '/'))
        fail('STATE_TARGET_MISMATCH', 'Workspace changes must identify the selected workspace.');
    }
    if (d.mergeConflict?.length)
      fail('STATE_CONFLICT', 'Resolve workspace conflicts explicitly before this operation.');
    return;
  }
  if (marker.kind === 'latest') {
    const root = resource.replace('/version_headers:latest', '');
    if (
      !simple(d.containerVersionId) ||
      !['/versions/', '/version_headers/'].some(k => d.path === root + k + d.containerVersionId)
    )
      fail('STATE_TARGET_MISMATCH', 'Latest version header belongs to another container.');
    bound(d, d.path);
    return;
  }
  if (!exact(d, resource))
    fail('STATE_TARGET_MISMATCH', 'State did not identify the exact selected Tag Manager resource.');
}
export async function readGtmWorkflow(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  if (p.gtmState?.kind !== 'collection') return request(p);
  const rows: JsonObject[] = [],
    tokens = new Set<string>();
  let current = p;
  for (let page = 0; page < 100; page++) {
    const response = await request(current);
    validateGtmWorkflowState(current, response, true);
    const d = response.data as JsonObject;
    rows.push(...collectionRows(current, d));
    if (rows.length > 1000) fail('STATE_TOO_LARGE', 'This review supports up to 1000 complete collection entries.');
    if (!d.nextPageToken) {
      const result = {
        ...response,
        data: {
          [p.gtmState.key!]: rows.sort((a, b) =>
            String(a.type ?? a.path).localeCompare(String(b.type ?? b.path), 'en'),
          ),
        },
      };
      validateGtmWorkflowState(p, result);
      return result;
    }
    if (tokens.has(d.nextPageToken)) fail('INCOMPLETE_STATE', 'Tag Manager repeated a collection cursor.');
    tokens.add(d.nextPageToken);
    current = {...p, query: {pageToken: d.nextPageToken}};
  }
  return fail('INCOMPLETE_STATE', 'Tag Manager pagination exceeded 100 pages.');
}
/** Environment preview authorization is sensitive. Preserve its change guard
 * as a one-way digest, without persisting or returning the authorization code. */
export function gtmSafeConfiguration(value: unknown): any {
  if (Array.isArray(value)) return value.map(gtmSafeConfiguration);
  if (!obj(value)) return value;
  const out = Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== 'authorizationCode')
      .map(([k, v]) => [k, gtmSafeConfiguration(v)]),
  );
  if (typeof value.authorizationCode === 'string') out.amcpAuthorizationCodeHash = sha256(value.authorizationCode);
  if (Array.isArray(out.containerAccess))
    out.containerAccess.sort((a: JsonObject, b: JsonObject) => a.containerId.localeCompare(b.containerId, 'en'));
  for (const key of ['firingTriggerId', 'blockingTriggerId', 'enablingTriggerId', 'disablingTriggerId'])
    if (Array.isArray(out[key])) out[key] = [...out[key]].sort();
  return out;
}
export function validateGtmWorkflowPrerequisites(p: CompiledRequest, states: unknown[], preparing = false): void {
  const a = gtmWorkflowKind(p);
  if (!a) return;
  const first = states[0] as JsonObject,
    b = obj(p.body) ? p.body : {},
    rows = (states[1] as JsonObject)?.userPermission as JsonObject[] | undefined;
  if (a.includes('USER_PERMISSION')) {
    if (!Array.isArray(rows)) fail('STATE_READ_FAILED', 'Complete current account permissions are required.');
    if (
      a === 'CREATE_USER_PERMISSION' &&
      rows.some(r => String(r.emailAddress).toLowerCase() === b.emailAddress.toLowerCase())
    )
      fail('CONFIGURATION_EXISTS', 'This email already has an account permission. Review its existing grant.');
    if (a === 'UPDATE_USER_PERMISSION' && first.emailAddress?.toLowerCase() !== b.emailAddress.toLowerCase())
      invalid('The permission recipient is immutable; create a separately reviewed grant for another email.');
    if (
      a !== 'CREATE_USER_PERMISSION' &&
      first.accountAccess?.permission === 'admin' &&
      (a === 'DELETE_USER_PERMISSION' || b.accountAccess.permission !== 'admin') &&
      !rows.some(r => r.path !== first.path && r.accountAccess?.permission === 'admin')
    )
      fail('STATE_LAST_ADMIN', 'This operation would remove the last observed account administrator.');
  }
  if (a === 'SET_LATEST_CONTAINER_VERSION' && first.deleted === true)
    fail('STATE_TARGET_DELETED', 'Undelete the selected version before setting it as latest.');
  if (a === 'UNDELETE_CONTAINER_VERSION' && preparing && first.deleted !== true)
    fail('CONFIGURATION_EXISTS', 'The selected container version is not deleted.');
  if (a === 'REAUTHORIZE_ENVIRONMENT') {
    if (typeof first.amcpAuthorizationCodeHash !== 'string' || !first.amcpAuthorizationCodeHash)
      fail('STATE_READ_FAILED', 'Environment authorization state is unavailable.');
    if (!p.scopeContext?.gtmPriorAuthHash)
      p.scopeContext = {...p.scopeContext, gtmPriorAuthHash: first.amcpAuthorizationCodeHash};
  }
  if (a.includes('BUILT_IN_VARIABLE')) {
    const types = (first.builtInVariable ?? []).map((r: JsonObject) => r.type),
      wanted = a === 'REVERT_BUILT_IN_VARIABLE' ? [p.query.type] : p.query.type;
    if (preparing && a === 'CREATE_BUILT_IN_VARIABLES' && wanted.some((t: string) => types.includes(t)))
      fail('CONFIGURATION_EXISTS', 'A requested built-in variable is already enabled.');
    if (a === 'DELETE_BUILT_IN_VARIABLES' && wanted.some((t: string) => !types.includes(t)))
      fail('STATE_NOT_FOUND', 'A requested built-in variable is not enabled.');
  }
}
export function gtmWorkflowOutcome(p: CompiledRequest, response: TransportResult): boolean {
  const a = gtmWorkflowKind(p)!,
    c = gtmWorkflowContracts[a]!,
    d = response.data,
    resource = target(p);
  if (![200, 201, 204].includes(response.status) || (obj(d) && d.error)) return false;
  if (a === 'DELETE_BUILT_IN_VARIABLES' || a === 'DELETE_USER_PERMISSION' || a === 'MOVE_ENTITIES_TO_FOLDER')
    return empty(d);
  if (!obj(d) || response.status === 204) return false;
  if (c.entity)
    return (
      Object.keys(d).every(k => k === c.entity![1]) && (d[c.entity[1]] === undefined || exact(d[c.entity[1]], resource))
    );
  if (a === 'CREATE_BUILT_IN_VARIABLES') {
    try {
      const rows = collectionRows(read(p, resource, 'collection', 'builtInVariable'), d);
      return rows.length === p.query.type.length && rows.every(r => p.query.type.includes(r.type));
    } catch {
      return false;
    }
  }
  if (a === 'REVERT_BUILT_IN_VARIABLE')
    return typeof d.enabled === 'boolean' && Object.keys(d).every(k => k === 'enabled');
  if (a === 'IMPORT_TEMPLATE_FROM_GALLERY') {
    const g = d.galleryReference;
    return (
      typeof d.path === 'string' &&
      d.path.startsWith(resource + '/') &&
      simple(d.path.slice(resource.length + 1)) &&
      exact(d, d.path) &&
      obj(g) &&
      g.owner === p.query.galleryOwner &&
      g.repository === p.query.galleryRepository &&
      g.version === p.query.gallerySha
    );
  }
  if (a === 'CREATE_USER_PERMISSION')
    return (
      typeof d.path === 'string' &&
      d.path.startsWith(resource + '/') &&
      simple(d.path.slice(resource.length + 1)) &&
      exact(d, d.path) &&
      d.emailAddress?.toLowerCase() === (p.body as JsonObject).emailAddress.toLowerCase()
    );
  if (!exact(d, resource)) return false;
  if (a === 'REAUTHORIZE_ENVIRONMENT')
    return (
      typeof d.authorizationCode === 'string' &&
      !!d.authorizationCode &&
      sha256(d.authorizationCode) !== p.scopeContext?.gtmPriorAuthHash
    );
  if (a === 'UNDELETE_CONTAINER_VERSION') return d.deleted !== true;
  return true;
}
export function gtmWorkflowVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const a = gtmWorkflowKind(p)!,
    c = gtmWorkflowContracts[a]!,
    d = result.data,
    resource = target(p),
    b = obj(p.body) ? p.body : {};
  const verify = (path: string, expected: JsonObject, optional = false) => ({
    read: read(p, path, 'resource', undefined, optional),
    expected,
    id: path,
  });
  if (c.entity)
    return [
      d[c.entity[1]]
        ? verify(resource, gtmSafeConfiguration(d[c.entity[1]]))
        : verify(resource, {amcp_absent: true, path: prefix + resource}, true),
    ];
  if (a === 'DELETE_USER_PERMISSION') return [verify(resource, {amcp_absent: true, path: prefix + resource}, true)];
  if (a.includes('BUILT_IN_VARIABLE')) {
    const old = ((before[0] as JsonObject).builtInVariable ?? []).map((r: JsonObject) => r.type),
      types = a === 'REVERT_BUILT_IN_VARIABLE' ? [p.query.type] : p.query.type,
      enabled = a === 'CREATE_BUILT_IN_VARIABLES' || (a === 'REVERT_BUILT_IN_VARIABLE' && d.enabled);
    const expected = {
      types: [...new Set([...old.filter((t: string) => !types.includes(t)), ...(enabled ? types : [])])].sort(),
    };
    return [
      {read: read(p, workspaceOf(p)! + '/built_in_variables', 'collection', 'builtInVariable'), expected, id: resource},
    ];
  }
  if (a === 'MOVE_ENTITIES_TO_FOLDER')
    return moved(p).map(path =>
      verify(path, {path, parentFolderId: resource.split('/').at(-1) === '0' ? '' : resource.split('/').at(-1)}),
    );
  if (a === 'SET_LATEST_CONTAINER_VERSION')
    return [
      {
        read: read(p, containerOf(p)! + '/version_headers:latest', 'latest'),
        expected: {containerVersionId: resource.split('/').at(-1)},
        id: resource,
      },
    ];
  if (a === 'UNDELETE_CONTAINER_VERSION') return [verify(resource, {path: resource, deleted: false})];
  if (a === 'REAUTHORIZE_ENVIRONMENT')
    return [verify(resource, {path: resource, amcpAuthorizationCodeHash: d.amcpAuthorizationCodeHash})];
  if (a === 'IMPORT_TEMPLATE_FROM_GALLERY')
    return [
      verify(d.path, {
        path: d.path,
        galleryReference: {
          owner: p.query.galleryOwner,
          repository: p.query.galleryRepository,
          version: p.query.gallerySha,
        },
        ...(typeof d.templateData === 'string' ? {templateData: d.templateData} : {}),
      }),
    ];
  const expected = gtmSafeConfiguration({...b, path: d.path});
  return [verify(d.path, expected)];
}
export function gtmWorkflowObserved(p: CompiledRequest, data: JsonObject): JsonObject {
  if (data.amcp_absent) return data;
  if (p.gtmState?.kind === 'collection' && p.gtmState.key === 'builtInVariable')
    return {types: data.builtInVariable.map((r: JsonObject) => r.type).sort()};
  const value = gtmSafeConfiguration(data);
  if (/\/versions\/[^/:]+$/.test(p.path)) value.deleted = data.deleted === true;
  if (/\/(tags|triggers|variables)\/[^/:]+$/.test(p.path) && data.parentFolderId === undefined)
    value.parentFolderId = '';
  return value;
}
export function gtmWorkflowDestructive(p: CompiledRequest): boolean {
  const a = gtmWorkflowKind(p);
  return (
    !!a &&
    (a.startsWith('REVERT_') ||
      ['DELETE_BUILT_IN_VARIABLES', 'DELETE_USER_PERMISSION', 'REAUTHORIZE_ENVIRONMENT'].includes(a))
  );
}
