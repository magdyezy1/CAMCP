import {responseData, assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';

/**
 * Pausing and enabling Upgraded Smart+ campaigns, ad groups and ads, per API for Business v1.3 "Update the
 * operation statuses of Upgraded Smart+ Campaigns / Ad Groups / Ads" and the matching "Get Upgraded Smart+"
 * endpoints (checked 2026-09-26). Each call takes 1–20 IDs; campaign and ad group calls report per-ID successes and
 * errors, ad calls return the updated IDs and one status. Deletion and SKAN postback windows are outside this contract.
 */
type Kind = 'campaign' | 'adgroup' | 'ad';
const ids: Record<Kind, string> = {campaign: 'campaign_ids', adgroup: 'adgroup_ids', ad: 'smart_plus_ad_ids'};
const idField: Record<Kind, string> = {campaign: 'campaign_id', adgroup: 'adgroup_id', ad: 'smart_plus_ad_id'};
export const tiktokSmartPlusStatusSource =
  'https://business-api.tiktok.com/portal/docs/upgraded-smart+-upgraded-smart+/v1.3';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown) => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);

/** The three Smart+ status routes, whatever the body: the status family and the deletion family share them. */
export function tiktokSmartPlusStatusRoute(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== 'tiktok_native_action' || p.method !== 'POST') return;
  return /^\/v1\.3\/smart_plus\/(campaign|adgroup|ad)\/status\/update\/$/.exec(p.path)?.[1] as Kind | undefined;
}
/**
 * A body with `operation_status: DELETE` is not this family's: it belongs to tiktok_smart_plus_deletions
 * (src/tiktok-smart-plus-deletions.ts; r25-m4-smartdelete, owner O3 2026-11-20), so one request has one family.
 */
export function tiktokSmartPlusStatusKind(p: CompiledRequest): Kind | undefined {
  const kind = tiktokSmartPlusStatusRoute(p);
  return kind && object(p.body).operation_status !== 'DELETE' ? kind : undefined;
}
const getPath = (kind: Kind) => '/v1.3/smart_plus/' + kind + '/get/';
function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_STATUS', message, {field});
}
function request(plan: CompiledRequest) {
  const kind = tiktokSmartPlusStatusKind(plan)!,
    b = plan.body as JsonObject;
  return {kind, ids: b[ids[kind]] as string[], status: b.operation_status as 'ENABLE' | 'DISABLE'};
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSmartPlusStatus(plan: CompiledRequest, body: JsonObject): void {
  const kind = tiktokSmartPlusStatusKind(plan)!,
    field = ids[kind];
  const extra = Object.keys(body).find(k => !['advertiser_id', field, 'operation_status'].includes(k));
  if (extra)
    invalid(
      extra,
      '"' +
        extra +
        '" is outside the qualified Smart+ status contract' +
        (extra === 'postback_window_mode' ? '; SKAN 4.0 postback windows need their own review.' : '.'),
    );
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  const list = body[field];
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.length > 20 ||
    !list.every(numeric) ||
    new Set(list).size !== list.length
  )
    invalid(field, field + ' must list 1 to 20 unique numeric IDs.');
  // A DELETE never reaches this assert: the deletion family claims it (tiktokSmartPlusStatusKind).
  if (!['ENABLE', 'DISABLE'].includes(body.operation_status))
    invalid('operation_status', 'operation_status must be ENABLE or DISABLE.');
}

export function tiktokSmartPlusStatusRead(plan: CompiledRequest) {
  const {kind, ids: list} = request(plan);
  return {
    path: getPath(kind),
    query: {advertiser_id: plan.accountId, filtering: {[ids[kind]]: list}, page_size: 100},
    action: 'tiktok_smart_plus_' + kind + '_get',
  };
}
/** The Smart+ get reads filtered by ID must return exactly the requested entities. */
export function validateTiktokSmartPlusState(
  read: CompiledRequest,
  data: JsonObject,
  sameIds: (actual: unknown[], expected: unknown[]) => void,
): boolean {
  const kind = /^\/v1\.3\/smart_plus\/(campaign|adgroup|ad)\/get\/$/.exec(read.path)?.[1] as Kind | undefined;
  if (!kind || read.gateway !== 'tiktok_native_action') return false;
  if (data.code !== 0 || !Array.isArray(data.data?.list))
    throw new MirrorError('STATE_READ_FAILED', 'TikTok Smart+ state must confirm success and contain its native list.');
  sameIds(
    data.data.list.map((r: JsonObject) => r?.[idField[kind]]),
    (read.query.filtering as JsonObject)?.[ids[kind]] as unknown[],
  );
  return true;
}

const rowsOf = (state: unknown[]) =>
  state.flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : [])) as JsonObject[];
