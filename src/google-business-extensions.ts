import type {ToolDefinition} from './types.js';

/** Maintained runtime guidance overrides, without rewriting the captured schema
 * or advertising unimplemented operations as executable. */
export function extendGoogleBusinessTool(original:ToolDefinition):ToolDefinition{
 const tool=structuredClone(original),op=tool.operations?.find(o=>o.operation==='gmb_engagement_ops');
 if(op){
  op.argumentsSchema.properties.dry_run.description='true validates and previews without provider calls. Read actions execute when false or omitted; writes require amcp_write review and execution.';
  op.amcp_discovery_contract={actions:['LIST_PLACE_ACTION_TYPE_METADATA','LIST_PLACE_ACTION_LINKS','GET_PLACE_ACTION_LINK'],guide:'amcp://guides/dv360-and-measurement',location_selection:'Use a locations/{id} grant. location_id supplies the native metadata location filter when none is given. Global/region metadata does not establish location eligibility.',pagination:'Lists follow up to 25 native pages and 1000 rows, with explicit completeness and a scoped next_call. Provider scopes and AMCP grants are checked before and after each page.',qualification:'Synthetic local fixtures; provider approval and live behavior remain unverified.'};
 }
 return tool;
}
