import {MirrorError} from './errors.js';
import {assertNoMethodOverride, object, responseData} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import type {TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';
import {tiktokSmartPlusStatusRoute, tiktokSmartPlusStatusSource} from './tiktok-smart-plus-status.js';

/**
 * Deleting Upgraded Smart+ campaigns, ad groups and ads (r25-m4-smartdelete; owner O3, 2026-11-20: "add delete function
 * to AMCP"). TikTok has no Smart+ delete route: a deletion is `operation_status: DELETE` on the three status routes,
 * POST /v1.3/smart_plus/{campaign|adgroup|ad}/status/update/, per API for Business v1.3 "Update the operation statuses
 * of Upgraded Smart+ Campaigns / Ad Groups / Ads" as recorded on 2026-09-26
 * (docs/implementation/TIKTOK-SMART-PLUS-STATUS-2026-09-26.md): 1-20 IDs; DISABLE, ENABLE or DELETE; deleted entities
 * cannot change status; campaign and ad group answers list per-ID successes (campaign_list, adgroup_list) and errors
 * (error_list), ad answers return smart_plus_ad_ids and one status. Pausing and enabling stay with
 * tiktok_smart_plus_status; this family claims only the DELETE bodies of those routes (QUESTIONS L11, lead 2026-11-20).
 *
 * It is the classic DELETE's contract (src/tiktok-entity-status.ts, WRT-02 stage B) adapted to Smart+, with one rule
 * more (QUESTIONS L12): a target that does not read paused (DISABLE, or FROZEN for a terminated ad) is refused, with the
 * status family's DISABLE prepare as `next_call`. The review reads the targets and the children a deletion takes with
 * it (a campaign's ad groups and ads, an ad group's ads) by their parents' IDs, one page each of 100 rows, AMCP's
 * Smart+ page size (src/tiktok-audience-edits.ts, src/tiktok-library-assets.ts), or INCOMPLETE_STATE; enabled children
 * of a paused target are listed and allowed, since they cannot deliver under it. Every request it claims is destructive:
 * allow_deletion:false refuses it, the owner's destructive tier asks destructive_confirmed and website approval asks a
 * member (QUESTIONS L13). A deletion stops delivery, so it asks no spending confirmation, as the classic one.
 *
 * The read-back reads each target with `primary_status: STATUS_ALL` and expects its own *_STATUS_DELETE, or, when it
 * is not listed there, its absence from the default read (lead review S3-1). TikTok's pages, read on 2026-11-21 by the
 * lead (docs/implementation/TIKTOK-SMART-PLUS-DELETION-2026-11-21.md), document STATUS_ALL for the three Smart+ gets,
 * DELETE among the receipt's statuses, and that the children of a deleted parent are not deleted themselves: they can
 * no longer change status and read *_CAMPAIGN_DELETE or *_ADGROUP_DELETE. The live shapes are checked by M4 LV-29.
 * SKAN postback windows, undo, a paused-and-deleted target in one step and Smart+ creatives inside an ad stay outside
 * this contract.
 */
type Kind = 'campaign' | 'adgroup' | 'ad';
type Child = 'adgroup' | 'ad';
type Marker =
  | {role: 'targets'; kind: Kind; ids: string[]}
  | {role: 'children'; kind: Child; parent: 'campaign' | 'adgroup'; ids: string[]}
  | {role: 'deleted'; kind: Kind; id: string};
type Read = CompiledRequest & {tiktokSmartPlusDeletion?: Marker};
const gateway = 'tiktok_native_action',
  maxIds = 20,
  pageSize = 100;
const ids: Record<Kind, string> = {campaign: 'campaign_ids', adgroup: 'adgroup_ids', ad: 'smart_plus_ad_ids'};
const idField: Record<Kind, string> = {campaign: 'campaign_id', adgroup: 'adgroup_id', ad: 'smart_plus_ad_id'};
const nameField: Record<Kind, string> = {campaign: 'campaign_name', adgroup: 'adgroup_name', ad: 'ad_name'};
const label: Record<Kind, string> = {campaign: 'campaign', adgroup: 'ad group', ad: 'ad'};
const childKinds: Record<Kind, Child[]> = {campaign: ['adgroup', 'ad'], adgroup: ['ad'], ad: []};
const getPath = (kind: Kind) => '/v1.3/smart_plus/' + kind + '/get/';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const text = (v: unknown) => (v === undefined || v === null ? null : String(v));
function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_DELETION', message, {field, source: tiktokSmartPlusStatusSource});
}
function unverified(message: string): never {
  throw new MirrorError('INCOMPLETE_STATE', message, {}, 502);
}
function mismatch(message: string, details: JsonObject = {}): never {
  throw new MirrorError('STATE_TARGET_MISMATCH', message, details);
}

