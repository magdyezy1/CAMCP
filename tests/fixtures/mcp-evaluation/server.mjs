// The fixture-backed MCP server for the mcp-builder skill's LLM evaluation runner (QA-04): the synthetic evaluation
// workspace (workspace.mjs) served over stdio, as `npm start` serves a real one. The runner launches it:
//   python <skill>/scripts/evaluation.py -t stdio -c node -a tests/fixtures/mcp-evaluation/server.mjs ... evaluation.xml
// It needs a built dist (npm run build) and nothing else: no database file, key, credential or network. Every provider
// is a synthetic fake, the global fetch is refused, and the workspace serves a reader, so a session can change nothing.
// The store is in memory and discarded when the runner closes the process. Logs go to stderr; stdout is the protocol.
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createMcpServer} from '../../../dist/server/mcp.js';
import {evaluationWorkspace} from './workspace.mjs';

globalThis.fetch = async () => {
  throw new TypeError('The MCP evaluation fixture refuses egress');
};
const workspace = await evaluationWorkspace(),
  server = createMcpServer(workspace.service, workspace.actor);
await server.connect(new StdioServerTransport());
const stop = () =>
  void server.close().finally(() => {
    workspace.close();
    process.exit(0);
  });
process.on('SIGTERM', stop);
process.stdin.on('end', stop);
