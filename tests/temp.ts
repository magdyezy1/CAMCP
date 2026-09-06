import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function removeTestDirectory(directory:string,prefix:string){
 const root=fs.realpathSync(os.tmpdir()),resolved=fs.realpathSync(directory);
 if(path.dirname(resolved)!==root||!path.basename(resolved).startsWith(prefix)||!prefix.startsWith('whathead-'))throw Error('Refusing to remove a path outside the named temporary test directory.');
 fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
