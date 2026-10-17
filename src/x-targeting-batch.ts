import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {changedStateFields, normalizeReviewState} from './review-state-core.js';
import {sha256, stable} from './security.js';
import {xAudienceCriteriaTypes} from './x-audience-estimate.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

type Read = (p: CompiledRequest) => Promise<TransportResult>;
const native = /^[a-z0-9]{1,32}$/,
  userId = /^[1-9][0-9]{0,24}$/;
const types = new Set(xAudienceCriteriaTypes.filter(t => t !== 'TV_SHOW'));
const privateUser = new Set(['FOLLOWERS_OF_USER', 'USER_ENGAGEMENT', 'USER_ENGAGEMENT_LOOKALIKE']);
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 1024): v is string =>
  typeof v === 'string' && !!v.trim() && [...v].length <= max && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(v);
const fail = (message: string, code = 'X_TARGETING_STATE_UNVERIFIED'): never => {
  throw new MirrorError(code, message);
};
const input = (message: string): never => fail(message, 'INVALID_X_TARGETING_BATCH');
const operations = (p: CompiledRequest) => p.body as JsonObject[];
const scalar = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : undefined;
export const xTargetingBatchRoute = (p: CompiledRequest): boolean =>
  p.gateway === 'x_ads_native_action' &&
  p.method === 'POST' &&
  !p.specialTransport &&
  (!p.origin || p.origin === 'https://ads-api.x.com') &&
  /^\/12\/batch\/accounts\/[a-z0-9]{1,32}\/targeting_criteria$/.test(p.path);
export const xTargetingBatchDeletes = (p: CompiledRequest): boolean =>
  xTargetingBatchRoute(p) && Array.isArray(p.body) && operations(p).some(o => o?.operation_type === 'Delete');

export function assertXTargetingBatch(p: CompiledRequest) {
  if (!xTargetingBatchRoute(p)) return;
  if (p.path.split('/')[4] !== p.accountId || Object.keys(p.query).length || Object.keys(p.headers).length)
    input('Use the selected account, native JSON operations and no query/header overrides.');
  if (
    !Array.isArray(p.body) ||
    !p.body.length ||
    p.body.length > 100 ||
    Buffer.byteLength(JSON.stringify(p.body)) > 192 * 1024
  )
    input('Use 1–100 targeting operations within 192 KiB. These are AMCP bounds; X documents a 500-operation maximum.');
  const seen = new Set<string>(),
    parents = new Set<string>();
  for (const o of operations(p)) {
    if (!object(o) || Object.keys(o).some(k => !['operation_type', 'params'].includes(k)) || !object(o.params))
      input('Each operation requires operation_type and its native params object.');
    const b = o.params;
    let key: string;
    if (o.operation_type === 'Delete') {
      if (
        Object.keys(b).length !== 1 ||
        typeof b.targeting_criterion_id !== 'string' ||
        !native.test(b.targeting_criterion_id)
      )
        input('Delete requires only the exact discovered targeting_criterion_id.');
      key = 'delete:' + b.targeting_criterion_id;
    } else if (o.operation_type === 'Create') {
      if (
        Object.keys(b).some(k => !['line_item_id', 'targeting_type', 'targeting_value', 'operator_type'].includes(k)) ||
        typeof b.line_item_id !== 'string' ||
        !native.test(b.line_item_id) ||
        !types.has(b.targeting_type) ||
        !text(b.targeting_value) ||
        (b.operator_type !== undefined && !['EQ', 'NE'].includes(b.operator_type))
      )
        input(
          'Create requires a native parent/type/string value and optional EQ/NE. TV_SHOW locale checks, APP_LIST/TAP, preroll-only types and comparison operators need separate contracts.',
        );
      if (
        (privateUser.has(b.targeting_type) || b.targeting_type === 'SIMILAR_TO_FOLLOWERS_OF_USER') &&
        !userId.test(b.targeting_value)
      )
        input('User targeting requires the exact decimal string ID.');
      if (
        /^(?:CUSTOM_AUDIENCE(?:_EXPANDED)?|CAMPAIGN_ENGAGEMENT(?:_LOOKALIKE)?)$/.test(b.targeting_type) &&
        !native.test(b.targeting_value)
      )
        input('Use an exact account-owned custom-audience or campaign ID.');
      if (b.targeting_type === 'CUSTOM_AUDIENCE_EXPANDED' && b.operator_type === 'NE')
        input('X does not support excluding custom-audience lookalikes.');
      parents.add(b.line_item_id);
      key = 'create:' + b.line_item_id + ':' + b.targeting_type + ':' + b.targeting_value;
    } else input('The native batch contract supports Create and Delete, not Update.');
    if (seen.has(key!)) input('Duplicate or contradictory operations cannot appear in one review.');
    seen.add(key!);
  }
  if (parents.size > 20) input('A review can affect at most 20 line items.');
}
function readPlan(p: CompiledRequest, suffix = '', query: JsonObject = {}): CompiledRequest {
  return {
    ...p,
    action: 'AMCP_X_TARGETING_READ',
    path: '/12/accounts/' + p.accountId + suffix,
    method: 'GET',
    query,
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
  };
}
export const xTargetingBatchSnapshots = (p: CompiledRequest): CompiledRequest[] => [
  readPlan(p),
  ...operations(p)
    .filter(o => o.operation_type === 'Delete')
    .map(o => readPlan(p, '/targeting_criteria/' + o.params.targeting_criterion_id)),
];
function projection(r: JsonObject): JsonObject {
  // These resource fields are provider observations. Preserve unknown configuration,
  // including unknown ordered arrays; only collection identity order is normalized.
  const {servable, reasons_not_servable, localized_name, ...configuration} = r;
  return normalizeReviewState(configuration) as JsonObject;
}
function criterion(raw: unknown, account: string): JsonObject {
  if (
    !object(raw) ||
    typeof raw.id !== 'string' ||
    !native.test(raw.id) ||
    typeof raw.line_item_id !== 'string' ||
    !native.test(raw.line_item_id) ||
    typeof raw.targeting_type !== 'string' ||
    !text(scalar(raw.targeting_value)) ||
    typeof raw.deleted !== 'boolean' ||
    (raw.account_id !== undefined && raw.account_id !== account) ||
    (raw.operator_type !== undefined && !['EQ', 'NE', 'GTE', 'LT'].includes(raw.operator_type)) ||
    raw.error ||
    raw.errors
  )
    fail('X did not return an exact native targeting criterion.');
  const {name, raw_negated, raw_targeting_value, raw_targeting_type, raw_operator_type, ...row} = raw as JsonObject;
  return projection({...row, targeting_value: scalar(row.targeting_value), operator_type: row.operator_type ?? 'EQ'});
}
const core = (r: JsonObject) =>
  Object.fromEntries(
    ['id', 'line_item_id', 'targeting_type', 'targeting_value', 'operator_type', 'deleted'].map(k => [k, r[k]]),
  );
