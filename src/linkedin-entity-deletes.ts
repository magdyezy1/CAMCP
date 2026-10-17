import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {fail} from './family-kit.js';

/**
 * Batch deletion of LinkedIn campaign groups and creatives, per "Create and Manage Campaign Groups" and "Create and Manage
 * Creatives" of the Marketing API (li-lms-2026-09, pages updated 2026-09-16, checked 2026-09-28).
 * - DELETE /rest/adAccounts/{id}/adCampaignGroups?ids=List(...) deletes DRAFT campaign groups; "To start the process of
 *   deleting non DRAFT campaign groups, update the status to PENDING_DELETION."
 * - DELETE /rest/adAccounts/{id}/creatives?ids=List(urn...) deletes creatives that are DRAFT, linked to a DRAFT campaign, or
 *   video creatives whose processingState is PROCESSING_FAILED; others go through PENDING_DELETION. processingState is not
 *   a field of the creative schema, so AMCP deletes only the first two kinds.
 * "Batch operations may only be performed on entities that belong to the same Ad Account." A success answers 204; the
 * creative sample answers per-entity results and errors, so a partial deletion is possible. A deleted creative with
 * performance data stays readable as REMOVED. AMCP also refuses campaign groups that still hold campaigns: the reference
 * does not say what deleting their group does to them.
 */
type Kind = 'groups' | 'creatives';
type State = {kind: Kind; ids: string[]};
type Read = CompiledRequest & {linkedinDeleteState?: State; linkedinDeletePage?: true};
const gateway = 'linkedin_native_action',
  origin = 'https://api.linkedin.com',
  marker = 'AMCP_LINKEDIN_DELETE_READ',
  maxIds = 25;
// Every campaign status the search finder lists except REMOVED (already deleted, kept for reporting).
const liveStatuses = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'COMPLETED', 'CANCELED', 'DRAFT', 'PENDING_DELETION'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    ? String(v)
    : typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v)
      ? v
      : undefined;
const creativeUrn = /^urn:li:sponsoredCreative:([1-9][0-9]{0,19})$/,
  campaignUrn = /^urn:li:sponsoredCampaign:([1-9][0-9]{0,19})$/;
