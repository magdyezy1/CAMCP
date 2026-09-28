import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * TikTok change log download tasks, per API for Business v1.3 "Create a change log download task" and "Check the status of
 * a download task" (checked 2026-09-28). POST /v1.3/changelog/task/create/ takes advertiser_id, start_time and end_time
 * ("YYYY-MM-DD HH:MM:SS"; "The largest time gap allowed is 30 days"), timezone (of the returned values), module
 * (BIDDING_AND_OPTIMIZATION, BUDGET, STATUS, TARGETING), object_type (AD, ADGROUP, ADVERTISER, CAMPAIGN, INSTANT_FORM),
 * object_ids and operation_types (CREATE, AUDIT, STATUS, UPDATE, DELETE, DOWNLOAD_LEADS, SUBSCRIBE_FORM,
 * UNSUBSCRIBE_FORM), and answers task_id; GET /v1.3/changelog/task/check/ reports PROCESSING, SUCCESS or FAILED.
 * order_fields stays out: its values are not documented and the example sends it as a string next to an undocumented
 * order_type. Nothing in the account changes; the review reads the advertiser and the objects a filter names.
 */
type State = {kind: 'review'; objectType?: string; ids: string[]} | {kind: 'task'; taskId: string};
type Read = CompiledRequest & {tiktokChangeLogState?: State};
const gateway = 'tiktok_native_action',
  createPath = '/v1.3/changelog/task/create/',
  maxIds = 100,
  maxWindow = 30 * 86400000;
const modules = ['BIDDING_AND_OPTIMIZATION', 'BUDGET', 'STATUS', 'TARGETING'],
  objectTypes = ['AD', 'ADGROUP', 'ADVERTISER', 'CAMPAIGN', 'INSTANT_FORM'];
