import {MirrorError} from './errors.js';
import {redact} from './security.js';
import type {Store} from './store.js';
import type {Actor, Connection, JsonObject} from './types.js';

const operations: Record<string, string> = {
  ga4_native_action: 'ga4_connection_ops',
  google_search_console_native_action: 'gsc_connection_ops',
  google_business_native_action: 'gmb_connection_ops',
};
export const businessQandaRetirement = {
  status: 'provider_unsupported',
  discontinued_on: '2025-11-03',
  checked_on: '2026-09-20',
  source: 'https://developers.google.com/my-business/content/sunset-dates',
  replacement_api: null,
};
export function redactConnectionInput(gateway: string, input: JsonObject): JsonObject {
  if (
    operations[gateway] !== input.operation ||
    !input.arguments ||
    typeof input.arguments !== 'object' ||
    Array.isArray(input.arguments)
  )
    return input;
  const args = {...input.arguments};
  for (const key of ['code', 'state']) if (Object.hasOwn(args, key)) args[key] = '[REDACTED]';
  return {...input, arguments: args};
}
export function connectionDiagnosticKind(
  gateway: string,
  operation: string,
  action: unknown,
): 'connection' | 'qanda' | undefined {
  if (operations[gateway] === operation && action === 'status') return 'connection';
  if (
    gateway === 'google_business_native_action' &&
    operation === 'gmb_qanda_ops' &&
    (action === undefined || action === 'status')
  )
    return 'qanda';
}
function invalid(message: string): never {
  throw new MirrorError('INVALID_ARGUMENT', message);
}
function summary(c: Connection) {
  return {
    connection_id: c.id,
    label: c.label,
    enabled: c.enabled,
    is_default: c.isDefault === true,
    selected_account_count: c.accounts.length,
    status: c.enabled ? (c.accounts.length ? 'configured' : 'selection_required') : 'disabled',
  };
}
/** Local metadata only. No tokens, provider requests, authorization codes,
 * reauthorization, implicit discovery or account-grant changes occur here. */
export function connectionDiagnostics(
  store: Store,
  gateway: string,
  operation: string,
  input: JsonObject,
  actor: Actor,
  allowWrites: boolean,
): JsonObject {
  store.assertActorActive(actor);
  const kind = connectionDiagnosticKind(gateway, operation, input.action);
  if (!kind) invalid('This diagnostic supports status only.');
  const allowed = kind === 'qanda' ? ['action'] : ['action', 'connection_id', 'dry_run'];
  if (Object.keys(input).some(k => !allowed.includes(k)))
    invalid('Status does not accept authorization codes, state, redirect overrides or synchronization arguments.');
  if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') invalid('dry_run must be a boolean.');
  if (kind === 'qanda')
    return {
      ...businessQandaRetirement,
      network_requests: 0,
      local_changes: 0,
      provider_changes: 0,
      meaning:
        'The local retirement-status workflow is implemented. Google no longer offers Q&A reads or writes; this is not an implemented provider Q&A API.',
      next_action:
        'Remove Q&A API and Q&A notification dependencies; additional OAuth scopes cannot restore a discontinued service.',
    };
  if (
    input.connection_id !== undefined &&
    (typeof input.connection_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.connection_id))
  )
    invalid('Select an exact connection UUID.');
  const all = store
    .listConnections(actor.tenantId)
    .filter(c => c.gateway === gateway)
    .sort((a, b) => a.id.localeCompare(b.id));
  let selected: Connection | undefined;
  if (input.connection_id) {
    selected = all.find(c => c.id === input.connection_id);
    if (!selected)
      throw new MirrorError('CONNECTION_NOT_FOUND', 'No matching connection exists in this workspace.', {}, 404);
  } else if (all.length === 1) selected = all[0];
  else {
    const enabled = all.filter(c => c.enabled),
      defaults = enabled.filter(c => c.isDefault === true);
    if (defaults.length === 1) selected = defaults[0];
    else if (enabled.length === 1) selected = enabled[0];
  }
  const writeAccounts = selected ? (selected.writeAccounts ?? []).filter(id => selected.accounts.includes(id)) : [];
  const detail = selected
    ? {
        ...summary(selected),
        gateway,
        accounts: selected.accounts.slice(0, 250),
        write_accounts: writeAccounts.slice(0, 250),
        write_account_count: writeAccounts.length,
        account_list_truncated: selected.accounts.length > 250 || writeAccounts.length > 250,
        recorded_oauth_scopes: [...selected.scopes],
        deployment_writes_enabled: allowWrites,
        actor_can_request_writes:
          allowWrites && actor.role !== 'reader' && selected.enabled && writeAccounts.length > 0,
        provider_access: 'not_checked',
        credential_health: 'not_inspected',
        meaning:
          'Recorded provider scopes and AMCP grants are distinct. Configuration is not proof of current provider access, quota, approval or an executable write contract.',
      }
    : null;
  store.assertActorActive(actor);
  return redact({
    source: 'AMCP stored connection metadata',
    gateway,
    network_requests: 0,
    local_changes: 0,
    provider_changes: 0,
    status: selected ? summary(selected).status : all.length ? 'selection_required' : 'not_connected',
    selected_connection: detail,
    connection_count: all.length,
    connections: all.slice(0, 100).map(summary),
    connections_truncated: all.length > 100,
    selection_required: !selected && all.length > 0,
    next_action:
      !selected && all.length
        ? 'Repeat status with an explicit connection_id. Use Connections for the complete inventory.'
        : !selected || !selected.enabled || !selected.accounts.length
          ? 'Use the AMCP Connections page to authorize or select accounts.'
          : 'Use the selected connection_id and account/property/site ID for the next operation; check current provider access independently.',
    website_path: '/connections',
    authorization:
      'Browser authorization remains separate from this status operation. Never send passwords, tokens, authorization codes or signed OAuth state to status.',
  });
}