/** A DELETE body on one of the three Smart+ status routes; every other body there is tiktok_smart_plus_status's. */
export function tiktokSmartPlusDeletionKind(p: CompiledRequest): Kind | undefined {
  const kind = tiktokSmartPlusStatusRoute(p);
  return kind && object(p.body).operation_status === 'DELETE' ? kind : undefined;
}
function request(p: CompiledRequest): {kind: Kind; ids: string[]} {
  const kind = tiktokSmartPlusDeletionKind(p)!;
  return {kind, ids: (object(p.body)[ids[kind]] ?? []) as string[]};
}
const marker = (read: CompiledRequest) => (read as Read).tiktokSmartPlusDeletion;

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSmartPlusDeletion(p: CompiledRequest): void {
  const kind = tiktokSmartPlusDeletionKind(p);
  if (!kind) return;
  const body = object(p.body),
    field = ids[kind];
  const extra = Object.keys(body).find(k => !['advertiser_id', field, 'operation_status'].includes(k));
  if (extra === 'postback_window_mode')
    invalid(
      extra,
      '"postback_window_mode" is outside the qualified Smart+ deletion contract; SKAN 4.0 postback windows need their own review.',
    );
  if (extra) invalid(extra, '"' + extra + '" is outside the qualified Smart+ deletion contract.');
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== p.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  const list = body[field];
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.length > maxIds ||
    !list.every(numeric) ||
    new Set(list).size !== list.length
  )
    invalid(field, field + ' must list 1 to ' + maxIds + ' unique numeric IDs.');
}

/**
 * The targets by ID, and the children the deletion takes with it by their parents' IDs: a campaign's ad groups and ads,
 * an ad group's ads. Each read is marked, so this family checks and keeps it (the gateway's own Smart+ projections of an
 * ad group read by campaign and an ad read by ad group keep other fields, for other families).
 */
export function tiktokSmartPlusDeletionSnapshots(
  p: CompiledRequest,
  stateRead: (path: string, query?: JsonObject) => CompiledRequest,
): CompiledRequest[] {
  const {kind, ids: list} = request(p);
  const read = (of: Kind, query: JsonObject, m: Marker): Read => {
    const r: Read = stateRead(getPath(of), {advertiser_id: p.accountId, ...query});
    r.action = 'tiktok_smart_plus_' + of + '_get';
    r.tiktokSmartPlusDeletion = m;
    return r;
  };
  return [
    read(kind, {filtering: {[ids[kind]]: list}, page_size: pageSize}, {role: 'targets', kind, ids: [...list]}),
    ...childKinds[kind].map(child =>
      read(
        child,
        {filtering: {[ids[kind]]: list}, page: 1, page_size: pageSize},
        {role: 'children', kind: child, parent: kind as 'campaign' | 'adgroup', ids: [...list]},
      ),
    ),
  ];
}
export function isTiktokSmartPlusDeletionRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!marker(p);
}
const listOf = (d: unknown): JsonObject[] => {
  if (!obj(d) || d.code !== 0 || !obj(d.data) || !Array.isArray(d.data.list))
    unverified('TikTok did not confirm success with its native list.');
  const rows = d.data.list as unknown[];
  if (!rows.every(obj)) unverified('A TikTok list row is malformed.');
  const info = obj(d.data.page_info) ? d.data.page_info : {},
    pages = Number(info.total_page ?? 1),
    // Lead review S4-4: a total that counts other rows than the page lists is incomplete too, as the Smart+ ad family's
    // count check (src/tiktok-smart-plus-ads.ts).
    counted =
      info.total_number === undefined || info.total_number === null || Number(info.total_number) === rows.length;
  if (!Number.isInteger(pages) || pages > 1 || !counted)
    unverified('TikTok listed more than one page; narrow the change.');
  return rows as JsonObject[];
};
/**
 * A deleted row's own secondary status, the only status that says the row itself is deleted (TikTok's Enumerations
 * appendix, read 2026-11-21). Other statuses end in _DELETE too and say something else: the filter aggregates
 * *_STATUS_NOT_DELETE, and the statuses of a row whose parent is deleted (ADGROUP_STATUS_CAMPAIGN_DELETE,
 * AD_STATUS_CAMPAIGN_DELETE, AD_STATUS_ADGROUP_DELETE). A row's operation_status is only ENABLE, DISABLE or FROZEN.
 */
