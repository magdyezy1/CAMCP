import fs from 'node:fs';
import {createHash} from 'node:crypto';
const [file,date]=process.argv.slice(2);
if(!file||!/^\d{4}-\d{2}-\d{2}$/.test(date??''))throw Error('Usage: node tools/google-bidding-event-field-evidence.mjs <public-reference-text> <YYYY-MM-DD> [--check]');
const raw=fs.readFileSync(file,'utf8'),plain=raw.replaceAll('\r\n','\n').replace(/^L\d+: ?/gm,''),resources={};
for(const [resource,count]of [['bidding_seasonality_adjustment',12],['bidding_data_exclusion',11]]){
 const fields={};for(const match of plain.matchAll(new RegExp('(?:^|\\n)## '+resource+'\\.([a-z0-9_.]+)\\n([\\s\\S]*?)(?=\\n## |\\n\\[Button|\\nExcept|$)','g'))){
  const selectable=match[2].match(/Selectable (True|False)/),repeated=match[2].match(/Repeated (True|False)/);if(!selectable||!repeated||Object.hasOwn(fields,match[1]))throw Error('Incomplete or duplicated official field: '+resource+'.'+match[1]);fields[match[1]]={selectable:selectable[1]==='True',repeated:repeated[1]==='True'};
 }
 if(Object.keys(fields).length!==count)throw Error('Expected every official v23 field of '+resource);resources[resource]={source:'https://developers.google.com/google-ads/api/fields/v23/'+resource,checked_at:date,method:'Public field heading/table extraction through the web tool; not a live account query',source_text_sha256:createHash('sha256').update(raw).digest('hex'),fields};
}
const output='tests/fixtures/google-bidding-event-fields-v23.json',text=JSON.stringify({api_version:'v23',resources},null,2)+'\n';
if(process.argv.includes('--check')){if(fs.readFileSync(output,'utf8')!==text)throw Error('Bidding-event field evidence changed.');}else fs.writeFileSync(output,text);
console.log(JSON.stringify({resources:2,fields:23}));
