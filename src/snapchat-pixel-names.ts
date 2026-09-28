import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Renaming Snapchat pixels, Marketing API v1 ("Snap Pixel"; checked 2026-09-27). PUT /v1/adaccounts/{ad_account_id}/pixels
 * with {pixels: [{id, name, ad_account_id}]} and PUT /v1/organizations/{organization_id}/pixels with {pixels: [{id, name,
 * organization_id}]} update pixels; "Attributes that can be updated: name". GET on the same paths lists the pixels of the
 * account or organization. Pixels are created in Ads Manager, not through the API.
 */
type Level = 'account' | 'organization';
type State = {level: Level; pixels: string[]};
type Read = CompiledRequest & {snapPixelNameState?: State; snapPixelOrg?: string};
const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com',
  maxItems = 10;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const snapId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' &&
  v === v.trim() &&
  [...v].length >= min &&
  [...v].length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_PIXEL_NAME', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapPixelNameKind(p: CompiledRequest): Level | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== origin) || p.method !== 'PUT') return;
  if (/^\/v1\/adaccounts\/[A-Za-z0-9-]{1,64}\/pixels$/.test(p.path)) return 'account';
  if (/^\/v1\/organizations\/[A-Za-z0-9-]{1,64}\/pixels$/.test(p.path)) return 'organization';
  return;
}
const ownerOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const rows = (p: CompiledRequest) =>
  (object(p.body) && Array.isArray(p.body.pixels) ? p.body.pixels : []) as JsonObject[];
