import type {Registry} from './catalog.js';
import type {CallOptions, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {guardInput, sha256, stable} from './security.js';
import {registeredProviderHooks} from './provider-hooks.js';
import {mediaDiscovery} from './media-routing.js';
import {conditionalProgramDescription} from './conditional-programs.js';
import {providerContractView} from './contract-evidence.js';
import {guidanceDiscovery, guideTopic} from './guidance.js';
import type {ContractProfile} from './contract-profile.js';
import {contractProfileTopic} from './mcp-profile-help.js';
import {firstPartyHelp} from './tool-summaries.js';
import {nameCandidates} from './name-candidates.js';
import {amcpDescribed, amcpExecution} from './execution-status.js';
import {unavailableOperations} from './unavailable-operations.js';
import {contextOperation, contextOperationHelp} from './context-operations.js';
import {firstPartyContract, toolActions} from './first-party-contracts.js';
import {capturePresetHelp} from './report-presets.js';
import {previewLinkAccessHelp} from './ad-previews.js';

/**
 * What the help of one first-party action adds to its contract, by tool and action (R25 M0, owner 2026-11-15): a function of
 * the day it is asked, kept out of tools/list. amcp_reporting capture_preset's worked calls are the platforms' own. A key of
 * a tool alone is what its root help adds: amcp_ad_previews says which links need a sign-in, which its description, pinned
 * by the tool surface golden, cannot.
 */
const helpAdditions: Readonly<Record<string, () => JsonObject>> = {
  'amcp_reporting capture_preset': () => capturePresetHelp(),
  amcp_ad_previews: () => previewLinkAccessHelp(),
};
const helpAddition = (tool: string, action: string | undefined): JsonObject =>
  helpAdditions[action === undefined ? tool : tool + ' ' + action]?.() ?? {};

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
}
/** A first-party tool's own read-only help; the captured help schema remains unchanged (D17-bis). */
export function ownToolHelp(tool: ListedTool, topic?: string, profile?: ContractProfile): JsonObject {
  if (topic !== undefined && (typeof topic !== 'string' || !topic || topic.length > 300))
    throw new MirrorError('INVALID_ARGUMENT', 'Use a name of at most 300 characters.', {field: 'topic'});
  if (tool.name === 'amcp_workspace' && (topic === 'guides' || topic?.startsWith('guides/')))
    return guideTopic(topic, profile);
  // The contract profile of this connection and what the other one changes (V2-MCP-06), announced here, not in tools/list.
  if (tool.name === 'amcp_workspace' && topic === 'mcp_profile') return contractProfileTopic(profile);
  const actions = toolActions(tool);
  if (topic !== undefined && !actions.includes(topic))
    throw new MirrorError('UNKNOWN_OPERATION', 'Unknown action of this AMCP tool.', {
      field: 'topic',
      ...nameCandidates(
        topic,
        actions.filter((a): a is string => a !== null),
      ),
      list_call: {tool: tool.name, arguments: {action: 'help'}},
    });
  const help = firstPartyHelp(tool, '', topic),
    examples = (topic === undefined ? actions : [topic]).map(action => {
      const contract = firstPartyContract(tool, action)!,
        args: JsonObject = action === null ? {} : {action};
      for (const name of contract.argumentsSchema.required)
        if (name !== 'action') args[name] = name === 'confirmed' ? true : '<' + name + '>';
      return {tool: tool.name, arguments: args};
    });
  // The full description and examples already explain every action. Avoid repeating the routing/action summaries
  // on this new endpoint so the workspace help still fits one 40 KB call. Legacy gateway help keeps those fields.
  if (topic === undefined) {
    delete help.summary;
    delete help.action_summaries;
  }
  // The topics of amcp_workspace help that are not actions (guides, and the contract profile of V2-MCP-06).
  return {
    ...help,
    ...helpAddition(tool.name, topic),
    ...(tool.name === 'amcp_workspace' && topic === undefined ? {other_topics: ['guides', 'mcp_profile']} : {}),
    examples,
  };
}
export interface HelpContext {
  registry: Registry;
  options: CallOptions;
  /** What tools/list shows, in this deployment's mode. */
  listed: () => ListedTool[];
  /** The AMCP-authored tools with their full descriptions. */
  firstParty: () => ListedTool[];
  /** This build's identity (dist/release-identity.json), when it can be read. */
  release?: () => JsonObject;
  /** The contract profile of the client asking (V2-MCP-06); legacy when absent. */
  profile?: ContractProfile;
}
/** A short hash of what tools/list shows: it changes when any listed name, description or schema changes (MCP-05). */
export const surfaceRevision = (listed: ListedTool[]) => sha256(stable(listed)).slice(0, 16);
/**
 * The surface this connection lists now (MCP-05), computed from tools/list. The captured discovery block beside it
 * keeps its recorded tool_count and gateways for compatibility (owner decision D17); this block is the live one.
 */
