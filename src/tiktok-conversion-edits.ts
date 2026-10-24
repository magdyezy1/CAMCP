import {
  tiktokConversionNameProblem,
  tiktokConversionListPath,
  tiktokPixelListPath,
} from './tiktok-custom-conversions.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {fail, stateReadOf} from './family-kit.js';

/**
 * Renaming and deleting TikTok custom conversions of pixels, per API for Business v1.3 "Update a Custom Conversion",
 * "Delete a Custom Conversion", "Get Custom Conversions associated with an event source" and "Get pixels" (checked
 * 2026-09-27). An update changes only name ("must start with a letter", at most 50 characters, no standard event name,
 * "Duplicate names for Custom Conversion within an ad account are not allowed") and description (at most 500
 * characters); both requests name only the conversion, so the review finds its pixel by listing the advertiser's pixels
 * (20 per page) and their conversions. Ad groups optimize for a conversion through custom_conversion_id, so a deletion
 * reads the advertiser's ad groups first. App (SAN) conversions stay outside.
 */
type Kind = 'update' | 'delete';
type State = {kind: Kind; conversionId: string; usage: boolean};
type Read = CompiledRequest & {tiktokConversionEditState?: State};
export const tiktokConversionEditPaths = {
  update: '/v1.3/custom_conversion/update/',
  delete: '/v1.3/custom_conversion/delete/',
};
const gateway = 'tiktok_native_action',
  pixelPageSize = 20,
  maxPixelPages = 5,
  listPageSize = 1000,
  adgroupPageSize = 1000,
  maxAdgroupPages = 10;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const emoji = /\p{Extended_Pictographic}/u,
  numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
