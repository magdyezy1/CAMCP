import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, familyErrors, readOf, type ReasonFirstRefusal} from './family-kit.js';
import {parseLinkedInValue} from './linkedin-restli.js';
import {assertLinkedInConversionScope} from './linkedin-conversion-links.js';
import {stable} from './security.js';
import {normalizeReviewState, comparableStateHash, changedComparableFields} from './review-state-core.js';
import {linkedinReviewVolatile} from './linkedin-review-volatile.js';
import {linkedinAccountState} from './linkedin-account-state.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

const base = '/rest/adTargetTemplates',
  marker = 'AMCP_LINKEDIN_TEMPLATE_READ';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: unknown, keys: string[]): v is JsonObject => object(v) && Object.keys(v).every(k => keys.includes(k));
const fail: ReasonFirstRefusal = familyErrors('LINKEDIN_TEMPLATE_STATE_UNVERIFIED');
const input = (message: string): never => fail(message, 'INVALID_AUDIENCE_TEMPLATE');
const id = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n
    ? v
    : typeof v === 'number' && Number.isSafeInteger(v) && v > 0
      ? String(v)
      : undefined;
const account = (p: CompiledRequest) => {
  if (!id(p.accountId)) input('Select one exact sponsored account ID.');
  return 'urn:li:sponsoredAccount:' + p.accountId;
};
const empty = (v: unknown) => v === null || v === undefined || (object(v) && Object.keys(v).length === 0);
export function linkedinTemplateKind(p: CompiledRequest): 'create' | 'update' | 'delete' | 'batch_delete' | undefined {
  if (
    p.gateway !== 'linkedin_native_action' ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://api.linkedin.com')
  )
    return;
  if (p.path === base) return p.method === 'POST' ? 'create' : p.method === 'DELETE' ? 'batch_delete' : undefined;
  if (/^\/rest\/adTargetTemplates\/[1-9][0-9]*$/.test(p.path))
    return p.method === 'POST' ? 'update' : p.method === 'DELETE' ? 'delete' : undefined;
}
function targets(p: CompiledRequest): string[] {
  const kind = linkedinTemplateKind(p);
  if (kind === 'create') return [];
  if (kind !== 'batch_delete') {
    const value = id(p.path.split('/').at(-1));
    if (!value) input('Use a numeric template ID.');
    return [value!];
  }
  const value = typeof p.query.ids === 'string' ? parseLinkedInValue(p.query.ids) : p.query.ids;
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 25 ||
    value.some(v => typeof v !== 'string' || !id(v)) ||
    new Set(value).size !== value.length
  )
    input('Delete 1–25 distinct exact string template IDs.');
  return [...(value as string[])].sort();
}
const numericFacets: Record<string, string> = {
  buyerGroups: 'standardizedProductCategory',
  companyCategory: 'organizationRankingList',
  degrees: 'degree',
  employers: 'organization',
  employersAll: 'organization',
  employersPast: 'organization',
  fieldsOfStudy: 'fieldOfStudy',
  firstDegreeConnectionCompanies: 'organization',
  followedCompanies: 'organization',
  groups: 'group',
  industries: 'industry',
  interests: 'interest',
  jobFunctions: 'function',
  memberBehaviors: 'memberBehavior',
  schools: 'organization',
  seniorities: 'seniority',
  skills: 'skill',
  titles: 'title',
  titlesAll: 'title',
  titlesPast: 'title',
  audienceMatchingSegments: 'adSegment',
  dynamicSegments: 'adSegment',
};
const ranges: Record<string, string[]> = {
  ageRanges: ['(18,24)', '(25,34)', '(35,54)', '(55,2147483647)'],
  growthRate: ['(-2147483647,0)', '(0,3)', '(3,10)', '(10,20)', '(20,2147483647)'],
  staffCountRanges: [
    '(1,1)',
    '(2,10)',
    '(11,50)',
    '(51,200)',
    '(201,500)',
    '(501,1000)',
    '(1001,5000)',
    '(5001,10000)',
    '(10001,2147483647)',
  ],
};
const rangeTypes: Record<string, string> = {
  ageRanges: 'ageRange',
  growthRate: 'growthRate',
  staffCountRanges: 'staffCountRange',
};
function criterionValue(facet: string, value: unknown, version: string): boolean {
  if (typeof value !== 'string' || value.length > 200) return false;
  if (facet === 'buyerGroups' && version < '202603') return false;
  if (numericFacets[facet])
    return (
      value.startsWith('urn:li:' + numericFacets[facet] + ':') &&
      !!id(value.slice(('urn:li:' + numericFacets[facet] + ':').length))
    );
  if (ranges[facet]) return ranges[facet]!.some(r => value === 'urn:li:' + rangeTypes[facet] + ':' + r);
  if (facet === 'genders') return ['urn:li:gender:MALE', 'urn:li:gender:FEMALE'].includes(value);
  if (facet === 'interfaceLocales') return /^urn:li:locale:[a-z]{2}_[A-Z]{2}$/.test(value);
  if (['locations', 'profileLocations'].includes(facet))
    return /^urn:li:(?:geo:[1-9][0-9]{0,18}|country:[a-z]{2}|countryGroup:[A-Z]{2}|region:[1-9][0-9]{0,18}|state:\(urn:li:country:[a-z]{2},[A-Z0-9_-]{1,10}\))$/.test(
      value,
    );
  return false;
}
/** Only native Boolean groups and facet members are unordered; unknown arrays remain ordered. */
function criteriaProjection(v: unknown): unknown {
  if (!object(v)) return v;
  const out = structuredClone(v);
  const clause = (x: unknown) => {
    if (!object(x) || !object(x.or)) return x;
    return {
      ...x,
      or: Object.fromEntries(
        Object.entries(x.or).map(([k, a]) => [
          k,
          Array.isArray(a) && k.startsWith('urn:li:adTargetingFacet:') && a.every(x => typeof x === 'string')
            ? [...a].sort()
            : a,
        ]),
      ),
    };
  };
  if (object(out.include) && Array.isArray(out.include.and))
    out.include = {
      ...out.include,
      and: out.include.and.map(clause).sort((a: unknown, b: unknown) => stable(a).localeCompare(stable(b), 'en')),
    };
  if (object(out.exclude)) out.exclude = clause(out.exclude);
  return out;
}
function criteria(v: unknown, version: string) {
  if (
    !only(v, ['include', 'exclude']) ||
    !only(v.include, ['and']) ||
    !Array.isArray(v.include.and) ||
    !v.include.and.length ||
    v.include.and.length > 25 ||
    (v.exclude !== undefined && !only(v.exclude, ['or']))
  )
    input('Use native include.and and optional exclude.or targeting; at most 25 include clauses.');
  const value = v as JsonObject;
  let count = 0;
  for (const group of [
    ...value.include.and,
    ...(value.exclude !== undefined && Object.keys(value.exclude).length ? [value.exclude] : []),
  ]) {
    if (!only(group, ['or']) || !object(group.or) || !Object.keys(group.or).length || Object.keys(group.or).length > 30)
      input('Each targeting clause needs a nonempty native facet map.');
    for (const [key, values] of Object.entries((group as JsonObject).or)) {
      const facet = key.replace(/^urn:li:adTargetingFacet:/, '');
      if (
        key === facet ||
        !Array.isArray(values) ||
        !values.length ||
        values.length > 100 ||
        values.some(v => !criterionValue(facet, v, version)) ||
        new Set(values).size !== values.length
      )
        input('Use discovered, unique values for a documented facet; private references must be adSegment URNs.');
      count += (values as unknown[]).length;
    }
  }
  if (count > 500 || Buffer.byteLength(JSON.stringify(v)) > 64 * 1024)
    input('Targeting supports at most 500 values and 64 KiB.');
  const groups = (criteriaProjection(v) as JsonObject).include.and;
  if (new Set(groups.map(stable)).size !== groups.length) input('Duplicate targeting clauses are not allowed.');
  const included = value.include.and.map((g: JsonObject) => new Set(Object.keys(g.or).map(k => k.split(':').at(-1)!)));
  const incompatible = (a: string[], b: string[]) =>
    included.some(
      (g: Set<string>, i: number) =>
        a.some(k => g.has(k)) && included.some((h: Set<string>, j: number) => i !== j && b.some(k => h.has(k))),
    );
  if (
    incompatible(['employers', 'employersAll', 'employersPast'], ['industries', 'staffCountRanges']) ||
    incompatible(['titles', 'titlesAll', 'titlesPast'], ['jobFunctions', 'seniorities']) ||
    incompatible(['dynamicSegments'], ['memberBehaviors', 'interests']) ||
    incompatible(['audienceMatchingSegments'], ['memberBehaviors'])
  )
    input('These facets cannot be ANDed in separate include clauses.');
  if (
    included.some((g: Set<string>) => g.has('staffCountRanges')) &&
    value.exclude?.or?.['urn:li:adTargetingFacet:staffCountRanges']
  )
    input('Staff-count targeting cannot be both included and excluded.');
}
function desired(p: CompiledRequest): JsonObject | undefined {
  return linkedinTemplateKind(p) === 'create'
    ? (p.body as JsonObject)
    : linkedinTemplateKind(p) === 'update'
      ? (p.body as JsonObject).patch.$set
      : undefined;
}
function segmentRefs(p: CompiledRequest): Map<string, string> {
  const map = new Map<string, string>(),
    c = desired(p)?.targetingCriteria;
  for (const clause of [...(c?.include?.and ?? []), ...(c?.exclude ? [c.exclude] : [])])
    for (const [facet, values] of Object.entries(clause.or ?? {}))
      if (
        ['urn:li:adTargetingFacet:audienceMatchingSegments', 'urn:li:adTargetingFacet:dynamicSegments'].includes(facet)
      )
        for (const value of values as string[]) {
          const key = value.split(':').at(-1)!,
            kind = facet.endsWith(':dynamicSegments') ? 'RETARGETING' : 'MATCHED';
          if (map.has(key) && map.get(key) !== kind) input('The same segment cannot use conflicting facet types.');
          map.set(key, kind);
        }
  if (map.size > 25) input('Review at most 25 private segment references.');
  return new Map([...map].sort(([a], [b]) => a.localeCompare(b, 'en')));
}
export function assertLinkedInTemplate(p: CompiledRequest) {
  const kind = linkedinTemplateKind(p);
  if (!kind) input('Unqualified saved-audience route.');
  const owner = account(p);
  targets(p);
  if (
    Object.keys(p.headers).some(
      k => !['LinkedIn-Version', 'X-Restli-Protocol-Version', 'X-RestLi-Method'].includes(k),
    ) ||
    p.headers['X-Restli-Protocol-Version'] !== '2.0.0' ||
    !/^20\d{2}(0[1-9]|1[0-2])$/.test(p.headers['LinkedIn-Version'] ?? '')
  )
    input('Use a pinned monthly LinkedIn version and REST.li 2.0 without transport overrides.');
  const method = p.headers['X-RestLi-Method']?.toUpperCase(),
    expected = {create: 'CREATE', update: 'PARTIAL_UPDATE', delete: 'DELETE', batch_delete: 'BATCH_DELETE'}[kind!];
  if (kind === 'update' ? method !== 'PARTIAL_UPDATE' : method !== undefined && method !== expected)
    input('The REST.li method must match the exact native operation.');
  if (Object.keys(p.query).some(k => kind !== 'batch_delete' || k !== 'ids'))
    input('Only batch-delete ids are accepted; finders and arbitrary actions are not write parameters.');
  if (kind === 'delete' || kind === 'batch_delete') {
    if (!empty(p.body)) input('Delete has no body.');
    return;
  }
  if (kind === 'create') {
    if (
      !only(p.body, ['account', 'name', 'description', 'targetingCriteria']) ||
      p.body.account !== owner ||
      p.body.name === undefined ||
      p.body.targetingCriteria === undefined
    )
      input('Create needs this account, a name and complete targetingCriteria, without read-only fields.');
  } else if (
    !only(p.body, ['patch']) ||
    !only(p.body.patch, ['$set']) ||
    !only(p.body.patch.$set, ['name', 'description', 'targetingCriteria']) ||
    !Object.keys(p.body.patch.$set).length
  )
    input(
      'Use a nonempty patch.$set of name, description or complete targetingCriteria. Account/IDs and nested patches are immutable or unqualified.',
    );
  const d = desired(p)!;
  for (const [key, max] of [
    ['name', 100],
    ['description', 500],
  ] as const)
    if (
      d[key] !== undefined &&
      (typeof d[key] !== 'string' ||
        (key === 'name' && !d[key].trim()) ||
        [...d[key]].length > max ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(d[key]))
    )
      input('Names need 1–100 characters and descriptions at most 500 characters without control bytes.');
  if (d.targetingCriteria !== undefined) criteria(d.targetingCriteria, p.headers['LinkedIn-Version']!);
  segmentRefs(p);
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}, deadline?: number): CompiledRequest {
  return readOf(
    p,
    {
      action: marker,
      path,
      query,
      headers: {'LinkedIn-Version': p.headers['LinkedIn-Version']!, 'X-Restli-Protocol-Version': '2.0.0'},
      clears: ['responseControls'],
    },
    {linkedinTemplateDeadline: deadline},
  );
}
export const linkedinTemplateSnapshots = (p: CompiledRequest) => [
  read(p, '/rest/adAccounts/' + p.accountId),
  read(p, base, {q: 'account', account: account(p), sortField: 'ID', sortOrder: 'ASCENDING', start: 0, count: 100}),
];
export function authorizeLinkedInTemplate(p: CompiledRequest, c: Connection, selected: string): boolean {
  if (linkedinTemplateKind(p)) {
    assertLinkedInTemplate(p);
    assertLinkedInConversionScope(c, true);
    return true;
  }
  if (p.gateway !== 'linkedin_native_action' || p.action !== marker || p.method !== 'GET' || !p.readOnly) return false;
  assertLinkedInConversionScope(c);
  if (p.accountId !== selected || p.body !== undefined || (p.origin && p.origin !== 'https://api.linkedin.com'))
    return fail('Invalid internal saved-audience read.', 'RESOURCE_SCOPE_REQUIRED');
  if (p.path === '/rest/adAccounts/' + selected && Object.keys(p.query).length === 0) return true;
  if (/^\/rest\/adSegments\/[1-9][0-9]*$/.test(p.path) && Object.keys(p.query).length === 0) return true;
  if (
    p.path === base &&
    p.query.q === 'account' &&
    p.query.account === account(p) &&
    p.query.sortField === 'ID' &&
    p.query.sortOrder === 'ASCENDING' &&
    Number.isSafeInteger(p.query.start) &&
    p.query.start >= 0 &&
    p.query.count === 100 &&
    Object.keys(p.query).every(k => ['q', 'account', 'sortField', 'sortOrder', 'start', 'count'].includes(k))
  )
    return true;
  return fail('Unqualified saved-audience dependency path.', 'RESOURCE_SCOPE_REQUIRED');
}
const invalidEnvelope = (d: JsonObject) =>
  d.error !== undefined ||
  d.errors !== undefined ||
  d.serviceErrorCode !== undefined ||
  typeof d.status === 'number' ||
  d.partial === true ||
  d.warnings !== undefined;
