import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * LinkedIn engagement retargeting audiences, per LinkedIn's Engagement Retargeting and DMP Segments pages (Microsoft
 * Learn, li-lms-2026-09, read 2026-09-30). Engagement Retargeting names rw_ads (and page roles for company pages):
 * - POST /rest/dmpSegments creates a segment of the sponsored account (201, x-restli-id), type USER, with the source
 *   platform of the engagement it collects (VIDEO_ADS, LEAD_GEN_FORMS, SINGLE_IMAGE_ADS, DOCUMENT_ADS, CONVERSATION_ADS,
 *   and others AMCP does not qualify yet) and the LINKEDIN destination. An account holds at most 1,000 segments.
 *   A PARTIAL_UPDATE changes only name, description and sourceSegmentId. DELETE removes the segment "altogether",
 *   with its destinations and "the corresponding Ad segment"; a BATCH_DELETE takes ids=List(...).
 * - POST /rest/dmpSegments/{id}/engagementRules adds a rule (201, x-restli-id), or several with BATCH_CREATE and
 *   {elements}: an engagement source (a campaign, for the ad platforms), a trigger
 *   urn:li:dmpEngagementTrigger:(urn:li:dmpEngagementSourceType:{type},{trigger}) and a lookback in days. Rules of one
 *   segment share trigger, lookback and source type, and a source appears once. DELETE removes a rule, or several
 *   with BATCH_DELETE and ids=List(...).
 * Segments that carry uploaded people (list uploads, streaming) stay outside: they fall under the personal-data policy
 * and need rw_dmp_segments. Company pages, events and website sources need page roles or other permissions AMCP does
 * not check yet.
 */
type Kind = 'create' | 'update' | 'delete' | 'deleteMany' | 'addRules' | 'deleteRule' | 'deleteRules';
type State = {
  segments: string[];
  campaigns: string[];
  rules?: true;
  usage?: true;
  optional?: true;
  sources?: string[];
  absent?: string[];
};
type Read = CompiledRequest & {linkedinEngagementState?: State; linkedinEngagementPage?: true};
const origin = 'https://api.linkedin.com',
  marker = 'AMCP_LINKEDIN_ENGAGEMENT_READ',
  source =
    'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/engagement-retargeting',
  maxIds = 25,
  pageSize = 1000,
  maxPages = 5;
/** The documented triggers and longest lookback of each source type AMCP qualifies (campaign sources). */
const platforms: Record<string, {triggers: string[]; lookbacks: number[]}> = {
  VIDEO_ADS: {
    triggers: ['FIRST_QUARTILE', 'MIDPOINT', 'THIRD_QUARTILE', 'FULL_COMPLETE'],
    lookbacks: [30, 60, 90, 180, 365],
  },
  LEAD_GEN_FORMS: {triggers: ['VIEW_FORM', 'LEAD_FORM_SUBMIT'], lookbacks: [30, 60, 90, 180, 365]},
  SINGLE_IMAGE_ADS: {triggers: ['CLICK', 'ENGAGEMENT'], lookbacks: [30, 60, 90, 180, 365]},
  DOCUMENT_ADS: {triggers: ['CLICK', 'ENGAGEMENT', 'DOWNLOAD_CLICK'], lookbacks: [30, 60, 90, 180, 365]},
  CONVERSATION_ADS: {triggers: ['OPEN', 'ANY_CTA_CLICK'], lookbacks: [30, 60, 90, 180, 365]},
};
const liveStatuses = ['ACTIVE', 'PAUSED', 'DRAFT'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    ? String(v)
    : typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v)
      ? v
      : undefined;
