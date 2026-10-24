import {assertDV360WriteScope} from './dv360-scope.js';
import {assertNoMethodOverride} from './write-common.js';
import type {GatewayStateChecks, ReviewedFamily} from './reviewed-family.js';
import {fail, stateReadOf} from './family-kit.js';
import {validateDiscoveryBody} from './discovery-body.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {pinnedJson} from './pinned-json.js';

export const dv360ListContracts = {
  channels: {
    model: 'Channel',
    id: 'channelId',
    maxNameBytes: 240,
    child: 'sites',
    item: 'Site',
    key: 'urlOrAppId',
    pageSize: 1000,
    remove: false,
    replace: true,
  },
  negativeKeywordLists: {
    model: 'NegativeKeywordList',
    id: 'negativeKeywordListId',
    maxNameBytes: 255,
    child: 'negativeKeywords',
    item: 'NegativeKeyword',
    key: 'keywordValue',
    pageSize: 1000,
    remove: true,
    replace: true,
  },
  locationLists: {
    model: 'LocationList',
    id: 'locationListId',
    maxNameBytes: 240,
    child: 'assignedLocations',
    item: 'AssignedLocation',
    key: 'assignedLocationId',
    pageSize: 200,
    remove: false,
    replace: false,
  },
} as const;
type Kind = keyof typeof dv360ListContracts;
type Contract = {
  kind: Kind;
  child: boolean;
  verb: 'create' | 'update' | 'delete' | 'bulkEdit' | 'replace';
  parent: string;
  collection: string;
  target?: string;
};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
const keyword = (value: string) => value.replace(/%20/gi, ' ').trim();
const sameName = (actual: unknown, expected: string) =>
  typeof actual === 'string' && decoded(actual) !== undefined && decoded(actual) === decoded(expected);
