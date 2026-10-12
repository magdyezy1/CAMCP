// Temporary local measurement (not committed): bytes of tools/list in a writes deployment, per tool.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createMcpServer} from '../dist/server/mcp.js';
const store = new Store(':memory:');
const service = new MirrorService(new Registry(), store, undefined, undefined, {
  allowWrites: true,
  maxBudgetChange: 0,
  requireBeforeState: true,
});
const server = createMcpServer(service, {tenantId: 't', userId: 'u', role: 'operator'}),
  client = new Client({name: 'measure', version: '1'}),
  [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
const listed = await client.listTools();
const total = Buffer.byteLength(JSON.stringify(listed));
console.log(JSON.stringify({total, limit: 95 * 1024, slack: 95 * 1024 - total}));
for (const t of listed.tools.filter(t => t.name.startsWith('amcp_reporting')))
  console.log(t.name, Buffer.byteLength(JSON.stringify(t)), t.description.length);
await client.close();
await server.close();
store.close();
