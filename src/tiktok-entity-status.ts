import {MirrorError} from './errors.js';
import {assertNoMethodOverride, object, responseData} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import type {TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Operation statuses of standard TikTok campaigns, ad groups and ads, per API for Business v1.3 "Update the status of
 * campaigns / ad groups / ads" (POST /v1.3/{campaign,adgroup,ad}/status/update/) and the matching get endpoints, whose
 * `filtering.primary_status` defaults to STATUS_NOT_DELETE and takes STATUS_ALL. Each call names 1-20 IDs and one
 * operation_status: ENABLE, DISABLE or DELETE (WRT-02 stage B; before it these routes were generic entity writes, so a
 * DELETE passed an owner policy that forbids deletion). DELETE is destructive and ENABLE activates. A DELETE review reads
 * the children it takes with it (ad groups and ads of a campaign, ads of an ad group) and fails closed when they do not
 * fit one complete page. Partial success, SKAN postback windows and ACO ads stay outside this contract.
 */
type Kind = 'campaign' | 'adgroup' | 'ad';
type Status = 'ENABLE' | 'DISABLE' | 'DELETE';
type Marker =
  {role: 'children'; kind: 'adgroup' | 'ad'; parent: Kind; ids: string[]} | {role: 'deleted'; kind: Kind; id: string};
type Read = CompiledRequest & {tiktokStatusRead?: Marker};
const gateway = 'tiktok_native_action',
  maxIds = 20,
  childPageSize = 1000;
export const tiktokEntityStatusSource = 'https://business-api.tiktok.com/portal/docs';
const ids: Record<Kind, string> = {campaign: 'campaign_ids', adgroup: 'adgroup_ids', ad: 'ad_ids'};
const idField: Record<Kind, string> = {campaign: 'campaign_id', adgroup: 'adgroup_id', ad: 'ad_id'};
const nameField: Record<Kind, string> = {campaign: 'campaign_name', adgroup: 'adgroup_name', ad: 'ad_name'};
const allowed: Record<Kind, string[]> = {
  campaign: ['advertiser_id', 'campaign_ids', 'operation_status'],
  adgroup: ['advertiser_id', 'adgroup_ids', 'operation_status', 'allow_partial_success'],
  ad: ['advertiser_id', 'ad_ids', 'operation_status'],
};
const outside: Record<string, string> = {
  postback_window_mode: 'SKAN 4.0 postback windows need their own review.',
  aco_ad_ids: 'automated creative (ACO) ads need their own review.',
};
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_STATUS', message, {field, source: tiktokEntityStatusSource});
}
function unverified(message: string): never {
  throw new MirrorError('INCOMPLETE_STATE', message, {}, 502);
}

