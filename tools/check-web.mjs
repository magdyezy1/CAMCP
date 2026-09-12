import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=fs.readdirSync('web',{recursive:true}).filter(f=>f.endsWith('.js')).sort();
for(const file of files){const result=spawnSync(process.execPath,['--check','web/'+file],{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);}
console.log('Checked every shipped browser script: '+files.length);