export function surfaceBlock(ctx: HelpContext): JsonObject {
  const listed = ctx.listed(),
    own = new Set(ctx.firstParty().map(t => t.name)),
    tools = listed.map(t => {
      const kind = t.name === 'amcp_tool_help' ? 'help' : own.has(t.name) ? 'amcp_workflow' : 'native_gateway';
      return {
        name: t.name,
        kind,
        selector:
          kind === 'help' ? null : ctx.registry.tools.get(t.name)?.mode === 'delegated' ? 'operation' : 'action',
      };
    });
  return {
    tool_count: tools.length,
    tools,
    surface_revision: surfaceRevision(listed),
    help_call: {tool: 'amcp_tool_help', arguments: {gateway: '<name>'}},
    meaning:
      'The tools this connection lists now. The captured tool_count and gateways above are the compatibility catalog. A different surface_revision means tool definitions changed: list the tools again.',
  };
}
const helpArguments = ['gateway', 'operation', 'topic', 'include_guidance'];
/**
 * The extension gateways: providers whose tool and catalog are AMCP's own contracts rather than captured ones (their
 * catalog hooks, ARC-01 phase B: Microsoft Advertising), in the provider hooks registry's order.
 */
const extensionGateways: readonly string[] = Object.freeze(
  registeredProviderHooks.filter(hooks => hooks.catalog?.own).map(hooks => hooks.gateway),
);
/** Operation help names an operation of a media gateway that moves a file: the media import route applies to it. */
const mediaOperation = /upload|image|video|media|asset/i;
/**
 * `amcp_tool_help` (MCP-01). Root help carries the discovery-wide keys (guides, extensions, the contracts ledger);
 * gateway help carries that gateway's provider contract and media import route; operation help carries only what
 * concerns the operation and a `see` call for the rest, so the gateway-level text is not repeated on every call.
 * `include_guidance:true` adds the discovery-wide keys anywhere. The captured schema stays byte-identical (owner
 * decision D17): the AMCP tools, `topic` and `include_guidance` are accepted by this special case, as Microsoft is.
 */
