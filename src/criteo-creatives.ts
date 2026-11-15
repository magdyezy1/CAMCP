import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {criteoPrefix, criteoRoute} from './criteo-version.js';
import {createsOnPost, defineFamily, fail, readOf} from './family-kit.js';

/**
 * Creatives of a Criteo Retail Media account, API 2026-07, from the pinned OpenAPI document (CreateCreative,
 * UpdateCreative, GetCreative, GetCreativeTemplate and SearchAccountRetailers; CreativeCreateModel202207,
 * CreativeUpdateModel202207, TemplateVariableValue, Template, Section, TemplateVariable, ChoiceOption and the variable
 * specifications; checked 2026-09-29). Criteo's guide page for creatives has no text (read 2026-09-29), so the document
 * is the source. A creative fills a template of a retailer: each value names a template variable and carries that
 * variable's type (Text, Choice, Color, Files, Hyperlink or Video); a chosen option can unlock dependent variables.
 *
 * AMCP reads the retailer among the account's retailers and the template, and checks every value against it: variable
 * IDs, types, required variables, text length, choice counts and options, file counts, colours and addresses. Files
 * name asset IDs from CreateAsset, which Criteo offers no read of, so their format and size stay with Criteo. An update
 * sends the whole creative (PUT), keeps its retailer and template, and the review names the line items that use it.
 */
type Kind = 'create' | 'update';
type State = {kind: Kind; retailer: string; template: string; creative?: string; verify?: boolean};
type Read = CompiledRequest & {criteoCreativeState?: State; criteoTemplatePage?: {retailer: string; template: string}};
const gateway = 'criteo_native_action',
  origin = 'https://api.criteo.com',
  marker = 'AMCP_CRITEO_CREATIVE_READ',
  actions: Record<string, Kind> = {
    'criteo_creative_ops/CREATE_CREATIVE': 'create',
    'criteo_creative_ops/UPDATE_CREATIVE': 'update',
  },
  valueKeys: Record<string, string> = {
    Text: 'textVariableValue',
    Choice: 'choiceVariableValue',
    Color: 'colorVariableValue',
    Files: 'filesVariableValue',
    Hyperlink: 'hyperlinkVariableValue',
    Video: 'videoVariableValue',
  },
  maxValues = 100;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v);
const int = (v: unknown, max = 2147483647): v is number =>
  Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= max;
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function invalid(message: string): never {
  return fail('INVALID_CRITEO_CREATIVE', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
function httpsUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}
export function criteoCreativeKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== origin)) return;
  const kind = actions[p.action];
  if (kind === 'create')
    return p.method === 'POST' && criteoRoute('/accounts/[1-9][0-9]{0,18}/creatives$').test(p.path) ? kind : undefined;
  if (kind === 'update')
    return p.method === 'PUT' && criteoRoute('/accounts/[1-9][0-9]{0,18}/creatives/[1-9][0-9]{0,18}$').test(p.path)
      ? kind
      : undefined;
}
const accountOf = (p: CompiledRequest) => p.path.split('/')[4]!,
  creativeOf = (p: CompiledRequest) => p.path.split('/')[6]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
const values = (p: CompiledRequest): JsonObject[] =>
  Array.isArray(body(p).templateVariableValues) ? (body(p).templateVariableValues as JsonObject[]) : [];