function invalid(message: string): never {
  return fail('INVALID_LINKEDIN_BATCH_DELETE', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  if (!/^[1-9][0-9]{0,19}$/.test(p.accountId ?? '')) invalid('Select one sponsored account.');
  return p.accountId!;
};
const accountUrn = (p: CompiledRequest) => 'urn:li:sponsoredAccount:' + account(p);
/** REST.li 2.0 scalar encoding of a URN path key. */
const restliKey = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function linkedinDeleteKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== gateway ||
    p.method !== 'DELETE' ||
    p.specialTransport ||
    (p.origin !== undefined && p.origin !== origin)
  )
    return;
  const m = /^\/rest\/adAccounts\/[^/]+\/(adCampaignGroups|creatives)$/.exec(p.path);
  return m ? (m[1] === 'adCampaignGroups' ? 'groups' : 'creatives') : undefined;
}
/** The IDs of the batch: ids=List(...) as a string, or a native array. */
function idsOf(p: CompiledRequest): string[] {
  const raw = p.query.ids,
    values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw],
    out: string[] = [];
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return invalid('ids are campaign group IDs or encoded creative URNs.');
    }
  };
  for (const v of values) {
    if (typeof v === 'number') {
      out.push(String(v));
      continue;
    }
    if (typeof v !== 'string') invalid('ids are campaign group IDs or creative URNs.');
    const d = decode(v),
      list = /^List\((.*)\)$/.exec(d);
    if (!list) {
      out.push(d);
      continue;
    }
    if (list[1]!.trim()) for (const part of list[1]!.split(',')) out.push(decode(part.trim()));
  }
  return out;
}
const keyOf = (kind: Kind, id: string) => (kind === 'groups' ? 'g' + id : 'c' + (creativeUrn.exec(id)?.[1] ?? ''));
export function assertLinkedInDelete(p: CompiledRequest): void {
  const kind = linkedinDeleteKind(p);
  if (!kind) return;
  if (p.path.split('/')[3] !== account(p))
    invalid('The path names the selected sponsored account; batch operations stay within one ad account.');
  if (
    Object.keys(p.headers).some(
      k => !['LinkedIn-Version', 'X-Restli-Protocol-Version', 'X-RestLi-Method'].includes(k),
    ) ||
    p.headers['X-Restli-Protocol-Version'] !== '2.0.0' ||
    !/^20\d{4}$/.test(p.headers['LinkedIn-Version'] ?? '')
  )
    invalid('Use the native versioned REST.li 2.0 contract without other headers.');
  if (p.headers['X-RestLi-Method']?.toUpperCase() !== 'BATCH_DELETE')
    invalid(
      'A batch deletion is a BATCH_DELETE (restli_method) with query ids; delete one entity through its own path.',
    );
  if (Object.keys(p.query).some(k => k !== 'ids')) invalid('The only query parameter is ids.');
  if (p.body !== undefined && p.body !== null && !(object(p.body) && !Object.keys(p.body).length))
    invalid('A batch deletion has no payload.');
  const ids = idsOf(p);
  if (!ids.length || ids.length > maxIds || new Set(ids).size !== ids.length)
    invalid('ids lists 1–' + maxIds + ' distinct ' + (kind === 'groups' ? 'campaign group IDs.' : 'creative URNs.'));
  for (const id of ids) {
    if (kind === 'groups' && !/^[1-9][0-9]{0,19}$/.test(id))
      invalid('Campaign groups are listed by numeric ID, as the reference shows: ' + id + '.');
    if (kind === 'creatives' && !creativeUrn.test(id))
      invalid('Creatives are listed by URN (urn:li:sponsoredCreative:{id}), as the reference shows: ' + id + '.');
  }
}
export function assertLinkedInDeleteScope(c: Connection, write = false): void {
  if (!c.scopes.some(s => (write ? s === 'rw_ads' : ['r_ads', 'rw_ads'].includes(s))))
    fail(
      'INSUFFICIENT_SCOPE',
      write
        ? 'Deleting campaign groups or creatives requires rw_ads.'
        : 'Campaign group and creative reads require r_ads or rw_ads.',
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
    query,
    body: undefined,
    headers: {'LinkedIn-Version': p.headers['LinkedIn-Version']!, 'X-Restli-Protocol-Version': '2.0.0'},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    linkedinDeleteState: undefined,
    linkedinDeletePage: true,
  };
}
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...read(p, '/rest/adAccounts/' + account(p)),
  linkedinDeleteState: state,
});
export function linkedinDeleteSnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p, {kind: linkedinDeleteKind(p)!, ids: idsOf(p)})];
}
export function isLinkedInDeleteRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).linkedinDeleteState;
}
const groupSearch = (group: string) => ({
  q: 'search',
  search: {campaignGroup: {values: ['urn:li:sponsoredCampaignGroup:' + group]}, status: {values: liveStatuses}},
  pageSize: 1,
});
/** Writes after validation; server-built reads of the selected account's campaign groups, creatives and campaigns. */
export function authorizeLinkedInDelete(p: CompiledRequest, c: Connection, id: string): boolean {
  if (linkedinDeleteKind(p)) {
    assertLinkedInDelete(p);
    assertLinkedInDeleteScope(c, true);
    if (p.accountId !== id)
      fail(
        'ACCOUNT_SCOPE_MISMATCH',
        'Select the sponsored account that owns the campaign groups or creatives.',
        {},
        403,
      );
    return true;
  }
  const internal = p as Read;
  if (
    p.gateway !== gateway ||
    !internal.linkedinDeletePage ||
    p.action !== marker ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    p.accountId !== id
  )
    return false;
  assertLinkedInDeleteScope(c);
  const base = '/rest/adAccounts/' + id,
    q = Object.keys(p.query);
  if (
    !q.length &&
    (p.path === base ||
      new RegExp('^' + base + '/(?:adCampaignGroups|adCampaigns)/[1-9][0-9]{0,19}$').test(p.path) ||
      new RegExp('^' + base + '/creatives/urn%3Ali%3AsponsoredCreative%3A[1-9][0-9]{0,19}$').test(p.path))
  )
    return true;
  if (p.path === base + '/adCampaigns') {
    const s = object(p.query.search) ? p.query.search : {},
      group =
        object(s.campaignGroup) && Array.isArray(s.campaignGroup.values) && s.campaignGroup.values.length === 1
          ? /^urn:li:sponsoredCampaignGroup:([1-9][0-9]{0,19})$/.exec(String(s.campaignGroup.values[0]))?.[1]
          : undefined;
    if (group && JSON.stringify(p.query) === JSON.stringify(groupSearch(group))) return true;
  }
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal campaign group or creative read.', {}, 403);
}
const notFound = (e: unknown) => e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND');
export async function readLinkedInDeletes(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).linkedinDeleteState;
  if (!s) return request(p);
  const a = account(p),
    urn = accountUrn(p),
    entities: JsonObject = {},
    campaigns: JsonObject = {};
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
  for (const id of s.ids) {
    if (s.kind === 'groups') {
      const d = await get('/rest/adAccounts/' + a + '/adCampaignGroups/' + id, 'campaign group ' + id);
      if (!d) {
        entities[keyOf(s.kind, id)] = {present: false};
        continue;
      }
      if (numeric(d.id) !== id)
        fail('STATE_TARGET_MISMATCH', 'LinkedIn returned another campaign group than ' + id + '.', {}, 409);
      const group: JsonObject = {
        present: true,
        id,
        account: d.account ?? null,
        name: d.name ?? null,
        status: d.status ?? null,
        firstCampaign: null,
      };
      // Only a group this request could delete needs the campaign check.
      if (group.account === urn && group.status === 'DRAFT') {
        const found = await get(
          '/rest/adAccounts/' + a + '/adCampaigns',
          'campaigns of campaign group ' + id,
          groupSearch(id),
        );
        const rows =
          found && Array.isArray(found.elements)
            ? (found.elements as unknown[])
            : unverified('LinkedIn did not list the campaigns of campaign group ' + id + '.');
        // LinkedIn may return a short page before the last one: an empty page that names another page does not show
        // that the group holds no campaigns.
        if (!rows.length && object(found!.metadata) && found!.metadata.nextPageToken)
          unverified('LinkedIn named another page of the campaigns of campaign group ' + id + ' without listing one.');
        if (rows.length) {
          const first = rows[0];
          group.firstCampaign = object(first)
            ? numeric(first.id)
              ? 'urn:li:sponsoredCampaign:' + numeric(first.id)
              : String(first.id ?? 'a campaign')
            : 'a campaign';
        }
      }
      entities[keyOf(s.kind, id)] = group;
      continue;
    }
    const d = await get('/rest/adAccounts/' + a + '/creatives/' + restliKey(id), 'creative ' + id);
    if (!d) {
      entities[keyOf(s.kind, id)] = {present: false};
      continue;
    }
    if (d.id !== id) fail('STATE_TARGET_MISMATCH', 'LinkedIn returned another creative than ' + id + '.', {}, 409);
    const creative: JsonObject = {
      present: true,
      id,
      account: d.account ?? null,
      name: d.name ?? null,
      campaign: d.campaign ?? null,
      intendedStatus: d.intendedStatus ?? null,
    };
    entities[keyOf(s.kind, id)] = creative;
    // A creative that is not DRAFT is deletable only while its campaign is DRAFT.
    const campaign = typeof creative.campaign === 'string' ? campaignUrn.exec(creative.campaign)?.[1] : undefined;
    if (
      creative.account === urn &&
      creative.intendedStatus !== 'DRAFT' &&
      campaign &&
      !Object.hasOwn(campaigns, 'p' + campaign)
    ) {
      const c = await get('/rest/adAccounts/' + a + '/adCampaigns/' + campaign, 'campaign ' + campaign);
      if (c && numeric(c.id) !== campaign)
        fail('STATE_TARGET_MISMATCH', 'LinkedIn returned another campaign than ' + campaign + '.', {}, 409);
      campaigns['p' + campaign] = c
        ? {present: true, id: campaign, account: c.account ?? null, status: c.status ?? null}
        : {present: false};
    }
  }
  return {status: 200, headers: {}, data: {kind: s.kind, entities, campaigns}};
}
export function validateLinkedInDeleteState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).linkedinDeleteState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    d.kind !== s.kind ||
    !object(d.entities) ||
    !object(d.campaigns) ||
    s.ids.some(id => !object((d.entities as JsonObject)[keyOf(s.kind, id)]))
  )
    unverified('Missing verified campaign group or creative state.');
}
export function linkedinDeletePrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = linkedinDeleteKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.entities) || !object(s.campaigns))
    unverified('Missing verified campaign group or creative state.');
  const urn = accountUrn(p),
    label = kind === 'groups' ? 'Campaign group ' : 'Creative ';
  for (const id of idsOf(p)) {
    const e = (s.entities as JsonObject)[keyOf(kind, id)];
    if (!object(e) || e.present !== true)
      fail('STATE_NOT_FOUND', label + id + ' was not found in the selected ad account.', {id}, 404);
    if (e.account !== urn)
      fail(
        'RESOURCE_SCOPE_REQUIRED',
        label + id + ' belongs to ' + String(e.account) + ', not the selected ad account.',
        {id},
        403,
      );
    if (kind === 'groups') {
      if (e.status !== 'DRAFT')
        invalid(
          'Campaign group ' +
            id +
            ' is ' +
            String(e.status) +
            '; LinkedIn deletes only DRAFT campaign groups. Set status PENDING_DELETION through a campaign group update to delete others.',
        );
      if (e.firstCampaign)
        invalid(
          'Campaign group ' + id + ' still has campaigns (' + String(e.firstCampaign) + '); delete or move them first.',
        );
      continue;
    }
    if (['REMOVED', 'PENDING_DELETION'].includes(String(e.intendedStatus)))
      invalid('Creative ' + id + ' is already ' + String(e.intendedStatus) + '.');
    if (e.intendedStatus === 'DRAFT') continue;
    const c = (s.campaigns as JsonObject)['p' + (campaignUrn.exec(String(e.campaign))?.[1] ?? '')];
    if (!object(c) || c.present !== true || c.status !== 'DRAFT')
      invalid(
        'Creative ' +
          id +
          ' is ' +
          String(e.intendedStatus) +
          ' in ' +
          (object(c) && c.present === true ? 'a ' + String(c.status) : 'an unreadable') +
          ' campaign; LinkedIn deletes only DRAFT creatives and creatives of DRAFT campaigns. Set intendedStatus PENDING_DELETION through a creative update to delete others.',
      );
  }
}
export function linkedinDeleteImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = linkedinDeleteKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    entities = object(s.entities) ? s.entities : {};
  const deleting = idsOf(p).map(id => {
    const e = entities[keyOf(kind, id)];
    return object(e) && e.present === true
      ? kind === 'groups'
        ? {id, name: e.name ?? null, status: e.status ?? null}
        : {id, name: e.name ?? null, intendedStatus: e.intendedStatus ?? null, campaign: e.campaign ?? null}
      : {id};
  });
  const groups = kind === 'groups';
  return {
    provider: 'linkedin',
    scope: groups ? 'campaign_groups' : 'creatives',
    operation: 'batch_delete',
    deleting,
    may_affect_serving: false,
    effect: groups
      ? 'Deletes ' +
        deleting.length +
        ' DRAFT campaign group(s) that hold no campaigns. DRAFT groups do not serve; a deletion cannot be undone.'
      : 'Deletes ' +
        deleting.length +
        ' creative(s) that are DRAFT or belong to DRAFT campaigns, so none serves; the posts they sponsor stay. A deletion cannot be undone.',
    verification:
      'Reads each ' +
      (groups ? 'campaign group' : 'creative') +
      ' again and expects it gone (or REMOVED, which LinkedIn keeps readable for reporting). A partial reply is not verified or resubmitted.',
    source:
      'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/' +
      (groups ? 'create-and-manage-campaign-groups' : 'create-and-manage-creatives') +
      '?view=li-lms-2026-09',
  };
}
/** 204, or 200 with a result of status 204 for every ID and no errors; anything else (a partial deletion included) fails. */
export function linkedinDeleteOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = linkedinDeleteKind(p)!,
    d = r.data,
    ids = idsOf(p);
  if (r.status === 204) return d === undefined || d === null || d === '' || (object(d) && !Object.keys(d).length);
  if (
    r.status !== 200 ||
    !object(d) ||
    !object(d.results) ||
    (d.errors !== undefined && !(object(d.errors) && !Object.keys(d.errors).length))
  )
    return false;
  const keys = Object.keys(d.results).map(k => {
    let x = k;
    try {
      x = decodeURIComponent(k);
    } catch {
      return '';
    }
    return kind === 'creatives' && /^[1-9][0-9]*$/.test(x) ? 'urn:li:sponsoredCreative:' + x : x;
  });
  if (keys.length !== ids.length || !ids.every(id => keys.includes(id))) return false;
  return Object.values(d.results).every(v => object(v) && (v.status ?? v.Status) === 204);
}
export function linkedinDeleteVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = linkedinDeleteKind(p)!,
    ids = idsOf(p),
    expected: JsonObject = {};
  for (const id of ids) expected[keyOf(kind, id)] = {present: false};
  return [
    {
      read: stateRead(p, {kind, ids}),
      expected: {entities: expected},
      id: (kind === 'groups' ? 'campaign groups ' : 'creatives ') + ids.join(', '),
    },
  ];
}
/** A REMOVED entity is deleted: LinkedIn keeps it readable only for its reporting data. */
export function linkedinDeleteObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const entities: JsonObject = {};
  for (const [k, e] of Object.entries(object(data.entities) ? data.entities : {}))
    entities[k] = {
      present: object(e) && e.present === true && e.status !== 'REMOVED' && e.intendedStatus !== 'REMOVED',
    };
  return {entities};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinDeleteFamily: ReviewedFamily = {
  name: 'linkedin_entity_deletes',
  files: ['src/linkedin-entity-deletes.ts', ['tests/linkedin-entity-deletes.test.mjs']],
  kind: linkedinDeleteKind,
  assert: assertLinkedInDelete,
  authorize: authorizeLinkedInDelete,
  snapshots: linkedinDeleteSnapshots,
  isRead: isLinkedInDeleteRead,
  reader: readLinkedInDeletes,
  validateState: validateLinkedInDeleteState,
  prerequisites: linkedinDeletePrerequisites,
  impact: linkedinDeleteImpact,
  outcome: linkedinDeleteOutcome,
  verification: linkedinDeleteVerification,
  observed: linkedinDeleteObserved,
};
