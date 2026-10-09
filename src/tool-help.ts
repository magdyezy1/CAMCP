import type {Registry} from './catalog.js';
import type {CallOptions, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {guardInput} from './security.js';
import {microsoftGateway} from './microsoft-native.js';
import {mediaDiscovery} from './media-routing.js';
import {conditionalProgramDescription} from './conditional-programs.js';
import {providerContractView} from './contract-evidence.js';
import {guidanceDiscovery, guideTopic} from './guidance.js';
import {firstPartyHelp} from './tool-summaries.js';

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
}
export interface HelpContext {
  registry: Registry;
  options: CallOptions;
  /** What tools/list shows, in this deployment's mode. */
  listed: () => ListedTool[];
  /** The AMCP-authored tools with their full descriptions. */
  firstParty: () => ListedTool[];
}
const helpArguments = ['gateway', 'operation', 'topic', 'include_guidance'];
const distance = (a: string, b: string) => {
  let row = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
};
/**
 * What a refusal of an unknown name carries (MCP-05): the value, how many names are valid, the first 20 of them and
 * up to five close ones from the same list (never another gateway's), so the caller can correct it in one call.
 */
export function nameCandidates(value: string, candidates: string[]): JsonObject {
  const needle = value.toLowerCase().slice(0, 200),
    close = candidates
      .map(name => {
        const lower = name.toLowerCase();
        return {
          name,
          score:
            needle.length >= 4 && (lower.includes(needle) || needle.includes(lower))
              ? 0
              : distance(needle, lower.slice(0, 200)),
        };
      })
      .filter(c => c.score <= Math.max(3, Math.floor(needle.length / 3)))
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map(c => c.name);
  return {value: value.slice(0, 200), count: candidates.length, allowed: candidates.slice(0, 20), did_you_mean: close};
}
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
    return guideTopic(input.topic);
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
    amcp_extensions: {gateways: [microsoftGateway]},
  };
  if (input.gateway === undefined) return {...structuredClone(ctx.registry.data.discovery), ...global};
  const extras = input.include_guidance === true ? {amcp_guidance: global.amcp_guidance, amcp_extensions: global.amcp_extensions} : {};
  const listed = ctx.listed(),
    own = ctx.firstParty().find(t => t.name === input.gateway);
  if (own) {
    const actions: string[] = own.inputSchema.properties?.action?.enum ?? [];
    if (input.operation !== undefined && !actions.includes(input.operation))
      throw new MirrorError('UNKNOWN_OPERATION', 'Unknown action of this AMCP tool.', {
        field: 'operation',
        gateway: own.name,
        ...nameCandidates(input.operation, actions),
        list_call: {tool: 'amcp_tool_help', arguments: {gateway: own.name}},
      });
    return {...firstPartyHelp(own, listed.find(t => t.name === own.name)!.description, input.operation), ...extras};
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
        gateway: 'Any tool tools/list shows, including the AMCP tools and ' + microsoftGateway + '.',
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
    throw new MirrorError('UNKNOWN_GATEWAY', 'Unknown gateway.', {field: 'gateway'});
  const help = ctx.registry.help({gateway: input.gateway, operation: input.operation}, ctx.options),
    media = mediaDiscovery(input.gateway),
    program = conditionalProgramDescription(ctx.registry, input.gateway, input.operation);
  if (input.operation !== undefined)
    return {
      ...help,
      ...(program ? {amcp_conditional_program: program} : {}),
      ...(media && mediaOperation.test(input.operation) ? {amcp_media_import: media} : {}),
      ...extras,
      see: {
        tool: 'amcp_tool_help',
        arguments: {gateway: input.gateway},
        meaning: 'The gateway’s schema, provider contract and media import route.',
      },
    };
  return {
    ...help,
    amcp_contract: providerContractView(input.gateway),
    amcp_action_contracts: global.amcp_action_contracts,
    ...(media ? {amcp_media_import: media} : {}),
    ...extras,
  };
}
