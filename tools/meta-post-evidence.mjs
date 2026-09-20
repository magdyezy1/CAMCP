import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
// Offline extraction only; callers obtain these PUBLIC pinned SDK files first.
const directory=process.argv[process.argv.indexOf('--source-dir')+1];
if(!process.argv.includes('--source-dir')||!directory)throw Error('Supply --source-dir with the five pinned public SDK files.');
const base='https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/25.0.3/facebook_business/adobjects/',sources={},text={};
for(const name of ['page','pagepost','iguser','igmedia','adaccount']){const bytes=fs.readFileSync(path.join(directory,name+'.py'));text[name]=bytes.toString('utf8');sources[name]={url:base+name+'.py',sha256:createHash('sha256').update(bytes).digest('hex')};}
const routes={};
for(const [name,method,edge]of [['page','get_posts','/posts'],['iguser','get_media','/media'],['adaccount','get_promote_pages','/promote_pages'],['adaccount','get_instagram_accounts','/instagram_accounts']]){
 const block=text[name].split('    def '+method+'(')[1]?.split(/\n    (?:def |_[a-z])/)[0];
 if(!block?.includes("method='GET'")||!block.includes("endpoint='"+edge+"'"))throw Error('Pinned SDK route changed: '+name+'.'+method);
 routes[name+'.'+method]={method:'GET',edge};
}
const fields={};
for(const name of ['pagepost','igmedia']){const block=/_field_types = \{([\s\S]*?)\n    \}/.exec(text[name])?.[1];if(!block)throw Error('Missing response field model: '+name);fields[name]=Object.fromEntries([...block.matchAll(/'([a-z_0-9]+)': '([^']+)'/g)].map(m=>[m[1],m[2]]));if(!fields[name].id)throw Error('Empty response field model.');}
const fixture={api_version:'v25.0',sdk_tag:'25.0.3',checked_at:'2026-09-20',meaning:'Official SDK schemas and read edges only; permissions, content eligibility and live responses require provider qualification.',sources,routes,fields},output='tests/fixtures/meta-post-sdk-v25.json',serialized=JSON.stringify(fixture,null,2)+'\n';
if(process.argv.includes('--check')){if(fs.readFileSync(output,'utf8')!==serialized)throw Error('Meta post SDK evidence differs.');}else fs.writeFileSync(output,serialized);
console.log('Verified 4 fixed read edges, 2 content field models and 5 pinned source hashes.');
