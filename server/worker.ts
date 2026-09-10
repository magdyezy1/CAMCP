import {ReportingOverview} from '../src/reporting-overview.js';
import {WebStore} from './web-store.js';
import {UserAccounts} from './user-accounts.js';
import {setTimeout as delay} from 'node:timers/promises';
import {createRuntime} from './runtime.js';
import {ReportWorker} from '../src/worker.js';
import {createReportExecutor} from '../src/report-executor.js';
const {service,store}=createRuntime();
const overview=new ReportingOverview(service),accounts=new UserAccounts(new WebStore(store,{origin:process.env.AMCP_PUBLIC_ORIGIN??'http://127.0.0.1:4317',masterKey:process.env.MIRROR_MASTER_KEY,tenantId:process.env.AMCP_TENANT_ID}));
const worker=new ReportWorker(store,createReportExecutor(service),(t,k,i)=>overview.work(t,k,i));
let running=true;process.on('SIGTERM',()=>{running=false;});process.on('SIGINT',()=>{running=false;});
try{do{overview.tick();await accounts.deliverEmails();const worked=await worker.once();if(process.argv.includes('--once'))break;if(!worked)await delay(1000);}while(running);}finally{store.close();}