function configuration(v: JsonObject, template = false): JsonObject {
  const {created, lastModified, approximateMemberCount, ...config} = v;
  if (template && Object.hasOwn(config, 'targetingCriteria'))
    config.targetingCriteria = criteriaProjection(config.targetingCriteria);
  return normalizeReviewState(config, linkedinReviewVolatile) as JsonObject;
}
function reader(p: CompiledRequest, request: (p: CompiledRequest) => Promise<TransportResult>) {
  const deadline = performance.now() + 60000;
  let requests = 0,
    bytes = 0;
  return async (path: string, query: JsonObject = {}) => {
    if (++requests > 100 || performance.now() >= deadline)
      fail('Saved-audience review exceeded 100 requests or 60 seconds.', 'LINKEDIN_TEMPLATE_LIMIT');
    const r = await request(read(p, path, query, deadline)),
      d = r.data;
    if (r.status !== 200 || !object(d) || invalidEnvelope(d))
      fail('A saved-audience dependency failed or returned an incomplete/error envelope.');
    bytes += Buffer.byteLength(JSON.stringify(d));
    if (bytes > 8 * 1024 * 1024 || performance.now() >= deadline)
      fail('Saved-audience review exceeded its byte/time bound.', 'LINKEDIN_TEMPLATE_LIMIT');
    return d as JsonObject;
  };
}
async function snapshot(p: CompiledRequest, get: ReturnType<typeof reader>, preflight: boolean): Promise<JsonObject> {
  const selected = await get('/rest/adAccounts/' + p.accountId);
  if (id(selected.id) !== p.accountId || typeof selected.currency !== 'string' || typeof selected.status !== 'string')
    fail('The selected account identity, currency and status are incomplete.');
  const templates: JsonObject = {};
  let start = 0,
    total: number | undefined;
  for (let page = 0; ; page++) {
    if (page >= 20) fail('Template collection exceeded 20 pages.', 'LINKEDIN_TEMPLATE_LIMIT');
    const d = await get(base, {
        q: 'account',
        account: account(p),
        sortField: 'ID',
        sortOrder: 'ASCENDING',
        start,
        count: 100,
      }),
      paging = d.paging;
    if (
      !only(d, ['elements', 'paging', 'metadata']) ||
      (d.metadata !== undefined && !empty(d.metadata)) ||
      !Array.isArray(d.elements) ||
      !only(paging, ['start', 'count', 'total', 'links']) ||
      paging.start !== start ||
      !Number.isSafeInteger(paging.count) ||
      paging.count < 0 ||
      paging.count > 100 ||
      !Array.isArray(paging.links) ||
      d.elements.length > paging.count
    )
      fail('Native paging metadata is required to prove complete template membership.');
    if (paging.total !== undefined) {
      if (!Number.isSafeInteger(paging.total) || paging.total < 0 || (total !== undefined && paging.total !== total))
        fail('Template total changed or was invalid.');
      total = paging.total;
    }
    for (const row of d.elements) {
      const key = id(row?.id);
      if (
        !object(row) ||
        invalidEnvelope(row) ||
        !key ||
        row.account !== account(p) ||
        typeof row.name !== 'string' ||
        !object(row.targetingCriteria) ||
        Object.hasOwn(templates, key)
      )
        fail('Template membership includes a foreign, duplicate or incomplete resource.');
      templates[key!] = configuration({...row, id: key}, true);
    }
    if (Object.keys(templates).length > 1000)
      fail('Review supports at most 1000 saved templates.', 'LINKEDIN_TEMPLATE_LIMIT');
    if (
      paging.links.some(
        (v: unknown) => !object(v) || !['prev', 'next', 'self'].includes(v.rel) || typeof v.href !== 'string',
      )
    )
      fail('Unknown template paging link.');
    const next = paging.links.some((v: JsonObject) => v.rel === 'next');
    if (next && !d.elements.length) fail('Empty pages cannot claim another page.');
    if (total !== undefined) {
      if (start + d.elements.length > total || (start + d.elements.length === total && next))
        fail('Template paging and total disagree.');
      if (start + d.elements.length === total) break;
      if (!d.elements.length) fail('Template membership is incomplete.');
    } else if (!next && (paging.count === 0 || d.elements.length < paging.count)) break;
    start += paging.count;
  }
  if (total !== undefined && Object.keys(templates).length !== total) fail('Template membership is incomplete.');
  if (preflight) {
    if (targets(p).some(key => !Object.hasOwn(templates, key)))
      fail('Every affected template must belong to the selected account.');
    if (linkedinTemplateKind(p) === 'create' && Object.keys(templates).length >= 1000)
      input('Creating another template would exceed complete read-back capacity.');
  }
  const segments: JsonObject = {};
  for (const [key, type] of segmentRefs(p)) {
    const row = await get('/rest/adSegments/' + key);
    if (
      id(row.id) !== key ||
      row.account !== account(p) ||
      typeof row.name !== 'string' ||
      !['READY', 'ARCHIVED'].includes(row.status) ||
      !(type === 'RETARGETING'
        ? row.type === 'RETARGETING'
        : ['BULK', 'MARKET_AUTOMATION', 'BUSINESS_OBJECTIVE_BASED_AUDIENCE'].includes(row.type))
    )
      fail('Matched segments require exact account ownership, compatible facet type and READY or ARCHIVED status.');
    segments[key] = configuration({...row, id: key});
  }
  // The account is kept to its identity (R2.5 M1, the ACCOUNT role): a balance or a version that moves is no change.
  return {
    account: configuration(linkedinAccountState({...selected, id: p.accountId}) as JsonObject),
    templates,
    segments,
  };
}
async function complete(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
  preflight: boolean,
) {
  const get = reader(p, request),
    first = await snapshot(p, get, preflight),
    second = await snapshot(p, get, preflight);
  if (stable(first) !== stable(second))
    fail('The account, templates or segment dependencies changed during collection. Review again.');
  return first;
}
export async function readLinkedInTemplateState(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<unknown[]> {
  assertLinkedInTemplate(p);
  return [await complete(p, request, true)];
}
function receiptId(r: TransportResult) {
  const value = r.headers['x-restli-id'];
  return typeof value === 'string' ? id(value) : undefined;
}
export function linkedinTemplateOutcome(p: CompiledRequest, r: TransportResult, before: unknown[]): boolean {
  const kind = linkedinTemplateKind(p),
    state = before[0] as JsonObject;
  if (kind === 'create') {
    const key = receiptId(r);
    return (
      r.status === 201 && empty(r.data) && !!key && object(state?.templates) && !Object.hasOwn(state.templates, key)
    );
  }
  if (kind !== 'batch_delete') return r.status === 204 && empty(r.data);
  if (
    r.status !== 200 ||
    !only(r.data, ['results', 'errors']) ||
    !object(r.data.results) ||
    (r.data.errors !== undefined && !empty(r.data.errors))
  )
    return false;
  const data = r.data,
    ids = targets(p),
    keys = Object.keys(data.results);
  return (
    keys.length === ids.length &&
    keys.every(key => ids.includes(key) && only(data.results[key], ['status']) && data.results[key].status === 204)
  );
}
export async function verifyLinkedInTemplate(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
  request: (p: CompiledRequest) => Promise<TransportResult>,
) {
  const actual = await complete(p, request, false),
    expected = structuredClone(before[0]) as JsonObject,
    kind = linkedinTemplateKind(p);
  let completeReceipt = true;
  if (kind === 'create') {
    const key = receiptId({status: result.status, headers: result.headers ?? {}, data: result.data});
    if (!key || Object.hasOwn(expected.templates, key)) completeReceipt = false;
    else {
      const row = actual.templates[key];
      expected.templates[key] = {...desired(p), id: key};
      if (row) {
        for (const [field, value] of Object.entries(row))
          if (!Object.hasOwn(expected.templates[key], field)) expected.templates[key][field] = value;
      }
      expected.templates[key] = configuration(expected.templates[key], true);
    }
  } else if (kind === 'update') {
    const key = targets(p)[0]!;
    expected.templates[key] = configuration({...expected.templates[key], ...desired(p)}, true);
  } else for (const key of targets(p)) delete expected.templates[key];
  // A verification compares what the write sent with what is stored: no URL rule (changedComparableFields).
  const fields = changedComparableFields(expected, actual, linkedinReviewVolatile),
    match = completeReceipt && fields.length === 0;
  return {
    status: match ? 'verified' : 'inconclusive',
    checks: [
      {
        description: 'Complete account-scoped saved audiences and referenced segments match the reviewed change',
        matched: match,
        expected_state_hash: comparableStateHash(expected, linkedinReviewVolatile),
        actual_state_hash: comparableStateHash(actual, linkedinReviewVolatile),
        changed_fields: fields,
      },
    ],
  };
}
export const linkedinTemplateImpact = {
  provider: 'linkedin',
  scope: 'saved_audience_templates',
  may_affect_serving: false,
  effect:
    'Saves, edits or removes a reusable account-owned audience definition. Campaign targeting and serving are not changed; applying a template to a campaign requires a separate review.',
  limits:
    '25 deletes, 25 private segments, 500 targeting values, 1000 saved templates, 20 pages per pass, 100 reads, 8 MiB and 60 seconds per state collection. Private segments require explicit selected-account ownership; shared or unowned segments remain unqualified.',
  verification:
    'Complete paginated membership and current account/segment state, read twice. Approximate audience counts and audit timestamps are observations, not configuration. Native eligibility, minimum audience size and creative approval remain provider checks.',
  recovery:
    'An incomplete receipt or lost response retains the original claim. Inspect state and prepare a separate correction; never automatically resubmit an uncertain create or batch.',
};

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinTemplateFamily: ReviewedFamily = defineFamily({
  name: 'linkedin_audience_templates',
  files: ['src/linkedin-audience-templates.ts', ['tests/linkedin-audience-templates.test.mjs']],
  kind: linkedinTemplateKind,
  assert: plan => assertLinkedInTemplate(plan),
  scope: (c, write) => {
    if (!write) assertLinkedInConversionScope(c);
  },
  authorize: (plan, connection, account) => authorizeLinkedInTemplate(plan, connection, account),
  snapshots: linkedinTemplateSnapshots,
  state: (plan, readers) =>
    readLinkedInTemplateState(
      plan,
      readers.guarded(
        'Targeting dependencies must remain read-only.',
        readers.sameLogin('The selected login changed during targeting checks.'),
      ).read,
    ),
  impact: () => linkedinTemplateImpact,
  outcome: linkedinTemplateOutcome,
  verify: (plan, v) =>
    verifyLinkedInTemplate(
      plan,
      v.result,
      v.state,
      v.guarded('Targeting verification must remain read-only.', {
        binding: v.sameLogin('The selected login changed during targeting verification.'),
      }),
    ).then(o => ({status: o.status, checks: o.checks})),
  verifyEveryTime: true,
});
