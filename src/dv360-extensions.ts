import type {ToolDefinition} from './types.js';

/** Keep the captured schema immutable. Connection selection is an AMCP control,
 * never a field in a Google request or a replacement for advertiserId. */
export function extendDV360Tool(original:ToolDefinition):ToolDefinition{
 const tool=structuredClone(original);
 tool.inputSchema.properties.connection_id={type:'string',format:'uuid',description:'AMCP connection to use for this request. Select explicitly when more than one identity can access the advertiser. Never sent to Google.'};
 return tool;
}
