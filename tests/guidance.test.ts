import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../server/mcp.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {readGuidance,buildCampaignPrompt,guidanceResources} from '../src/guidance.js';

test('MCP clients discover, read and load curated campaign guides without provider calls',async()=>{
 const store=new Store(':memory:'),server=createMcpServer(new MirrorService(new Registry(),store),{tenantId:'t',userId:'u',role:'reader'}),client=new Client({name:'guide-test',version:'1'}),[c,s]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(s);await client.connect(c);const list=await client.listResources();assert.equal(list.resources.length,8);
  for(const resource of list.resources){const result=await client.readResource({uri:resource.uri}),content=result.contents[0]!;assert.ok('text' in content&&content.text.length>500);}
  assert.equal((await client.listPrompts()).prompts[0]!.name,'amcp_build_campaign');
  const prompt=await client.getPrompt({name:'amcp_build_campaign',arguments:{platform:'microsoft',request:'Build a paused search campaign'}});assert.ok(JSON.stringify(prompt).includes('DailyBudget'));assert.ok(JSON.stringify(prompt).includes('Build a paused search campaign'));
  const help=await client.callTool({name:'whathead_tool_help',arguments:{}});assert.ok(JSON.stringify(help).includes('amcp://guides/index'));
  assert.throws(()=>readGuidance('amcp://guides/../../.env'));assert.throws(()=>readGuidance('file:///etc/passwd'));assert.throws(()=>buildCampaignPrompt({platform:'unsupported'}));
 }finally{await client.close();await server.close();store.close();}
});

test('guide references are complete and distinguish unsupported execution from metadata',()=>{
 for(const {uri}of guidanceResources){const text=readGuidance(uri).text;for(const match of text.matchAll(/\]\((?:references\/)?([a-z-]+)\.md\)/g))assert.ok(guidanceResources.some(r=>r.name===match[1]),match[1]);}
 const reddit=readGuidance('amcp://guides/reddit').text;assert.ok(reddit.includes('CREATE_SAVED_AUDIENCE'));assert.ok(reddit.includes('Reddit Drive/media import, Reddit Max, post publishing and customer-list ingestion remain unqualified'));
 assert.ok(readGuidance('amcp://guides/google-ads').text.includes('negative campaign keyword'));
});
