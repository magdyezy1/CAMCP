import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {assertNoMethodOverride} from './write-common.js';
import {fail} from './family-kit.js';

/**
 * Creating and renaming TikTok pixels, API for Business v1.3. The request fields come from TikTok's official Business
 * API SDK (tiktok/tiktok-business-api-sdk, `yml_files/pixel_create.yml` and `pixel_update.yml`, read 2026-09-29):
 * POST /pixel/create/ takes `advertiser_id`, `pixel_name` (required, not empty), `pixel_category` (ONLINE_STORE,
 * FILLING_FORM, CONTACTS, LANDING_PAGE, CUSTOMIZE_EVENTS) and `partner_name`; POST /pixel/update/ takes
 * `advertiser_id`, `pixel_id`, `pixel_name` and `advanced_matching_fields`. The SDK leaves both responses undocumented,
 * so AMCP relies on the envelope code and reads the pixel list ("Get pixels", checked 2026-09-26: pixel_id, pixel_name,
 * pixel_code, asset_ownership) before and after. Partner integrations and advanced matching (which personal data
 * TikTok matches) stay outside the contract. A new name must differ, in any case, from every pixel of the advertiser,
 * which is also how a created pixel is found again when the receipt names none.
 */
type State = {pixel?: string; created?: {name: string; before: string[]; id?: string}};
type Read = CompiledRequest & {tiktokPixelState?: State};
const gateway = 'tiktok_native_action',
  createPath = '/v1.3/pixel/create/',
  updatePath = '/v1.3/pixel/update/',
  listPath = '/v1.3/pixel/list/',
  pageSize = 20,
  maxPages = 10,
  categories = ['ONLINE_STORE', 'FILLING_FORM', 'CONTACTS', 'LANDING_PAGE', 'CUSTOMIZE_EVENTS'],
  source = 'https://github.com/tiktok/tiktok-business-api-sdk/tree/main/yml_files';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