const ownDeletion: Record<Kind, string> = {
  campaign: 'CAMPAIGN_STATUS_DELETE',
  adgroup: 'ADGROUP_STATUS_DELETE',
  ad: 'AD_STATUS_DELETE',
};
/**
 * The targets' read lists only requested targets, each once; a target it leaves out is refused by name later. One that
 * reads its own deletion status is refused as already deleted, not told to pause first (lead review S4-1): deleted
 * entities cannot change status, so a pause would be refused too.
 */
function targetRows(m: Extract<Marker, {role: 'targets'}>, d: unknown): JsonObject[] {
  const rows = listOf(d),
    seen = rows.map(r => String(r[idField[m.kind]] ?? ''));
  if (seen.some(id => !m.ids.includes(id)) || new Set(seen).size !== seen.length)
    mismatch('TikTok returned a Smart+ ' + label[m.kind] + ' other than the reviewed ones.');
  const gone = rows.find(r => r.secondary_status === ownDeletion[m.kind]);
  if (gone)
    mismatch(
      'Smart+ ' +
        label[m.kind] +
        ' ' +
        String(gone[idField[m.kind]]) +
        ' is already deleted (deleted entities cannot change).',
      {[idField[m.kind]]: String(gone[idField[m.kind]])},
    );
  return rows;
}
/**
 * Each child names its own ID and a reviewed parent. An ad read by its campaigns that does not show its campaign must
 * name an ad group, which the prerequisites find among the campaigns' ad groups.
 */
function childRows(m: Extract<Marker, {role: 'children'}>, d: unknown): JsonObject[] {
  const rows = listOf(d);
  for (const r of rows) {
    const parent = text(r[idField[m.parent]]);
    if (
      !numeric(String(r[idField[m.kind]] ?? '')) ||
      (parent === null
        ? !(m.kind === 'ad' && m.parent === 'campaign' && numeric(String(r.adgroup_id ?? '')))
        : !m.ids.includes(parent))
    )
      mismatch(
        'TikTok returned ' +
          (m.kind === 'ad' ? 'an ad' : 'an ad group') +
          ' outside the reviewed Smart+ ' +
          label[m.parent] +
          's.',
      );
  }
  return rows;
}
/**
 * A deletion read-back, as the classic one (src/tiktok-entity-status.ts): the target read with every status, deleted
 * included (`primary_status: STATUS_ALL`, documented for the three Smart+ gets), where a deleted target reads its own
 * *_STATUS_DELETE and any other listed row is not deleted; only when it is not listed there, its absence from the
 * default read (STATUS_NOT_DELETE) proves the deletion. A read that lists another entity proves nothing, and a refused
 * read stays unverified.
 */