export function tiktokEntityStatusKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.method !== 'POST' || p.specialTransport) return;
  return /^\/v1\.3\/(campaign|adgroup|ad)\/status\/update\/$/.exec(p.path)?.[1] as Kind | undefined;
}
function request(p: CompiledRequest): {kind: Kind; ids: string[]; status: Status} {
  const kind = tiktokEntityStatusKind(p)!,
    b = object(p.body);
  return {kind, ids: (b[ids[kind]] ?? []) as string[], status: b.operation_status as Status};
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokEntityStatus(p: CompiledRequest): void {
  const kind = tiktokEntityStatusKind(p);
  if (!kind) return;
  if (Object.keys(p.query).length) invalid('query', 'Send the status change in the body, without query parameters.');
  const b = p.body;
  if (!obj(b)) invalid('body', 'Send the status change as a native object.');
  const extra = Object.keys(b).find(k => !allowed[kind].includes(k));
  if (extra)
    invalid(
      extra,
      '"' + extra + '" is outside the qualified status contract' + (outside[extra] ? '; ' + outside[extra] : '.'),
    );
  if (b.advertiser_id !== undefined && String(b.advertiser_id) !== p.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  const list = b[ids[kind]];
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.length > maxIds ||
    !list.every(numeric) ||
    new Set(list).size !== list.length
  )
    invalid(ids[kind], ids[kind] + ' must list 1 to ' + maxIds + ' unique numeric IDs.');
  if (!['ENABLE', 'DISABLE', 'DELETE'].includes(b.operation_status))
    invalid('operation_status', 'operation_status must be ENABLE, DISABLE or DELETE.');
  // A partial success would leave some entities changed and others not, which one receipt cannot prove.
  if (b.allow_partial_success !== undefined && b.allow_partial_success !== false)
    invalid(
      'allow_partial_success',
      'allow_partial_success must be false or left out: a partial success cannot be verified as one reviewed change.',
    );
}

/** True for a DELETE: the owner policy with allow_deletion:false refuses it, whatever the catalog says of the route. */
export function tiktokEntityStatusDeletes(p: CompiledRequest): boolean {
  return !!tiktokEntityStatusKind(p) && object(p.body).operation_status === 'DELETE';
}
/** True for an ENABLE, which starts delivery wherever the parents are on. */
export function tiktokEntityStatusActivates(p: CompiledRequest): boolean {
  return !!tiktokEntityStatusKind(p) && object(p.body).operation_status === 'ENABLE';
}

/**
 * The reviewed entities (the default get, which leaves deleted entities out, so every ID must still exist), and for a
 * DELETE the children it takes with it, read by their parents' IDs.
 */
export function tiktokEntityStatusSnapshots(
  p: CompiledRequest,
  stateRead: (path: string, query?: JsonObject) => CompiledRequest,
): CompiledRequest[] {
  const {kind, ids: list, status} = request(p);
  const target = stateRead('/v1.3/' + kind + '/get/', {
    advertiser_id: p.accountId,
    filtering: {[ids[kind]]: list},
    page_size: 100,
  });
  target.action = 'tiktok_' + kind + '_get';
  if (status !== 'DELETE' || kind === 'ad') return [target];
  const children: ('adgroup' | 'ad')[] = kind === 'campaign' ? ['adgroup', 'ad'] : ['ad'];
  return [
    target,
    ...children.map(child => {
      const read: Read = stateRead('/v1.3/' + child + '/get/', {
        advertiser_id: p.accountId,
        filtering: {[ids[kind]]: list},
        page: 1,
        page_size: childPageSize,
      });
      read.action = 'tiktok_' + child + '_get';
      read.tiktokStatusRead = {role: 'children', kind: child, parent: kind, ids: [...list]};
      return read;
    }),
  ];
}
export function isTiktokEntityStatusRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).tiktokStatusRead;
}
const listOf = (d: unknown): JsonObject[] => {
  if (!obj(d) || d.code !== 0 || !obj(d.data) || !Array.isArray(d.data.list))
    unverified('TikTok did not confirm success with its native list.');
  const rows = d.data.list as unknown[];
  if (!rows.every(obj)) unverified('A TikTok list row is malformed.');
  const pages = obj(d.data.page_info) ? Number(d.data.page_info.total_page ?? 1) : 1;
  if (!Number.isInteger(pages) || pages > 1) unverified('TikTok listed more than one page; narrow the change.');
  return rows as JsonObject[];
};
/** Each child names its own ID and a reviewed parent; anything else is a read of something other than the children. */
function childRows(m: Extract<Marker, {role: 'children'}>, d: unknown): JsonObject[] {
  const rows = listOf(d),
    parent = idField[m.parent];
  for (const r of rows)
    if (!numeric(String(r[idField[m.kind]] ?? '')) || !m.ids.includes(String(r[parent] ?? '')))
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'TikTok returned a ' + m.kind + ' outside the reviewed ' + m.parent + 's.',
      );
  return rows;
}
const deletedRow = (row: JsonObject) =>
  row.operation_status === 'DELETE' || /_DELETE$/.test(String(row.secondary_status ?? ''));
/**
 * A deletion read-back: every entity, deleted included (STATUS_ALL), where a deleted one carries secondary_status
 * *_DELETE; when the entity is no longer listed at all, its absence from the default read (STATUS_NOT_DELETE) proves
 * the deletion. A row that is listed and not deleted proves the opposite.
 */