export function assertSnapPixelName(p: CompiledRequest): void {
  const level = snapPixelNameKind(p);
  if (!level) return;
  if (!snapId(p.accountId))
    fail('ACCOUNT_REQUIRED', 'Select the ad account of the pixel, or an ad account of its organization.', {}, 403);
  if (level === 'account' && ownerOf(p) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account in the path.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Pixel renames take no query or header overrides.');
  const b = p.body,
    owner = level === 'account' ? 'ad_account_id' : 'organization_id';
  if (
    !object(b) ||
    Object.keys(b).some(k => k !== 'pixels') ||
    !Array.isArray(b.pixels) ||
    !b.pixels.length ||
    b.pixels.length > maxItems
  )
    invalid('Send {pixels: [...]} with 1–' + maxItems + ' pixels.');
  const ids = new Set<string>();
  (b.pixels as unknown[]).forEach((x, i) => {
    const at = 'pixels[' + i + ']';
    if (!object(x) || Object.keys(x).sort().join() !== ['id', 'name', owner].sort().join())
      invalid(at + ' takes id, name and ' + owner + '; only the name of a pixel changes.');
    if (!snapId(x.id)) invalid(at + '.id names the pixel.');
    if (ids.has(x.id)) invalid('Each pixel appears once per request.');
    ids.add(x.id);
    if (x[owner] !== ownerOf(p))
      invalid(at + '.' + owner + ' is the ' + (level === 'account' ? 'ad account' : 'organization') + ' in the path.');
    if (!text(x.name, 1, 375))
      invalid(at + '.name has 1–375 characters without surrounding spaces or control characters.');
  });
}
function read(p: CompiledRequest, path: string, extra: Partial<Read> = {}): Read {
  return {
    ...p,
    action: 'AMCP_SNAPCHAT_PIXEL_NAME_READ',
    method: 'GET',
    path,
    query: {},
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    snapPixelNameState: undefined,
    snapPixelOrg: undefined,
    ...extra,
  } as Read;
}
const stateRead = (p: CompiledRequest, state: State) =>
  read(p, '/v1/adaccounts/' + p.accountId, {snapPixelNameState: state});
export function snapPixelNameSnapshots(p: CompiledRequest): Read[] {
  return [
    stateRead(p, {
      level: snapPixelNameKind(p)!,
      pixels: rows(p)
        .map(x => String(x.id))
        .sort(),
    }),
  ];
}
export function isSnapPixelNameRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).snapPixelNameState;
}
/** Writes after validation; internal reads are the account, its pixels and the pixels of its own organization. */
export function authorizeSnapPixelName(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (snapPixelNameKind(p)) {
    assertSnapPixelName(p);
    if (p.accountId !== account)
      fail(
        'ACCOUNT_SCOPE_MISMATCH',
        'Select the ad account of the pixel, or an ad account of its organization.',
        {},
        403,
      );
    return true;
  }
  if (p.action !== 'AMCP_SNAPCHAT_PIXEL_NAME_READ' || p.method !== 'GET' || !p.readOnly || p.body !== undefined)
    return false;
  if (p.path === '/v1/adaccounts/' + account || p.path === '/v1/adaccounts/' + account + '/pixels') return true;
  // Set only by readSnapPixelNames from the organization of the account it just read.
  if (
    /^\/v1\/organizations\/[A-Za-z0-9-]{1,64}\/pixels$/.test(p.path) &&
    (p as Read).snapPixelOrg === p.path.split('/')[3]
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal pixel read.', {}, 403);
}
function list(r: TransportResult, label: string): JsonObject[] {
  const d = r.data;
  if (
    r.status !== 200 ||
    !object(d) ||
    String(d.request_status).toUpperCase() !== 'SUCCESS' ||
    !Array.isArray(d.pixels)
  )
    unverified('Snapchat did not list the ' + label + '.');
  if (object(d.paging) && d.paging.next_link) unverified('The ' + label + ' span more than one page.');
  return (d.pixels as unknown[]).map(x => {
    const v = object(x) && object(x.pixel) ? x.pixel : undefined;
    if (!v || !snapId(v.id)) unverified('A row of the ' + label + ' is malformed.');
    return v!;
  });
}
export async function readSnapPixelNames(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).snapPixelNameState;
  if (!s) return fetch(p);
  const account = p.accountId!,
    a = await fetch({...(p as Read), snapPixelNameState: undefined} as Read),
    ad = a.data;
  const row =
    object(ad) &&
    String(ad.request_status).toUpperCase() === 'SUCCESS' &&
    Array.isArray(ad.adaccounts) &&
    ad.adaccounts.length === 1 &&
    object(ad.adaccounts[0])
      ? ad.adaccounts[0].adaccount
      : undefined;
  if (a.status !== 200 || !object(row) || row.id !== account || !snapId(row.organization_id))
    unverified('Snapchat did not return the selected ad account with its organization.');
  const org = String(row.organization_id);
  const listed =
    s.level === 'account'
      ? list(await fetch(read(p, '/v1/adaccounts/' + account + '/pixels')), 'pixels of the ad account')
      : list(
          await fetch(read(p, '/v1/organizations/' + org + '/pixels', {snapPixelOrg: org})),
          'pixels of the organization',
        );
  const pixels: JsonObject = {};
  for (const x of listed) {
    const owner = s.level === 'account' ? x.ad_account_id : x.organization_id;
    if (owner !== undefined && owner !== (s.level === 'account' ? account : org))
      fail(
        'STATE_TARGET_MISMATCH',
        'Snapchat listed a pixel of another ' + (s.level === 'account' ? 'ad account' : 'organization') + '.',
        {},
        409,
      );
    pixels['p' + x.id] = {present: true, id: String(x.id), name: x.name ?? null, status: x.status ?? null};
  }
  for (const id of s.pixels) if (!Object.hasOwn(pixels, 'p' + id)) pixels['p' + id] = {present: false, id};
  return {status: 200, headers: {}, data: {ad_account_id: account, organization_id: org, level: s.level, pixels}};
}
export function validateSnapPixelNameState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).snapPixelNameState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || !object(d.pixels) || d.level !== s.level)
    unverified('Missing verified pixel state.');
}
export function snapPixelNamePrerequisites(p: CompiledRequest, states: unknown[]): void {
  const level = snapPixelNameKind(p);
  if (!level) return;
  const s = states[0];
  if (!object(s) || !object(s.pixels)) unverified('Missing verified pixel state.');
  if (level === 'organization' && s.organization_id !== ownerOf(p))
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'Organization ' + ownerOf(p) + ' is not the organization of the selected ad account.',
      {organization_id: ownerOf(p)},
      403,
    );
  for (const x of rows(p)) {
    const before = (s.pixels as JsonObject)['p' + x.id];
    if (!object(before) || before.present !== true)
      fail(
        'STATE_NOT_FOUND',
        'Pixel ' +
          String(x.id) +
          ' is not a pixel of the ' +
          (level === 'account' ? 'selected ad account' : 'organization') +
          '.',
        {pixel_id: String(x.id)},
      );
    if (before.name === x.name) invalid('Pixel ' + String(x.id) + ' is already named "' + String(x.name) + '".');
  }
}
export function snapPixelNameImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const level = snapPixelNameKind(p);
  if (!level) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    pixels: JsonObject = object(s.pixels) ? s.pixels : {};
  return {
    provider: 'snapchat',
    scope: 'pixel',
    operation: 'rename',
    level,
    renaming: rows(p).map(x => ({
      id: String(x.id),
      before: object(pixels['p' + x.id]) ? ((pixels['p' + x.id] as JsonObject).name ?? null) : null,
      after: x.name,
    })),
    may_affect_serving: false,
    effect: 'Renames the pixels; tracking, conversions and ad squads that use them are unchanged.',
    verification:
      'Lists the ' + (level === 'account' ? 'ad account' : 'organization') + ' pixels again and compares each name.',
    source: 'https://developers.snap.com/api/marketing-api/Ads-API/snap-pixel',
  };
}
export function snapPixelNameOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data,
    sent = rows(p);
  if (
    r.status !== 200 ||
    !object(d) ||
    String(d.request_status).toUpperCase() !== 'SUCCESS' ||
    !Array.isArray(d.pixels) ||
    d.pixels.length !== sent.length
  )
    return false;
  return (d.pixels as unknown[]).every(
    (x, i) =>
      object(x) &&
      String(x.sub_request_status).toUpperCase() === 'SUCCESS' &&
      object(x.pixel) &&
      x.pixel.id === sent[i]!.id,
  );
}
export function snapPixelNameVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const ids = rows(p)
    .map(x => String(x.id))
    .sort();
  return [
    {
      read: stateRead(p, {level: snapPixelNameKind(p)!, pixels: ids}),
      expected: {
        pixels: Object.fromEntries(rows(p).map(x => ['p' + x.id, {present: true, id: String(x.id), name: x.name}])),
      },
      id: ids.join(','),
    },
  ];
}
export function snapPixelNameObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {pixels: object(data.pixels) ? data.pixels : {}};
}
