import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * LinkedIn Insight Tags, per "Conversion Tracking" of the Marketing API (li-lms-2025-10 to li-lms-2026-09, checked
 * 2026-09-27). POST /rest/insightTags creates the tag of one sponsored account ({sponsoredAccounts: [urn]}; 201 with the
 * ID in x-restli-id); "An account can have only one Insight Tag". A PARTIAL_UPDATE of /rest/insightTags/{id} sets
 * firstPartyTrackingEnabled, a setting that "will propagate to all the accounts with the same Insight Tag"; only an
 * account with FULL access to the tag updates it. Sharing (Insight Tag permissions) and domain blocking stay outside.
 */
type State = {tagId?: string; optional?: true};
type Read = CompiledRequest & {linkedinInsightState?: State; linkedinInsightPage?: true};
const origin = 'https://api.linkedin.com';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    ? String(v)
    : typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v)
      ? v
      : undefined;
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_LINKEDIN_INSIGHT_TAG', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  if (!/^[1-9][0-9]{0,19}$/.test(p.accountId ?? '')) invalid('Select one sponsored account.');
  return p.accountId!;
};
const accountUrn = (p: CompiledRequest) => 'urn:li:sponsoredAccount:' + account(p);
export function linkedinInsightKind(p: CompiledRequest): 'create' | 'update' | undefined {
  if (
    p.gateway !== 'linkedin_native_action' ||
    p.specialTransport ||
    (p.origin !== undefined && p.origin !== origin) ||
    p.method !== 'POST'
  )
    return;
  if (p.path === '/rest/insightTags') return 'create';
  if (/^\/rest\/insightTags\/[1-9][0-9]{0,19}$/.test(p.path)) return 'update';
  return;
}
const tagOf = (p: CompiledRequest) => p.path.split('/').at(-1)!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
const wanted = (p: CompiledRequest) => {
  const b = body(p);
  return object(b.patch) && object(b.patch.$set) ? b.patch.$set.firstPartyTrackingEnabled : undefined;
};
export function assertLinkedInInsight(p: CompiledRequest): void {
  const kind = linkedinInsightKind(p);
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
    (kind === 'update' && method !== 'PARTIAL_UPDATE')
  )
    invalid(
      kind === 'create'
        ? 'Creation uses the collection without method tunneling.'
        : 'An Insight Tag update is a PARTIAL_UPDATE (X-RestLi-Method).',
    );
  if (Object.keys(p.query).length) invalid('Insight Tag writes take no query parameters.');
  const b = p.body;
  if (!object(b)) invalid('Provide the native Insight Tag body.');
  if (kind === 'create') {
    if (
      Object.keys(b).some(k => k !== 'sponsoredAccounts') ||
      !Array.isArray(b.sponsoredAccounts) ||
      b.sponsoredAccounts.length !== 1 ||
      b.sponsoredAccounts[0] !== accountUrn(p)
    )
      invalid(
        'sponsoredAccounts names the selected sponsored account only; LinkedIn fails with several, and sharing uses Insight Tag permissions.',
      );
    return;
  }
  if (
    Object.keys(b).some(k => k !== 'patch') ||
    !object(b.patch) ||
    Object.keys(b.patch).some(k => k !== '$set') ||
    !object(b.patch.$set) ||
    Object.keys(b.patch.$set).some(k => k !== 'firstPartyTrackingEnabled') ||
    typeof b.patch.$set.firstPartyTrackingEnabled !== 'boolean'
  )
    invalid('The patch sets only firstPartyTrackingEnabled (true or false).');
}
export function assertLinkedInInsightScope(c: Connection, write = false): void {
  if (!c.scopes.some(s => (write ? s === 'rw_ads' : ['r_ads', 'rw_ads'].includes(s))))
    fail(
      'INSUFFICIENT_SCOPE',
      write ? 'Insight Tag writes require rw_ads.' : 'Insight Tag reads require r_ads or rw_ads.',
      {},
      403,
    );
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): Read {
  return {
    ...p,
    action: 'AMCP_LINKEDIN_INSIGHT_READ',
    method: 'GET',
    path,
    query,
    body: undefined,
    headers: {'LinkedIn-Version': p.headers['LinkedIn-Version']!, 'X-Restli-Protocol-Version': '2.0.0'},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    linkedinInsightState: undefined,
    linkedinInsightPage: true,
  };
}
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...read(p, '/rest/adAccounts/' + account(p)),
  linkedinInsightState: state,
});
export function linkedinInsightSnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p, linkedinInsightKind(p) === 'update' ? {tagId: tagOf(p)} : {})];
}
export function isLinkedInInsightRead(p: CompiledRequest): p is Read {
  return !!(p as Read).linkedinInsightState;
}
/** Writes after validation; server-built reads of the account, its Insight Tag finder, its permission and a tag by ID. */
export function authorizeLinkedInInsight(p: CompiledRequest, c: Connection, id: string): boolean {
  if (linkedinInsightKind(p)) {
    assertLinkedInInsight(p);
    assertLinkedInInsightScope(c, true);
    return true;
  }
  const internal = p as Read;
  if (
    p.gateway !== 'linkedin_native_action' ||
    !internal.linkedinInsightPage ||
    p.action !== 'AMCP_LINKEDIN_INSIGHT_READ' ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined
  )
    return false;
  assertLinkedInInsightScope(c);
  const q = Object.keys(p.query),
    urn = 'urn:li:sponsoredAccount:' + id;
  if (!q.length && (p.path === '/rest/adAccounts/' + id || /^\/rest\/insightTags\/[1-9][0-9]*$/.test(p.path)))
    return true;
  if (
    ['/rest/insightTags', '/rest/insightTagsPermission'].includes(p.path) &&
    p.query.q === 'account' &&
    p.query.account === urn &&
    q.every(k => ['q', 'account'].includes(k))
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal Insight Tag read.', {}, 403);
}
const notFound = (e: unknown) => e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND');
const tagView = (t: JsonObject) => ({
  id: numeric(t.id) ?? null,
  accounts: Array.isArray(t.sponsoredAccounts) ? [...t.sponsoredAccounts].map(String).sort() : [],
  firstPartyTrackingEnabled: typeof t.firstPartyTrackingEnabled === 'boolean' ? t.firstPartyTrackingEnabled : null,
});
export async function readLinkedInInsight(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).linkedinInsightState;
  if (!s) return request(p);
  const ok = (r: TransportResult, label: string) => {
    if (r.status !== 200 || !object(r.data)) unverified('LinkedIn did not return the ' + label + '.');
    return r.data as JsonObject;
  };
  const a = ok(await request({...(p as Read), linkedinInsightState: undefined} as Read), 'ad account');
  if (numeric(a.id) !== account(p)) unverified('LinkedIn returned another ad account.');
  const urn = accountUrn(p),
    out: JsonObject = {account: {id: account(p), status: a.status ?? null}};
  const finder = ok(
    await request(read(p, '/rest/insightTags', {q: 'account', account: urn})),
    'Insight Tags of the account',
  );
  if (!Array.isArray(finder.elements) || finder.elements.length > 1)
    unverified('LinkedIn listed more than one Insight Tag for the account.');
  out.accountTag =
    finder.elements.length && object(finder.elements[0]) ? tagView(finder.elements[0] as JsonObject) : null;
  if (s.tagId) {
    let t: JsonObject | null = null;
    try {
      t = ok(await request(read(p, '/rest/insightTags/' + s.tagId)), 'Insight Tag');
    } catch (e) {
      if (!notFound(e)) throw e;
      if (!s.optional)
        fail(
          'STATE_NOT_FOUND',
          'Insight Tag ' + s.tagId + ' is not readable with this account.',
          {insight_tag_id: s.tagId},
          404,
        );
    }
    if (t && numeric(t.id) !== s.tagId) unverified('LinkedIn returned another Insight Tag.');
    out.tag = t ? {present: true, ...tagView(t)} : {present: false, id: s.tagId};
    const perm = ok(
      await request(read(p, '/rest/insightTagsPermission', {q: 'account', account: urn})),
      'Insight Tag permission',
    );
    const rows = Array.isArray(perm.elements) ? (perm.elements as unknown[]).filter(object) : [];
    out.role =
      rows
        .map(r => ({tag: String(r.insightTag ?? ''), role: r.accessRole ?? r.role ?? null}))
        .find(r => r.tag.endsWith(':' + s.tagId))?.role ?? null;
  }
  return {status: 200, headers: {}, data: out};
}
export function validateLinkedInInsightState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).linkedinInsightState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || !object(d.account) || !('accountTag' in d) || !!s.tagId !== object(d.tag))
    unverified('Missing verified Insight Tag state.');
}
export function linkedinInsightPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = linkedinInsightKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.account)) unverified('Missing verified Insight Tag state.');
  if (kind === 'create') {
    if (object(s.accountTag))
      fail(
        'CONFIGURATION_EXISTS',
        'The ad account already has Insight Tag ' + String(s.accountTag.id) + '; an account has only one.',
        {insight_tag_id: String(s.accountTag.id)},
      );
    return;
  }
  const t = s.tag;
  if (!object(t) || t.present !== true) unverified('Missing verified Insight Tag state.');
  if (!object(s.accountTag) || s.accountTag.id !== tagOf(p))
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'Insight Tag ' + tagOf(p) + ' is not the tag of the selected ad account.',
      {insight_tag_id: tagOf(p)},
      403,
    );
  if (s.role !== 'FULL')
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'The selected ad account has ' +
        String(s.role ?? 'no') +
        ' access to Insight Tag ' +
        tagOf(p) +
        '; only FULL access updates it.',
      {insight_tag_id: tagOf(p)},
      403,
    );
  if (t.firstPartyTrackingEnabled === wanted(p))
    invalid(
      'Insight Tag ' + tagOf(p) + ' already has first-party tracking ' + (wanted(p) ? 'enabled' : 'disabled') + '.',
    );
}
export function linkedinInsightImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = linkedinInsightKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    t = object(s.tag) ? s.tag : null,
    shared = t && Array.isArray(t.accounts) ? t.accounts : [];
  return {
    provider: 'linkedin',
    scope: 'insight_tag',
    operation: kind,
    before: t,
    after: kind === 'create' ? {accounts: [accountUrn(p)]} : {firstPartyTrackingEnabled: wanted(p)},
    shared_with: shared,
    may_affect_serving: false,
    effect:
      kind === 'create'
        ? 'Creates the Insight Tag of the ad account; it tracks nothing until its code is placed on the site.'
        : 'Turns first-party cookie tracking ' +
          (wanted(p) ? 'on' : 'off') +
          ' for the tag and every ad account that shares it' +
          (shared.length > 1 ? ' (' + shared.join(', ') + ')' : '') +
          '; conversion and audience signals may change.',
    verification:
      kind === 'create'
        ? 'Finds the Insight Tag of the account again and compares its ID.'
        : 'Reads the tag again and compares firstPartyTrackingEnabled.',
    source: 'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversion-tracking',
  };
}
export function linkedinInsightOutcome(p: CompiledRequest, r: TransportResult): boolean {
  if (linkedinInsightKind(p) === 'update') return r.status === 204 || r.status === 200;
  return r.status === 201 && !!numeric(String(r.headers?.['x-restli-id'] ?? (object(r.data) ? r.data.id : '')));
}
export function linkedinInsightVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  if (linkedinInsightKind(p) === 'update')
    return [
      {
        read: stateRead(p, {tagId: tagOf(p), optional: true}),
        expected: {tag: {present: true, id: tagOf(p), firstPartyTrackingEnabled: wanted(p)}},
        id: 'Insight Tag ' + tagOf(p),
      },
    ];
  const id = numeric(String(result.headers?.['x-restli-id'] ?? result.data?.id ?? ''));
  if (!id) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no Insight Tag to verify.');
  return [{read: stateRead(p, {}), expected: {accountTag: {id, accounts: [accountUrn(p)]}}, id: 'Insight Tag ' + id}];
}
export function linkedinInsightObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {
    accountTag: object(data.accountTag) ? data.accountTag : {present: false},
    ...(object(data.tag) ? {tag: data.tag} : {}),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinInsightFamily: ReviewedFamily = {
  name: 'linkedin_insight_tags',
  files: ['src/linkedin-insight-tags.ts', ['tests/linkedin-insight-tags.test.mjs']],
  kind: linkedinInsightKind,
  assert: assertLinkedInInsight,
  scope: assertLinkedInInsightScope,
  authorize: authorizeLinkedInInsight,
  snapshots: linkedinInsightSnapshots,
  isRead: isLinkedInInsightRead,
  reader: readLinkedInInsight,
  validateState: validateLinkedInInsightState,
  prerequisites: linkedinInsightPrerequisites,
  impact: linkedinInsightImpact,
  outcome: linkedinInsightOutcome,
  verification: linkedinInsightVerification,
  observed: linkedinInsightObserved,
  exemptFromSpendTextMatch: true,
};
