import {MirrorError} from './errors.js';
import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Structured Data File download tasks on Display & Video 360 API v4, per the pinned Discovery document
 * (sdfdownloadtasks.create and sdfdownloadtasks.operations.get; CreateSdfDownloadTaskRequest, ParentEntityFilter, IdFilter,
 * InventorySourceFilter and Operation; checked 2026-09-27). A task is "a long-running, asynchronous operation" that builds
 * SDF files of an advertiser's entities; the operation is read until done, and "The response will not include the
 * download files, which must be retrieved with media.download". Nothing about the entities changes.
 * AMCP asks for the selected advertiser (never partner access) and one filter.
 */
type Read = CompiledRequest & {dv360SdfState?: {operation?: string}; dv360SdfOperation?: string};
const gateway = 'dv360_native_action',
  origin = 'https://displayvideo.googleapis.com',
  oauthScope = 'https://www.googleapis.com/auth/display-video';
const fileTypes = [
  'FILE_TYPE_CAMPAIGN',
  'FILE_TYPE_MEDIA_PRODUCT',
  'FILE_TYPE_INSERTION_ORDER',
  'FILE_TYPE_LINE_ITEM',
  'FILE_TYPE_AD_GROUP',
  'FILE_TYPE_AD',
  'FILE_TYPE_LINE_ITEM_QA',
  'FILE_TYPE_AD_GROUP_QA',
];
const filterTypes = [
  'FILTER_TYPE_NONE',
  'FILTER_TYPE_ADVERTISER_ID',
  'FILTER_TYPE_CAMPAIGN_ID',
  'FILTER_TYPE_MEDIA_PRODUCT_ID',
  'FILTER_TYPE_INSERTION_ORDER_ID',
  'FILTER_TYPE_LINE_ITEM_ID',
];
const idLists = [
  'campaignIds',
  'adGroupAdIds',
  'mediaProductIds',
  'adGroupQaIds',
  'lineItemQaIds',
  'adGroupIds',
  'insertionOrderIds',
  'lineItemIds',
];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const operationName = /^sdfdownloadtasks\/operations\/[A-Za-z0-9_-]{1,128}$/;
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_DV360_SDF_DOWNLOAD', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function dv360SdfKind(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    (p.origin === undefined || p.origin === origin) &&
    !p.specialTransport &&
    p.method === 'POST' &&
    p.path === '/v4/sdfdownloadtasks'
  );
}
function ids(v: unknown, label: string, max = 200): void {
  if (!Array.isArray(v) || v.length > max || v.some(x => !id(x)) || new Set(v).size !== v.length)
    invalid(label + ' lists up to ' + max + ' distinct numeric IDs.');
}
export function assertDV360Sdf(p: CompiledRequest): void {
  if (!dv360SdfKind(p)) return;
  if (Object.keys(p.query).length || Object.keys(p.headers ?? {}).length)
    invalid('SDF download tasks take no query or header overrides.');
  const b = p.body;
  if (!obj(b)) invalid('Provide the CreateSdfDownloadTaskRequest body.');
  if (b.partnerId !== undefined)
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'Partner-level SDF downloads are outside this contract; name the selected advertiser.',
      {},
      403,
    );
  if (b.advertiserId !== p.accountId || !id(b.advertiserId))
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiserId must be the selected advertiser.', {}, 403);
  const extra = Object.keys(b).filter(
    k => !['version', 'advertiserId', 'parentEntityFilter', 'idFilter', 'inventorySourceFilter'].includes(k),
  );
  if (extra.length) invalid('Unqualified fields: ' + extra.join(', ') + '.');
  if (typeof b.version !== 'string' || !/^SDF_VERSION_(UNSPECIFIED|\d+(_\d+)?)$/.test(b.version))
    invalid('version is an SDF version such as SDF_VERSION_9, or SDF_VERSION_UNSPECIFIED for the advertiser default.');
  const filters = ['parentEntityFilter', 'idFilter', 'inventorySourceFilter'].filter(k => b[k] !== undefined);
  if (filters.length !== 1) invalid('Send exactly one of parentEntityFilter, idFilter or inventorySourceFilter.');
  if (b.parentEntityFilter !== undefined) {
    const f = b.parentEntityFilter;
    if (!obj(f) || Object.keys(f).some(k => !['fileType', 'filterType', 'filterIds'].includes(k)))
      invalid('parentEntityFilter takes fileType, filterType and filterIds.');
    if (
      !Array.isArray(f.fileType) ||
      !f.fileType.length ||
      f.fileType.some((t: unknown) => !fileTypes.includes(String(t))) ||
      new Set(f.fileType).size !== f.fileType.length
    )
      invalid('fileType lists distinct file types such as FILE_TYPE_LINE_ITEM.');
    if (!filterTypes.includes(f.filterType)) invalid('filterType is one of ' + filterTypes.join(', ') + '.');
    if (f.filterType === 'FILTER_TYPE_NONE') {
      if (f.filterIds !== undefined && !(Array.isArray(f.filterIds) && !f.filterIds.length))
        invalid('FILTER_TYPE_NONE takes no filterIds.');
    } else {
      ids(f.filterIds, 'filterIds');
      if (!(f.filterIds as unknown[]).length)
        invalid('filterIds names at least one ID for ' + String(f.filterType) + '.');
      if (
        f.filterType === 'FILTER_TYPE_ADVERTISER_ID' &&
        ((f.filterIds as string[]).length !== 1 || (f.filterIds as string[])[0] !== p.accountId)
      )
        invalid('FILTER_TYPE_ADVERTISER_ID names the selected advertiser only.');
    }
  }
  if (b.idFilter !== undefined) {
    const f = b.idFilter;
    if (!obj(f) || Object.keys(f).some(k => !idLists.includes(k)))
      invalid('idFilter takes ' + idLists.join(', ') + '.');
    for (const k of Object.keys(f)) ids(f[k], k, 150);
    if (!Object.values(f).some(v => Array.isArray(v) && v.length)) invalid('idFilter names at least one ID.');
  }
  if (b.inventorySourceFilter !== undefined) {
    const f = b.inventorySourceFilter;
    if (!obj(f) || Object.keys(f).some(k => k !== 'inventorySourceIds'))
      invalid('inventorySourceFilter takes inventorySourceIds (empty for all).');
    if (f.inventorySourceIds !== undefined) ids(f.inventorySourceIds, 'inventorySourceIds');
  }
}
export function assertDV360SdfScope(c: Connection): void {
  if (!c.scopes.includes(oauthScope))
    fail('INSUFFICIENT_SCOPE', 'Reconnect the selected DV360 connection with display-video scope.', {}, 403);
}
const read = (p: CompiledRequest, path: string): Read => ({
  ...p,
  action: 'AMCP_DV360_SDF_READ',
  method: 'GET',
  path,
  query: {},
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  dv360SdfState: undefined,
});
const stateRead = (p: CompiledRequest, operation?: string): Read => ({
  ...read(p, '/v4/advertisers/' + p.accountId),
  dv360SdfState: operation ? {operation} : {},
});
export function dv360SdfSnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p)];
}
export function isDV360SdfRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).dv360SdfState;
}
/** The write names the selected advertiser; an operation is readable when bound from a receipt or remembered for the account. */
export function authorizeDV360Sdf(p: CompiledRequest, c: Connection, store: Store, account: string): boolean {
  if (p.gateway !== gateway || (p.origin !== undefined && p.origin !== origin) || p.specialTransport) return false;
  if (dv360SdfKind(p)) {
    assertDV360Sdf(p);
    if (p.accountId !== account)
      fail('ACCOUNT_SCOPE_MISMATCH', 'advertiserId must be the selected advertiser.', {}, 403);
    assertDV360SdfScope(c);
    return true;
  }
  // The files of a finished task, once a verification read has seen their resource name for this advertiser.
  const file = /^\/download\/(download\/sdfdownloadtasks\/media\/[A-Za-z0-9_.-]{1,128})$/.exec(p.path);
  if (
    file &&
    p.method === 'GET' &&
    p.readOnly &&
    p.body === undefined &&
    (p.accountId === undefined || p.accountId === account) &&
    Object.keys(p.query).every(k => k === 'alt') &&
    store.ownsResource(c, account, file[1]!)
  ) {
    assertDV360SdfScope(c);
    return true;
  }
  const m = /^\/v4\/(sdfdownloadtasks\/operations\/[A-Za-z0-9_-]{1,128})$/.exec(p.path);
  if (
    !m ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    Object.keys(p.query).length ||
    (p.accountId !== undefined && p.accountId !== account)
  )
    return false;
  if ((p as Read).dv360SdfOperation === m[1] || store.ownsResource(c, account, m[1]!)) {
    assertDV360SdfScope(c);
    return true;
  }
  return fail(
    'RESOURCE_SCOPE_REQUIRED',
    'Read SDF download operations created for this advertiser through a verified review.',
    {},
    403,
  );
}
export async function readDV360Sdf(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).dv360SdfState;
  if (!s) return fetch(p);
  const a = await fetch({...(p as Read), dv360SdfState: undefined} as Read);
  if (a.status !== 200 || !obj(a.data) || String(a.data.advertiserId) !== p.accountId)
    fail('STATE_TARGET_MISMATCH', 'DV360 returned a different advertiser.', {}, 409);
  const out: JsonObject = {advertiser: {advertiserId: p.accountId!, entityStatus: a.data.entityStatus ?? null}};
  if (s.operation) {
    // Bound here to the receipt's operation; external arguments cannot set this marker.
    const r = await fetch({...read(p, '/v4/' + s.operation), dv360SdfOperation: s.operation} as Read),
      d = r.data;
    if (r.status !== 200 || !obj(d) || d.name !== s.operation)
      unverified('DV360 did not return the SDF download operation.');
    const response = obj(d.response) ? d.response : {};
    out.operation = {
      name: s.operation,
      done: d.done === true,
      failed: obj(d.error),
      resourceName: typeof response.resourceName === 'string' ? response.resourceName : null,
    };
  }
  return {status: 200, headers: {}, data: out};
}
export function validateDV360SdfState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).dv360SdfState,
    d = r.data;
  if (!s || r.status !== 200 || !obj(d) || !obj(d.advertiser) || !!s.operation !== obj(d.operation))
    unverified('Missing verified SDF download state.');
}
export function dv360SdfPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!dv360SdfKind(p)) return;
  const s = states[0];
  if (!obj(s) || !obj(s.advertiser)) unverified('Missing verified SDF download state.');
}
export function dv360SdfImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!dv360SdfKind(p)) return;
  const first = state[0],
    b = obj(p.body) ? p.body : {},
    filter = b.parentEntityFilter ?? b.idFilter ?? b.inventorySourceFilter;
  return {
    provider: 'dv360',
    scope: 'sdf_download_task',
    operation: 'create',
    advertiser: obj(first) && obj(first.advertiser) ? first.advertiser : null,
    version: b.version ?? null,
    filter,
    may_affect_serving: false,
    effect:
      "Starts an asynchronous export of the advertiser's entities as SDF files; nothing about them changes. Read the operation until it is done, then download its files with media.download.",
    verification:
      'Reads the operation named in the receipt until it is done without an error; its files then become downloadable.',
    source: 'https://developers.google.com/display-video/api/reference/rest/v4/sdfdownloadtasks/create',
  };
}
export function dv360SdfOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  return r.status === 200 && obj(d) && typeof d.name === 'string' && operationName.test(d.name) && !obj(d.error);
}
export function dv360SdfVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const name = String(result.data?.name ?? '');
  if (!operationName.test(name))
    fail('VERIFICATION_UNSUPPORTED', 'The receipt names no SDF download operation to verify.');
  return [{read: stateRead(p, name), expected: {operation: {name, done: true, failed: false}}, id: name}];
}
export function dv360SdfObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {operation: obj(data.operation) ? data.operation : null};
}
