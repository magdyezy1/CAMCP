import {Ajv, type ErrorObject} from 'ajv';
import addFormatsModule from 'ajv-formats';
import {MirrorError} from './errors.js';
import {guardInput, stable as stableStringify} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {DelegatedScopeContext} from './provider-adapter.js';
import {pinnedJson} from './pinned-json.js';
import {nativeParameterKey} from './parameter-key.js';
import {providerHooks, registeredProviderHooks} from './provider-hooks.js';

export interface VendorRoute {
  gateway: string;
  operation: string;
  action: string;
  vendorMethod: string;
  source: string;
  sourceFile: string;
  origin: string;
  path: string;
  method: string;
  readOnly: boolean;
  parameters: Record<string, JsonObject>;
  requestSchema?: JsonObject;
  responseSchemas?: Record<string, JsonObject>;
  requestRef?: string;
  bodyRequired: boolean;
  scopes: string[];
  evidence: string;
  unsupportedMedia?: string[];
}
export interface VendorRoutes {
  formatVersion: number;
  routes: VendorRoute[];
  gaps: JsonObject[];
  schemaComponents?: Record<string, JsonObject>;
}
const record = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
const normalize = nativeParameterKey;
const scopeKeys = new Set(['accountid', 'property', 'siteurl']);
const resourceFields: Record<string, string[]> = {
  accounts: ['account_id'],
  properties: ['property'],
  containers: ['container_id'],
  workspaces: ['workspace_id'],
  versions: ['version_id'],
  user_permissions: ['user_permission_id'],
  destinations: ['destination_id'],
  environments: ['environment_id'],
  variables: ['variable_id'],
  triggers: ['trigger_id'],
  tags: ['tag_id'],
  gtag_config: ['gtag_config_id'],
  templates: ['template_id'],
  folders: ['folder_id'],
  zones: ['zone_id'],
  clients: ['client_id'],
  transformations: ['transformation_id'],
  locations: ['location_id'],
  admins: ['admin_id'],
  invitations: ['invitation_id'],
  placeActionLinks: ['place_action_link_id'],
  verifications: ['verification_id'],
  chains: ['chain_id'],
  audienceExports: ['audience_export_name'],
  reportTasks: ['report_task_name'],
};
const extraAliases: Record<string, string[]> = {
  siteUrl: ['site_url', 'site', 'property_url'],
  feedpath: ['sitemap_url'],
  inspectionUrl: ['inspection_url', 'url'],
  languageCode: ['language_code'],
  lineItemId: ['line_item_id', 'externalLineItemId', 'external_line_item_id'],
  limitToId: ['limitToIds'],
};
const forbiddenQuery = new Set(['access_token', 'oauth_token', 'key']);
/** An Ajv for vendor schemas: unknown keywords tolerated, every error reported, nothing coerced, defaulted or removed. */
function vendorAjv(): Ajv {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    useDefaults: false,
    coerceTypes: false,
    removeAdditional: false,
  });
  (addFormatsModule as unknown as (ajv: Ajv) => void)(ajv);
  ajv.addFormat('long-id', {
    type: 'string',
    validate: (value: string) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
  });
  return ajv;
}

/**
 * Properties a provider's answer carries that the pinned schema of its route does not declare (r25-hotfix, 5.8b of the
 * live checks of 2026-11-15, when Reddit added `ugc_addon_default_on` to its account read). A provider adding a response
 * field is not a contract break, so a read still succeeds; this says where and which, never what the values were.
 */
export interface VendorSchemaDrift {
  /** The pinned route's own name for the operation, which AMCP wrote (never provider text). */
  vendor_method: string;
  /**
   * Each place that carried some, and their names. A place is a JSON Pointer in which the answer itself is `/` and a row
   * index, or a key the provider chose, is `*`.
   */
  unexpected: {path: string; properties: string[]}[];
  /** How many names beyond the limit are not listed. */
  omitted?: number;
}
const driftNameLimit = 50;
const clipText = (text: string, limit: number) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * The drift of (place, name) pairs: each pair once, the places and the names in order, at most `driftNameLimit` names
 * listed and the rest counted. The same order whatever the order of the pages or of the provider's properties.
 */
