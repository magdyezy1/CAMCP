import {MirrorError} from './errors.js';
import {parseLinkedInValue, linkedinQuery} from './linkedin-restli.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {fail, readOf} from './family-kit.js';

/**
 * LinkedIn dynamic UTM tracking parameters, per "Dynamic UTM Tracking" of the Marketing API (li-lms-2026-09, checked
 * 2026-09-27). PUT /rest/adTrackingParameters/(adEntity:(sponsoredCampaign:{URN})) creates them (201) or, with the
 * idempotencyToken of the current parameters as a query parameter, replaces them (200; a stale token returns 409); DELETE
 * removes them (204). Account-level parameters (sponsoredAccount) need LinkedIn-Version 202608 or later, and the
 * CREATIVE_NAME value 202606 or later. LinkedIn appends the parameters to the landing page URLs of every creative under the
 * entity, including running ads, without another ad review; Conversation Ads and Message Ads are not supported.
 */
type Entity = {type: 'sponsoredCampaign' | 'sponsoredAccount'; urn: string; id: string};
type Read = CompiledRequest & {linkedinTrackingState?: {entity: Entity}; linkedinTrackingPage?: true};
const base = '/rest/adTrackingParameters/',
  origin = 'https://api.linkedin.com';
export const linkedinTrackingSource =
  'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/dynamic-utm-tracking';