/** Against the normalized review state: every entity exists, and a terminated (FROZEN) ad is never enabled. */
export function tiktokSmartPlusStatusImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const {kind, ids: list, status} = request(plan),
    rows = rowsOf(state);
  const changes = list.map(id => {
    const row = rows.find(r => String(r[idField[kind]]) === id);
    if (!row)
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'Smart+ ' +
          kind +
          ' ' +
          id +
          ' was not returned for the selected advertiser (deleted entities cannot change status).',
        {[idField[kind]]: id},
      );
    if (status === 'ENABLE' && row.operation_status === 'FROZEN')
      invalid(ids[kind], 'Smart+ ad ' + id + ' is FROZEN (terminated) and cannot be enabled.');
    return {
      [idField[kind]]: id,
      name: row[kind === 'ad' ? 'ad_name' : kind + '_name'] ?? null,
      before: row.operation_status ?? null,
      after: status,
      unchanged: row.operation_status === status,
      // A campaign with campaign budget optimization off (every Search campaign: S2-1) carries no budget that starts its spending: its ad groups'
      // budgets do. The row shows what the campaign itself has, so that the person who turns it on is told where the budget is.
      ...(kind === 'campaign' && status === 'ENABLE' && row.budget_optimize_on === false
        ? {
            budget: {
              campaign_budget_optimization: false,
              campaign_budget_mode: row.budget_mode ?? null,
              campaign_budget: row.budget ?? null,
            },
          }
        : {}),
    };
  });
  const adgroupBudgets = changes.some(c => c.budget !== undefined);
  return {
    provider: 'tiktok',
    scope: 'smart_plus_' + kind + '_status',
    may_affect_serving: true,
    effect:
      status === 'ENABLE'
        ? 'Turns the listed Upgraded Smart+ ' +
          kind +
          's on. They can deliver and spend if their parents are on and their budgets allow.'
        : 'Turns the listed Upgraded Smart+ ' + kind + 's off. Delivery stops; nothing is deleted.',
    ...(adgroupBudgets
      ? {
          budget_meaning:
            'A campaign with campaign budget optimization off has no budget of its own that decides its spending (at most a limit caps the total of its ad groups): the budget of each of its ad groups is what starts spending.',
        }
      : {}),
    changes,
    source: tiktokSmartPlusStatusSource,
  };
}

/** Campaign and ad group receipts list every success and no errors; ad receipts return every ID and the new status. */
export function tiktokSmartPlusStatusOutcome(plan: CompiledRequest, d: JsonObject): boolean {
  const {kind, ids: list, status} = request(plan),
    data = obj(d.data) ? d.data : {};
  if (d.code !== 0) return false;
  if (kind === 'ad')
    return (
      Array.isArray(data.smart_plus_ad_ids) &&
      data.smart_plus_ad_ids.length === list.length &&
      list.every(id => data.smart_plus_ad_ids.map(String).includes(id)) &&
      data.status === status
    );
  const done = data[kind + '_list'],
    errors = data.error_list;
  return (
    Array.isArray(done) &&
    Array.isArray(errors) &&
    errors.length === 0 &&
    done.length === list.length &&
    list.every(id => done.some((r: JsonObject) => String(r?.[idField[kind]]) === id && r.status === status))
  );
}

/** One read per entity confirms its operation status. */
export function tiktokSmartPlusStatusVerification(
  plan: CompiledRequest,
): {path: string; query: JsonObject; expected: JsonObject; id: string; action: string}[] {
  const {kind, ids: list, status} = request(plan);
  return list.map(id => ({
    path: getPath(kind),
    query: {advertiser_id: plan.accountId, filtering: {[ids[kind]]: [id]}, page_size: 100},
    expected: {[idField[kind]]: id, operation_status: status},
    id,
    action: 'tiktok_smart_plus_' + kind + '_get',
  }));
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokSmartPlusStatusFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_smart_plus_status',
  files: ['src/tiktok-smart-plus-status.ts', ['tests/tiktok-smart-plus-status.test.mjs']],
  kind: tiktokSmartPlusStatusKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokSmartPlusStatus(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) => {
    const r = tiktokSmartPlusStatusRead(plan),
      read = stateRead(r.path, r.query);
    read.action = r.action;
    return [read];
  },
  impact: tiktokSmartPlusStatusImpact,
  outcome: (plan, result) => {
    const d = responseData(result);
    return d.code === 0 && tiktokSmartPlusStatusOutcome(plan, d);
  },
  verification: (plan, result, before, verificationRead) =>
    tiktokSmartPlusStatusVerification(plan).map(v => ({
      read: {...verificationRead(v.path, v.query), action: v.action},
      expected: v.expected,
      id: v.id,
    })),
});