const models = (): Record<string, JsonObject> => pinnedJson('.mirror/VENDOR/dv360-v4.json').document.schemas;
export function dv360ListKind(p: CompiledRequest): Contract | undefined {
  if (
    p.gateway !== 'dv360_native_action' ||
    (p.origin !== undefined && p.origin !== 'https://displayvideo.googleapis.com')
  )
    return;
  const m =
    /^\/v4\/advertisers\/([1-9]\d*)\/(channels|negativeKeywordLists|locationLists)(?:\/([1-9]\d*)(?:\/(sites|negativeKeywords|assignedLocations)(?::(bulkEdit|replace)|\/([^/]+))?)?)?$/.exec(
      p.path,
    );
  if (!m) return;
  const kind = m[2] as Kind,
    c = dv360ListContracts[kind],
    child = !!m[4],
    root = '/v4/advertisers/' + m[1] + '/' + kind;
  if (child && m[4] !== c.child) return;
  const verb = child
    ? (m[5] ?? (p.method === 'POST' && !m[6] ? 'create' : p.method === 'DELETE' && m[6] ? 'delete' : undefined))
    : p.method === 'POST' && !m[3]
      ? 'create'
      : p.method === 'PATCH' && m[3]
        ? 'update'
        : p.method === 'DELETE' && m[3] && c.remove
          ? 'delete'
          : undefined;
  if (!verb || (m[5] && p.method !== 'POST') || (verb === 'replace' && !c.replace)) return;
  return {
    kind,
    child,
    verb: verb as Contract['verb'],
    parent: child ? root + '/' + m[3] : root,
    collection: child ? root + '/' + m[3] + '/' + c.child : root,
    target: child ? m[6] : m[3],
  };
}
function text(value: unknown, label: string, bytes: number) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > bytes)
    fail('INVALID_VENDOR_BODY', label + ' must be nonblank UTF-8 within ' + bytes + ' bytes.');
}
function item(c: (typeof dv360ListContracts)[Kind], value: JsonObject) {
  validateDiscoveryBody(c.item, models(), value, true);
  if (c.child === 'sites') {
    text(value.urlOrAppId, 'urlOrAppId', 240);
    if (/[\x00-\x20\\?#]/.test(value.urlOrAppId))
      fail(
        'INVALID_VENDOR_BODY',
        'A channel site must be a native URL or app ID without controls or query delimiters.',
      );
  }
  if (c.child === 'negativeKeywords') {
    text(value.keywordValue, 'keywordValue', 255);
    if (
      !/^[\x20-\x7e]+$/.test(value.keywordValue) ||
      value.keywordValue.length > 80 ||
      value.keywordValue.trim().split(/\s+/).length > 10 ||
      value.keywordValue !== value.keywordValue.trim() ||
      /%(?!20)/i.test(value.keywordValue)
    )
      fail(
        'INVALID_VENDOR_BODY',
        'Negative keywords require 1–80 ASCII characters, at most 10 words, and canonical surrounding whitespace. Only %20 is accepted as a native whitespace escape.',
      );
  }
  if (
    c.child === 'assignedLocations' &&
    (typeof value.targetingOptionId !== 'string' ||
      !value.targetingOptionId ||
      /[\x00-\x20\\?#/]/.test(value.targetingOptionId))
  )
    fail('INVALID_VENDOR_BODY', 'Provide a native targetingOptionId.');
}
const nativeKey = (c: (typeof dv360ListContracts)[Kind], row: JsonObject) =>
  c.child === 'negativeKeywords'
    ? keyword(String(row[c.key]))
    : String(row[c.child === 'assignedLocations' ? 'targetingOptionId' : c.key]);
function changes(p: CompiledRequest, r: Contract) {
  const c = dv360ListContracts[r.kind],
    body = obj(p.body) ? p.body : {},
    suffix = c.child[0]!.toUpperCase() + c.child.slice(1);
  const adds = r.verb === 'create' ? [body] : (body[(r.verb === 'replace' ? 'new' : 'created') + suffix] ?? []);
  const removes =
    r.verb === 'delete'
      ? [decoded(r.target!) ?? fail('INVALID_VENDOR_BODY', 'Malformed removal identifier.')]
      : (body['deleted' + suffix] ?? []);
  return {adds: adds as JsonObject[], removes: removes as string[]};
}
export function assertDV360ListWrite(p: CompiledRequest): void {
  const r = dv360ListKind(p);
  if (!r) return;
  const c = dv360ListContracts[r.kind],
    body = obj(p.body) ? p.body : {};
  if (p.path.split('/')[3] !== p.accountId) fail('ACCOUNT_SCOPE_MISMATCH', 'DV360 path must belong to account_id.');
  if (Object.keys(p.query).some(k => r.verb !== 'update' || k !== 'updateMask'))
    fail(
      'INVALID_VENDOR_BODY',
      'Only explicit updateMask is accepted for list updates. Partner overrides need a separate partner contract.',
    );
  if (r.verb === 'delete') {
    if (p.body !== undefined && (!obj(p.body) || Object.keys(body).length))
      fail('INVALID_VENDOR_BODY', 'DELETE has no body.');
    return;
  }
  if (!obj(p.body)) fail('INVALID_VENDOR_BODY', 'Provide the native request object.');
  if (body.partnerId !== undefined || (body.advertiserId !== undefined && String(body.advertiserId) !== p.accountId))
    fail('ACCOUNT_SCOPE_MISMATCH', 'List owner must be the selected advertiser.');
  if (!r.child) {
    validateDiscoveryBody(c.model, models(), body, r.verb === 'create');
    text(body.displayName, 'displayName', c.maxNameBytes);
    if (
      r.verb === 'update' &&
      (p.query.updateMask !== 'displayName' || Object.keys(body).some(k => k !== 'displayName'))
    )
      fail(
        'INVALID_UPDATE_MASK',
        'List updates require updateMask=displayName and that field only; owner and location type are immutable.',
      );
    if (
      r.kind === 'locationLists' &&
      r.verb === 'create' &&
      !['TARGETING_LOCATION_TYPE_PROXIMITY', 'TARGETING_LOCATION_TYPE_REGIONAL'].includes(body.locationType)
    )
      fail('INVALID_VENDOR_BODY', 'Choose the explicit location type.');
    return;
  }
  const suffix = c.child[0]!.toUpperCase() + c.child.slice(1),
    model = r.verb === 'create' ? c.item : (r.verb === 'replace' ? 'Replace' : 'BulkEdit') + suffix + 'Request';
  validateDiscoveryBody(model, models(), body, true);
  if (r.verb === 'replace' && !Array.isArray(body['new' + suffix]))
    fail('INVALID_VENDOR_BODY', 'Replacement requires the explicit new membership array, including [] to clear it.');
  const {adds, removes} = changes(p, r);
  if (
    !Array.isArray(adds) ||
    !Array.isArray(removes) ||
    adds.length + removes.length > 1000 ||
    (r.verb === 'bulkEdit' && !adds.length && !removes.length)
  )
    fail(
      'INVALID_VENDOR_BODY',
      'A review supports 1–1000 bulk changes, or an explicit replacement of up to 1000 members.',
    );
  adds.forEach(v => {
    if (!obj(v)) fail('INVALID_VENDOR_BODY', 'Members must be native objects.');
    item(c, v);
  });
  if (removes.some(v => typeof v !== 'string' || !v || /[\x00-\x1f]/.test(v)))
    fail('INVALID_VENDOR_BODY', 'Removal identifiers must be nonempty strings.');
  if (
    new Set(adds.map(v => nativeKey(c, v))).size !== adds.length ||
    new Set(removes).size !== removes.length ||
    (c.child !== 'assignedLocations' && adds.some(v => removes.includes(nativeKey(c, v))))
  )
    fail('INVALID_VENDOR_BODY', 'A member cannot be duplicated or both added and removed in one review.');
}
const base = (p: CompiledRequest, path: string, optional = false): CompiledRequest =>
  stateReadOf(p, optional ? 'AMCP_STATE_OPTIONAL' : 'AMCP_DV360_LIST_STATE', path, {});
function members(p: CompiledRequest, r: Contract): CompiledRequest {
  const c = dv360ListContracts[r.kind],
    path = r.child ? r.collection : r.parent + '/' + r.target + '/' + c.child;
  return {...base(p, path), query: {pageSize: c.pageSize}, dv360ListState: {kind: r.kind, collection: true}};
}
export function dv360ListSnapshots(p: CompiledRequest): CompiledRequest[] {
  const r = dv360ListKind(p)!;
  if (r.child) return [base(p, r.parent), members(p, r)];
  return r.verb === 'create'
    ? [base(p, '/v4/advertisers/' + p.accountId)]
    : [base(p, p.path), ...(r.verb === 'delete' ? [members(p, r)] : [])];
}
export function validateDV360ListState(p: CompiledRequest, response: TransportResult, allowPage = false): void {
  const d = response.data;
  if (!obj(d) || response.status !== 200 || d.error)
    fail('STATE_READ_FAILED', 'DV360 state requires a successful native response.');
  const marker = p.dv360ListState;
  if (marker?.collection) {
    const c = dv360ListContracts[marker.kind as Kind],
      rows = d[c.child];
    if (
      (rows !== undefined && !Array.isArray(rows)) ||
      (rows === undefined && Object.keys(d).some(k => k !== 'nextPageToken'))
    )
      fail('STATE_READ_FAILED', 'Missing or malformed native membership array.');
    if ((d.nextPageToken !== undefined && typeof d.nextPageToken !== 'string') || (!allowPage && d.nextPageToken))
      fail('INCOMPLETE_STATE', 'A membership read is incomplete.');
    const seen = new Set<string>();
    for (const row of rows ?? []) {
      if (
        !obj(row) ||
        typeof row[c.key] !== 'string' ||
        !row[c.key] ||
        seen.has(row[c.key]) ||
        !sameName(row.name, p.path.slice(4) + '/' + row[c.key])
      )
        fail(
          'STATE_TARGET_MISMATCH',
          'Membership rows must have unique IDs and the exact selected parent resource name.',
        );
      if (c.child === 'assignedLocations' && (typeof row.targetingOptionId !== 'string' || !row.targetingOptionId))
        fail('STATE_TARGET_MISMATCH', 'Assignment must identify its targeting option.');
      seen.add(row[c.key]);
    }
    return;
  }
  const parts = p.path.split('/'),
    collection = parts.at(-2),
    id = parts.at(-1);
  if (collection === 'advertisers') {
    if (String(d.advertiserId) !== p.accountId)
      fail('STATE_TARGET_MISMATCH', 'Advertiser state has a different identity.');
    return;
  }
  const c = dv360ListContracts[collection as Kind];
  if (
    !c ||
    String(d[c.id]) !== id ||
    String(d.advertiserId) !== p.accountId ||
    d.name !== p.path.slice(4) ||
    d.partnerId !== undefined
  )
    fail('STATE_TARGET_MISMATCH', 'List state did not identify its exact selected-advertiser resource.');
}
/** Complete bounded pagination for membership snapshots. Provider cursors are
 * opaque query values; never follow arbitrary links or mutate during recovery. */
export async function readDV360List(
  p: CompiledRequest,
  request: (read: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  if (!p.dv360ListState?.collection) return request(p);
  const c = dv360ListContracts[p.dv360ListState.kind as Kind],
    rows: JsonObject[] = [],
    tokens = new Set<string>();
  let current = p;
  for (let page = 0; page < 100; page++) {
    const response = await request(current);
    validateDV360ListState(current, response, true);
    const data = response.data as JsonObject;
    rows.push(...(data[c.child] ?? []));
    if (rows.length > 10000)
      fail('STATE_TOO_LARGE', 'Membership snapshots are limited to 10,000 entries; no mutation was submitted.');
    if (!data.nextPageToken) {
      const result = {
        ...response,
        data: {[c.child]: rows.sort((a, b) => String(a[c.key]).localeCompare(String(b[c.key]), 'en'))},
      };
      validateDV360ListState(p, result);
      return result;
    }
    if (tokens.has(data.nextPageToken)) fail('INCOMPLETE_STATE', 'Provider repeated a membership cursor.');
    tokens.add(data.nextPageToken);
    current = {...p, query: {...p.query, pageToken: data.nextPageToken}};
  }
  return fail('INCOMPLETE_STATE', 'Membership pagination exceeded 100 pages.');
}
export function validateDV360ListPrerequisites(p: CompiledRequest, state: unknown[], preparing = false): void {
  const r = dv360ListKind(p);
  if (!r?.child) return;
  const c = dv360ListContracts[r.kind],
    rows = (state[1] as JsonObject)?.[c.child] as JsonObject[];
  const {adds, removes} = changes(p, r);
  for (const id of removes)
    if (!rows.some(row => row[c.key] === id))
      fail('STATE_NOT_FOUND', 'A requested removal is absent from the exact selected list.');
  if (preparing && r.verb !== 'replace' && adds.some(a => rows.some(row => nativeKey(c, row) === nativeKey(c, a))))
    fail(
      'CONFIGURATION_EXISTS',
      'A requested member is already present. Inspect the existing list instead of recreating it.',
    );
}
function receiptRows(p: CompiledRequest, r: Contract, rows: unknown, expected: JsonObject[]): boolean {
  const c = dv360ListContracts[r.kind];
  if (!Array.isArray(rows) || rows.length !== expected.length) return false;
  const seen = new Set<string>(),
    values = new Set<string>();
  return rows.every(row => {
    if (
      !obj(row) ||
      typeof row[c.key] !== 'string' ||
      !row[c.key] ||
      seen.has(row[c.key]) ||
      values.has(nativeKey(c, row)) ||
      !sameName(row.name, r.collection.slice(4) + '/' + row[c.key])
    )
      return false;
    seen.add(row[c.key]);
    values.add(nativeKey(c, row));
    return expected.some(e => nativeKey(c, e) === nativeKey(c, row));
  });
}
export function dv360ListOutcome(p: CompiledRequest, response: TransportResult): boolean {
  const r = dv360ListKind(p)!,
    c = dv360ListContracts[r.kind],
    d = response.data;
  if (response.status !== 200 || !obj(d) || d.error) return false;
  if (r.verb === 'delete') return Object.keys(d).length === 0;
  if (r.child) {
    const {adds} = changes(p, r);
    return receiptRows(p, r, r.verb === 'create' ? [d] : (d[c.child] ?? []), adds);
  }
  return (
    typeof d[c.id] === 'string' &&
    /^[1-9]\d*$/.test(d[c.id]) &&
    String(d.advertiserId) === p.accountId &&
    d.partnerId === undefined &&
    d.name === r.parent.slice(4) + '/' + d[c.id] &&
    (r.verb === 'create' || d[c.id] === r.target)
  );
}
export function dv360ListVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const r = dv360ListKind(p)!,
    c = dv360ListContracts[r.kind],
    body = obj(p.body) ? p.body : {};
  if (!r.child) {
    if (r.verb === 'delete')
      return [
        {
          read: {...base(p, p.path, true), dv360ListState: {kind: r.kind, collection: false}},
          expected: {amcp_absent: true, path: p.path},
          id: p.path,
        },
      ];
    const path = r.verb === 'create' ? r.parent + '/' + result.data[c.id] : p.path;
    return [{read: base(p, path), expected: body, id: path}];
  }
  const old = (before[1] as JsonObject)[c.child] as JsonObject[],
    {adds, removes} = changes(p, r);
  const final = r.verb === 'replace' ? adds : [...old.filter(row => !removes.includes(row[c.key])), ...adds];
  return [{read: members(p, r), expected: {members: final.map(row => nativeKey(c, row)).sort()}, id: r.collection}];
}
export function dv360ListObserved(p: CompiledRequest, data: JsonObject): JsonObject {
  if (!p.dv360ListState?.collection) return data;
  const c = dv360ListContracts[p.dv360ListState.kind as Kind];
  return {members: data[c.child].map((row: JsonObject) => nativeKey(c, row)).sort()};
}
export function dv360ListAffectsServing(p: CompiledRequest): boolean {
  const r = dv360ListKind(p);
  return !!r && (r.child || r.verb === 'delete');
}
export function dv360ListRemoves(p: CompiledRequest): boolean {
  const r = dv360ListKind(p);
  return !!r && (r.verb === 'delete' || r.verb === 'replace' || (r.child && changes(p, r).removes.length > 0));
}

/** A list read: an absent target only where the read allowed one; otherwise the gateway's checks and the list contract. */
export function validateDV360ListRead(
  read: CompiledRequest,
  result: TransportResult,
  gateway: GatewayStateChecks,
): void {
  if (read.dv360ListState && !read.dv360ListState.collection && result.status === 404) {
    const d = obj(result.data) ? result.data : {};
    if (read.action !== 'AMCP_STATE_OPTIONAL' || d.amcp_absent !== true || d.path !== read.path)
      fail('STATE_TARGET_MISMATCH', 'Unqualified absent DV360 target.');
    return;
  }
  gateway(validateDV360ListState);
}

/** What a list write changes, as prepare returns it for review. */
export function dv360ListImpact(): JsonObject {
  return {
    provider: 'dv360',
    effect:
      'Channel, location and negative-keyword lists can be shared by enabled line items. Membership edits affect all consumers of this selected-advertiser list. Replacement removes previous members not in the supplied complete list.',
    verification:
      'Complete membership read-back, including all pages, compares the resulting set. It does not establish serving or policy approval.',
    limits:
      'Advertiser-owned lists only; partner ownership requires separate grants. Maximum 1000 changes, 10000 snapshot members and 100 pages per review.',
    recovery:
      'Partial receipts and lost responses do not authorize replay. Preserve the frozen request and inspect membership; corrections require a fresh review.',
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const dv360ListFamily: ReviewedFamily = {
  name: 'dv360_lists',
  files: ['src/dv360-list-writes.ts', ['tests/dv360-list-writes.test.ts']],
  kind: dv360ListKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    assertDV360ListWrite(plan);
    gateway();
  },
  scope: (c, write) => {
    if (write) assertDV360WriteScope(c, true);
  },
  snapshots: dv360ListSnapshots,
  isRead: (read: CompiledRequest) =>
    read.gateway === 'dv360_native_action' && (!!read.dv360ListState || read.action === 'AMCP_DV360_LIST_STATE'),
  reader: (read, next) => readDV360List(read, next),
  validateState: validateDV360ListRead,
  prerequisites: (plan, state) => validateDV360ListPrerequisites(plan, state),
  stateChecks: (plan, state, preparing) => {
    if (preparing) validateDV360ListPrerequisites(plan, state, true);
  },
  impact: dv360ListImpact,
  outcome: dv360ListOutcome,
  verification: dv360ListVerification,
  observed: (read: CompiledRequest, data: JsonObject) =>
    data.amcp_absent !== true && read.dv360ListState ? dv360ListObserved(read, data) : data,
  spendConfirmation: {
    needed: plan => !!dv360ListAffectsServing(plan),
    message: 'DV360 shared-list membership can change serving eligibility. Provide spend_change_confirmed=true.',
  },
  activates: plan => !!dv360ListAffectsServing(plan),
  destructive: plan => !!dv360ListRemoves(plan),
};