const operations = [
  'CREATE',
  'AUDIT',
  'STATUS',
  'UPDATE',
  'DELETE',
  'DOWNLOAD_LEADS',
  'SUBSCRIBE_FORM',
  'UNSUBSCRIBE_FORM',
];
// The objects a filter can name and the read that lists them for the advertiser.
const listings: Record<string, {action: string; path: string; filter: string; id: string}> = {
  CAMPAIGN: {action: 'tiktok_campaign_get', path: '/v1.3/campaign/get/', filter: 'campaign_ids', id: 'campaign_id'},
  ADGROUP: {action: 'tiktok_adgroup_get', path: '/v1.3/adgroup/get/', filter: 'adgroup_ids', id: 'adgroup_id'},
  AD: {action: 'tiktok_ad_get', path: '/v1.3/ad/get/', filter: 'ad_ids', id: 'ad_id'},
};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_TIKTOK_CHANGE_LOG_TASK', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function tiktokChangeLogKind(p: CompiledRequest): boolean {
  return p.gateway === gateway && p.method === 'POST' && !p.specialTransport && p.path === createPath;
}
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
/** A "YYYY-MM-DD HH:MM:SS" time as milliseconds, or undefined when it is not a real date and time. */
function time(v: unknown): number | undefined {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(v) : null;
  if (!m) return;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number],
    t = Date.UTC(y, mo - 1, d, h, mi, s),
    c = new Date(t);
  return c.getUTCFullYear() === y &&
    c.getUTCMonth() === mo - 1 &&
    c.getUTCDate() === d &&
    c.getUTCHours() === h &&
    c.getUTCMinutes() === mi &&
    c.getUTCSeconds() === s
    ? t
    : undefined;
}
export function assertTiktokChangeLog(p: CompiledRequest): void {
  if (!tiktokChangeLogKind(p)) return;
  if (Object.keys(p.query).length) invalid('A change log task takes no query parameters.');
  const b = p.body;
  if (!obj(b)) invalid('Send the request as a JSON object.');
  if (String(b.advertiser_id) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.', {}, 403);
  if (Object.hasOwn(b, 'order_fields') || Object.hasOwn(b, 'order_type'))
    invalid('Ordering stays out: the reference does not document the values of order_fields.');
  const extra = Object.keys(b).filter(
    k =>
      ![
        'advertiser_id',
        'start_time',
        'end_time',
        'timezone',
        'module',
        'object_ids',
        'object_type',
        'operation_types',
      ].includes(k),
  );
  if (extra.length)
    invalid(
      'A change log task takes start_time, end_time, timezone, module, object_type, object_ids and operation_types, not ' +
        extra.join(', ') +
        '.',
    );
  const start = time(b.start_time),
    end = time(b.end_time);
  if (start === undefined || end === undefined)
    invalid('start_time and end_time are required as "YYYY-MM-DD HH:MM:SS"; the reference gives no default window.');
  if (end <= start) invalid('end_time comes after start_time.');
  if (end - start > maxWindow) invalid('The window is at most 30 days; split longer periods into several tasks.');
  if (
    b.timezone !== undefined &&
    (typeof b.timezone !== 'string' || !/^(?:UTC|GMT|[A-Z][A-Za-z_-]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(b.timezone))
  )
    invalid('timezone is a time zone name of the TikTok appendix, such as America/Los_Angeles or Etc/GMT+8.');
  if (b.module !== undefined && !modules.includes(String(b.module)))
    invalid('module is one of ' + modules.join(', ') + '.');
  if (b.object_type !== undefined && !objectTypes.includes(String(b.object_type)))
    invalid('object_type is one of ' + objectTypes.join(', ') + '.');
  const ops = b.operation_types;
  if (
    ops !== undefined &&
    (!Array.isArray(ops) ||
      !ops.length ||
      ops.some(o => !operations.includes(String(o))) ||
      new Set(ops).size !== ops.length)
  )
    invalid('operation_types lists distinct values of ' + operations.join(', ') + '.');
  const ids = b.object_ids;
  if (ids === undefined) return;
  if (b.object_type === undefined) invalid('object_ids needs the object_type they are.');
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > maxIds ||
    ids.some(i => typeof i !== 'string' || !/^[1-9][0-9]{0,24}$/.test(i)) ||
    new Set(ids).size !== ids.length
  )
    invalid('object_ids lists 1–' + maxIds + ' distinct IDs as strings.');
  if (b.object_type === 'ADVERTISER' && (ids.length !== 1 || ids[0] !== p.accountId))
    invalid('For ADVERTISER, object_ids names only the selected advertiser.');
  if (b.object_type === 'INSTANT_FORM')
    invalid(
      'Instant forms cannot be filtered by ID here: AMCP cannot read that they belong to the advertiser. Filter by object_type or operation_types instead.',
    );
}
const read = (p: CompiledRequest, action: string, path: string, query: JsonObject, state?: State): Read => ({
  ...p,
  action,
  method: 'GET',
  path,
  query,
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  tiktokChangeLogState: state,
});
const advertiserRead = (p: CompiledRequest, state?: State) =>
  read(
    p,
    'tiktok_advertiser_info_get',
    '/v1.3/advertiser/info/',
    {advertiser_ids: [p.accountId], fields: ['advertiser_id', 'name', 'timezone', 'status']},
    state,
  );
export function tiktokChangeLogSnapshots(p: CompiledRequest): Read[] {
  const b = body(p),
    type = b.object_type === undefined ? undefined : String(b.object_type);
  return [
    advertiserRead(p, {
      kind: 'review',
      ...(type ? {objectType: type} : {}),
      ids:
        Array.isArray(b.object_ids) && type && Object.hasOwn(listings, type)
          ? (b.object_ids as string[]).map(String).sort()
          : [],
    }),
  ];
}
export function isTiktokChangeLogRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).tiktokChangeLogState;
}
function ok(r: TransportResult, label: string): JsonObject {
  const d = r.data;
  if (r.status !== 200 || !obj(d) || d.code !== 0 || !obj(d.data))
    unverified('TikTok did not return the ' + label + '.');
  return (d as JsonObject).data;
}
/** The advertiser and the named objects it has, or the status of a download task. */
export async function readTiktokChangeLogs(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).tiktokChangeLogState;
  if (!s) return request(p);
  if (s.kind === 'task') {
    const d = ok(await request({...(p as Read), tiktokChangeLogState: undefined} as Read), 'change log task');
    return {
      status: 200,
      headers: {},
      data: {task: {task_id: s.taskId, status: typeof d.status === 'string' ? d.status : null}},
    };
  }
  const info = ok(await request(advertiserRead(p)), 'advertiser'),
    rows = Array.isArray(info.list) ? (info.list as unknown[]) : unverified('TikTok did not list the advertiser.');
  const a = rows.find(r => obj(r) && String(r.advertiser_id) === p.accountId) as JsonObject | undefined;
  if (!a) unverified('TikTok did not return the selected advertiser.');
  const found: string[] = [];
  const listing = s.objectType ? listings[s.objectType] : undefined;
  if (listing && s.ids.length) {
    const d = ok(
      await request(
        read(p, listing.action, listing.path, {
          advertiser_id: p.accountId,
          filtering: {[listing.filter]: s.ids},
          page: 1,
          page_size: maxIds,
        }),
      ),
      s.objectType!.toLowerCase() + 's',
    );
    for (const row of (Array.isArray(d.list) ? d.list : []) as unknown[]) {
      if (!obj(row)) unverified('A listed object is malformed.');
      if (row.advertiser_id !== undefined && String(row.advertiser_id) !== p.accountId)
        fail('STATE_TARGET_MISMATCH', 'TikTok listed an object of another advertiser.', {}, 409);
      const id = String(row[listing.id]);
      if (s.ids.includes(id)) found.push(id);
    }
  }
  return {
    status: 200,
    headers: {},
    data: {
      advertiser: {id: p.accountId, name: a.name ?? null, timezone: a.timezone ?? null, status: a.status ?? null},
      objects: {type: s.objectType ?? null, requested: s.ids, found: [...new Set(found)].sort()},
    },
  };
}
export function validateTiktokChangeLogState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).tiktokChangeLogState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !obj(d) ||
    (s.kind === 'task' ? !obj(d.task) : !obj(d.advertiser) || !obj(d.objects) || !Array.isArray(d.objects.found))
  )
    unverified('Missing verified change log task state.');
}
export function tiktokChangeLogPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!tiktokChangeLogKind(p)) return;
  const s = states[0];
  if (!obj(s) || !obj(s.objects) || !Array.isArray(s.objects.found) || !Array.isArray(s.objects.requested))
    unverified('Missing verified change log task state.');
  const found = s.objects.found as string[],
    missing = (s.objects.requested as string[]).filter(id => !found.includes(id));
  if (missing.length)
    fail(
      'STATE_NOT_FOUND',
      'Not ' + String(body(p).object_type).toLowerCase() + 's of the selected advertiser: ' + missing.join(', ') + '.',
      {ids: missing},
      404,
    );
}
export function tiktokChangeLogImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!tiktokChangeLogKind(p)) return;
  const first = state[0],
    s: JsonObject = obj(first) ? first : {},
    b = body(p);
  return {
    provider: 'tiktok',
    scope: 'change_log',
    operation: 'export',
    advertiser: s.advertiser ?? null,
    window: {start_time: b.start_time, end_time: b.end_time, timezone: b.timezone ?? null},
    filters: {
      module: b.module ?? null,
      object_type: b.object_type ?? null,
      object_ids: b.object_ids ?? null,
      operation_types: b.operation_types ?? null,
    },
    may_affect_serving: false,
    effect:
      'Starts a change log download task for the advertiser; nothing in the account changes. Once it succeeds, get the file with the change log download read.',
    verification:
      'Checks the task until TikTok reports SUCCESS; verify again while it is PROCESSING. FAILED is not verified.',
    source: 'https://business-api.tiktok.com/portal/docs/create-a-change-log-download-task/v1.3',
  };
}
const taskOf = (d: unknown) =>
  obj(d) &&
  obj(d.data) &&
  ((typeof d.data.task_id === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(d.data.task_id)) ||
    (typeof d.data.task_id === 'number' && Number.isSafeInteger(d.data.task_id)))
    ? String(d.data.task_id)
    : undefined;