function invalid(field: string, message: string): never {
  return fail('INVALID_TIKTOK_PIXEL', message, {field});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function tiktokPixelKind(p: CompiledRequest): 'create' | 'rename' | undefined {
  if (p.gateway !== gateway || p.method !== 'POST' || p.specialTransport) return;
  return p.path === createPath ? 'create' : p.path === updatePath ? 'rename' : undefined;
}
export function assertTiktokPixel(p: CompiledRequest, gatewayShape: () => void): void {
  const kind = tiktokPixelKind(p);
  if (!kind) return;
  assertNoMethodOverride(p);
  gatewayShape();
  const b = body(p),
    allowed =
      kind === 'create'
        ? ['advertiser_id', 'pixel_name', 'pixel_category']
        : ['advertiser_id', 'pixel_id', 'pixel_name'];
  for (const key of Object.keys(b))
    if (!allowed.includes(key))
      invalid(
        key,
        key === 'advanced_matching_fields'
          ? 'Advanced matching decides which personal data TikTok matches; it is outside the reviewed pixel contract.'
          : key === 'partner_name'
            ? 'Partner integrations are outside the reviewed pixel contract; create the pixel without partner_name.'
            : '"' + key + '" is outside the reviewed pixel contract.',
      );
  if (String(b.advertiser_id) !== p.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if (typeof b.pixel_name !== 'string' || !b.pixel_name.trim()) invalid('pixel_name', 'pixel_name must not be empty.');
  if (kind === 'create' && b.pixel_category !== undefined && !categories.includes(b.pixel_category))
    invalid('pixel_category', 'pixel_category must be one of ' + categories.join(', ') + '.');
  if (kind === 'rename' && !numeric(b.pixel_id))
    invalid('pixel_id', 'pixel_id must be the numeric pixel ID from /pixel/list/.');
}
const read = (p: CompiledRequest, state: State): Read => ({
  ...p,
  action: 'tiktok_pixel_list_get',
  method: 'GET',
  path: listPath,
  query: {advertiser_id: p.accountId, ...(state.pixel ? {pixel_id: state.pixel} : {}), page: 1, page_size: pageSize},
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  tiktokPixelState: state,
});
export function tiktokPixelSnapshots(p: CompiledRequest): Read[] {
  return [read(p, tiktokPixelKind(p) === 'rename' ? {pixel: String(body(p).pixel_id)} : {})];
}
export function isTiktokPixelRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).tiktokPixelState;
}
/** Every pixel of the advertiser in bounded pages: identity, name and whether the advertiser owns it. */
export async function readTiktokPixels(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).tiktokPixelState;
  if (!s) return request(p);
  const rows: JsonObject[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > maxPages)
      unverified('The advertiser has more pixels than one review reads (' + maxPages * pageSize + ').');
    const r = await request({...(p as Read), tiktokPixelState: undefined, query: {...p.query, page}} as Read),
      d = r.data;
    if (r.status !== 200 || !obj(d) || d.code !== 0 || !obj(d.data) || !Array.isArray(d.data.pixels))
      unverified('TikTok did not list the pixels.');
    const n = Number(obj(d.data.page_info) ? (d.data.page_info.total_page ?? 1) : 1);
    if (!Number.isInteger(n) || n < 0) unverified('TikTok returned an invalid page count.');
    if (page === 1) total = Math.max(n, 1);
    for (const row of d.data.pixels as unknown[]) {
      if (!obj(row) || !numeric(String(row.pixel_id ?? ''))) unverified('A pixel row is malformed.');
      rows.push(row);
    }
  }
  const pixels = rows
    .map(x => {
      const own = obj(x.asset_ownership) ? x.asset_ownership : {};
      return {
        pixel_id: String(x.pixel_id),
        pixel_name: typeof x.pixel_name === 'string' ? x.pixel_name : null,
        pixel_code: typeof x.pixel_code === 'string' ? x.pixel_code : null,
        owned: own.ownership_status === true && !['SHARED', 'UNBOUND'].includes(own.asset_relation_status),
      };
    })
    .sort((a, b) => a.pixel_id.localeCompare(b.pixel_id));
  if (new Set(pixels.map(x => x.pixel_id)).size !== pixels.length) unverified('TikTok listed a pixel twice.');
  if (s.created) {
    const created = pixels.filter(
      x =>
        x.pixel_name === s.created!.name &&
        !s.created!.before.includes(x.pixel_id) &&
        (!s.created!.id || x.pixel_id === s.created!.id),
    );
    return {status: 200, headers: {}, data: {created: {count: created.length, pixel_id: created[0]?.pixel_id ?? null}}};
  }
  if (s.pixel) {
    const row = pixels.find(x => x.pixel_id === s.pixel);
    return {
      status: 200,
      headers: {},
      data: {pixel: row ? {present: true, ...row} : {present: false, pixel_id: s.pixel}},
    };
  }
  return {status: 200, headers: {}, data: {pixels}};
}
export function validateTiktokPixelState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).tiktokPixelState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !obj(d) ||
    (s.created ? !obj(d.created) : s.pixel ? !obj(d.pixel) : !Array.isArray(d.pixels))
  )
    unverified('Missing verified pixel state.');
}
export function tiktokPixelPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = tiktokPixelKind(p);
  if (!kind) return;
  const s = states[0],
    b = body(p);
  if (kind === 'create') {
    if (!obj(s) || !Array.isArray(s.pixels)) unverified('Missing verified pixel state.');
    const taken = (s.pixels as JsonObject[]).find(x => same(x.pixel_name, b.pixel_name));
    if (taken)
      fail(
        'CONFIGURATION_EXISTS',
        'The advertiser already has a pixel named "' +
          String(taken.pixel_name) +
          '" (' +
          taken.pixel_id +
          '). Reuse it or choose another name.',
        {pixel_id: taken.pixel_id},
      );
    return;
  }
  const pixel = obj(s) && obj(s.pixel) ? s.pixel : undefined;
  if (!pixel) unverified('Missing verified pixel state.');
  if (pixel.present !== true)
    fail('STATE_NOT_FOUND', 'Pixel ' + b.pixel_id + ' is not a pixel of the selected advertiser.', {
      pixel_id: b.pixel_id,
    });
  if (pixel.owned !== true)
    fail(
      'STATE_TARGET_MISMATCH',
      'Pixel ' + b.pixel_id + ' is shared with this advertiser, not owned by it; only its owner renames it.',
      {pixel_id: b.pixel_id},
      409,
    );
  if (pixel.pixel_name === b.pixel_name)
    invalid('pixel_name', 'Pixel ' + b.pixel_id + ' is already named "' + b.pixel_name + '".');
}
export function tiktokPixelImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = tiktokPixelKind(p);
  if (!kind) return;
  const s: JsonObject = obj(state[0]) ? state[0] : {},
    b = body(p);
  return kind === 'create'
    ? {
        provider: 'tiktok',
        scope: 'pixel',
        operation: 'create',
        pixel_name: b.pixel_name,
        pixel_category: b.pixel_category ?? null,
        existing_pixels: Array.isArray(s.pixels) ? s.pixels.length : null,
        may_affect_serving: false,
        effect:
          'Creates a pixel for the advertiser. It records nothing until its code is installed on a website, and ad groups use it only once they name it.',
        verification: 'Lists the pixels again and expects one new pixel with this name.',
        source: source + '/pixel_create.yml',
      }
    : {
        provider: 'tiktok',
        scope: 'pixel',
        operation: 'rename',
        pixel: obj(s.pixel)
          ? {pixel_id: s.pixel.pixel_id, pixel_name: s.pixel.pixel_name, pixel_code: s.pixel.pixel_code}
          : null,
        new_name: b.pixel_name,
        may_affect_serving: false,
        effect: 'Renames the pixel; its code, events and matching settings are unchanged.',
        verification: 'Lists the pixel again and compares its name.',
        source: source + '/pixel_update.yml',
      };
}
export function tiktokPixelOutcome(p: CompiledRequest, r: TransportResult): boolean {
  if (r.status !== 200 || !obj(r.data) || r.data.code !== 0) return false;
  const id = obj(r.data.data) ? r.data.data.pixel_id : undefined;
  return tiktokPixelKind(p) !== 'create' || id === undefined || numeric(String(id));
}
export function tiktokPixelVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const b = body(p);
  if (tiktokPixelKind(p) === 'rename')
    return [
      {
        read: read(p, {pixel: String(b.pixel_id)}),
        expected: {pixel: {present: true, pixel_name: b.pixel_name}},
        id: 'pixel ' + b.pixel_id,
      },
    ];
  const s: JsonObject = obj(before[0]) ? before[0] : {},
    id = result.data?.data?.pixel_id,
    before_ids = Array.isArray(s.pixels) ? (s.pixels as JsonObject[]).map(x => String(x.pixel_id)) : [];
  if (id !== undefined && !numeric(String(id)))
    fail('VERIFICATION_UNSUPPORTED', 'The creation receipt names no valid pixel.');
  return [
    {
      read: read(p, {
        created: {name: String(b.pixel_name), before: before_ids, ...(id !== undefined ? {id: String(id)} : {})},
      }),
      expected: {created: {count: 1}},
      id: 'pixel ' + (id ?? '"' + b.pixel_name + '"'),
    },
  ];
}
export function tiktokPixelObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  if (obj(data.created)) return {created: {count: data.created.count}};
  return {pixel: obj(data.pixel) ? {present: data.pixel.present, pixel_name: data.pixel.pixel_name ?? null} : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokPixelFamily: ReviewedFamily = {
  name: 'tiktok_pixels',
  files: ['src/tiktok-pixels.ts', ['tests/tiktok-pixels.test.mjs']],
  kind: tiktokPixelKind,
  assert: assertTiktokPixel,
  snapshots: tiktokPixelSnapshots,
  isRead: isTiktokPixelRead,
  reader: readTiktokPixels,
  validateState: validateTiktokPixelState,
  prerequisites: tiktokPixelPrerequisites,
  impact: tiktokPixelImpact,
  outcome: tiktokPixelOutcome,
  verification: tiktokPixelVerification,
  observed: tiktokPixelObserved,
  exemptFromSpendTextMatch: true,
};
