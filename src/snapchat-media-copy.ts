import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {fail, readOf} from './family-kit.js';

/**
 * Snapchat media copy between ad accounts of one organization, per the Ads API "Media" reference (Copy Media, checked
 * 2026-09-27): POST /v1/adaccounts/{destination}/media_copy with media_copy: [{source_media_id, source_ad_account_id}], at
 * most 20. The accounts must belong to the same organization, the login must read the source media and write media in the
 * destination, and the media must be READY images or videos (Lens media is not supported). A copy keeps the name, type and
 * download link under a new ID. The request is not atomic: some copies can succeed while others fail.
 */
type Pair = {source_media_id: string; source_ad_account_id: string};
type Read = CompiledRequest & {
  snapchatMediaCopyState?: {pairs: Pair[]};
  snapchatMediaCopyPage?: true;
  snapchatMediaCopyCheck?: string;
};
const route = /^\/v1\/adaccounts\/([\w-]+)\/media_copy$/,
  maxCopies = 20,
  id = /^[\w-]{1,64}$/;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_MEDIA_COPY', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapchatMediaCopyKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'snapchat_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://adsapi.snapchat.com') &&
    route.test(p.path)
  );
}
const destination = (p: CompiledRequest) => route.exec(p.path)![1]!;
const pairs = (p: CompiledRequest): Pair[] =>
  (object(p.body) && Array.isArray(p.body.media_copy) ? p.body.media_copy : []).map((v: JsonObject) => ({
    source_media_id: String(v?.source_media_id),
    source_ad_account_id: String(v?.source_ad_account_id),
  }));
