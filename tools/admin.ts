import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {backup} from 'node:sqlite';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorError} from '../src/errors.js';
import {guardInput} from '../src/security.js';
import type {Actor,Connection,Credentials} from '../src/types.js';
const [command,...args]=process.argv.slice(2);
const help='Usage: admin keygen | init <tenant> | create-key <tenant> <user> <reader|operator|admin> | revoke-key <file> | provision <json-file> | status <tenant> | audit-verify | backup <new-file>';
if(command==='keygen'){process.stdout.write(randomBytes(32).toString('base64')+'\n');}
else if(!command||command==='help'){process.stdout.write(help+'\n');}
else{
 const store=new Store(process.env.MIRROR_DB??'.runtime/mirror.sqlite',process.env.MIRROR_MASTER_KEY);
 try{
  switch(command){
   case 'init':if(!args[0])throw Error(help);store.ensureTenant(args[0]);process.stdout.write('Tenant initialized.\n');break;
   case 'create-key':{
    const [tenantId,userId,role]=args;if(!tenantId||!userId||!['reader','operator','admin'].includes(role??''))throw Error(help);
    const token=store.createKey({tenantId,userId,role:role as Actor['role']});process.stdout.write(token+'\n');break;
   }
   case 'revoke-key':if(!args[0])throw Error(help);store.revokeKey(fs.readFileSync(args[0],'utf8').trim());process.stdout.write('Key revoked.\n');break;
   case 'provision':{
    if(!args[0])throw Error(help);const data=JSON.parse(fs.readFileSync(args[0],'utf8')) as {connection:Connection;credentials:Credentials};guardInput(data);
    const c=data.connection;
    if(!c||typeof c.id!=='string'||!c.id||typeof c.tenantId!=='string'||!c.tenantId||!Array.isArray(c.scopes)||typeof c.enabled!=='boolean'||typeof c.label!=='string'||!new Registry().tools.has(c.gateway))throw new MirrorError('INVALID_CONNECTION','Provide a complete connection with an observed gateway name.');
    if(!data.credentials||typeof data.credentials!=='object'||!Object.values(data.credentials).some(Boolean))throw new MirrorError('INVALID_CREDENTIALS','Provide credentials for your own vendor app.');
    store.putConnection({tenantId:c.tenantId,userId:'local-administrator',role:'admin'},c,data.credentials);
    store.appendAudit(c.tenantId,'admin/provision',{event:'connection_provisioned',connection_id:c.id,gateway:c.gateway,accounts:c.accounts});process.stdout.write('Encrypted connection provisioned.\n');break;
   }
   case 'status':if(!args[0])throw Error(help);process.stdout.write(JSON.stringify({tenant:args[0],connections:store.listConnections(args[0]),audit_chain_valid:store.verifyAudit()},null,2)+'\n');break;
   case 'audit-verify':if(!store.verifyAudit())throw new MirrorError('AUDIT_INTEGRITY_FAILURE','Audit hash chain does not verify.');process.stdout.write('Audit hash chain verified.\n');break;
   case 'backup':if(!args[0]||fs.existsSync(args[0]))throw new MirrorError('BACKUP_PATH_REQUIRED','Provide a new backup filename.');await backup(store.db,args[0]);process.stdout.write('Consistent SQLite backup created. Store the master key separately.\n');break;
   default:throw Error(help);
  }
 }catch(e){process.stderr.write((e instanceof MirrorError?e.code+': '+e.message:e instanceof Error?e.message:'Command failed.')+'\n');process.exitCode=1;}finally{store.close();}
}
