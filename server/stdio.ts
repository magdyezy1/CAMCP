import {StdioServerTransport, serveStdio} from '@modelcontextprotocol/server/stdio';
import {createMcpServer} from './mcp.js';
import {createRuntime} from './runtime.js';
import {loadConfig} from './config.js';
import type {Actor} from '../src/types.js';
const role = process.env.MIRROR_ROLE ?? (process.env.MIRROR_ALLOW_WRITES === 'true' ? 'operator' : 'reader');
if (role !== 'reader' && role !== 'operator') throw new Error('MIRROR_ROLE must be reader or operator.');
if (role === 'operator' && process.env.MIRROR_ALLOW_WRITES !== 'true')
  throw new Error('Stdio operator access requires MIRROR_ALLOW_WRITES=true.');
const config = loadConfig(process.env, 'stdio');
const {store, service} = createRuntime(config);
const tenantId = process.env.MIRROR_TENANT_ID ?? 'local';
store.ensureTenant(tenantId);
const actor: Actor = {tenantId, userId: process.env.MIRROR_USER_ID ?? 'local-operator', role};
// AMCP_MCP_MODERN_PROTOCOL governs the 2026-07-28 revision here as it does over HTTP (MCP-03 phase 3): `off` (the
// default, and the rollback) serves the earlier revisions only, through the plain transport; `next` and `on` also
// serve the modern revision, the connection's first message choosing the era. Stdio has no /mcp/next to hold `next`
// back, so the two are the same here.
const server =
  config.mcpModernProtocol === 'off'
    ? await (async () => {
        const plain = createMcpServer(service, actor);
        await plain.connect(new StdioServerTransport());
        return plain;
      })()
    : serveStdio(context => createMcpServer(service, actor, {era: context.era}));
process.on('SIGTERM', () => {
  void server.close().finally(() => {
    store.close();
    process.exit(0);
  });
});
