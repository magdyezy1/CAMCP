import type {ReviewedFamily} from './reviewed-family.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {fail} from './family-kit.js';

/**
 * Snapchat dynamic templates, Marketing API v1 (Dynamic Product Ads guide, "Dynamic Templates"; checked 2026-09-27).
 * POST /v1/adaccounts/{ad_account_id}/dynamic_templates creates templates from {dynamic_templates: [...]} and PUT on the
 * same path updates them, each with its id; replies list each template with its sub_request_status. A template names the
 * render URLs, a layout, up to two catalog text fields, a background colour, preferred image and video tags and overlays
 * (IMAGE and FRAME overlays of account media, TEXT overlays of up to 34 characters). Dynamic creatives name a template in
 * dynamic_render_properties.dynamic_template_id. The guide documents no deletion.
 */
type Kind = 'create' | 'update';
type State = {templates: string[]; media: string[]; usage: boolean};
type Read = CompiledRequest & {snapTemplateState?: State};
const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com',
  maxItems = 10,
  pageSize = 1000,
  maxPages = 5;
const renderUrl = 'https://ads-interfaces.sc-cdn.net/adformats/templates/V2/index.html';
const layouts = ['AUTOMATIC', 'FILL_WIDTH', 'FILL_HEIGHT', 'FIT', 'HEADER', 'TILT', 'CAROUSEL', 'SLIDESHOW'];
// The guide's text field names for COMMERCE, HOTELS and FLIGHTS catalogs; its own examples also send empty strings.
const textFields = [
  '',
  'title',
  'price',
  'descriptionTruncated',
  'salePrice',
  'availability',
  'brand',
  'condition',
  'ageGroup',
  'color',
  'gender',
  'productType',
  'size',
  'customLabel_0',
  'customLabel_1',
  'customLabel_2',
  'customLabel_3',
  'customLabel_4',
  'name',
  'guestRating',
  'loyaltyProgram',
  'numberOfReviewers',
  'starRating',
  'originAirport',
  'destinationAirport',
  'originCity',
  'destinationCity',
];
const positions = ['BOTTOM_MIDDLE', 'BOTTOM_LEFT', 'BOTTOM_RIGHT', 'CENTER', 'TOP_MIDDLE', 'TOP_LEFT', 'TOP_RIGHT'],
  shapes = ['NONE', 'CIRCLE', 'PILL', 'RECTANGLE'];
const fields = [
  'ad_account_id',
  'name',
  'ios_url',
  'android_url',
  'layout',
  'text_fields',
  'background_color',
  'preferred_image_tags',
  'preferred_video_tags',
  'overlay_specs',
];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const snapId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
const hex = (v: unknown) => typeof v === 'string' && /^(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(v);
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' &&
  v === v.trim() &&
  [...v].length >= min &&
  [...v].length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_DYNAMIC_TEMPLATE', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapTemplateKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== origin)) return;
  if (!/^\/v1\/adaccounts\/[A-Za-z0-9-]{1,64}\/dynamic_templates$/.test(p.path)) return;
  return p.method === 'POST' ? 'create' : p.method === 'PUT' ? 'update' : undefined;
}
const accountOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const rows = (p: CompiledRequest) =>
  (object(p.body) && Array.isArray(p.body.dynamic_templates) ? p.body.dynamic_templates : []) as JsonObject[];
const opacity = (v: unknown) =>
  typeof v === 'number' ? v : typeof v === 'string' && /^\d{2,3}$/.test(v) ? Number(v) : NaN;
/** The template as Snapchat echoes it: opacity as a number, optional lists absent when not sent. */
function view(t: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const f of fields.filter(f => f !== 'ad_account_id' && f !== 'overlay_specs'))
    if (t[f] !== undefined) out[f] = t[f];
  if (t.overlay_specs !== undefined)
    out.overlay_specs = Array.isArray(t.overlay_specs)
      ? (t.overlay_specs as unknown[]).map(o =>
          object(o) ? {...o, ...(o.opacity !== undefined ? {opacity: opacity(o.opacity)} : {})} : o,
        )
      : t.overlay_specs;
  return out;
}
const media = (p: CompiledRequest) =>
  [
    ...new Set(
      rows(p).flatMap(t =>
        Array.isArray(t.overlay_specs)
          ? (t.overlay_specs as JsonObject[])
              .filter(o => object(o) && o.media_id !== undefined)
              .map(o => String(o.media_id))
          : [],
      ),
    ),
  ].sort();
