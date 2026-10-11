import {Ajv} from 'ajv';
import addFormatsModule from 'ajv-formats';
import type {Action, CallOptions, Catalog, RegistryData, ToolDefinition, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {guardInput} from './security.js';
import {appleActions} from './apple-native.js';
import {microsoftActions, microsoftGateway, microsoftTool} from './microsoft-native.js';
import {extendRedditTool} from './reddit-extensions.js';
import {extendDV360Tool} from './dv360-extensions.js';
import {extendGoogleBusinessTool} from './google-business-extensions.js';
import {extendMetaPostWorkflow} from './meta-post-extensions.js';
import {extendAdjustTool} from './adjust-extensions.js';
import {metaActionOverride} from './meta-contracts.js';
import {catalogVersions, currentCapture} from './catalog-versions.js';
import {extendXReportTool} from './x-report-jobs.js';
import {pinnedJson} from './pinned-json.js';
import {metaRuleActions} from './meta-rule-routes.js';
import {dataManagerActions} from './google-data-manager-routes.js';
import {describedTool, describesOwnText} from './tool-notes.js';
import {nameCandidates, searchTerm} from './name-candidates.js';
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => void;
/** Gateways whose captured schema lacks LIST_ACTIONS but which AMCP lists from its catalog (MCP-05). */
export const listsActions = new Set(['dv360_native_action']);
/**
 * Ajv errors, compacted (MCP-05): the failing path and keyword, and for an enum the first 20 allowed values and their
 * count, so a misspelt DV360 action no longer echoes all 346 values. `field` names the first failing argument.
 */
export function compactSchemaErrors(errors: unknown): JsonObject {
  if (!Array.isArray(errors) || !errors.length) return {};
  const compact = errors.slice(0, 10).map((e: JsonObject) => {
    const allowed = e.params?.allowedValues;
    return {
      instancePath: e.instancePath || '/',
      keyword: e.keyword,
      ...(typeof e.message === 'string' ? {message: e.message.slice(0, 200)} : {}),
      ...(Array.isArray(allowed) ? {allowed: allowed.slice(0, 20), allowed_count: allowed.length} : {}),
      ...(e.params?.additionalProperty ? {property: String(e.params.additionalProperty).slice(0, 200)} : {}),
      ...(e.params?.missingProperty ? {property: String(e.params.missingProperty).slice(0, 200)} : {}),
    };
  });
  const first = compact.find(e => e.instancePath !== '/') ?? compact[0]!,
    path = first.instancePath === '/' ? '' : first.instancePath.slice(1).split('/').join('.'),
    field = [path, first.property].filter(Boolean).join('.');
  return {...(field ? {field} : {}), errors: compact, ...(errors.length > 10 ? {error_count: errors.length} : {})};
}
export class Registry {
  readonly data: RegistryData;
  readonly tools = new Map<string, ToolDefinition>();
  readonly catalogs = new Map<string, Catalog>();
  // Validators compile on first use: constructing a registry stays cheap, and a process pays only for the tools it calls.
  private schemas = new Map<string, JsonObject>();
  private validators = new Map<string, ReturnType<Ajv['compile']>>();
  private routes = new Map<string, Action>();
  private ajv = new Ajv({
    strict: false,
    allErrors: true,
    useDefaults: false,
    coerceTypes: false,
    removeAdditional: false,
    validateFormats: true,
  });
  constructor(data?: RegistryData) {
    this.data = data ?? pinnedJson<RegistryData>('generated/registry.json');
    addFormats(this.ajv);
    for (const original of this.data.tools) {
      const tool =
        original.name === 'x_ads_native_action'
          ? extendXReportTool(original)
          : original.name === 'reddit_native_action'
            ? extendRedditTool(original)
            : original.name === 'dv360_native_action'
              ? extendDV360Tool(original)
              : original.name === 'google_business_native_action'
                ? extendGoogleBusinessTool(original)
                : original.name === 'amcp_native_action'
                  ? extendMetaPostWorkflow(original)
                  : original.name === 'adjust_native_action'
                    ? extendAdjustTool(original)
                    : (catalogVersions[original.name]?.tool?.(original) ?? original);
      this.tools.set(tool.name, tool);
      this.schemas.set(tool.name, tool.inputSchema);
      for (const op of tool.operations ?? []) this.schemas.set(tool.name + '/' + op.operation, op.argumentsSchema);
    }
    for (const original of this.data.catalogs) {
      const actions =
          original.gateway === 'meta_native_action' ? original.actions.map(metaActionOverride) : original.actions,
        moved = catalogVersions[original.gateway],
        catalog = moved
          ? {...original, api_version: moved.version, actions: actions.map(moved.action)}
          : {...original, actions};
      this.catalogs.set(catalog.gateway, catalog);
      for (const action of catalog.actions) this.register(catalog.gateway, action);
    }
    for (const action of this.data.supplemental) this.register(action.gateway!, action, false);
    // Meta documents rule update and delete; the captured catalog maps only creation (src/meta-ad-rules.ts).
    if (this.catalogs.has('meta_native_action'))
      for (const action of metaRuleActions) this.register('meta_native_action', action, false);
    if (this.catalogs.has('google_ads_native_action'))
      for (const action of dataManagerActions) this.register('google_ads_native_action', action, false);
    if (this.tools.has('apple_ads_native_action'))
      for (const action of appleActions) this.register('apple_ads_native_action', action, false);
    if (this.tools.has('amcp_tool_help')) {
      this.tools.set(microsoftGateway, microsoftTool);
      this.schemas.set(microsoftGateway, microsoftTool.inputSchema);
      this.catalogs.set(microsoftGateway, {
        gateway: microsoftGateway,
        mode: 'direct',
        api_version: 'v13',
        reported_total: null,
        captured: 0,
        complete: false,
        denominator_kind: 'LIST_ACTIONS',
        actions: microsoftActions,
        gaps: ['Independent extension; not part of the captured AMCP denominator.'],
      });
      for (const a of microsoftActions) this.register(microsoftGateway, a);
    }
  }
  private validator(key: string) {
    let compiled = this.validators.get(key);
    const schema = this.schemas.get(key);
    if (!compiled && schema) this.validators.set(key, (compiled = this.ajv.compile(schema)));
    return compiled;
  }
  /** Compiles every validator now, so a schema Ajv cannot compile fails a test rather than a tool's first call. */
  compileAll() {
    for (const key of this.schemas.keys()) this.validator(key);
    return this.validators.size;
  }
  /** An unknown action name: where to find the right one, from the same gateway (MCP-05). */
  private actionListCall(tool: string, errors: unknown, action: unknown): JsonObject {
    const miss =
      Array.isArray(errors) &&
      errors.some(e => e?.instancePath === '/action' && e.keyword === 'enum') &&
      typeof action === 'string';
    if (!miss) return {};
    const refusal = this.unknownAction(tool, action as string, 'action');
    return {did_you_mean: refusal.details.did_you_mean, list_call: refusal.details.list_call};
  }
  private register(gateway: string, action: Action, strict = true) {
    const names = new Set([action.name, action.canonical_name, ...action.aliases]);
    for (const name of names) {
      const key = gateway + '/' + name;
      if (!strict && this.routes.has(key)) continue;
      this.routes.set(key, action);
    }
  }
  action(gateway: string, name: string): Action | undefined {
    return this.routes.get(gateway + '/' + name) ?? this.routes.get(gateway + '/' + name.toLowerCase());
  }
  validate(tool: string, input: JsonObject, options: CallOptions) {
    guardInput(input);
    const definition = this.tools.get(tool);
    if (!definition) throw new MirrorError('UNKNOWN_TOOL', 'Unknown MCP tool: ' + tool);
    const checkInput = structuredClone(input);
    if (tool === 'amcp_tool_help' && input.gateway === microsoftGateway) {
      if (
        Object.keys(input).some(k => !['gateway', 'operation'].includes(k)) ||
        (input.operation !== undefined && typeof input.operation !== 'string')
      )
        throw new MirrorError('INVALID_ARGUMENT', 'Invalid Microsoft help arguments.');
      return;
    }
    if (options.mode === 'enhanced')
      for (const key of ['native_request', ...(options.flags.uniformIdempotency ? ['idempotency_key'] : [])])
        delete checkInput[key];
    const validator = this.validator(tool)!;
    if (!validator(checkInput))
      throw new MirrorError('INVALID_ARGUMENT', 'Arguments do not satisfy the captured gateway schema.', {
        ...compactSchemaErrors(validator.errors),
        ...this.actionListCall(tool, validator.errors, input.action),
      });
    if (definition.mode === 'delegated') {
      const nested = this.validator(tool + '/' + input.operation);
      if (!nested || !nested(input.arguments ?? {}))
        throw new MirrorError('INVALID_ARGUMENT', 'Arguments do not satisfy the captured operation schema.', {
          ...compactSchemaErrors(nested?.errors),
          ...(nested ? {} : {field: 'operation', list_call: {tool: 'amcp_tool_help', arguments: {gateway: tool}}}),
        });
    }
  }
  /**
   * The refusal of an action or operation this gateway's catalog does not list (MCP-05): it names the value, offers up
   * to five close names from the same gateway and the call that lists the rest: LIST_ACTIONS where the gateway has a
   * verified one, otherwise the local contracts ledger.
   */
  unknownAction(gateway: string, value: string, field: string): MirrorError {
    const catalog = this.catalogs.get(gateway),
      names = [
        ...new Set([
          ...(catalog?.actions ?? []).map(a => a.name),
          ...[...this.routes].filter(([key]) => key.startsWith(gateway + '/')).map(([, action]) => action.name),
        ]),
      ],
      search = searchTerm(value);
    return new MirrorError('UNKNOWN_OPERATION', 'Unknown operation of this gateway.', {
      field,
      gateway,
      ...nameCandidates(value, names),
      list_call:
        catalog?.denominator_kind === 'LIST_ACTIONS' || listsActions.has(gateway)
          ? {tool: gateway, arguments: {action: 'LIST_ACTIONS', search, limit: 20}}
          : {tool: 'amcp_workspace', arguments: {action: 'contracts', gateway, search}},
    });
  }
  /** True when the tool's input schema (or, for a delegated tool, the operation's arguments schema) accepts this key. */
  acceptsArgument(tool: string, key: string, operation?: string): boolean {
    const t = this.tools.get(tool);
    if (!t) return false;
    const schema =
      t.mode === 'delegated' ? t.operations?.find(o => o.operation === operation)?.argumentsSchema : t.inputSchema;
    return (
      !!schema &&
      (Object.hasOwn(schema.properties ?? {}, key) ||
        (schema.additionalProperties !== false && schema.additionalProperties !== undefined))
    );
  }
  listTools(options: CallOptions) {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: describedTool(t),
      inputSchema: this.schema(t, options),
    }));
  }
  schema(tool: ToolDefinition, options: CallOptions): JsonObject {
    const schema = structuredClone(tool.inputSchema);
    if (options.flags.compactSchemas && Array.isArray(schema.properties?.action?.enum)) {
      // Validation keeps the full enum, so a legacy alias is still accepted; only the listing drops it.
      const listed = new Set<string>(schema.properties.action.enum),
        aliases = new Set<string>();
      for (const a of this.catalogs.get(tool.name)?.actions ?? [])
        if (listed.has(a.canonical_name))
          for (const alias of a.aliases) if (alias !== a.canonical_name) aliases.add(alias);
      schema.properties.action.enum = schema.properties.action.enum.filter((v: string) => !aliases.has(v));
    }
    if (options.mode === 'enhanced' && tool.mode === 'direct') {
      if (options.flags.dryRunSchemaDefault && schema.properties.dry_run) schema.properties.dry_run.default = true;
      if (options.flags.uniformIdempotency)
        schema.properties.idempotency_key = {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'Tenant-scoped persistent idempotency key.',
        };
      if (options.flags.nativeRequests)
        schema.properties.native_request = {
          type: 'object',
          required: ['method', 'path'],
          properties: {
            method: {type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']},
            path: {type: 'string'},
            query: {type: 'object'},
            body: {},
          },
          additionalProperties: false,
        };
    }
    return schema;
  }
  help(input: JsonObject, options: CallOptions): JsonObject {
    if (!input.gateway) return structuredClone(this.data.discovery);
    const tool = this.tools.get(input.gateway);
    if (!tool) throw new MirrorError('UNKNOWN_GATEWAY', 'Unknown gateway.');
    if (input.gateway === microsoftGateway) {
      if (input.operation) {
        const action = microsoftActions.find(a => a.name === input.operation);
        if (!action)
          throw new MirrorError('UNKNOWN_OPERATION', 'Unknown Microsoft operation. Use LIST_ACTIONS.', {
            field: 'operation',
            gateway: microsoftGateway,
            ...nameCandidates(
              input.operation,
              microsoftActions.map(a => a.name),
            ),
            list_call: {
              tool: microsoftGateway,
              arguments: {action: 'LIST_ACTIONS', search: searchTerm(input.operation)},
            },
          });
        return structuredClone(action);
      }
      return {
        ...structuredClone(tool.help),
        inputSchema: this.schema(tool, options),
        amcp_actions: microsoftActions.map(a => ({
          action: a.name,
          method: a.method,
          path: a.path,
          read_only: a.read_only,
        })),
      };
    }
    if (input.gateway === 'apple_ads_native_action') {
      const action = appleActions.find(a => a.name === input.operation);
      if (action)
        return {...structuredClone(action), qualification: 'Independent AMCP implementation; no live parity claim.'};
      if (!input.operation)
        return {
          ...structuredClone(tool.help),
          amcp_actions: appleActions.map(a => ({
            action: a.name,
            method: a.method,
            path: a.path,
            read_only: a.read_only,
          })),
          qualification:
            'Independent AMCP v1 extensions. Captured catalog counts are unchanged. Legacy v5 routes are unavailable.',
        };
    }
    if (input.operation && tool.mode === 'delegated') {
      const op = tool.operations?.find(x => x.operation === input.operation);
      if (!op)
        throw new MirrorError('UNKNOWN_OPERATION', 'Unknown operation.', {
          field: 'operation',
          gateway: input.gateway,
          ...nameCandidates(
            input.operation,
            (tool.operations ?? []).map(x => x.operation),
          ),
          list_call: {tool: 'amcp_tool_help', arguments: {gateway: input.gateway}},
        });
      return structuredClone(op);
    }
    if (input.operation) {
      const desc = this.data.descriptions[input.gateway + '/' + input.operation];
      if (desc) return structuredClone(currentCapture(input.gateway, desc));
      // A known record in the versioned captured catalog can describe its effective route, but
      // it does not supply an independently verified extended native schema or execution authority.
      const catalog = catalogVersions[input.gateway] ? this.catalogs.get(input.gateway) : undefined,
        action = catalog?.actions.find(a => a.name === input.operation);
      if (action)
        return {
          success: true,
          api_version: catalog!.api_version,
          ...structuredClone(action.raw),
          mirror_evidence: 'Catalog metadata only; extended DESCRIBE_ACTION response is unverified.',
        };
      // Any other action the catalog lists is described from its record, as DESCRIBE_ACTION does; an operation it does
      // not list is refused by name rather than answered with the whole gateway's help (MCP-05).
      const listed = this.action(input.gateway, input.operation);
      if (listed)
        return {
          success: true,
          api_version: this.catalogs.get(input.gateway)?.api_version,
          ...structuredClone(listed.raw),
          mirror_evidence: 'Catalog metadata only; extended DESCRIBE_ACTION response is unverified.',
        };
      throw this.unknownAction(input.gateway, input.operation, 'operation');
    }
    const out = structuredClone(tool.help);
    if (out.inputSchema) out.inputSchema = this.schema(tool, options);
    if (typeof out.description === 'string') {
      // AMCP's own text where the captured one is untrue (MCP-10); the captured text stays beside it.
      if (describesOwnText(tool, out.description)) out.captured_catalog = {description: out.description};
      out.description = describedTool(tool, out.description);
    }
    return out;
  }
}