function invalid(message: string): never {
  return fail('INVALID_TIKTOK_CUSTOM_CONVERSION_EDIT', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function tiktokConversionEditKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.method !== 'POST' || p.specialTransport) return;
  return Object.entries(tiktokConversionEditPaths).find(([, path]) => path === p.path)?.[0] as Kind | undefined;
}
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
const conversionOf = (p: CompiledRequest) => String(body(p).custom_conversion_id);
export function assertTiktokConversionEdit(p: CompiledRequest): void {
  const kind = tiktokConversionEditKind(p);
  if (!kind) return;
  if (Object.keys(p.query).length) invalid('Custom conversion edits take no query parameters.');
  const b = p.body,
    allowed =
      kind === 'update'
        ? ['advertiser_id', 'custom_conversion_id', 'name', 'description']
        : ['advertiser_id', 'custom_conversion_id'];
  if (!obj(b) || Object.keys(b).some(k => !allowed.includes(k)))
    invalid('This request takes ' + allowed.join(', ') + '; rules, events and the event source cannot change.');
  if (String(b.advertiser_id) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.', {}, 403);
  if (!numeric(b.custom_conversion_id)) invalid('custom_conversion_id is the numeric ID of the custom conversion.');
  if (kind === 'delete') return;
  if (b.name === undefined && b.description === undefined) invalid('An update sets name, description or both.');
  if (b.name !== undefined) {
    const problem = tiktokConversionNameProblem(b.name);
    if (problem) invalid(problem);
  }
  if (
    b.description !== undefined &&
    (typeof b.description !== 'string' || [...b.description].length > 500 || emoji.test(b.description))
  )
    invalid('description is text of at most 500 characters without emoji.');
}
const read = (p: CompiledRequest, action: string, path: string, query: JsonObject, state?: State): Read =>
  stateReadOf<Read>(p, action, path, {advertiser_id: p.accountId, ...query}, {tiktokConversionEditState: state});
const stateRead = (p: CompiledRequest, state: State) =>
  read(p, 'tiktok_pixel_list_get', tiktokPixelListPath, {page: 1, page_size: pixelPageSize}, state);
export function tiktokConversionEditSnapshots(p: CompiledRequest): Read[] {
  const kind = tiktokConversionEditKind(p)!;
  return [stateRead(p, {kind, conversionId: conversionOf(p), usage: kind === 'delete'})];
}
export function isTiktokConversionEditRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).tiktokConversionEditState;
}
function ok(r: TransportResult, label: string): JsonObject {
  const d = r.data;
  if (r.status !== 200 || !obj(d) || d.code !== 0 || !obj(d.data))
    unverified('TikTok did not return the ' + label + '.');
  return (d as JsonObject).data;
}
async function pages(
  first: Read,
  key: string,
  label: string,
  max: number,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > max) unverified('The advertiser has more ' + label + ' than one review reads.');
    const d = ok(
      await request({...first, tiktokConversionEditState: undefined, query: {...first.query, page}} as Read),
      label,
    );
    if (d[key] !== undefined && !Array.isArray(d[key])) unverified('TikTok did not list the ' + label + '.');
    const pagesTotal = Number(obj(d.page_info) ? (d.page_info.total_page ?? 1) : 1);
    if (!Number.isInteger(pagesTotal) || pagesTotal < 0) unverified('TikTok returned an invalid page count.');
    if (page === 1) total = Math.max(pagesTotal, 1);
    for (const row of (d[key] ?? []) as unknown[]) {
      if (!obj(row)) unverified('A row of the ' + label + ' is malformed.');
      out.push(row as JsonObject);
    }
  }
  return out;
}
/** The advertiser's pixels, their conversions (activity status left out: it changes with traffic) and, for deletions, its ad groups. */
export async function readTiktokConversionEdits(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).tiktokConversionEditState;
  if (!s) return request(p);
  const pixels = (await pages(p as Read, 'pixels', 'pixels', maxPixelPages, request))
    .map(x => String(x.pixel_id))
    .filter(numeric)
    .sort();
  const conversions: JsonObject = {};
  let found: JsonObject | undefined;
  for (const pixel of pixels) {
    for (const c of await pages(
      read(p, 'tiktok_custom_conversion_list_get', tiktokConversionListPath, {
        event_source_type: 'PIXEL',
        event_source_id: pixel,
        page: 1,
        page_size: listPageSize,
      }),
      'list',
      'custom conversions',
      1,
      request,
    )) {
      const id = String(c.custom_conversion_id);
      if (!numeric(id)) unverified('A custom conversion row has no ID.');
      if (c.event_source_id !== undefined && String(c.event_source_id) !== pixel)
        fail('STATE_TARGET_MISMATCH', 'TikTok listed a custom conversion of another pixel.', {}, 409);
      const view = {
        present: true,
        custom_conversion_id: id,
        pixel_id: pixel,
        name: c.name ?? null,
        description: c.description ?? null,
        optimization_event: c.optimization_event ?? null,
      };
      conversions['c' + id] = view;
      if (id === s.conversionId) found = view;
    }
  }
  const out: JsonObject = {
    conversion: found ?? {present: false, custom_conversion_id: s.conversionId},
    names: Object.values(conversions)
      .filter(c => obj(c) && c.custom_conversion_id !== s.conversionId)
      .map(c => String((c as JsonObject).name))
      .sort(),
  };
  if (s.usage) {
    const groups = await pages(
      read(p, 'tiktok_adgroup_get', '/v1.3/adgroup/get/', {page: 1, page_size: adgroupPageSize}),
      'list',
      'ad groups',
      maxAdgroupPages,
      request,
    );
    out.used_by = groups
      .filter(g => String(g.custom_conversion_id ?? '') === s.conversionId)
      .map(g => ({adgroup_id: String(g.adgroup_id), adgroup_name: g.adgroup_name ?? null}))
      .sort((a, b) => a.adgroup_id.localeCompare(b.adgroup_id));
  }
  return {status: 200, headers: {}, data: out};
}
export function validateTiktokConversionEditState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).tiktokConversionEditState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !obj(d) ||
    !obj(d.conversion) ||
    !Array.isArray(d.names) ||
    s.usage !== Array.isArray(d.used_by)
  )
    unverified('Missing verified custom conversion state.');
}
export function tiktokConversionEditPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = tiktokConversionEditKind(p);
  if (!kind) return;
  const s = states[0];
  if (!obj(s) || !obj(s.conversion) || !Array.isArray(s.names)) unverified('Missing verified custom conversion state.');
  const c = s.conversion as JsonObject,
    b = body(p);
  if (c.present !== true)
    fail(
      'STATE_NOT_FOUND',
      'Custom conversion ' + conversionOf(p) + ' is not a conversion of a pixel of the selected advertiser.',
      {custom_conversion_id: conversionOf(p)},
    );
  if (kind === 'delete') {
    const used = Array.isArray(s.used_by) ? (s.used_by as JsonObject[]) : unverified('Missing ad group usage.');
    if (used.length)
      fail(
        'CUSTOM_CONVERSION_IN_USE',
        'Ad groups ' +
          used.map(g => String(g.adgroup_id)).join(', ') +
          ' optimize for custom conversion ' +
          conversionOf(p) +
          '; TikTok does not say what happens to them.',
        {adgroups: used.map(g => String(g.adgroup_id))},
        409,
      );
    return;
  }
  if (b.name !== undefined && (s.names as string[]).some(n => n === b.name))
    fail('CONFIGURATION_EXISTS', 'The ad account already has a custom conversion named "' + String(b.name) + '".', {
      name: String(b.name),
    });
  if ((b.name === undefined || b.name === c.name) && (b.description === undefined || b.description === c.description))
    invalid('Custom conversion ' + conversionOf(p) + ' already has this name and description.');
}
export function tiktokConversionEditImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = tiktokConversionEditKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = obj(first) ? first : {},
    b = body(p);
  return {
    provider: 'tiktok',
    scope: 'custom_conversions',
    operation: kind,
    conversion: obj(s.conversion) ? s.conversion : null,
    ...(kind === 'update'
      ? {after: Object.fromEntries(['name', 'description'].filter(k => b[k] !== undefined).map(k => [k, b[k]]))}
      : {}),
    may_affect_serving: false,
    effect:
      kind === 'update'
        ? 'Renames or re-describes the custom conversion; its rules, event and pixel are unchanged.'
        : 'Deletes the custom conversion; no ad group of the advertiser optimizes for it.',
    verification:
      kind === 'update'
        ? "Lists the pixel's custom conversions again and compares the name and description."
        : "Lists the pixels' custom conversions again and expects this one to be gone.",
    source: 'https://business-api.tiktok.com/portal/docs?id=1842225247176705',
  };
}
export function tiktokConversionEditOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && obj(r.data) && r.data.code === 0;
}
export function tiktokConversionEditVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = tiktokConversionEditKind(p)!,
    b = body(p);
  const expected =
    kind === 'delete'
      ? {present: false}
      : {
          present: true,
          ...Object.fromEntries(['name', 'description'].filter(k => b[k] !== undefined).map(k => [k, b[k]])),
        };
  return [
    {
      read: stateRead(p, {kind, conversionId: conversionOf(p), usage: false}),
      expected: {conversion: expected},
      id: 'custom conversion ' + conversionOf(p),
    },
  ];
}
export function tiktokConversionEditObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {conversion: obj(data.conversion) ? data.conversion : {}};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokConversionEditFamily: ReviewedFamily = {
  name: 'tiktok_custom_conversion_edits',
  files: ['src/tiktok-conversion-edits.ts', ['tests/tiktok-conversion-edits.test.mjs']],
  kind: tiktokConversionEditKind,
  assert: assertTiktokConversionEdit,
  snapshots: tiktokConversionEditSnapshots,
  isRead: isTiktokConversionEditRead,
  reader: readTiktokConversionEdits,
  validateState: validateTiktokConversionEditState,
  prerequisites: tiktokConversionEditPrerequisites,
  impact: tiktokConversionEditImpact,
  outcome: tiktokConversionEditOutcome,
  verification: tiktokConversionEditVerification,
  observed: tiktokConversionEditObserved,
  exemptFromSpendTextMatch: true,
};
