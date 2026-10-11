import {Ajv} from 'ajv';
import addFormatsModule from 'ajv-formats';
import {MirrorError} from './errors.js';
import {guardInput, stable as stableStringify} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {redditAudienceRoutes, redditReadRoutes} from './reddit-extensions.js';
import {assertRedditReportRules} from './reddit-report-rules.js';
import {pinnedJson} from './pinned-json.js';
import {nativeParameterKey} from './parameter-key.js';

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
const redditAliases: Record<string, string[]> = {
  ad_account_id: ['account_id'],
  ad_group_id: ['adgroup_id', 'adset_id'],
  'page.size': ['page_size', 'pageSize', 'limit'],
  'page.token': ['page_token', 'pageToken', 'after', 'cursor'],
  query: ['q'],
};
const forbiddenQuery = new Set(['access_token', 'oauth_token', 'key']);
/** Whether a delegated argument name addresses this native parameter: its own name or one of its aliases. */
export function delegatedParameterMatches(gateway: string, argument: string, native: string): boolean {
  const names = [
    native,
    ...(extraAliases[native] ?? []),
    ...(gateway === 'reddit_native_action' ? (redditAliases[native] ?? []) : []),
  ];
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
  if (route.gateway === 'ga4_native_action') {
    const property = args.property === undefined ? undefined : resourceId(args.property, 'properties');
    const match = path.match(/\/properties\/([^/:]+)/);
    if (match && property && decodeURIComponent(match[1]!) !== property)
      throw new MirrorError(
        'ACCOUNT_SCOPE_MISMATCH',
        'The request resource belongs to a different Analytics property.',
        {},
        403,
      );
    const visit = (v: unknown) => {
      if (Array.isArray(v)) {
        for (const n of v) visit(n);
        return;
      }
      if (v && typeof v === 'object')
        for (const [k, n] of Object.entries(v)) {
          if (k === 'property' && property && !sameResource(n, property, 'properties'))
            throw new MirrorError(
              'ACCOUNT_SCOPE_MISMATCH',
              'Nested report property differs from the authorized property.',
              {},
              403,
            );
          visit(n);
        }
    };
    visit(body);
    return property ?? (match ? decodeURIComponent(match[1]!) : undefined);
  }
  if (route.gateway === 'google_search_console_native_action')
    return singleValue('siteUrl', [args, record(args.params), record(args.path_params), body]) as string | undefined;
  const account = singleValue(
    'account_id',
    [args, record(args.params), record(args.path_params)],
    route.gateway === 'reddit_native_action' ? ['ad_account_id'] : [],
  ) as string | undefined;
  const match = path.match(
    route.gateway === 'reddit_native_action' ? /\/ad_accounts\/([^/:]+)/ : /\/accounts\/([^/:]+)/,
  );
  const id = resourceId(account, 'accounts');
  if (match && id && decodeURIComponent(match[1]!) !== id)
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'The request resource belongs to a different account.', {}, 403);
  if (route.gateway === 'google_business_native_action') {
    const location = resourceId(args.location_id, 'locations'),
      found = path.match(/\/locations\/([^/:]+)/);
    if (location && found && decodeURIComponent(found[1]!) !== location)
      throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'The request resource belongs to a different location.', {}, 403);
    if (route.operation === 'gmb_engagement_ops' && route.action === 'LIST_PLACE_ACTION_TYPE_METADATA') {
      if (
        args.location_id !== undefined &&
        (typeof args.location_id !== 'string' || !/^(?:locations\/)?[1-9][0-9]*$/.test(args.location_id))
      )
        throw new MirrorError('INVALID_RESOURCE_NAME', 'Use the exact numeric location ID or locations/{id}.');
      if (account !== undefined && (typeof account !== 'string' || !/^(?:accounts\/)?[1-9][0-9]*$/.test(account)))
        throw new MirrorError('INVALID_RESOURCE_NAME', 'Use the exact numeric account ID or accounts/{id}.');
      const filter =
        typeof query.filter === 'string' ? /^location=(locations\/[1-9][0-9]*)$/.exec(query.filter)?.[1] : undefined;
      if (filter && (id || (location && filter !== 'locations/' + location)))
        throw new MirrorError(
          'ACCOUNT_SCOPE_MISMATCH',
          'Use the exact selected location for location-filtered metadata; do not substitute a broader account.',
          {},
          403,
        );
      if (location && id)
        throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Choose an account or a location context, not both.', {}, 403);
      if (location && query.filter === undefined) query.filter = 'location=locations/' + location;
      return location ? 'locations/' + location : (filter ?? id);
    }
    return (
      id ??
      (match ? decodeURIComponent(match[1]!) : undefined) ??
      (found ? 'locations/' + decodeURIComponent(found[1]!) : undefined)
    );
  }
  return id ?? (match ? decodeURIComponent(match[1]!) : undefined);
}

