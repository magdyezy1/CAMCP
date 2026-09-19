import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import type {Server} from 'node:http';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {createHttpApp} from '../server/http-app.js';

const {checkApplication}=await import(pathToFileURL(resolve('deploy/smoke-api.mjs')).href);
for(const writes of [false,true])test(`deployment HTTP contract includes reporting and survives restart (writes=${writes})`,async()=>{
 const directory=mkdtempSync(join(tmpdir(),'amcp-deployment-smoke-')),database=join(directory,'mirror.sqlite');
 const master=randomBytes(32).toString('base64'),password=randomBytes(24).toString('base64url'),origin='https://amcp.shop';
 let store:Store|undefined,listener:Server|undefined,port=0,egress=0;
 const start=async()=>{
  store=new Store(database,master);
  const transport=new NativeTransport(async()=>{egress++;throw Error('Deployment smoke must not contact a vendor.');});
  const service=new MirrorService(new Registry(),store,transport,undefined,{allowWrites:writes,maxBudgetChange:0,requireBeforeState:true});
  const app=createHttpApp(service,store,{publicOrigin:origin,website:{origin,masterKey:master,adminPassword:password,authEnv:{}}});
  listener=await listenForFetch(app,{port});
  port=(listener.address() as {port:number}).port;
 };
 const stop=async()=>{
  if(listener){const closing=listener;listener=undefined;await new Promise<void>((resolve,reject)=>{closing.close(error=>error?reject(error):resolve());closing.closeAllConnections();});}
  store?.close();store=undefined;
 };
 try{
  await start();
  await checkApplication({base:'http://127.0.0.1:'+port,origin,password,writes,restart:async()=>{await stop();await start();}});
  assert.equal(egress,0);
 }finally{
  await stop();
  // Remove only this test's freshly created temporary directory.
  const target=resolve(directory),parent=resolve(tmpdir());
  if(!target.startsWith(parent+sep)||!target.startsWith(join(parent,'amcp-deployment-smoke-')))throw Error('Unexpected smoke temporary path');
  rmSync(target,{recursive:true,force:true});
 }
});