export async function readTiktokEntityStatus(
  p: CompiledRequest,
  next: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const m = (p as Read).tiktokStatusRead;
  if (!m || m.role !== 'deleted') return next(p);
  const plain = {...p, tiktokStatusRead: undefined} as Read,
    filter = (primary: string) => ({
      ...plain,
      query: {...plain.query, filtering: {[ids[m.kind]]: [m.id], primary_status: primary}},
    });
  const ok = (r: TransportResult) => {
    if (r.status !== 200) unverified('TikTok did not return the ' + m.kind + '.');
    return listOf(r.data).filter(row => String(row[idField[m.kind]]) === m.id);
  };
  const all = ok(await next(filter('STATUS_ALL')));
  if (all.length > 1) unverified('TikTok listed ' + m.kind + ' ' + m.id + ' twice.');
  if (all.length === 1)
    return {
      status: 200,
      headers: {},
      data: {
        tiktok_status: {
          id: m.id,
          deleted: deletedRow(all[0]!),
          evidence: 'secondary_status',
          secondary_status: all[0]!.secondary_status ?? null,
        },
      },
    };
  const live = ok(await next(filter('STATUS_NOT_DELETE')));
  return {
    status: 200,
    headers: {},
    data: {tiktok_status: {id: m.id, deleted: live.length === 0, evidence: 'absent'}},
  };
}
export function validateTiktokEntityStatusState(
  p: CompiledRequest,
  r: TransportResult,
  gatewayChecks: (identity?: (read: CompiledRequest, result: TransportResult) => void) => void,
): void {
  const m = (p as Read).tiktokStatusRead;
  if (m?.role === 'children') {
    gatewayChecks(read => childRows(m, r.data));
    return;
  }
  const s = obj(r.data) ? r.data.tiktok_status : undefined;
  if (r.status !== 200 || !obj(s) || s.id !== (m as {id: string}).id || typeof s.deleted !== 'boolean')
    unverified('Missing the deletion read-back.');
}
/** Children keep only what the impact shows: identity, parents, name and statuses (no metrics or timestamps). */
export function tiktokEntityStatusState(read: CompiledRequest, data: JsonObject): unknown {
  const m = (read as Read).tiktokStatusRead;
  if (m?.role !== 'children') return data;
  return {
    tiktok_status_children: {
      kind: m.kind,
      rows: childRows(m, data)
        .map(r => ({
          id: String(r[idField[m.kind]]),
          ...(m.kind === 'ad' ? {adgroup_id: r.adgroup_id ?? null} : {}),
          [idField[m.parent]]: String(r[idField[m.parent]]),
          name: r[nameField[m.kind]] ?? null,
          operation_status: r.operation_status ?? null,
          secondary_status: r.secondary_status ?? null,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    },
  };
}

const targetRows = (state: unknown[]) => {
  const first = state[0];
  return (obj(first) && obj(first.data) && Array.isArray(first.data.list) ? first.data.list : []) as JsonObject[];
};
const childrenOf = (state: unknown[], kind: 'adgroup' | 'ad') =>
  state
    .map(s => (obj(s) && obj(s.tiktok_status_children) ? s.tiktok_status_children : undefined))
    .find(c => c?.kind === kind)?.rows as JsonObject[] | undefined;
/** What the change does to each entity and, for a DELETE, which children go with them and which of those serve. */
export function tiktokEntityStatusImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const {kind, ids: list, status} = request(p),
    rows = targetRows(state);
  const changes = list.map(id => {
    const row = rows.find(r => String(r[idField[kind]]) === id);
    if (!row)
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'TikTok ' + kind + ' ' + id + ' was not returned for the selected advertiser (deleted entities cannot change).',
        {[idField[kind]]: id},
      );
    return {
      [idField[kind]]: id,
      name: row[nameField[kind]] ?? null,
      before: row.operation_status ?? null,
      after: status,
      unchanged: row.operation_status === status,
    };
  });
  const out: JsonObject = {
    provider: 'tiktok',
    scope: kind + '_status',
    operation: status === 'DELETE' ? 'delete' : 'status',
    may_affect_serving: true,
    changes,
    source: tiktokEntityStatusSource,
  };
  if (status === 'ENABLE')
    out.effect =
      'Turns the listed ' + kind + 's on. They can deliver and spend if their parents are on and their budgets allow.';
  else if (status === 'DISABLE') out.effect = 'Turns the listed ' + kind + 's off. Delivery stops; nothing is deleted.';
  else {
    const children = (
      kind === 'campaign' ? (['adgroup', 'ad'] as const) : kind === 'adgroup' ? (['ad'] as const) : []
    ).map(child => {
      const found = childrenOf(state, child);
      if (!found) unverified('Missing the ' + child + 's under the ' + kind + 's to delete.');
      return {
        kind: child,
        count: found.length,
        enabled: found.filter(r => r.operation_status === 'ENABLE'),
        all: found.map(r => r.id),
      };
    });
    out.effect =
      'Deletes the listed ' +
      kind +
      's; AMCP cannot undo a deletion' +
      (children.length
        ? ', and the ' +
          children.map(c => (c.kind === 'adgroup' ? 'ad groups' : 'ads')).join(' and ') +
          ' under them stop delivering with them'
        : '') +
      '.';
    out.children = children;
    out.enabled_children = children.reduce((n, c) => n + c.enabled.length, 0);
    out.verification =
      'Reads each ' +
      kind +
      ' again with deleted entities included and expects it deleted (secondary_status *_DELETE).';
  }
  return out;
}

/**
 * Code 0 is TikTok's success, and without partial success the call changes every ID or none. When the reply lists the
 * changed IDs, each requested one must be among them, and an error list must be empty.
 */
export function tiktokEntityStatusOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const {kind, ids: list} = request(p),
    d = responseData(r);
  if (d.code !== 0) return false;
  const data = object(d.data),
    listed = data[ids[kind]];
  if (Array.isArray(data.error_list) && data.error_list.length) return false;
  return !Array.isArray(listed) || list.every(id => listed.map(String).includes(id));
}

