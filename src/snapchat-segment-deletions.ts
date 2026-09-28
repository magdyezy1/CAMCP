import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Deleting Snapchat audience segments, Marketing API v1 (Audiences, "Delete a Segment"; checked 2026-09-27):
 * DELETE /v1/segments/{segment_id} answers request_status SUCCESS, and "Deleted Audience segments cannot be retrieved".
 * Ad squads target segments in targeting.segments ({segment_id: [...], operation INCLUDE or EXCLUDE}); Snapchat does not
 * say what happens to them when a segment they name is deleted, so AMCP refuses to delete a segment an ad squad of the
 * account still targets. The segment path is scoped to segments listed from the selected ad account; the review and the
 * verification read the account's own lists.
 */
type Read = CompiledRequest & {snapSegmentDeleteState?: {segmentId: string; adsquads: boolean}};
const gateway = 'snapchat_native_action',
  maxPages = 5,
  pageSize = 1000;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_SEGMENT_DELETION', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapSegmentDeleteKind(p: CompiledRequest): 'delete' | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== 'https://adsapi.snapchat.com')) return;
  return p.method === 'DELETE' && /^\/v1\/segments\/[A-Za-z0-9-]{1,64}$/.test(p.path) ? 'delete' : undefined;
}
const segmentOf = (p: CompiledRequest) => p.path.split('/')[3]!;
export function assertSnapSegmentDelete(p: CompiledRequest): void {
  if (!snapSegmentDeleteKind(p)) return;
  if (!p.accountId) fail('ACCOUNT_REQUIRED', 'Select the ad account that owns the segment.', {}, 403);
  if (
    Object.keys(p.query).length ||
    Object.keys(p.headers).length ||
    (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length))
  )
    invalid('Segment deletion takes only the segment in the path, without a body, query or header overrides.');
}
const read = (p: CompiledRequest, state: NonNullable<Read['snapSegmentDeleteState']>): Read => ({
  ...p,
  action: 'AMCP_SNAPCHAT_SEGMENT_DELETE_READ',
  method: 'GET',
  path: '/v1/adaccounts/' + p.accountId + '/segments',
  query: {limit: pageSize},
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  snapSegmentDeleteState: state,
});
export function snapSegmentDeleteSnapshots(p: CompiledRequest): Read[] {
  return [read(p, {segmentId: segmentOf(p), adsquads: true})];
}
export function isSnapSegmentDeleteRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).snapSegmentDeleteState;
}
/** Every row of an account list, following cursors for at most five pages. */
async function all(
  first: Read,
  key: 'segments' | 'adsquads',
  item: 'segment' | 'adsquad',
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject[]> {
  const rows: JsonObject[] = [],
    cursors = new Set<string>();
  let q: Read = first;
  for (let page = 0; ; page++) {
    if (page >= maxPages)
      unverified('The ad account has more ' + key + ' than one review reads (' + maxPages * pageSize + ').');
    const r = await fetch(q),
      d = r.data;
    if (
      r.status !== 200 ||
      !object(d) ||
      String(d.request_status).toUpperCase() !== 'SUCCESS' ||
      !Array.isArray(d[key])
    )
      unverified('Snapchat did not list the ' + key + '.');
    for (const row of d[key] as unknown[]) {
      const v = object(row) && object(row[item]) ? row[item] : undefined;
      if (!v || typeof v.id !== 'string') unverified('A row of the ' + key + ' is malformed.');
      rows.push(v!);
    }
    const link = object(d.paging) ? d.paging.next_link : undefined;
    if (!link) return rows;
    let cursor: string | null = null;
    try {
      cursor = new URL(String(link)).searchParams.get('cursor');
    } catch {
      cursor = null;
    }
    if (!cursor || cursors.has(cursor)) unverified('Snapchat pagination of the ' + key + ' is repeated or malformed.');
    cursors.add(cursor!);
    q = {...q, query: {...q.query, cursor: cursor!}};
  }
}
export async function readSnapSegmentDelete(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).snapSegmentDeleteState;
  if (!s) return fetch(p);
  const segments = await all({...(p as Read), snapSegmentDeleteState: undefined} as Read, 'segments', 'segment', fetch);
  const found = segments.filter(v => v.id === s.segmentId);
  if (found.length > 1) unverified('Snapchat listed segment ' + s.segmentId + ' twice.');
  const v = found[0];
  if (v && v.ad_account_id !== undefined && v.ad_account_id !== p.accountId)
    fail('STATE_TARGET_MISMATCH', 'Snapchat listed a segment of another ad account.', {}, 409);
  const segment = v
    ? {
        present: true,
        id: s.segmentId,
        name: v.name ?? null,
        source_type: v.source_type ?? null,
        status: v.status ?? null,
        gone: false,
      }
    : {present: false, id: s.segmentId, gone: true};
  const out: JsonObject = {ad_account_id: p.accountId!, segment};
  if (s.adsquads) {
    const squads = await all(
      {
        ...(p as Read),
        path: '/v1/adaccounts/' + p.accountId + '/adsquads',
        query: {limit: pageSize},
        snapSegmentDeleteState: undefined,
      } as Read,
      'adsquads',
      'adsquad',
      fetch,
    );
    out.targeted_by = squads
      .filter(q => {
        const t = object(q.targeting) ? q.targeting : {};
        return (
          Array.isArray(t.segments) &&
          (t.segments as unknown[]).some(
            g => object(g) && Array.isArray(g.segment_id) && (g.segment_id as unknown[]).includes(s.segmentId),
          )
        );
      })
      .map(q => ({id: q.id, name: q.name ?? null, status: q.status ?? null}))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return {status: 200, headers: {}, data: out};
}
export function validateSnapSegmentDeleteState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).snapSegmentDeleteState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || !object(d.segment) || s.adsquads !== Array.isArray(d.targeted_by))
    unverified('Missing verified segment state.');
}
export function snapSegmentDeletePrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!snapSegmentDeleteKind(p)) return;
  const s = states[0];
  if (!object(s) || !object(s.segment) || !Array.isArray(s.targeted_by)) unverified('Missing verified segment state.');
  if (s.segment.present !== true)
    fail('STATE_NOT_FOUND', 'Segment ' + segmentOf(p) + ' is not a segment of the selected ad account.', {
      segment_id: segmentOf(p),
    });
  const squads = s.targeted_by as JsonObject[];
  if (squads.length)
    fail(
      'AUDIENCE_IN_USE',
      'Segment ' +
        segmentOf(p) +
        ' is targeted by ad squads ' +
        squads.map(q => String(q.id)).join(', ') +
        '; remove it from their targeting first.',
      {ad_squads: squads.map(q => String(q.id))},
      409,
    );
}
export function snapSegmentDeleteImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!snapSegmentDeleteKind(p)) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {};
  return {
    provider: 'snapchat',
    scope: 'audience_segment',
    operation: 'delete',
    segment: object(s.segment) ? s.segment : null,
    targeted_by: Array.isArray(s.targeted_by) ? s.targeted_by : null,
    may_affect_serving: false,
    effect:
      'Deletes the segment permanently; Snapchat cannot retrieve deleted segments. No ad squad of the account targets it.',
    verification: 'Lists the account segments again and expects the segment to be gone.',
    source: 'https://developers.snap.com/api/marketing-api/Ads-API/audiences',
  };
}
export function snapSegmentDeleteOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && object(r.data) && String(r.data.request_status).toUpperCase() === 'SUCCESS';
}
export function snapSegmentDeleteVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  return [
    {
      read: read(p, {segmentId: segmentOf(p), adsquads: false}),
      expected: {segment: {gone: true}},
      id: 'segment ' + segmentOf(p),
    },
  ];
}
export function snapSegmentDeleteObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {segment: object(data.segment) ? data.segment : null};
}