function vendorDrift(vendorMethod: string, pairs: Iterable<readonly [string, string]>, omitted = 0) {
  const unique = new Map<string, readonly [string, string]>();
  for (const pair of pairs) unique.set(pair[0] + '\u0000' + pair[1], pair);
  const sorted = [...unique.values()].sort((a, b) => byText(a[0], b[0]) || byText(a[1], b[1])),
    kept = sorted.slice(0, driftNameLimit),
    places = new Map<string, string[]>();
  for (const [path, name] of kept) places.set(path, [...(places.get(path) ?? []), name]);
  const left = omitted + sorted.length - kept.length;
  if (!kept.length) return undefined;
  const drift: VendorSchemaDrift = {
    vendor_method: vendorMethod,
    unexpected: [...places].map(([path, properties]) => ({path, properties})),
  };
  if (left) drift.omitted = left;
  return drift;
}
/**
 * The place of an instance path: a segment is shown only when it looks like a property name. A row index, an ID, and a key
 * the provider chose for a map (an advertiser's own text, an e-mail address) are `*`, so one place stands for every row
 * and no value the answer chose reaches the drift or the audit.
 */
const propertyName = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const placeOf = (instancePath: string) =>
  (
    '/' +
    instancePath
      .split('/')
      .slice(1)
      .map(segment => (propertyName.test(segment) ? segment : '*'))
      .join('/')
  ).slice(0, 200);
/** The drift a strict validation reported: its `additionalProperties` errors, rows collapsed into one place. */
function driftOf(errors: readonly ErrorObject[] | null | undefined, vendorMethod: string) {
  const pairs: [string, string][] = [];
  for (const error of errors ?? []) {
    const name = (error.params as {additionalProperty?: unknown} | undefined)?.additionalProperty;
    if (error.keyword === 'additionalProperties' && typeof name === 'string')
      pairs.push([placeOf(error.instancePath), clipText(name, 80)]);
  }
  return vendorDrift(vendorMethod, pairs);
}
/** The drifts of the pages of one read as one: by place, names once, the name limit applied again. */
export function mergeVendorDrift(parts: readonly VendorSchemaDrift[]): VendorSchemaDrift | undefined {
  if (!parts.length) return undefined;
  return vendorDrift(
    parts[0]!.vendor_method,
    parts.flatMap(part =>
      part.unexpected.flatMap(({path, properties}) => properties.map(name => [path, name] as const)),
    ),
    parts.reduce((sum, part) => sum + (part.omitted ?? 0), 0),
  );
}
// The keywords whose value is a map of names to schemas (the keys are names, not keywords) and those whose value is data.
const schemaMaps = new Set(['properties', 'patternProperties', 'definitions', '$defs', 'schemas', 'dependentSchemas']);
const dataKeywords = new Set(['enum', 'const', 'default', 'example', 'examples']);
/**
 * A copy of a vendor schema, or of its components, with every closed object opened: each `additionalProperties: false` is
 * left out, wherever it occurs, so an object may carry properties the schema does not declare while each declared one
 * keeps its type, enum, format and required checks. A typed `additionalProperties` (a map of text, say) is not closed and
 * stays as it is. Never changes its argument: the pinned data is shared with the request checks, which stay strict.
 */
function openClosedObjects(node: unknown, namesOnly = false): unknown {
  if (Array.isArray(node)) return node.map(item => openClosedObjects(item));
  if (!node || typeof node !== 'object') return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (!namesOnly && key === 'additionalProperties' && value === false) continue;
    out[key] =
      !namesOnly && dataKeywords.has(key) ? value : openClosedObjects(value, !namesOnly && schemaMaps.has(key));
  }
  return out;
}
/**
 * The provider's part of the delegated compiler (ARC-01 phase B, src/<provider>-adapter.ts), consulted at the step where
 * the compiler named the provider; the compiler keeps every rule and the order of every step.
 */