function overlay(o: unknown, at: string): void {
  if (
    !object(o) ||
    Object.keys(o).some(
      k => !['type', 'media_id', 'text', 'position', 'opacity', 'text_overlay_properties'].includes(k),
    )
  )
    invalid(at + ' takes type, media_id, text, position, opacity and text_overlay_properties.');
  if (!['IMAGE', 'FRAME', 'TEXT'].includes(o.type as string)) invalid(at + '.type is IMAGE, FRAME or TEXT.');
  if (o.type === 'TEXT') {
    if (o.media_id !== undefined || !text(o.text, 1, 34))
      invalid(at + ': a TEXT overlay has text of 1–34 characters and no media_id.');
  } else if (!snapId(o.media_id) || o.text !== undefined || o.text_overlay_properties !== undefined)
    invalid(at + ': an ' + String(o.type) + ' overlay names the media_id of an image of the account and no text.');
  if (!positions.includes(o.position as string) || (o.type === 'FRAME' && o.position !== 'CENTER'))
    invalid(at + '.position is one of ' + positions.join(', ') + '; a FRAME is CENTER.');
  if (o.opacity !== undefined) {
    const n = opacity(o.opacity);
    if (!Number.isInteger(n) || n < 75 || n > 100) invalid(at + '.opacity is a whole number from 75 to 100.');
  }
  const t = o.text_overlay_properties;
  if (
    t !== undefined &&
    (o.type !== 'TEXT' ||
      !object(t) ||
      Object.keys(t).some(k => !['shape', 'shape_color', 'text_color'].includes(k)) ||
      !shapes.includes(t.shape as string) ||
      !hex(t.text_color) ||
      (t.shape_color !== undefined && !hex(t.shape_color)))
  )
    invalid(
      at +
        '.text_overlay_properties has a shape (' +
        shapes.join(', ') +
        '), a text_color and an optional shape_color as three or six hexadecimal digits.',
    );
}
export function assertSnapTemplate(p: CompiledRequest): void {
  const kind = snapTemplateKind(p);
  if (!kind) return;
  if (!snapId(p.accountId) || p.accountId !== accountOf(p))
    fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account in the path.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Dynamic template writes take no query or header overrides.');
  const b = p.body;
  if (
    !object(b) ||
    Object.keys(b).some(k => k !== 'dynamic_templates') ||
    !Array.isArray(b.dynamic_templates) ||
    !b.dynamic_templates.length ||
    b.dynamic_templates.length > maxItems
  )
    invalid('Send {dynamic_templates: [...]} with 1–' + maxItems + ' templates.');
  const names = new Set<string>(),
    ids = new Set<string>();
  (b.dynamic_templates as unknown[]).forEach((t, i) => {
    const at = 'dynamic_templates[' + i + ']',
      allowed = kind === 'update' ? ['id', ...fields] : fields;
    if (!object(t) || Object.keys(t).some(k => !allowed.includes(k)))
      invalid(at + ' takes ' + allowed.join(', ') + '.');
    if (kind === 'update') {
      if (!snapId(t.id)) invalid(at + '.id names the template to update.');
      if (ids.has(t.id)) invalid('Each template appears once per request.');
      ids.add(t.id);
    }
    if (t.ad_account_id !== p.accountId) invalid(at + '.ad_account_id is the selected ad account.');
    if (!text(t.name, 1, 375))
      invalid(at + '.name has 1–375 characters without surrounding spaces or control characters.');
    if (names.has(t.name.toLowerCase())) invalid('Each template name appears once per request.');
    names.add(t.name.toLowerCase());
    if (t.ios_url !== renderUrl || t.android_url !== renderUrl)
      invalid(at + ": ios_url and android_url are the guide's template renderer, " + renderUrl + '.');
    if (!layouts.includes(t.layout as string)) invalid(at + '.layout is one of ' + layouts.join(', ') + '.');
    if (
      !Array.isArray(t.text_fields) ||
      t.text_fields.length < 1 ||
      t.text_fields.length > 2 ||
      t.text_fields.some((f: unknown) => typeof f !== 'string' || !textFields.includes(f))
    )
      invalid(at + '.text_fields lists one or two catalog text fields such as title and price.');
    if (t.background_color !== undefined && !hex(t.background_color))
      invalid(at + '.background_color is three or six hexadecimal digits without #.');
    for (const k of ['preferred_image_tags', 'preferred_video_tags'])
      if (
        t[k] !== undefined &&
        (!Array.isArray(t[k]) ||
          !t[k].length ||
          t[k].length > 10 ||
          t[k].some((x: unknown) => !text(x, 1, 255)) ||
          new Set(t[k]).size !== t[k].length)
      )
        invalid(at + '.' + k + ' lists 1–10 different tags from the product feed.');
    if (t.overlay_specs !== undefined) {
      if (!Array.isArray(t.overlay_specs) || t.overlay_specs.length > 10)
        invalid(at + '.overlay_specs lists at most 10 overlays.');
      (t.overlay_specs as unknown[]).forEach((o, j) => overlay(o, at + '.overlay_specs[' + j + ']'));
      if ((t.overlay_specs as JsonObject[]).filter(o => o.type === 'FRAME').length > 1)
        invalid(at + ' has at most one FRAME overlay.');
    }
  });
}
const read = (p: CompiledRequest, path: string, state?: State): Read => ({
  ...p,
  action: 'AMCP_SNAPCHAT_TEMPLATE_READ',
  method: 'GET',
  path,
  query: {limit: pageSize},
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  snapTemplateState: state,
});
const stateRead = (p: CompiledRequest, state: State) =>
  read(p, '/v1/adaccounts/' + accountOf(p) + '/dynamic_templates', state);
