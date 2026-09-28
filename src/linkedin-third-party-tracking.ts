import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * LinkedIn third-party tracking tags, per "Third-Party Tracking" of the Marketing API (li-lms-2025-10 to li-lms-2026-09,
 * checked 2026-09-27). POST /rest/thirdPartyTrackingTags adds a DoubleClick impression or click tag to a sponsored creative
 * (201, ID in x-restli-id); DELETE /rest/thirdPartyTrackingTags/{id} removes it (204). LinkedIn supports them for Sponsored
 * Content, Spotlight Dynamic Ads and Text Ads; tags use https, and impression and click trackers are accepted while
 * monitoring or blocking tags are not. Click tags together with landing page link wrappers double count clicks.
 */
type State = {creativeId?: string; tagId?: string; allowMissing?: true};
type Read = CompiledRequest & {
  linkedinThirdPartyState?: State;
  linkedinThirdPartyPage?: true;
  linkedinThirdPartyCreative?: string;
};
const base = '/rest/thirdPartyTrackingTags',
  origin = 'https://api.linkedin.com',
  events = ['IMPRESSION', 'CLICK'],
  platforms = ['DOUBLECLICK'];
const removed = ['CANCELED', 'PENDING_DELETION', 'REMOVED'];
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
  return fail('INVALID_LINKEDIN_THIRD_PARTY_TAG', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
function mismatch(message: string, details: JsonObject = {}): never {
  return fail('STATE_TARGET_MISMATCH', message, details, 409);
}
const account = (p: CompiledRequest) => {
  if (!/^[1-9][0-9]{0,19}$/.test(p.accountId ?? '')) invalid('Select one sponsored account.');
  return p.accountId!;
};
const accountUrn = (p: CompiledRequest) => 'urn:li:sponsoredAccount:' + account(p);
const creativeUrn = (id: string) => 'urn:li:sponsoredCreative:' + id;
export function linkedinThirdPartyKind(p: CompiledRequest): 'create' | 'delete' | undefined {
  if (p.gateway !== 'linkedin_native_action' || p.specialTransport || (p.origin !== undefined && p.origin !== origin))
    return;
  if (p.method === 'POST' && p.path === base) return 'create';
  if (p.method === 'DELETE' && /^\/rest\/thirdPartyTrackingTags\/[1-9][0-9]{0,19}$/.test(p.path)) return 'delete';
  return;
}
const tagOf = (p: CompiledRequest) => p.path.split('/').at(-1)!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
const creativeOf = (p: CompiledRequest) =>
  /^urn:li:sponsoredCreative:([1-9][0-9]{0,19})$/.exec(String(body(p).entity))?.[1];
function trackingUrl(v: unknown): void {
  if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(v))
    invalid('trackingUrl is the DoubleClick tag URL: at most 2048 characters without spaces or control characters.');
  let u: URL;
  try {
    u = new URL(v as string);
  } catch {
    return invalid('trackingUrl must be an absolute URL.');
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.'))
    invalid('trackingUrl must be an https URL without credentials; LinkedIn refuses tags without https.');
}
export function assertLinkedInThirdParty(p: CompiledRequest): void {
  const kind = linkedinThirdPartyKind(p);
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
  if (method !== undefined && method !== (kind === 'create' ? 'CREATE' : 'DELETE'))
    invalid('The REST.li method must match this ' + p.method + '.');
  if (Object.keys(p.query).length) invalid('Tracking tag writes take no query parameters.');
  if (kind === 'delete') {
    if (p.body !== undefined && p.body !== null && (!object(p.body) || Object.keys(p.body).length))
      invalid('Deleting a tracking tag takes no body.');
    return;
  }
  const b = p.body;
  if (!object(b)) invalid('Provide the native tracking tag {entity, event, platform, trackingUrl}.');
  const extra = Object.keys(b).filter(k => !['entity', 'event', 'platform', 'trackingUrl'].includes(k));
  if (extra.length)
    invalid(
      'Unqualified fields: ' +
        extra.join(', ') +
        (extra.some(k => ['id', 'account'].includes(k)) ? ' (LinkedIn sets id and account)' : '') +
        '.',
    );
  if (!creativeOf(p))
    invalid('entity is the URN of a sponsored creative of the selected ad account (urn:li:sponsoredCreative:{id}).');
  if (!events.includes(b.event)) invalid('event is IMPRESSION or CLICK.');
  if (!platforms.includes(b.platform))
    invalid('platform is DOUBLECLICK, the only tracking platform LinkedIn supports.');
  trackingUrl(b.trackingUrl);
}
export function assertLinkedInThirdPartyScope(c: Connection, write = false): void {
  if (!c.scopes.some(s => (write ? s === 'rw_ads' : ['r_ads', 'rw_ads'].includes(s))))
    fail(
      'INSUFFICIENT_SCOPE',
      write ? 'Tracking tag writes require rw_ads.' : 'Tracking tag reads require r_ads or rw_ads.',
      {},
      403,
    );
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): Read {
  return {
    ...p,
    action: 'AMCP_LINKEDIN_THIRD_PARTY_READ',
    method: 'GET',
    path,
    query,
    body: undefined,
    headers: {'LinkedIn-Version': p.headers['LinkedIn-Version']!, 'X-Restli-Protocol-Version': '2.0.0'},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    linkedinThirdPartyState: undefined,
    linkedinThirdPartyPage: true,
    linkedinThirdPartyCreative: undefined,
  };
}
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...read(p, '/rest/adAccounts/' + account(p)),
  linkedinThirdPartyState: state,
});
/** One marked read of the ad account; the reader adds the tag, the creative and the creative's tags. */
export function linkedinThirdPartySnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p, linkedinThirdPartyKind(p) === 'create' ? {creativeId: creativeOf(p)!} : {tagId: tagOf(p)})];
}
export function isLinkedInThirdPartyRead(p: CompiledRequest): p is Read {
  return !!(p as Read).linkedinThirdPartyState;
}
/** Writes after validation; server-built reads of the account, a creative of it, a tag, and the tags of a creative the reader proved. */
export function authorizeLinkedInThirdParty(p: CompiledRequest, c: Connection, id: string): boolean {
  if (linkedinThirdPartyKind(p)) {
    assertLinkedInThirdParty(p);
    assertLinkedInThirdPartyScope(c, true);
    return true;
  }
  const internal = p as Read;
  if (
    p.gateway !== 'linkedin_native_action' ||
    !internal.linkedinThirdPartyPage ||
    p.action !== 'AMCP_LINKEDIN_THIRD_PARTY_READ' ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined
  )
    return false;
  assertLinkedInThirdPartyScope(c);
  const q = Object.keys(p.query);
  if (
    !q.length &&
    (p.path === '/rest/adAccounts/' + id ||
      new RegExp('^/rest/adAccounts/' + id + '/creatives/urn%3Ali%3AsponsoredCreative%3A[1-9][0-9]*$').test(p.path) ||
      /^\/rest\/thirdPartyTrackingTags\/[1-9][0-9]*$/.test(p.path))
  )
    return true;
  // The finder runs only for a creative the reader has just read in this ad account.
  if (
    p.path === base &&
    internal.linkedinThirdPartyCreative &&
    p.query.q === 'creative' &&
    p.query.creative === internal.linkedinThirdPartyCreative &&
    q.every(k => ['q', 'creative', 'start', 'count'].includes(k))
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal tracking tag read.', {}, 403);
}
const tagView = (t: JsonObject) => ({
  id: numeric(t.id) ?? null,
  creative: typeof t.entity === 'string' ? t.entity : null,
  event: t.event ?? null,
  platform: t.platform ?? null,
  url: t.trackingUrl ?? null,
});
export async function readLinkedInThirdParty(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).linkedinThirdPartyState;
  if (!s) return request(p);
  let requests = 0;
  const fetch = async (q: Read) => {
    if (++requests > 8) unverified('Tracking tag reads exceeded their bound.');
    const r = await request(q),
      d = r.data;
    if (r.status !== 200 || !object(d) || d.serviceErrorCode !== undefined || d.errors !== undefined)
      unverified('A required LinkedIn read failed or returned an error envelope.');
    return d as JsonObject;
  };
  const selected = await fetch(read(p, '/rest/adAccounts/' + account(p)));
  if (numeric(selected.id) !== account(p) || typeof selected.status !== 'string')
    unverified('The selected ad account identity and status are required.');
  let tag: JsonObject | null = null,
    creativeId = s.creativeId;
  if (s.tagId) {
    try {
      const d = await fetch(read(p, base + '/' + s.tagId));
      if (numeric(d.id) !== s.tagId || d.account !== accountUrn(p))
        mismatch('Tracking tag ' + s.tagId + ' is not a tracking tag of the selected ad account.', {
          tracking_tag_id: s.tagId,
        });
      tag = tagView(d);
      const m = /^urn:li:sponsoredCreative:([1-9][0-9]{0,19})$/.exec(String(d.entity));
      if (!m) unverified('Tracking tag ' + s.tagId + ' names no sponsored creative.');
      if (creativeId && creativeId !== m[1]) mismatch('Tracking tag ' + s.tagId + ' belongs to another creative.');
      creativeId = m[1]!;
    } catch (e) {
      if (!(s.allowMissing && e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND'))) throw e;
    }
  }
  if (!creativeId) unverified('The tracking tag names no creative.');
  const urn = creativeUrn(creativeId!),
    row = await fetch(read(p, '/rest/adAccounts/' + account(p) + '/creatives/' + encodeURIComponent(urn)));
  if (row.id !== urn || row.account !== accountUrn(p))
    mismatch('Creative ' + creativeId + ' is not a creative of the selected ad account.', {creative: urn});
  const creative = {
    urn,
    campaign: typeof row.campaign === 'string' ? row.campaign : null,
    status: row.intendedStatus ?? null,
    name: typeof row.name === 'string' ? row.name : null,
  };
  const listed = await fetch({
    ...read(p, base, {q: 'creative', creative: urn, start: 0, count: 100}),
    linkedinThirdPartyCreative: urn,
  });
  const elements = Array.isArray(listed.elements)
    ? listed.elements
    : unverified('LinkedIn did not list the tracking tags of the creative.');
  if (
    elements.length >= 100 ||
    (object(listed.paging) && typeof listed.paging.total === 'number' && listed.paging.total > elements.length)
  )
    unverified('The creative has more tracking tags than one page.');
  const tags: JsonObject = {};
  for (const t of elements) {
    if (!object(t) || !numeric(t.id) || t.entity !== urn || (t.account !== undefined && t.account !== accountUrn(p)))
      unverified('A tracking tag row is foreign or malformed.');
    const v = tagView(t);
    tags['t' + v.id] = {event: v.event, platform: v.platform, url: v.url};
  }
  return {status: 200, headers: {}, data: {account: {id: account(p), status: selected.status}, creative, tag, tags}};
}
export function validateLinkedInThirdPartyState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).linkedinThirdPartyState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.account) ||
    !object(d.creative) ||
    !object(d.tags) ||
    (!!s.tagId && !s.allowMissing && !object(d.tag))
  )
    unverified('Complete tracking tag state is missing.');
}
export function linkedinThirdPartyPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = linkedinThirdPartyKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.creative) || !object(s.tags)) unverified('Complete tracking tag state is missing.');
  if (kind === 'delete') return;
  if (removed.includes(s.creative.status)) invalid('Creative ' + s.creative.urn + ' is ' + s.creative.status + '.');
  const b = body(p),
    same = Object.entries(s.tags).find(
      ([, t]) => object(t) && t.event === b.event && t.platform === b.platform && t.url === b.trackingUrl,
    );
  if (same)
    fail(
      'CONFIGURATION_EXISTS',
      'Creative ' +
        s.creative.urn +
        ' already has this ' +
        String(b.event) +
        ' tag as tracking tag ' +
        same[0].slice(1) +
        '.',
      {tracking_tag_id: same[0].slice(1)},
    );
}
export function linkedinThirdPartyImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = linkedinThirdPartyKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    b = body(p),
    tag = object(s.tag) ? s.tag : null,
    event = kind === 'create' ? b.event : tag?.event;
  return {
    provider: 'linkedin',
    scope: 'third_party_tracking_tag',
    operation: kind,
    creative: object(s.creative) ? s.creative : null,
    before: tag,
    after: kind === 'create' ? {event: b.event, platform: b.platform, url: b.trackingUrl} : null,
    may_affect_serving: false,
    effect:
      (kind === 'create'
        ? 'DoubleClick receives a call on each ' + (event === 'CLICK' ? 'click' : 'impression') + ' of the creative'
        : 'DoubleClick stops receiving these calls for the creative') +
      '. Delivery and budgets do not change.' +
      (event === 'CLICK' ? ' Click tags and landing page link wrappers together double count clicks.' : ''),
    verification:
      kind === 'create'
        ? 'Reads the new tag by ID: its creative, event, platform and URL.'
        : 'Reads the tag again and expects it gone.',
    source: 'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/third-party-tracking',
  };
}
export function linkedinThirdPartyOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = linkedinThirdPartyKind(p)!,
    d = r.data,
    clean = d === null || d === undefined || (object(d) && d.serviceErrorCode === undefined && d.errors === undefined);
  if (kind === 'delete')
    return (
      (r.status === 204 || r.status === 200) && (d === null || d === undefined || (object(d) && !Object.keys(d).length))
    );
  return r.status === 201 && clean && !!numeric(r.headers['x-restli-id']);
}
export function linkedinThirdPartyVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = linkedinThirdPartyKind(p)!,
    b = body(p);
  if (kind === 'create') {
    const id = numeric(result.headers?.['x-restli-id']);
    if (!id) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no tracking tag to verify.');
    return [
      {
        read: stateRead(p, {tagId: id, creativeId: creativeOf(p)!}),
        expected: {tag: {id, creative: b.entity, event: b.event, platform: b.platform, url: b.trackingUrl}},
        id: 'tracking tag ' + id,
      },
    ];
  }
  const first = before[0],
    prior = object(first) && object(first.tag) ? first.tag : {},
    creative = /([1-9][0-9]{0,19})$/.exec(String(prior.creative))?.[1];
  if (!creative) fail('VERIFICATION_UNSUPPORTED', 'The review names no creative to verify.');
  return [
    {
      read: stateRead(p, {tagId: tagOf(p), creativeId: creative, allowMissing: true}),
      expected: {tag: null, listed: false},
      id: 'tracking tag ' + tagOf(p),
    },
  ];
}
export function linkedinThirdPartyObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const s = (read as Read).linkedinThirdPartyState,
    tags = object(data.tags) ? data.tags : {};
  return {tag: object(data.tag) ? data.tag : null, listed: !!s?.tagId && Object.hasOwn(tags, 't' + s.tagId)};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinThirdPartyFamily: ReviewedFamily = {
  name: 'linkedin_third_party_tracking',
  files: ['src/linkedin-third-party-tracking.ts', ['tests/linkedin-third-party-tracking.test.mjs']],
  kind: linkedinThirdPartyKind,
  assert: assertLinkedInThirdParty,
  scope: assertLinkedInThirdPartyScope,
  authorize: authorizeLinkedInThirdParty,
  snapshots: linkedinThirdPartySnapshots,
  isRead: isLinkedInThirdPartyRead,
  reader: readLinkedInThirdParty,
  validateState: validateLinkedInThirdPartyState,
  prerequisites: linkedinThirdPartyPrerequisites,
  impact: linkedinThirdPartyImpact,
  outcome: linkedinThirdPartyOutcome,
  verification: linkedinThirdPartyVerification,
  observed: linkedinThirdPartyObserved,
  exemptFromSpendTextMatch: true,
};
