import {createServer,type RequestListener,type Server} from 'node:http';

// The OS ephemeral range can include ports forbidden by Fetch, even on loopback.
// Source: https://fetch.spec.whatwg.org/#port-blocking (checked 2026-09-19).
const blockedPorts=new Set([0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);
type Options={port?:number;create?:(handler:RequestListener)=>Server};
const close=(server:Server)=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));

/** Test-only loopback server. Retry port allocation, never a request or assertion. */
export async function listenForFetch(handler:RequestListener,{port=0,create=createServer}:Options={}):Promise<Server>{
 if(!Number.isInteger(port)||port<0||port>65535||(port!==0&&blockedPorts.has(port)))throw Error('The requested test port is not Fetch-compatible');
 const rejected:number[]=[];
 for(let attempt=0;attempt<10;attempt++){
  const server=create(handler);
  await new Promise<void>((resolve,reject)=>{
   const onListening=()=>{server.off('error',onError);resolve();};
   const onError=(error:Error)=>{server.off('listening',onListening);reject(error);};
   server.once('listening',onListening);server.once('error',onError);
   try{server.listen(port,'127.0.0.1');}catch(error){server.off('listening',onListening);server.off('error',onError);reject(error);}
  });
  const address=server.address();
  if(address&&typeof address==='object'&&!blockedPorts.has(address.port))return server;
  if(address&&typeof address==='object')rejected.push(address.port);
  await close(server);
 }
 throw Error('No Fetch-compatible ephemeral port after 10 allocations: '+rejected.join(', '));
}
