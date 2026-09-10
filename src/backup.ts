import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

const magic=Buffer.from('AMCP-BACKUP-1\n');
function backupKey(key:string|undefined){const bytes=Buffer.from(key??'','base64');if(bytes.length!==32)throw new MirrorError('ENCRYPTION_REQUIRED','Set the 32-byte MIRROR_MASTER_KEY before creating or verifying backups.');return bytes;}
function temporary(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amcp-backup-'));return {file:path.join(dir,'snapshot.sqlite'),clean(){for(const name of ['snapshot.sqlite','snapshot.sqlite-wal','snapshot.sqlite-shm']){const file=path.join(dir,name);if(fs.existsSync(file))fs.unlinkSync(file);}fs.rmdirSync(dir);}};}
async function hashFile(file:string){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}

/** Verify a disposable restored copy; never restore over the running database. */
export async function verifyEncryptedBackup(file:string,key:string|undefined){
 const secret=backupKey(key),size=fs.statSync(file).size,header=Buffer.alloc(magic.length+12),tag=Buffer.alloc(16),fd=fs.openSync(file,'r');
 try{if(size<header.length+16)throw new MirrorError('BACKUP_INVALID','The encrypted backup is truncated.');fs.readSync(fd,header,0,header.length,0);fs.readSync(fd,tag,0,16,size-16);}finally{fs.closeSync(fd);}
 if(!header.subarray(0,magic.length).equals(magic))throw new MirrorError('BACKUP_INVALID','This is not an AMCP encrypted backup.');
 const temp=temporary();let output:number|undefined;
 try{
  const decrypt=createDecipheriv('aes-256-gcm',secret,header.subarray(magic.length));decrypt.setAAD(magic);decrypt.setAuthTag(tag);output=fs.openSync(temp.file,'wx',0o600);
  for await(const chunk of fs.createReadStream(file,{start:header.length,end:size-17}))fs.writeSync(output,decrypt.update(chunk));
  fs.writeSync(output,decrypt.final());fs.closeSync(output);output=undefined;
  const db=new DatabaseSync(temp.file,{readOnly:true});try{const result=db.prepare('PRAGMA integrity_check').all() as JsonObject[];if(result.length!==1||result[0]!.integrity_check!=='ok')throw new MirrorError('BACKUP_INTEGRITY_FAILED','The restored SQLite copy failed its integrity check.');}finally{db.close();}
  const restored=new Store(temp.file,key);try{if(!restored.verifyAudit())throw new MirrorError('BACKUP_AUDIT_FAILED','The restored audit chain is invalid.');for(const tenant of restored.listTenants())for(const connection of restored.listConnections(tenant))restored.credentials(tenant,connection.id);}finally{restored.close();}
  return {status:'verified',verified_at:Date.now(),encrypted_bytes:size,sha256:await hashFile(file),message:'Disposable restoration passed SQLite integrity, audit-chain and connection decryption checks. Store a copy off-host and keep its master key separately.'};
 }catch(e){if(e instanceof MirrorError)throw e;throw new MirrorError('BACKUP_DECRYPT_FAILED','Backup authentication or restoration failed. Check the matching master key and file.');}
 finally{if(output!==undefined)fs.closeSync(output);temp.clean();}
}

export async function createEncryptedBackup(store:Store,file:string,key:string|undefined){
 const secret=backupKey(key),temp=temporary();let output:number|undefined,created=false;
 try{
  await backup(store.db,temp.file);output=fs.openSync(file,'wx',0o600);created=true;
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,nonce);cipher.setAAD(magic);fs.writeSync(output,Buffer.concat([magic,nonce]));
  for await(const chunk of fs.createReadStream(temp.file))fs.writeSync(output,cipher.update(chunk));
  fs.writeSync(output,cipher.final());fs.writeSync(output,cipher.getAuthTag());fs.fsyncSync(output);fs.closeSync(output);output=undefined;
  const receipt=await verifyEncryptedBackup(file,key),id=randomUUID();for(const tenant of store.listTenants())store.putDocument(tenant,'backup_receipt',id,receipt);return receipt;
 }catch(e){if(output!==undefined){fs.closeSync(output);output=undefined;}if(created&&fs.existsSync(file))fs.unlinkSync(file);throw e;}
 finally{temp.clean();}
}