export function tiktokChangeLogOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && obj(r.data) && r.data.code === 0 && !!taskOf(r.data);
}
export function tiktokChangeLogVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const task = taskOf(result.data);
  if (!task) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no change log task to verify.');
  return [
    {
      read: read(
        p,
        'tiktok_changelog_task_check',
        '/v1.3/changelog/task/check/',
        {advertiser_id: p.accountId, task_id: task},
        {kind: 'task', taskId: task},
      ),
      expected: {task: {task_id: task, status: 'SUCCESS'}},
      id: 'change log task ' + task,
    },
  ];
}
export function tiktokChangeLogObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {task: obj(data.task) ? data.task : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokChangeLogFamily: ReviewedFamily = {
  name: 'tiktok_change_log_tasks',
  files: ['src/tiktok-change-logs.ts', ['tests/tiktok-change-logs.test.mjs']],
  kind: tiktokChangeLogKind,
  assert: assertTiktokChangeLog,
  snapshots: tiktokChangeLogSnapshots,
  isRead: isTiktokChangeLogRead,
  reader: readTiktokChangeLogs,
  validateState: validateTiktokChangeLogState,
  prerequisites: tiktokChangeLogPrerequisites,
  impact: tiktokChangeLogImpact,
  outcome: tiktokChangeLogOutcome,
  verification: tiktokChangeLogVerification,
  observed: tiktokChangeLogObserved,
  exemptFromSpendTextMatch: true,
};