export async function readTiktokSmartPlusDeletion(
  p: CompiledRequest,
  next: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const m = marker(p);
  if (m?.role !== 'deleted') return next(p);
  const plain = {...p, tiktokSmartPlusDeletion: undefined} as Read;
  const listed = async (primary: string) => {
    const r = await next({
      ...plain,
      query: {...plain.query, filtering: {[ids[m.kind]]: [m.id], primary_status: primary}},
    });
    if (r.status !== 200) unverified('TikTok did not return the Smart+ ' + label[m.kind] + '.');
    const rows = listOf(r.data);
    if (rows.length > 1 || rows.some(row => String(row[idField[m.kind]] ?? '') !== m.id))
      unverified('TikTok listed something other than Smart+ ' + label[m.kind] + ' ' + m.id + ' once.');
    return rows[0];
  };
  const answer = (s: JsonObject): TransportResult => ({
    status: 200,
    headers: {},
    data: {tiktok_smart_plus_deletion: s},
  });
  const row = await listed('STATUS_ALL');
  if (row)
    return answer({
      id: m.id,
      deleted: row.secondary_status === ownDeletion[m.kind],
      evidence: 'secondary_status',
      secondary_status: row.secondary_status ?? null,
    });
  return answer({id: m.id, deleted: !(await listed('STATUS_NOT_DELETE')), evidence: 'absent'});
}
export function validateTiktokSmartPlusDeletionState(
  read: CompiledRequest,
  r: TransportResult,
  gatewayChecks: (identity?: (read: CompiledRequest, result: TransportResult) => void) => void,
): void {
  const m = marker(read);
  if (m?.role === 'targets') {
    gatewayChecks(() => targetRows(m, r.data));
    return;
  }
  if (m?.role === 'children') {
    gatewayChecks(() => childRows(m, r.data));
    return;
  }
  const s = obj(r.data) ? r.data.tiktok_smart_plus_deletion : undefined;
  if (r.status !== 200 || !obj(s) || s.id !== m?.id || typeof s.deleted !== 'boolean')
    unverified('Missing the deletion read-back.');
}
/**
 * The targets keep the gateway's projection (their rows); children keep only what the review shows: identity,
 * parents, name and statuses, sorted. Applying it to a kept state returns that state, since execute normalizes the state
 * saved at prepare again.
 */
