import {MirrorError} from './errors.js';
import type {Registry} from './catalog.js';
import type {JsonObject} from './types.js';

/**
 * get_workspace_context and list_accounts as AMCP implements them (MCP-10). Both read AMCP's own store and make no
 * provider request. The captured schemas promise options AMCP does not have (a billing summary, asset counts, inactive
 * accounts); each such option is accepted only at its captured default, which is what AMCP does anyway, and any other
 * value is refused naming the option rather than ignored. The listed schemas stay the captured ones (owner decision
 * D17); operation help shows these.
 */
export const contextOptionDefaults: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  get_workspace_context: {
    include_accounts: false,
    account_limit: 20,
    include_asset_summary: false,
    include_integration_details: false,
  },
  list_accounts: {include_inactive: false},
};
const gateways = new Set(['amcp_platform_workspace', 'amcp_native_action']);
/** Whether this gateway's operation is one AMCP describes with its own contract here. */
export const contextOperation = (gateway: string, operation: unknown): operation is string =>
  gateways.has(gateway) && typeof operation === 'string' && Object.hasOwn(contextOptionDefaults, operation);
/**
 * The platform names list_accounts filters by: each provider gateway, the captured google and x spellings, and the
 * sheets and drive spellings that list report destinations and media sources (CON-05; src/service.ts maps them).
 */
export function accountPlatforms(registry: Registry): string[] {
  const names = [...registry.tools.keys()]
    .filter(n => n.endsWith('_native_action') && n !== 'amcp_native_action')
    .map(n => n.slice(0, -'_native_action'.length));
  return [...new Set([...names, 'google', 'x', 'sheets', 'drive'])].sort();
}
/** Refuses an option AMCP does not implement, naming it; a captured default is accepted and changes nothing. */
export function checkContextOptions(registry: Registry, operation: string, args: JsonObject): void {
  for (const [option, value] of Object.entries(contextOptionDefaults[operation] ?? {}))
    if (args[option] !== undefined && args[option] !== value)
      throw new MirrorError(
        'INVALID_ARGUMENT',
        operation + ' does not support ' + option + ' in AMCP; omit it. ' + optionMeaning[option],
        {field: option, operation, accepted_value: value},
      );
  if (operation === 'list_accounts' && args.platform !== undefined) {
    const allowed = accountPlatforms(registry);
    if (typeof args.platform !== 'string' || !allowed.includes(args.platform))
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'platform names no provider AMCP connects; use one in details.allowed.',
        {
          field: 'platform',
          allowed,
        },
      );
  }
}
const optionMeaning: Record<string, string> = {
  include_accounts: 'list_accounts returns the accounts.',
  account_limit: 'list_accounts returns every bound account.',
  include_asset_summary: 'list_workspace_assets returns the saved workspace assets.',
  include_integration_details: 'The connections are always returned with their account IDs.',
  include_inactive:
    'AMCP lists every account bound to an enabled connection and does not know whether it is active or paused.',
};
const accepted = (option: string, value: unknown, type: string) => ({
  type,
  const: value,
  description: 'Accepted only as ' + JSON.stringify(value) + ', the captured default. ' + optionMeaning[option],
});
/** Operation help for these two operations: AMCP's description and arguments, with the captured ones beside them. */
export function contextOperationHelp(registry: Registry, captured: JsonObject): JsonObject {
  const operation = String(captured.operation),
    workspace = operation === 'get_workspace_context';
  return {
    gateway: captured.gateway,
    operation,
    description: workspace
      ? 'The AMCP workspace this connection works in: its id, the caller’s id and role, each enabled provider connection (id, platform, account IDs, write-enabled account IDs, whether it is the default) and whether this deployment allows reviewed writes. It reads AMCP’s own records and makes no provider request; list_accounts returns account names, currency and time zone.'
      : 'The accounts bound to this workspace’s enabled connections, one row each: id, platform, connection_id, connection_label, write_enabled and is_default, with the name, currency and time zone AMCP kept from the account’s last live read and metadata.source and metadata.checked_at. Until such a read they are null and the row carries a next_call (amcp_workspace check live:true) that reads the account. It reads AMCP’s own records, makes no provider request and does not know whether an account is active or paused.',
    argumentsSchema: {
      type: 'object',
      properties: workspace
        ? {
            include_accounts: accepted('include_accounts', false, 'boolean'),
            account_limit: accepted('account_limit', 20, 'integer'),
            include_asset_summary: accepted('include_asset_summary', false, 'boolean'),
            include_integration_details: accepted('include_integration_details', false, 'boolean'),
          }
        : {
            platform: {
              type: 'string',
              enum: accountPlatforms(registry),
              description: 'Only the accounts of this provider (google is google_ads, x is x_ads).',
            },
            include_inactive: accepted('include_inactive', false, 'boolean'),
          },
      additionalProperties: false,
    },
    captured_catalog: {
      description: captured.description,
      argumentsSchema: captured.argumentsSchema,
      meaning:
        'The captured catalog’s text and schema, which AMCP still validates against. An option above accepted only at its default is refused with INVALID_ARGUMENT at any other value.',
    },
  };
}
