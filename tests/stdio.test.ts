import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {removeTestDirectory} from './temp.js';
test('standalone stdio process initializes, serves metadata and compiles a preview without credentials',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whathead-stdio-'));
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/server/stdio.js')],cwd:process.cwd(),env:{...getDefaultEnvironment(),MIRROR_DB:path.join(directory,'test.sqlite'),MIRROR_TENANT_ID:'stdio-test',MIRROR_MASTER_KEY:'',MIRROR_ALLOW_WRITES:'false',MIRROR_MODE:'strict',MIRROR_FLAGS:'{}'},stderr:'pipe'});
 const client=new Client({name:'stdio-integration',version:'1'});
 try{await client.connect(transport);assert.equal((await client.listTools()).tools.length,20);
  const result=await client.callTool({name:'google_ads_native_action',arguments:{action:'CREATE_CAMPAIGN',account_id:'111',payload:{resource:{name:'Draft',advertising_channel_type:'SEARCH',campaign_budget:'customers/111/campaignBudgets/222'}},dry_run:true}});
  const data=JSON.parse((result.content as any)[0].text);assert.equal(data.success,true);assert.equal(data.data.executed,false);assert.equal(data.data.request.method,'POST');
 }finally{await client.close();removeTestDirectory(directory,'whathead-stdio-');}
});
