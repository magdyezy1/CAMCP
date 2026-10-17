import type {ReviewedFamily} from './reviewed-family.js';
import {familyErrors, type ReasonFirstRefusal} from './family-kit.js';
import {parseLinkedInValue, linkedinQuery} from './linkedin-restli.js';
import {linkedinConversionConfiguration} from './linkedin-conversion-state.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

type Pair = {campaign: string; conversion: string};
type LinkRead = CompiledRequest & {linkedinConversionState?: Pair[]; linkedinConversionPage?: true};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail: ReasonFirstRefusal = familyErrors('INVALID_CONVERSION_LINK');
const stateFail = (message: string): never => fail(message, 'CONVERSION_LINK_STATE_UNVERIFIED');
const only = (v: unknown, fields: string[]): v is JsonObject =>
  object(v) && Object.keys(v).every(k => fields.includes(k));
const urn = (v: unknown, type: string): v is string =>
  typeof v === 'string' && new RegExp('^urn:' + type + ':[1-9][0-9]{0,19}$').test(v);
const nativeId = (v: unknown, want: string) =>
  (typeof v === 'string' && v === want) ||
  (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && String(v) === want);
const pairKey = (p: Pair) => '(campaign:' + p.campaign + ',conversion:' + p.conversion + ')';
function pair(value: unknown): Pair {
  if (typeof value === 'string') value = parseLinkedInValue(value);
  if (
    !only(value, ['campaign', 'conversion']) ||
    !urn(value.campaign, 'li:sponsoredCampaign') ||
    !urn(value.conversion, 'lla:llaPartnerConversion')
  )
    fail('Use an exact campaign and conversion URN pair.');
  return {campaign: (value as Pair).campaign, conversion: (value as Pair).conversion};
}
const account = (p: CompiledRequest) => {
  if (!/^[1-9][0-9]{0,19}$/.test(p.accountId ?? '')) fail('Select one sponsored account.');
  return p.accountId!;
};
const accountUrn = (p: CompiledRequest) => 'urn:li:sponsoredAccount:' + account(p);
const single = (p: CompiledRequest) => p.path !== '/rest/campaignConversions';
export function linkedinConversionKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'linkedin_native_action' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://api.linkedin.com') &&
    ['PUT', 'DELETE'].includes(p.method) &&
    /^\/rest\/campaignConversions(?:\/[^/]+)?$/.test(p.path)
  );
}
/** Preserve the captured template, but encode tuple scalars rather than its syntax. */
export function linkedinConversionPlan(p: CompiledRequest): CompiledRequest {
  if (p.gateway !== 'linkedin_native_action' || !/^\/rest\/campaignConversions\/[^/]+$/.test(p.path)) return p;
  try {
    const value = pair(decodeURIComponent(p.path.slice('/rest/campaignConversions/'.length)));
    return {...p, path: '/rest/campaignConversions/' + linkedinQuery({key: value}).slice(4)};
  } catch {
    return p;
  }
}
export function conversionPairs(p: CompiledRequest): Pair[] {
  let values: unknown = single(p)
    ? [pair(decodeURIComponent(p.path.slice('/rest/campaignConversions/'.length)))]
    : p.query.ids;
  if (typeof values === 'string') values = parseLinkedInValue(values);
  if (!Array.isArray(values) || !values.length || values.length > 25)
    fail('Review 1–25 distinct campaign/conversion pairs.');
  const pairs = (values as unknown[]).map(pair);
  if (new Set(pairs.map(pairKey)).size !== pairs.length) fail('Each pair may appear only once.');
  return pairs;
}
export function assertLinkedInConversion(p: CompiledRequest) {
  if (!linkedinConversionKind(p)) return;
  account(p);
  const pairs = conversionPairs(p),
    batch = !single(p),
    method = p.headers['X-RestLi-Method']?.toUpperCase();
  if (
    Object.keys(p.headers).some(
      k => !['LinkedIn-Version', 'X-Restli-Protocol-Version', 'X-RestLi-Method'].includes(k),
    ) ||
    p.headers['X-Restli-Protocol-Version'] !== '2.0.0' ||
    !/^20\d{4}$/.test(p.headers['LinkedIn-Version'] ?? '')
  )
    fail('Use the native versioned REST.li 2.0 contract without method tunneling.');
  if (method !== undefined && method !== (batch ? 'BATCH_' : '') + (p.method === 'PUT' ? 'UPDATE' : 'DELETE'))
    fail('REST.li method must match this exact PUT/DELETE operation.');
  if (Object.keys(p.query).some(k => !batch || k !== 'ids'))
    fail('Only batch ids are accepted; additional finders/actions are not qualified.');
  if (p.method === 'DELETE') {
    if (p.body !== undefined && p.body !== null && (!object(p.body) || Object.keys(p.body).length))
      fail('Deletion has no request body.');
    return;
  }
  if (!batch) {
    if (pairKey(pair(p.body)) !== pairKey(pairs[0]!)) fail('Path and body must identify the same pair.');
    return;
  }
  if (!only(p.body, ['entities']) || !object(p.body.entities)) fail('Batch PUT requires a native entities map.');
  const found = new Set<string>();
  for (const [key, value] of Object.entries((p.body as JsonObject).entities)) {
    const k = pairKey(pair(key));
    if (found.has(k) || k !== pairKey(pair(value)) || !pairs.some(v => pairKey(v) === k))
      fail('Every batch entity key, value and query id must match exactly.');
    found.add(k);
  }
  if (found.size !== pairs.length) fail('Every requested pair needs one entity.');
}
export function assertLinkedInConversionScope(c: Connection, write = false) {
  if (!c.scopes.some(s => (write ? s === 'rw_ads' : ['r_ads', 'rw_ads'].includes(s))))
    fail(
      write ? 'Campaign conversion writes require rw_ads.' : 'Conversion verification requires r_ads or rw_ads.',
      'INSUFFICIENT_SCOPE',
    );
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): LinkRead {
  return {
    ...p,
    action: 'AMCP_LINKEDIN_CONVERSION_READ',
    method: 'GET',
    path,
    query,
    body: undefined,
    headers: {'LinkedIn-Version': p.headers['LinkedIn-Version']!, 'X-Restli-Protocol-Version': '2.0.0'},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    linkedinConversionState: undefined,
    linkedinConversionPage: true,
  };
}
export function linkedinConversionSnapshots(p: CompiledRequest): LinkRead[] {
  return [{...read(p, '/rest/adAccounts/' + account(p)), linkedinConversionState: conversionPairs(p)}];
}
export function isLinkedInConversionRead(p: CompiledRequest): p is LinkRead {
  return !!(p as LinkRead).linkedinConversionState;
}
/** Only server-built reads may follow a proven campaign into the global finder. */
export function authorizeLinkedInConversion(p: CompiledRequest, c: Connection, id: string): boolean {
  if (linkedinConversionKind(p)) {
    assertLinkedInConversion(p);
    assertLinkedInConversionScope(c, true);
    return true;
  }
  const internal = p as LinkRead;
  if (
    p.gateway !== 'linkedin_native_action' ||
    !internal.linkedinConversionPage ||
    p.action !== 'AMCP_LINKEDIN_CONVERSION_READ' ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined
  )
    return false;
  assertLinkedInConversionScope(c);
  if (
    p.path === '/rest/adAccounts/' + id ||
    new RegExp('^/rest/adAccounts/' + id + '/adCampaigns/[1-9][0-9]*$').test(p.path)
  )
    return true;
  if (
    /^\/rest\/conversions\/[1-9][0-9]*$/.test(p.path) &&
    p.query.account === 'urn:li:sponsoredAccount:' + id &&
    Object.keys(p.query).length === 1
  )
    return true;
  if (
    p.path === '/rest/campaignConversions' &&
    p.query.q === 'campaigns' &&
    Array.isArray(p.query.campaigns) &&
    p.query.campaigns.length > 0 &&
    p.query.campaigns.length <= 25 &&
    p.query.campaigns.every((v: unknown) => urn(v, 'li:sponsoredCampaign')) &&
    Object.keys(p.query).every(k => ['q', 'campaigns', 'start', 'count'].includes(k))
  )
    return true;
  return fail('Unqualified internal conversion read.', 'RESOURCE_SCOPE_REQUIRED');
}
export async function readLinkedInConversions(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const pairs = (p as LinkRead).linkedinConversionState;
  if (!pairs) return request(p);
  let requests = 0,
    bytes = 0;
  const started = performance.now();
  const fetch = async (path: string, query: JsonObject = {}) => {
    if (++requests > 80 || performance.now() - started > 60000)
      stateFail('Conversion review exceeded its request/time bound.');
    const response = await request(read(p, path, query)),
      value = response.data;
    if (
      response.status !== 200 ||
      !object(value) ||
      value.error !== undefined ||
      value.errors !== undefined ||
      value.serviceErrorCode !== undefined ||
      value.warnings !== undefined ||
      (value.status !== undefined && typeof value.status === 'number')
    )
      stateFail('A required read failed or returned an error envelope.');
    const data = value as JsonObject,
      size = Buffer.byteLength(JSON.stringify(data));
    bytes += size;
    if (size > 4 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
      stateFail('Conversion review exceeded its byte/time bound.');
    return data;
  };
  const selected = await fetch('/rest/adAccounts/' + account(p));
  if (
    !nativeId(selected.id, account(p)) ||
    typeof selected.currency !== 'string' ||
    typeof selected.status !== 'string'
  )
    stateFail('The selected account identity, currency and status are required.');
  const campaigns: JsonObject = {},
    conversions: JsonObject = {},
    memberships: JsonObject = {};
  for (const id of [...new Set(pairs.map(v => v.campaign))].sort()) {
    const row = await fetch('/rest/adAccounts/' + account(p) + '/adCampaigns/' + id.split(':').at(-1));
    if (
      !nativeId(row.id, id.split(':').at(-1)!) ||
      row.account !== accountUrn(p) ||
      typeof row.name !== 'string' ||
      typeof row.status !== 'string'
    )
      stateFail('A campaign was missing, foreign or incomplete.');
    campaigns[id] = row;
  }
  for (const id of [...new Set(pairs.map(v => v.conversion))].sort()) {
    const row = await fetch('/rest/conversions/' + id.split(':').at(-1), {account: accountUrn(p)});
    if (
      !nativeId(row.id, id.split(':').at(-1)!) ||
      row.account !== accountUrn(p) ||
      typeof row.name !== 'string' ||
      typeof row.enabled !== 'boolean' ||
      typeof row.type !== 'string'
    )
      stateFail('A conversion was missing, foreign or incomplete.');
    conversions[id] = linkedinConversionConfiguration(row);
  }
  let start = 0,
    total: number | undefined;
  for (let page = 0; ; page++) {
    if (page >= 25) stateFail('Complete association membership exceeded 25 pages.');
    const data = await fetch('/rest/campaignConversions', {
        q: 'campaigns',
        campaigns: Object.keys(campaigns),
        start,
        count: 100,
      }),
      paging = data.paging;
    if (
      !only(data, ['elements', 'paging', 'metadata']) ||
      !Array.isArray(data.elements) ||
      !only(paging, ['start', 'count', 'links', 'total']) ||
      paging.start !== start ||
      !Number.isSafeInteger(paging.count) ||
      paging.count < 1 ||
      paging.count > 100 ||
      !Array.isArray(paging.links) ||
      data.elements.length > paging.count
    )
      stateFail('Association membership has an unknown or incomplete page envelope.');
    if (data.metadata !== undefined && (!object(data.metadata) || Object.keys(data.metadata).length))
      stateFail('Unqualified association metadata may indicate incomplete results.');
    if (paging.total !== undefined) {
      if (!Number.isSafeInteger(paging.total) || paging.total < 0 || (total !== undefined && total !== paging.total))
        stateFail('Invalid or changing membership count.');
      total = paging.total;
    }
    for (const row of data.elements) {
      if (
        !object(row) ||
        row.error !== undefined ||
        row.errors !== undefined ||
        (row.status !== undefined && typeof row.status === 'number')
      )
        stateFail('A membership entry returned an error.');
      const value = pair({campaign: row?.campaign, conversion: row?.conversion}),
        key = pairKey(value);
      if (!Object.hasOwn(campaigns, value.campaign) || Object.hasOwn(memberships, key))
        stateFail('Membership has a foreign campaign or duplicate pair.');
      const {associatedAt, ...config} = row;
      memberships[key] = config;
    }
    if (Object.keys(memberships).length > 1000) stateFail('Review supports at most 1000 associations.');
    // Link URLs are never followed. Continue with the same fixed finder and offset.
    if (
      paging.links.some((l: unknown) => !object(l) || !['next', 'prev'].includes(l.rel) || typeof l.href !== 'string')
    )
      stateFail('Unrecognized association pagination link.');
    const next = paging.links.some((l: JsonObject) => l.rel === 'next');
    if (next && !data.elements.length) stateFail('An empty page cannot establish continued membership.');
    if (total !== undefined) {
      if (start + data.elements.length > total || (start + data.elements.length === total && next))
        stateFail('Membership count disagrees with pagination.');
      if (start + data.elements.length === total) break;
      if (!data.elements.length) stateFail('A required association page was empty.');
    } else if (!next && data.elements.length < paging.count) break;
    start += paging.count;
  }
  if (total !== undefined && Object.keys(memberships).length !== total) stateFail('Membership is incomplete.');
  return {
    status: 200,
    headers: {},
    data: {
      account: selected,
      campaigns,
      conversions,
      memberships,
      targets: Object.fromEntries(pairs.map(v => [pairKey(v), {present: Object.hasOwn(memberships, pairKey(v))}])),
    },
  };
}
export function validateLinkedInConversionState(p: CompiledRequest, r: TransportResult) {
  if (
    !isLinkedInConversionRead(p) ||
    r.status !== 200 ||
    !object(r.data) ||
    String(r.data.account?.id) !== account(p) ||
    !object(r.data.targets) ||
    !object(r.data.memberships)
  )
    stateFail('Complete conversion review state is missing.');
}
export function linkedinConversionPrerequisites(p: CompiledRequest, state: unknown[]) {
  if (!linkedinConversionKind(p) || p.method !== 'PUT') return;
  const s = state[0] as JsonObject;
  if (
    Object.keys(s.memberships).length +
      conversionPairs(p).filter(v => !Object.hasOwn(s.memberships, pairKey(v))).length >
    1000
  )
    fail('This batch exceeds complete association read-back capacity.');
}
export function linkedinConversionOutcome(p: CompiledRequest, r: TransportResult): boolean {
  if (r.status === 204)
    return r.data === null || r.data === undefined || (object(r.data) && !Object.keys(r.data).length);
  if (
    single(p) ||
    r.status !== 200 ||
    !only(r.data, ['results', 'errors']) ||
    !object(r.data.results) ||
    (r.data.errors !== undefined && (!object(r.data.errors) || Object.keys(r.data.errors).length))
  )
    return false;
  try {
    const pairs = conversionPairs(p),
      seen = new Set<string>();
    for (const [key, value] of Object.entries(r.data.results)) {
      const k = pairKey(pair(key));
      if (seen.has(k) || !pairs.some(v => pairKey(v) === k) || !only(value, ['status']) || value.status !== 204)
        return false;
      seen.add(k);
    }
    return seen.size === pairs.length;
  } catch {
    return false;
  }
}
export function linkedinConversionVerification(p: CompiledRequest) {
  return [
    {
      read: linkedinConversionSnapshots(p)[0]!,
      expected: {targets: Object.fromEntries(conversionPairs(p).map(v => [pairKey(v), {present: p.method === 'PUT'}]))},
      id: account(p),
    },
  ];
}
export const linkedinConversionImpact = {
  provider: 'linkedin',
  scope: 'campaign_conversion_links',
  may_affect_serving: true,
  effect:
    'Associates or removes existing conversion rules from selected campaigns. This can change attribution and conversion optimization in running campaigns without changing their status or monetary budgets.',
  verification:
    'Fresh selected-account campaigns and conversions; complete bounded association membership. A missing resource or HTTP 404 is never deletion proof.',
  recovery:
    'Keep the original reviewed claim after a partial or lost response. Reconcile all requested pairs through read-only discovery; do not repeat the uncertain batch.',
};

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinConversionFamily: ReviewedFamily = {
  name: 'linkedin_conversion_links',
  files: ['src/linkedin-conversion-links.ts', ['tests/linkedin-conversion-links.test.ts']],
  kind: linkedinConversionKind,
  assert: plan => assertLinkedInConversion(plan),
  scope: (c, write) => assertLinkedInConversionScope(c, write),
  authorize: (plan, connection, account) => authorizeLinkedInConversion(plan, connection, account),
  snapshots: linkedinConversionSnapshots,
  isRead: isLinkedInConversionRead,
  reader: (read, next) => readLinkedInConversions(read, next),
  validateState: validateLinkedInConversionState,
  prerequisites: (plan, state) => linkedinConversionPrerequisites(plan, state),
  impact: () => linkedinConversionImpact,
  outcome: linkedinConversionOutcome,
  verification: (plan: CompiledRequest) => linkedinConversionVerification(plan),
  spendConfirmation: {
    needed: () => true,
    message:
      'Campaign conversion associations can affect optimization. Review the selected campaigns and conversion rules and provide spend_change_confirmed=true.',
  },
  activates: () => true,
};