const key = (r: JsonObject) => r.line_item_id + ':' + r.targeting_type + ':' + r.targeting_value;
function errorEnvelope(d: JsonObject) {
  return (
    d.error ||
    (d.errors !== undefined && (!Array.isArray(d.errors) || d.errors.length)) ||
    (d.operation_errors !== undefined &&
      (!Array.isArray(d.operation_errors) || d.operation_errors.some((e: unknown) => e !== null))) ||
    d.success === false ||
    ['partial', 'partial_failure', 'partialFailure', 'truncated'].some(k => d[k] !== undefined && d[k] !== false)
  );
}
function reader(p: CompiledRequest, send: Read) {
  const start = performance.now();
  let calls = 0,
    bytes = 0;
  const data = async (suffix: string, query: JsonObject = {}) => {
    if (++calls > 320 || performance.now() - start >= 60000)
      fail('Targeting discovery exceeded its 320-request or 60-second bound.', 'X_TARGETING_LIMIT');
    const r = await send({...readPlan(p, suffix, query), xTargetingDeadline: start + 60000}),
      d = r.data;
    bytes += Buffer.byteLength(JSON.stringify(d) ?? '');
    if (bytes > 8 * 1024 * 1024 || performance.now() - start >= 60000)
      fail('Targeting discovery exceeded its 8 MiB or 60-second bound.', 'X_TARGETING_LIMIT');
    if (
      r.status !== 200 ||
      !object(d) ||
      errorEnvelope(d) ||
      d.request?.params?.account_id !== p.accountId ||
      ['next', 'next_token', 'next_page_token', 'nextLink', 'paging', 'pagination'].some(k => d[k] != null)
    )
      fail('X returned a failed, partial or unscoped targeting dependency.');
    return d as JsonObject;
  };
  const single = async (suffix: string, id: string) => {
    const d = await data(suffix),
      r = d.data;
    if (
      (d.next_cursor != null && d.next_cursor !== 0 && d.next_cursor !== '0') ||
      !object(r) ||
      r.id !== id ||
      r.deleted !== false ||
      (r.account_id !== undefined && r.account_id !== p.accountId) ||
      r.error ||
      r.errors
    )
      fail('X returned a missing, deleted or foreign targeting dependency.');
    return projection(r);
  };
  const list = async (suffix: string, query: JsonObject = {}) => {
    const rows: JsonObject[] = [],
      tokens = new Set<string>(),
      ids = new Set<string>();
    let cursor: string | undefined, total: number | undefined;
    for (let page = 0; page < 10; page++) {
      const d = await data(suffix, {count: 1000, ...query, ...(cursor ? {cursor} : {})});
      if (!Array.isArray(d.data) || d.data.length > 1000)
        fail('X did not return a bounded native targeting collection.');
      for (const row of d.data) {
        if (
          !object(row) ||
          typeof row.id !== 'string' ||
          !native.test(row.id) ||
          ids.has(row.id) ||
          (row.account_id !== undefined && row.account_id !== p.accountId) ||
          row.error ||
          row.errors
        )
          fail('X returned duplicate or foreign collection identities.');
        ids.add(row.id);
        rows.push(row);
      }
      if (d.total_count !== undefined) {
        if (
          !Number.isSafeInteger(d.total_count) ||
          d.total_count < 0 ||
          (total !== undefined && total !== d.total_count)
        )
          fail('X collection totals are inconsistent.');
        total = d.total_count;
      }
      if (d.next_cursor == null || d.next_cursor === 0 || d.next_cursor === '0') {
        if (total !== undefined && total !== rows.length) fail('X collection totals do not reconcile.');
        return rows;
      }
      if (!text(d.next_cursor, 2048) || tokens.has(d.next_cursor) || !d.data.length)
        fail('X returned an invalid or repeated collection cursor.');
      tokens.add(d.next_cursor);
      cursor = d.next_cursor;
    }
    return fail('Targeting discovery exceeded its complete 10000-row collection bound.', 'X_TARGETING_LIMIT');
  };
  return {single, list};
}
type Reader = ReturnType<typeof reader>;
async function references(read: Reader, rows: JsonObject[]) {
  const refs = new Set<string>(),
    users = new Set<string>(),
    out: JsonObject = {resources: [], users: []};
  for (const c of rows) {
    if (/^CUSTOM_AUDIENCE(?:_EXPANDED)?$/.test(c.targeting_type)) refs.add('/custom_audiences/' + c.targeting_value);
    if (/^CAMPAIGN_ENGAGEMENT(?:_LOOKALIKE)?$/.test(c.targeting_type)) refs.add('/campaigns/' + c.targeting_value);
    if (privateUser.has(c.targeting_type)) users.add(c.targeting_value);
  }
  if (refs.size + users.size > 25)
    fail('A targeting review can reference at most 25 private audiences, campaigns and authors.', 'X_TARGETING_LIMIT');
  for (const path of [...refs].sort()) {
    const r = await read.single(path, path.split('/').at(-1)!);
    if (path.startsWith('/custom_audiences/') && r.targetable !== true)
      fail('The exact custom audience must currently be targetable.', 'RESOURCE_SCOPE_REQUIRED');
    // Reach estimates fluctuate without an advertiser configuration edit. Keep
    // eligibility, permission/owner metadata and all unknown definition fields.
    const {audience_size, ...configuration} = r;
    out.resources.push({path, ...(path.startsWith('/custom_audiences/') ? configuration : r)});
  }
  if (users.size) {
    const rows = await read.list('/promotable_users'),
      byUser = new Map<string, JsonObject>();
    for (const r of rows) {
      if (
        typeof r.user_id !== 'string' ||
        !userId.test(r.user_id) ||
        typeof r.deleted !== 'boolean' ||
        !['FULL', 'RETWEETS_ONLY'].includes(r.promotable_user_type)
      )
        fail('The promotable-user collection is incomplete.');
      if (!r.deleted && r.promotable_user_type === 'FULL' && users.has(r.user_id)) {
        if (byUser.has(r.user_id)) fail('The selected author is ambiguous.');
        byUser.set(r.user_id, projection(r));
      }
    }
    for (const id of [...users].sort()) {
      if (!byUser.has(id))
        fail('Own-content targeting requires the exact FULL promotable author.', 'RESOURCE_SCOPE_REQUIRED');
      out.users.push(byUser.get(id));
    }
  }
  return out;
}
function desired(p: CompiledRequest, rows: JsonObject[], requireTargets = true): JsonObject[] {
  const deleted = new Set(
    operations(p)
      .filter(o => o.operation_type === 'Delete')
      .map(o => o.params.targeting_criterion_id),
  );
  if (requireTargets && [...deleted].some(id => !rows.some(r => r.id === id)))
    fail('A requested deletion is not in the complete current targeting set.');
  const after = rows.filter(r => !deleted.has(r.id)).map(r => ({...r}));
  operations(p).forEach((o, i) => {
    if (o.operation_type === 'Create')
      after.push({...o.params, id: 'amcp' + i, operator_type: o.params.operator_type ?? 'EQ', deleted: false});
  });
  const keys = new Set<string>(),
    ages = new Set<string>(),
    custom = new Map<string, Set<string>>();
  for (const r of after) {
    if (keys.has(key(r))) input('The projected set duplicates or both includes and excludes a criterion.');
    keys.add(key(r));
    if (r.targeting_type === 'AGE') {
      if (ages.has(r.line_item_id)) input('X supports one age bucket per line item.');
      ages.add(r.line_item_id);
    }
    if (/^CUSTOM_AUDIENCE(?:_EXPANDED)?$/.test(r.targeting_type)) {
      const types = custom.get(r.line_item_id) ?? new Set<string>();
      types.add(r.targeting_type);
      custom.set(r.line_item_id, types);
      if (types.size > 1) input('X does not support custom audiences and their lookalikes on the same line item.');
    }
  }
  return after;
}
async function snapshot(p: CompiledRequest, read: Reader, parents: string[], preparation: boolean) {
  const account = await read.single('', p.accountId!);
  if (typeof account.currency !== 'string' || !/^[A-Z]{3}$/.test(account.currency))
    fail('X account currency is missing.');
  const lines: JsonObject[] = [],
    campaigns: JsonObject[] = [],
    campaignIds = new Set<string>();
  for (const id of parents) {
    const line = await read.single('/line_items/' + id, id);
    if (
      typeof line.campaign_id !== 'string' ||
      !native.test(line.campaign_id) ||
      !['PAUSED', 'ACTIVE'].includes(line.entity_status)
    )
      fail('The exact line item and parent campaign are required.');
    if (preparation && line.entity_status !== 'PAUSED')
      fail('Pause every affected line item before reviewing an atomic audience change.', 'TARGETING_PARENT_NOT_PAUSED');
    lines.push(line);
    campaignIds.add(line.campaign_id);
  }
  for (const id of [...campaignIds].sort()) {
    const campaign = await read.single('/campaigns/' + id, id);
    if (campaign.currency !== undefined && campaign.currency !== account.currency)
      fail('The campaign and account currency disagree.');
    campaigns.push(campaign);
  }
  const rows = (await read.list('/targeting_criteria', {line_item_ids: parents.join(','), with_deleted: false})).map(
    r => criterion(r, p.accountId!),
  );
  if (rows.some(r => !parents.includes(r.line_item_id) || r.deleted))
    fail('The targeting collection escaped its requested line items.');
  rows.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return {
    account,
    lines,
    campaigns,
    criteria: rows,
    references: await references(read, preparation ? desired(p, rows) : rows),
  };
}
export async function readXTargetingBatchState(p: CompiledRequest, send: Read): Promise<unknown[]> {
  assertXTargetingBatch(p);
  const read = reader(p, send),
    parents = new Set(
      operations(p)
        .filter(o => o.operation_type === 'Create')
        .map(o => o.params.line_item_id),
    ),
    resolved: JsonObject[] = [];
  for (const o of operations(p).filter(o => o.operation_type === 'Delete')) {
    const row = criterion(
      await read.single('/targeting_criteria/' + o.params.targeting_criterion_id, o.params.targeting_criterion_id),
      p.accountId!,
    );
    resolved.push(row);
    parents.add(row.line_item_id);
  }
  if (parents.size > 20) input('A review can affect at most 20 line items.');
  const ids = [...parents].sort(),
    a = await snapshot(p, read, ids, true),
    b = await snapshot(p, read, ids, true);
  if (resolved.some(row => stable(row) !== stable(a.criteria.find(r => r.id === row.id))) || stable(a) !== stable(b))
    fail('The audience or its dependencies changed during preparation. Read and review again.');
  return [a];
}
export function xTargetingBatchOutcome(p: CompiledRequest, r: TransportResult, before: unknown[]): boolean {
  try {
    const d = r.data,
      s = before[0] as JsonObject,
      ops = operations(p);
    if (
      r.status < 200 ||
      r.status >= 300 ||
      !object(d) ||
      errorEnvelope(d) ||
      !Array.isArray(d.data) ||
      d.data.length !== ops.length ||
      !Array.isArray(d.request) ||
      d.request.length !== ops.length ||
      d.next_cursor != null
    )
      return false;
    const ids = new Set<string>();
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!,
        echo = d.request[i],
        row = criterion(d.data[i], p.accountId!);
      if (
        !object(echo) ||
        echo.operation_type !== op.operation_type ||
        !object(echo.params) ||
        echo.params.account_id !== p.accountId ||
        Object.entries(op.params).some(([k, v]) => stable(echo.params[k]) !== stable(v)) ||
        ids.has(row.id)
      )
        return false;
      ids.add(row.id);
      if (op.operation_type === 'Create') {
        if (
          s.criteria.some((old: JsonObject) => old.id === row.id) ||
          row.deleted ||
          row.line_item_id !== op.params.line_item_id ||
          row.targeting_type !== op.params.targeting_type ||
          row.targeting_value !== op.params.targeting_value ||
          row.operator_type !== (op.params.operator_type ?? 'EQ')
        )
          return false;
      } else {
        const old = s.criteria.find((v: JsonObject) => v.id === op.params.targeting_criterion_id);
        if (!old || stable(core(row)) !== stable({...core(old), deleted: true})) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
export async function verifyXTargetingBatch(p: CompiledRequest, result: JsonObject, before: unknown[], send: Read) {
  const s = before[0] as JsonObject,
    read = reader(p, send),
    parents = s.lines.map((l: JsonObject) => l.id);
  const a = await snapshot(p, read, parents, false),
    b = await snapshot(p, read, parents, false);
  if (stable(a) !== stable(b)) fail('The audience changed during complete read-back; no mutation is repeated.');
  const removed = new Set(
    operations(p)
      .filter(o => o.operation_type === 'Delete')
      .map(o => o.params.targeting_criterion_id),
  );
  const created = new Map<string, JsonObject>();
  operations(p).forEach((o, i) => {
    if (o.operation_type === 'Create') {
      const row = criterion(result.data.data[i], p.accountId!);
      created.set(row.id, core(row));
    }
  });
  const expectedRows = [...s.criteria.filter((r: JsonObject) => !removed.has(r.id)), ...created.values()].sort((a, b) =>
    a.id.localeCompare(b.id, 'en'),
  );
  const actualRows = a.criteria.map(r => (created.has(r.id) ? core(r) : r));
  const expected = {
    account: s.account,
    lines: s.lines,
    campaigns: s.campaigns,
    criteria: expectedRows,
    references: s.references,
  };
  const actual = {...a, criteria: actualRows},
    changed = changedStateFields(expected, actual),
    status = changed.length ? 'inconclusive' : 'verified';
  return {
    status,
    checks: [
      {
        status,
        verification_scope: 'complete_targeting_membership_and_parent_configuration',
        line_item_ids: parents,
        changed_fields: changed,
        expected_hash: sha256(stable(expected)),
        actual_hash: sha256(stable(actual)),
      },
    ],
  };
}
export const xTargetingBatchImpact = () => ({
  provider: 'x',
  workflow: 'atomic_targeting_batch',
  may_affect_serving: false,
  effect:
    'Creates and removes audience criteria together on explicitly paused line items. It does not activate them or change monetary limits.',
  limits:
    '100 operations, 20 line items, 25 private references, 10000 criteria per collection, 320 reads, 8 MiB and 60 seconds. X documents a native maximum of 500; larger reviews require a separate capacity qualification.',
  verification:
    'Complete before/after membership, parent campaigns and current private-reference eligibility. X has no conditional write for the read snapshot; external concurrent activation cannot be made atomic with this request.',
  recovery:
    'Retain the original review/key. Missing, partial, foreign or lost receipts never authorize another mutation. Read back the original result and prepare any correction separately.',
});

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xTargetingBatchRouteFamily: ReviewedFamily = {
  name: 'x_targeting_batch',
  files: ['src/x-targeting-batch.ts', ['tests/x-targeting-batch.test.mjs']],
  kind: xTargetingBatchRoute,
  assert: plan => assertXTargetingBatch(plan),
  snapshots: xTargetingBatchSnapshots,
  state: (plan, readers) =>
    readXTargetingBatchState(
      plan,
      readers.guarded(
        'Targeting dependencies must remain read-only.',
        readers.sameLogin('The selected login changed during targeting checks.'),
      ).read,
    ),
  impact: () => xTargetingBatchImpact(),
  outcome: xTargetingBatchOutcome,
  verify: (plan, v) =>
    verifyXTargetingBatch(
      plan,
      v.result,
      v.state,
      v.guarded('Targeting verification must remain read-only.', {
        binding: v.sameLogin('The selected login changed during targeting verification.'),
      }),
    ).then(o => ({status: o.status, checks: o.checks})),
  verifyEveryTime: true,
  destructive: plan => !!xTargetingBatchDeletes(plan),
};
