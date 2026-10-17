import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import {stable, sha256} from './security.js';
import {changedStateFields} from './review-state-core.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';

const gateway = 'google_ads_native_action',
  ranks: Record<string, number> = {EMAIL_ONLY: 0, READ_ONLY: 1, STANDARD: 2, ADMIN: 3};
const memberActions = new Set([
  'UPDATE_CUSTOMER_USER_ACCESS',
  'REMOVE_CUSTOMER_USER_ACCESS',
  'google_ads_v23_customer_user_access_mutate_customer_user_access',
]);
const inviteActions = new Set([
  'CREATE_CUSTOMER_USER_ACCESS_INVITATION',
  'REMOVE_CUSTOMER_USER_ACCESS_INVITATION',
  'google_ads_v23_customer_user_access_invitation_mutate_customer_user_access_invitation',
]);
const fields = {
  customer: ['id', 'currency_code', 'time_zone', 'manager'],
  customer_user_access: ['resource_name', 'user_id', 'email_address', 'access_role', 'pending_multi_party_auth_review'],
  customer_user_access_invitation: [
    'resource_name',
    'invitation_id',
    'email_address',
    'access_role',
    'invitation_status',
  ],
};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
type Send = (p: CompiledRequest) => Promise<TransportResult>;
type Kind = 'members' | 'invitations';
function fail(message: string, state = false): never {
  throw new MirrorError(
    state ? 'GOOGLE_ACCESS_STATE_UNVERIFIED' : 'INVALID_GOOGLE_ACCESS',
    message,
    {},
    state ? 502 : 400,
  );
}
function only(v: JsonObject, keys: string[], state = false) {
  if (Object.keys(v).some(k => !keys.includes(k)))
    fail('Unqualified Google access field, mutation option or response envelope.', state);
}
function account(p: CompiledRequest): string {
  if (!p.accountId || !/^\d+$/.test(p.accountId)) fail('Select one exact Google Ads customer.');
  return p.accountId;
}
const collection = (kind: Kind) => (kind === 'members' ? 'customerUserAccesses' : 'customerUserAccessInvitations');
function name(p: CompiledRequest, v: unknown, kind: Kind, state = false): string {
  if (
    typeof v !== 'string' ||
    !new RegExp('^customers/' + account(p) + '/' + collection(kind) + '/[1-9][0-9]*$').test(v)
  )
    fail('Use the exact selected-customer access or invitation resource name.', state);
  return v as string;
}
function email(v: unknown, state = false): string {
  if (
    typeof v !== 'string' ||
    v.length > 254 ||
    !v ||
    v !== v.trim() ||
    /[\u0000-\u001f\u007f]/.test(v) ||
    !/^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(v)
  )
    fail('Supply one exact email address without display names or control characters.', state);
  return (v as string).toLowerCase();
}
export function googleAccessKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== gateway ||
    p.method !== 'POST' ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://googleads.googleapis.com')
  )
    return;
  if (memberActions.has(p.action) && /^\/v\d+\/customers\/\d+\/customerUserAccesses:mutate$/.test(p.path))
    return 'members';
  if (inviteActions.has(p.action) && /^\/v\d+\/customers\/\d+\/customerUserAccessInvitations:mutate$/.test(p.path))
    return 'invitations';
}
export function assertGoogleAccessActor(p: CompiledRequest, a: Actor) {
  if (googleAccessKind(p) && (a.role !== 'admin' || a.testAccount === true))
    throw new MirrorError(
      'ADMIN_REQUIRED',
      'Only a current workspace administrator can change Google Ads user access. Reviewer test accounts cannot change external administrators.',
      {},
      403,
    );
}
const operation = (p: CompiledRequest): JsonObject => googleJson(p.body).operation;
export function assertGoogleAccess(p: CompiledRequest): void {
  const kind = googleAccessKind(p);
  if (!kind) return;
  const b = googleJson(p.body);
  if (!object(b)) fail('Provide one native operation.');
  only(b, ['operation']);
  if (p.path.split('/')[3] !== account(p) || Object.keys(p.query).length || Object.keys(p.headers).length)
    fail('Use the exact customer route without query/header overrides.');
  const op = b.operation;
  if (!object(op))
    fail('These native services take singular operation, not operations, partialFailure or validateOnly.');
  only(op, ['create', 'update', 'remove', 'updateMask']);
  const verbs = ['create', 'update', 'remove'].filter(k => Object.hasOwn(op, k));
  if (verbs.length !== 1) fail('Choose exactly one supported operation.');
  const verb = verbs[0]!;
  if (
    (p.action.startsWith('CREATE_') && verb !== 'create') ||
    (p.action.startsWith('UPDATE_') && verb !== 'update') ||
    (p.action.startsWith('REMOVE_') && verb !== 'remove')
  )
    fail('The legacy action must match the native operation.');
  if (verb === 'remove') {
    name(p, op.remove, kind);
    if (op.updateMask !== undefined) fail('Removal has no updateMask.');
    return;
  }
  if ((kind === 'members' && verb !== 'update') || (kind === 'invitations' && verb !== 'create'))
    fail('User access supports update/remove; invitations support create/remove.');
  const row = op[verb];
  if (!object(row)) fail('Provide a native user access or invitation object.');
  if (verb === 'create') {
    only(row, ['emailAddress', 'accessRole']);
    email(row.emailAddress);
    if (op.updateMask !== undefined) fail('Invitations are immutable and have no updateMask.');
  } else {
    only(row, ['resourceName', 'accessRole']);
    name(p, row.resourceName, kind);
    if (op.updateMask !== 'accessRole') fail('Update exactly accessRole with its explicit native field mask.');
  }
  if (typeof row.accessRole !== 'string' || !Object.hasOwn(ranks, row.accessRole))
    fail(
      'Choose ADMIN, STANDARD, READ_ONLY or EMAIL_ONLY; the provider enforces eligibility for the selected principal.',
    );
}
function read(p: CompiledRequest, kind: keyof typeof fields): CompiledRequest {
  const query =
    'SELECT ' +
    fields[kind].map(f => kind + '.' + f).join(', ') +
    ' FROM ' +
    kind +
    (kind === 'customer' ? ' LIMIT 1' : '');
  return {
    ...p,
    action: 'AMCP_GOOGLE_ACCESS_READ',
    method: 'POST',
    path: googleAdsCustomers + account(p) + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
  };
}
export function googleAccessSnapshots(p: CompiledRequest): CompiledRequest[] {
  return (Object.keys(fields) as (keyof typeof fields)[]).map(k => read(p, k));
}
async function currentState(p: CompiledRequest, send: Send): Promise<JsonObject> {
  let requests = 0,
    bytes = 0;
  const started = performance.now();
  const fetch = async (kind: keyof typeof fields) => {
    const rows: JsonObject[] = [],
      tokens = new Set<string>();
    let token: string | undefined, count: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 25 || ++requests > 104 || performance.now() - started > 60000)
        fail('Access discovery exceeded its page, request or monotonic deadline bound.', true);
      const plan = read(p, kind);
      if (token) (plan.body as JsonObject).pageToken = token;
      const response = await send(plan),
        data = response.data;
      if (response.status !== 200 || !object(data)) fail('The customer or membership read failed.', true);
      only(
        data as JsonObject,
        ['results', 'fieldMask', 'queryResourceConsumption', 'requestId', 'nextPageToken', 'totalResultsCount'],
        true,
      );
      const d = data as JsonObject,
        size = Buffer.byteLength(JSON.stringify(d));
      bytes += size;
      if (size > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
        fail('Access state exceeded its byte/time bound.', true);
      if (
        (d.results !== undefined && !Array.isArray(d.results)) ||
        (d.nextPageToken !== undefined && typeof d.nextPageToken !== 'string')
      )
        fail('Malformed membership page.', true);
      if (d.totalResultsCount !== undefined) {
        const n = String(d.totalResultsCount);
        if (!/^\d+$/.test(n) || (count !== undefined && n !== count))
          fail('The native membership count is invalid or changed.', true);
        count = n;
      }
      for (const row of d.results ?? []) {
        if (
          !object(row) ||
          Object.keys(row).length !== 1 ||
          !object(row[kind.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())])
        )
          fail('Invalid native membership row.', true);
        rows.push(Object.values(row)[0] as JsonObject);
      }
      if (rows.length > (kind === 'customer' ? 1 : 1000)) fail('The complete membership exceeds 1000 records.', true);
      if (!d.nextPageToken) break;
      if (!d.results?.length || d.nextPageToken.length > 4096 || tokens.has(d.nextPageToken))
        fail('Membership pagination is incomplete or repeating.', true);
      tokens.add(d.nextPageToken);
      token = d.nextPageToken;
    }
    if (count !== undefined && BigInt(count) !== BigInt(rows.length))
      fail('The native count proves incomplete membership.', true);
    return rows;
  };
  const snapshot = async () => {
    const customers = await fetch('customer'),
      c = customers[0];
    if (
      customers.length !== 1 ||
      c?.id !== account(p) ||
      typeof c.currencyCode !== 'string' ||
      !/^[A-Z]{3}$/.test(c.currencyCode) ||
      typeof c.timeZone !== 'string' ||
      !c.timeZone ||
      (c.manager !== undefined && c.manager !== false)
    )
      fail(
        'This contract requires a selected client customer. Manager-wide user changes need a separate descendant-account impact contract.',
        true,
      );
    only(c, ['resourceName', 'id', 'currencyCode', 'timeZone', 'manager'], true);
    if (c.resourceName !== undefined && c.resourceName !== 'customers/' + account(p))
      fail('Customer resource mismatch.', true);
    const out: JsonObject = {
      customer: {id: c.id, currencyCode: c.currencyCode, timeZone: c.timeZone, manager: false},
      members: {},
      invitations: {},
    };
    for (const kind of ['members', 'invitations'] as Kind[]) {
      const emails = new Set<string>();
      for (const row of await fetch(kind === 'members' ? 'customer_user_access' : 'customer_user_access_invitation')) {
        only(
          row,
          kind === 'members'
            ? [
                'resourceName',
                'userId',
                'emailAddress',
                'accessRole',
                'pendingMultiPartyAuthReview',
                'accessCreationDateTime',
                'inviterUserEmailAddress',
              ]
            : ['resourceName', 'invitationId', 'emailAddress', 'accessRole', 'invitationStatus', 'creationDateTime'],
          true,
        );
        const resource = name(p, row.resourceName, kind, true),
          identity = kind === 'members' ? row.userId : row.invitationId,
          mail = email(row.emailAddress, true);
        if (
          typeof identity !== 'string' ||
          resource.split('/').at(-1) !== identity ||
          Object.hasOwn(out[kind], resource) ||
          typeof row.accessRole !== 'string' ||
          !Object.hasOwn(ranks, row.accessRole)
        )
          fail('Foreign, repeated or unknown native access identity/role.', true);
        if (kind === 'members' && emails.has(mail)) fail('Member email identity is duplicated.', true);
        emails.add(mail);
        const projected: JsonObject = {resourceName: resource, emailAddress: mail, accessRole: row.accessRole};
        if (kind === 'invitations') {
          if (!['PENDING', 'DECLINED', 'EXPIRED'].includes(row.invitationStatus))
            fail('An invitation has unknown native status.', true);
          projected.invitationStatus = row.invitationStatus;
        } else {
          const review = row.pendingMultiPartyAuthReview;
          if (
            review !== undefined &&
            review !== '' &&
            (typeof review !== 'string' ||
              !new RegExp('^customers/' + account(p) + '/multiPartyAuthReviews/[A-Za-z0-9_-]{1,512}$').test(review))
          )
            fail('Invalid native pending authorization review.', true);
          projected.pendingMultiPartyAuthReview = review || null;
        }
        out[kind][resource] = projected;
      }
    }
    return out;
  };
  const first = await snapshot(),
    second = await snapshot();
  if (stable(first) !== stable(second))
    fail('Membership changed during discovery. Restart from a stable baseline.', true);
  return first;
}
export async function readGoogleAccessState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  return [await currentState(p, send)];
}
export function assertGoogleAccessPrerequisites(p: CompiledRequest, state: unknown[]): void {
  const kind = googleAccessKind(p);
  if (!kind) return;
  const before = state[0] as JsonObject,
    op = operation(p),
    target = op.remove ?? op.update?.resourceName,
    old = target ? before[kind][target] : undefined;
  if (op.create) {
    const mail = email(op.create.emailAddress);
    if (
      (Object.values(before.members) as JsonObject[]).some(r => r.emailAddress === mail) ||
      (Object.values(before.invitations) as JsonObject[]).some(
        r => r.emailAddress === mail && r.invitationStatus === 'PENDING',
      )
    )
      fail('The recipient already has access or a pending invitation. Inspect it instead of resending.');
    if (Object.keys(before.invitations).length >= 1000)
      fail('Creation would exceed the complete invitation read-back bound.');
    return;
  }
  if (!old) fail('The selected user access or invitation is absent. Discover a current ID.');
  if (kind === 'invitations') {
    if (old.invitationStatus !== 'PENDING') fail('Only a pending invitation can be revoked by this contract.');
    return;
  }
  if (old.pendingMultiPartyAuthReview)
    fail('The user already has a pending multi-party authorization review. Reconcile it before another change.');
  if (
    old.accessRole === 'ADMIN' &&
    (op.remove || op.update.accessRole !== 'ADMIN') &&
    (Object.values(before.members) as JsonObject[]).filter(r => r.accessRole === 'ADMIN').length <= 1
  )
    fail('Removing or demoting the last direct administrator needs a separately verified owner-manager recovery path.');
  if (op.update?.accessRole === old.accessRole)
    fail('This principal already has the requested role. Inspect it without resubmitting.');
}
export function googleAccessOutcome(p: CompiledRequest, result: TransportResult, before: unknown[]): boolean {
  try {
    const kind = googleAccessKind(p)!,
      data = result.data;
    if (
      result.status !== 200 ||
      !object(data) ||
      Object.keys(data).length !== 1 ||
      !object(data.result) ||
      Object.keys(data.result).some(k => !['resourceName', 'multiPartyAuthReview'].includes(k))
    )
      return false;
    if (
      data.result.multiPartyAuthReview !== undefined &&
      (typeof data.result.multiPartyAuthReview !== 'string' ||
        !new RegExp('^customers/' + account(p) + '/multiPartyAuthReviews/[1-9][0-9]*$').test(
          data.result.multiPartyAuthReview,
        ))
    )
      return false;
    const resource = name(p, data.result.resourceName, kind),
      op = operation(p);
    return op.create
      ? !Object.hasOwn((before[0] as JsonObject).invitations, resource)
      : resource === (op.remove ?? op.update.resourceName);
  } catch {
    return false;
  }
}
export async function verifyGoogleAccess(p: CompiledRequest, result: JsonObject, state: unknown[], send: Send) {
  const kind = googleAccessKind(p)!,
    op = operation(p),
    resource = name(p, result.data.result.resourceName, kind),
    expected = structuredClone(state[0]) as JsonObject;
  if (op.create)
    expected.invitations[resource] = {
      resourceName: resource,
      emailAddress: email(op.create.emailAddress),
      accessRole: op.create.accessRole,
      invitationStatus: 'PENDING',
    };
  else if (op.remove) delete expected[kind][resource];
  else expected.members[resource].accessRole = op.update.accessRole;
  const actual = await currentState(p, send),
    changed = changedStateFields([expected], [actual]),
    status = changed.length ? 'inconclusive' : 'verified',
    pending = actual.members[resource]?.pendingMultiPartyAuthReview ?? null;
  return {
    status,
    checks: [
      {
        status,
        resource_id: resource,
        changed_fields: changed,
        expected_hash: sha256(stable(expected)),
        actual_hash: sha256(stable(actual)),
        ...(result.data.result.multiPartyAuthReview ? {provider_review: result.data.result.multiPartyAuthReview} : {}),
        ...(op.create
          ? {
              invitation_sent: status === 'verified',
              invitation_status: actual.invitations[resource]?.invitationStatus ?? 'unobserved',
              access_granted: false,
            }
          : {pending_multi_party_auth_review: pending}),
      },
    ],
    resources: [],
  };
}
export function assertGoogleAccessPolicy(p: CompiledRequest, state: unknown, policy: JsonObject): void {
  const kind = googleAccessKind(p);
  if (!kind) return;
  const before = (Array.isArray(state) ? state[0] : state) as JsonObject,
    op = operation(p),
    old = before.members?.[op.update?.resourceName],
    promotes = !!op.create || (!!op.update && old && ranks[op.update.accessRole]! > ranks[old.accessRole]!),
    demotes = !!op.update && old && ranks[op.update.accessRole]! < ranks[old.accessRole]!;
  if (policy.allow_activation === false && promotes)
    throw new MirrorError(
      'POLICY_ACTIVATION_FORBIDDEN',
      'The owner policy forbids new or increased Google Ads user access.',
      {},
      403,
    );
  if (policy.allow_deletion === false && (op.remove || demotes))
    throw new MirrorError(
      'POLICY_DELETION_FORBIDDEN',
      'The owner policy forbids removing or reducing Google Ads user access.',
      {},
      403,
    );
}
export function googleAccessImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const kind = googleAccessKind(p)!,
    op = operation(p),
    before = state[0] as JsonObject,
    old = before[kind][op.remove ?? op.update?.resourceName];
  return {
    provider: 'google_ads',
    effect: op.create
      ? 'Sends an invitation email to the exact recipient for this client account. Pending invitation is not accepted access.'
      : op.remove
        ? 'Removes the selected client-account access or revokes the pending invitation. This may remove the acting provider user’s access.'
        : 'Changes only the selected client-account user’s role. Google may require a separate multi-party authorization decision.',
    previous: old ?? null,
    requested: op.create ?? op.update ?? null,
    policy:
      'Workspace administrator and current account write grant required. Owner activation control covers new/increased access; deletion control covers removal/demotion. No budget values change.',
    provider_authority:
      'Google enforces native administrator identity, domain policy and multi-party authorization. AMCP does not infer provider administrator authority from its local role.',
    recovery:
      'Retain the original claim and receipt after uncertainty. Verify pending invitations separately from acceptance; the accepting Google account can have a different email. Never infer a new member or AMCP grant from an invitation receipt or retry under a new key.',
    limits:
      'Client accounts only. Last-direct-admin removal/demotion requires verified recovery ownership; manager-wide effects and multi-party approval actions remain separate contracts.',
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleAccessFamily: ReviewedFamily = {
  name: 'google_user_access',
  files: ['src/google-user-access.ts', ['tests/google-user-access.test.ts']],
  kind: googleAccessKind,
  assert: plan => assertGoogleAccess(plan),
  actor: (plan, actor) => assertGoogleAccessActor(plan, actor),
  scope: c => assertGoogleAdsScope(c),
  snapshots: googleAccessSnapshots,
  state: (plan, readers) =>
    readGoogleAccessState(plan, readers.guarded('Google access prerequisites must remain read-only.').read),
  stateChecks: (plan, state) => assertGoogleAccessPrerequisites(plan, state),
  impact: googleAccessImpact,
  outcome: googleAccessOutcome,
  verify: (plan, v) =>
    verifyGoogleAccess(
      plan,
      v.result,
      v.state,
      v.guarded('Google access verification must remain read-only.', {
        actor: () => assertGoogleAccessActor(plan, v.actor),
        check: assertGoogleAdsScope,
      }),
    ).then(o => ({status: o.status, checks: o.checks})),
  exemptFromSpendTextMatch: true,
  administratorRequired: true,
};