/** One read per entity: its operation status after ENABLE or DISABLE, its deletion after DELETE. */
export function tiktokEntityStatusVerification(
  p: CompiledRequest,
  _result: JsonObject,
  _before: unknown[],
  verificationRead: (path: string, query?: JsonObject) => CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const {kind, ids: list, status} = request(p);
  return list.map(id => {
    const read: Read = {
      ...verificationRead('/v1.3/' + kind + '/get/', {
        advertiser_id: p.accountId,
        filtering: {[ids[kind]]: [id]},
        page_size: 100,
      }),
      action: 'tiktok_' + kind + '_get',
    };
    if (status !== 'DELETE') return {read, expected: {[idField[kind]]: id, operation_status: status}, id};
    read.tiktokStatusRead = {role: 'deleted', kind, id};
    return {read, expected: {id, deleted: true}, id};
  });
}
export function tiktokEntityStatusObserved(read: CompiledRequest, data: JsonObject, gateway: () => JsonObject) {
  const m = (read as Read).tiktokStatusRead;
  if (m?.role !== 'deleted') return gateway();
  const s = obj(data.tiktok_status) ? data.tiktok_status : {};
  return {id: s.id ?? null, deleted: s.deleted ?? null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokEntityStatusFamily: ReviewedFamily = {
  name: 'tiktok_entity_status',
  files: ['src/tiktok-entity-status.ts', ['tests/tiktok-entity-status.test.mjs']],
  kind: tiktokEntityStatusKind,
  assert: (plan, gatewayChecks) => {
    assertNoMethodOverride(plan);
    gatewayChecks();
    assertTiktokEntityStatus(plan);
  },
  snapshots: tiktokEntityStatusSnapshots,
  isRead: isTiktokEntityStatusRead,
  reader: readTiktokEntityStatus,
  validateState: validateTiktokEntityStatusState,
  snapshotState: tiktokEntityStatusState,
  impact: tiktokEntityStatusImpact,
  outcome: tiktokEntityStatusOutcome,
  verification: tiktokEntityStatusVerification,
  observed: tiktokEntityStatusObserved,
  activates: tiktokEntityStatusActivates,
  destructive: tiktokEntityStatusDeletes,
};
