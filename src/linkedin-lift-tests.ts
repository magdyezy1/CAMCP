import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail, readOf} from './family-kit.js';

/**
 * LinkedIn brand lift tests, per the Brand Lift Testing pages of the Marketing API (Overview, Lift Test Management API,
 * Lift Test Survey Management API; li-lms-2025-10 to li-lms-2026-09, read 2026-09-30):
 * - POST /rest/adLiftTests creates a test (201, x-restli-id) of the sponsored account, on the whole account
 *   (liftEntity.account) or, from 202511, on up to 50 campaign groups (liftEntity.campaignGroups). The schedule starts at
 *   00:00 UTC and ends at 23:45 UTC, in the future and within 180 days, running 3 to 90 days. Names and brand names have
 *   1–200 characters, descriptions up to 1,000.
 * - A PARTIAL_UPDATE ($set of whole top-level fields) changes a test. Before it starts nearly everything but the account
 *   changes; once scheduled or started only name, description, schedule (not its start) and userState; an ENDED test is
 *   immutable. userState READY "sends Lift Test for review and activates it on schedule.start date", needs survey
 *   questions, and ends the account's ENDED_RESUMABLE tests; CANCELED "is not reversible".
 * - DELETE removes a test, and DELETE .../adLiftTestSurveys?ids=List(...) its survey questions, only before it is
 *   scheduled ("A scheduled lift test is not allowed be deleted"). The pages name that state PENDING, which is not among
 *   the documented execution states; AMCP accepts CREATED, the state of a test not yet validated, or PENDING.
 * Creating survey questions stays blocked: the page shows no request body (src/withheld-writes.ts).
 */
type Kind = 'create' | 'update' | 'delete' | 'surveys';
type State = {testId?: string; groups: string[]; surveys?: true; resumable?: true; optional?: true; absent?: string[]};
type Read = CompiledRequest & {linkedinLiftState?: State; linkedinLiftPage?: true};
const origin = 'https://api.linkedin.com',
  marker = 'AMCP_LINKEDIN_LIFT_READ',
  source =
    'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/experimentation/brand-lift-testing/ad-lift-tests',
  day = 86400000,
  quarter = 15 * 60000;
const metrics = [
  'AWARENESS',
  'RECALL',
  'FAMILIARITY',
  'FAVORABILITY',
  'RECOMMENDATION',
  'CONSIDERATION',
  'EMPLOYER_FAMILIARITY',
  'EMPLOYER_FAVORABILITY',
  'EMPLOYER_RECOMMENDATION',
  'EMPLOYER_CONSIDERATION',
  'TOP_OF_MIND',
];
const fields = ['name', 'brandName', 'brandNameLocale', 'description', 'schedule', 'userState', 'liftEntity'],
  afterScheduling = ['name', 'description', 'schedule', 'userState'],
  draftStates = ['CREATED', 'PENDING'],
  gone = ['CANCELED', 'REMOVED', 'PENDING_DELETION'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    ? String(v)
    : typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v)
      ? v
      : undefined;