const delegatedHooks = (gateway: string) => providerHooks(gateway)?.delegated;
/** The other names a provider's tool gives a native parameter (Reddit's), none otherwise. */
const providerAliases = (gateway: string, native: string) => delegatedHooks(gateway)?.aliases?.(native) ?? [];
/** Whether a delegated argument name addresses this native parameter: its own name or one of its aliases. */
export function delegatedParameterMatches(gateway: string, argument: string, native: string): boolean {
  const names = [native, ...(extraAliases[native] ?? []), ...providerAliases(gateway, native)];
  return names.some(name => normalize(name) === normalize(argument));
}
function valuesFor(key: string, bags: JsonObject[], extra: string[] = []): unknown[] {
  const names = new Set([key, ...extra, ...(extraAliases[key] ?? [])].map(normalize));
  return bags.flatMap(b =>
    Object.entries(b)
      .filter(([k, v]) => names.has(normalize(k)) && v !== undefined && v !== null && v !== '')
      .map(([, v]) => v),
  );
}
function singleValue(key: string, bags: JsonObject[], extra: string[] = []): unknown {
  const candidates = valuesFor(key, bags, extra),
    first = candidates[0];
  const comparable = (v: unknown) =>
    normalize(key) === 'accountid' ? resourceId(v, 'accounts') : key === 'property' ? resourceId(v, 'properties') : v;
  if (candidates.some(v => stableStringify(comparable(v)) !== stableStringify(comparable(first))))
    throw new MirrorError(
      scopeKeys.has(normalize(key)) ? 'ACCOUNT_SCOPE_MISMATCH' : 'CONFLICTING_PARAMETER',
      'Conflicting aliases for ' + key + '.',
      {parameter: key},
      403,
    );
  return first;
}
function resourceId(value: unknown, resource: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new MirrorError('INVALID_RESOURCE_NAME', 'Resource identifier must be a string.', {resource});
  const v = String(value);
  if (v.startsWith(resource + '/')) {
    const id = v.slice(resource.length + 1);
    if (!id || id.includes('/'))
      throw new MirrorError(
        'INVALID_RESOURCE_NAME',
        'Use the exact resource ID or matching resource name, without trailing path segments.',
        {resource},
      );
    return id;
  }
  return v;
}
function sameResource(left: unknown, right: unknown, resource: string): boolean {
  return resourceId(left, resource) === resourceId(right, resource);
}
function ensureSimple(value: string, key: string) {
  if (!value || /[\x00-\x20\\?#%]/.test(value) || value.split('/').some(s => s === '.' || s === '..' || !s))
    throw new MirrorError('INVALID_PATH_PARAMETER', 'Unsafe resource path parameter.', {parameter: key});
}
function buildResource(pattern: string, args: JsonObject, key: string, params: JsonObject): string | undefined {
  // Discovery supplies fixed resource templates expressed as anchored regular expressions.
  const template = pattern.replace(/^\^|\$$/g, '').replaceAll('[^/]+', '*');
  if (/[\[\]()+?\\]/.test(template)) return undefined;
  const segments = template.split('/'),
    out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s !== '*') {
      out.push(s);
      continue;
    }
    const resource = segments[i - 1]!,
      fields = resourceFields[resource];
    if (!fields) return undefined;
    const candidates = valuesFor(fields[0]!, [args, params], fields.slice(1));
    if (candidates.length === 0 && i === segments.length - 1 && args.id !== undefined) candidates.push(args.id);
    const first = candidates[0];
    if (first === undefined) return undefined;
    if (candidates.some(v => !sameResource(v, first, resource)))
      throw new MirrorError(
        'CONFLICTING_PARAMETER',
        'Conflicting resource identifier aliases.',
        {parameter: key, resource},
        403,
      );
    const raw = String(first);
    // A fully qualified audience/report name can supply the whole resource, but must match its parent later.
    if (raw.includes('/') && new RegExp(pattern).test(raw)) return raw;
    const id = resourceId(first, resource)!;
    ensureSimple(id, key);
    if (id.includes('/'))
      throw new MirrorError('INVALID_RESOURCE_NAME', 'Use an ID or the matching resource name.', {
        parameter: key,
        resource,
      });
    out.push(id);
  }
  return out.join('/');
}
function checkParameter(value: unknown, schema: JsonObject, key: string) {
  const repeated = schema.repeated === true || schema.type === 'array';
  if (repeated) {
    if (!Array.isArray(value))
      throw new MirrorError('INVALID_PARAMETER', 'Repeated query parameters must be arrays.', {parameter: key});
    for (const item of value)
      checkParameter(
        item,
        {
          ...schema,
          ...record(schema.items),
          type: schema.type === 'array' ? schema.items?.type : schema.type,
          repeated: false,
        },
        key,
      );
    return;
  }
  if (Array.isArray(value) || (value !== null && typeof value === 'object'))
    throw new MirrorError('INVALID_PARAMETER', 'Expected a scalar query parameter.', {parameter: key});
  const type = schema.type;
  if (
    (type === 'boolean' && typeof value !== 'boolean') ||
    (type === 'integer' &&
      !(
        (typeof value === 'number' && Number.isSafeInteger(value)) ||
        (schema.format === 'int64' && typeof value === 'string' && /^-?\d+$/.test(value))
      )) ||
    (type === 'number' && typeof value !== 'number') ||
    (type === 'string' && typeof value !== 'string')
  )
    throw new MirrorError('INVALID_PARAMETER', 'Incorrect query parameter type.', {parameter: key, type});
  if (schema.enum && !schema.enum.includes(value))
    throw new MirrorError('INVALID_PARAMETER', 'Unsupported query parameter value.', {
      parameter: key,
      allowed: schema.enum,
    });
  if (
    (schema.minimum !== undefined && Number(value) < Number(schema.minimum)) ||
    (schema.maximum !== undefined && Number(value) > Number(schema.maximum))
  )
    throw new MirrorError('INVALID_PARAMETER', 'Query parameter is outside vendor bounds.', {parameter: key});
}
function scopeFrom(
  route: VendorRoute,
  args: JsonObject,
  path: string,
  body: JsonObject,
  query: JsonObject,
): string | undefined {
  const scope = delegatedHooks(route.gateway)?.scope,
    context: DelegatedScopeContext = {route, args, path, body, query, resourceId, sameResource, singleValue};
  // A provider whose requests another resource scopes (GA4's property, Search Console's site).
  if (scope?.own) return scope.own(context);
  const account = singleValue(
    'account_id',
    [args, record(args.params), record(args.path_params)],
    [...(scope?.account?.aliases ?? [])],
  ) as string | undefined;
  const match = path.match(scope?.account?.path ?? /\/accounts\/([^/:]+)/);
  const id = resourceId(account, 'accounts');
  if (match && id && decodeURIComponent(match[1]!) !== id)
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'The request resource belongs to a different account.', {}, 403);
  // A provider whose requests a resource inside the account may scope (Business Profile's locations).
  if (scope?.refine) return scope.refine(context, {account, id, match});
  return id ?? (match ? decodeURIComponent(match[1]!) : undefined);
}