export function snapTemplateSnapshots(p: CompiledRequest): Read[] {
  return [
    stateRead(p, {
      templates: rows(p)
        .filter(t => snapId(t.id))
        .map(t => String(t.id))
        .sort(),
      media: media(p),
      usage: snapTemplateKind(p) === 'update',
    }),
  ];
}
export function isSnapTemplateRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).snapTemplateState;
}
/** Writes after validation; internal reads are the account's templates, media and creatives. */
export function authorizeSnapTemplate(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (snapTemplateKind(p)) {
    assertSnapTemplate(p);
    return true;
  }
  if (p.action !== 'AMCP_SNAPCHAT_TEMPLATE_READ' || p.method !== 'GET' || !p.readOnly || p.body !== undefined)
    return false;
  if (['dynamic_templates', 'media', 'creatives'].some(k => p.path === '/v1/adaccounts/' + account + '/' + k))
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal dynamic template read.', {}, 403);
}
async function all(
  first: Read,
  key: string,
  item: string,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject[]> {
  const out: JsonObject[] = [],
    cursors = new Set<string>();
  let q = first;
  for (let page = 0; ; page++) {
    if (page >= maxPages)
      unverified(
        'The ad account has more ' + key.replace('_', ' ') + ' than one review reads (' + maxPages * pageSize + ').',
      );
    const r = await fetch(q),
      d = r.data;
    if (
      r.status !== 200 ||
      !object(d) ||
      String(d.request_status).toUpperCase() !== 'SUCCESS' ||
      !Array.isArray(d[key])
    )
      unverified('Snapchat did not list the ' + key.replace('_', ' ') + '.');
    for (const row of d[key] as unknown[]) {
      const v = object(row) && object(row[item]) ? row[item] : undefined;
      if (!v || !snapId(v.id)) unverified('A row of the ' + key.replace('_', ' ') + ' is malformed.');
      out.push(v!);
    }
    const link = object(d.paging) ? d.paging.next_link : undefined;
    if (!link) return out;
    let cursor: string | null = null;
    try {
      cursor = new URL(String(link)).searchParams.get('cursor');
    } catch {
      cursor = null;
    }
    if (!cursor || cursors.has(cursor))
      unverified('Snapchat pagination of the ' + key.replace('_', ' ') + ' is repeated or malformed.');
    cursors.add(cursor!);
    q = {...q, query: {...q.query, cursor: cursor!}};
  }
}
export async function readSnapTemplates(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).snapTemplateState;
  if (!s) return fetch(p);
  const account = accountOf(p),
    templates: JsonObject = {};
  for (const t of await all(
    {...(p as Read), snapTemplateState: undefined} as Read,
    'dynamic_templates',
    'dynamic_template',
    fetch,
  )) {
    if (t.ad_account_id !== undefined && t.ad_account_id !== account)
      fail('STATE_TARGET_MISMATCH', 'Snapchat listed a template of another ad account.', {}, 409);
    if (Object.hasOwn(templates, 't' + t.id)) unverified('A template is listed twice.');
    templates['t' + t.id] = {present: true, id: String(t.id), ...view(t)};
  }
  for (const id of s.templates) if (!Object.hasOwn(templates, 't' + id)) templates['t' + id] = {present: false, id};
  const out: JsonObject = {ad_account_id: account, templates};
  if (s.media.length) {
    const listed = await all(read(p, '/v1/adaccounts/' + account + '/media'), 'media', 'media', fetch),
      found: JsonObject = {};
    for (const id of s.media) {
      const m = listed.find(x => x.id === id);
      found['m' + id] = m
        ? {present: true, id, type: m.type ?? null, media_status: m.media_status ?? null}
        : {present: false, id};
    }
    out.media = found;
  }
  if (s.usage) {
    const creatives = await all(read(p, '/v1/adaccounts/' + account + '/creatives'), 'creatives', 'creative', fetch),
      used: JsonObject = {};
    for (const id of s.templates)
      used['t' + id] = creatives
        .filter(c => object(c.dynamic_render_properties) && c.dynamic_render_properties.dynamic_template_id === id)
        .map(c => ({id: String(c.id), name: c.name ?? null}))
        .sort((a, b) => a.id.localeCompare(b.id));
    out.used_by = used;
  }
  return {status: 200, headers: {}, data: out};
}
export function validateSnapTemplateState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).snapTemplateState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.templates) ||
    !!s.media.length !== object(d.media) ||
    s.usage !== object(d.used_by)
  )
    unverified('Missing verified dynamic template state.');
}
export function snapTemplatePrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = snapTemplateKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.templates)) unverified('Missing verified dynamic template state.');
  const templates = s.templates as JsonObject,
    present = Object.values(templates).filter((t): t is JsonObject => object(t) && t.present === true);
  for (const id of media(p)) {
    const m = object(s.media) ? (s.media as JsonObject)['m' + id] : undefined;
    if (!object(m) || m.present !== true)
      fail('STATE_NOT_FOUND', 'Media ' + id + ' is not media of the selected ad account.', {media_id: id});
    if (String(m.type).toUpperCase() !== 'IMAGE')
      invalid('Media ' + id + ' is ' + String(m.type) + '; overlays use IMAGE media.');
    if (m.media_status !== null && m.media_status !== undefined && String(m.media_status).toUpperCase() !== 'READY')
      invalid('Media ' + id + ' is ' + String(m.media_status) + '; overlays need READY media.');
  }
  const renamed = new Map(
    rows(p)
      .filter(t => snapId(t.id))
      .map(t => [String(t.id), String(t.name)]),
  );
  for (const t of rows(p)) {
    if (kind === 'update') {
      const before = templates['t' + t.id];
      if (!object(before) || before.present !== true)
        fail('STATE_NOT_FOUND', 'Template ' + String(t.id) + ' is not a dynamic template of the selected ad account.', {
          dynamic_template_id: String(t.id),
        });
      const {present: _p, id: _i, ...current} = before;
      if (stable(current) === stable(view(t))) invalid('Template ' + String(t.id) + ' already has these values.');
    }
    const name = String(t.name).toLowerCase();
    if (present.some(x => x.id !== t.id && (renamed.get(String(x.id)) ?? String(x.name)).toLowerCase() === name))
      fail('CONFIGURATION_EXISTS', 'The ad account already has a dynamic template named "' + String(t.name) + '".', {
        name: String(t.name),
      });
  }
}
export function snapTemplateImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = snapTemplateKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    templates: JsonObject = object(s.templates) ? s.templates : {},
    used: JsonObject = object(s.used_by) ? s.used_by : {};
  const usage = rows(p)
    .filter(t => snapId(t.id))
    .map((t): JsonObject => ({id: String(t.id), creatives: Array.isArray(used['t' + t.id]) ? used['t' + t.id] : []}));
  return {
    provider: 'snapchat',
    scope: 'dynamic_template',
    operation: kind,
    ...(kind === 'create'
      ? {creating: rows(p).map(view)}
      : {updating: rows(p).map(t => ({before: templates['t' + t.id] ?? null, after: view(t)})), used_by: usage}),
    may_affect_serving: usage.some(u => (u.creatives as unknown[]).length > 0),
    effect:
      kind === 'create'
        ? 'Creates dynamic templates; ads use them only once a dynamic creative names them.'
        : 'Changes how dynamic creatives that name the templates render their products.',
    verification: "Lists the account's dynamic templates again and compares each field sent.",
    source: 'https://developers.snap.com/api/marketing-api/Ads-API/dynamic-product-ads',
  };
}
export function snapTemplateOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = snapTemplateKind(p)!,
    d = r.data,
    sent = rows(p);
  if (
    r.status !== 200 ||
    !object(d) ||
    String(d.request_status).toUpperCase() !== 'SUCCESS' ||
    !Array.isArray(d.dynamic_templates) ||
    d.dynamic_templates.length !== sent.length
  )
    return false;
  return (d.dynamic_templates as unknown[]).every(
    (x, i) =>
      object(x) &&
      String(x.sub_request_status).toUpperCase() === 'SUCCESS' &&
      object(x.dynamic_template) &&
      snapId(x.dynamic_template.id) &&
      (kind === 'create' || x.dynamic_template.id === sent[i]!.id),
  );
}
export function snapTemplateVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = snapTemplateKind(p)!,
    expected: JsonObject = {};
  rows(p).forEach((t, i) => {
    const id = kind === 'create' ? result.data?.dynamic_templates?.[i]?.dynamic_template?.id : t.id;
    if (!snapId(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no dynamic template to verify.');
    expected['t' + id] = {present: true, id, ...view(t)};
  });
  const ids = Object.keys(expected).map(k => k.slice(1));
  return [
    {read: stateRead(p, {templates: ids, media: [], usage: false}), expected: {templates: expected}, id: ids.join(',')},
  ];
}
export function snapTemplateObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {templates: object(data.templates) ? data.templates : {}};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const snapTemplateFamily: ReviewedFamily = {
  name: 'snapchat_dynamic_templates',
  files: ['src/snapchat-dynamic-templates.ts', ['tests/snapchat-dynamic-templates.test.mjs']],
  kind: snapTemplateKind,
  assert: assertSnapTemplate,
  authorize: authorizeSnapTemplate,
  snapshots: snapTemplateSnapshots,
  isRead: isSnapTemplateRead,
  reader: readSnapTemplates,
  validateState: validateSnapTemplateState,
  prerequisites: snapTemplatePrerequisites,
  impact: snapTemplateImpact,
  outcome: snapTemplateOutcome,
  verification: snapTemplateVerification,
  observed: snapTemplateObserved,
  exemptFromSpendTextMatch: true,
};
