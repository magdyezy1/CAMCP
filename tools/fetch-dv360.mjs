import fs from 'node:fs';
const url='https://displayvideo.googleapis.com/$discovery/rest?version=v4';
const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('Discovery HTTP '+response.status);
const doc=await response.json();
if(doc.name!=='displayvideo'||doc.version!=='v4')throw Error('Unexpected discovery identity');
fs.mkdirSync('.mirror/VENDOR',{recursive:true});
fs.writeFileSync('.mirror/VENDOR/dv360-v4.json',JSON.stringify({source:url,captured_at:new Date().toISOString(),evidence:'VENDOR_DOCUMENTED_NOT_AMCP_OBSERVED',document:doc},null,2)+'\n');
console.log('Saved official DV360 v4 discovery metadata; '+Object.keys(doc.resources).length+' root resources.');
