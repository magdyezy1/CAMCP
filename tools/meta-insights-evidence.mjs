import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Read only downloaded PUBLIC SDK sources. Runtime credentials are never used.
// Usage: node tools/meta-insights-evidence.mjs --source-dir <download-dir> [--check]
const directory=process.argv[process.argv.indexOf('--source-dir')+1];
if(!process.argv.includes('--source-dir')||!directory)throw Error('Supply --source-dir containing the pinned public SDK files.');
const base='https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/25.0.3/facebook_business/';
const sources={};
function source(name){
 const bytes=fs.readFileSync(path.join(directory,name+'.py'));
 sources[name]={url:base+'adobjects/'+name+'.py',sha256:createHash('sha256').update(bytes).digest('hex')};
 return bytes.toString('utf8');
}
function dictionary(text,name){
 const body=new RegExp('\\b'+name+' = \\{([\\s\\S]*?)\\n    +\\}').exec(text)?.[1];
 if(!body)throw Error('Missing SDK dictionary: '+name);
 const entries=body.split('\n').filter(s=>s.trim()).map(s=>{
  const m=/^\s*'([a-z_0-9]+)': '([^']+)',\s*$/.exec(s);if(!m)throw Error('Changed SDK dictionary syntax: '+s);return [m[1],m[2]];
 });
 if(!entries.length||new Set(entries.map(e=>e[0])).size!==entries.length)throw Error('Empty/duplicate SDK dictionary.');
 return Object.fromEntries(entries);
}
const models=Object.fromEntries(['adreportrun','adsinsights'].map(n=>[n,dictionary(source(n),'_field_types')]));
const creation={};
for(const name of ['adaccount','campaign','adset']){
 const text=source(name),method=text.split('    def get_insights_async(')[1]?.split(/\n    (?:def |_[a-z])/)[0];
 if(!method||!method.includes("method='POST'")||!method.includes("endpoint='/insights'")||!method.includes('target_class=AdReportRun'))throw Error('Changed asynchronous SDK route: '+name);
 creation[name]={method:'POST',edge:'/insights',result:'AdReportRun',parameters:dictionary(method,'param_types')};
}
const reportText=fs.readFileSync(path.join(directory,'adreportrun.py'),'utf8');
if(!reportText.includes("method='GET'")||!reportText.includes("endpoint='/insights'")||!reportText.includes('target_class=AdsInsights'))throw Error('Changed result route.');
const fixture={api_version:'v25.0',sdk_tag:'25.0.3',checked_at:'2026-09-20',method:'Deterministic extraction from the pinned official public Python SDK; schema evidence, not live provider acceptance.',sources,creation,models};
const output='tests/fixtures/meta-insights-sdk-v25.json',serialized=JSON.stringify(fixture,null,2)+'\n';
if(process.argv.includes('--check')){if(fs.readFileSync(output,'utf8')!==serialized)throw Error('Meta Insights SDK evidence differs.');}
else fs.writeFileSync(output,serialized);
console.log('Verified 3 async creation edges, 2 response models and 5 pinned public SDK source hashes.');
