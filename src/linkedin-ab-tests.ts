import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {fail, readOf} from './family-kit.js';

/**
 * LinkedIn A/B tests, per the "A/B Testing Management API" of the Marketing API (li-lms-2025-10 to li-lms-2026-09, checked
 * 2026-09-27). An experiment of a sponsored account compares exactly two cells, each a campaign of the same campaign group
 * with a traffic weight of 1–99 (summing to 100), over at most 90 days, against a key metric (CPC, CPM, CPV, CPMS) at a
 * confidence of 51–99. POST /rest/adExperiments creates it (201); a PARTIAL_UPDATE sets whole top-level fields: nearly all
 * before it starts, and after it starts only name, description, scheduledEndAt, autoStop, confidence, userIntendedState
 * and cell names and descriptions; an ENDED experiment is immutable. DELETE works only while executionState is PENDING.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {experimentId?: string; campaigns: string[]; optional?: true};
type Read = CompiledRequest & {linkedinAbState?: State; linkedinAbPage?: true};
const origin = 'https://api.linkedin.com',
  day = 86400000;
const metrics = ['CPC', 'CPM', 'CPV', 'CPMS'],
  states = ['ACTIVE', 'CANCELED', 'DRAFT', 'PAUSED'],
  stops = ['AUTO_STOP_AT_END_DATE', 'AUTO_STOP_AT_WINNER', 'AUTO_STOP_DISABLED'];
const fields = [
  'name',
  'description',
  'keyMetric',
  'confidence',
  'scheduledStartAt',
  'scheduledEndAt',
  'userIntendedState',
  'autoStop',
  'cells',
];
const afterStart = ['name', 'description', 'scheduledEndAt', 'autoStop', 'confidence', 'userIntendedState', 'cells'];
const servable = ['ACTIVE', 'PAUSED', 'DRAFT'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    ? String(v)
    : typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v)
      ? v
      : undefined;
function invalid(message: string): never {
  return fail('INVALID_LINKEDIN_AB_TEST', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  if (!/^[1-9][0-9]{0,19}$/.test(p.accountId ?? '')) invalid('Select one sponsored account.');
  return p.accountId!;
};
const accountUrn = (p: CompiledRequest) => 'urn:li:sponsoredAccount:' + account(p);
const campaignId = (urn: unknown) => /^urn:li:sponsoredCampaign:([1-9][0-9]{0,19})$/.exec(String(urn))?.[1];
export function linkedinAbKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== 'linkedin_native_action' || p.specialTransport || (p.origin !== undefined && p.origin !== origin))
    return;
  if (p.method === 'POST' && p.path === '/rest/adExperiments') return 'create';
  if (/^\/rest\/adExperiments\/[1-9][0-9]{0,19}$/.test(p.path))
    return p.method === 'POST' ? 'update' : p.method === 'DELETE' ? 'delete' : undefined;
  return;
}
const experimentOf = (p: CompiledRequest) => p.path.split('/').at(-1)!;
const values = (p: CompiledRequest): JsonObject => {
  const b = object(p.body) ? p.body : {};
  return linkedinAbKind(p) === 'update' ? (object(b.patch) && object(b.patch.$set) ? b.patch.$set : {}) : b;
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
function cells(v: unknown): void {
  if (!Array.isArray(v) || v.length !== 2) invalid('cells lists exactly two cells.');
  let sum = 0;
  const seen = new Set<string>();
  (v as unknown[]).forEach((c, i) => {
    if (
      !object(c) ||
      Object.keys(c).some(k => !['name', 'description', 'trafficWeight', 'reference'].includes(k)) ||
      !object(c.reference) ||
      Object.keys(c.reference).some(k => k !== 'campaign')
    )
      invalid('cells[' + i + '] takes name, description, trafficWeight and reference.campaign.');
    text(c.name, 'cells[' + i + '].name', 99);
    text(c.description, 'cells[' + i + '].description', 499, true);
    if (!Number.isInteger(c.trafficWeight) || c.trafficWeight < 1 || c.trafficWeight > 99)
      invalid('cells[' + i + '].trafficWeight is a whole percent from 1 to 99.');
    const id = campaignId(c.reference.campaign);
    if (!id) invalid('cells[' + i + '].reference.campaign is a sponsored campaign URN.');
    if (seen.has(id!)) invalid('The two cells use different campaigns.');
    seen.add(id!);
    sum += c.trafficWeight;
  });
  if (sum !== 100) invalid('The traffic weights of the cells add up to 100.');
}
export function assertLinkedInAb(p: CompiledRequest): void {
  const kind = linkedinAbKind(p);
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
    (kind === 'delete' && method !== undefined && method !== 'DELETE')
  )
    invalid(
      kind === 'update'
        ? 'An experiment update is a PARTIAL_UPDATE (X-RestLi-Method).'
        : 'The REST.li method must match this ' + p.method + '.',
    );
  if (Object.keys(p.query).length) invalid('Experiment writes take no query parameters.');
  if (kind === 'delete') {
    if (p.body !== undefined && p.body !== null && (!object(p.body) || Object.keys(p.body).length))
      invalid('Deleting an experiment takes no body.');
    return;
  }
  const b = p.body;
  if (!object(b)) invalid('Provide the native experiment body.');
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
      (extra.includes('account') ? 'The account of an experiment never changes. ' : '') +
        'Unqualified fields: ' +
        extra.join(', ') +
        '.',
    );
  if (kind === 'create') {
    if (v.account !== accountUrn(p)) invalid('account is the selected sponsored account.');
    for (const f of [
      'name',
      'keyMetric',
      'confidence',
      'scheduledStartAt',
      'scheduledEndAt',
      'userIntendedState',
      'cells',
    ])
      if (v[f] === undefined) invalid('A new experiment needs ' + f + '.');
    if (!['DRAFT', 'ACTIVE'].includes(v.userIntendedState)) invalid('A new experiment starts DRAFT or ACTIVE.');
  }
  if (v.name !== undefined) text(v.name, 'name', 100);
  text(v.description, 'description', 1000, true);
  if (v.keyMetric !== undefined && !metrics.includes(v.keyMetric)) invalid('keyMetric is CPC, CPM, CPV or CPMS.');
  if (v.confidence !== undefined && (!Number.isInteger(v.confidence) || v.confidence < 51 || v.confidence > 99))
    invalid('confidence is a whole percent from 51 to 99.');
  if (v.userIntendedState !== undefined && !states.includes(v.userIntendedState))
    invalid('userIntendedState is ACTIVE, CANCELED, DRAFT or PAUSED.');
  if (v.autoStop !== undefined && !stops.includes(v.autoStop)) invalid('autoStop is ' + stops.join(', ') + '.');
  for (const f of ['scheduledStartAt', 'scheduledEndAt'])
    if (v[f] !== undefined && (!Number.isSafeInteger(v[f]) || v[f] <= 0))
      invalid(f + ' is an epoch time in milliseconds.');
  if (v.scheduledStartAt !== undefined && v.scheduledEndAt !== undefined) {
    if (v.scheduledEndAt <= v.scheduledStartAt) invalid('scheduledEndAt comes after scheduledStartAt.');
    if (v.scheduledEndAt - v.scheduledStartAt > 90 * day) invalid('An experiment runs for at most 90 days.');
  }
  if (v.scheduledEndAt !== undefined && (v.scheduledEndAt <= Date.now() || v.scheduledEndAt > Date.now() + 180 * day))
    invalid('scheduledEndAt is in the future and at most 180 days ahead.');
  if (v.cells !== undefined) cells(v.cells);
}
export function assertLinkedInAbScope(c: Connection, write = false): void {
  if (!c.scopes.some(s => (write ? s === 'rw_ads' : ['r_ads', 'rw_ads'].includes(s))))
    fail(
      'INSUFFICIENT_SCOPE',
      write ? 'A/B test writes require rw_ads.' : 'A/B test reads require r_ads or rw_ads.',
      {},
      403,
    );
}
function read(p: CompiledRequest, path: string): Read {
  return readOf<Read>(
    p,
    {
      action: 'AMCP_LINKEDIN_AB_READ',
      path,
      query: {},
      headers: {'LinkedIn-Version': p.headers['LinkedIn-Version']!, 'X-Restli-Protocol-Version': '2.0.0'},
    },
    {linkedinAbState: undefined, linkedinAbPage: true},
  );
}
const requestedCampaigns = (p: CompiledRequest) => {
  const v = values(p);
  return Array.isArray(v.cells)
    ? (v.cells as JsonObject[])
        .map(c => campaignId(object(c.reference) ? c.reference.campaign : undefined))
        .filter((x): x is string => !!x)
    : [];
};
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...read(p, '/rest/adAccounts/' + account(p)),
  linkedinAbState: state,
});
export function linkedinAbSnapshots(p: CompiledRequest): Read[] {
  return [
    stateRead(p, {
      ...(linkedinAbKind(p) !== 'create' ? {experimentId: experimentOf(p)} : {}),
      campaigns: requestedCampaigns(p),
    }),
  ];
}
export function isLinkedInAbRead(p: CompiledRequest): p is Read {
  return !!(p as Read).linkedinAbState;
}
/** Writes after validation; server-built reads of the account, its campaigns and an experiment by ID. */
export function authorizeLinkedInAb(p: CompiledRequest, c: Connection, id: string): boolean {
  if (linkedinAbKind(p)) {
    assertLinkedInAb(p);
    assertLinkedInAbScope(c, true);
    return true;
  }
  const internal = p as Read;
  if (
    p.gateway !== 'linkedin_native_action' ||
    !internal.linkedinAbPage ||
    p.action !== 'AMCP_LINKEDIN_AB_READ' ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    Object.keys(p.query).length
  )
    return false;
  assertLinkedInAbScope(c);
  if (
    p.path === '/rest/adAccounts/' + id ||
    new RegExp('^/rest/adAccounts/' + id + '/adCampaigns/[1-9][0-9]*$').test(p.path) ||
    /^\/rest\/adExperiments\/[1-9][0-9]*$/.test(p.path)
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal A/B test read.', {}, 403);
}
const notFound = (e: unknown) => e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND');
const cellView = (c: JsonObject) => ({
  campaign: object(c.reference) ? String(c.reference.campaign) : null,
  name: c.name ?? null,
  description: c.description ?? null,
  trafficWeight: c.trafficWeight ?? null,
});
const sortCells = (list: unknown) =>
  Array.isArray(list)
    ? (list as JsonObject[]).map(cellView).sort((a, b) => String(a.campaign).localeCompare(String(b.campaign)))
    : null;
function experimentView(e: JsonObject): JsonObject {
  return {
    present: true,
    id: numeric(e.id) ?? null,
    account: e.account ?? null,
    name: e.name ?? null,
    description: e.description ?? null,
    keyMetric: e.keyMetric ?? null,
    confidence: e.confidence ?? null,
    scheduledStartAt: e.scheduledStartAt ?? null,
    scheduledEndAt: e.scheduledEndAt ?? null,
    userIntendedState: e.userIntendedState ?? null,
    autoStop: e.autoStop ?? null,
    executionState: e.executionState ?? null,
    cells: sortCells(e.cells),
  };
}
export async function readLinkedInAb(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).linkedinAbState;
  if (!s) return request(p);
  const ok = (r: TransportResult, label: string) => {
    if (r.status !== 200 || !object(r.data)) unverified('LinkedIn did not return the ' + label + '.');
    return r.data as JsonObject;
  };
  const a = ok(await request({...(p as Read), linkedinAbState: undefined} as Read), 'ad account');
  if (numeric(a.id) !== account(p)) unverified('LinkedIn returned another ad account.');
  const out: JsonObject = {account: {id: account(p), status: a.status ?? null}};
  let experiment: JsonObject | null = null;
  if (s.experimentId) {
    try {
      experiment = ok(await request(read(p, '/rest/adExperiments/' + s.experimentId)), 'experiment');
    } catch (e) {
      if (!notFound(e)) throw e;
      if (!s.optional)
        fail(
          'STATE_NOT_FOUND',
          'Experiment ' + s.experimentId + ' is not an experiment LinkedIn can read with this account.',
          {experiment_id: s.experimentId},
          404,
        );
    }
    if (experiment && numeric(experiment.id) !== s.experimentId) unverified('LinkedIn returned another experiment.');
    out.experiment = experiment ? experimentView(experiment) : {present: false, id: s.experimentId};
  }
  if (!s.optional) {
    const ids = new Set(s.campaigns);
    if (experiment && Array.isArray(experiment.cells))
      for (const c of experiment.cells as JsonObject[]) {
        const id = campaignId(object(c.reference) ? c.reference.campaign : undefined);
        if (id) ids.add(id);
      }
    const campaigns: JsonObject = {};
    for (const id of [...ids].sort()) {
      let c: JsonObject | null = null;
      try {
        c = ok(await request(read(p, '/rest/adAccounts/' + account(p) + '/adCampaigns/' + id)), 'campaign');
      } catch (e) {
        if (!notFound(e)) throw e;
      }
      campaigns[id] =
        c && numeric(c.id) === id
          ? {
              present: true,
              account: c.account ?? null,
              campaignGroup: c.campaignGroup ?? null,
              status: c.status ?? null,
            }
          : {present: false};
    }
    out.campaigns = campaigns;
  }
  return {status: 200, headers: {}, data: out};
}
export function validateLinkedInAbState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).linkedinAbState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.account) ||
    !!s.experimentId !== object(d.experiment) ||
    (!s.optional && !object(d.campaigns))
  )
    unverified('Missing verified A/B test state.');
}
export function linkedinAbPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = linkedinAbKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.account) || !object(s.campaigns)) unverified('Missing verified A/B test state.');
  const e = object(s.experiment) ? s.experiment : undefined;
  if (kind !== 'create') {
    if (!e || e.present !== true) unverified('Missing verified A/B test state.');
    if (e.account !== accountUrn(p))
      fail(
        'ACCOUNT_SCOPE_MISMATCH',
        'Experiment ' + experimentOf(p) + ' belongs to another sponsored account.',
        {experiment_id: experimentOf(p)},
        403,
      );
    if (kind === 'delete') {
      if (e.executionState !== 'PENDING')
        invalid(
          'Experiment ' +
            experimentOf(p) +
            ' is ' +
            String(e.executionState) +
            '; LinkedIn deletes only PENDING experiments.',
        );
      return;
    }
    if (e.executionState === 'ENDED') invalid('Experiment ' + experimentOf(p) + ' has ended and can no longer change.');
  }
  const v = values(p),
    started = e && e.executionState !== 'PENDING' && e.executionState !== null;
  if (started) {
    const late = Object.keys(v).filter(k => !afterStart.includes(k));
    if (late.length)
      invalid('Experiment ' + experimentOf(p) + ' has started; ' + late.join(', ') + ' can no longer change.');
    if (v.cells !== undefined) {
      const now = (Array.isArray(e!.cells) ? e!.cells : []) as JsonObject[],
        next = sortCells(v.cells)!;
      if (
        now.length !== next.length ||
        now.some((c, i) => c.campaign !== next[i]!.campaign || c.trafficWeight !== next[i]!.trafficWeight)
      )
        invalid(
          'After the start only the names and descriptions of the cells change; send the same campaigns and weights.',
        );
    }
  }
  const start = Number(v.scheduledStartAt ?? e?.scheduledStartAt),
    end = Number(v.scheduledEndAt ?? e?.scheduledEndAt);
  if (Number.isFinite(start) && Number.isFinite(end) && (end <= start || end - start > 90 * day))
    invalid('The experiment runs after its start and for at most 90 days.');
  if (v.cells !== undefined) {
    const groups = new Set<string>();
    for (const id of requestedCampaigns(p)) {
      const c = (s.campaigns as JsonObject)[id] as JsonObject | undefined;
      if (!object(c) || c.present !== true || (c.account !== undefined && c.account !== accountUrn(p)))
        fail('STATE_NOT_FOUND', 'Campaign ' + id + ' is not a campaign of the selected ad account.', {campaign_id: id});
      if (!servable.includes(String(c!.status)))
        invalid('Campaign ' + id + ' is ' + String(c!.status) + '; experiments use active, paused or draft campaigns.');
      groups.add(String(c!.campaignGroup));
    }
    if (groups.size > 1) invalid('Both campaigns belong to the same campaign group.');
  }
  if (kind === 'update') {
    const changed = Object.keys(v).filter(
      k => stable(k === 'cells' ? sortCells(v.cells) : v[k]) !== stable(e![k] ?? null),
    );
    if (!changed.length) invalid('Experiment ' + experimentOf(p) + ' already has these values.');
  }
}
/** An ACTIVE experiment splits the traffic of its campaigns, which then serve under it. */
export function linkedinAbNeedsConfirmation(p: CompiledRequest): boolean {
  const k = linkedinAbKind(p);
  return k !== undefined && k !== 'delete' && values(p).userIntendedState === 'ACTIVE';
}
export function linkedinAbImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = linkedinAbKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    e = object(s.experiment) ? s.experiment : null,
    v = values(p),
    active = v.userIntendedState === 'ACTIVE';
  return {
    provider: 'linkedin',
    scope: 'ab_test',
    operation: kind,
    before: e,
    after: kind === 'delete' ? null : {...v, ...(v.cells !== undefined ? {cells: sortCells(v.cells)} : {})},
    campaigns: object(s.campaigns) ? s.campaigns : null,
    may_affect_serving: active || kind === 'delete',
    effect:
      kind === 'delete'
        ? 'Deletes the pending experiment; its campaigns are not changed.'
        : active
          ? 'Runs the experiment: traffic of the two campaigns is split by the weights from its start; with AUTO_STOP_DISABLED the campaigns keep running after it ends.'
          : 'Saves the experiment without running it.',
    verification:
      kind === 'delete'
        ? 'Reads the experiment again and expects it to be gone.'
        : 'Reads the experiment again and compares the fields sent.',
    source: 'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/experimentation/ab-testing/ab-testing',
  };
}
export function linkedinAbOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = linkedinAbKind(p)!,
    d = r.data,
    clean = d === null || d === undefined || (object(d) && d.serviceErrorCode === undefined && d.errors === undefined);
  if (kind === 'create')
    return r.status === 201 && clean && !!numeric(String(r.headers?.['x-restli-id'] ?? (object(d) ? d.id : '')));
  return (r.status === 204 || r.status === 200) && clean;
}
export function linkedinAbVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = linkedinAbKind(p)!,
    id =
      kind === 'create' ? numeric(String(result.headers?.['x-restli-id'] ?? result.data?.id ?? '')) : experimentOf(p);
  if (!id) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no experiment to verify.');
  if (kind === 'delete')
    return [
      {
        read: stateRead(p, {experimentId: id, campaigns: [], optional: true}),
        expected: {experiment: {present: false}},
        id: 'experiment ' + id,
      },
    ];
  const v = values(p),
    expected: JsonObject = {
      present: true,
      id,
      ...Object.fromEntries(
        Object.keys(v)
          .filter(k => k !== 'account')
          .map(k => [k, k === 'cells' ? sortCells(v.cells) : v[k]]),
      ),
    };
  return [
    {
      read: stateRead(p, {experimentId: id, campaigns: [], optional: true}),
      expected: {experiment: expected},
      id: 'experiment ' + id,
    },
  ];
}
export function linkedinAbObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {experiment: object(data.experiment) ? data.experiment : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinAbFamily: ReviewedFamily = {
  name: 'linkedin_ab_tests',
  files: ['src/linkedin-ab-tests.ts', ['tests/linkedin-ab-tests.test.mjs']],
  kind: linkedinAbKind,
  assert: assertLinkedInAb,
  scope: assertLinkedInAbScope,
  authorize: authorizeLinkedInAb,
  snapshots: linkedinAbSnapshots,
  isRead: isLinkedInAbRead,
  reader: readLinkedInAb,
  validateState: validateLinkedInAbState,
  prerequisites: linkedinAbPrerequisites,
  impact: linkedinAbImpact,
  outcome: linkedinAbOutcome,
  verification: linkedinAbVerification,
  observed: linkedinAbObserved,
  spendConfirmation: {
    needed: linkedinAbNeedsConfirmation,
    message:
      'An active A/B test splits the traffic of its campaigns, which serve and spend under it. Review it and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: linkedinAbNeedsConfirmation,
};