export const linkedinDynamicValues = [
  'ACCOUNT_ID',
  'ACCOUNT_NAME',
  'CAMPAIGN_GROUP_ID',
  'CAMPAIGN_GROUP_NAME',
  'CAMPAIGN_ID',
  'CAMPAIGN_NAME',
  'CREATIVE_ID',
  'CREATIVE_NAME',
];
const maxParameters = 50,
  parameterName = /^[A-Za-z0-9_.~-]{1,100}$/,
  removedCampaign = ['REMOVED', 'PENDING_DELETION'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const nativeId = (v: unknown, want: string) =>
  (typeof v === 'string' && v === want) ||
  (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && String(v) === want);
function invalid(message: string): never {
  return fail('INVALID_LINKEDIN_TRACKING', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
function mismatch(message: string, details: JsonObject = {}): never {
  return fail('STATE_TARGET_MISMATCH', message, details, 409);
}
const account = (p: CompiledRequest) => {
  if (!/^[1-9][0-9]{0,19}$/.test(p.accountId ?? '')) invalid('Select one sponsored account.');
  return p.accountId!;
};
const version = (p: CompiledRequest) => Number(p.headers['LinkedIn-Version']);
/** Parameter names survive the case folding of verification when they are hex-encoded. */
const encodeName = (name: string) => 'n' + Buffer.from(name, 'utf8').toString('hex');

export function linkedinTrackingKind(p: CompiledRequest): 'put' | 'delete' | undefined {
  if (p.gateway !== 'linkedin_native_action' || p.specialTransport || (p.origin !== undefined && p.origin !== origin))
    return;
  if (!p.path.startsWith(base) || !p.path.slice(base.length) || p.path.slice(base.length).includes('/')) return;
  return p.method === 'PUT' ? 'put' : p.method === 'DELETE' ? 'delete' : undefined;
}
function entityOf(p: CompiledRequest): Entity {
  let value: unknown;
  try {
    value = parseLinkedInValue(decodeURIComponent(p.path.slice(base.length)));
  } catch {
    value = undefined;
  }
  const e = object(value) && Object.keys(value).length === 1 && object(value.adEntity) ? value.adEntity : undefined,
    keys = e ? Object.keys(e) : [];
  if (!e || keys.length !== 1 || !['sponsoredCampaign', 'sponsoredAccount'].includes(keys[0]!))
    return invalid(
      'The key is (adEntity:(sponsoredCampaign:{campaign URN})) or (adEntity:(sponsoredAccount:{ad account URN})).',
    );
  const type = keys[0] as Entity['type'],
    urn = e[type],
    m = typeof urn === 'string' ? new RegExp('^urn:li:' + type + ':([1-9][0-9]{0,19})$').exec(urn) : null;
  if (!m) return invalid('adEntity.' + type + ' must be a ' + type + ' URN.');
  return {type, urn: urn as string, id: m[1]!};
}
const keyPath = (e: Entity) => base + linkedinQuery({key: {adEntity: {[e.type]: e.urn}}}).slice(4);
/** The canonical REST.li 2.0 key: record punctuation as is, the URN encoded. */
export function linkedinTrackingPlan(p: CompiledRequest): CompiledRequest {
  if (
    p.gateway !== 'linkedin_native_action' ||
    !p.path.startsWith(base) ||
    !['GET', 'PUT', 'DELETE'].includes(p.method)
  )
    return p;
  try {
    return {...p, path: keyPath(entityOf(p))};
  } catch {
    return p;
  }
}
function parameters(v: unknown, label: string, dynamic: boolean, p: CompiledRequest): JsonObject {
  if (v === undefined) return {};
  if (!object(v)) invalid(label + ' maps parameter names to values.');
  for (const [name, value] of Object.entries(v)) {
    if (!parameterName.test(name))
      invalid(label + '.' + name + ': a parameter name has 1–100 URL-safe characters (letters, digits, _ . ~ -).');
    if (dynamic) {
      if (!linkedinDynamicValues.includes(value as string))
        invalid(label + '.' + name + ' is one of ' + linkedinDynamicValues.join(', ') + '.');
      if (value === 'CREATIVE_NAME' && version(p) < 202606)
        invalid('CREATIVE_NAME needs LinkedIn-Version 202606 or later.');
    } else if (typeof value !== 'string' || !value || [...value].length > 500 || /[\u0000-\u001f\u007f]/.test(value))
      invalid(label + '.' + name + ' is a text of 1–500 characters without control characters.');
  }
  return v;
}
export function assertLinkedInTracking(p: CompiledRequest): void {
  const kind = linkedinTrackingKind(p);
  if (!kind) return;
  const selected = account(p),
    e = entityOf(p),
    method = p.headers['X-RestLi-Method']?.toUpperCase();
  if (
    Object.keys(p.headers).some(
      k => !['LinkedIn-Version', 'X-Restli-Protocol-Version', 'X-RestLi-Method'].includes(k),
    ) ||
    p.headers['X-Restli-Protocol-Version'] !== '2.0.0' ||
    !/^20\d{4}$/.test(p.headers['LinkedIn-Version'] ?? '')
  )
    invalid('Use the native versioned REST.li 2.0 contract without other headers.');
  if (method !== undefined && method !== (kind === 'put' ? 'UPDATE' : 'DELETE'))
    invalid('The REST.li method must match this ' + p.method + '.');
  if (e.type === 'sponsoredAccount') {
    if (e.id !== selected)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Account-level tracking parameters must name the selected ad account.', {}, 403);
    if (version(p) < 202608)
      invalid(
        'Account-level tracking parameters need LinkedIn-Version 202608 or later; configure AMCP_LINKEDIN_API_VERSION, or set them on each campaign.',
      );
  }
  const query = Object.keys(p.query);
  if (kind === 'delete') {
    if (query.length) invalid('Deleting tracking parameters takes no query parameters.');
    if (p.body !== undefined && p.body !== null && (!object(p.body) || Object.keys(p.body).length))
      invalid('Deleting tracking parameters takes no body.');
    return;
  }
  if (
    query.some(k => k !== 'idempotencyToken') ||
    (p.query.idempotencyToken !== undefined &&
      (typeof p.query.idempotencyToken !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.query.idempotencyToken)))
  )
    invalid('The only query parameter is idempotencyToken, the token of the current parameters.');
  const b = p.body;
  if (!object(b)) invalid('Provide the native tracking parameter object.');
  const extra = Object.keys(b).filter(
    k => !['dynamicValueParameters', 'customValueParameters', 'adEntity'].includes(k),
  );
  if (extra.length) invalid('Unqualified fields: ' + extra.join(', ') + '.');
  if (
    b.adEntity !== undefined &&
    (!object(b.adEntity) || Object.keys(b.adEntity).length !== 1 || b.adEntity[e.type] !== e.urn)
  )
    invalid('adEntity in the body must be the entity of the path.');
  const d = parameters(b.dynamicValueParameters, 'dynamicValueParameters', true, p),
    c = parameters(b.customValueParameters, 'customValueParameters', false, p),
    names = [...Object.keys(d), ...Object.keys(c)];
  if (!names.length) invalid('Send at least one parameter; DELETE removes all of them.');
  if (names.length > maxParameters) invalid('Send at most ' + maxParameters + ' parameters.');
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length)
    invalid('A parameter name appears twice (names compare without case); the landing page URL would carry it twice.');
}
export function assertLinkedInTrackingScope(c: Connection, write = false): void {
  if (!c.scopes.some(s => (write ? s === 'rw_ads' : ['r_ads', 'rw_ads'].includes(s))))
    fail(
      'INSUFFICIENT_SCOPE',
      write ? 'Tracking parameter writes require rw_ads.' : 'Tracking parameter reads require r_ads or rw_ads.',
      {},
      403,
    );
}
function read(p: CompiledRequest, path: string): Read {
  return readOf<Read>(
    p,
    {
      action: 'AMCP_LINKEDIN_TRACKING_READ',
      path,
      query: {},
      headers: {'LinkedIn-Version': p.headers['LinkedIn-Version']!, 'X-Restli-Protocol-Version': '2.0.0'},
      clears: ['responseControls'],
    },
    {linkedinTrackingState: undefined, linkedinTrackingPage: true},
  );
}
/** One marked read of the ad account; the reader adds the campaign and the current parameters. */
export function linkedinTrackingSnapshots(p: CompiledRequest): Read[] {
  return [{...read(p, '/rest/adAccounts/' + account(p)), linkedinTrackingState: {entity: entityOf(p)}}];
}
export function isLinkedInTrackingRead(p: CompiledRequest): p is Read {
  return !!(p as Read).linkedinTrackingState;
}
/** Writes after validation; server-built reads of the account, its campaigns and the parameters of a verified entity. */
export function authorizeLinkedInTracking(p: CompiledRequest, c: Connection, id: string): boolean {
  if (linkedinTrackingKind(p)) {
    assertLinkedInTracking(p);
    assertLinkedInTrackingScope(c, true);
    return true;
  }
  const internal = p as Read;
  if (
    p.gateway !== 'linkedin_native_action' ||
    !internal.linkedinTrackingPage ||
    p.action !== 'AMCP_LINKEDIN_TRACKING_READ' ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    Object.keys(p.query).length
  )
    return false;
  assertLinkedInTrackingScope(c);
  if (
    p.path === '/rest/adAccounts/' + id ||
    new RegExp('^/rest/adAccounts/' + id + '/adCampaigns/[1-9][0-9]*$').test(p.path)
  )
    return true;
  // The reader reads a campaign's parameters only after the campaign read proved it belongs to the account.
  if (p.path.startsWith(base)) {
    const e = entityOf(p);
    if (e.type === 'sponsoredCampaign' || e.id === id) return true;
  }
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal tracking parameter read.', {}, 403);
}
function projection(d: JsonObject | null): JsonObject {
  const map = (v: unknown) =>
    object(v)
      ? Object.fromEntries(
          Object.entries(v)
            .map(([k, x]) => [encodeName(k), x])
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : {};
  const token =
      d && (typeof d.idempotencyToken === 'string' || typeof d.idempotencyToken === 'number')
        ? String(d.idempotencyToken)
        : null,
    dynamic = map(d?.dynamicValueParameters),
    custom = map(d?.customValueParameters);
  // An answer without a token or parameters is the same as none (LinkedIn documents only the 200 form with both).
  return {present: !!token || Object.keys(dynamic).length + Object.keys(custom).length > 0, token, dynamic, custom};
}
export async function readLinkedInTracking(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const m = (p as Read).linkedinTrackingState;
  if (!m) return request(p);
  const fetch = async (path: string) => {
    const r = await request(read(p, path)),
      d = r.data;
    if (r.status !== 200 || !object(d) || d.serviceErrorCode !== undefined || d.errors !== undefined)
      unverified('A required LinkedIn read failed or returned an error envelope.');
    return d as JsonObject;
  };
  const selected = await fetch('/rest/adAccounts/' + account(p));
  if (!nativeId(selected.id, account(p)) || typeof selected.status !== 'string')
    unverified('The selected ad account identity and status are required.');
  let campaign: JsonObject | null = null;
  if (m.entity.type === 'sponsoredCampaign') {
    const row = await fetch('/rest/adAccounts/' + account(p) + '/adCampaigns/' + m.entity.id);
    if (
      !nativeId(row.id, m.entity.id) ||
      row.account !== 'urn:li:sponsoredAccount:' + account(p) ||
      typeof row.status !== 'string'
    )
      mismatch('Campaign ' + m.entity.id + ' is not a campaign of the selected ad account.', {campaign: m.entity.urn});
    campaign = {id: m.entity.id, name: typeof row.name === 'string' ? row.name : null, status: row.status};
  }
  let current: JsonObject | null = null;
  try {
    const r = await request(read(p, keyPath(m.entity))),
      d = r.data;
    if (r.status !== 200 || !object(d) || d.serviceErrorCode !== undefined || d.errors !== undefined)
      unverified('LinkedIn did not return the tracking parameters.');
    if (d.adEntity !== undefined && (!object(d.adEntity) || d.adEntity[m.entity.type] !== m.entity.urn))
      mismatch('LinkedIn returned tracking parameters of another entity.');
    current = d as JsonObject;
  } catch (e) {
    if (!(e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND'))) throw e;
  }
  return {
    status: 200,
    headers: {},
    data: {
      account: {id: account(p), status: selected.status},
      entity: m.entity.urn,
      campaign,
      parameters: projection(current),
    },
  };
}
export function validateLinkedInTrackingState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data;
  if (
    !isLinkedInTrackingRead(p) ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.account) ||
    d.account.id !== account(p) ||
    !object(d.parameters)
  )
    unverified('Complete tracking parameter state is missing.');
}
/** The parameters as the request leaves them, in the projection above. */
function after(p: CompiledRequest): JsonObject {
  const b = p.body as JsonObject;
  return projection({
    dynamicValueParameters: b.dynamicValueParameters ?? {},
    customValueParameters: b.customValueParameters ?? {},
  });
}
export function linkedinTrackingPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = linkedinTrackingKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.parameters)) unverified('Complete tracking parameter state is missing.');
  const cur = s.parameters as JsonObject,
    label = object(s.campaign) ? 'Campaign ' + s.campaign.id : 'Ad account ' + account(p);
  if (object(s.campaign) && removedCampaign.includes(s.campaign.status))
    invalid(label + ' is ' + s.campaign.status + '.');
  if (kind === 'delete') {
    if (!cur.present) fail('STATE_NOT_FOUND', label + ' has no tracking parameters to delete.');
    return;
  }
  const token = p.query.idempotencyToken;
  if (cur.present && token === undefined)
    fail(
      'CONFIGURATION_EXISTS',
      label +
        ' already has tracking parameters. Replace them with idempotencyToken=' +
        String(cur.token) +
        ' from this review, or delete them first.',
      {idempotency_token: cur.token},
    );
  if (cur.present && String(token) !== cur.token)
    invalid(
      'idempotencyToken ' +
        String(token) +
        ' is not the token of the current parameters (' +
        String(cur.token) +
        '); LinkedIn would refuse it with 409.',
    );
  if (!cur.present && token !== undefined)
    invalid(label + ' has no tracking parameters to replace; create them without idempotencyToken.');
  const next = after(p);
  if (cur.present && JSON.stringify([cur.dynamic, cur.custom]) === JSON.stringify([next.dynamic, next.custom]))
    invalid(label + ' already has exactly these tracking parameters.');
}
const decoded = (v: unknown) =>
  object(v)
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [Buffer.from(k.slice(1), 'hex').toString('utf8'), x]))
    : {};
