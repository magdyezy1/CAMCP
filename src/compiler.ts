import {MirrorError} from './errors.js';
import {metaReportPlan} from './meta-insights-jobs.js';
import {xReportPlan} from './x-report-jobs.js';
import {xAudienceEstimatePlan} from './x-audience-estimate.js';
import {snapchatPlanningPlan} from './snapchat-planning-reads.js';
import {linkedinPlanningPlan} from './linkedin-planning-reads.js';
import {linkedinConversionPlan} from './linkedin-conversion-links.js';
import {linkedinDomainPlan} from './linkedin-insight-domains.js';
import {linkedinTrackingPlan} from './linkedin-tracking-parameters.js';
import {linkedinMessagePlan} from './linkedin-message-ads.js';
import {tiktokPreviewPlan, tiktokPreviewVariantPath} from './tiktok-preview-reads.js';
import type {CallOptions, CompiledRequest, JsonObject} from './types.js';
import {Registry} from './catalog.js';
import {guardInput} from './security.js';
import {adaptGoogleLegacy} from './google-legacy.js';
import {
  accountAliases as aliases,
  parameterBag,
  nativeTopLevel,
  assertSameAlias,
  encodedBodyGateways,
} from './parameters.js';
import {responseControls} from './projection.js';
import {validateApplePlan} from './apple-native.js';
import {microsoftGateway, compileMicrosoft} from './microsoft-native.js';
import {googleContractEvidence} from './google-contracts.js';
import {googleAdsRequestChange} from './google-version.js';
import {googleGenerationPlan} from './google-generation.js';
import {dv360TargetingSearchPlan} from './dv360-targeting-search.js';
import {linkedinVersion} from './linkedin-version.js';
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
    if (gateway === microsoftGateway) return compileMicrosoft(input);
    if (gateway === 'google_ads_native_action' && !this.registry.action(gateway, String(input.action))?.path) {
      const adapted = adaptGoogleLegacy(this.registry, input);
      if (adapted) {
        const compiled = this.compile(gateway, adapted.input, options);
        return {
          ...compiled,
          action: adapted.legacyAction,
          evidence: adapted.evidence,
          warnings: [...compiled.warnings, ...adapted.warnings],
        };
      }
    }
    if (options.mode === 'enhanced' && options.flags.nativeRequests && input.native_request)
      return this.native(gateway, input);
    let action = this.registry.action(gateway, String(input.action ?? ''));
    if (gateway === 'dv360_native_action' && !input.action && input.resource && input.method)
      action = this.registry.data.supplemental.find(
        a => a.raw.resource === input.resource && a.raw.rpc === input.method,
      );
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
            gateway === 'meta_native_action' && key === 'fields' && Array.isArray(bag[key])
              ? bag[key].join(',')
              : bag[key],
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
          gateway === 'meta_native_action' && key === 'fields' && Array.isArray(object(body)[key])
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
      const canonicalId = (v: unknown) =>
        String(v)
          .replace(gateway === 'meta_native_action' ? /^act_/ : /$^/, '')
          .replace(gateway === 'google_ads_native_action' ? /-/g : /$^/g, '');
      for (const key of aliases[gateway] ?? [])
        for (const bag of [input, params, explicitPath, explicitQuery, object(body)])
          if (bag[key] !== undefined && canonicalId(bag[key]) !== canonicalId(accountId))
            throw new MirrorError(
              'ACCOUNT_SCOPE_MISMATCH',
              'Conflicting account identifiers are not allowed.',
              {field: key},
              403,
            );
      for (const key of aliases[gateway] ?? []) if (values[key] === undefined) values[key] = accountId;
      if (gateway === 'google_ads_native_action') values.customer_id = accountId.replaceAll('-', '');
      if (gateway === 'meta_native_action' && action.path.includes('act_{ad_account_id}'))
        values.ad_account_id = String(values.ad_account_id).replace(/^act_/, '');
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
    const required = new Set([...action.required, ...(action.raw.required_path_params ?? [])]);
    // tiktokPreviewPlan checks each TikTok preview_type's own required fields; the catalog lists every variant's together.
    if (
      gateway === 'google_ads_native_action' ||
      (options.mode === 'enhanced' && options.flags.catalogPreflight && !tiktokPreviewVariantPath(gateway, action.path))
    )
      for (const key of required) {
        if (typeof key !== 'string') continue;
        const v =
          values[key] ??
          (gateway === 'google_ads_native_action'
            ? values[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())]
            : undefined);
        // The AMCP Drive importer supplies the binary payload after review. Only its
        // exact upload routes may omit their ordinary native content container.
        if (
          gateway === 'google_ads_native_action' &&
          ['operations', 'you_tube_video_upload'].includes(key) &&
          /\/(?:assets:mutate|youTubeVideoUploads:create)$/.test(action.path) &&
          ['drive_url', 'url', 'image_url', 'video_url', 'file_url', 'source'].some(k => typeof values[k] === 'string')
        )
          continue;
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
          if (gateway === 'google_ads_native_action') {
            const change = googleAdsRequestChange(action.name);
            throw new MirrorError(
              'MISSING_PARAMETER',
              action.name +
                " requires request field '" +
                key +
                "'. Pass path values in path_params and all other native request fields in params or payload.",
              {parameter: key, ...(change ? {version_change: change} : {})},
            );
          }
          throw new MirrorError('MISSING_PARAMETER', 'Missing required parameter: ' + key, {parameter: key});
        }
      }
    const remaining = {...params};
    for (const key of consumed) delete remaining[key];
    const query: JsonObject = {...templateQuery};
    const headers: Record<string, string> = {};
    let method = action.method.toUpperCase();
    let readOnly = action.read_only === true;
    const queryOnly =
      ['GET', 'HEAD', 'DELETE'].includes(method) ||
      gateway === 'linkedin_native_action' ||
      gateway === 'dv360_native_action';
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
    if (gateway === 'meta_native_action') {
      if (Array.isArray(query.fields)) query.fields = query.fields.join(',');
      if (!Array.isArray(body) && Array.isArray(object(body).fields))
        body = {...object(body), fields: object(body).fields.join(',')};
    }
    if (gateway === 'tiktok_native_action' && accountId) {
      if (['GET', 'HEAD', 'DELETE'].includes(method)) query.advertiser_id ??= accountId;
      else if (!Array.isArray(body)) body = {advertiser_id: accountId, ...object(body)};
      if (input.lead_region) headers['X-Lead-Region'] = input.lead_region;
    }
    if (gateway === 'google_ads_native_action') {
      const desc = this.registry.data.descriptions[gateway + '/' + action.name];
      if (desc?.body_mapping && desc.body_mapping !== '*') body = object(body)[desc.body_mapping] ?? body;
    }
    if (gateway === 'linkedin_native_action') {
      headers['LinkedIn-Version'] = linkedinVersion(input.api_version);
      headers['X-Restli-Protocol-Version'] = '2.0.0';
      if (input.restli_method) {
        const restli = String(input.restli_method).toUpperCase();
        if (
          ![
            'GET',
            'BATCH_GET',
            'FINDER',
            'GET_ALL',
            'CREATE',
            'BATCH_CREATE',
            'UPDATE',
            'BATCH_UPDATE',
            'PARTIAL_UPDATE',
            'BATCH_PARTIAL_UPDATE',
            'DELETE',
            'BATCH_DELETE',
            'ACTION',
          ].includes(restli)
        )
          throw new MirrorError('INVALID_METHOD_OVERRIDE', 'Unsupported REST.li method.');
        headers['X-RestLi-Method'] = String(input.restli_method);
        readOnly = readOnly && ['GET', 'BATCH_GET', 'FINDER', 'GET_ALL'].includes(restli);
      }
      if (input.http_method_override) {
        const override = String(input.http_method_override).toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(override))
          throw new MirrorError('INVALID_METHOD_OVERRIDE', 'Unsupported HTTP method override.');
        headers['X-HTTP-Method-Override'] = override;
        method = 'POST';
        readOnly = readOnly && ['GET', 'HEAD'].includes(override);
      }
    }
    // Graph and other REST servers can tunnel methods in the query string.
    for (const key of ['method', '_method', 'http_method', 'method_override'])
      if (query[key] !== undefined) {
        const override = String(query[key]).toUpperCase();
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(override))
          throw new MirrorError('INVALID_METHOD_OVERRIDE', 'Unsupported query method override.');
        readOnly = readOnly && ['GET', 'HEAD'].includes(override);
      }
    if (gateway === 'meta_native_action' && query.batch !== undefined) readOnly = false;
    return tiktokPreviewPlan(
      linkedinDomainPlan(
        linkedinMessagePlan(
          linkedinPlanningPlan(
            snapchatPlanningPlan(
              xAudienceEstimatePlan(
                xReportPlan(
                  metaReportPlan(
                    dv360TargetingSearchPlan(
                      linkedinTrackingPlan(
                        linkedinConversionPlan(
                          googleGenerationPlan(
                            googleContractEvidence(
                              validateApplePlan({
                                gateway,
                                action: action.canonical_name || action.name,
                                method,
                                path,
                                query,
                                ...(absolute ? {origin: absolute.origin} : {}),
                                ...(body === undefined ? {} : {body}),
                                headers,
                                readOnly,
                                destructive:
                                  action.destructive === true || headers['X-HTTP-Method-Override'] === 'DELETE',
                                requiresConfirmation: !readOnly,
                                accountId,
                                evidence: action.evidence,
                                warnings: [
                                  'Request routing compiled locally; live behavioral parity is tracked separately.',
                                ],
                                specialTransport: action.raw.special_transport ?? undefined,
                                ...(projection ? {responseControls: projection} : {}),
                              }),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  input,
                ),
              ),
            ),
          ),
        ),
      ),
    );
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
    if (gateway === 'meta_native_action' && query.batch !== undefined) readOnly = false;
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