export function tiktokSmartPlusDeletionState(read: CompiledRequest, data: JsonObject, gatewayState: () => unknown) {
  const m = marker(read);
  if (m?.role !== 'children') return m?.role === 'targets' ? gatewayState() : data;
  if (obj(data.tiktok_smart_plus_deletion_children)) return data;
  return {
    tiktok_smart_plus_deletion_children: {
      kind: m.kind,
      rows: childRows(m, data)
        .map(r => ({
          id: String(r[idField[m.kind]]),
          ...(m.kind === 'ad' ? {adgroup_id: text(r.adgroup_id)} : {}),
          campaign_id: text(r.campaign_id),
          name: r[nameField[m.kind]] ?? null,
          operation_status: r.operation_status ?? null,
          secondary_status: r.secondary_status ?? null,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    },
  };
}

const rowsOf = (state: unknown[]) =>
  state.flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : [])) as JsonObject[];
const childrenOf = (state: unknown[], kind: Child) =>
  state
    .map(s =>
      obj(s) && obj(s.tiktok_smart_plus_deletion_children) ? s.tiktok_smart_plus_deletion_children : undefined,
    )
    .find(c => c?.kind === kind)?.rows as JsonObject[] | undefined;
/** A target may be deleted once it is paused: DISABLE, or FROZEN for a terminated ad. */
const paused = (kind: Kind, row: JsonObject) =>
  row.operation_status === 'DISABLE' || (kind === 'ad' && row.operation_status === 'FROZEN');

/**
 * At prepare and again at execute: every target is returned, every target is paused, and every ad of a campaign
 * deletion that does not show its campaign is in one of the campaign's ad groups.
 */
export function tiktokSmartPlusDeletionPrerequisites(p: CompiledRequest, state: unknown[]): void {
  const {kind, ids: list} = request(p),
    rows = rowsOf(state),
    on: {id: string; status: unknown}[] = [];
  for (const id of list) {
    const row = rows.find(r => String(r[idField[kind]]) === id);
    if (!row)
      mismatch(
        'Smart+ ' +
          label[kind] +
          ' ' +
          id +
          ' was not returned for the selected advertiser (deleted entities cannot change).',
        {[idField[kind]]: id},
      );
    if (!paused(kind, row)) on.push({id, status: row.operation_status ?? null});
  }
  // Lead review S4-2: the message names a documented operation_status (ENABLE, DISABLE, FROZEN), or OTHER for any other
  // value or none, so no provider value reaches it; details keep the value read.
  const named = (s: unknown) => (['ENABLE', 'DISABLE', 'FROZEN'].includes(s as string) ? (s as string) : 'OTHER');
  // QUESTIONS L12 (lead, 2026-11-20): pause first, as its own reviewed status change; then delete.
  if (on.length)
    throw new MirrorError(
      'TIKTOK_SMART_PLUS_DELETE_REQUIRES_PAUSE',
      'AMCP deletes an Upgraded Smart+ campaign, ad group or ad only once it is paused, and these are not: {targets}. Pause them first with the DISABLE prepare in details.next_call, then prepare the deletion again. Nothing was sent.',
      {
        field: ids[kind],
        [ids[kind]]: on.map(t => t.id),
        operation_status: Object.fromEntries(on.map(t => [t.id, t.status])),
        next_call: {
          tool: 'amcp_write',
          arguments: {
            action: 'prepare',
            gateway: p.gateway,
            arguments: {
              action: 'tiktok_smart_plus_' + kind + '_status_update',
              account_id: p.accountId,
              payload: {[ids[kind]]: on.map(t => t.id), operation_status: 'DISABLE'},
            },
          },
          meaning:
            'Pauses the listed targets, a reviewed status change of its own. Once it is verified, prepare this deletion again.',
        },
      },
      400,
      false,
      {targets: on.map(t => t.id + ' (' + named(t.status) + ')').join(', ')},
    );
  if (kind !== 'campaign') return;
  const groups = new Set((childrenOf(state, 'adgroup') ?? []).map(r => String(r.id)));
  for (const ad of childrenOf(state, 'ad') ?? [])
    if (ad.campaign_id == null && !groups.has(String(ad.adgroup_id)))
      mismatch('TikTok returned an ad outside the reviewed Smart+ campaigns.', {smart_plus_ad_id: String(ad.id)});
}

/**
 * What a deletion does, in TikTok's words (the status pages and the Enumerations appendix, read 2026-11-21): the
 * children of a deleted campaign or ad group are not deleted themselves; they can no longer change status and read
 * their parent's deletion. One sentence per kind, each with its Arabic in web/locales/ar.json.
 */
const deletionEffect: Record<Kind, string> = {
  campaign:
    'Deletes the listed Upgraded Smart+ campaigns. AMCP cannot undo a deletion. Their ad groups and ads are not deleted themselves: they stop delivering and can no longer change status; the ad groups read ADGROUP_STATUS_CAMPAIGN_DELETE and the ads AD_STATUS_CAMPAIGN_DELETE.',
  adgroup:
    'Deletes the listed Upgraded Smart+ ad groups. AMCP cannot undo a deletion. Their ads are not deleted themselves: they stop delivering and can no longer change status, and read AD_STATUS_ADGROUP_DELETE.',
  ad: 'Deletes the listed Upgraded Smart+ ads. AMCP cannot undo a deletion.',
};
/** What the deletion does to each target, and which children go with them and which of those are on. */
export function tiktokSmartPlusDeletionImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const {kind, ids: list} = request(p),
    rows = rowsOf(state);
  const changes = list.map(id => {
    const row = rows.find(r => String(r[idField[kind]]) === id);
    if (!row) mismatch('Smart+ ' + label[kind] + ' ' + id + ' was not returned for the selected advertiser.');
    return {
      [idField[kind]]: id,
      name: row[nameField[kind]] ?? null,
      before: row.operation_status ?? null,
      after: 'DELETE',
      unchanged: false,
    };
  });
  const children = childKinds[kind].map(child => {
    const found = childrenOf(state, child);
    if (!found) unverified('Missing the Smart+ ' + label[child] + 's under the ' + label[kind] + 's to delete.');
    return {
      kind: child,
      count: found.length,
      enabled: found.filter(r => r.operation_status === 'ENABLE'),
      all: found.map(r => r.id),
    };
  });
  return {
    provider: 'tiktok',
    scope: 'smart_plus_' + kind + '_deletion',
    operation: 'delete',
    may_affect_serving: true,
    changes,
    effect: deletionEffect[kind],
    children,
    enabled_children: children.reduce((n, c) => n + c.enabled.length, 0),
    verification:
      'Reads each Upgraded Smart+ ' +
      label[kind] +
      ' again with every status (STATUS_ALL) and expects its own ' +
      ownDeletion[kind] +
      ', or, when it is not listed there, its absence from the default read.',
    source: tiktokSmartPlusStatusSource,
  };
}