export function linkedinTrackingImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = linkedinTrackingKind(p);
  if (!kind) return;
  const e = entityOf(p),
    first = state[0],
    s: JsonObject = object(first) ? first : {},
    cur = object(s.parameters) ? s.parameters : null,
    next = kind === 'delete' ? null : after(p);
  return {
    provider: 'linkedin',
    scope: 'tracking_parameters',
    operation: kind === 'delete' ? 'delete' : cur?.present ? 'replace' : 'create',
    entity: {
      urn: e.urn,
      level: e.type === 'sponsoredCampaign' ? 'campaign' : 'ad_account',
      ...(object(s.campaign) ? {name: s.campaign.name, status: s.campaign.status} : {}),
    },
    before: cur ? {dynamic: decoded(cur.dynamic), custom: decoded(cur.custom)} : null,
    after: next ? {dynamic: decoded(next.dynamic), custom: decoded(next.custom)} : null,
    may_affect_serving: false,
    effect:
      'LinkedIn ' +
      (kind === 'delete' ? 'stops appending these parameters to' : 'appends these parameters to') +
      ' the landing page URLs of every creative ' +
      (e.type === 'sponsoredCampaign' ? 'in the campaign' : 'in every campaign of the ad account') +
      ', including running ads, without another ad review. Conversation Ads and Message Ads are not supported. Static UTM parameters already in a URL remain, so a name must not repeat one of them.',
    verification:
      kind === 'delete'
        ? 'Reads the tracking parameters again and expects none.'
        : 'Reads the tracking parameters again and compares every dynamic and custom parameter.',
    source: linkedinTrackingSource,
  };
}
export function linkedinTrackingOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = linkedinTrackingKind(p)!,
    d = r.data,
    clean = d === null || d === undefined || (object(d) && d.serviceErrorCode === undefined && d.errors === undefined);
  if (kind === 'delete')
    return (
      (r.status === 204 || r.status === 200) && (d === null || d === undefined || (object(d) && !Object.keys(d).length))
    );
  return (r.status === 201 || r.status === 200) && clean;
}
export function linkedinTrackingVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = linkedinTrackingKind(p)!,
    next = kind === 'delete' ? projection(null) : after(p);
  return [
    {
      read: linkedinTrackingSnapshots(p)[0]!,
      expected: {parameters: {dynamic: next.dynamic, custom: next.custom}},
      id: entityOf(p).urn,
    },
  ];
}
export function linkedinTrackingObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const s = object(data.parameters) ? data.parameters : {};
  return {parameters: {dynamic: s.dynamic ?? {}, custom: s.custom ?? {}}};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinTrackingFamily: ReviewedFamily = {
  name: 'linkedin_tracking_parameters',
  files: ['src/linkedin-tracking-parameters.ts', ['tests/linkedin-tracking-parameters.test.mjs']],
  kind: linkedinTrackingKind,
  assert: assertLinkedInTracking,
  scope: assertLinkedInTrackingScope,
  authorize: authorizeLinkedInTracking,
  snapshots: linkedinTrackingSnapshots,
  isRead: isLinkedInTrackingRead,
  reader: readLinkedInTracking,
  validateState: validateLinkedInTrackingState,
  prerequisites: linkedinTrackingPrerequisites,
  impact: linkedinTrackingImpact,
  outcome: linkedinTrackingOutcome,
  verification: linkedinTrackingVerification,
  observed: linkedinTrackingObserved,
  exemptFromSpendTextMatch: true,
};
