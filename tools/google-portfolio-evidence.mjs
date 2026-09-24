import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
// Offline extraction from explicitly supplied public Google v23 source files.
const directory=process.argv[process.argv.indexOf('--source-dir')+1];
if(!process.argv.includes('--source-dir')||!directory)throw Error('Supply --source-dir containing the seven public v23 portfolio protos.');
const names=['resources/bidding_strategy','services/bidding_strategy_service','common/bidding','enums/bidding_strategy_status','enums/bidding_strategy_type','enums/target_impression_share_location','errors/bidding_strategy_error'];
const sources={},content={};
for(const name of names){const bytes=fs.readFileSync(path.join(directory,name.replace('/','_')+'.proto'));content[name]=bytes.toString('utf8');sources[name]={url:'https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/'+name+'.proto',sha256:createHash('sha256').update(bytes).digest('hex')};}
function message(text,name){const start=text.indexOf('message '+name+' {');if(start<0)throw Error('Native message disappeared: '+name);const begin=text.indexOf('{',start);let depth=1,end=begin;while(depth&&++end<text.length){if(text[end]==='{')depth++;if(text[end]==='}')depth--;}if(depth)throw Error('Unclosed proto message');return text.slice(begin+1,end);}
const fields={};for(const name of ['TargetCpa','TargetRoas','MaximizeConversions','MaximizeConversionValue','TargetImpressionShare','TargetSpend'])fields[name]=[...message(content['common/bidding'],name).matchAll(/^\s+(?:optional\s+)?[\w.]+\s+([a-z_]+)\s*=\s*\d+/gm)].map(m=>m[1]).sort();
const enums={};for(const name of ['bidding_strategy_status','bidding_strategy_type','target_impression_share_location','bidding_strategy_error']){const file=(name==='bidding_strategy_error'?'errors/':'enums/')+name;enums[name]=Object.fromEntries([...content[file].matchAll(/^\s+([A-Z_]+) = (\d+);/gm)].map(m=>[m[1],Number(m[2])]));if(Object.keys(enums[name]).length<4)throw Error('Changed native enum: '+name);}
const native=message(content['resources/bidding_strategy'],'BiddingStrategy'),resourcePattern=/pattern: "([^"]+)"/.exec(native)?.[1],route='/v23/customers/{customer_id=*}/biddingStrategies:mutate';
if(resourcePattern!=='customers/{customer_id}/biddingStrategies/{bidding_strategy_id}'||!content['services/bidding_strategy_service'].includes(route)||!content['services/bidding_strategy_service'].includes('repeated BiddingStrategyOperation operations = 2')||!content['services/bidding_strategy_service'].includes('repeated MutateBiddingStrategyResult results = 2;'))throw Error('The native portfolio resource or operation/result contract changed.');
const resourceFields=[...native.matchAll(/^\s+(?:optional\s+)?[\w.]+\s+([a-z_]+)\s*=\s*\d+/gm)].map(m=>m[1]).sort();
const fixture={version:'v23',checked_at:'2026-09-24',meaning:'Public source-hashed protocol evidence; not live eligibility or permission.',sources,resourcePattern,route,resourceFields,fields,enums};
const output='tests/fixtures/google-portfolio-v23.json',text=JSON.stringify(fixture,null,2)+'\n';
if(process.argv.includes('--check')){if(fs.readFileSync(output,'utf8')!==text)throw Error('Portfolio evidence differs from pinned fixture.');}else fs.writeFileSync(output,text);
console.log('Verified portfolio native resource, mutation service, six schemes, four enums and seven public source hashes.');
