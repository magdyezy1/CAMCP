import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/**
 * Windows briefly keeps a handle on a just-closed SQLite file (indexer, antivirus, lazy close),
 * so removal can return EPERM/EBUSY well after every database was closed. Retry longer than
 * fs.rmSync's own backoff, and never fail an assertion that already passed because an
 * operating-system temporary directory outlived the test; the OS reclaims it either way.
 */
export function removeTestDirectory(directory:string,prefix:string){
 const root=fs.realpathSync(os.tmpdir()),resolved=fs.realpathSync(directory);
 if(path.dirname(resolved)!==root||!path.basename(resolved).startsWith(prefix)||!prefix.startsWith('amcp-'))throw Error('Refusing to remove a path outside the named temporary test directory.');
 try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
 catch(e){if(fs.existsSync(resolved))process.emitWarning('Left temporary test directory '+resolved+' in place: '+(e as Error).message);}
}
