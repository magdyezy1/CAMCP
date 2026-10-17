import {assertBusinessNotificationActor} from './google-business-notification-kind.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {isIP} from 'node:net';
import {MirrorError} from './errors.js';
import {stable, sha256} from './security.js';
import {changedStateFields} from './review-state-core.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

const gateway = 'google_business_native_action';
const origin = 'https://mybusinessplaceactions.googleapis.com';
const informationOrigin = 'https://mybusinessbusinessinformation.googleapis.com';
const scope = 'https://www.googleapis.com/auth/business.manage';
const locationMask = 'name,title,storeCode,categories,websiteUri,openInfo';
const mutable = ['uri', 'placeActionType', 'isPreferred'];
export const placeActionTypes = [
  'APPOINTMENT',
  'ONLINE_APPOINTMENT',
  'DINING_RESERVATION',
  'FOOD_ORDERING',
  'FOOD_DELIVERY',
  'FOOD_TAKEOUT',
  'SHOP_ONLINE',
  'SOLOPRENEUR_APPOINTMENT',
];
type Kind = 'create' | 'patch' | 'delete';
type Send = (p: CompiledRequest) => Promise<TransportResult>;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 255): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function fail(message: string, code = 'INVALID_PLACE_ACTION'): never {
  throw new MirrorError(code, message, {}, code === 'PLACE_ACTION_STATE_UNVERIFIED' ? 502 : 400);
}
const stateFail = (message: string): never => fail(message, 'PLACE_ACTION_STATE_UNVERIFIED');
function only(v: JsonObject, keys: string[], state = false) {
  if (Object.keys(v).some(k => !keys.includes(k)))
    (state ? stateFail : fail)('Unqualified place-action fields or response metadata.');
}
function location(p: CompiledRequest): string {
  const id = p.accountId,
    found = p.path.match(/^\/v1\/(locations\/[1-9][0-9]*)\//)?.[1];
  if (!id || !/^locations\/[1-9][0-9]*$/.test(id) || (found && found !== id))
    fail('Select an explicit locations/{id} grant using location_id; omit the broader account_id.');
  return id;
}
function linkName(p: CompiledRequest, v: unknown): string {
  if (typeof v !== 'string' || !new RegExp('^' + location(p) + '/placeActionLinks/[A-Za-z0-9_-]{1,256}$').test(v))
    stateFail('The link identity is missing or outside the selected location.');
  return v as string;
}
/** These URLs are published to Google, never fetched by AMCP. Do not forward a
 * private/signed source URL or access credential as a customer-facing link. */
export function placeActionUri(v: unknown): string {
  let u: URL;
  try {
    if (typeof v !== 'string' || v.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(v)) throw Error();
    u = new URL(v);
  } catch {
    return fail('Use a complete public HTTP(S) customer destination without credentials.');
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.port ||
    isIP(host) ||
    host.includes(':') ||
    !host.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|lan|test|invalid)$/.test(host) ||
    u.hash
  )
    fail('Use a public website destination, without credentials, fragments, IP literals or nonstandard ports.');
  for (const k of u.searchParams.keys())
    if (
      /(?:token|secret|password|signature|credential|authorization|api[_-]?key|^sig$|^key$|^code$|^x-amz-|^x-goog-)/i.test(
        k,
      )
    )
      fail('Private, signed and credential-bearing URLs cannot be published as place-action links.');
  return u.href;
}
/** Reject private destinations before dispatch, and also remove rejected input
 * and provider echoes from inspect results, failed receipts and audit records. */
