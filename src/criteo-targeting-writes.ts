import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {criteoPrefix, criteoRoute} from './criteo-version.js';

const prefix = criteoPrefix,
  gateway = 'criteo_native_action';
const fields: Record<string, string[]> = {
  audiences: ['audienceIds'],
  stores: ['storeIds'],
  'add-to-basket': ['categoryIds', 'productIds'],
};
const object = (x: unknown): x is JsonObject => !!x && typeof x === 'object' && !Array.isArray(x);
function fail(message: string, code = 'CRITEO_TARGETING_INVALID'): never {
  throw new MirrorError(code, message);
}
const id = (x: unknown): x is string => typeof x === 'string' && /^[1-9][0-9]*$/.test(x);
const keys = (x: JsonObject, allowed: string[]) => {
  if (Object.keys(x).some(k => !allowed.includes(k)))
    fail('Unqualified targeting field. Use the exact native data.attributes shape.');
};
function list(x: unknown, field: string, maximum = 1000): string[] {
  if (
    !Array.isArray(x) ||
    x.length > maximum ||
    x.some(
      v =>
        typeof v !== 'string' ||
        !v.trim() ||
        v.length > 256 ||
        /[\u0000-\u001f]/.test(v) ||
        (field === 'audienceIds' && !id(v)),
    ) ||
    new Set(x).size !== x.length
  )
    fail('Target identifiers must be distinct native strings within the bounded limit.');
  return [...x].sort();
}
export function criteoTargetingKind(p: CompiledRequest): string | undefined {
  const m = criteoRoute(
    '/preferred-line-items/[1-9][0-9]*/targeting/(audiences|stores|add-to-basket)(?:/(append|delete))?$',
  ).exec(p.path);
  return p.gateway === gateway &&
    (!p.origin || p.origin === 'https://api.criteo.com') &&
    !p.specialTransport &&
    m &&
    (m[2] ? p.method === 'POST' : p.method === 'PUT')
    ? m[1]
    : undefined;
}
const lineId = (p: CompiledRequest) => p.path.split('/')[4]!;
export function assertCriteoTargeting(p: CompiledRequest) {
  const kind = criteoTargetingKind(p);
  if (!kind) return;
  if (!id(p.accountId) || Object.keys(p.query).length || Object.keys(p.headers).length)
    fail('Use a selected numeric Criteo account without request overrides.');
  if (!object(p.body)) fail('Provide a native data.attributes body.');
  keys(p.body, ['data']);
  const data = p.body.data;
  if (!object(data) || !object(data.attributes)) fail('Provide native data.attributes.');
  keys(data, ['type', 'attributes']);
  if (data.type !== undefined && (typeof data.type !== 'string' || !data.type || data.type.length > 128))
    fail('A supplied native type must be a nonempty string.');
  const attributes = data.attributes;
  keys(attributes, [...fields[kind]!, ...(p.method === 'PUT' ? ['scope'] : [])]);
  if (p.method === 'PUT' && !['include', 'exclude'].includes(attributes.scope))
    fail('Scope changes require include or exclude.');
  let n = 0;
  for (const key of fields[kind]!)
    if (attributes[key] !== undefined) n += list(attributes[key], key, 100).length;
    else if (p.method === 'PUT' || kind !== 'add-to-basket')
      fail('Explicit native target arrays are required, including empty arrays when preserving an empty set.');
  if (n > 100 || (p.method !== 'PUT' && !n))
    fail('Each review accepts 1–100 membership changes, or a scope change preserving up to 100 existing targets.');
}
export function assertCriteoTargetingScopes(c: Connection) {
  if (!['RetailMedia_Campaign_Read', 'RetailMedia_Campaign_Manage'].every(s => c.scopes.includes(s)))
    fail(
      'Criteo targeting requires recorded RetailMedia_Campaign_Read and RetailMedia_Campaign_Manage permissions.',
      'PROVIDER_WRITE_SCOPE_REQUIRED',
    );
}
const read = (p: CompiledRequest, path: string, query: JsonObject = {}): CompiledRequest => ({
  ...p,
  action: 'AMCP_CRITEO_TARGET_READ',
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
  queryArrayEncoding: 'repeat',
  criteoTargetState: undefined,
});
export function criteoTargetingSnapshots(p: CompiledRequest): CompiledRequest[] {
  return [
    {
      ...read(p, prefix + '/accounts/' + p.accountId + '/line-items', {
        limitToId: [lineId(p)],
        limitToType: 'Preferred',
        pageIndex: 0,
        pageSize: 2,
      }),
      criteoTargetState: {
        lineId: lineId(p),
        kind: criteoTargetingKind(p)!,
        audienceIds:
          criteoTargetingKind(p) === 'audiences' ? ((p.body as JsonObject).data.attributes.audienceIds ?? []) : [],
      },
    },
  ];
}
function envelope(r: TransportResult): JsonObject {
  const d = r.data;
  if (
    r.status !== 200 ||
    !object(d) ||
    d.error ||
    (d.errors != null && (!Array.isArray(d.errors) || d.errors.length)) ||
    (d.warnings != null && (!Array.isArray(d.warnings) || d.warnings.length))
  )
    fail(
      'Criteo returned an error, warning or unrecognized state envelope. Inspect it before changing targeting.',
      'CRITEO_STATE_UNVERIFIED',
    );
  if (Buffer.byteLength(JSON.stringify(d)) > 4 * 1024 * 1024)
    fail('Criteo state exceeds the 4 MiB response limit.', 'CRITEO_STATE_UNVERIFIED');
  if (d.links?.next || d.nextPage || d.nextPageToken || d.has_more || d.hasMore)
    fail('The target state is incomplete.', 'CRITEO_STATE_UNVERIFIED');
  return d;
}
function singlePage(d: JsonObject, wanted: string): JsonObject {
  const m = d.metadata;
  if (
    !Array.isArray(d.data) ||
    d.data.length !== 1 ||
    !object(m) ||
    m.currentPageIndex !== 0 ||
    !Number.isSafeInteger(m.currentPageSize) ||
    m.currentPageSize < 1 ||
    m.nextPage ||
    (m.totalItemsAcrossAllPages != null && m.totalItemsAcrossAllPages !== 1) ||
    (m.totalPages != null && m.totalPages !== 1)
  )
    fail('The filtered account discovery must contain exactly one complete target.', 'CRITEO_STATE_UNVERIFIED');
  const row = d.data[0];
  if (!object(row) || row.id !== wanted || !object(row.attributes))
    fail('Account discovery returned a different or malformed resource.', 'CRITEO_STATE_UNVERIFIED');
  return row;
}
function configuration(row: JsonObject): JsonObject {
  // Only documented output telemetry is discarded. Unknown configuration remains protected.
  const a = Object.fromEntries(
    Object.entries(row.attributes).filter(
      ([k]) => !['budgetSpent', 'budgetRemaining', 'createdAt', 'updatedAt'].includes(k),
    ),
  );
  for (const key of ['drawableBalanceIds', 'promotedBrandIds']) if (Array.isArray(a[key])) a[key] = list(a[key], key);
  return {id: row.id, attributes: a};
}
function targeting(kind: string, d: JsonObject): JsonObject {
  if (!object(d.data) || !object(d.data.attributes))
    fail('Missing targeting configuration.', 'CRITEO_STATE_UNVERIFIED');
  const a = d.data.attributes;
  if (!['include', 'exclude', 'unknown'].includes(a.scope))
    fail('Missing or unrecognized targeting scope.', 'CRITEO_STATE_UNVERIFIED');
  const result = {...a};
  let count = 0;
  for (const key of fields[kind]!)
    count += (result[key] = list(a[key] ?? (kind === 'add-to-basket' ? [] : undefined), key)).length;
  if (count > 1000) fail('Target state exceeds 1000 retained identifiers.', 'CRITEO_STATE_UNVERIFIED');
  return result;
}
/** Four exact reads plus bounded audience lookups. No provider-returned URL is followed. */
export async function readCriteoTargeting(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const cfg = p.criteoTargetState;
  if (!cfg) return fetch(p);
  const start = performance.now();
  let bytes = 0,
    requests = 0;
  const get = async (q: CompiledRequest) => {
    if (++requests > 24 || performance.now() - start > 60000)
      fail('Criteo review exceeded its bounded discovery budget.', 'CRITEO_STATE_UNVERIFIED');
    const r = await fetch(q),
      d = envelope(r);
    bytes += Buffer.byteLength(JSON.stringify(d));
    if (bytes > 8 * 1024 * 1024) fail('Criteo review exceeds 8 MiB.', 'CRITEO_STATE_UNVERIFIED');
    return d;
  };
  const membership = singlePage(await get({...p, criteoTargetState: undefined}), cfg.lineId),
    ma = membership.attributes;
  if (
    ma.type !== 'preferred' ||
    !id(ma.campaignId) ||
    !id(ma.targetRetailerId) ||
    (ma.id != null && ma.id !== cfg.lineId)
  )
    fail('The selected account did not return the exact preferred line item.', 'CRITEO_STATE_UNVERIFIED');
  const campaign = singlePage(
    await get(
      read(p, prefix + '/accounts/' + p.accountId + '/campaigns', {
        limitToId: [ma.campaignId],
        pageIndex: 0,
        pageSize: 2,
      }),
    ),
    ma.campaignId,
  );
  if (campaign.attributes.accountId !== p.accountId || campaign.attributes.type !== 'preferred')
    fail('The line item parent is not a preferred campaign of the selected account.', 'CRITEO_STATE_UNVERIFIED');
  // This authority is derived here after fresh account lists. External inputs cannot set it.
  const scoped = {...p, scopeContext: {...p.scopeContext, criteoVerifiedLineId: cfg.lineId}},
    base = prefix + '/preferred-line-items/' + cfg.lineId;
  const detail = (await get(read(scoped, base))).data;
  if (
    !object(detail) ||
    detail.id !== cfg.lineId ||
    !object(detail.attributes) ||
    detail.attributes.campaignId !== ma.campaignId ||
    detail.attributes.targetRetailerId !== ma.targetRetailerId ||
    (detail.attributes.id != null && detail.attributes.id !== cfg.lineId)
  )
    fail('The detailed line item disagrees with fresh account membership.', 'CRITEO_STATE_UNVERIFIED');
  if (
    !['active', 'scheduled', 'draft', 'paused', 'budgetHit', 'ended', 'noFunds'].includes(detail.attributes.status) ||
    typeof detail.attributes.budget !== 'number' ||
    !Number.isFinite(detail.attributes.budget) ||
    typeof detail.attributes.name !== 'string'
  )
    fail('Incomplete line-item configuration.', 'CRITEO_STATE_UNVERIFIED');
  const target = targeting(cfg.kind, await get(read(scoped, base + '/targeting/' + cfg.kind))),
    audiences: JsonObject[] = [];
  if (cfg.kind === 'audiences') {
    const ids = [...new Set([...target.audienceIds, ...cfg.audienceIds])].sort();
    if (ids.length > 1000) fail('Audience state exceeds 1000 identities.', 'CRITEO_STATE_UNVERIFIED');
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100),
        d = await get({
          ...read(p, prefix + '/accounts/' + p.accountId + '/audiences/search', {limit: 500, offset: 0}),
          method: 'POST',
          body: {data: {attributes: {audienceIds: chunk, retailerIds: [ma.targetRetailerId]}}},
        });
      if (
        !Array.isArray(d.data) ||
        d.data.length !== chunk.length ||
        !object(d.meta) ||
        d.meta.offset !== 0 ||
        d.meta.totalItems !== chunk.length ||
        d.meta.limit < chunk.length
      )
        fail('Audience search was incomplete or omitted a selected target.', 'CRITEO_STATE_UNVERIFIED');
      const seen = new Set<string>();
      for (const row of d.data) {
        if (
          !object(row) ||
          !chunk.includes(row.id) ||
          seen.has(row.id) ||
          !object(row.attributes) ||
          row.attributes.accountId !== p.accountId ||
          row.attributes.retailerId !== ma.targetRetailerId
        )
          fail('Audience identity, account or retailer does not match.', 'CRITEO_STATE_UNVERIFIED');
        seen.add(row.id);
        audiences.push(configuration(row));
      }
    }
  }
  return {
    status: 200,
    headers: {},
    data: {
      accountId: p.accountId,
      lineItemId: cfg.lineId,
      campaign: configuration(campaign),
      line: configuration(detail),
      target,
      audiences: audiences.sort((a, b) => a.id.localeCompare(b.id, 'en')),
    },
  };
}
export function validateCriteoTargetState(p: CompiledRequest, r: TransportResult) {
  const d = r.data as JsonObject;
  if (
    r.status !== 200 ||
    !object(d) ||
    d.accountId !== p.accountId ||
    d.lineItemId !== p.criteoTargetState?.lineId ||
    !object(d.target) ||
    !object(d.line) ||
    !object(d.campaign) ||
    !Array.isArray(d.audiences)
  )
    fail('Missing verified Criteo state.', 'CRITEO_STATE_UNVERIFIED');
}
export function validateCriteoTargetingPrerequisites(p: CompiledRequest, states: unknown[]) {
  const kind = criteoTargetingKind(p);
  if (!kind) return;
  const current = (states[0] as JsonObject)?.target,
    a = (p.body as JsonObject).data.attributes;
  if (!object(current)) fail('Missing target state.');
  if (p.method === 'PUT') {
    // The reference documents scope changes. Do not assume PUT silently replaces membership.
    for (const field of fields[kind]!)
      if (stable(list(a[field], field)) !== stable(current[field]))
        fail(
          'Use append/delete for membership changes. PUT changes include/exclude scope while explicitly preserving current target identifiers.',
          'TARGET_MEMBERSHIP_UPDATE_REQUIRED',
        );
  } else if (current.scope === 'unknown')
    fail('Set include or exclude with a reviewed PUT before appending or removing targets.', 'TARGET_SCOPE_REQUIRED');
  if (
    p.path.endsWith('/append') &&
    fields[kind]!.reduce((n, key) => n + new Set([...current[key], ...(a[key] ?? [])]).size, 0) > 1000
  )
    fail('The resulting target state would exceed the 1000-identifier verification bound.');
}
export function criteoTargetingOutcome(p: CompiledRequest, r: TransportResult): boolean {
  try {
    const d = envelope(r);
    targeting(criteoTargetingKind(p)!, d);
    return true;
  } catch {
    return false;
  }
}
export function criteoTargetingVerification(p: CompiledRequest, before: unknown[]) {
  const kind = criteoTargetingKind(p)!,
    original = (before[0] as JsonObject).target,
    a = (p.body as JsonObject).data.attributes,
    expected: JsonObject = structuredClone(original);
  if (p.method === 'PUT') expected.scope = a.scope;
  else
    for (const key of fields[kind]!) {
      const prior = original[key] as string[],
        changes = (a[key] ?? []) as string[];
      expected[key] = p.path.endsWith('/append')
        ? [...new Set([...prior, ...changes])].sort()
        : prior.filter(v => !changes.includes(v)).sort();
    }
  return [{read: criteoTargetingSnapshots(p)[0]!, expected: {target: expected}, id: lineId(p) + '/' + kind}];
}
export function authorizeCriteoInternalRead(p: CompiledRequest, c: Connection, account: string): boolean {
  const line = p.scopeContext?.criteoVerifiedLineId;
  if (p.gateway !== gateway || !line || !p.readOnly || p.method !== 'GET' || p.action !== 'AMCP_CRITEO_TARGET_READ')
    return false;
  assertCriteoReadScope(c);
  return (
    p.accountId === account &&
    (p.path === prefix + '/preferred-line-items/' + line ||
      new RegExp('^' + prefix + '/preferred-line-items/' + line + '/targeting/(audiences|stores|add-to-basket)$').test(
        p.path,
      ))
  );
}
export function assertCriteoReadScope(c: Connection) {
  if (!c.scopes.includes('RetailMedia_Campaign_Read'))
    fail('Criteo current campaign read permission is required.', 'INSUFFICIENT_SCOPE');
}