/** The one value a template value carries, by its key. */
const valueKey = (v: JsonObject) => Object.keys(v).find(k => k !== 'id' && v[k] !== null && v[k] !== undefined);
function checkValue(v: unknown, at: string): void {
  if (!object(v) || typeof v.id !== 'string' || !text(v.id, 255)) invalid(at + ' names its template variable by id.');
  const keys = Object.keys(v).filter(k => k !== 'id');
  if (keys.length !== 1 || !Object.values(valueKeys).includes(keys[0]!))
    invalid(at + ' carries exactly one of ' + Object.values(valueKeys).join(', ') + '.');
  const k = keys[0]!,
    x = v[k];
  if (!object(x)) invalid(at + '.' + k + ' is an object.');
  const only = (...allowed: string[]) => {
    if (Object.keys(x).some(key => !allowed.includes(key)))
      invalid(at + '.' + k + ' takes ' + allowed.join(', ') + '.');
  };
  if (k === 'textVariableValue') {
    only('text');
    if (
      typeof x.text !== 'string' ||
      !x.text.trim() ||
      [...x.text].length > 10000 ||
      /[\u0000-\u0008\u000b-\u001f\u007f]/.test(x.text)
    )
      invalid(at + '.textVariableValue.text is text without control characters.');
  } else if (k === 'choiceVariableValue') {
    only('chosenOptions');
    const o = x.chosenOptions;
    if (!Array.isArray(o) || !o.every(c => text(c, 255)) || new Set(o).size !== o.length)
      invalid(at + '.choiceVariableValue.chosenOptions lists different option ids.');
  } else if (k === 'colorVariableValue') {
    only('color');
    if (typeof x.color !== 'string' || !/^#(([0-9a-fA-F]{2}){3}|([0-9a-fA-F]){3})$/.test(x.color))
      invalid(at + '.colorVariableValue.color is a hex colour such as #1A2B3C.');
  } else if (k === 'filesVariableValue') {
    only('assetIds');
    const a = x.assetIds;
    if (
      !Array.isArray(a) ||
      !a.length ||
      a.length > 50 ||
      !a.every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s))
    )
      invalid(at + '.filesVariableValue.assetIds lists the IDs CreateAsset returned.');
    if (new Set(a).size !== a.length) invalid(at + '.filesVariableValue.assetIds lists each asset once.');
  } else if (k === 'hyperlinkVariableValue') {
    only('url');
    if (!httpsUrl(x.url)) invalid(at + '.hyperlinkVariableValue.url is an HTTPS address without credentials.');
  } else {
    only('duration', 'height', 'url', 'width');
    if (!text(x.duration, 32) || !int(x.height, 10000) || !int(x.width, 10000) || !httpsUrl(x.url))
      invalid(at + '.videoVariableValue has duration, width, height and an HTTPS VAST url.');
  }
}
export function assertCriteoCreative(p: CompiledRequest): void {
  const kind = criteoCreativeKind(p);
  if (!kind) return;
  if (!id(p.accountId) || accountOf(p) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The request must use the selected Criteo account.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Creative writes take their body only, without query or header overrides.');
  const b = p.body;
  if (!object(b)) invalid('Send the creative as {name, retailerId, templateId, templateVariableValues, brandId?}.');
  const fields = ['name', 'retailerId', 'templateId', 'templateVariableValues', 'brandId'];
  const extra = Object.keys(b).filter(k => !fields.includes(k));
  if (extra.length) invalid('A creative takes ' + fields.join(', ') + '; unqualified: ' + extra.join(', ') + '.');
  if (!text(b.name, 255)) invalid('name has 1 to 255 characters without surrounding spaces or control characters.');
  if (!int(b.retailerId)) invalid('retailerId is the retailer of the template, as a number.');
  if (!int(b.templateId)) invalid('templateId is the creative template, as a number.');
  if (b.brandId !== undefined && b.brandId !== null && !int(b.brandId, Number.MAX_SAFE_INTEGER))
    invalid('brandId is a brand ID, as a number.');
  const list = b.templateVariableValues;
  if (!Array.isArray(list) || list.length > maxValues)
    invalid('templateVariableValues lists up to ' + maxValues + ' values of template variables.');
  list.forEach((v, i) => checkValue(v, 'templateVariableValues[' + i + ']'));
  const ids = list.map(v => (v as JsonObject).id);
  if (new Set(ids).size !== ids.length) invalid('Each template variable takes one value.');
}
export function assertCriteoCreativeScopes(c: {scopes: string[]}, write = false): void {
  const required = [
    'RetailMedia_Accounts_Read',
    'RetailMedia_Campaign_Read',
    ...(write ? ['RetailMedia_Campaign_Manage'] : []),
  ];
  if (!required.every(s => c.scopes.includes(s)))
    fail('INSUFFICIENT_SCOPE', 'The selected Criteo connection needs ' + required.join(', ') + '.', {}, 403);
}
const read = (
  p: CompiledRequest,
  path: string,
  query: JsonObject = {},
  bodyOf?: JsonObject,
  extra: Partial<Read> = {},
): Read =>
  readOf<Read>(
    p,
    {action: marker, method: bodyOf ? 'POST' : 'GET', path, query, body: bodyOf},
    {criteoCreativeState: undefined, criteoTemplatePage: undefined, ...extra},
  );
const retailerSearch = (p: CompiledRequest, retailer: string) =>
  read(
    p,
    criteoPrefix + '/accounts/' + p.accountId + '/retailers/search',
    {limit: 50, offset: 0},
    {data: {type: 'RetailerSearchRequest', attributes: {retailerIdFilter: [retailer]}}},
  );
const stateRead = (p: CompiledRequest, s: State): Read => ({...retailerSearch(p, s.retailer), criteoCreativeState: s});
export function criteoCreativeSnapshots(p: CompiledRequest): Read[] {
  const kind = criteoCreativeKind(p)!,
    b = body(p);
  return [
    stateRead(p, {
      kind,
      retailer: String(b.retailerId),
      template: String(b.templateId),
      ...(kind === 'update' ? {creative: creativeOf(p)} : {}),
    }),
  ];
}
export function isCriteoCreativeRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).criteoCreativeState;
}
/** The template read, which is not under the account: allowed only for the retailer the account's search returned. */
export function authorizeCriteoCreative(p: CompiledRequest, _c: Connection, account: string): boolean {
  const page = (p as Read).criteoTemplatePage;
  if (p.gateway !== gateway || p.action !== marker || !page) return false;
  if (
    p.method === 'GET' &&
    p.readOnly &&
    p.body === undefined &&
    p.accountId === account &&
    !Object.keys(p.query).length &&
    p.path === criteoPrefix + '/retailers/' + page.retailer + '/templates/' + page.template
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal template read.', {}, 403);
}
function envelope(r: TransportResult, what: string): JsonObject {
  const d = r.data;
  if (
    ![200, 201].includes(r.status) ||
    !object(d) ||
    ['errors', 'warnings'].some(k => d[k] != null && (!Array.isArray(d[k]) || (k === 'errors' && d[k].length)))
  )
    unverified('Criteo returned a failed or unrecognized ' + what + ' read.');
  return d as JsonObject;
}
type Variable = {id: string; type: string; required: boolean; spec: JsonObject; under: string | null};
/** Every variable of a template, with the choice option that unlocks it (dependent variables). */
function variables(template: JsonObject): Variable[] {
  const out: Variable[] = [];
  const walk = (list: unknown, under: string | null) => {
    for (const v of Array.isArray(list) ? (list as JsonObject[]) : []) {
      if (!object(v) || typeof v.id !== 'string') continue;
      const spec: JsonObject = {};
      if (object(v.textVariableSpecification) && v.textVariableSpecification.maxChars != null)
        spec.maxChars = Number(v.textVariableSpecification.maxChars);
      const f = v.filesVariablesSpecification;
      if (object(f)) {
        if (f.minFiles != null) spec.minFiles = Number(f.minFiles);
        if (f.maxFile != null) spec.maxFiles = Number(f.maxFile);
        if (Array.isArray(f.extensions)) spec.extensions = f.extensions.map(String);
      }
      const c = v.choiceVariableSpecification;
      if (object(c)) {
        spec.options = (Array.isArray(c.options) ? c.options : []).map((o: JsonObject) => String(o.id));
        if (c.minSelected != null) spec.minSelected = Number(c.minSelected);
        if (c.maxSelected != null) spec.maxSelected = Number(c.maxSelected);
      }
      out.push({id: v.id, type: String(v.type), required: v.required === true, spec, under});
      if (object(c))
        for (const o of (Array.isArray(c.options) ? c.options : []) as JsonObject[])
          walk(o.dependentVariables, v.id + '=' + String(o.id));
    }
  };
  for (const s of Array.isArray(template.sections) ? (template.sections as JsonObject[]) : [])
    walk(s?.templateVariables, null);
  return out;
}
/** A value as AMCP compares it: the variable and its one value, colours in upper case. */
function valueView(v: JsonObject): JsonObject {
  const k = valueKey(v);
  if (!k) return {id: String(v.id)};
  const x = v[k] as JsonObject;
  return {
    id: String(v.id),
    [k]:
      k === 'colorVariableValue'
        ? {color: String(x.color).toUpperCase()}
        : k === 'choiceVariableValue'
          ? {chosenOptions: [...(x.chosenOptions as string[])].map(String).sort()}
          : k === 'filesVariableValue'
            ? {assetIds: (x.assetIds as unknown[]).map(String)}
            : k === 'videoVariableValue'
              ? {duration: x.duration, height: Number(x.height), url: x.url, width: Number(x.width)}
              : x,
  };
}
const valuesView = (list: unknown): JsonObject[] =>
  (Array.isArray(list) ? (list as JsonObject[]) : [])
    .filter(object)
    .map(valueView)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
const creativeView = (r: JsonObject): JsonObject => {
  const a = object(r.attributes) ? r.attributes : {};
  return {
    present: true,
    id: String(r.id),
    name: a.name ?? null,
    retailerId: a.retailerId == null ? null : Number(a.retailerId),
    templateId: a.templateId == null ? null : Number(a.templateId),
    brandId: a.brandId == null ? null : Number(a.brandId),
    status: a.status ?? null,
    line_items: (Array.isArray(a.associatedLineItemIds) ? a.associatedLineItemIds.map(String) : []).sort(),
    templateVariableValues: valuesView(a.templateVariableValues),
  };
};
/** The retailer among the account's retailers, its template and, for an update, the creative. */
export async function readCriteoCreatives(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).criteoCreativeState;
  if (!s) return fetch(p);
  const creative = async (cid: string) => {
    try {
      const d = envelope(
        await fetch(read(p, criteoPrefix + '/accounts/' + p.accountId + '/creatives/' + cid)),
        'creative',
      );
      return object(d.data) && String(d.data.id) === cid ? creativeView(d.data) : undefined;
    } catch (e) {
      if (e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND')) return undefined;
      throw e;
    }
  };
  if (s.verify) {
    const c = await creative(s.creative!);
    return {status: 200, headers: {}, data: {creative: c ?? {present: false, id: s.creative}}};
  }
  const found = envelope(await fetch(retailerSearch(p, s.retailer)), 'retailer');
  const row = (Array.isArray(found.data) ? (found.data as JsonObject[]) : []).find(
    r => object(r) && String(r.id) === s.retailer,
  );
  const out: JsonObject = {
    account_id: p.accountId!,
    retailer: row ? {id: s.retailer, name: object(row.attributes) ? (row.attributes.name ?? null) : null} : null,
  };
  if (row) {
    let t: JsonObject | undefined;
    try {
      t = envelope(
        await fetch(
          read(p, criteoPrefix + '/retailers/' + s.retailer + '/templates/' + s.template, {}, undefined, {
            criteoTemplatePage: {retailer: s.retailer, template: s.template},
          }),
        ),
        'template',
      );
    } catch (e) {
      if (!(e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND'))) throw e;
    }
    const a = t && object(t.data) && object(t.data.attributes) ? t.data.attributes : undefined;
    out.template = a
      ? {id: s.template, name: a.name ?? null, format: a.creativeFormat ?? null, variables: variables(a)}
      : null;
  }
  if (s.creative) out.creative = (await creative(s.creative)) ?? {present: false, id: s.creative};
  return {status: 200, headers: {}, data: out};
}
export function validateCriteoCreativeState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).criteoCreativeState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify ? !object(d.creative) : !('retailer' in d)))
    unverified('Missing verified creative state.');
}
export function criteoCreativePrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = criteoCreativeKind(p);
  if (!kind) return;
  const s = states[0],
    b = body(p);
  if (!object(s)) unverified('Missing verified creative state.');
  if (!object(s.retailer))
    fail('STATE_TARGET_MISMATCH', 'Retailer ' + String(b.retailerId) + ' is not a retailer of the account.', {}, 409);
  if (!object(s.template))
    fail(
      'STATE_NOT_FOUND',
      'Template ' + String(b.templateId) + ' is not a template of retailer ' + String(b.retailerId) + '.',
      {},
      404,
    );
  const vars = s.template.variables as Variable[],
    byId = new Map(vars.map(v => [v.id, v])),
    sent = new Map(values(p).map(v => [String(v.id), v]));
  // A dependent variable counts only when the option that unlocks it is chosen.
  const chosen = new Set<string>();
  for (const v of values(p))
    if (object(v.choiceVariableValue))
      for (const o of v.choiceVariableValue.chosenOptions as string[]) chosen.add(String(v.id) + '=' + o);
  const open = (v: Variable) => v.under === null || chosen.has(v.under);
  // Choices first: an unknown option says more than the dependent variable it would have unlocked.
  const order = [...sent].sort(
    ([, x], [, y]) => Number(!object(x.choiceVariableValue)) - Number(!object(y.choiceVariableValue)),
  );
  for (const [vid, v] of order) {
    const t = byId.get(vid);
    if (!t) invalid('Template ' + String(b.templateId) + ' has no variable ' + vid + '.');
    if (!open(t))
      invalid(
        'Variable ' +
          vid +
          ' depends on option ' +
          t.under!.split('=')[1] +
          ' of ' +
          t.under!.split('=')[0] +
          ', which is not chosen.',
      );
    if (valueKey(v) !== valueKeys[t.type])
      invalid('Variable ' + vid + ' is a ' + t.type + ' variable; send ' + valueKeys[t.type] + '.');
    const x = v[valueKeys[t.type]!] as JsonObject,
      sp = t.spec;
    if (t.type === 'Text' && sp.maxChars != null && [...String(x.text)].length > Number(sp.maxChars))
      invalid('Variable ' + vid + ' takes at most ' + String(sp.maxChars) + ' characters.');
    if (t.type === 'Choice') {
      const picked = x.chosenOptions as string[],
        unknown = picked.filter(o => !(sp.options as string[]).includes(o));
      if (unknown.length) invalid('Variable ' + vid + ' has no option ' + unknown.join(', ') + '.');
      if (
        (sp.minSelected != null && picked.length < Number(sp.minSelected)) ||
        (sp.maxSelected != null && picked.length > Number(sp.maxSelected))
      )
        invalid(
          'Variable ' +
            vid +
            ' takes ' +
            String(sp.minSelected ?? 0) +
            ' to ' +
            String(sp.maxSelected ?? 'any number of') +
            ' options.',
        );
    }
    if (t.type === 'Files') {
      const n = (x.assetIds as string[]).length;
      if ((sp.minFiles != null && n < Number(sp.minFiles)) || (sp.maxFiles != null && n > Number(sp.maxFiles)))
        invalid(
          'Variable ' +
            vid +
            ' takes ' +
            String(sp.minFiles ?? 1) +
            ' to ' +
            String(sp.maxFiles ?? 'any number of') +
            ' files.',
        );
    }
  }
  const missing = vars.filter(v => v.required && open(v) && !sent.has(v.id)).map(v => v.id);
  if (missing.length) invalid('Template ' + String(b.templateId) + ' requires ' + missing.join(', ') + '.');
  if (kind === 'create') return;
  const c = s.creative;
  if (!object(c) || c.present === false)
    fail('STATE_NOT_FOUND', 'Creative ' + creativeOf(p) + ' is not a creative of the account.', {}, 404);
  if (['Archived', 'Deleted'].includes(String(c.status)))
    invalid('Creative ' + creativeOf(p) + ' is ' + String(c.status) + '.');
  if (c.retailerId !== b.retailerId || c.templateId !== b.templateId)
    invalid(
      'An update keeps the retailer and template of the creative (' +
        String(c.retailerId) +
        ', ' +
        String(c.templateId) +
        '); create a new creative for another.',
    );
  if (
    c.name === b.name &&
    (b.brandId === undefined || (b.brandId ?? null) === c.brandId) &&
    stable(c.templateVariableValues) === stable(valuesView(values(p)))
  )
    invalid('Creative ' + creativeOf(p) + ' already has these values.');
}
export function criteoCreativeImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = criteoCreativeKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    b = body(p),
    t = object(s.template) ? s.template : null,
    c = object(s.creative) ? s.creative : null,
    after = {name: b.name, brandId: b.brandId ?? null, templateVariableValues: valuesView(values(p))},
    lines = c && Array.isArray(c.line_items) ? (c.line_items as string[]) : [];
  const files = values(p).some(v => object(v.filesVariableValue));
  return {
    provider: 'criteo',
    scope: 'creative',
    operation: kind,
    retailer: s.retailer ?? null,
    template: t ? {id: t.id, name: t.name, format: t.format} : null,
    ...(kind === 'create'
      ? {creating: after}
      : {
          before: c ? {name: c.name, brandId: c.brandId, templateVariableValues: c.templateVariableValues} : null,
          after,
        }),
    ...(lines.length ? {line_items: lines} : {}),
    ...(files
      ? {
          note: 'Files name asset IDs from CreateAsset; Criteo offers no read of an asset, so it checks their format and size itself.',
        }
      : {}),
    may_affect_serving: kind === 'update' && lines.length > 0,
    effect:
      kind === 'create'
        ? 'Creates the creative in the account from the template. Line items use it through their own reviewed changes.'
        : 'Replaces the name and values of the creative (the PUT sends the whole creative)' +
          (lines.length ? '; line items ' + lines.join(', ') + ' use it.' : '.'),
    verification: 'Reads the creative again and compares name, retailer, template, brand and every value.',
    source: 'https://developers.criteo.com/retail-media/reference',
  };
}
export function criteoCreativeOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  if (![200, 201].includes(r.status) || !object(d) || (Array.isArray(d.errors) && d.errors.length) || !object(d.data))
    return false;
  const x = d.data;
  return id(String(x.id ?? '')) && (criteoCreativeKind(p) === 'create' || String(x.id) === creativeOf(p));
}
export function criteoCreativeVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = criteoCreativeKind(p)!,
    cid = kind === 'create' ? String(result.data?.data?.id ?? '') : creativeOf(p),
    b = body(p);
  if (!id(cid)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no creative.');
  return [
    {
      read: stateRead(p, {
        kind,
        retailer: String(b.retailerId),
        template: String(b.templateId),
        creative: cid,
        verify: true,
      }),
      expected: {
        creative: {
          present: true,
          id: cid,
          name: b.name,
          retailerId: b.retailerId,
          templateId: b.templateId,
          ...(b.brandId !== undefined ? {brandId: b.brandId ?? null} : {}),
          templateVariableValues: valuesView(values(p)),
        },
      },
      id: 'creative ' + cid,
    },
  ];
}
export function criteoCreativeObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {creative: object(data.creative) ? data.creative : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const criteoCreativeFamily: ReviewedFamily = defineFamily({
  name: 'criteo_creatives',
  files: ['src/criteo-creatives.ts', ['tests/criteo-creatives.test.mjs']],
  kind: criteoCreativeKind,
  operation: createsOnPost,
  assert: plan => assertCriteoCreative(plan),
  scope: (c, write) => assertCriteoCreativeScopes(c, write),
  authorize: authorizeCriteoCreative,
  snapshots: criteoCreativeSnapshots,
  isRead: isCriteoCreativeRead,
  reader: readCriteoCreatives,
  validateState: validateCriteoCreativeState,
  prerequisites: criteoCreativePrerequisites,
  impact: criteoCreativeImpact,
  outcome: criteoCreativeOutcome,
  verification: criteoCreativeVerification,
  observed: criteoCreativeObserved,
});
