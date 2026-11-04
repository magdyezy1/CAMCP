// Measures what the MCP surface costs an AI client (MCP-01): tools/list bytes and description lengths, and the size of
// capabilities, dashboard, help and the campaign prompt, on synthetic in-memory fixtures. No provider is reached: the
// transport refuses every request. Usage: npm run build && node tools/measure-tool-list.mjs
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const writes = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
const providers = [
  ['meta_native_action', ['1001', '1002', '1003', '1004']],
  ['google_ads_native_action', ['2001', '2002', '2003', '2004']],
  ['tiktok_native_action', ['3001', '3002', '3003']],
  ['snapchat_native_action', ['4001', '4002', '4003']],
  ['linkedin_native_action', ['5001', '5002', '5003']],
  ['x_ads_native_action', ['6001', '6002', '6003']],
];
/** One synthetic Meta connection, or six providers with 20 accounts, readiness checks and many verified writes. */
export function surfaceFixture({large = false, allowWrites = true} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64')),
    actor = {tenantId: 'measure', userId: 'owner', role: 'admin'},
    requests = [];
  const transport = new NativeTransport(async request => {
    requests.push(String(request?.url ?? request));
    throw Error('Synthetic measurement makes no provider request.');
  });
  store.ensureTenant(actor.tenantId);
  const list = large ? providers : [['meta_native_action', ['1001']]];
  list.forEach(([gateway, accounts], i) =>
    store.putConnection(
      actor,
      {
        id: 'c' + i,
        tenantId: actor.tenantId,
        gateway,
        accounts,
        writeAccounts: accounts.slice(0, 2),
        enabled: true,
        label: 'Synthetic ' + gateway,
        scopes: [],
      },
      {accessToken: 'synthetic-' + i},
    ),
  );
  if (large) {
    let n = 0;
    list.forEach(([, accounts], i) =>
      accounts.forEach(account => {
        store.putDocument(actor.tenantId, 'readiness', 'r' + i + account, {
          connection_id: 'c' + i,
          account_id: account,
          checked_at: Date.now(),
          requirements: {write: true},
          checks: [{key: 'connection', status: 'passed', message: 'Connection enabled.'}],
          ready: false,
          blocked: true,
          live_read: false,
        });
        for (let k = 0; k < 7; k++)
          store.putDocument(actor.tenantId, 'write_verification', 'w' + n++, {
            review_id: 'w' + n,
            connection_id: 'c' + i,
            account_id: account,
            action: 'synthetic_campaign_update',
            status: k % 3 ? 'verified' : 'inconclusive',
            checks: [{field: 'status', status: 'verified', expected_hash: 'a'.repeat(64), actual_hash: 'a'.repeat(64)}],
            checked_at: Date.now() - k * 1000,
          });
      }),
    );
  }
  const service = new MirrorService(new Registry(), store, transport, undefined, allowWrites ? writes : undefined);
  return {store, actor, service, requests, close: () => store.close()};
}
const size = value => Buffer.byteLength(JSON.stringify(value));
/** Keys that describe a whole gateway or the whole surface, so repeating them on operation help is boilerplate. */
export const gatewayLevelHelpKeys = [
  'see',
  'amcp_contract',
  'amcp_action_contracts',
  'amcp_guidance',
  'amcp_extensions',
  'amcp_media_import',
];
async function client(service, actor) {
  const server = createMcpServer(service, actor),
    c = new Client({name: 'amcp-surface-measure', version: '1'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), c.connect(a)]);
  return {
    client: c,
    close: async () => {
      await c.close();
      await server.close();
    },
  };
}
/** Every measurement, as plain numbers. */
export async function measureSurface() {
  const out = {tools_list: {}, capabilities: {}, dashboard: {}, help: {}, prompt: {}};
  for (const mode of ['reader', 'operator']) {
    const f = surfaceFixture({allowWrites: mode === 'operator'}),
      c = await client(f.service, f.actor);
    try {
      const listed = await c.client.listTools();
      out.tools_list[mode] = {
        bytes: size(listed),
        tools: listed.tools.length,
        descriptions: Object.fromEntries(listed.tools.map(t => [t.name, t.description.length])),
      };
    } finally {
      await c.close();
      f.close();
    }
  }
  for (const large of [false, true]) {
    const f = surfaceFixture({large}),
      c = await client(f.service, f.actor),
      key = large ? 'six_providers_20_accounts' : 'one_connection';
    try {
      const call = async args => (await c.client.callTool({name: 'amcp_workspace', arguments: args})).structuredContent;
      let page = await call({action: 'capabilities'}),
        pages = 1,
        largest = size(page);
      const first = size(page);
      while (page.data?.next_cursor) {
        page = await call({action: 'capabilities', cursor: page.data.next_cursor});
        pages++;
        largest = Math.max(largest, size(page));
      }
      out.capabilities[key] = {
        summary_first_page: first,
        summary_largest_page: largest,
        summary_pages: pages,
        graph: size(await call({action: 'capabilities', view: 'graph'})),
      };
      const dashboard = await call({action: 'dashboard'});
      out.dashboard[key] = {
        summary: JSON.stringify(dashboard).length,
        full: JSON.stringify(await call({action: 'dashboard', view: 'full'})).length,
        verified_writes_page: JSON.stringify(await call({action: 'dashboard', sections: ['verified_writes']})).length,
      };
      if (!large) {
        const help = async args =>
            (await c.client.callTool({name: 'amcp_tool_help', arguments: args})).structuredContent,
          tools = (await c.client.listTools()).tools.map(t => t.name);
        out.help.root = size(await help({}));
        out.help.gateways = {};
        for (const gateway of tools) out.help.gateways[gateway] = size(await help({gateway}));
        const operations = [
          ['meta_native_action', 'meta_ad_account_id_campaigns_get'],
          ['google_ads_native_action', 'google_ads_v23_google_ads_search'],
          ['tiktok_native_action', 'tiktok_ad_get'],
          ['snapchat_native_action', 'snapchat_get_campaigns'],
          ['linkedin_native_action', 'linkedin_rest_ad_accounts_get'],
          ['amcp_workspace', 'capabilities'],
        ];
        out.help.operations = {};
        let total = 0,
          repeated = 0;
        for (const [gateway, operation] of operations) {
          const result = await help({gateway, operation}),
            data = result.data ?? result;
          out.help.operations[gateway + '/' + operation] = size(result);
          total += size(result);
          for (const key of gatewayLevelHelpKeys) if (data[key] !== undefined) repeated += size({[key]: data[key]});
        }
        out.help.operation_boilerplate_share = Number((repeated / total).toFixed(4));
        for (const platform of ['meta', 'google', 'tiktok', 'snapchat', 'linkedin', 'x', 'reddit', 'microsoft']) {
          const prompt = await c.client.getPrompt({
            name: 'amcp_build_campaign',
            arguments: {platform, request: 'A paused launch with an image ad and a daily budget'},
          });
          out.prompt[platform] = prompt.messages[0].content.text.length;
        }
      }
      out.provider_requests = (out.provider_requests ?? 0) + f.requests.length;
    } finally {
      await c.close();
      f.close();
    }
  }
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await measureSurface(), null, 2));
