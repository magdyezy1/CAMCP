import {Ajv} from 'ajv';
import addFormatsModule from 'ajv-formats';
import type {Action, CallOptions, Catalog, RegistryData, ToolDefinition, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {guardInput} from './security.js';
import {catalogVersions, currentCapture} from './catalog-versions.js';
import {pinnedJson} from './pinned-json.js';
import {describedTool, describesOwnText} from './tool-notes.js';
import {nameCandidates, searchTerm} from './name-candidates.js';
import {actionAliasTable, type ActionAliasTable} from './action-aliases.js';
import {unsupportedProviderAlias} from './retired-provider-actions.js';
import {providerAdapters} from './provider-adapters.js';
import {providerHooks, registeredProviderHooks} from './provider-hooks.js';
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => void;
/** Gateways whose captured schema lacks LIST_ACTIONS but which AMCP lists from its catalog (MCP-05). */
export const listsActions = new Set(providerAdapters.filter(a => a.listsActions).map(a => a.gateway));
/**
 * The providers' additions to captured tool definitions, by tool name (ARC-01 phase B, src/<provider>-adapter.ts): a
 * load-time check, like a family declaration's, that no two providers extend one tool.
 */
const toolExtensions = new Map<string, (tool: ToolDefinition) => ToolDefinition>();
for (const {gateway, catalog} of registeredProviderHooks)
  for (const [name, extend] of Object.entries(catalog?.tools ?? {})) {
    if (toolExtensions.has(name)) throw new Error('Two providers extend the tool ' + name + ': ' + gateway + '.');
    toolExtensions.set(name, extend);
  }
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
      // A provider's additions to the captured definition (X's report jobs, Reddit's, DV360's, Business Profile's and
      // Adjust's extensions, Meta's post workflow in AMCP's native tool), else the gateway's version move.
      const extend = toolExtensions.get(original.name),
        tool = extend ? extend(original) : (catalogVersions[original.name]?.tool?.(original) ?? original);
      this.tools.set(tool.name, tool);
      this.schemas.set(tool.name, tool.inputSchema);
      for (const op of tool.operations ?? []) this.schemas.set(tool.name + '/' + op.operation, op.argumentsSchema);
    }
    for (const original of this.data.catalogs) {
      // A provider's documented overrides of its captured actions (Meta's), before the version move.
      const override = providerHooks(original.gateway)?.catalog?.action,
        actions = override ? original.actions.map(override) : original.actions,
        moved = catalogVersions[original.gateway],
        catalog = moved
          ? {...original, api_version: moved.version, actions: actions.map(moved.action)}
          : {...original, actions};
      this.catalogs.set(catalog.gateway, catalog);
      for (const action of catalog.actions) this.register(catalog.gateway, action);
    }
    for (const action of this.data.supplemental) this.register(action.gateway!, action, false);
    // The actions providers document beyond the captured catalog (Meta's rule update and delete, which the captured
    // catalog maps only as creation, src/meta-ad-rules.ts; Google's Data Manager; Apple's v1 actions), where the
    // registry holds the catalog or tool they extend. Their routes are each provider's own, so the order between
    // providers does not matter.
    for (const {gateway, catalog} of registeredProviderHooks) {
      const extra = catalog?.supplemental;
      if (extra && (extra.requires === 'tool' ? this.tools : this.catalogs).has(gateway))
        for (const action of extra.actions) this.register(gateway, action, false);
    }
    // A provider whose tool and catalog are AMCP's own contracts (Microsoft Advertising), with AMCP's tools.
    if (this.tools.has('amcp_tool_help'))
      for (const {gateway, catalog} of registeredProviderHooks) {
        const own = catalog?.own?.();
        if (!own) continue;
        this.tools.set(gateway, own.tool);
        this.schemas.set(gateway, own.tool.inputSchema);
        this.catalogs.set(gateway, own.catalog);
        for (const a of own.catalog.actions) this.register(gateway, a);
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
    this.aliasTables.clear();
  }
  /**
   * The near-miss spellings of a gateway's action names (T7, src/action-aliases.ts): generated from its exact names the
   * first time one is asked for, held apart from `routes` so that nothing that lists, counts or validates action names
   * (tools/list, the contracts ledger, did_you_mean) ever sees one.
   */
  private aliasTables = new Map<string, ActionAliasTable>();
  actionAliases(gateway: string): ActionAliasTable {
    let table = this.aliasTables.get(gateway);
    if (!table) {
      const prefix = gateway + '/',
        names = new Map<string, Action>();
      for (const [key, action] of this.routes) if (key.startsWith(prefix)) names.set(key.slice(prefix.length), action);
      this.aliasTables.set(
        gateway,
        (table = actionAliasTable(
          names,
          providerHooks(gateway)?.catalog?.aliases,
          spelling => unsupportedProviderAlias(gateway, spelling) !== undefined,
        )),
      );
    }
    return table;
  }
  /**
   * The action a name stands for. An exact name (or its lower case) resolves as it always did. Failing that, a near-miss
   * spelling that stands for exactly one action resolves to that action, the very one its canonical name reaches, and
   * `alias` names what was used and what to send instead: every caller that tells a person or an agent what it ran
   * reports it. A spelling that stands for more than one is no alias.
   */
  resolveAction(
    gateway: string,
    name: string,
  ): {action: Action | undefined; alias?: {used: string; canonical: string}} {
    const exact = this.action(gateway, name);
    if (exact) return {action: exact};
    const {aliases} = this.actionAliases(gateway),
      entry = aliases.get(name) ?? aliases.get(name.toLowerCase());
    return entry ? {action: entry.action, alias: {used: name, canonical: entry.canonical}} : {action: undefined};
  }
  /**
   * The action an exact name stands for (or its lower case), as it always did. A near-miss spelling is no name here (the
   * review's S3-3): only the sites that canonicalize it and tell the caller what to send call `resolveAction`, so no other
   * lookup (help, the workflow engine, capability eligibility, execution status, decision reporting) resolves one silently.
   */
  action(gateway: string, name: string): Action | undefined {
    return this.routes.get(gateway + '/' + name) ?? this.routes.get(gateway + '/' + name.toLowerCase());
  }
  validate(tool: string, input: JsonObject, options: CallOptions) {
    guardInput(input);
    const definition = this.tools.get(tool);
    if (!definition) throw new MirrorError('UNKNOWN_TOOL', 'Unknown MCP tool: ' + tool);
    const checkInput = structuredClone(input);
    // A provider that answers amcp_tool_help from its own contracts checks those arguments itself (Microsoft).
    const helpArguments = tool === 'amcp_tool_help' ? providerHooks(input.gateway)?.catalog?.helpArguments : undefined;
    if (helpArguments) {
      helpArguments(input);
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
    // A provider's own help, before the captured help (Microsoft's contracts; Apple's v1 actions and its gateway).
    const own = providerHooks(input.gateway)?.catalog?.help?.(input, tool, () => this.schema(tool, options));
    if (own) return own;
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