/**
 * The status family's receipt rule with DELETE: campaign and ad group answers list every ID with status DELETE and an
 * empty error_list; ad answers return every ID and status DELETE. Anything less is a partial outcome.
 */
export function tiktokSmartPlusDeletionOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const {kind, ids: list} = request(p),
    d = responseData(r);
  if (d.code !== 0) return false;
  const data = object(d.data);
  if (kind === 'ad')
    return (
      Array.isArray(data.smart_plus_ad_ids) &&
      data.smart_plus_ad_ids.length === list.length &&
      list.every(id => data.smart_plus_ad_ids.map(String).includes(id)) &&
      data.status === 'DELETE'
    );
  const done = data[kind + '_list'],
    errors = data.error_list;
  return (
    Array.isArray(done) &&
    Array.isArray(errors) &&
    errors.length === 0 &&
    done.length === list.length &&
    list.every(id => done.some((row: JsonObject) => String(row?.[idField[kind]]) === id && row.status === 'DELETE'))
  );
}

/** One read per target, expecting it deleted. */
export function tiktokSmartPlusDeletionVerification(
  p: CompiledRequest,
  _result: JsonObject,
  _before: unknown[],
  verificationRead: (path: string, query?: JsonObject) => CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const {kind, ids: list} = request(p);
  return list.map(id => {
    const read: Read = {
      ...verificationRead(getPath(kind), {
        advertiser_id: p.accountId,
        filtering: {[ids[kind]]: [id]},
        page_size: pageSize,
      }),
      action: 'tiktok_smart_plus_' + kind + '_get',
      tiktokSmartPlusDeletion: {role: 'deleted', kind, id},
    };
    return {read, expected: {id, deleted: true}, id};
  });
}
export function tiktokSmartPlusDeletionObserved(
  read: CompiledRequest,
  data: JsonObject,
  gatewayObserved: () => JsonObject,
) {
  if (marker(read)?.role !== 'deleted') return gatewayObserved();
  const s = obj(data.tiktok_smart_plus_deletion) ? data.tiktok_smart_plus_deletion : {};
  return {id: s.id ?? null, deleted: s.deleted ?? null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokSmartPlusDeletionFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_smart_plus_deletions',
  files: ['src/tiktok-smart-plus-deletions.ts', ['tests/tiktok-smart-plus-deletions.test.mjs']],
  kind: tiktokSmartPlusDeletionKind,
  assert: (plan, gatewayChecks) => {
    assertNoMethodOverride(plan);
    gatewayChecks();
    assertTiktokSmartPlusDeletion(plan);
  },
  snapshots: tiktokSmartPlusDeletionSnapshots,
  isRead: isTiktokSmartPlusDeletionRead,
  reader: readTiktokSmartPlusDeletion,
  validateState: validateTiktokSmartPlusDeletionState,
  snapshotState: tiktokSmartPlusDeletionState,
  prerequisites: tiktokSmartPlusDeletionPrerequisites,
  impact: tiktokSmartPlusDeletionImpact,
  outcome: tiktokSmartPlusDeletionOutcome,
  verification: tiktokSmartPlusDeletionVerification,
  observed: tiktokSmartPlusDeletionObserved,
  // A deletion stops delivery and spends nothing, so the budget/bid/status text match does not apply.
  exemptFromSpendTextMatch: true,
  // Every request this family claims deletes: allow_deletion:false, the destructive tier and website approval apply.
  destructive: () => true,
});
