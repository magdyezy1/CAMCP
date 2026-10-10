import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import type {NativeTransport} from './transport.js';
import {metaPrefix} from './meta-version.js';

/**
 * What Meta granted, from one `/me/permissions` response (CON-03). Meta's token exchanges return no scope, and with
 * Facebook Login for Business the configuration, not the scope parameter, decides the permissions, so only this read
 * says what the login can do. A malformed or paginated answer is not knowledge: `known` is false and nothing counts as
 * granted. Metadata only; no token or provider text is kept.
 */
export function metaPermissionGrants(body: unknown, now = Date.now()): JsonObject {
  const unknown = (reason: string) => ({source: 'permissions_endpoint', known: false, reason, checked_at: now});
  const data = body && typeof body === 'object' && !Array.isArray(body) ? (body as JsonObject) : undefined;
  if (
    !data ||
    !Array.isArray(data.data) ||
    data.data.some(
      (row: JsonObject) =>
        !row ||
        typeof row.permission !== 'string' ||
        !/^[a-z_]{1,64}$/.test(row.permission) ||
        !['granted', 'declined', 'expired'].includes(row.status),
    )
  )
    return unknown('invalid_response');
  if (data.paging?.next !== undefined) return unknown('incomplete_response');
  const of = (status: string) =>
    [...new Set(data.data.filter((r: JsonObject) => r.status === status).map((r: JsonObject) => r.permission))].sort();
  return {
    source: 'permissions_endpoint',
    known: true,
    granted: of('granted'),
    declined: of('declined'),
    expired: of('expired'),
    checked_at: now,
  };
}

// Operator credential diagnostic only. This does not add an account-scope exception
// to the MCP service or request any permission changes from Meta.
export async function readMetaPermissions(
  transport: NativeTransport,
  connection: Connection,
  credentials: Credentials,
): Promise<JsonObject> {
  if (connection.gateway !== 'meta_native_action' || !connection.enabled)
    throw new MirrorError('CONNECTION_REQUIRED', 'An enabled Meta connection is required.');
  const plan: CompiledRequest = {
    gateway: 'meta_native_action',
    action: 'LOCAL_TOKEN_PERMISSIONS',
    method: 'GET',
    path: metaPrefix + 'me/permissions',
    query: {limit: 100},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'INDEPENDENT_CREDENTIAL_DIAGNOSTIC',
    warnings: [],
  };
  const response = await transport.request(plan, connection, credentials),
    body = response.data as JsonObject;
  if (
    !body ||
    !Array.isArray(body.data) ||
    body.data.some(
      (row: JsonObject) =>
        !row || typeof row.permission !== 'string' || !['granted', 'declined', 'expired'].includes(row.status),
    )
  )
    throw new MirrorError(
      'UPSTREAM_RESPONSE_INVALID',
      'Meta permissions did not return the expected permission/status rows.',
    );
  if (
    body.paging !== undefined &&
    (!body.paging ||
      typeof body.paging !== 'object' ||
      Array.isArray(body.paging) ||
      (body.paging.next !== undefined && typeof body.paging.next !== 'string'))
  )
    throw new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Meta permissions paging metadata is malformed.');
  const permissions = body.data.map((row: JsonObject) => ({permission: row.permission, status: row.status})),
    complete = !body.paging?.next;
  const granted = (name: string) =>
    permissions.some((row: JsonObject) => row.permission === name && row.status === 'granted')
      ? true
      : complete
        ? false
        : null;
  return {
    http_status: response.status,
    trace_id: response.headers['x-fb-trace-id'] ?? null,
    permissions,
    complete,
    ads_read_granted: granted('ads_read'),
    ads_management_granted: granted('ads_management'),
    account_access_verified: false,
    vendor_writes: 0,
  };
}
