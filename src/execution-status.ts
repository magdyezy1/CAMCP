import type {Registry} from './catalog.js';
import {actionContracts, type ActionContract} from './action-contracts.js';
import {unavailableOperation} from './unavailable-operations.js';
import {readUnanchored} from './route-anchors.js';
import type {JsonObject} from './types.js';

/**
 * What the route of a single action rests on (ARC-03), and for a native read that no pinned or dated vendor artifact
 * states, the advisory read_unanchored. Advisory only: it changes neither the status nor what AMCP runs.
 */
const unanchoredNotes: Partial<Record<NonNullable<ActionContract['anchor_status']>, string>> = {
  captured_only: 'its method and path come only from the captured catalog',
  unanchored: 'its method and path come from an AMCP mapping of documentation that is not pinned',
  not_recorded: 'no route anchor is recorded for it yet',
};
function routeAnchorNote(row: ActionContract): JsonObject {
  if (!row.anchor_status || row.anchor_status === 'no_route') return {};
  return {
    route_anchor: row.anchor_status,
    ...(readUnanchored(row)
      ? {
          advisory: 'read_unanchored',
          advisory_note:
            'This read runs as classified, but ' +
            unanchoredNotes[row.anchor_status] +
            ': no pinned vendor document, SDK request or dated page states its route (amcp_workspace contracts, anchor).',
        }
      : {}),
  };
}

/** Contract statuses that settle whether a request only reads; the others keep the captured flag. */
const readOnlyByStatus: Partial<Record<ActionContract['status'], boolean>> = {
  native_read: true,
  unqualified_read: true,
  reviewed_write_family: false,
  blocked_write: false,
  media_workflow: false,
};
const rowsOf = (registry: Registry, gateway: string, operation: string, action?: string) => {
  const delegated = registry.tools.get(gateway)?.mode === 'delegated',
    // A direct gateway's alias (an unprefixed DV360 name, another spelling) reads as the captured action it names.
    named = delegated ? operation : (registry.action(gateway, operation)?.name ?? operation);
  return actionContracts(registry).filter(r =>
    r.gateway !== gateway
      ? false
      : delegated
        ? r.operation === operation && (action === undefined || r.action === action)
        : r.action === named,
  );
};
/**
 * Whether AMCP can run an operation (or a direct gateway's action), from the contracts ledger (MCP-10): its status,
 * why, and for an operation AMCP cannot run the calls to use instead. An operation whose actions differ lists each.
 */
export function amcpExecution(
  registry: Registry,
  gateway: string,
  operation: string,
  action?: string,
): JsonObject | undefined {
  const rows = rowsOf(registry, gateway, operation, action);
  if (!rows.length) return undefined;
  const statuses = [...new Set(rows.map(r => r.status))],
    unavailable = unavailableOperation(gateway, operation, action ?? rows[0]!.action);
  if (statuses.length === 1)
    return {
      status: statuses[0],
      reason: unavailable ? unavailable.reason + ' ' + rows[0]!.reason : rows[0]!.reason,
      ...(unavailable ? {alternatives: structuredClone(unavailable.alternatives)} : {}),
      ...(rows.length === 1 ? routeAnchorNote(rows[0]!) : {}),
    };
  return {
    status: 'mixed',
    reason: 'The actions of this operation differ; each is listed with its status.',
    actions: rows.slice(0, 50).map(r => ({action: r.action, status: r.status})),
    ...(rows.length > 50 ? {actions_total: rows.length} : {}),
  };
}
/**
 * A captured DESCRIBE_ACTION record (or a direct gateway's operation help) as AMCP answers it (MCP-10): read_only is
 * AMCP's own contract classification and api_version the version AMCP sends; the captured values that differ are kept
 * under captured_catalog, and amcp_execution says whether AMCP runs the action.
 */
export function amcpDescribed(registry: Registry, gateway: string, name: string, record: JsonObject): JsonObject {
  const execution = amcpExecution(registry, gateway, name);
  if (!execution) return record;
  const capturedVersion =
      registry.data.descriptions[gateway + '/' + name]?.api_version ??
      registry.data.catalogs.find(c => c.gateway === gateway)?.api_version,
    primary = readOnlyByStatus[execution.status as ActionContract['status']],
    captured: JsonObject = {};
  if (primary !== undefined && typeof record.read_only === 'boolean' && record.read_only !== primary)
    captured.read_only = record.read_only;
  if (
    typeof record.api_version === 'string' &&
    typeof capturedVersion === 'string' &&
    capturedVersion !== record.api_version
  )
    captured.api_version = capturedVersion;
  return {
    ...record,
    ...(captured.read_only !== undefined ? {read_only: primary} : {}),
    ...(Object.keys(captured).length
      ? {
          captured_catalog: {
            ...captured,
            meaning:
              'The captured catalog’s values. read_only above is AMCP’s contract classification and api_version the version AMCP sends.',
          },
        }
      : {}),
    amcp_execution: execution,
  };
}
