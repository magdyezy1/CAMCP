import {setTimeout as delay} from 'node:timers/promises';
import {createRuntime} from './runtime.js';
import {ReportWorker} from '../src/worker.js';
import {createReportExecutor} from '../src/report-executor.js';
const {service,store}=createRuntime();
const worker=new ReportWorker(store,createReportExecutor(service));
let running=true;process.on('SIGTERM',()=>{running=false;});process.on('SIGINT',()=>{running=false;});
try{do{const worked=await worker.once();if(process.argv.includes('--once'))break;if(!worked)await delay(1000);}while(running);}finally{store.close();}