export function placeActionSafe(value: unknown): any {
  if (Array.isArray(value)) return value.map(placeActionSafe);
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (['uri', 'websiteUri'].includes(k)) {
          try {
            placeActionUri(v);
          } catch {
            return [k, '[PRIVATE_OR_INVALID_URL_REDACTED]'];
          }
        }
        return [k, placeActionSafe(v)];
      }),
    );
  if (typeof value === 'string')
    return value.replace(/https?:\/\/[^\s"'<>]+/g, u => {
      try {
        placeActionUri(u);
        return u;
      } catch {
        return '[PRIVATE_OR_INVALID_URL_REDACTED]';
      }
    });
  return value;
}
export function redactPlaceActionInput(tool: string, input: JsonObject): JsonObject {
  return (tool === gateway && input.operation === 'gmb_engagement_ops') ||
    (tool === 'amcp_write' && input.gateway === gateway && input.arguments?.operation === 'gmb_engagement_ops')
    ? placeActionSafe(input)
    : input;
}
export function placeActionSafeError(error: unknown): unknown {
  return error instanceof MirrorError
    ? new MirrorError(
        error.code,
        placeActionSafe(error.message),
        placeActionSafe(error.details),
        error.status,
        error.retryable,
      )
    : error;
}
export function placeActionKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.origin !== origin || p.specialTransport) return;
  for (const [kind, method, action] of [
    ['create', 'POST', 'CREATE'],
    ['patch', 'PATCH', 'PATCH'],
    ['delete', 'DELETE', 'DELETE'],
  ] as const) {
    if (p.method !== method || p.action !== 'gmb_engagement_ops/' + action + '_PLACE_ACTION_LINK') continue;
    if (
      new RegExp(
        '^/v1/locations/[1-9][0-9]*/placeActionLinks' + (kind === 'create' ? '' : '/[A-Za-z0-9_-]{1,256}') + '$',
      ).test(p.path)
    )
      return kind;
  }
}
export function assertPlaceActionScope(c: Connection) {
  if (!c.scopes.includes(scope))
    throw new MirrorError(
      'INSUFFICIENT_SCOPE',
      'Reconnect this Business Profile identity with business.manage; Ads or Analytics authorization is separate.',
      {},
      403,
    );
}
export function assertPlaceAction(p: CompiledRequest) {
  const kind = placeActionKind(p);
  if (!kind) return;
  location(p);
  if (Object.keys(p.headers).length || Object.keys(p.query).some(k => kind !== 'patch' || k !== 'updateMask'))
    fail('Only the exact PATCH updateMask query is supported; do not override headers or response fields.');
  if (kind === 'delete') {
    if (p.body !== undefined && (!object(p.body) || Object.keys(p.body).length)) fail('DELETE has no request body.');
    return;
  }
  if (!object(p.body)) fail('Provide a native PlaceActionLink payload.');
  const b = p.body as JsonObject;
  only(b, [...mutable, ...(kind === 'patch' ? ['name'] : [])]);
  if (kind === 'create' && (!Object.hasOwn(b, 'uri') || !Object.hasOwn(b, 'placeActionType')))
    fail('Creation requires an explicit destination URI and action type.');
  if (b.uri !== undefined) placeActionUri(b.uri);
  if (b.placeActionType !== undefined && !placeActionTypes.includes(b.placeActionType))
    fail('Choose a documented action type and verify its availability for this location.');
  if (Object.hasOwn(b, 'isPreferred') && typeof b.isPreferred !== 'boolean')
    fail('isPreferred must be an explicit boolean.');
  if (kind === 'patch') {
    const name = p.path.slice(4);
    if (b.name !== undefined && b.name !== name) fail('The payload name must match the exact selected link.');
    const mask = typeof p.query.updateMask === 'string' ? p.query.updateMask.split(',') : [];
    if (
      !mask.length ||
      new Set(mask).size !== mask.length ||
      mask.some(k => !mutable.includes(k) || !Object.hasOwn(b, k) || b[k] === null) ||
      Object.keys(b).some(k => k !== 'name' && !mask.includes(k))
    )
      fail('The updateMask must cover exactly the supplied mutable fields; use false explicitly to clear preference.');
  }
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}, host = origin): CompiledRequest {
  return {
    ...p,
    action: 'AMCP_PLACE_ACTION_READ',
    origin: host,
    method: 'GET',
    path,
    query,
    body: undefined,
    headers: {},
    readOnly: true,
    requiresConfirmation: false,
    destructive: false,
    responseControls: undefined,
  };
}
export function placeActionSnapshots(p: CompiledRequest): CompiledRequest[] {
  const id = location(p);
  return [
    read(p, '/v1/' + id, {readMask: locationMask}, informationOrigin),
    read(p, '/v1/placeActionTypeMetadata', {filter: 'location=' + id, pageSize: 100}),
    read(p, '/v1/' + id + '/placeActionLinks', {pageSize: 100}),
  ];
}
/** The global metadata endpoint is confined by an exact native location filter.
 * Internal markers cannot substitute for its origin, path, method or grant. */
