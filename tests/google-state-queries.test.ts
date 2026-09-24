import test from 'node:test';
import assert from 'node:assert/strict';
import {readGoogleBiddingEventState} from '../src/google-bidding-events.js';
import {readGooglePortfolioState} from '../src/google-portfolio-strategies.js';
import type {CompiledRequest,JsonObject} from '../src/types.js';

// Official v23 fields pages mark these RESOURCE_NAME fields non-sortable.
// A permissive fixture used to accept invalid GAQL and conceal this defect.
for(const collection of ['biddingSeasonalityAdjustments','biddingDataExclusions','biddingStrategies'])test('native GAQL sortability permits complete '+collection+' review',async()=>{
 const isPortfolio=collection==='biddingStrategies',create:JsonObject=isPortfolio?{name:'Portfolio',targetCpa:{targetCpaMicros:'15000000'}}:{name:'Event',scope:'CHANNEL',advertisingChannelTypes:['SEARCH'],startDateTime:collection==='biddingDataExclusions'?'2020-01-01 00:00:00':'2098-12-01 00:00:00',endDateTime:collection==='biddingDataExclusions'?'2020-01-03 00:00:00':'2098-12-03 00:00:00',...(collection==='biddingSeasonalityAdjustments'?{conversionRateModifier:1.5}:{})};
 const plan={gateway:'google_ads_native_action',action:'synthetic',accountId:'123',method:'POST',path:'/v23/customers/123/'+collection+':mutate',body:{operations:[{create}]},query:{},headers:{},readOnly:false,destructive:false,requiresConfirmation:true} as CompiledRequest;
 let reads=0;const result=await (isPortfolio?readGooglePortfolioState:readGoogleBiddingEventState)(plan,async read=>{
  reads++;const q=String((read.body as JsonObject).query);
  if(/ORDER BY [a-z_]+\.resource_name/.test(q))return {status:400,headers:{},data:{error:{code:400,message:'Field is not sortable',details:[{errors:[{errorCode:{queryError:'PROHIBITED_FIELD_IN_ORDER_BY_CLAUSE'}}]}]}}};
  return {status:200,headers:{},data:/FROM customer(?: |$)/.test(q)?{results:[{customer:{id:'123',currencyCode:'EGP',timeZone:'Africa/Cairo'}}]}:{}};
 });assert.equal(result.length,1);assert.ok(reads>=4);
});