const campaignId = (urn: unknown) => /^urn:li:sponsoredCampaign:([1-9][0-9]{0,19})$/.exec(String(urn))?.[1];
const triggerOf = (urn: unknown) =>
  /^urn:li:dmpEngagementTrigger:\(urn:li:dmpEngagementSourceType:([A-Z_]+),([A-Z_]+)\)$/.exec(String(urn));
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_LINKEDIN_ENGAGEMENT_AUDIENCE', message, {source});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  if (!/^[1-9][0-9]{0,19}$/.test(p.accountId ?? '')) invalid('Select one sponsored account.');
  return p.accountId!;
};
const accountUrn = (p: CompiledRequest) => 'urn:li:sponsoredAccount:' + account(p);
export function linkedinEngagementKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== 'linkedin_native_action' || p.specialTransport || (p.origin !== undefined && p.origin !== origin))
    return;
  if (p.path === '/rest/dmpSegments')
    return p.method === 'POST' ? 'create' : p.method === 'DELETE' ? 'deleteMany' : undefined;
  if (/^\/rest\/dmpSegments\/[1-9][0-9]{0,19}$/.test(p.path))
    return p.method === 'POST' ? 'update' : p.method === 'DELETE' ? 'delete' : undefined;
  if (/^\/rest\/dmpSegments\/[1-9][0-9]{0,19}\/engagementRules$/.test(p.path))
    return p.method === 'POST' ? 'addRules' : p.method === 'DELETE' ? 'deleteRules' : undefined;
  if (
    p.method === 'DELETE' &&
    /^\/rest\/dmpSegments\/[1-9][0-9]{0,19}\/engagementRules\/[1-9][0-9]{0,19}$/.test(p.path)
  )
    return 'deleteRule';
  return;
}
const segmentOf = (p: CompiledRequest) => p.path.split('/')[3]!;
/** IDs of a batch deletion: ids=List(...) or repeated ids. */
function idsOf(p: CompiledRequest): string[] {
  const raw = p.query.ids,
    list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw],
    out: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string' && typeof v !== 'number') invalid('ids lists numeric IDs.');
    const m = /^List\((.*)\)$/.exec(String(v));
    for (const part of m ? m[1]!.split(',') : [String(v)]) if (part.trim()) out.push(part.trim());
  }
  return out;
}
/** The rules a creation sends: one rule, or {elements: [...]} with BATCH_CREATE. */
function rulesOf(p: CompiledRequest): JsonObject[] {
  const b = object(p.body) ? p.body : {};
  return Array.isArray(b.elements) ? (b.elements as JsonObject[]) : [b];
}
const values = (p: CompiledRequest): JsonObject => {
  const b = object(p.body) ? p.body : {};
  return linkedinEngagementKind(p) === 'update' ? (object(b.patch) && object(b.patch.$set) ? b.patch.$set : {}) : b;
};
function text(v: unknown, label: string, max: number, optional = false): void {
  if (optional && v === undefined) return;
  if (
    typeof v !== 'string' ||
    (!optional && !v.trim()) ||
    v !== v.trim() ||
    [...v].length > max ||
    /[\u0000-\u001f]/.test(v)
  )
    invalid(
      label +
        ' has ' +
        (optional ? 'up to ' : '1–') +
        max +
        ' characters without surrounding spaces or control characters.',
    );
}
function rule(v: unknown, i: number): {campaign: string; type: string; trigger: string; days: number} {
  const at = 'Rule ' + (i + 1);
  if (!object(v) || Object.keys(v).sort().join() !== 'engagementSource,engagementTrigger,timeFrame')
    invalid(at + ' takes engagementSource, engagementTrigger and timeFrame.');
  const campaign = campaignId(v.engagementSource);
  if (!campaign)
    invalid(
      at +
        ': engagementSource is a sponsored campaign of the account. Company pages, events and websites are not qualified.',
    );
  const t = triggerOf(v.engagementTrigger),
    spec = t ? platforms[t[1]!] : undefined;
  if (!t || !spec || !spec.triggers.includes(t[2]!))
    invalid(
      at +
        ': engagementTrigger is urn:li:dmpEngagementTrigger:(urn:li:dmpEngagementSourceType:{type},{trigger}) for ' +
        Object.entries(platforms)
          .map(([k, s]) => k + ' (' + s.triggers.join(', ') + ')')
          .join('; ') +
        '.',
    );
  const span = object(v.timeFrame) ? v.timeFrame.timeSpan : undefined;
  if (
    !object(v.timeFrame) ||
    Object.keys(v.timeFrame).join() !== 'timeSpan' ||
    !object(span) ||
    Object.keys(span).sort().join() !== 'duration,unit' ||
    span.unit !== 'DAY' ||
    !spec!.lookbacks.includes(span.duration as number)
  )
    invalid(
      at +
        ': timeFrame.timeSpan is {duration, unit: "DAY"} with a lookback of ' +
        spec!.lookbacks.join(', ') +
        ' days.',
    );
  return {campaign: campaign!, type: t![1]!, trigger: t![2]!, days: (span as JsonObject).duration as number};
}
export function assertLinkedInEngagement(p: CompiledRequest): void {
  const kind = linkedinEngagementKind(p);
  if (!kind) return;
  account(p);
  const method = p.headers['X-RestLi-Method']?.toUpperCase();
  if (
    Object.keys(p.headers).some(
      k => !['LinkedIn-Version', 'X-Restli-Protocol-Version', 'X-RestLi-Method'].includes(k),
    ) ||
    p.headers['X-Restli-Protocol-Version'] !== '2.0.0' ||
    !/^20\d{4}$/.test(p.headers['LinkedIn-Version'] ?? '')
  )
    invalid('Use the native versioned REST.li 2.0 contract without other headers.');
  const batchRules = kind === 'addRules' && Array.isArray((object(p.body) ? p.body : {}).elements);
  const expected: Record<Kind, (string | undefined)[]> = {
    create: [undefined, 'CREATE'],
    update: ['PARTIAL_UPDATE'],
    delete: [undefined, 'DELETE'],
    deleteMany: ['BATCH_DELETE'],
    addRules: batchRules ? ['BATCH_CREATE'] : [undefined, 'CREATE'],
    deleteRule: [undefined, 'DELETE'],
    deleteRules: ['BATCH_DELETE'],
  };
  if (!expected[kind].includes(method))
    invalid(
      'The REST.li method of this request is ' +
        expected[kind].filter(Boolean).join(' or ') +
        (expected[kind].includes(undefined) ? ' (or none)' : '') +
        ' (restli_method).',
    );
  if (kind === 'deleteMany' || kind === 'deleteRules') {
    if (Object.keys(p.query).some(k => k !== 'ids')) invalid('A batch deletion takes only ids=List(...).');
    const ids = idsOf(p);
    if (!ids.length || ids.length > maxIds || ids.some(id => !numeric(id)) || new Set(ids).size !== ids.length)
      invalid('ids lists 1–' + maxIds + ' distinct numeric IDs.');
  } else if (Object.keys(p.query).length) invalid('These writes take no query parameters.');
  if (['delete', 'deleteMany', 'deleteRule', 'deleteRules'].includes(kind)) {
    if (p.body !== undefined && p.body !== null && (!object(p.body) || Object.keys(p.body).length))
      invalid('A deletion takes no body.');
    return;
  }
  const b = p.body;
  if (!object(b)) invalid('Provide the native body.');
  if (kind === 'addRules') {
    if (batchRules && Object.keys(b).length !== 1) invalid('A batch of rules is {elements: [...]}.');
    const list = rulesOf(p);
    if (!list.length || list.length > maxIds) invalid('Send 1–' + maxIds + ' rules.');
    const parsed = list.map(rule);
    if (new Set(parsed.map(r => r.campaign)).size !== parsed.length) invalid('Each campaign is a source once.');
    if (new Set(parsed.map(r => r.type + ',' + r.trigger + ',' + r.days)).size !== 1)
      invalid('The rules of a segment share one trigger and one lookback.');
    return;
  }
  if (kind === 'update') {
    if (
      Object.keys(b).some(k => k !== 'patch') ||
      !object(b.patch) ||
      Object.keys(b.patch).some(k => k !== '$set') ||
      !object(b.patch.$set) ||
      !Object.keys(b.patch.$set).length
    )
      invalid('The patch sets whole top-level fields with $set.');
    const extra = Object.keys(values(p)).filter(k => !['name', 'description', 'sourceSegmentId'].includes(k));
    if (extra.length)
      invalid('LinkedIn updates only name, description and sourceSegmentId; unqualified: ' + extra.join(', ') + '.');
  }
  const v = values(p);
  if (kind === 'create') {
    const extra = Object.keys(v).filter(
      k => !['name', 'description', 'account', 'type', 'sourcePlatform', 'destinations', 'sourceSegmentId'].includes(k),
    );
    if (extra.length) invalid('Unqualified fields: ' + extra.join(', ') + '.');
    if (v.account !== accountUrn(p)) invalid('account is the selected sponsored account.');
    if (v.type !== 'USER') invalid('An engagement segment has type USER.');
    if (!platforms[v.sourcePlatform as string])
      invalid(
        'sourcePlatform is the engagement source: ' +
          Object.keys(platforms).join(', ') +
          '. List uploads and streaming segments carry people and are not qualified.',
      );
    if (stable(v.destinations) !== stable([{destination: 'LINKEDIN'}]))
      invalid('destinations is [{destination: "LINKEDIN"}], the only one LinkedIn accepts.');
    if (v.name === undefined) invalid('A new segment needs a name.');
  }
  if (v.name !== undefined) text(v.name, 'name', 200);
  text(v.description, 'description', 1000, true);
  text(v.sourceSegmentId, 'sourceSegmentId', 200, true);
}
export function assertLinkedInEngagementScope(c: Connection, write = false): void {
  if (!c.scopes.some(s => (write ? s === 'rw_ads' : ['r_ads', 'rw_ads'].includes(s))))
    fail(
      'INSUFFICIENT_SCOPE',
      write ? 'Engagement audience writes require rw_ads.' : 'Engagement audience reads require r_ads or rw_ads.',
      {},
      403,
    );
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): Read {
  return {
    ...p,
    action: marker,
    method: 'GET',
    path,
    query: query as CompiledRequest['query'],
    body: undefined,
    headers: {'LinkedIn-Version': p.headers['LinkedIn-Version']!, 'X-Restli-Protocol-Version': '2.0.0'},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    linkedinEngagementState: undefined,
    linkedinEngagementPage: true,
  };
}
const usageQuery = (token?: string) => ({
  q: 'search',
  search: {status: {values: liveStatuses}},
  pageSize,
  ...(token ? {pageToken: token} : {}),
});
const rulesQuery = {start: '0', count: '100'};
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...read(p, '/rest/adAccounts/' + account(p)),
  linkedinEngagementState: state,
});
function segmentsOf(p: CompiledRequest): string[] {
  const kind = linkedinEngagementKind(p)!;
  return kind === 'create' ? [] : kind === 'deleteMany' ? idsOf(p) : [segmentOf(p)];
}
export function linkedinEngagementSnapshots(p: CompiledRequest): Read[] {
  const kind = linkedinEngagementKind(p)!;
  return [
    stateRead(p, {
      segments: segmentsOf(p),
      campaigns:
        kind === 'addRules'
          ? rulesOf(p)
              .map(r => campaignId(r.engagementSource)!)
              .filter(Boolean)
          : [],
      ...(['addRules', 'deleteRule', 'deleteRules'].includes(kind) ? {rules: true as const} : {}),
      ...(['delete', 'deleteMany'].includes(kind) ? {usage: true as const} : {}),
    }),
  ];
}
export function isLinkedInEngagementRead(p: CompiledRequest): p is Read {
  return !!(p as Read).linkedinEngagementState;
}
/** Writes after validation; server-built reads of the account, its campaigns, segments and their rules. */
export function authorizeLinkedInEngagement(p: CompiledRequest, c: Connection, id: string): boolean {
  if (linkedinEngagementKind(p)) {
    assertLinkedInEngagement(p);
    assertLinkedInEngagementScope(c, true);
    return true;
  }
  const internal = p as Read;
  if (
    p.gateway !== 'linkedin_native_action' ||
    !internal.linkedinEngagementPage ||
    p.action !== marker ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    p.accountId !== id
  )
    return false;
  assertLinkedInEngagementScope(c);
  if (p.path === '/rest/adAccounts/' + id + '/adCampaigns') {
    const token = typeof p.query.pageToken === 'string' ? p.query.pageToken : undefined;
    if (stable(p.query) === stable(usageQuery(token))) return true;
  } else if (/^\/rest\/dmpSegments\/[1-9][0-9]*\/engagementRules$/.test(p.path)) {
    if (stable(p.query) === stable(rulesQuery)) return true;
  } else if (
    !Object.keys(p.query).length &&
    (p.path === '/rest/adAccounts/' + id ||
      new RegExp('^/rest/adAccounts/' + id + '/adCampaigns/[1-9][0-9]*$').test(p.path) ||
      /^\/rest\/dmpSegments\/[1-9][0-9]*$/.test(p.path))
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal engagement audience read.', {}, 403);
}
const notFound = (e: unknown) => e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND');
const adSegmentOf = (s: JsonObject) =>
  Array.isArray(s.destinations)
    ? ((s.destinations as JsonObject[]).find(d => object(d) && typeof d.destinationSegmentId === 'string')
        ?.destinationSegmentId as string | undefined)
    : undefined;
function segmentView(s: JsonObject): JsonObject {
  return {
    present: true,
    id: numeric(s.id) ?? null,
    account: s.account ?? null,
    name: s.name ?? null,
    description: s.description ?? null,
    sourceSegmentId: s.sourceSegmentId ?? null,
    type: s.type ?? null,
    sourcePlatform: s.sourcePlatform ?? null,
    adSegment: adSegmentOf(s) ?? null,
    status: Array.isArray(s.destinations) && object(s.destinations[0]) ? (s.destinations[0].status ?? null) : null,
  };
}
const ruleView = (r: JsonObject) => ({
  id: numeric(r.id) ?? null,
  engagementSource: r.engagementSource ?? null,
  engagementTrigger: r.engagementTrigger ?? null,
  days: object(r.timeFrame) && object(r.timeFrame.timeSpan) ? (r.timeFrame.timeSpan.duration ?? null) : null,
});
export async function readLinkedInEngagement(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).linkedinEngagementState;
  if (!s) return request(p);
  const get = async (path: string, label: string, query: JsonObject = {}): Promise<JsonObject | null> => {
    let r: TransportResult;
    try {
      r = await request(read(p, path, query));
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
    if (r.status !== 200 || !object(r.data) || r.data.serviceErrorCode !== undefined)
      unverified('LinkedIn did not return the ' + label + '.');
    return r.data as JsonObject;
  };
  const a = await get('/rest/adAccounts/' + account(p), 'ad account');
  if (!a || numeric(a.id) !== account(p)) unverified('LinkedIn returned another ad account.');
  const out: JsonObject = {account: {id: account(p), status: a!.status ?? null}, segments: {}, campaigns: {}};
  for (const id of s.segments) {
    const d = await get('/rest/dmpSegments/' + id, 'segment ' + id);
    if (d && numeric(d.id) !== id) unverified('LinkedIn returned another segment than ' + id + '.');
    (out.segments as JsonObject)[id] = d ? segmentView(d) : {present: false};
    if (s.rules && d) {
      const list = await get(
        '/rest/dmpSegments/' + id + '/engagementRules',
        'engagement rules of segment ' + id,
        rulesQuery,
      );
      if (!list || !Array.isArray(list.elements)) unverified('LinkedIn did not return the engagement rules.');
      const total = object(list!.paging) ? Number(list!.paging.total ?? list!.elements.length) : list!.elements.length;
      if (list!.elements.length >= Number(rulesQuery.count) || total > list!.elements.length)
        unverified('Segment ' + id + ' has more engagement rules than AMCP reads in one page.');
      (out.segments as JsonObject)[id] = {
        ...segmentView(d),
        rules: (list!.elements as JsonObject[]).filter(object).map(ruleView),
      };
    }
  }
  if (s.optional) return {status: 200, headers: {}, data: out};
  for (const id of [...new Set(s.campaigns)].sort()) {
    const c = await get('/rest/adAccounts/' + account(p) + '/adCampaigns/' + id, 'campaign ' + id);
    (out.campaigns as JsonObject)[id] =
      c && numeric(c.id) === id
        ? {present: true, account: c.account ?? null, status: c.status ?? null}
        : {present: false};
  }
  if (s.usage) {
    const targets = new Set(
      Object.values(out.segments as JsonObject)
        .map(v => (object(v) ? v.adSegment : null))
        .filter((x): x is string => typeof x === 'string'),
    );
    const using: JsonObject[] = [];
    let token: string | undefined,
      pages = 0;
    do {
      const page = await get(
        '/rest/adAccounts/' + account(p) + '/adCampaigns',
        'campaigns of the account',
        usageQuery(token),
      );
      if (!page || !Array.isArray(page.elements)) unverified('LinkedIn did not return the campaigns of the account.');
      for (const c of page!.elements as JsonObject[]) {
        const criteria = JSON.stringify(c?.targetingCriteria ?? null);
        for (const t of targets)
          if (criteria.includes('"' + t + '"'))
            using.push({campaign: numeric(c.id) ?? null, name: c.name ?? null, adSegment: t});
      }
      token =
        object(page!.metadata) && typeof page!.metadata.nextPageToken === 'string'
          ? page!.metadata.nextPageToken
          : undefined;
      if (++pages >= maxPages && token)
        unverified(
          'The account has more than ' + maxPages * pageSize + ' live campaigns; AMCP could not check them all.',
        );
    } while (token);
    out.usage = using;
  }
  return {status: 200, headers: {}, data: out};
}
export function validateLinkedInEngagementState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).linkedinEngagementState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.account) ||
    !object(d.segments) ||
    (s.usage && !s.optional && !Array.isArray(d.usage))
  )
    unverified('Missing verified engagement audience state.');
}
export function linkedinEngagementPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = linkedinEngagementKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.segments) || !object(s.campaigns))
    unverified('Missing verified engagement audience state.');
  for (const id of segmentsOf(p)) {
    const g = (s.segments as JsonObject)[id];
    if (!object(g) || g.present !== true)
      fail(
        'STATE_NOT_FOUND',
        'Segment ' + id + ' is not a segment LinkedIn can read with this account.',
        {segment_id: id},
        404,
      );
    if (g.account !== accountUrn(p))
      fail('ACCOUNT_SCOPE_MISMATCH', 'Segment ' + id + ' belongs to another sponsored account.', {segment_id: id}, 403);
    if (!platforms[String(g.sourcePlatform)] || g.type !== 'USER')
      invalid(
        'Segment ' +
          id +
          ' is a ' +
          String(g.sourcePlatform) +
          ' segment; AMCP changes only engagement segments of ' +
          Object.keys(platforms).join(', ') +
          '. Segments of uploaded people fall under the personal-data policy.',
      );
    if (kind === 'addRules') {
      const rules = Array.isArray(g.rules) ? (g.rules as JsonObject[]) : [],
        sent = rulesOf(p).map(rule);
      const type = sent[0]!.type;
      if (type !== g.sourcePlatform)
        invalid(
          'Segment ' + id + ' collects ' + String(g.sourcePlatform) + ' engagement; its rules use that source type.',
        );
      if (rules.length) {
        const first = rules[0]!,
          t = triggerOf(first.engagementTrigger);
        if (!t || t[2] !== sent[0]!.trigger || first.days !== sent[0]!.days)
          invalid(
            'The rules of segment ' +
              id +
              ' use ' +
              String(first.engagementTrigger) +
              ' over ' +
              String(first.days) +
              ' days; new rules share them.',
          );
      }
      const taken = new Set(rules.map(r => campaignId(r.engagementSource)));
      const repeated = sent.filter(r => taken.has(r.campaign)).map(r => r.campaign);
      if (repeated.length) invalid('Segment ' + id + ' already has rules for campaigns ' + repeated.join(', ') + '.');
      for (const r of sent) {
        const c = (s.campaigns as JsonObject)[r.campaign];
        if (!object(c) || c.present !== true || (c.account !== undefined && c.account !== accountUrn(p)))
          fail('STATE_NOT_FOUND', 'Campaign ' + r.campaign + ' is not a campaign of the selected ad account.', {
            campaign_id: r.campaign,
          });
      }
    }
    if (kind === 'deleteRule' || kind === 'deleteRules') {
      const have = new Set((Array.isArray(g.rules) ? (g.rules as JsonObject[]) : []).map(r => String(r.id)));
      const wanted = kind === 'deleteRule' ? [p.path.split('/').at(-1)!] : idsOf(p);
      const missing = wanted.filter(w => !have.has(w));
      if (missing.length)
        fail('STATE_NOT_FOUND', 'Segment ' + id + ' has no engagement rules ' + missing.join(', ') + '.', {
          rules: missing,
        });
    }
    if (kind === 'update') {
      const v = values(p),
        changed = Object.keys(v).filter(k => stable(v[k]) !== stable(g[k] ?? null));
      if (!changed.length) invalid('Segment ' + id + ' already has these values.');
    }
  }
  if (kind === 'delete' || kind === 'deleteMany') {
    const using = Array.isArray(s.usage) ? (s.usage as JsonObject[]) : [];
    if (using.length)
      invalid(
        'Campaigns still target these audiences: ' +
          using.map(u => String(u.campaign) + ' (' + String(u.adSegment) + ')').join(', ') +
          '. Remove the audience from their targeting first; deleting the segment also deletes its ad segment.',
      );
  }
}
export function linkedinEngagementImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = linkedinEngagementKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    segments = object(s.segments) ? s.segments : {};
  const effect: Record<Kind, string> = {
    create:
      'Creates an empty engagement audience of the account. It collects members once engagement rules are added; LinkedIn may take up to 48 hours to build it and 24 more before it serves.',
    update: 'Renames or re-describes the audience; its members and rules do not change.',
    delete: 'Deletes the audience with its destinations and its ad segment. No live campaign targets it.',
    deleteMany: 'Deletes the audiences with their destinations and ad segments. No live campaign targets them.',
    addRules:
      'Adds engagement rules: members who engaged with these campaigns in the lookback join the audience, and campaigns that target it reach them.',
    deleteRule: 'Removes the engagement rule; members it brought in leave the audience as it rebuilds.',
    deleteRules: 'Removes the engagement rules; members they brought in leave the audience as it rebuilds.',
  };
  return {
    provider: 'linkedin',
    scope: 'engagement_audience',
    operation: kind,
    segments,
    ...(kind === 'addRules' ? {rules: rulesOf(p).map(ruleView), campaigns: s.campaigns ?? null} : {}),
    ...(kind === 'create' || kind === 'update' ? {after: values(p)} : {}),
    ...(['deleteRules'].includes(kind) ? {rules_removed: idsOf(p)} : {}),
    effect: effect[kind],
    verification:
      kind === 'delete' || kind === 'deleteMany'
        ? 'Reads the segments again and expects them gone.'
        : kind === 'addRules' || kind === 'deleteRule' || kind === 'deleteRules'
          ? 'Reads the rules of the segment again.'
          : 'Reads the segment again and compares the fields sent.',
    source,
  };
}
const createdId = (r: TransportResult | JsonObject) =>
  numeric(String((r.headers as JsonObject | undefined)?.['x-restli-id'] ?? (object(r.data) ? r.data.id : '')));