export function toolHelp(ctx: HelpContext, input: JsonObject): JsonObject {
  guardInput(input);
  for (const key of Object.keys(input))
    if (!helpArguments.includes(key))
      throw new MirrorError('INVALID_ARGUMENT', 'Unknown amcp_tool_help argument.', {
        field: key,
        allowed: helpArguments,
      });
  for (const key of ['gateway', 'operation', 'topic'])
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key] || input[key].length > 300))
      throw new MirrorError('INVALID_ARGUMENT', 'Use a name of at most 300 characters.', {field: key});
  if (input.include_guidance !== undefined && typeof input.include_guidance !== 'boolean')
    throw new MirrorError('INVALID_ARGUMENT', 'include_guidance is true or false.', {field: 'include_guidance'});
  if (input.topic !== undefined) {
    if (input.gateway !== undefined || input.operation !== undefined)
      throw new MirrorError('INVALID_ARGUMENT', 'Ask for a topic or a gateway, not both.', {field: 'topic'});
    return guideTopic(input.topic, ctx.profile);
  }
  if (input.operation !== undefined && input.gateway === undefined)
    throw new MirrorError('INVALID_ARGUMENT', 'Name the gateway whose operation you want described.', {
      field: 'operation',
    });
  const global = {
    amcp_action_contracts: {
      tool: 'amcp_workspace',
      arguments: {action: 'contracts', ...(input.gateway ? {gateway: input.gateway} : {})},
      meaning: 'Action-level route coverage; exact-payload inspect remains mandatory.',
    },
    amcp_guidance: guidanceDiscovery,
    amcp_extensions: {gateways: [...extensionGateways]},
  };
  if (input.gateway === undefined)
    return {
      ...structuredClone(ctx.registry.data.discovery),
      amcp_surface: surfaceBlock(ctx),
      ...(ctx.release ? {amcp_release: ctx.release()} : {}),
      ...global,
    };
  const extras =
    input.include_guidance === true
      ? {amcp_guidance: global.amcp_guidance, amcp_extensions: global.amcp_extensions}
      : {};
  const listed = ctx.listed(),
    own = ctx.firstParty().find(t => t.name === input.gateway);
  if (own) {
    const actions: string[] = own.inputSchema.properties?.action?.enum ?? [];
    if (input.operation !== undefined && !actions.includes(input.operation))
      throw new MirrorError('UNKNOWN_OPERATION', 'Unknown action of this AMCP tool.', {
        field: 'operation',
        gateway: own.name,
        ...nameCandidates(input.operation, actions),
        list_call: {tool: own.name, arguments: {action: 'help'}},
      });
    return {
      ...firstPartyHelp(own, listed.find(t => t.name === own.name)!.description, input.operation),
      ...helpAddition(own.name, input.operation),
      ...extras,
    };
  }
  if (input.gateway === 'amcp_tool_help') {
    if (input.operation !== undefined)
      throw new MirrorError('UNKNOWN_OPERATION', 'amcp_tool_help has no operations.', {field: 'operation'});
    const self = listed.find(t => t.name === 'amcp_tool_help')!;
    return {
      gateway: 'amcp_tool_help',
      mode: 'help',
      description: self.description,
      inputSchema: self.inputSchema,
      amcp_arguments: {
        gateway: 'Any tool tools/list shows, including the AMCP tools and ' + extensionGateways.join(', ') + '.',
        operation: 'An action or operation of that gateway.',
        topic: '"guides", "guides/<name>" (a section index) or "guides/<name>/<section id>" (one section).',
        include_guidance: 'true adds the guide list and extension gateways to gateway or operation help.',
        meaning:
          'The captured input schema is kept unchanged for compatibility; these arguments are accepted beyond it.',
      },
      ...extras,
    };
  }
  if (!ctx.registry.tools.has(input.gateway) || !listed.some(t => t.name === input.gateway))
    throw new MirrorError('UNKNOWN_GATEWAY', 'Unknown gateway.', {
      field: 'gateway',
      ...nameCandidates(
        input.gateway,
        listed.map(t => t.name),
      ),
      list_call: {tool: 'amcp_tool_help', arguments: {}},
      surface_revision: surfaceRevision(listed),
    });
  const help = ctx.registry.help({gateway: input.gateway, operation: input.operation}, ctx.options),
    media = mediaDiscovery(input.gateway, ctx.profile),
    program = conditionalProgramDescription(ctx.registry, input.gateway, input.operation);
  const contract = providerContractView(input.gateway);
  if (input.operation !== undefined) {
    // Whether AMCP runs it, from the contracts ledger; a direct gateway's action reads as DESCRIBE_ACTION answers it,
    // and the two context operations AMCP implements itself are described as implemented (MCP-10).
    const delegated = ctx.registry.tools.get(input.gateway)?.mode === 'delegated',
      execution = delegated ? amcpExecution(ctx.registry, input.gateway, input.operation) : undefined,
      described = delegated
        ? {
            ...(contextOperation(input.gateway, input.operation) ? contextOperationHelp(ctx.registry, help) : help),
            ...(execution ? {amcp_execution: execution} : {}),
          }
        : amcpDescribed(ctx.registry, input.gateway, input.operation, help);
    return {
      ...described,
      ...(program ? {amcp_conditional_program: program} : {}),
      ...(media && mediaOperation.test(input.operation) ? {amcp_media_import: media} : {}),
      ...extras,
      see: {
        tool: 'amcp_tool_help',
        arguments: {gateway: input.gateway},
        meaning: 'The gateway’s schema, provider contract and media import route.',
      },
    };
  }
  const unavailable = Object.entries(unavailableOperations[input.gateway] ?? {});
  return {
    ...help,
    // The operations listed for catalog compatibility that AMCP cannot run, and why (MCP-10).
    ...(unavailable.length
      ? {
          amcp_unavailable_operations: unavailable.map(([operation, entry]) => ({
            operation,
            ...(entry.actions ? {actions: entry.actions} : {}),
            reason: entry.reason,
          })),
        }
      : {}),
    ...(contract ? {amcp_contract: contract} : {}),
    amcp_action_contracts: global.amcp_action_contracts,
    ...(media ? {amcp_media_import: media} : {}),
    ...extras,
  };
}
