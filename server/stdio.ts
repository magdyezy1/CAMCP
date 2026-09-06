import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createMcpServer} from './mcp.js';
import {createRuntime} from './runtime.js';
const {store,service}=createRuntime();
const tenantId=process.env.MIRROR_TENANT_ID??'local';store.ensureTenant(tenantId);
const actor={tenantId,userId:process.env.MIRROR_USER_ID??'local-operator',role:'reader' as const};
const server=createMcpServer(service,actor);
await server.connect(new StdioServerTransport());
process.on('SIGTERM',()=>{void server.close().finally(()=>{store.close();process.exit(0);});});
