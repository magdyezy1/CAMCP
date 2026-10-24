import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {familyStateErrors, readOf, type StateFlaggedRefusal} from './family-kit.js';
import {stable, sha256} from './security.js';
import {changedStateFields} from './review-state-core.js';
import {assertPlaceActionScope, placeActionSafeError, placeActionSafe} from './google-place-action-links.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

const gateway = 'google_business_native_action',
  origin = 'https://mybusinessaccountmanagement.googleapis.com',
  locationOrigin = 'https://mybusinessbusinessinformation.googleapis.com';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 1024): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const roleRank: Record<string, number> = {SITE_MANAGER: 0, MANAGER: 1, OWNER: 2, PRIMARY_OWNER: 3};
type Kind = 'rename' | 'create' | 'patch' | 'delete';
type Send = (p: CompiledRequest) => Promise<TransportResult>;
const fail: StateFlaggedRefusal = familyStateErrors('INVALID_BUSINESS_ACCESS', 'BUSINESS_ACCESS_STATE_UNVERIFIED');
function only(value: JsonObject, keys: string[], state = false) {
  if (Object.keys(value).some(k => !keys.includes(k)))
    fail('Unqualified Business Profile access field, query override or native response envelope.', state);
}
function parent(p: CompiledRequest): string {
  const found = /^\/v1\/((?:accounts|locations)\/[1-9][0-9]*)(?:\/|$)/.exec(p.path)?.[1],
    id = p.accountId;
  if (!found || id !== (found.startsWith('accounts/') ? found.slice(9) : found))
    fail('Use the exact account or locations/{id} grant matching the native resource.');
  return found;
}
export function businessAccessKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.origin !== origin || p.specialTransport) return;
  if (
    p.action === 'gmb_account_ops/PATCH_ACCOUNT' &&
    p.method === 'PATCH' &&
    /^\/v1\/accounts\/[1-9][0-9]*$/.test(p.path)
  )
    return 'rename';
  const m = /^gmb_account_ops\/(CREATE|PATCH|DELETE)_(ACCOUNT|LOCATION)_ADMIN$/.exec(p.action);
  if (!m || p.method !== ({CREATE: 'POST', PATCH: 'PATCH', DELETE: 'DELETE'} as JsonObject)[m[1]!]) return;
  if (
    new RegExp(
      '^/v1/' +
        (m[2] === 'ACCOUNT' ? 'accounts' : 'locations') +
        '/[1-9][0-9]*/admins' +
        (m[1] === 'CREATE' ? '' : '/[A-Za-z0-9_-]{1,256}') +
        '$',
    ).test(p.path)
  )
    return m[1]!.toLowerCase() as Kind;
}
export function assertBusinessAccessActor(p: CompiledRequest, a: Actor) {
  if (businessAccessKind(p) && (a.role !== 'admin' || a.testAccount === true))
    throw new MirrorError(
      'ADMIN_REQUIRED',
      'Only a current workspace administrator can change Business Profile account names or administrator access. Reviewer test accounts cannot make this administrative change.',
      {},
      403,
    );
}
export function assertBusinessAccessScope(c: Connection) {
  assertPlaceActionScope(c);
}
function email(value: unknown, state = false): string {
  if (!text(value, 254) || !/^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(value))
    fail('Provide one exact invitee email address, without display names, lists or control characters.', state);
  return (value as string).toLowerCase();
}
export function assertBusinessAccess(p: CompiledRequest): void {
  const kind = businessAccessKind(p);
  if (!kind) return;
  const resource = parent(p),
    b = p.body;
  if (Object.keys(p.headers).length) fail('Business access changes do not accept header overrides.');
  if (kind === 'delete') {
    only(p.query, []);
    if (b !== undefined && (!object(b) || Object.keys(b).length)) fail('Admin deletion has no body.');
    return;
  }
  if (!object(b)) fail('Provide the native Account or Admin payload.');
  const body = b as JsonObject;
  if (kind === 'rename') {
    only(body, ['name', 'accountName']);
    only(p.query, ['updateMask']);
    if (
      p.query.updateMask !== 'accountName' ||
      !text(body.accountName) ||
      (body.name !== undefined && body.name !== resource)
    )
      fail('Account rename supports exactly accountName with updateMask=accountName and an optional matching name.');
    return;
  }
  if (kind === 'create') {
    only(body, ['admin', 'account', 'role']);
    only(p.query, []);
    if (Object.hasOwn(body, 'admin') === Object.hasOwn(body, 'account'))
      fail('Choose one invitee email or one LocationGroup account; never supply both.');
    if (body.admin !== undefined) email(body.admin);
    if (
      body.account !== undefined &&
      (!resource.startsWith('locations/') ||
        typeof body.account !== 'string' ||
        !/^accounts\/[1-9][0-9]*$/.test(body.account))
    )
      fail('Only location invitations can name a LocationGroup account, using accounts/{id}.');
  } else {
    only(body, ['name', 'role']);
    only(p.query, ['updateMask']);
    if (p.query.updateMask !== 'role' || (body.name !== undefined && body.name !== p.path.slice(4)))
      fail('Update only role, with an exact matching admin name and updateMask=role.');
  }
  if (body.role === 'PRIMARY_OWNER')
    fail(
      'Primary-ownership transfer needs a separate verified acting-owner and former-owner transition contract. Use OWNER or MANAGER here; do not disguise a transfer as an invitation.',
    );
  if (!['OWNER', 'MANAGER', ...(resource.startsWith('locations/') ? ['SITE_MANAGER'] : [])].includes(body.role))
    fail('Choose OWNER or MANAGER; SITE_MANAGER is a native location-only role.');
}
function read(
  p: CompiledRequest,
  resource: string,
  query: JsonObject = {},
  host = origin,
  grant = p.accountId,
): CompiledRequest {
  // The grant's account is set after the body and before the cleared response controls, as this read always set them.
  return readOf(
    p,
    {before: {origin: host}, action: 'AMCP_BUSINESS_ACCESS_READ', path: '/v1/' + resource, query, clears: []},
    {accountId: grant, responseControls: undefined},
  );
}
export function businessAccessSnapshots(p: CompiledRequest): CompiledRequest[] {
  const resource = parent(p),
    plans = [
      resource.startsWith('accounts/')
        ? read(p, resource)
        : read(p, resource, {readMask: 'name,title,storeCode'}, locationOrigin),
    ];
  if (businessAccessKind(p) !== 'rename') plans.push(read(p, resource + '/admins'));
  if (businessAccessKind(p) === 'create' && (p.body as JsonObject).account) {
    const account = (p.body as JsonObject).account;
    plans.push(read(p, account, {}, origin, account.slice(9)));
  }
  return plans;
}
export function authorizeBusinessAccessRead(p: CompiledRequest, c: Connection, id: string): boolean {
  if (p.gateway !== gateway || p.action !== 'AMCP_BUSINESS_ACCESS_READ') return false;
  assertBusinessAccessScope(c);
  if (p.method !== 'GET' || !p.readOnly || p.body !== undefined || Object.keys(p.headers).length || p.accountId !== id)
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Invalid Business Profile access prerequisite.', {}, 403);
  const ok =
    (p.origin === origin &&
      (p.path === '/v1/accounts/' + id ||
        p.path === '/v1/accounts/' + id + '/admins' ||
        (id.startsWith('locations/') && p.path === '/v1/' + id + '/admins')) &&
      Object.keys(p.query).length === 0) ||
    (p.origin === locationOrigin &&
      id.startsWith('locations/') &&
      p.path === '/v1/' + id &&
      stable(p.query) === stable({readMask: 'name,title,storeCode'}));
  if (!ok)
    throw new MirrorError(
      'ACCOUNT_SCOPE_MISMATCH',
      'Access prerequisites must retain exact native resource scope and complete membership.',
      {},
      403,
    );
  return true;
}
function accountIdentity(resource: string, value: unknown): JsonObject {
  if (!object(value)) fail('The native account identity is missing.', true);
  const v = value as JsonObject;
  only(
    v,
    [
      'name',
      'accountName',
      'type',
      'role',
      'permissionLevel',
      'accountNumber',
      'organizationInfo',
      'verificationState',
      'vettedState',
    ],
    true,
  );
  if (
    v.name !== resource ||
    !text(v.accountName) ||
    !['PERSONAL', 'LOCATION_GROUP', 'USER_GROUP', 'ORGANIZATION'].includes(v.type) ||
    (v.role !== undefined && !['ACCOUNT_ROLE_UNSPECIFIED', ...Object.keys(roleRank)].includes(v.role)) ||
    (v.permissionLevel !== undefined &&
      !['PERMISSION_LEVEL_UNSPECIFIED', 'OWNER_LEVEL', 'MEMBER_LEVEL'].includes(v.permissionLevel))
  )
    fail('The native account identity or authority is incomplete.', true);
  return {
    name: v.name,
    accountName: v.accountName,
    type: v.type,
    role: v.role ?? null,
    permissionLevel: v.permissionLevel ?? null,
  };
}
function locationIdentity(resource: string, value: unknown): JsonObject {
  if (!object(value)) fail('The native location identity is missing.', true);
  const v = value as JsonObject;
  only(v, ['name', 'title', 'storeCode'], true);
  if (v.name !== resource || !text(v.title) || (v.storeCode !== undefined && !text(v.storeCode)))
    fail('The native location identity is incomplete.', true);
  return {...v, storeCode: v.storeCode ?? ''};
}
function member(resource: string, value: unknown): JsonObject {
  if (!object(value)) fail('The native admin is missing.', true);
  const v = value as JsonObject;
  only(v, ['name', 'admin', 'account', 'role', 'pendingInvitation'], true);
  if (
    typeof v.name !== 'string' ||
    !new RegExp('^' + resource + '/admins/[A-Za-z0-9_-]{1,256}$').test(v.name) ||
    !Object.hasOwn(roleRank, v.role) ||
    (v.pendingInvitation !== undefined && typeof v.pendingInvitation !== 'boolean') ||
    (v.admin !== undefined && v.admin !== '' && !text(v.admin)) ||
    (v.account !== undefined &&
      v.account !== '' &&
      (typeof v.account !== 'string' || !/^accounts\/[1-9][0-9]*$/.test(v.account)))
  )
    fail('The admin identity, role or invitation state is incomplete.', true);
  if (v.pendingInvitation && !v.account) email(v.admin, true);
  // Active users expose a mutable display name, not their login email. Keep the
  // stable resource ID; pending email and group-account bindings remain protected.
  return {
    name: v.name,
    role: v.role,
    pendingInvitation: v.pendingInvitation ?? false,
    account: v.account || null,
    invitee_email: v.pendingInvitation && !v.account ? email(v.admin, true) : null,
  };
}
function members(resource: string, value: unknown): JsonObject {
  if (!object(value)) fail('The native membership collection is missing.', true);
  const key = resource.startsWith('accounts/') ? 'accountAdmins' : 'admins',
    v = value as JsonObject;
  only(v, [key], true);
  if (!Array.isArray(v[key]) || v[key].length < 1 || v[key].length > 1000)
    fail('A complete nonempty native admin list is required, bounded to 1000 members.', true);
  const result: JsonObject = {},
    principals = new Set<string>();
  for (const row of v[key]) {
    const m = member(resource, row),
      principal = m.account ?? m.invitee_email;
    if (result[m.name] || (principal && principals.has(principal)))
      fail('Membership contains duplicate identities or pending principals.', true);
    result[m.name] = m;
    if (principal) principals.add(principal);
  }
  if (Object.values(result).filter((m: any) => m.role === 'PRIMARY_OWNER' && !m.pendingInvitation).length !== 1)
    fail('Exactly one active primary owner must be identified before access changes.', true);
  return result;
}
async function currentState(p: CompiledRequest, send: Send): Promise<JsonObject> {
  const resource = parent(p),
    plans = businessAccessSnapshots(p),
    started = performance.now();
  let bytes = 0;
  const get = async (plan: CompiledRequest) => {
    if (performance.now() - started > 30000) fail('Access discovery exceeded its 30-second monotonic deadline.', true);
    let result: TransportResult;
    try {
      result = await send(plan);
    } catch (e) {
      throw placeActionSafeError(e);
    }
    if (result.status !== 200 || !object(result.data))
      fail('A failed native read cannot prove an empty account or membership.', true);
    const size = Buffer.byteLength(JSON.stringify(result.data));
    bytes += size;
    if (size > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 30000)
      fail('Access discovery exceeded its byte or deadline bound.', true);
    return result.data;
  };
  const snapshot = async () => {
    const state: JsonObject = {
      resource: resource.startsWith('accounts/')
        ? accountIdentity(resource, await get(plans[0]!))
        : locationIdentity(resource, await get(plans[0]!)),
    };
    if (businessAccessKind(p) !== 'rename') state.admins = members(resource, await get(plans[1]!));
    if (plans[2]) state.invitee_group = accountIdentity(plans[2].path.slice(4), await get(plans[2]));
    return state;
  };
  const before = await snapshot();
  if (stable(before) !== stable(await snapshot()))
    fail('The resource authority or complete membership changed during discovery.', true);
  return before;
}
function prerequisites(p: CompiledRequest, before: JsonObject): void {
  const resource = parent(p),
    kind = businessAccessKind(p)!,
    body = (p.body ?? {}) as JsonObject;
  if (
    resource.startsWith('accounts/') &&
    (before.resource.type === 'PERSONAL' ||
      !['PRIMARY_OWNER', 'OWNER'].includes(before.resource.role) ||
      before.resource.permissionLevel === 'MEMBER_LEVEL')
  )
    fail('Account administration requires an identified business account and native owner authority.');
  if (kind === 'rename') return;
  const old = before.admins[p.path.slice(4)];
  if (kind !== 'create' && !old) fail('The exact selected admin is absent from the current membership.');
  if (kind !== 'create' && old.role === 'PRIMARY_OWNER' && !old.pendingInvitation)
    fail('The active primary owner cannot be removed or demoted by this contract.');
  if (kind === 'create') {
    if (body.account && before.invitee_group?.type !== 'LOCATION_GROUP')
      fail('The invited account must be a currently readable LOCATION_GROUP on this connection.');
    if (
      Object.values(before.admins).some((m: any) =>
        body.account ? m.account === body.account : m.invitee_email === email(body.admin),
      )
    )
      fail('That account or pending email is already a member; select the existing native admin instead.');
  }
}
function desired(p: CompiledRequest, before: JsonObject, receipt?: unknown): JsonObject {
  prerequisites(p, before);
  const kind = businessAccessKind(p)!,
    body = (p.body ?? {}) as JsonObject,
    next = structuredClone(before);
  if (kind === 'rename') {
    next.resource.accountName = body.accountName;
    return next;
  }
  const name = p.path.slice(4);
  if (kind === 'delete') {
    delete next.admins[name];
    return next;
  }
  if (kind === 'patch') {
    next.admins[name].role = body.role;
    return next;
  }
  if (receipt === undefined) return next;
  const row = member(parent(p), receipt);
  if (
    Object.hasOwn(before.admins, row.name) ||
    row.role !== body.role ||
    (body.account && row.account !== body.account) ||
    (!body.account && (row.account !== null || row.invitee_email !== email(body.admin) || !row.pendingInvitation))
  )
    fail('The invitation receipt does not prove a new exact requested principal and role.', true);
  next.admins[row.name] = row;
  return next;
}
export async function readBusinessAccessState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  const state = await currentState(p, send);
  prerequisites(p, state);
  return [state];
}
export function businessAccessOutcome(p: CompiledRequest, result: TransportResult, state: unknown[]): boolean {
  if (result.status !== 200) return false;
  try {
    const before = state[0] as JsonObject,
      kind = businessAccessKind(p),
      expected = desired(p, before, result.data);
    if (kind === 'delete') return object(result.data) && Object.keys(result.data).length === 0;
    if (kind === 'rename') return stable(accountIdentity(parent(p), result.data)) === stable(expected.resource);
    return (
      stable(member(parent(p), result.data)) ===
      stable(expected.admins[kind === 'create' ? (result.data as JsonObject).name : p.path.slice(4)])
    );
  } catch {
    return false;
  }
}
export async function verifyBusinessAccess(p: CompiledRequest, result: JsonObject, state: unknown[], send: Send) {
  const expected = desired(p, state[0] as JsonObject, result.data),
    actual = await currentState(p, send),
    kind = businessAccessKind(p),
    resource = kind === 'create' ? result.data.name : p.path.slice(4);
  // A previously verified pending-email receipt binds this new native admin ID.
  // Acceptance may race with read-back and replaces the email with display text.
  // Permit only that monotonic transition; role, account, ID and other members
  // must still match. We never infer acceptance merely from HTTP success.
  if (
    kind === 'create' &&
    expected.admins[resource].pendingInvitation &&
    actual.admins[resource]?.pendingInvitation === false
  ) {
    expected.admins[resource].pendingInvitation = false;
    expected.admins[resource].invitee_email = null;
  }
  const changed = changedStateFields([expected], [actual]),
    status = changed.length ? 'inconclusive' : 'verified',
    pending = kind === 'create' ? expected.admins[resource].pendingInvitation : false;
  return {
    status,
    checks: [
      {
        resource_id: resource,
        status,
        changed_fields: changed,
        expected_hash: sha256(stable(expected)),
        actual_hash: sha256(stable(actual)),
        ...(kind === 'create'
          ? {
              invitation_status: pending ? 'pending_acceptance' : 'accepted',
              access_granted: status === 'verified' && !pending,
            }
          : {}),
      },
    ],
    resources:
      status === 'verified' && kind !== 'delete'
        ? [
            {
              resource_id: resource,
              kind: kind === 'rename' ? 'business_account' : 'business_admin',
              ...(kind === 'create' ? {invitation_status: pending ? 'pending_acceptance' : 'accepted'} : {}),
            },
          ]
        : [],
  };
}
export function assertBusinessAccessPolicy(p: CompiledRequest, state: unknown, policy: JsonObject): void {
  const kind = businessAccessKind(p);
  if (!kind || kind === 'rename') return;
  const before = Array.isArray(state) ? state[0] : state;
  if (!object(before) || !object(before.admins))
    fail('An exact membership baseline is required for access policy evaluation.', true);
  const old = before.admins[p.path.slice(4)],
    requested = (p.body as JsonObject)?.role;
  const promotes = kind === 'create' || (kind === 'patch' && old && roleRank[requested]! > roleRank[old.role]!),
    demotes = kind === 'patch' && old && roleRank[requested]! < roleRank[old.role]!;
  if (policy.allow_activation === false && promotes)
    throw new MirrorError(
      'POLICY_ACTIVATION_FORBIDDEN',
      'The owner policy forbids enabling or increasing external administrator access.',
      {},
      403,
    );
  if (policy.allow_deletion === false && (kind === 'delete' || demotes))
    throw new MirrorError(
      'POLICY_DELETION_FORBIDDEN',
      'The owner policy forbids removing or reducing administrator access.',
      {},
      403,
    );
}
export function businessAccessImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const kind = businessAccessKind(p),
    before = state[0] as JsonObject,
    body = (p.body ?? {}) as JsonObject,
    old = before.admins?.[p.path.slice(4)];
  return {
    provider: 'google_business',
    resource: before.resource,
    effect:
      kind === 'rename'
        ? 'Renames the selected business account without changing its locations, grants or advertising.'
        : kind === 'create'
          ? 'Sends a provider invitation to the exact principal. Pending acceptance is not an active access grant.'
          : kind === 'patch'
            ? 'Changes only the selected administrator role and verifies the complete membership.'
            : 'Removes the exact administrator or pending invitation; current access may be lost.',
    target_admin: old ?? null,
    invitee: body.admin ?? body.account ?? null,
    previous_role: old?.role ?? null,
    requested_role: body.role ?? null,
    previous_account_name: kind === 'rename' ? before.resource.accountName : null,
    requested_account_name: body.accountName ?? null,
    policy:
      'A workspace administrator must approve this external access change. Owner activation policy covers new/increased access; deletion policy covers removal/demotion. No advertising budget changes.',
    provider_authority: parent(p).startsWith('locations/')
      ? 'The native member list does not identify the acting Google user. Google enforces owner permission and any seven-day new-owner restriction; AMCP does not infer them from local administrator status.'
      : 'The native account read must identify owner authority.',
    recovery:
      'Retain the original receipt and key after any uncertain response. Do not resend invitations or repeat role changes. Verify pending invitations separately from acceptance. Primary-owner transfers require a separate contract.',
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const businessAccessFamily: ReviewedFamily = {
  name: 'google_business_access',
  files: ['src/google-business-access.ts', ['tests/google-business-access.test.ts']],
  kind: businessAccessKind,
  assert: plan => assertBusinessAccess(plan),
  actor: (plan, actor) => assertBusinessAccessActor(plan, actor),
  scope: c => assertBusinessAccessScope(c),
  authorize: (plan, connection, account) => authorizeBusinessAccessRead(plan, connection, account),
  snapshots: businessAccessSnapshots,
  state: (plan, readers) =>
    readBusinessAccessState(plan, readers.guarded('Business access prerequisites must remain read-only.').read),
  impact: businessAccessImpact,
  outcome: businessAccessOutcome,
  safeOutcome: placeActionSafe,
  safeError: e => placeActionSafeError(e),
  verify: (plan, v) =>
    verifyBusinessAccess(
      plan,
      v.result,
      v.state,
      v.guarded('Business access verification must remain read-only.', {
        actor: () => assertBusinessAccessActor(plan, v.actor),
        check: assertBusinessAccessScope,
      }),
    ),
  exemptFromSpendTextMatch: true,
  administratorRequired: true,
};
