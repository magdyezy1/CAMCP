import fs from 'node:fs';
import {createHash} from 'node:crypto';
const [directory,date]=process.argv.slice(2);
if(!directory||!/^\d{4}-\d{2}-\d{2}$/.test(date??''))throw Error('Usage: node tools/google-bid-field-evidence.mjs <public-reference-text-directory> <YYYY-MM-DD> [--campaign|--portfolio] [--check]');
const campaign=process.argv.includes('--campaign'),portfolio=process.argv.includes('--portfolio');if(campaign&&portfolio)throw Error('Select one native resource.');
const resource=portfolio?'bidding_strategy':campaign?'campaign_bid_modifier':'ad_group_bid_modifier',raw=fs.readFileSync(directory+'/'+resource+'.txt','utf8'),plain=raw.replaceAll('\r\n','\n').replace(/\bL\d+: ?/g,'\n'),fields={};
for(const m of plain.matchAll(new RegExp('(?:^|\\n)## '+resource+'\\.([a-z0-9_.]+)\\n([\\s\\S]*?)(?=\\n## |\\n\\[Button|\\nExcept|$)','g'))){
 const selectable=m[2].match(/Selectable (True|False)/),repeated=m[2].match(/Repeated (True|False)/);if(!selectable||!repeated)throw Error('Incomplete native field table: '+m[1]);fields[m[1]]={selectable:selectable[1]==='True',repeated:repeated[1]==='True'};
}
if(Object.keys(fields).length!==(portfolio?30:campaign?5:15))throw Error('Expected the complete v23 modifier/dependency field table.');
const output='tests/fixtures/google-'+(portfolio?'portfolio-':campaign?'campaign-':'')+'bid-fields-v23.json',text=JSON.stringify({api_version:'v23',source:'https://developers.google.com/google-ads/api/fields/v23/'+resource,checked_at:date,method:'Official public field table text retrieved with web tool; no live account query',source_text_sha256:createHash('sha256').update(raw).digest('hex'),fields},null,2)+'\n';
if(process.argv.includes('--check')){if(fs.readFileSync(output,'utf8')!==text)throw Error('Bid field evidence is stale.');}else fs.writeFileSync(output,text);
console.log(JSON.stringify({resource,fields:Object.keys(fields).length}));
