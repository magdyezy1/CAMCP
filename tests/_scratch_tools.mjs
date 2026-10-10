import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
const identity = {tenantId: 't', userId: 'u', role: 'operator'};
const key = store.createKey(identity),
  actor = store.authenticate(key);
const service = new MirrorService(
  new Registry(),
  store,
  new NativeTransport(async () => {
    throw Error('x');
  }),
  undefined,
  {allowWrites: true, requireBeforeState: true},
);
const server = createMcpServer(service, actor),
  client = new Client({name: 'x', version: '1'});
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
const tools = (await client.listTools()).tools;
for (const t of tools)
  console.log(
    t.name,
    Buffer.byteLength(JSON.stringify(t)),
    (t.description || '').length,
    JSON.stringify(t.inputSchema.properties?.action?.enum ?? null).slice(0, 900),
  );
console.log('instructions', (client.getInstructions() ?? '').length);
for (const arg of process.argv.slice(2)) {
  const help = await client.callTool({name: 'amcp_tool_help', arguments: JSON.parse(arg)});
  console.log(JSON.stringify(help.structuredContent).slice(0, 3000));
}
await client.close();
await server.close();
store.close();
