import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {MirrorError} from '../src/errors.js';
import {prepareReadProbes,verifyReads} from '../src/read-verification.js';
const args=process.argv.slice(2),live=args.includes('--live'),file=args.find(a=>!a.startsWith('--'));
let store:Store|undefined;
try{
 if(!file||args.some(a=>a.startsWith('--')&&a!=='--live')||args.filter(a=>!a.startsWith('--')).length!==1)throw new MirrorError('USAGE','Usage: npm run verify:reads -- <probe-file.json> [--live]. Default is local preview without credentials.');
 if(fs.statSync(file).size>1024*1024)throw new MirrorError('INVALID_PROBES','Probe files must be no larger than 1 MiB.');
 const probes=JSON.parse(fs.readFileSync(file,'utf8'));
 store=new Store(live?(process.env.MIRROR_DB??'.runtime/mirror.sqlite'):':memory:',live?process.env.MIRROR_MASTER_KEY:undefined);
 const service=new MirrorService(new Registry(),store),prepared=prepareReadProbes(service,probes);
 const result=await verifyReads(service,prepared,{tenantId:process.env.MIRROR_TENANT_ID??'local',userId:'read-verifier',role:'reader'},live);
 process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.success)process.exitCode=1;
}catch(e){process.stderr.write(JSON.stringify({success:false,error:e instanceof MirrorError?{code:e.code,message:e.message}:{code:'VERIFICATION_SETUP_FAILED',message:'Could not load or prepare the read probes.'}})+'\n');process.exitCode=1;}finally{store?.close();}
