/**
 * The whole description of a tool, as an AI client reads it after tools/list: the listing carries a routing summary of
 * at most 2,000 characters (MCP-01) and amcp_tool_help {gateway} returns the rest, unchanged.
 */
export async function fullDescription(client, name) {
  const help = await client.callTool({name: 'amcp_tool_help', arguments: {gateway: name}});
  if (help.isError) throw Error('amcp_tool_help refused ' + name + ': ' + help.content[0].text);
  return help.structuredContent.data.description;
}