export function authorizePlaceActionRead(p: CompiledRequest, c: Connection, id: string): boolean {
  if (p.gateway !== gateway || p.action !== 'AMCP_PLACE_ACTION_READ') return false;
  assertPlaceActionScope(c);
  if (p.method !== 'GET' || !p.readOnly || p.body !== undefined || Object.keys(p.headers).length || id !== location(p))
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Invalid location-bound place-action prerequisite.', {}, 403);
  const q = p.query,
    keys = Object.keys(q),
    page =
      keys.every(k => ['pageSize', 'pageToken'].includes(k)) &&
      q.pageSize === 100 &&
      (q.pageToken === undefined || text(q.pageToken, 4096));
  const ok =
    (p.origin === informationOrigin && p.path === '/v1/' + id && keys.length === 1 && q.readMask === locationMask) ||
    (p.origin === origin &&
      ((p.path === '/v1/' + id + '/placeActionLinks' && page) ||
        (p.path === '/v1/placeActionTypeMetadata' &&
          q.filter === 'location=' + id &&
          keys.every(k => ['filter', 'pageSize', 'pageToken'].includes(k)) &&
          q.pageSize === 100 &&
          (q.pageToken === undefined || text(q.pageToken, 4096)))));
  if (!ok)
    throw new MirrorError(
      'ACCOUNT_SCOPE_MISMATCH',
      'Place-action reads must target the exact selected location and complete native collections.',
      {},
      403,
    );
  return true;
}
function link(p: CompiledRequest, value: unknown): JsonObject {
  if (!object(value)) stateFail('A link row is not a native resource.');
  const v = value as JsonObject;
  only(v, ['name', 'providerType', 'isEditable', ...mutable, 'createTime', 'updateTime'], true);
  const name = linkName(p, v.name);
  if (
    !['MERCHANT', 'AGGREGATOR_3P'].includes(v.providerType) ||
    !placeActionTypes.includes(v.placeActionType) ||
    (v.isEditable !== undefined && typeof v.isEditable !== 'boolean') ||
    (v.isPreferred !== undefined && typeof v.isPreferred !== 'boolean')
  )
    stateFail('Link provider, type or editability is unknown.');
  return {
    name,
    providerType: v.providerType,
    isEditable: v.isEditable ?? false,
    uri: placeActionUri(v.uri),
    placeActionType: v.placeActionType,
    isPreferred: v.isPreferred ?? false,
  };
}
function listing(p: CompiledRequest, v: JsonObject): JsonObject {
  only(v, ['name', 'title', 'storeCode', 'categories', 'websiteUri', 'openInfo'], true);
  if (v.name !== location(p) || !text(v.title, 1024) || (v.storeCode !== undefined && !text(v.storeCode, 1024)))
    stateFail('The selected business location is missing or its identity is incomplete.');
  const out: JsonObject = {
    name: v.name,
    title: v.title,
    storeCode: v.storeCode ?? '',
    websiteUri: v.websiteUri === undefined ? '' : placeActionUri(v.websiteUri),
  };
  if (v.categories !== undefined) {
    if (!object(v.categories)) stateFail('Business categories are incomplete.');
    only(v.categories, ['primaryCategory', 'additionalCategories'], true);
    const c = v.categories,
      primary = c.primaryCategory?.name,
      additional = c.additionalCategories ?? [];
    if (
      typeof primary !== 'string' ||
      !/^gcid:[a-z0-9_]+$/.test(primary) ||
      !Array.isArray(additional) ||
      additional.length > 100 ||
      additional.some((a: any) => !object(a) || typeof a.name !== 'string' || !/^gcid:[a-z0-9_]+$/.test(a.name))
    )
      stateFail('Business category identifiers are incomplete.');
    const names = additional.map((a: any) => a.name);
    if (new Set([primary, ...names]).size !== names.length + 1)
      stateFail('Business categories have duplicate identities.');
    out.categories = {primaryCategory: primary, additionalCategories: names.sort()};
  } else out.categories = null;
  if (v.openInfo !== undefined) {
    if (!object(v.openInfo) || !['OPEN', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY'].includes(v.openInfo.status))
      stateFail('The business open status is unknown.');
    out.openStatus = v.openInfo.status;
  } else out.openStatus = null;
  return out;
}
async function currentState(p: CompiledRequest, send: Send): Promise<JsonObject> {
  let bytes = 0,
    rows = 0,
    requests = 0;
  const started = performance.now(),
    plans = placeActionSnapshots(p);
  const get = async (plan: CompiledRequest) => {
    if (++requests > 80 || performance.now() - started > 60000)
      stateFail('Complete place-action discovery exceeded its request/deadline bound.');
    let result: TransportResult;
    try {
      result = await send(plan);
    } catch (e) {
      throw placeActionSafeError(e);
    }
    if (result.status !== 200 || !object(result.data))
      stateFail('Place-action discovery failed or returned an unrecognized body.');
    const size = Buffer.byteLength(JSON.stringify(result.data));
    bytes += size;
    if (size > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
      stateFail('Complete place-action discovery exceeded its byte/deadline bound.');
    return result.data as JsonObject;
  };
  const collect = async (plan: CompiledRequest, key: string) => {
    const out: unknown[] = [],
      tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 25) stateFail('Complete place-action discovery exceeded 25 pages.');
      const d = await get({...plan, query: {...plan.query, ...(token ? {pageToken: token} : {})}});
      only(d, [key, 'nextPageToken'], true);
      if (
        (d[key] !== undefined && !Array.isArray(d[key])) ||
        (d.nextPageToken !== undefined && typeof d.nextPageToken !== 'string')
      )
        stateFail('Invalid native place-action collection or pagination.');
      const values = d[key] ?? [];
      rows += values.length;
      if (out.length + values.length > 1000 || rows > 4100)
        stateFail('Complete place-action collections exceed the review capacity.');
      out.push(...values);
      if (!d.nextPageToken) break;
      if (!text(d.nextPageToken, 4096) || tokens.has(d.nextPageToken) || !values.length)
        stateFail('Repeated or incomplete place-action pagination.');
      tokens.add(d.nextPageToken);
      token = d.nextPageToken;
    }
    return out;
  };
  const snapshot = async () => {
    const business = listing(p, await get(plans[0]!)),
      types: string[] = [],
      links: JsonObject = {},
      pairs = new Set<string>(),
      preferred = new Set<string>();
    for (const v of await collect(plans[1]!, 'placeActionTypeMetadata')) {
      if (!object(v)) stateFail('Action-type metadata is incomplete.');
      const row = v as JsonObject;
      only(row, ['placeActionType', 'displayName'], true);
      if (
        !placeActionTypes.includes(row.placeActionType) ||
        types.includes(row.placeActionType) ||
        (row.displayName !== undefined && !text(row.displayName, 1024))
      )
        stateFail('Action-type metadata contains unknown or duplicate types.');
      types.push(row.placeActionType);
    }
    for (const v of await collect(plans[2]!, 'placeActionLinks')) {
      const row = link(p, v),
        pair = row.uri + '|' + row.placeActionType;
      if (Object.hasOwn(links, row.name) || pairs.has(pair) || (row.isPreferred && preferred.has(row.placeActionType)))
        stateFail('The link collection has duplicate identities, destinations or preferences.');
      links[row.name] = row;
      pairs.add(pair);
      if (row.isPreferred) preferred.add(row.placeActionType);
    }
    return {business, availableTypes: types.sort(), links};
  };
  const state = await snapshot();
  if (stable(state) !== stable(await snapshot()))
    stateFail('Business identity, eligible types or links changed during discovery.');
  return state;
}
function desired(p: CompiledRequest, before: JsonObject, receipt?: JsonObject): JsonObject {
  const kind = placeActionKind(p)!,
    links = structuredClone(before.links) as JsonObject,
    name = kind === 'create' ? (receipt?.name ?? 'new') : p.path.slice(4),
    old = links[name];
  if (kind !== 'create' && (!old || old.isEditable !== true))
    fail('The exact existing link must be editable by the selected identity.');
  if (kind === 'delete') {
    delete links[name];
    return links;
  }
  if (kind === 'create' && Object.hasOwn(links, name)) stateFail('Creation returned an existing link identity.');
  const b = p.body as JsonObject,
    value = {
      ...(kind === 'create' ? {name, providerType: 'MERCHANT', isEditable: true, isPreferred: false} : old),
      ...b,
      name,
    };
  value.uri = placeActionUri(value.uri);
  if (!before.availableTypes.includes(value.placeActionType))
    fail('This action type is not currently available for the selected location.');
  if (
    Object.values(links).some(
      (v: any) => v.name !== name && v.uri === value.uri && v.placeActionType === value.placeActionType,
    )
  )
    fail('A link with this destination and action type already exists at the location.');
  if (value.isPreferred)
    for (const v of Object.values(links) as JsonObject[])
      if (v.name !== name && v.placeActionType === value.placeActionType) v.isPreferred = false;
  links[name] = value;
  if (Object.keys(links).length > 1000) fail('Creation would exceed complete link read-back capacity.');
  return links;
}
export async function readPlaceActionState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  const state = await currentState(p, send);
  desired(p, state);
  return [state];
}
export function placeActionOutcome(p: CompiledRequest, result: TransportResult, before: unknown[]): boolean {
  if (result.status !== 200 || !object(result.data)) return false;
  if (placeActionKind(p) === 'delete') return Object.keys(result.data).length === 0;
  try {
    const row = link(p, result.data),
      expected = desired(p, before[0] as JsonObject, row)[row.name];
    return !!expected && stable(expected) === stable(row);
  } catch {
    return false;
  }
}
export async function verifyPlaceAction(p: CompiledRequest, result: JsonObject, before: unknown[], send: Send) {
  const original = before[0] as JsonObject,
    expected = desired(p, original, result.data),
    actual = await currentState(p, send);
  const comparison = {business: original.business, availableTypes: original.availableTypes, links: expected},
    changed = changedStateFields([comparison], [actual]),
    status = changed.length ? 'inconclusive' : 'verified';
  const id = placeActionKind(p) === 'create' ? result.data.name : p.path.slice(4);
  return {
    status,
    checks: [
      {
        resource_id: id,
        status,
        verification_scope:
          'Complete location identity, eligible types and all link configurations including displaced preferences',
        changed_fields: changed,
        expected_hash: sha256(stable(comparison)),
        actual_hash: sha256(stable(actual)),
      },
    ],
    resources:
      status === 'verified' && placeActionKind(p) !== 'delete'
        ? [{resource_id: id, location_id: location(p), kind: 'place_action_link'}]
        : [],
  };
}
export function placeActionImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const before = state[0] as JsonObject,
    after = desired(p, before),
    displaced = Object.values(before.links)
      .filter((v: any) => v.isPreferred && after[v.name]?.isPreferred === false)
      .map((v: any) => v.name);
  return {
    provider: 'google_business',
    effect:
      placeActionKind(p) === 'delete'
        ? 'Removes a customer-facing link from the selected business listing.'
        : 'Publishes or changes a customer-facing business listing link immediately; it has no paused state.',
    may_publish: placeActionKind(p) !== 'delete',
    displaced_preferred_links: displaced,
    policy:
      'Owner allow_activation=false prevents creation and editing of public links. allow_deletion=false prevents removal. These operations do not change advertising budgets.',
    verification:
      'Complete location-bound link read-back checks uniqueness, eligibility and displaced preferences. It does not prove Search/Maps display, destination availability, provider approval or conversions.',
    recovery:
      'Keep the original review and key after a lost or ambiguous response. Never repeat the mutation; inspect the location and prepare any correction separately.',
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const placeActionFamily: ReviewedFamily = {
  name: 'google_place_actions',
  files: ['src/google-place-action-links.ts', ['tests/google-place-action-links.test.ts']],
  kind: placeActionKind,
  assert: plan => assertPlaceAction(plan),
  scope: c => assertPlaceActionScope(c),
  authorize: (plan, connection, account) => authorizePlaceActionRead(plan, connection, account),
  snapshots: placeActionSnapshots,
  state: (plan, readers) =>
    readPlaceActionState(plan, readers.guarded('Place-action prerequisites must remain read-only.').read),
  impact: placeActionImpact,
  outcome: placeActionOutcome,
  safeOutcome: placeActionSafe,
  safeError: e => placeActionSafeError(e),
  verify: (plan, v) =>
    verifyPlaceAction(
      plan,
      v.result,
      v.state,
      v.guarded('Place-action verification must remain read-only.', {
        actor: () => assertBusinessNotificationActor(plan, v.actor),
        check: assertPlaceActionScope,
      }),
    ),
  exemptFromSpendTextMatch: true,
  activates: plan => placeActionKind(plan) !== 'delete',
};
