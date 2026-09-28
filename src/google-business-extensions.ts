import type {ToolDefinition} from './types.js';

/** Maintained runtime guidance overrides, without rewriting the captured schema
 * or advertising unimplemented operations as executable. */
export function extendGoogleBusinessTool(original: ToolDefinition): ToolDefinition {
  const tool = structuredClone(original),
    op = tool.operations?.find(o => o.operation === 'gmb_engagement_ops');
  const connection = tool.operations?.find(o => o.operation === 'gmb_connection_ops');
  if (connection) {
    connection.description =
      'Local Business Profile connection status, administrator disconnect and native account/location metadata sync on a provisioned identity. Captured start/exchange/refresh actions and website OAuth remain unimplemented.';
    connection.argumentsSchema.properties.read_mask.description =
      'sync_assets only: comma-separated name,title,storeCode fields. Identity and title are always included; other native fields require a separate scoped read.';
    connection.argumentsSchema.properties.dry_run.description =
      'sync_assets and disconnect default to true (preview). sync_assets:false performs native reads and local metadata persistence, preserving account selections and write grants.';
    connection.amcp_discovery_contract = {
      actions: ['sync_assets'],
      guide: 'amcp://guides/dv360-and-measurement',
      authority:
        'Workspace administrator and recorded business.manage scope on an existing provisioned identity. Explicit connection UUID or sole/unique enabled default login; discovery does not grant account access.',
      dry_run:
        'Defaults to true: identity and bounds only, with no credential access, network requests or persistence. false replaces completely validated metadata groups; existing read/write selections are preserved.',
      selection:
        'Native business account IDs remain numeric. Location IDs retain locations/{id}. Shared native locations retain every discovered parent account; parent access does not imply an AMCP location grant.',
      fields:
        'read_mask accepts name,title,storeCode only; name and title are always added. Default includes all three. Other location fields require a separate scoped read.',
      bounds:
        '1–500 accounts, default 50; 1–500 locations per account, default 100. include_locations:false allows a zero location limit and preserves old location timestamps. 50 pages per collection, 250 requests, 8 MiB, 10000 assets and 60 seconds. A limit or invalid page fails without saving partial collections.',
      qualification:
        'Synthetic execution and concurrency fixtures. Website OAuth/discovery and MCP start/exchange/refresh are separate unimplemented workflows; live access and listing verification are unverified.',
    };
  }
  if (op) {
    op.argumentsSchema.properties.dry_run.description =
      'true validates and previews without provider calls. Read actions execute when false or omitted; writes require amcp_write review and execution.';
    op.amcp_discovery_contract = {
      actions: ['LIST_PLACE_ACTION_TYPE_METADATA', 'LIST_PLACE_ACTION_LINKS', 'GET_PLACE_ACTION_LINK'],
      guide: 'amcp://guides/dv360-and-measurement',
      location_selection:
        'Use a locations/{id} grant. location_id supplies the native metadata location filter when none is given. Global/region metadata does not establish location eligibility.',
      pagination:
        'Lists follow up to 25 native pages and 1000 rows, with explicit completeness and a scoped next_call. Provider scopes and AMCP grants are checked before and after each page.',
      qualification: 'Synthetic local fixtures; provider approval and live behavior remain unverified.',
    };
  }
  return tool;
}
