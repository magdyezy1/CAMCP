import {MirrorError} from './errors.js';
import {parseLinkedInValue, linkedinQuery} from './linkedin-restli.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * LinkedIn Insight Tag domains, per "Conversion Tracking" of the Marketing API (li-lms-2025-10 to li-lms-2026-09, checked
 * 2026-09-27). LinkedIn fills the domains of a tag from its traffic; each is keyed (account, domainName). POST
 * /rest/insightTagDomains/{key} with {patch: {$set: {blocked}}} blocks or allows one (204); a BATCH_PARTIAL_UPDATE of
 * /rest/insightTagDomains?ids=List(...) with {entities: {key: {patch}}} updates several (200, results and errors). Only
 * FULL access to the tag updates domains, and blocking "may impact associated conversions, website audiences and website
 * professional demographics".
 */
type Key = {account: string; domainName: string};
type State = {domains: string[]; optional?: true};
type Read = CompiledRequest & {linkedinDomainState?: State; linkedinDomainPage?: true};
const gateway = 'linkedin_native_action',
  origin = 'https://api.linkedin.com',
  maxBatch = 20,
  prefix = '/rest/insightTagDomains';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    ? String(v)
    : typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v)
      ? v
      : undefined;
const hostname = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= 253 &&
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9]$/.test(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_LINKEDIN_INSIGHT_DOMAIN', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  if (!/^[1-9][0-9]{0,19}$/.test(p.accountId ?? '')) invalid('Select one sponsored account.');
  return p.accountId!;
};
const accountUrn = (p: CompiledRequest) => 'urn:li:sponsoredAccount:' + account(p);
export function linkedinDomainKind(p: CompiledRequest): 'single' | 'batch' | undefined {
  if (
    p.gateway !== gateway ||
    p.specialTransport ||
    (p.origin !== undefined && p.origin !== origin) ||
    p.method !== 'POST'
  )
    return;
  if (p.path === prefix) return 'batch';
  if (p.path.startsWith(prefix + '/') && !p.path.slice(prefix.length + 1).includes('/')) return 'single';
  return;
}
const shape = 'Name each domain as (account:urn:li:sponsoredAccount:<id>,domainName:<host without protocol>).';
function key(value: unknown): Key {
  if (typeof value === 'string') {
    try {
      value = parseLinkedInValue(value);
    } catch {
      invalid(shape);
    }
  }
  if (
    !object(value) ||
    Object.keys(value).sort().join() !== 'account,domainName' ||
    typeof value.account !== 'string' ||
    !/^urn:li:sponsoredAccount:[1-9][0-9]{0,19}$/.test(value.account) ||
    !hostname(value.domainName)
  )
    invalid(shape);
  return {account: value.account, domainName: value.domainName};
}
const keyText = (k: Key) => '(account:' + k.account + ',domainName:' + k.domainName + ')';
// REST.li 2.0 encodes the scalars of a key, not its punctuation, as in the reference's examples.
const encodedKey = (k: Key) => linkedinQuery({key: k}).slice(4);
function pathKey(p: CompiledRequest): string {
  try {
    return decodeURIComponent(p.path.slice(prefix.length + 1));
  } catch {
    return invalid(shape);
  }
}
/** Encode the key of a single update and the entity keys of a batch as the reference does. */
export function linkedinDomainPlan(p: CompiledRequest): CompiledRequest {
  const kind = linkedinDomainKind(p);
  if (!kind) return p;
  try {
    if (kind === 'single') return {...p, path: prefix + '/' + encodedKey(key(pathKey(p)))};
    const b = p.body;
    if (!object(b) || !object(b.entities)) return p;
    const entities: JsonObject = {};
    for (const [k, v] of Object.entries(b.entities)) entities[encodedKey(key(k))] = v;
    return Object.keys(entities).length === Object.keys(b.entities).length ? {...p, body: {...b, entities}} : p;
  } catch {
    return p;
  }
}
function patch(v: unknown, at: string): boolean {
  if (
    !object(v) ||
    Object.keys(v).some(k => k !== 'patch') ||
    !object(v.patch) ||
    Object.keys(v.patch).some(k => k !== '$set') ||
    !object(v.patch.$set) ||
    Object.keys(v.patch.$set).some(k => k !== 'blocked') ||
    typeof v.patch.$set.blocked !== 'boolean'
  )
    invalid(at + ' sets only blocked (true or false): {patch: {$set: {blocked}}}.');
  return (v as JsonObject).patch.$set.blocked;
}
function domainKeys(p: CompiledRequest): Key[] {
  let values: unknown = linkedinDomainKind(p) === 'single' ? [pathKey(p)] : p.query.ids;
  if (typeof values === 'string') {
    try {
      values = parseLinkedInValue(values);
    } catch {
      invalid(shape);
    }
  }
  if (!Array.isArray(values) || !values.length || values.length > maxBatch) invalid('Name 1–' + maxBatch + ' domains.');
  const keys = (values as unknown[]).map(key);
  if (new Set(keys.map(keyText)).size !== keys.length) invalid('Each domain appears once.');
  for (const k of keys)
    if (k.account !== accountUrn(p))
      invalid(
        'Domain ' + k.domainName + ' names ' + k.account + '; update only domains of the selected sponsored account.',
      );
  return keys;
}
/** The blocked value wanted for each domain name. */
function wanted(p: CompiledRequest): Record<string, boolean> {
  const b = object(p.body) ? p.body : {},
    out: Record<string, boolean> = {};
  if (linkedinDomainKind(p) === 'single') {
    out[domainKeys(p)[0]!.domainName] = patch(b, 'The body');
    return out;
  }
  for (const [k, v] of Object.entries(object(b.entities) ? b.entities : {}))
    out[key(k).domainName] = patch(v, 'Entity ' + k);
  return out;
}
export function assertLinkedInDomain(p: CompiledRequest): void {
  const kind = linkedinDomainKind(p);
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
  if (kind === 'single' && method !== undefined && method !== 'PARTIAL_UPDATE')
    invalid('A domain update is a PARTIAL_UPDATE.');
  if (kind === 'batch' && method !== 'BATCH_PARTIAL_UPDATE')
    invalid('Several domains are updated with X-RestLi-Method BATCH_PARTIAL_UPDATE and ids.');
  const keys = domainKeys(p),
    b = p.body;
  if (!object(b)) invalid('Provide the native patch body.');
  if (kind === 'single') {
    if (Object.keys(p.query).length) invalid('A single domain update takes no query parameters.');
    patch(b, 'The body');
    return;
  }
  if (Object.keys(p.query).some(k => k !== 'ids')) invalid('A batch update takes only ids.');
  if (Object.keys(b).some(k => k !== 'entities') || !object(b.entities))
    invalid('A batch update sends {entities: {key: {patch: {$set: {blocked}}}}}.');
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(b.entities)) {
    const t = keyText(key(k));
    if (seen.has(t) || !keys.some(x => keyText(x) === t)) invalid('Every entity key must match one of the ids, once.');
    seen.add(t);
    patch(v, 'Entity ' + t);
  }
  if (seen.size !== keys.length) invalid('Every id needs one entity.');
}
export function assertLinkedInDomainScope(c: Connection, write = false): void {
  if (!c.scopes.some(s => (write ? s === 'rw_ads' : ['r_ads', 'rw_ads'].includes(s))))
    fail(
      'INSUFFICIENT_SCOPE',
      write ? 'Insight Tag domain writes require rw_ads.' : 'Insight Tag domain reads require r_ads or rw_ads.',
      {},
      403,
    );
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): Read {
  return {
    ...p,
    action: 'AMCP_LINKEDIN_INSIGHT_DOMAIN_READ',
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
    linkedinDomainState: undefined,
    linkedinDomainPage: true,
  };
}
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...read(p, '/rest/adAccounts/' + account(p)),
  linkedinDomainState: state,
});
export function linkedinDomainSnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p, {domains: Object.keys(wanted(p)).sort()})];
}
export function isLinkedInDomainRead(p: CompiledRequest): p is Read {
  return !!(p as Read).linkedinDomainState;
}
/** Writes after validation; server-built reads of the account, its Insight Tag, its permission and its named domains. */
export function authorizeLinkedInDomain(p: CompiledRequest, c: Connection, id: string): boolean {
  if (linkedinDomainKind(p)) {
    assertLinkedInDomain(p);
    assertLinkedInDomainScope(c, true);
    return true;
  }
  const internal = p as Read;
  if (
    p.gateway !== gateway ||
    !internal.linkedinDomainPage ||
    p.action !== 'AMCP_LINKEDIN_INSIGHT_DOMAIN_READ' ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined
  )
    return false;
  assertLinkedInDomainScope(c);
  const q = Object.keys(p.query),
    urn = 'urn:li:sponsoredAccount:' + id;
  if (!q.length && p.path === '/rest/adAccounts/' + id) return true;
  if (
    ['/rest/insightTags', '/rest/insightTagsPermission'].includes(p.path) &&
    p.query.q === 'account' &&
    p.query.account === urn &&
    q.every(k => ['q', 'account'].includes(k))
  )
    return true;
  if (
    p.path === prefix &&
    p.query.q === 'account' &&
    p.query.account === urn &&
    hostname(p.query.domainName) &&
    q.every(k => ['q', 'account', 'domainName'].includes(k))
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal Insight Tag domain read.', {}, 403);
}
export async function readLinkedInDomains(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).linkedinDomainState;
  if (!s) return request(p);
  const ok = (r: TransportResult, label: string) => {
    if (r.status !== 200 || !object(r.data)) unverified('LinkedIn did not return the ' + label + '.');
    return r.data as JsonObject;
  };
  const a = ok(await request({...(p as Read), linkedinDomainState: undefined} as Read), 'ad account');
  if (numeric(a.id) !== account(p)) unverified('LinkedIn returned another ad account.');
  const urn = accountUrn(p),
    out: JsonObject = {account: {id: account(p), status: a.status ?? null}};
  const finder = ok(
    await request(read(p, '/rest/insightTags', {q: 'account', account: urn})),
    'Insight Tags of the account',
  );
  if (!Array.isArray(finder.elements) || finder.elements.length > 1)
    unverified('LinkedIn listed more than one Insight Tag for the account.');
  const tag = finder.elements.length && object(finder.elements[0]) ? (finder.elements[0] as JsonObject) : null;
  out.tag = tag
    ? {
        id: numeric(tag.id) ?? null,
        accounts: Array.isArray(tag.sponsoredAccounts) ? [...tag.sponsoredAccounts].map(String).sort() : [],
      }
    : null;
  out.role = null;
  if (tag) {
    const perm = ok(
      await request(read(p, '/rest/insightTagsPermission', {q: 'account', account: urn})),
      'Insight Tag permission',
    );
    const rows = Array.isArray(perm.elements) ? (perm.elements as unknown[]).filter(object) : [];
    out.role =
      rows
        .map(r => ({tag: String(r.insightTag ?? ''), role: r.accessRole ?? r.role ?? null}))
        .find(r => r.tag.endsWith(':' + numeric(tag.id)))?.role ?? null;
  }
  const domains: JsonObject = {};
  for (const name of s.domains) {
    const r = ok(await request(read(p, prefix, {q: 'account', account: urn, domainName: name})), 'domain ' + name);
    const rows = (Array.isArray(r.elements) ? (r.elements as unknown[]) : []).filter(
      (x): x is JsonObject => object(x) && x.domainName === name,
    );
    if (rows.length > 1) unverified('LinkedIn listed domain ' + name + ' more than once for the account.');
    // lastCallbackAt changes with traffic; it is left out so a review does not go stale by itself.
    domains['d:' + name] = rows.length
      ? {
          present: true,
          domainName: name,
          blocked: typeof rows[0]!.blocked === 'boolean' ? rows[0]!.blocked : null,
          insightTag: rows[0]!.insightTag ?? null,
        }
      : {present: false, domainName: name};
  }
  out.domains = domains;
  return {status: 200, headers: {}, data: out};
}
export function validateLinkedInDomainState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).linkedinDomainState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || !object(d.account) || !('tag' in d) || !object(d.domains))
    unverified('Missing verified Insight Tag domain state.');
}
export function linkedinDomainPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!linkedinDomainKind(p)) return;
  const s = states[0];
  if (!object(s) || !object(s.account) || !object(s.domains)) unverified('Missing verified Insight Tag domain state.');
  if (!object(s.tag))
    fail(
      'STATE_NOT_FOUND',
      'The selected ad account has no Insight Tag, so it has no domains to block or allow.',
      {},
      404,
    );
  if (s.role !== 'FULL')
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'The selected ad account has ' +
        String(s.role ?? 'no') +
        ' access to Insight Tag ' +
        String(s.tag.id) +
        '; only FULL access updates its domains.',
      {insight_tag_id: String(s.tag.id)},
      403,
    );
  for (const [name, blocked] of Object.entries(wanted(p))) {
    const d = (s.domains as JsonObject)['d:' + name];
    if (!object(d) || d.present !== true)
      fail(
        'STATE_NOT_FOUND',
        'Domain ' +
          name +
          ' is not an Insight Tag domain of the selected ad account; LinkedIn adds domains from tag traffic.',
        {domain: name},
        404,
      );
    if (d.blocked === blocked) invalid('Domain ' + name + ' is already ' + (blocked ? 'blocked' : 'allowed') + '.');
  }
}
export function linkedinDomainImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = linkedinDomainKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    tag = object(s.tag) ? s.tag : null,
    domains: JsonObject = object(s.domains) ? s.domains : {},
    want = wanted(p);
  const blocking = Object.values(want).some(Boolean),
    shared = tag && Array.isArray(tag.accounts) ? tag.accounts : [];
  return {
    provider: 'linkedin',
    scope: 'insight_tag_domain',
    operation: kind === 'batch' ? 'batch_update' : 'update',
    insight_tag: tag ? tag.id : null,
    shared_with: shared,
    domains: Object.entries(want).map(([name, blocked]) => ({
      domainName: name,
      before: object(domains['d:' + name]) ? ((domains['d:' + name] as JsonObject).blocked ?? null) : null,
      after: blocked,
    })),
    may_affect_serving: blocking,
    effect:
      (blocking
        ? 'Blocked domains stop sending Insight Tag signals, so conversions, website audiences and website demographics from them are no longer captured'
        : 'Allowed domains send Insight Tag signals again') +
      (shared.length > 1 ? '; the tag is shared with ' + shared.join(', ') : '') +
      '.',
    verification: 'Finds each domain of the account again and compares blocked.',
    source: 'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversion-tracking',
  };
}
export function linkedinDomainOutcome(p: CompiledRequest, r: TransportResult): boolean {
  if (linkedinDomainKind(p) === 'single') return r.status === 204 || r.status === 200;
  const d = r.data;
  if (r.status !== 200 || !object(d) || !object(d.results) || (object(d.errors) && Object.keys(d.errors).length))
    return false;
  const keys = domainKeys(p).map(keyText),
    results = Object.entries(d.results);
  return (
    results.length === keys.length &&
    results.every(([k, v]) => {
      try {
        return keys.includes(keyText(key(k))) && object(v) && (v.status === 204 || v.status === 200);
      } catch {
        return false;
      }
    })
  );
}
export function linkedinDomainVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const want = wanted(p),
    names = Object.keys(want).sort();
  return [
    {
      read: stateRead(p, {domains: names, optional: true}),
      expected: {domains: Object.fromEntries(names.map(n => ['d:' + n, {present: true, blocked: want[n]}]))},
      id: names.join(','),
    },
  ];
}
export function linkedinDomainObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {domains: object(data.domains) ? data.domains : {}};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinDomainFamily: ReviewedFamily = {
  name: 'linkedin_insight_tag_domains',
  files: ['src/linkedin-insight-domains.ts', ['tests/linkedin-insight-domains.test.mjs']],
  kind: linkedinDomainKind,
  assert: assertLinkedInDomain,
  authorize: authorizeLinkedInDomain,
  snapshots: linkedinDomainSnapshots,
  isRead: isLinkedInDomainRead,
  reader: readLinkedInDomains,
  validateState: validateLinkedInDomainState,
  prerequisites: linkedinDomainPrerequisites,
  impact: linkedinDomainImpact,
  outcome: linkedinDomainOutcome,
  verification: linkedinDomainVerification,
  observed: linkedinDomainObserved,
  exemptFromSpendTextMatch: true,
};