function invalid(message: string): never {
  return fail('INVALID_LINKEDIN_LIFT_TEST', message, {source});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  if (!/^[1-9][0-9]{0,19}$/.test(p.accountId ?? '')) invalid('Select one sponsored account.');
  return p.accountId!;
};
const accountUrn = (p: CompiledRequest) => 'urn:li:sponsoredAccount:' + account(p);
const groupId = (urn: unknown) => /^urn:li:sponsoredCampaignGroup:([1-9][0-9]{0,19})$/.exec(String(urn))?.[1];
export function linkedinLiftKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== 'linkedin_native_action' || p.specialTransport || (p.origin !== undefined && p.origin !== origin))
    return;
  if (p.method === 'POST' && p.path === '/rest/adLiftTests') return 'create';
  if (/^\/rest\/adLiftTests\/[1-9][0-9]{0,19}$/.test(p.path))
    return p.method === 'POST' ? 'update' : p.method === 'DELETE' ? 'delete' : undefined;
  if (p.method === 'DELETE' && /^\/rest\/adLiftTests\/[1-9][0-9]{0,19}\/adLiftTestSurveys$/.test(p.path))
    return 'surveys';
  return;
}
const testOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const values = (p: CompiledRequest): JsonObject => {
  const b = object(p.body) ? p.body : {};
  return linkedinLiftKind(p) === 'update' ? (object(b.patch) && object(b.patch.$set) ? b.patch.$set : {}) : b;
};
/** The survey questions of a deletion: ids=List(...) or repeated ids. */
function metricsOf(p: CompiledRequest): string[] {
  const raw = p.query.ids,
    list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw],
    out: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string') invalid('ids lists survey questions by key metric.');
    const m = /^List\((.*)\)$/.exec(v);
    for (const part of m ? m[1]!.split(',') : [v]) if (part.trim()) out.push(part.trim());
  }
  return out;
}
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
const version = (p: CompiledRequest) => Number(p.headers['LinkedIn-Version']);
function entity(p: CompiledRequest, v: unknown): void {
  if (!object(v) || Object.keys(v).length !== 1) invalid('liftEntity names the account or its campaign groups.');
  if ('account' in v) {
    if (v.account !== accountUrn(p)) invalid('liftEntity.account is the selected sponsored account.');
    return;
  }
  if ('campaignGroup' in v)
    invalid(
      'liftEntity.campaignGroup is the 202510 form; send campaignGroups, a list, with LinkedIn-Version 202511 or later.',
    );
  if (!('campaignGroups' in v) || !Array.isArray(v.campaignGroups) || !v.campaignGroups.length)
    invalid('liftEntity is {account} or {campaignGroups: [...]}.');
  if (version(p) < 202511) invalid('liftEntity.campaignGroups needs LinkedIn-Version 202511 or later.');
  const list = v.campaignGroups as unknown[];
  if (list.length > 50) invalid('A lift test covers at most 50 campaign groups.');
  const ids = list.map(groupId);
  if (ids.some(id => !id)) invalid('liftEntity.campaignGroups lists sponsored campaign group URNs.');
  if (new Set(ids).size !== ids.length) invalid('liftEntity.campaignGroups lists each campaign group once.');
}
function schedule(v: unknown, now: number): {start: number; end: number} {
  if (
    !object(v) ||
    Object.keys(v).sort().join() !== 'end,start' ||
    !Number.isSafeInteger(v.start) ||
    !Number.isSafeInteger(v.end)
  )
    invalid('schedule is {start, end} in epoch milliseconds.');
  const start = v.start as number,
    end = v.end as number;
  if (end % day !== day - quarter) invalid('schedule.end is at 23:45 UTC.');
  if (end <= now || end > now + 180 * day) invalid('schedule.end is in the future and within 180 days.');
  if (end - start + quarter < 3 * day) invalid('A lift test runs for at least 3 days.');
  if (end - start > 90 * day) invalid('A lift test runs for at most 90 days.');
  return {start, end};
}
function checkStart(start: number, now: number): void {
  if (start % day !== 0) invalid('schedule.start is at 00:00 UTC.');
  if (start <= now || start > now + 180 * day) invalid('schedule.start is in the future and within 180 days.');
}
export function assertLinkedInLift(p: CompiledRequest): void {
  const kind = linkedinLiftKind(p);
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
  if (
    (kind === 'create' && method !== undefined && method !== 'CREATE') ||
    (kind === 'update' && method !== 'PARTIAL_UPDATE') ||
    (kind === 'delete' && method !== undefined && method !== 'DELETE') ||
    (kind === 'surveys' && method !== undefined && method !== 'BATCH_DELETE')
  )
    invalid(
      kind === 'update'
        ? 'A lift test update is a PARTIAL_UPDATE (X-RestLi-Method).'
        : 'The REST.li method must match this ' + p.method + '.',
    );
  if (kind === 'surveys') {
    if (Object.keys(p.query).some(k => k !== 'ids')) invalid('A survey deletion takes only ids=List(...).');
    const ids = metricsOf(p);
    if (!ids.length || ids.some(m => !metrics.includes(m)) || new Set(ids).size !== ids.length)
      invalid('ids lists survey questions once each by key metric: ' + metrics.join(', ') + '.');
  } else if (Object.keys(p.query).length) invalid('Lift test writes take no query parameters.');
  if (kind === 'delete' || kind === 'surveys') {
    if (p.body !== undefined && p.body !== null && (!object(p.body) || Object.keys(p.body).length))
      invalid('A deletion takes no body.');
    return;
  }
  const b = p.body;
  if (!object(b)) invalid('Provide the native lift test body.');
  if (
    kind === 'update' &&
    (Object.keys(b).some(k => k !== 'patch') ||
      !object(b.patch) ||
      Object.keys(b.patch).some(k => k !== '$set') ||
      !object(b.patch.$set) ||
      !Object.keys(b.patch.$set).length)
  )
    invalid('The patch sets whole top-level fields with $set.');
  const v = values(p),
    allowed = kind === 'create' ? ['account', ...fields] : fields,
    extra = Object.keys(v).filter(k => !allowed.includes(k));
  if (extra.length)
    invalid(
      (extra.includes('account') ? 'The account of a lift test never changes. ' : '') +
        'Unqualified fields: ' +
        extra.join(', ') +
        '.',
    );
  const now = Date.now();
  if (kind === 'create') {
    if (v.account !== accountUrn(p)) invalid('account is the selected sponsored account.');
    for (const f of ['name', 'brandName', 'brandNameLocale', 'schedule', 'userState', 'liftEntity'])
      if (v[f] === undefined) invalid('A new lift test needs ' + f + '.');
    if (v.userState !== 'DRAFT')
      invalid('A new lift test starts as DRAFT: survey questions come first, then an update to READY.');
    checkStart((v.schedule as JsonObject)?.start as number, now);
  }
  if (v.name !== undefined) text(v.name, 'name', 200);
  if (v.brandName !== undefined) text(v.brandName, 'brandName', 200);
  text(v.description, 'description', 1000, true);
  if (
    v.brandNameLocale !== undefined &&
    (!object(v.brandNameLocale) ||
      Object.keys(v.brandNameLocale).sort().join() !== 'country,language' ||
      !/^[a-z]{2}$/.test(String(v.brandNameLocale.language)) ||
      !/^[A-Z]{2}$/.test(String(v.brandNameLocale.country)))
  )
    invalid('brandNameLocale is {language, country}: a lowercase ISO 639 and an uppercase ISO 3166 code.');
  if (v.userState !== undefined && !['DRAFT', 'READY', 'CANCELED'].includes(v.userState as string))
    invalid('userState is DRAFT, READY or CANCELED.');
  if (v.schedule !== undefined) schedule(v.schedule, now);
  if (v.liftEntity !== undefined) entity(p, v.liftEntity);
}
export function assertLinkedInLiftScope(c: Connection, write = false): void {
  if (!c.scopes.some(s => (write ? s === 'rw_ads' : ['r_ads', 'rw_ads'].includes(s))))
    fail(
      'INSUFFICIENT_SCOPE',
      write ? 'Lift test writes require rw_ads.' : 'Lift test reads require r_ads or rw_ads.',
      {},
      403,
    );
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): Read {
  return readOf<Read>(
    p,
    {
      action: marker,
      path,
      query: query as CompiledRequest['query'],
      headers: {'LinkedIn-Version': p.headers['LinkedIn-Version']!, 'X-Restli-Protocol-Version': '2.0.0'},
    },
    {linkedinLiftState: undefined, linkedinLiftPage: true},
  );
}
const resumableQuery = (p: CompiledRequest) => ({
  q: 'criteria',
  account: accountUrn(p),
  executionState: 'ENDED_RESUMABLE',
  start: '0',
  count: '100',
});
const requestedGroups = (p: CompiledRequest) => {
  const e = values(p).liftEntity;
  return object(e) && Array.isArray(e.campaignGroups)
    ? (e.campaignGroups as unknown[]).map(groupId).filter((x): x is string => !!x)
    : [];
};
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...read(p, '/rest/adAccounts/' + account(p)),
  linkedinLiftState: state,
});
export function linkedinLiftSnapshots(p: CompiledRequest): Read[] {
  const kind = linkedinLiftKind(p)!,
    ready = kind === 'update' && values(p).userState === 'READY';
  return [
    stateRead(p, {
      ...(kind !== 'create' ? {testId: testOf(p)} : {}),
      groups: requestedGroups(p),
      ...(ready || kind === 'surveys' ? {surveys: true as const} : {}),
      ...(ready ? {resumable: true as const} : {}),
    }),
  ];
}
export function isLinkedInLiftRead(p: CompiledRequest): p is Read {
  return !!(p as Read).linkedinLiftState;
}
/** Writes after validation; server-built reads of the account, its campaign groups, a lift test and its surveys. */
export function authorizeLinkedInLift(p: CompiledRequest, c: Connection, id: string): boolean {
  if (linkedinLiftKind(p)) {
    assertLinkedInLift(p);
    assertLinkedInLiftScope(c, true);
    return true;
  }
  const internal = p as Read;
  if (
    p.gateway !== 'linkedin_native_action' ||
    !internal.linkedinLiftPage ||
    p.action !== marker ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined
  )
    return false;
  assertLinkedInLiftScope(c);
  if (p.path === '/rest/adLiftTests') {
    if (p.accountId === id && stable(p.query) === stable(resumableQuery(p))) return true;
  } else if (
    !Object.keys(p.query).length &&
    (p.path === '/rest/adAccounts/' + id ||
      new RegExp('^/rest/adAccounts/' + id + '/adCampaignGroups/[1-9][0-9]*$').test(p.path) ||
      /^\/rest\/adLiftTests\/[1-9][0-9]*(\/adLiftTestSurveys)?$/.test(p.path))
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal lift test read.', {}, 403);
}
const notFound = (e: unknown) => e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND');
const sortGroups = (e: unknown) =>
  object(e) && Array.isArray(e.campaignGroups)
    ? {campaignGroups: [...(e.campaignGroups as string[])].map(String).sort()}
    : object(e)
      ? e
      : null;
function testView(t: JsonObject): JsonObject {
  return {
    present: true,
    id: numeric(t.id) ?? null,
    account: t.account ?? null,
    name: t.name ?? null,
    brandName: t.brandName ?? null,
    brandNameLocale: t.brandNameLocale ?? null,
    description: t.description ?? null,
    schedule: t.schedule ?? null,
    userState: t.userState ?? null,
    executionState: t.executionState ?? null,
    liftEntity: sortGroups(t.liftEntity),
    reviewStatus: object(t.reviewInfo) ? (t.reviewInfo.reviewStatus ?? null) : null,
  };
}
export async function readLinkedInLift(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).linkedinLiftState;
  if (!s) return request(p);
  const ok = (r: TransportResult, label: string) => {
    if (r.status !== 200 || !object(r.data)) unverified('LinkedIn did not return the ' + label + '.');
    return r.data as JsonObject;
  };
  const a = ok(await request({...(p as Read), linkedinLiftState: undefined} as Read), 'ad account');
  if (numeric(a.id) !== account(p)) unverified('LinkedIn returned another ad account.');
  const out: JsonObject = {account: {id: account(p), status: a.status ?? null}};
  let test: JsonObject | null = null;
  if (s.testId) {
    try {
      test = ok(await request(read(p, '/rest/adLiftTests/' + s.testId)), 'lift test');
    } catch (e) {
      if (!notFound(e)) throw e;
      if (!s.optional)
        fail(
          'STATE_NOT_FOUND',
          'Lift test ' + s.testId + ' is not a lift test LinkedIn can read with this account.',
          {lift_test_id: s.testId},
          404,
        );
    }
    if (test && numeric(test.id) !== s.testId) unverified('LinkedIn returned another lift test.');
    out.test = test ? testView(test) : {present: false, id: s.testId};
  }
  if (s.surveys && s.testId && test) {
    const list = ok(await request(read(p, '/rest/adLiftTests/' + s.testId + '/adLiftTestSurveys')), 'survey list');
    if (!Array.isArray(list.elements)) unverified('LinkedIn did not return the survey list.');
    out.surveys = (list.elements as JsonObject[])
      .filter(object)
      .map(e => String(e.id))
      .sort();
  }
  if (s.resumable) {
    const list = ok(await request(read(p, '/rest/adLiftTests', resumableQuery(p))), 'lift tests of the account');
    const rows = Array.isArray(list.elements) ? (list.elements as JsonObject[]).filter(object) : undefined,
      total = object(list.paging) ? Number(list.paging.total ?? rows?.length) : rows?.length;
    if (!rows || total !== rows.length) unverified('LinkedIn did not return every resumable lift test of the account.');
    out.resumable = rows
      .filter(r => r.account === accountUrn(p) && numeric(r.id) !== s.testId)
      .map(r => ({id: numeric(r.id) ?? null, name: r.name ?? null}));
  }
  if (!s.optional) {
    const groups: JsonObject = {};
    for (const id of [...new Set(s.groups)].sort()) {
      let g: JsonObject | null = null;
      try {
        g = ok(await request(read(p, '/rest/adAccounts/' + account(p) + '/adCampaignGroups/' + id)), 'campaign group');
      } catch (e) {
        if (!notFound(e)) throw e;
      }
      groups[id] =
        g && numeric(g.id) === id
          ? {present: true, account: g.account ?? null, status: g.status ?? null}
          : {present: false};
    }
    out.groups = groups;
  }
  return {status: 200, headers: {}, data: out};
}
export function validateLinkedInLiftState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).linkedinLiftState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.account) ||
    !!s.testId !== object(d.test) ||
    (!s.optional && !object(d.groups))
  )
    unverified('Missing verified lift test state.');
}
export function linkedinLiftPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = linkedinLiftKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.account) || !object(s.groups)) unverified('Missing verified lift test state.');
  const t = object(s.test) ? s.test : undefined;
  if (kind !== 'create') {
    if (!t || t.present !== true) unverified('Missing verified lift test state.');
    if (t.account !== accountUrn(p))
      fail(
        'ACCOUNT_SCOPE_MISMATCH',
        'Lift test ' + testOf(p) + ' belongs to another sponsored account.',
        {lift_test_id: testOf(p)},
        403,
      );
    if (kind === 'delete' || kind === 'surveys') {
      if (!draftStates.includes(String(t.executionState)))
        invalid(
          'Lift test ' +
            testOf(p) +
            ' is ' +
            String(t.executionState) +
            '; LinkedIn deletes a test or its questions only before it is scheduled.',
        );
      if (kind === 'surveys') {
        const have = Array.isArray(s.surveys) ? (s.surveys as string[]) : [],
          missing = metricsOf(p).filter(m => !have.includes(m));
        if (missing.length) invalid('Lift test ' + testOf(p) + ' has no question for ' + missing.join(', ') + '.');
      }
      return;
    }
    if (t.executionState === 'ENDED') invalid('Lift test ' + testOf(p) + ' has ended and can no longer change.');
    if (t.userState === 'CANCELED') invalid('Lift test ' + testOf(p) + ' is canceled and can no longer change.');
  }
  const v = values(p),
    scheduled = !!t && !draftStates.includes(String(t.executionState));
  if (scheduled) {
    const late = Object.keys(v).filter(k => !afterScheduling.includes(k));
    if (late.length)
      invalid(
        'Lift test ' + testOf(p) + ' is ' + String(t!.executionState) + '; ' + late.join(', ') + ' no longer change.',
      );
  }
  if (kind === 'update') {
    const now = Date.now(),
      before = object(t!.schedule) ? t!.schedule : {};
    if (v.schedule !== undefined) {
      const next = v.schedule as JsonObject;
      if (scheduled && next.start !== before.start)
        invalid('Lift test ' + testOf(p) + ' is scheduled; its start no longer changes. Send the same schedule.start.');
      if (!scheduled) checkStart(next.start as number, now);
    }
    if (v.userState === 'DRAFT' && t!.userState !== 'DRAFT')
      invalid('A lift test goes from DRAFT to READY or CANCELED, never back to DRAFT.');
    if (v.userState === 'READY') {
      if (t!.userState !== 'DRAFT') invalid('Only a DRAFT lift test becomes READY.');
      const questions = Array.isArray(s.surveys) ? s.surveys.length : 0;
      if (!questions || questions > 6)
        invalid(
          'Lift test ' +
            testOf(p) +
            ' has ' +
            questions +
            ' survey questions; LinkedIn activates a test with one to six. Add them in Campaign Manager first.',
        );
      const start = Number((object(v.schedule) ? v.schedule : before).start);
      if (!(start > now)) invalid('The schedule starts in the past; move it to a future day first.');
    }
    const changed = Object.keys(v).filter(
      k => stable(k === 'liftEntity' ? sortGroups(v[k]) : v[k]) !== stable((t as JsonObject)[k] ?? null),
    );
    if (!changed.length) invalid('Lift test ' + testOf(p) + ' already has these values.');
  }
  for (const id of requestedGroups(p)) {
    const g = (s.groups as JsonObject)[id] as JsonObject | undefined;
    if (!object(g) || g.present !== true || (g.account !== undefined && g.account !== accountUrn(p)))
      fail('STATE_NOT_FOUND', 'Campaign group ' + id + ' is not a campaign group of the selected ad account.', {
        campaign_group_id: id,
      });
    if (gone.includes(String(g.status)))
      invalid(
        'Campaign group ' +
          id +
          ' is ' +
          String(g.status) +
          '; LinkedIn ends a lift test whose campaign group is gone.',
      );
  }
}
/** READY sends the test for review and, from its start, splits the audience of its campaigns into test and control. */
export function linkedinLiftActivates(p: CompiledRequest): boolean {
  return linkedinLiftKind(p) === 'update' && values(p).userState === 'READY';
}
export function linkedinLiftImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = linkedinLiftKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    t = object(s.test) ? s.test : null,
    v = values(p),
    ready = v.userState === 'READY',
    cancel = v.userState === 'CANCELED';
  return {
    provider: 'linkedin',
    scope: 'lift_test',
    operation: kind,
    before: t,
    after:
      kind === 'delete' || kind === 'surveys'
        ? null
        : {...v, ...(v.liftEntity !== undefined ? {liftEntity: sortGroups(v.liftEntity)} : {})},
    ...(kind === 'surveys' ? {questions_removed: metricsOf(p), questions_now: s.surveys ?? null} : {}),
    ...(ready ? {questions: s.surveys ?? null, resumable_tests_ended: s.resumable ?? []} : {}),
    campaign_groups: object(s.groups) && Object.keys(s.groups).length ? s.groups : null,
    may_affect_serving: ready || cancel,
    effect:
      kind === 'delete'
        ? 'Deletes the lift test before it is scheduled; its campaigns are not changed.'
        : kind === 'surveys'
          ? 'Removes the survey questions from the lift test before it is scheduled.'
          : ready
            ? 'Sends the lift test for review and runs it from its start: members are split into a test group that can see the ads and a control group that cannot, and surveys go to both. Any of the account’s ended tests that could still resume end for good.'
            : cancel
              ? 'Cancels the lift test. This cannot be undone: every field of the test becomes read-only.'
              : 'Saves the lift test without running it.',
    advice:
      'LinkedIn suggests a test of at least two weeks with campaigns that use their budgets fully; a result is not guaranteed to be conclusive.',
    verification:
      kind === 'delete'
        ? 'Reads the lift test again and expects it to be gone.'
        : kind === 'surveys'
          ? 'Reads the survey questions again and expects these to be gone.'
          : 'Reads the lift test again and compares the fields sent.',
    source,
  };
}
export function linkedinLiftOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = linkedinLiftKind(p)!,
    d = r.data,
    clean = d === null || d === undefined || (object(d) && d.serviceErrorCode === undefined && d.errors === undefined);
  if (kind === 'create')
    return r.status === 201 && clean && !!numeric(String(r.headers?.['x-restli-id'] ?? (object(d) ? d.id : '')));
  if (kind === 'surveys') {
    if (r.status === 204 && clean) return true;
    if (r.status !== 200 || !object(d) || !object(d.results)) return false;
    const results = d.results as JsonObject;
    return (
      (!object(d.errors) || !Object.keys(d.errors).length) &&
      metricsOf(p).every(m => object(results[m]) && [200, 204].includes(Number(results[m].status)))
    );
  }
  return (r.status === 204 || r.status === 200) && clean;
}
export function linkedinLiftVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = linkedinLiftKind(p)!,
    id = kind === 'create' ? numeric(String(result.headers?.['x-restli-id'] ?? result.data?.id ?? '')) : testOf(p);
  if (!id) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no lift test to verify.');
  const again = (extra: Partial<State> = {}) => stateRead(p, {testId: id, groups: [], optional: true, ...extra});
  if (kind === 'delete') return [{read: again(), expected: {test: {present: false}}, id: 'lift test ' + id}];
  if (kind === 'surveys')
    return [
      {
        read: again({surveys: true, absent: metricsOf(p)}),
        expected: {surveys_absent: metricsOf(p)},
        id: 'lift test ' + id + ' survey questions',
      },
    ];
  const v = values(p),
    expected: JsonObject = {
      present: true,
      id,
      ...Object.fromEntries(
        Object.keys(v)
          .filter(k => k !== 'account')
          .map(k => [k, k === 'liftEntity' ? sortGroups(v.liftEntity) : v[k]]),
      ),
    };
  return [{read: again(), expected: {test: expected}, id: 'lift test ' + id}];
}
export function linkedinLiftObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const s = (read as Read).linkedinLiftState;
  if (s?.absent) {
    const have = Array.isArray(data.surveys) ? (data.surveys as string[]) : null;
    return {surveys_absent: have ? s.absent.filter(m => !have.includes(m)) : null};
  }
  return {test: object(data.test) ? data.test : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinLiftFamily: ReviewedFamily = defineFamily({
  name: 'linkedin_lift_tests',
  files: ['src/linkedin-lift-tests.ts', ['tests/linkedin-lift-tests.test.mjs']],
  kind: linkedinLiftKind,
  assert: assertLinkedInLift,
  scope: assertLinkedInLiftScope,
  authorize: authorizeLinkedInLift,
  snapshots: linkedinLiftSnapshots,
  isRead: isLinkedInLiftRead,
  reader: readLinkedInLift,
  validateState: validateLinkedInLiftState,
  prerequisites: linkedinLiftPrerequisites,
  impact: linkedinLiftImpact,
  outcome: linkedinLiftOutcome,
  verification: linkedinLiftVerification,
  observed: linkedinLiftObserved,
  spendConfirmation: {
    needed: linkedinLiftActivates,
    message:
      'A READY lift test splits the audience of its campaigns into test and control groups from its start. Review it and provide spend_change_confirmed=true.',
  },
  warnings: p =>
    values(p).userState === 'CANCELED'
      ? ['Canceling a lift test cannot be undone: every field becomes read-only.']
      : [],
  exemptFromSpendTextMatch: true,
  activates: linkedinLiftActivates,
  destructive: p => ['delete', 'surveys'].includes(linkedinLiftKind(p) ?? ''),
});
