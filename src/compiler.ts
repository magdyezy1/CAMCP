import {MirrorError} from './errors.js';
import {reportJobPlan} from './report-jobs.js';
import type {CallOptions, CompiledRequest, JsonObject} from './types.js';
import type {Registry} from './catalog.js';
import {guardInput} from './security.js';
import {
  accountAliases as aliases,
  parameterBag,
  nativeTopLevel,
  assertSameAlias,
  encodedBodyGateways,
} from './parameters.js';
import {responseControls} from './projection.js';
import {normalizeAccount} from './account-id.js';
import {providerHooks} from './provider-hooks.js';
import type {CompileDraft} from './provider-adapter.js';
const object = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? {...v} : {});
export function expandPath(template: string, values: JsonObject): {path: string; consumed: string[]} {
  const consumed: string[] = [];
  const path = template.replace(
    /\{(\+?)([^{}=]+)(?:=([^{}]+))?\}/g,
    (_full, plus: string, key: string, pattern: string | undefined) => {
      const value = values[key];
      if (value === undefined || value === null || value === '')
        throw new MirrorError('MISSING_PARAMETER', 'Missing path parameter: ' + key, {parameter: key});
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new MirrorError('INVALID_PARAMETER', 'Path parameter must be a string or number.', {parameter: key});
      const text = String(value);
      if (typeof value === 'number' && !Number.isSafeInteger(value))
        throw new MirrorError('UNSAFE_NUMERIC_ID', 'Use string identifiers.');
      if (/[\r\n\\?#]/.test(text) || /%(?:2f|2e|5c)/i.test(text) || text.split('/').some(x => x === '.' || x === '..'))
        throw new MirrorError('INVALID_PATH_PARAMETER', 'Unsafe path parameter.', {parameter: key});
      consumed.push(key);
      if (pattern && pattern !== '*') {
        const pieces = pattern.split('/');
        const actual = text.split('/');
        if (
          !pieces.includes('**') &&
          (pieces.length !== actual.length || pieces.some((p, i) => p !== '*' && p !== actual[i]))
        )
          throw new MirrorError('INVALID_RESOURCE_NAME', 'Resource name does not match its template.', {
            parameter: key,
            pattern,
          });
        return actual.map(encodeURIComponent).join('/');
      }
      return plus ? text.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(text);
    },
  );
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\r\n\\?#]/.test(path) ||
    path.split('/').some(x => x === '..' || x === '.') ||
    /%(?:2e|5c)/i.test(path)
  )
    throw new MirrorError(
      'INVALID_PATH',
      'Compiled path is unsafe. Supply query parameters in query, without a fragment.',
    );
  return {path, consumed};
}
export class Compiler {
  constructor(private registry: Registry) {}
  compile(gateway: string, input: JsonObject, options: CallOptions): CompiledRequest {
    guardInput(input);
    // A near-miss name (T7, src/action-aliases.ts) compiles as its canonical action, before anything reads the name: the
    // provider's hooks, the route and every later rule see the one action the call stands for, never a second route to it.
    if (typeof input.action === 'string') {
      const named = this.registry.resolveAction(gateway, input.action);
      if (named.alias) input = {...input, action: named.alias.canonical};
    }
    // The provider's part of the compiler (ARC-01 phase B, src/<provider>-adapter.ts): what only it says about its
    // requests, consulted at the step where the compiler named the provider before. The compiler keeps every rule and
    // the order of every step.
    const hooks = providerHooks(gateway)?.compile;
    if (hooks?.own) return hooks.own(input);
    if (hooks?.legacy && !this.registry.action(gateway, String(input.action))?.path) {
      const adapted = hooks.legacy(this.registry, input);
      if (adapted) {
        const compiled = this.compile(gateway, adapted.input, options);
        return {
          ...compiled,
          action: adapted.legacyAction,
          evidence: adapted.evidence,
          warnings: [...compiled.warnings, ...adapted.warnings],
          ...(adapted.defaultLimit ? {legacyDefaultLimit: adapted.defaultLimit} : {}),
        };
      }
    }
    if (options.mode === 'enhanced' && options.flags.nativeRequests && input.native_request)
      return this.native(gateway, input);
    let action = this.registry.action(gateway, String(input.action ?? ''));
    if (hooks?.resourceAction && !input.action && input.resource && input.method)
      action = hooks.resourceAction(this.registry, input);
    if (action && !action.path)
      action = this.registry.data.supplemental.find(a => a.gateway === gateway && a.name === action!.name) ?? action;
    if (!action)
      throw new MirrorError('UNKNOWN_ACTION', 'Action is absent from the captured catalog.', {
        gateway,
        action: input.action,
        // Close names from this gateway and where to list the rest (MCP-05).
        ...(typeof input.action === 'string'
          ? this.registry.unknownAction(gateway, input.action, 'action').details
          : {field: 'action'}),
      });
    if (!action.method || !action.path)
      throw new MirrorError('CONTRACT_UNAVAILABLE', 'Upstream routing metadata is not available for this action.', {
        gateway,
        action: action.name,
      });
    assertSameAlias(input.path_params, input.pathParams, 'path_params/pathParams');
    assertSameAlias(input.payload, input.body, 'payload/body');
    const params = parameterBag(input.params, 'params'),
      explicitPath = parameterBag(
        input.path_params !== undefined ? input.path_params : input.pathParams,
        'path_params',
      ),
      explicitQuery = parameterBag(input.query, 'query');
    const top = nativeTopLevel(gateway, action, input),
      projection = responseControls(gateway, action, input);
    for (const [key, value] of Object.entries(top)) {
      for (const bag of [params, explicitPath, explicitQuery, object(input.payload ?? input.body)])
        if (bag[key] !== undefined && !aliases[gateway]?.includes(key))
          assertSameAlias(
            value,
            hooks?.joinedFields && key === 'fields' && Array.isArray(bag[key]) ? bag[key].join(',') : bag[key],
            key,
          );
      params[key] ??= value;
    }
    const bodies = [input.payload, input.body, params.payload, params.body].filter(v => v !== undefined);
    for (const v of bodies.slice(1)) assertSameAlias(bodies[0], v, 'payload/body');
    let body = bodies[0];
    delete params.payload;
    delete params.body;
    if (encodedBodyGateways.includes(gateway) && typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        throw new MirrorError('INVALID_JSON_BODY', 'body/payload must contain valid JSON.');
      }
      if (!body || typeof body !== 'object')
        throw new MirrorError('INVALID_JSON_BODY', 'body/payload must decode to an object or array.');
      guardInput(body);
    }
    if (body !== undefined && (!body || typeof body !== 'object'))
      throw new MirrorError('INVALID_JSON_BODY', 'body/payload must be an object or array.');
    for (const [key, value] of Object.entries(top))
      if (object(body)[key] !== undefined && !aliases[gateway]?.includes(key))
        assertSameAlias(
          value,
          hooks?.joinedFields && key === 'fields' && Array.isArray(object(body)[key])
            ? object(body)[key].join(',')
            : object(body)[key],
          key,
        );
    const values = {...params, ...object(body), ...explicitQuery, ...explicitPath};
    const account = aliases[gateway]
      ?.map(k => input[k] ?? values[k])
      .find(v => v !== undefined && v !== null && v !== '');
    const accountId = account === undefined ? undefined : String(account);
    if (accountId) {
      // The account IDs compare in the form the provider's account model binds (Meta without act_, Google Ads
      // without dashes).
      const canonicalId = (v: unknown) => normalizeAccount(gateway, v);
      // What a conflict shows of an ID (R2.5 M3 round 2, S4-5): only a string or number that is ID-shaped (letters, digits and the
      // separators IDs use, no space or markup: text an agent typed where an ID belongs is not echoed into an error message), cut to
      // 64 characters.
      const shownId = (v: unknown): string | undefined => {
        if (typeof v !== 'string' && typeof v !== 'number') return undefined;
        const id = canonicalId(v);
        return /^[\w.:/@%+=-]+$/.test(id) ? id.slice(0, 64) : undefined;
      };
      for (const key of aliases[gateway] ?? [])
        for (const bag of [input, params, explicitPath, explicitQuery, object(body)])
          if (bag[key] !== undefined && canonicalId(bag[key]) !== canonicalId(accountId))
            throw new MirrorError(
              'ACCOUNT_SCOPE_MISMATCH',
              'Conflicting account identifiers are not allowed.',
              // account_conflict: the request is at fault, not a grant (R25 M0, owner 2026-11-15; src/errors.ts reviewRemedy).
              // `provided` and `expected` name the two IDs in the form the provider binds, so that the agent sees which one to
              // keep (R2.5 M3, L2-01): `expected` is the call's own account_id. A value that is no ID (a list, an object, free
              // text) is not echoed, and a long one is cut (`shownId`, round 2, S4-5).
              {
                field: key,
                account_conflict: true,
                ...(shownId(bag[key]) !== undefined ? {provided: shownId(bag[key])} : {}),
                ...(shownId(accountId) !== undefined ? {expected: shownId(accountId)} : {}),
              },
              403,
            );
      for (const key of aliases[gateway] ?? []) if (values[key] === undefined) values[key] = accountId;
      hooks?.accountValues?.(values, accountId, action.path);
    }
    const absolute = action.path.startsWith('https://') ? new URL(action.path) : undefined;
    // URL serializes template braces; restore those delimiters before expansion.
    const [pathTemplate, queryTemplate] = (
      absolute ? (absolute.pathname + absolute.search).replace(/%7B/gi, '{').replace(/%7D/gi, '}') : action.path
    ).split('?');
    const {path, consumed} = expandPath(pathTemplate!, values);
    const templateQuery: JsonObject = {};
    for (const [key, template] of new URLSearchParams(queryTemplate)) {
      templateQuery[key] = template.replace(/\{([^}]+)\}/g, (_all, key: string) => {
        if (values[key] === undefined)
          throw new MirrorError('MISSING_PARAMETER', 'Missing query template parameter: ' + key);
        consumed.push(key);
        return String(values[key]);
      });
    }
    const required = new Set([...action.required, ...(action.raw.required_path_params ?? [])]),
      fields = hooks?.required;
    // A provider may check its required fields in every mode (Google Ads), or leave a route's to its own plan step
    // (TikTok's preview types: the catalog lists every variant's together).
    if (
      fields?.always ||
      (options.mode === 'enhanced' && options.flags.catalogPreflight && !fields?.unchecked?.(action.path))
    )
      for (const key of required) {
        if (typeof key !== 'string') continue;
        const v = values[key] ?? fields?.alias?.(values, key);
        // A field another step supplies after review (Google Ads' Drive-imported upload content).
        if (fields?.supplied?.(key, action.path, values)) continue;
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))
          throw (
            fields?.missing?.(action, key) ??
            new MirrorError('MISSING_PARAMETER', 'Missing required parameter: ' + key, {parameter: key})
          );
      }
    const remaining = {...params};
    for (const key of consumed) delete remaining[key];
    const query: JsonObject = {...templateQuery};
    const headers: Record<string, string> = {};
    let method = action.method.toUpperCase();
    let readOnly = action.read_only === true;
    // A provider may send its parameters in the query whatever the method (LinkedIn's Rest.li, DV360).
    const queryOnly = ['GET', 'HEAD', 'DELETE'].includes(method) || hooks?.queryParameters === true;
    if (!queryOnly && Array.isArray(body) && Object.keys(remaining).length)
      throw new MirrorError(
        'UNSUPPORTED_PARAMETER',
        'Array payloads cannot be merged with body parameters. Use query for explicit URL parameters.',
        {parameter: 'params'},
      );
    if (queryOnly) Object.assign(query, remaining, explicitQuery);
    else {
      body = Array.isArray(body) ? body : {...remaining, ...object(body)};
      Object.assign(query, explicitQuery);
    }
    if (['GET', 'HEAD'].includes(method) && body !== undefined) {
      const supplied = object(body);
      for (const key of consumed) delete supplied[key];
      if (Array.isArray(body) || Object.keys(supplied).length)
        throw new MirrorError(
          'UNSUPPORTED_PARAMETER',
          'GET/HEAD requests cannot carry a payload. Put native request fields in params or query.',
          {parameter: 'payload'},
        );
      body = undefined;
    }
    if (hooks?.joinedFields) {
      if (Array.isArray(query.fields)) query.fields = query.fields.join(',');
      if (!Array.isArray(body) && Array.isArray(object(body).fields))
        body = {...object(body), fields: object(body).fields.join(',')};
    }
    // The provider's request rules (TikTok's advertiser and lead region, Google Ads' body mapping, LinkedIn's version,
    // Rest.li method and method override); what rides beside the request comes back (TikTok's comment scope).
    const draft: CompileDraft = {
      gateway,
      action,
      route: action.path,
      method,
      query,
      body,
      headers,
      readOnly,
      accountId,
    };
    const beside = hooks?.request?.(draft, input, this.registry);
    ({method, body, readOnly} = draft);
    // Graph and other REST servers can tunnel methods in the query string.
    for (const key of ['method', '_method', 'http_method', 'method_override'])
      if (query[key] !== undefined) {
        const override = String(query[key]).toUpperCase();
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(override))
          throw new MirrorError('INVALID_METHOD_OVERRIDE', 'Unsupported query method override.');
        readOnly = readOnly && ['GET', 'HEAD'].includes(override);
      }
    // A request that carries other requests is never a read (Meta's Graph batch).
    if (hooks?.batchParameter !== undefined && query[hooks.batchParameter] !== undefined) readOnly = false;
    const compiled: CompiledRequest = {
      gateway,
      action: action.canonical_name || action.name,
      method,
      path,
      query,
      ...(absolute ? {origin: absolute.origin} : {}),
      ...(body === undefined ? {} : {body}),
      headers,
      readOnly,
      destructive: action.destructive === true || headers['X-HTTP-Method-Override'] === 'DELETE',
      requiresConfirmation: !readOnly,
      accountId,
      evidence: action.evidence,
      warnings: ['Request routing compiled locally; live behavioral parity is tracked separately.'],
      specialTransport: action.raw.special_transport ?? undefined,
      ...(projection ? {responseControls: projection} : {}),
      ...beside,
    };
    // The provider's plan steps around the request controls of its gateway's report job (ARC-04 stage F,
    // src/report-jobs.ts), in the order the compiler applied them.
    const controlled = reportJobPlan(hooks?.beforeJob ? hooks.beforeJob(compiled) : compiled, input);
    return hooks?.afterJob ? hooks.afterJob(controlled) : controlled;
  }
  private native(gateway: string, input: JsonObject): CompiledRequest {
    const n = input.native_request;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(n.method) || typeof n.path !== 'string')
      throw new MirrorError('INVALID_NATIVE_REQUEST', 'Provide a supported HTTP method and a relative path.');
    const {path} = expandPath(n.path, {});
    const account = (aliases[gateway] ?? []).map(k => input[k]).find(v => v !== undefined);
    const query = object(n.query);
    let readOnly = n.method === 'GET';
    for (const key of ['method', '_method', 'http_method', 'method_override'])
      if (query[key] !== undefined) {
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(query[key]).toUpperCase()))
          throw new MirrorError('INVALID_METHOD_OVERRIDE', 'Unsupported query method override.');
        readOnly = readOnly && ['GET', 'HEAD'].includes(String(query[key]).toUpperCase());
      }
    const batch = providerHooks(gateway)?.compile?.batchParameter;
    if (batch !== undefined && query[batch] !== undefined) readOnly = false;
    return {
      gateway,
      action: String(input.action ?? 'NATIVE_REQUEST'),
      method: n.method,
      path,
      query,
      body: n.body,
      headers: {},
      readOnly,
      destructive: n.method === 'DELETE',
      requiresConfirmation: !readOnly,
      accountId: account === undefined ? undefined : String(account),
      evidence: 'INDEPENDENT_DESIGN',
      warnings: ['Native request extension is not a AMCP parity claim.'],
    };
  }
}