export function assertSnapchatMediaCopy(p: CompiledRequest): void {
  if (!snapchatMediaCopyKind(p)) return;
  if (destination(p) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The destination must be the selected ad account.', {}, 403);
  if (Object.keys(p.query).length) invalid('Media copies take no query parameters.');
  const b = p.body;
  if (
    !object(b) ||
    Object.keys(b).some(k => k !== 'media_copy') ||
    !Array.isArray(b.media_copy) ||
    !b.media_copy.length ||
    b.media_copy.length > maxCopies
  )
    invalid('Send media_copy with 1–' + maxCopies + ' copies.');
  const seen = new Set<string>();
  (b.media_copy as unknown[]).forEach((v, i) => {
    if (
      !object(v) ||
      Object.keys(v).some(k => !['source_media_id', 'source_ad_account_id'].includes(k)) ||
      typeof v.source_media_id !== 'string' ||
      !id.test(v.source_media_id) ||
      typeof v.source_ad_account_id !== 'string' ||
      !id.test(v.source_ad_account_id)
    )
      invalid('media_copy[' + i + '] is {source_media_id, source_ad_account_id} with native IDs.');
    if (v.source_ad_account_id === destination(p))
      invalid('media_copy[' + i + ']: the media is already in the destination ad account.');
    if (seen.has(v.source_media_id)) invalid('Each source media is copied once per review.');
    seen.add(v.source_media_id);
  });
}
function read(p: CompiledRequest, path: string, account: string): Read {
  return readOf<Read>(
    p,
    {
      before: {accountId: account},
      action: 'AMCP_SNAPCHAT_MEDIA_COPY_READ',
      path,
      query: {},
      clears: ['responseControls'],
    },
    {snapchatMediaCopyState: undefined, snapchatMediaCopyPage: true},
  );
}
export function snapchatMediaCopySnapshots(p: CompiledRequest): Read[] {
  return [{...read(p, '/v1/adaccounts/' + destination(p), destination(p)), snapchatMediaCopyState: {pairs: pairs(p)}}];
}
export function isSnapchatMediaCopyRead(p: CompiledRequest): p is Read {
  return !!(p as Read).snapchatMediaCopyState;
}
/**
 * Server-built reads of the ad accounts and of each source media under its own ad account. The source account must be bound
 * to this login; the reader then requires that the media names that account.
 */
export function authorizeSnapchatMediaCopyRead(p: CompiledRequest, c: Connection, account: string): boolean {
  const r = p as Read;
  if (
    p.gateway !== 'snapchat_native_action' ||
    !r.snapchatMediaCopyPage ||
    p.action !== 'AMCP_SNAPCHAT_MEDIA_COPY_READ' ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    Object.keys(p.query).length
  )
    return false;
  if (!c.accounts.includes(account))
    return fail('ACCOUNT_REQUIRED', 'The source ad account is not bound to this login.', {}, 403);
  if (p.path === '/v1/adaccounts/' + account || /^\/v1\/media\/[\w-]+$/.test(p.path)) return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal media copy read.', {}, 403);
}
function single(d: unknown, key: string, wanted: string, label: string): JsonObject {
  if (
    !object(d) ||
    String(d.request_status).toUpperCase() !== 'SUCCESS' ||
    !Array.isArray(d[key]) ||
    d[key].length !== 1
  )
    unverified('Snapchat did not return ' + label + '.');
  const row = (d[key] as JsonObject[])[0]!,
    entity = object(row) ? row[key === 'media' ? 'media' : key.slice(0, -1)] : undefined;
  if (String(row?.sub_request_status).toUpperCase() !== 'SUCCESS' || !object(entity) || entity.id !== wanted)
    unverified('Snapchat did not return ' + label + '.');
  return entity as JsonObject;
}
export async function readSnapchatMediaCopy(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).snapchatMediaCopyState;
  if (!s) return request(p);
  const dest = p.path.split('/')[3]!,
    accounts: JsonObject = {},
    media: JsonObject = {};
  const account = async (a: string) => {
    if (!accounts[a]) {
      const e = single((await request(read(p, '/v1/adaccounts/' + a, a))).data, 'adaccounts', a, 'ad account ' + a);
      accounts[a] = {id: a, organization_id: e.organization_id ?? null};
    }
    return accounts[a] as JsonObject;
  };
  await account(dest);
  for (const pair of s.pairs) {
    await account(pair.source_ad_account_id);
    let e: JsonObject;
    try {
      e = single(
        (await request(read(p, '/v1/media/' + pair.source_media_id, pair.source_ad_account_id))).data,
        'media',
        pair.source_media_id,
        'media ' + pair.source_media_id,
      );
    } catch (err) {
      if (err instanceof MirrorError && (err.status === 404 || err.code === 'NOT_FOUND'))
        fail(
          'STATE_TARGET_MISMATCH',
          'Media ' + pair.source_media_id + ' was not found in ad account ' + pair.source_ad_account_id + '.',
          {source_media_id: pair.source_media_id},
          409,
        );
      throw err;
    }
    if (e.ad_account_id !== pair.source_ad_account_id)
      fail(
        'STATE_TARGET_MISMATCH',
        'Media ' + pair.source_media_id + ' is not in ad account ' + pair.source_ad_account_id + '.',
        {source_media_id: pair.source_media_id},
        409,
      );
    media[pair.source_media_id] = {
      id: pair.source_media_id,
      ad_account_id: e.ad_account_id,
      name: e.name ?? null,
      type: e.type ?? null,
      media_status: e.media_status ?? null,
    };
  }
  return {status: 200, headers: {}, data: {destination: dest, accounts, media}};
}
export function validateSnapchatMediaCopyState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).snapchatMediaCopyState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.accounts) ||
    !object(d.media) ||
    s.pairs.some(x => !object((d.media as JsonObject)[x.source_media_id]))
  )
    unverified('Missing verified media copy state.');
}
export function snapchatMediaCopyPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!snapchatMediaCopyKind(p)) return;
  const s = states[0];
  if (!object(s) || !object(s.accounts) || !object(s.media)) unverified('Missing verified media copy state.');
  const org = object(s.accounts[destination(p)]) ? s.accounts[destination(p)].organization_id : undefined;
  for (const pair of pairs(p)) {
    const a = s.accounts[pair.source_ad_account_id],
      m = s.media[pair.source_media_id];
    if (!object(a) || !org || a.organization_id !== org)
      invalid('Ad account ' + pair.source_ad_account_id + ' is not in the organization of the destination ad account.');
    if (!object(m) || !['IMAGE', 'VIDEO'].includes(m.type))
      invalid(
        'Media ' +
          pair.source_media_id +
          ' is ' +
          String(object(m) ? m.type : 'unknown') +
          '; only images and videos can be copied.',
      );
    if (m.media_status !== 'READY')
      invalid('Media ' + pair.source_media_id + ' is ' + String(m.media_status) + '; only READY media can be copied.');
  }
}
export function snapchatMediaCopyImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!snapchatMediaCopyKind(p)) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    media = object(s.media) ? s.media : {};
  return {
    provider: 'snapchat',
    scope: 'media_copy',
    destination_ad_account: destination(p),
    copies: pairs(p).map(x => ({
      source_media_id: x.source_media_id,
      source_ad_account_id: x.source_ad_account_id,
      name: object(media[x.source_media_id]) ? media[x.source_media_id].name : null,
      type: object(media[x.source_media_id]) ? media[x.source_media_id].type : null,
    })),
    may_affect_serving: false,
    effect:
      'Copies each READY image or video into the selected ad account under a new media ID with the same name and file. Nothing serves until a creative uses the copy.',
    bulk_semantics:
      'Snapchat copies each item separately; a failed item does not undo the others, and AMCP keeps a partial receipt as a failure and never resubmits it.',
    verification:
      'Reads each new media in the selected ad account and compares its account, name and type with the source.',
    source: 'https://developers.snap.com/api/marketing-api/Ads-API/media',
  };
}
/** Each copy in request order: SUCCESS, a new ID in the destination. */
export function snapchatMediaCopies(p: CompiledRequest, r: TransportResult): JsonObject[] | undefined {
  const d = r.data,
    sources = pairs(p);
  if (
    r.status !== 200 ||
    !object(d) ||
    String(d.request_status).toUpperCase() !== 'SUCCESS' ||
    !Array.isArray(d.media) ||
    d.media.length !== sources.length
  )
    return;
  const out: JsonObject[] = [];
  for (const [i, row] of (d.media as unknown[]).entries()) {
    const m = object(row) ? row.media : undefined;
    if (
      !object(row) ||
      String(row.sub_request_status).toUpperCase() !== 'SUCCESS' ||
      !object(m) ||
      typeof m.id !== 'string' ||
      !id.test(m.id) ||
      m.id === sources[i]!.source_media_id ||
      m.ad_account_id !== destination(p)
    )
      return;
    out.push(m);
  }
  return new Set(out.map(m => m.id)).size === out.length ? out : undefined;
}
export function snapchatMediaCopyOutcome(p: CompiledRequest, r: TransportResult): boolean {
  return !!snapchatMediaCopies(p, r);
}
export function snapchatMediaCopyVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const copies = snapchatMediaCopies(p, {status: 200, headers: {}, data: result.data});
  if (!copies) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no copied media to verify.');
  const first = before[0],
    s: JsonObject = object(first) ? first : {},
    media = object(s.media) ? s.media : {};
  return pairs(p).map((x, i) => {
    const src = object(media[x.source_media_id]) ? media[x.source_media_id] : {},
      copy = copies[i]!;
    return {
      read: {
        ...read(p, '/v1/media/' + String(copy.id), destination(p)),
        snapchatMediaCopyCheck: String(copy.id),
      } as Read,
      expected: {copy: {ad_account_id: destination(p), name: src.name ?? null, type: src.type ?? null}},
      id: 'media ' + String(copy.id),
    };
  });
}
export function isSnapchatMediaCopyCheck(p: CompiledRequest): boolean {
  return !!(p as Read).snapchatMediaCopyCheck;
}
/** The copied media as the destination reads it: account, name and type. */
export function snapchatMediaCopyObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const row = Array.isArray(data.media) && data.media.length === 1 && object(data.media[0]) ? data.media[0] : {},
    m = object(row.media) ? row.media : {};
  return {
    copy:
      m.id === (read as Read).snapchatMediaCopyCheck && String(row.sub_request_status).toUpperCase() === 'SUCCESS'
        ? {ad_account_id: m.ad_account_id ?? null, name: m.name ?? null, type: m.type ?? null}
        : null,
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const snapchatMediaCopyFamily: ReviewedFamily = {
  name: 'snapchat_media_copy',
  files: ['src/snapchat-media-copy.ts', ['tests/snapchat-media-copy.test.mjs']],
  kind: snapchatMediaCopyKind,
  assert: plan => {
    assertNoMethodOverride(plan);
    assertSnapchatMediaCopy(plan);
  },
  authorize: (plan, connection, account) => authorizeSnapchatMediaCopyRead(plan, connection, account),
  snapshots: snapchatMediaCopySnapshots,
  isRead: (read: CompiledRequest) => isSnapchatMediaCopyRead(read) || isSnapchatMediaCopyCheck(read),
  reader: (read, next) => readSnapchatMediaCopy(read, next),
  validateState: (read, result, gateway) =>
    isSnapchatMediaCopyRead(read) ? validateSnapchatMediaCopyState(read, result) : gateway(),
  snapshotState: (read, data, gateway) => (isSnapchatMediaCopyRead(read) ? data : gateway()),
  prerequisites: (plan, state) => snapchatMediaCopyPrerequisites(plan, state),
  impact: snapchatMediaCopyImpact,
  outcome: snapchatMediaCopyOutcome,
  verification: snapchatMediaCopyVerification,
  observed: (read, data, gateway) =>
    data.amcp_absent !== true && isSnapchatMediaCopyCheck(read) ? snapchatMediaCopyObserved(read, data) : gateway(),
};
