import type {MirrorService} from './service.js';
import type {JsonObject} from './types.js';
import {amcpExecution} from './execution-status.js';
import {firstPartyContract} from './first-party-contracts.js';
import {firstPartyActionHints} from './tool-annotations.js';

/**
 * Whether a call only reads (V2-MCP-06): the one question the response budget asks before it will cut a result into pieces
 * and run the same call again for the next. A call that saves anything, sends anything but a provider read, or reaches an
 * action AMCP does not classify is never read, so it is answered whole and never run twice.
 *
 * The classification is the one `amcp_tool_help` serves and tests/mcp-operation-annotations.test.mjs walks: an AMCP tool's action
 * is read when its contract's effects save nothing and send no write (`firstPartyActionHints`), and a native gateway's operation
 * or action is read when every row of the contracts ledger it names is a read (`amcpExecution`). The catalogue listings
 * (LIST_ACTIONS, DESCRIBE_ACTION) answer from AMCP's own catalogue, so they read.
 */
export function callIsRead(service: MirrorService, tool: string, args: JsonObject): boolean {
  const own = service.firstPartyTools().find(t => t.name === tool);
  if (own) {
    const action = typeof args.action === 'string' ? args.action : null,
      contract = firstPartyContract(own, action);
    return !!contract && firstPartyActionHints(tool, action, contract.effects).readOnlyHint;
  }
  const definition = service.registry.tools.get(tool);
  if (!definition) return false;
  if (args.action === 'LIST_ACTIONS' || args.action === 'DESCRIBE_ACTION') return true;
  const delegated = definition.mode === 'delegated',
    operation = delegated ? args.operation : args.action,
    inner =
      delegated && args.arguments && typeof args.arguments === 'object'
        ? (args.arguments as JsonObject).action
        : undefined;
  if (typeof operation !== 'string') return false;
  return (
    amcpExecution(service.registry, tool, operation, typeof inner === 'string' ? inner : undefined)?.annotations
      ?.readOnlyHint === true
  );
}