/** Compiles one vendor request only. OAuth, persistence, authentication, ownership checks and execution belong to the service. */
export class DelegatedNativeCompiler {
  readonly data: VendorRoutes;
  private routes = new Map<string, VendorRoute>();
  private validators = new Map<string, ReturnType<Ajv['compile']>>();
  private ajv = vendorAjv();
  // The checks a read applies to a response (validateReadResponse): the pinned schemas with their closed objects opened,
  // compiled apart from the strict ones, and the components they share, opened once per source.
  private readValidators = new Map<string, ReturnType<Ajv['compile']>>();
  private readAjv?: Ajv;
  private readComponents = new Map<string, unknown>();
  constructor(data?: VendorRoutes) {
    const source = data ?? pinnedJson<VendorRoutes>('generated/vendor-routes.json');
    // A provider compiled by its own entry point (Google Ads' direct compilation and ProtoJSON validation): a vendor
    // snapshot must not accidentally create a second delegated API.
    this.data = {...source, routes: source.routes.filter((r: VendorRoute) => !delegatedHooks(r.gateway)?.direct)};
    if (this.data.formatVersion !== 1) throw new Error('Unsupported vendor routes format.');
    for (const r of this.data.routes) {
      const key = this.key(r.gateway, r.operation, r.action);
      if (this.routes.has(key)) throw new Error('Duplicate delegated route: ' + key);
      this.routes.set(key, r);
    }
    // A provider's own routes beside the snapshot's, when the snapshot holds the schemas they use (Reddit's).
    for (const {delegated} of registeredProviderHooks)
      if (delegated?.routes && this.data.schemaComponents?.[delegated.routes.components])
        for (const r of delegated.routes.list()) this.routes.set(this.key(r.gateway, r.operation, r.action), r);
  }
  private key(gateway: string, operation: string, action: string) {
    return gateway + '/' + operation + '/' + action;
  }
  canCompile(gateway: string, input: JsonObject): boolean {
    return this.routes.has(this.key(gateway, String(input.operation ?? ''), String(input.arguments?.action ?? '')));
  }
  isNativeOperation(gateway: string, operation: string): boolean {
    return this.data.routes.some(r => r.gateway === gateway && r.operation === operation);
  }
  /**
   * The strict check of a route's pinned response schema for a status: its route, schema and key, and whether `data`
   * satisfies it exactly as pinned, with the errors if not. Nothing when the route pins no response schema; a status it
   * does not document is refused.
   */
  private responseCheck(plan: CompiledRequest, data: unknown, status: number) {
    const route = this.routes.get(plan.gateway + '/' + plan.action);
    if (!route?.responseSchemas) return undefined;
    const schema = route.responseSchemas[String(status)];
    if (!schema)
      throw new MirrorError(
        'UPSTREAM_RESPONSE_INVALID',
        'Vendor returned an undocumented successful status for this route.',
        {status, vendor_method: route.vendorMethod},
        502,
      );
    const key = 'response/' + plan.gateway + '/' + plan.action + '/' + status;
    let validator = this.validators.get(key);
    if (!validator) {
      validator = this.ajv.compile({...schema, components: this.data.schemaComponents?.[route.sourceFile]});
      this.validators.set(key, validator);
    }
    const valid = !!validator(data);
    return {route, schema, key, valid, errors: valid ? null : [...(validator.errors ?? [])]};
  }
  private invalidResponse(route: VendorRoute, errors: unknown) {
    return new MirrorError(
      'UPSTREAM_RESPONSE_INVALID',
      'Vendor response does not satisfy its published JSON schema.',
      {errors, vendor_method: route.vendorMethod},
      502,
    );
  }
  /**
   * The check of a reviewed write's response: exactly as pinned. A write's response is held to its pinned schema as it
   * always was, a closed object included, because a response that names something it should not (an account or a profile
   * of someone else) must not pass as the answer to this write. A read uses validateReadResponse.
   */
  validateResponse(plan: CompiledRequest, data: unknown, status: number): void {
    const checked = this.responseCheck(plan, data, status);
    if (checked && !checked.valid) throw this.invalidResponse(checked.route, checked.errors);
  }
  /**
   * The check of a read's response (r25-hotfix, 5.8b of the live checks of 2026-11-15). A published response schema is not
   * a closed contract: a provider adds response fields without breaking it. The answer must satisfy the pinned schema
   * exactly, or satisfy it once its closed objects are opened (every type, enum, format and required check of the declared
   * properties stays): then it is accepted, and the properties it added are returned as drift for the caller to report.
   * Anything else is refused as before, and the refusal names the mismatch, never an added property.
   */
  validateReadResponse(plan: CompiledRequest, data: unknown, status: number): VendorSchemaDrift | undefined {
    const checked = this.responseCheck(plan, data, status);
    if (!checked || checked.valid) return undefined;
    let validator = this.readValidators.get(checked.key);
    if (!validator) {
      const source = checked.route.sourceFile;
      if (!this.readComponents.has(source))
        this.readComponents.set(source, openClosedObjects(this.data.schemaComponents?.[source]));
      validator = (this.readAjv ??= vendorAjv()).compile({
        ...(openClosedObjects(checked.schema) as JsonObject),
        components: this.readComponents.get(source),
      });
      this.readValidators.set(checked.key, validator);
    }
    if (!validator(data)) throw this.invalidResponse(checked.route, validator.errors);
    return driftOf(checked.errors, checked.route.vendorMethod);
  }
  compile(gateway: string, input: JsonObject): CompiledRequest {
    guardInput(input);
    const args = record(input.arguments),
      operation = String(input.operation ?? ''),
      action = String(args.action ?? '');
    const route = this.routes.get(this.key(gateway, operation, action));
    if (!route) {
      const gap = this.data.gaps.find(g => g.gateway === gateway && g.operation === operation && g.action === action);
      throw new MirrorError(
        'DELEGATED_ROUTE_UNAVAILABLE',
        'This operation needs a workflow adapter or an unambiguous vendor contract.',
        {
          gateway,
          operation,
          action,
          ...(gap ? {reason: gap.reason} : {}),
          next_step:
            'Use a documented supported action; connection and multi-request workflows must be handled by their service adapter.',
        },
      );
    }
    if (route.unsupportedMedia)
      throw new MirrorError(
        'SPECIAL_TRANSPORT_REQUIRED',
        'This endpoint requires a binary or multipart upload adapter.',
        {
          gateway,
          operation,
          action,
          media_types: route.unsupportedMedia,
          next_step: 'Provide a validated upload workflow; JSON payloads cannot represent this vendor operation.',
        },
      );
    if (args.api_version && args.api_version !== route.path.split('/')[1])
      throw new MirrorError(
        'API_VERSION_UNAVAILABLE',
        'The requested version has no generated route for this action.',
        {requested: args.api_version, available: route.path.split('/')[1]},
      );
    const hooks = delegatedHooks(gateway),
      params = record(args.params),
      explicit = record(args.path_params),
      queryInput = record(args.query);
    const aliases = (key: string) => [...providerAliases(gateway, key)];
    const bodyAllowed = route.requestSchema !== undefined || route.bodyRequired;
    // The argument that carries the body: payload, or the provider's own (GA4's request).
    const suppliedBody = args[hooks?.bodyArgument ?? 'payload'];
    if (
      suppliedBody !== undefined &&
      (!suppliedBody || typeof suppliedBody !== 'object' || Array.isArray(suppliedBody))
    )
      throw new MirrorError('INVALID_JSON_BODY', 'This operation requires an object request body.');
    let body = structuredClone(record(suppliedBody));
    // Body fields the provider's arguments may give at the top level (Search Console's URL inspection).
    for (const field of hooks?.bodyFields?.(action) ?? []) {
      const value = singleValue(field, [args, params, explicit, body]);
      if (value !== undefined) body[field] = value;
    }
    const values: JsonObject = {};
    for (const [key, schema] of Object.entries(route.parameters).filter(([, s]) => s.location === 'path')) {
      let value = singleValue(key, [explicit, params], aliases(key));
      const direct = singleValue(key, [args], aliases(key));
      if (direct !== undefined) {
        const prefixed =
          key === 'property' && typeof direct === 'string' && !direct.startsWith('properties/')
            ? 'properties/' + direct
            : direct;
        if (value !== undefined && stableStringify(value) !== stableStringify(prefixed))
          throw new MirrorError('CONFLICTING_PARAMETER', 'Conflicting explicit path values.', {parameter: key}, 403);
        value = prefixed;
      }
      if (value === undefined && schema.pattern) value = buildResource(schema.pattern, args, key, params);
      if (value === undefined)
        throw new MirrorError('MISSING_PARAMETER', 'Missing vendor path parameter: ' + key + '.', {
          parameter: key,
          pattern: schema.pattern,
          next_step: hooks?.missingPathStep ?? 'Supply friendly resource IDs or the exact path parameter.',
        });
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new MirrorError('INVALID_PARAMETER', 'Path parameters must be string identifiers.', {parameter: key});
      const string = String(value);
      if (schema.pattern && !new RegExp(schema.pattern).test(string))
        throw new MirrorError('INVALID_RESOURCE_NAME', 'Resource name does not match the vendor template.', {
          parameter: key,
          pattern: schema.pattern,
        });
      if (key === 'siteUrl' || key === 'feedpath') {
        if (
          /[\x00-\x20\\]/.test(string) ||
          !((key === 'siteUrl' && /^sc-domain:[^/?#]+$/.test(string)) || /^https?:\/\//.test(string))
        )
          throw new MirrorError('INVALID_SITE_URL', 'Supply a complete HTTP(S) URL or sc-domain property.', {
            parameter: key,
          });
        if (/^https?:/.test(string)) {
          const url = new URL(string);
          if (url.username || url.password)
            throw new MirrorError('INVALID_SITE_URL', 'Site URLs cannot contain credentials.');
        }
      } else ensureSimple(string, key);
      values[key] = string;
    }
    const path = route.path.replace(/\{(\+?)([^}]+)\}/g, (_all, plus: string, key: string) =>
      plus ? String(values[key]).split('/').map(encodeURIComponent).join('/') : encodeURIComponent(values[key]),
    );
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\]/.test(path))
      throw new MirrorError('INVALID_PATH', 'Generated vendor path is invalid.');
    const query: JsonObject = {};
    for (const [key, schema] of Object.entries(route.parameters).filter(([, s]) => s.location === 'query')) {
      if (forbiddenQuery.has(key)) {
        if (singleValue(key, [args, params, queryInput]) !== undefined)
          throw new MirrorError(
            'CREDENTIAL_PARAMETER_FORBIDDEN',
            'Credentials must be supplied by the connection provider.',
            {parameter: key},
            403,
          );
        continue;
      }
      const value = singleValue(
        key,
        [args, params, queryInput, hooks?.queryBody && !bodyAllowed ? body : {}],
        aliases(key),
      );
      // A query parameter the provider's documentation requires although the snapshot does not mark it (Business
      // Profile's readMask): refused when missing, and its value checked.
      const documented = hooks?.requiredQuery?.(operation, action, key);
      if (value === undefined) {
        if (schema.required || documented)
          throw new MirrorError('MISSING_PARAMETER', 'Missing vendor query parameter: ' + key + '.', {parameter: key});
        continue;
      }
      documented?.(value);
      checkParameter(value, schema, key);
      if (hooks?.joinedArrays && Array.isArray(value) && schema.explode === false) {
        if (value.some(v => String(v).includes(',')))
          throw new MirrorError('INVALID_PARAMETER', 'Comma-separated values cannot themselves contain commas.', {
            parameter: key,
          });
        query[key] = value.join(',');
      } else query[key] = value;
    }
    const friendlyResourceKeys = new Set(Object.values(resourceFields).flat().map(normalize));
    for (const key of Object.keys({...params, ...queryInput}))
      if (
        !Object.keys(route.parameters).some(p =>
          [p, ...(extraAliases[p] ?? []), ...aliases(p)].some(alias => normalize(alias) === normalize(key)),
        ) &&
        !(
          Object.values(route.parameters).some(s => s.location === 'path' && s.pattern) &&
          friendlyResourceKeys.has(normalize(key))
        )
      )
        throw new MirrorError(
          'UNKNOWN_VENDOR_PARAMETER',
          'Unknown vendor parameter; body fields belong in payload/request.',
          {parameter: key, vendor_method: route.vendorMethod},
        );
    // An absent body of a route that requires one is empty, unless the provider supplies it otherwise (GA4's request
    // argument, Search Console's top-level inspection fields).
    if (route.bodyRequired && !hooks?.bodyArgument && args.payload === undefined && !hooks?.bodyFields?.(action))
      body = {};
    if (!bodyAllowed && Object.keys(body).length && !hooks?.queryBody)
      throw new MirrorError('UNEXPECTED_BODY', 'This vendor method does not accept a JSON body.', {
        vendor_method: route.vendorMethod,
      });
    // A provider whose request bodies are checked against their pinned schema (Reddit's, Criteo's documented ones).
    const bodySchema = hooks?.bodySchema;
    if (bodySchema?.applies(route) && route.requestSchema) {
      const key = this.key(gateway, operation, action);
      let validator = this.validators.get(key);
      if (!validator) {
        validator = this.ajv.compile({
          ...route.requestSchema,
          components: this.data.schemaComponents?.[route.sourceFile],
        });
        this.validators.set(key, validator);
      }
      if (!validator(body))
        throw new MirrorError('INVALID_VENDOR_BODY', bodySchema.refusal, {errors: validator.errors});
      bodySchema.report?.(action, body);
    }
    const accountId = scopeFrom(route, args, path, body, query);
    return {
      gateway,
      action: operation + (action ? '/' + action : ''),
      method: route.method,
      origin: route.origin,
      path,
      query,
      queryArrayEncoding: 'repeat',
      ...(bodyAllowed ? {body} : {}),
      headers: {},
      readOnly: route.readOnly,
      destructive: route.method === 'DELETE' || /(?:^|_)(?:DELETE|REMOVE|CLEAR)(?:_|$)/.test(action),
      requiresConfirmation: !route.readOnly,
      accountId,
      evidence: route.evidence,
      warnings: [
        'This request uses an independently designed mapping to ' +
          route.vendorMethod +
          '. AMCP compiler and response-envelope parity are not asserted.',
        'Credential account bindings and ownership of globally addressed resources must be checked before execution.',
      ],
    };
  }
}