/** Compiles one vendor request only. OAuth, persistence, authentication, ownership checks and execution belong to the service. */
export class DelegatedNativeCompiler {
  readonly data: VendorRoutes;
  private routes = new Map<string, VendorRoute>();
  private validators = new Map<string, ReturnType<Ajv['compile']>>();
  private ajv = new Ajv({
    strict: false,
    allErrors: true,
    useDefaults: false,
    coerceTypes: false,
    removeAdditional: false,
  });
  constructor(data?: VendorRoutes) {
    (addFormatsModule as unknown as (ajv: Ajv) => void)(this.ajv);
    this.ajv.addFormat('long-id', {
      type: 'string',
      validate: (value: string) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
    });
    const source = data ?? pinnedJson<VendorRoutes>('generated/vendor-routes.json');
    // Direct Google Ads compilation and ProtoJSON validation have their own entry
    // point. A vendor snapshot must not accidentally create a second delegated API.
    this.data = {...source, routes: source.routes.filter((r: VendorRoute) => r.gateway !== 'google_ads_native_action')};
    if (this.data.formatVersion !== 1) throw new Error('Unsupported vendor routes format.');
    for (const r of this.data.routes) {
      const key = this.key(r.gateway, r.operation, r.action);
      if (this.routes.has(key)) throw new Error('Duplicate delegated route: ' + key);
      this.routes.set(key, r);
    }
    if (this.data.schemaComponents?.['reddit-v3'])
      for (const r of [...redditAudienceRoutes, ...redditReadRoutes()])
        this.routes.set(this.key(r.gateway, r.operation, r.action), r);
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
  validateResponse(plan: CompiledRequest, data: unknown, status: number): void {
    const route = this.routes.get(plan.gateway + '/' + plan.action);
    if (!route?.responseSchemas) return;
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
    if (!validator(data))
      throw new MirrorError(
        'UPSTREAM_RESPONSE_INVALID',
        'Vendor response does not satisfy its published JSON schema.',
        {errors: validator.errors, vendor_method: route.vendorMethod},
        502,
      );
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
    const params = record(args.params),
      explicit = record(args.path_params),
      queryInput = record(args.query);
    const aliases = (key: string) => (gateway === 'reddit_native_action' ? (redditAliases[key] ?? []) : []);
    const bodyAllowed = route.requestSchema !== undefined || route.bodyRequired;
    const suppliedBody = gateway === 'ga4_native_action' ? args.request : args.payload;
    if (
      suppliedBody !== undefined &&
      (!suppliedBody || typeof suppliedBody !== 'object' || Array.isArray(suppliedBody))
    )
      throw new MirrorError('INVALID_JSON_BODY', 'This operation requires an object request body.');
    let body = structuredClone(record(suppliedBody));
    if (gateway === 'google_search_console_native_action' && action === 'INSPECT_URL')
      for (const field of ['siteUrl', 'inspectionUrl', 'languageCode']) {
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
          next_step:
            gateway === 'ga4_native_action'
              ? 'Supply the property and full audience_export_name or report_task_name when required.'
              : 'Supply friendly resource IDs or the exact path parameter.',
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
        [args, params, queryInput, gateway === 'ga4_native_action' && !bodyAllowed ? body : {}],
        aliases(key),
      );
      // These discovery query descriptions and current provider docs require an explicit field selection.
      // Discovery omits the required flag; do not default to all fields or change other routes.
      const requiredBusinessReadMask =
        gateway === 'google_business_native_action' &&
        key === 'readMask' &&
        ((operation === 'gmb_location_ops' && action === 'GET_LOCATION') ||
          (operation === 'gmb_lodging_ops' && action === 'GET_LODGING'));
      if (value === undefined) {
        if (schema.required || requiredBusinessReadMask)
          throw new MirrorError('MISSING_PARAMETER', 'Missing vendor query parameter: ' + key + '.', {parameter: key});
        continue;
      }
      if (requiredBusinessReadMask && typeof value === 'string' && !value.trim())
        throw new MirrorError('INVALID_PARAMETER', 'Choose an explicit nonempty readMask for this resource.', {
          parameter: key,
        });
      checkParameter(value, schema, key);
      if (gateway === 'reddit_native_action' && Array.isArray(value) && schema.explode === false) {
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
    if (route.bodyRequired && gateway !== 'ga4_native_action' && args.payload === undefined && action !== 'INSPECT_URL')
      body = {};
    if (!bodyAllowed && Object.keys(body).length && gateway !== 'ga4_native_action')
      throw new MirrorError('UNEXPECTED_BODY', 'This vendor method does not accept a JSON body.', {
        vendor_method: route.vendorMethod,
      });
    if (
      (gateway === 'reddit_native_action' || (gateway === 'criteo_native_action' && route.responseSchemas)) &&
      route.requestSchema
    ) {
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
        throw new MirrorError(
          'INVALID_VENDOR_BODY',
          gateway === 'reddit_native_action'
            ? 'Request body does not satisfy the published Reddit API schema.'
            : 'Request body does not satisfy the pinned Criteo campaign schema.',
          {errors: validator.errors},
        );
      if (action === 'GET_INSIGHTS') {
        const data = body.data;
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(data.starts_at) ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(data.ends_at) ||
          Date.parse(data.starts_at) >= Date.parse(data.ends_at)
        )
          throw new MirrorError(
            'INVALID_REPORT_WINDOW',
            'Reddit reports require increasing UTC timestamps aligned to complete hours.',
          );
        if (data.fields.length === 0)
          throw new MirrorError('INVALID_VENDOR_BODY', 'A Reddit report requires at least one field.');
        // Breakdown rules Reddit enforces from 2026-12-08 (PRV-04): refused here instead of by a provider 400.
        if (gateway === 'reddit_native_action') assertRedditReportRules(data);
      }
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