export function linkedinEngagementOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = linkedinEngagementKind(p)!,
    d = r.data,
    clean = d === null || d === undefined || (object(d) && d.serviceErrorCode === undefined && d.errors === undefined);
  if (kind === 'create') return r.status === 201 && clean && !!createdId(r);
  if (kind === 'addRules') {
    if (!Array.isArray((object(p.body) ? p.body : {}).elements)) return r.status === 201 && clean && !!createdId(r);
    const rows = object(d) && Array.isArray(d.elements) ? (d.elements as JsonObject[]) : [];
    return (
      r.status === 200 && rows.length === rulesOf(p).length && rows.every(e => object(e) && Number(e.status) === 201)
    );
  }
  if (kind === 'deleteMany' || kind === 'deleteRules') {
    if (r.status === 204 && clean) return true;
    const body = object(d) ? d : {},
      results = object(body.results) ? body.results : undefined;
    return (
      r.status === 200 &&
      !!results &&
      (!object(body.errors) || !Object.keys(body.errors).length) &&
      idsOf(p).every(id => object(results[id]) && Number((results[id] as JsonObject).status) === 204)
    );
  }
  return (r.status === 204 || r.status === 200) && clean;
}
export function linkedinEngagementVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = linkedinEngagementKind(p)!;
  const again = (segments: string[], extra: Partial<State> = {}) =>
    stateRead(p, {segments, campaigns: [], optional: true, ...extra});
  if (kind === 'create') {
    const id = createdId(result as unknown as TransportResult);
    if (!id) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no segment to verify.');
    const v = values(p);
    return [
      {
        read: again([id!]),
        expected: {
          segments: {
            [id!]: {
              present: true,
              account: v.account,
              name: v.name,
              type: v.type,
              sourcePlatform: v.sourcePlatform,
              ...(v.description !== undefined ? {description: v.description} : {}),
            },
          },
        },
        id: 'segment ' + id,
      },
    ];
  }
  if (kind === 'update')
    return [
      {
        read: again([segmentOf(p)]),
        expected: {segments: {[segmentOf(p)]: {present: true, ...values(p)}}},
        id: 'segment ' + segmentOf(p),
      },
    ];
  if (kind === 'delete' || kind === 'deleteMany')
    return segmentsOf(p).map(id => ({
      read: again([id]),
      expected: {segments: {[id]: {present: false}}},
      id: 'segment ' + id,
    }));
  const id = segmentOf(p);
  if (kind === 'addRules') {
    const sources = rulesOf(p)
      .map(r => String(r.engagementSource))
      .sort();
    return [
      {
        read: again([id], {rules: true, sources}),
        expected: {rules_present: sources},
        id: 'engagement rules of segment ' + id,
      },
    ];
  }
  const removed = kind === 'deleteRule' ? [p.path.split('/').at(-1)!] : idsOf(p);
  return [
    {
      read: again([id], {rules: true, absent: removed}),
      expected: {rules_absent: removed},
      id: 'engagement rules of segment ' + id,
    },
  ];
}
export function linkedinEngagementObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const s = (read as Read).linkedinEngagementState,
    segments = object(data.segments) ? data.segments : {},
    only = Object.values(segments)[0],
    rules = object(only) && Array.isArray(only.rules) ? (only.rules as JsonObject[]) : null;
  if (s?.sources) {
    const have = new Set(rules?.map(r => String(r.engagementSource)));
    return {rules_present: rules ? s.sources.filter(x => have.has(x)) : null};
  }
  if (s?.absent) {
    const have = new Set(rules?.map(r => String(r.id)));
    return {rules_absent: rules ? s.absent.filter(x => !have.has(x)) : null};
  }
  return {segments};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinEngagementFamily: ReviewedFamily = {
  name: 'linkedin_engagement_audiences',
  files: ['src/linkedin-engagement-audiences.ts', ['tests/linkedin-engagement-audiences.test.mjs']],
  kind: linkedinEngagementKind,
  assert: assertLinkedInEngagement,
  scope: assertLinkedInEngagementScope,
  authorize: authorizeLinkedInEngagement,
  snapshots: linkedinEngagementSnapshots,
  isRead: isLinkedInEngagementRead,
  reader: readLinkedInEngagement,
  validateState: validateLinkedInEngagementState,
  prerequisites: linkedinEngagementPrerequisites,
  impact: linkedinEngagementImpact,
  outcome: linkedinEngagementOutcome,
  verification: linkedinEngagementVerification,
  observed: linkedinEngagementObserved,
  exemptFromSpendTextMatch: true,
  exemptFromActivationScan: true,
  activates: () => false,
  destructive: p => ['delete', 'deleteMany', 'deleteRule', 'deleteRules'].includes(linkedinEngagementKind(p) ?? ''),
};
