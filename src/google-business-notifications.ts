import {MirrorError} from './errors.js';
import {stable, sha256} from './security.js';
import {changedStateFields} from './review-state.js';
import {assertPlaceActionScope as assertBusinessScope, placeActionSafeError} from './google-place-action-links.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

const gateway = 'google_business_native_action',
  origin = 'https://mybusinessnotifications.googleapis.com',
  accountOrigin = 'https://mybusinessaccountmanagement.googleapis.com';
export const businessNotificationTypes = [
  'GOOGLE_UPDATE',
  'NEW_REVIEW',
  'UPDATED_REVIEW',
  'NEW_CUSTOMER_MEDIA',
  'DUPLICATE_LOCATION',
  'VOICE_OF_MERCHANT_UPDATED',
];
export const retiredBusinessNotificationTypes = [
  'NEW_QUESTION',
  'UPDATED_QUESTION',
  'NEW_ANSWER',
  'UPDATED_ANSWER',
  'LOSS_OF_VOICE_OF_MERCHANT',
];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
type Send = (p: CompiledRequest) => Promise<TransportResult>;
function fail(message: string, state = false): never {
  throw new MirrorError(
    state ? 'BUSINESS_NOTIFICATION_STATE_UNVERIFIED' : 'INVALID_BUSINESS_NOTIFICATION',
    message,
    {},
    state ? 502 : 400,
  );
}
const only = (v: JsonObject, keys: string[], state = false) => {
  if (Object.keys(v).some(k => !keys.includes(k)))
    fail('Unqualified notification field, response envelope or query option.', state);
};
function account(p: CompiledRequest) {
  const id = p.accountId;
  if (!id || !/^\d+$/.test(id) || p.path !== '/v1/accounts/' + id + '/notificationSetting')
    fail('Use the exact numeric Business Profile account grant, not a location grant.');
  return 'accounts/' + id;
}
export function businessNotificationKind(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    p.action === 'gmb_notification_ops/UPDATE_NOTIFICATION_SETTING' &&
    p.origin === origin &&
    p.method === 'PATCH' &&
    !p.specialTransport &&
    /^\/v1\/accounts\/\d+\/notificationSetting$/.test(p.path)
  );
}
export function businessNotificationDisables(p: CompiledRequest): boolean {
  return (
    businessNotificationKind(p) &&
    object(p.body) &&
    (p.body.pubsubTopic === '' || (Array.isArray(p.body.notificationTypes) && p.body.notificationTypes.length === 0))
  );
}
export function assertBusinessNotificationActor(p: CompiledRequest, actor: Actor) {
  if (businessNotificationKind(p) && (actor.role !== 'admin' || actor.testAccount === true))
    throw new MirrorError(
      'ADMIN_REQUIRED',
      'Only a workspace administrator can change account-wide Business Profile notification destinations. Reviewer test accounts cannot perform this administrative change.',
      {},
      403,
    );
}
export function assertBusinessNotificationScope(c: Connection) {
  assertBusinessScope(c);
}
function topic(v: unknown, state = false): string {
  if (v === '') return '';
  if (
    typeof v !== 'string' ||
    !/^projects\/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[1-9][0-9]{0,19})\/topics\/[A-Za-z][A-Za-z0-9._~+%\-]{2,254}$/.test(
      v,
    ) ||
    v.split('/')[3]!.toLowerCase().startsWith('goog')
  )
    fail(
      'Use an exact existing projects/{project}/topics/{topic} name; URLs, wildcard topics and credentials are not destinations.',
      state,
    );
  return v as string;
}
function types(v: unknown, state = false): string[] {
  const allowed = state
    ? [...businessNotificationTypes, ...retiredBusinessNotificationTypes]
    : businessNotificationTypes;
  if (
    !Array.isArray(v) ||
    v.length > allowed.length ||
    new Set(v).size !== v.length ||
    v.some(k => !allowed.includes(k))
  )
    fail(
      'Use distinct current notification types. Q&A events are retired; migrate LOSS_OF_VOICE_OF_MERCHANT to VOICE_OF_MERCHANT_UPDATED.',
      state,
    );
  return [...v].sort();
}
export function assertBusinessNotification(p: CompiledRequest) {
  if (!businessNotificationKind(p)) return;
  const name = account(p) + '/notificationSetting';
  if (!object(p.body)) fail('Provide the native notification setting and exact update mask.');
  const b = p.body as JsonObject;
  only(b, ['name', 'pubsubTopic', 'notificationTypes']);
  only(p.query, ['updateMask']);
  if (Object.keys(p.headers).length || b.name !== name)
    fail('The required native setting name must match the selected account; headers cannot be overridden.');
  const mask = typeof p.query.updateMask === 'string' ? p.query.updateMask.split(',') : [];
  if (
    !mask.length ||
    new Set(mask).size !== mask.length ||
    mask.some(k => !['pubsubTopic', 'notificationTypes'].includes(k) || b[k] === undefined) ||
    Object.keys(b).some(k => k !== 'name' && !mask.includes(k))
  )
    fail('updateMask must cover exactly the supplied pubsubTopic and/or notificationTypes fields.');
  if (Object.hasOwn(b, 'pubsubTopic')) topic(b.pubsubTopic);
  if (Object.hasOwn(b, 'notificationTypes')) types(b.notificationTypes);
  if (
    businessNotificationDisables(p) &&
    (b.pubsubTopic !== '' || !Array.isArray(b.notificationTypes) || b.notificationTypes.length !== 0)
  )
    fail(
      'To disable, explicitly clear both pubsubTopic and notificationTypes in one review. This avoids ambiguous retained settings.',
    );
}
function read(p: CompiledRequest, path: string, host: string): CompiledRequest {
  return {
    ...p,
    action: 'AMCP_BUSINESS_NOTIFICATION_READ',
    origin: host,
    method: 'GET',
    path,
    query: {},
    body: undefined,
    headers: {},
    readOnly: true,
    requiresConfirmation: false,
    destructive: false,
    responseControls: undefined,
  };
}
export function businessNotificationSnapshots(p: CompiledRequest) {
  return [read(p, '/v1/' + account(p), accountOrigin), read(p, p.path, origin)];
}
function setting(p: CompiledRequest, value: unknown): JsonObject {
  if (!object(value)) fail('The notification setting is missing or not a native resource.', true);
  const v = value as JsonObject;
  only(v, ['name', 'pubsubTopic', 'notificationTypes'], true);
  if (v.name !== account(p) + '/notificationSetting')
    fail('The notification setting does not identify the selected account.', true);
  return {
    name: v.name,
    pubsubTopic: topic(v.pubsubTopic ?? '', true),
    notificationTypes: types(v.notificationTypes ?? [], true),
  };
}
function identity(p: CompiledRequest, value: unknown): JsonObject {
  if (!object(value)) fail('The Business Profile account identity is missing.', true);
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
    v.name !== account(p) ||
    typeof v.accountName !== 'string' ||
    !v.accountName.trim() ||
    v.accountName.length > 1024 ||
    !['PERSONAL', 'LOCATION_GROUP', 'USER_GROUP', 'ORGANIZATION'].includes(v.type)
  )
    fail('The account name, identity or type is incomplete.', true);
  if (
    (v.role !== undefined &&
      !['ACCOUNT_ROLE_UNSPECIFIED', 'PRIMARY_OWNER', 'OWNER', 'MANAGER', 'SITE_MANAGER'].includes(v.role)) ||
    (v.permissionLevel !== undefined &&
      !['PERMISSION_LEVEL_UNSPECIFIED', 'OWNER_LEVEL', 'MEMBER_LEVEL'].includes(v.permissionLevel))
  )
    fail('The native account permission information is unknown.', true);
  // Organization addresses/contact details and verification telemetry are not
  // notification configuration. Keep only the account and authority identity.
  return {
    name: v.name,
    accountName: v.accountName,
    type: v.type,
    role: v.role ?? null,
    permissionLevel: v.permissionLevel ?? null,
  };
}
async function currentState(p: CompiledRequest, send: Send): Promise<JsonObject> {
  const plans = businessNotificationSnapshots(p),
    started = performance.now();
  let bytes = 0;
  const get = async (plan: CompiledRequest) => {
    if (performance.now() - started > 30000) fail('Notification discovery exceeded its 30-second deadline.', true);
    let result: TransportResult;
    try {
      result = await send(plan);
    } catch (e) {
      throw placeActionSafeError(e);
    }
    if (result.status !== 200 || !object(result.data))
      fail('A failed notification/account read cannot prove an empty setting.', true);
    const size = Buffer.byteLength(JSON.stringify(result.data));
    bytes += size;
    if (size > 1024 * 1024 || bytes > 4 * 1024 * 1024 || performance.now() - started > 30000)
      fail('Notification discovery exceeded its byte/deadline bound.', true);
    return result.data;
  };
  const snapshot = async () => ({
    account: identity(p, await get(plans[0]!)),
    setting: setting(p, await get(plans[1]!)),
  });
  const before = await snapshot();
  if (stable(before) !== stable(await snapshot()))
    fail('The account authority or notification setting changed during discovery.', true);
  return before;
}
function desired(p: CompiledRequest, before: JsonObject): JsonObject {
  const result = setting(p, {...before.setting, ...(p.body as JsonObject)});
  if (!businessNotificationDisables(p) && (!result.pubsubTopic || !result.notificationTypes.length))
    fail(
      'Enabling requires both an existing topic and a nonempty event selection; supply missing configuration explicitly.',
    );
  if (
    !businessNotificationDisables(p) &&
    result.notificationTypes.some((v: string) => retiredBusinessNotificationTypes.includes(v))
  )
    fail('Remove retired event types explicitly before enabling or redirecting notifications.');
  return result;
}
export async function readBusinessNotificationState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  const before = await currentState(p, send);
  desired(p, before);
  return [before];
}
export function businessNotificationOutcome(p: CompiledRequest, result: TransportResult, before: unknown[]): boolean {
  if (result.status !== 200) return false;
  try {
    return stable(setting(p, result.data)) === stable(desired(p, before[0] as JsonObject));
  } catch {
    return false;
  }
}
export async function verifyBusinessNotification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
  send: Send,
) {
  const original = before[0] as JsonObject,
    expected = {account: original.account, setting: desired(p, original)},
    actual = await currentState(p, send),
    changed = changedStateFields([expected], [actual]),
    status = changed.length ? 'inconclusive' : 'verified';
  return {
    status,
    checks: [
      {
        resource_id: expected.setting.name,
        status,
        changed_fields: changed,
        expected_hash: sha256(stable(expected)),
        actual_hash: sha256(stable(actual)),
        verification_scope:
          'Saved notification destination and event set plus the selected account identity/authority; delivery and IAM are not verified',
      },
    ],
    resources: [],
  };
}
export function businessNotificationImpact(p: CompiledRequest, before: unknown[]): JsonObject {
  const original = before[0] as JsonObject,
    next = desired(p, original);
  return {
    provider: 'google_business',
    effect: businessNotificationDisables(p)
      ? 'Disables notifications for every location managed by this Business Profile account.'
      : 'Sends the selected account-wide Business Profile event notifications to the exact Pub/Sub topic, replacing any previous destination. All managed locations, including future locations, are affected.',
    previous_topic: original.setting.pubsubTopic,
    destination_topic: next.pubsubTopic,
    notification_types: next.notificationTypes,
    prerequisite:
      'An administrator must approve this data destination and provision the topic/subscriber separately. mybusiness-api-pubsub@system.gserviceaccount.com needs pubsub.topics.publish. AMCP does not create topics, alter IAM, publish test messages or verify subscriber access.',
    billing:
      'Pub/Sub usage can incur separate Cloud charges. This operation does not edit advertising budgets; owner activation/deletion controls still apply.',
    verification:
      'Saved configuration only. No claim of IAM permission, delivery, retention, subscriber identity or data residency.',
    recovery:
      'Preserve the review/key after a lost or rejected receipt. Read the exact setting before preparing a correction; do not repeat the PATCH or infer that a failed read means notifications are disabled.',
  };
}
