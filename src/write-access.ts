import {MirrorError} from './errors.js';
import {normalizeAccount} from './scope.js';
import type {Store} from './store.js';
import type {Connection} from './types.js';

/** An account grant applies equally to campaigns, ads, creatives and media. */
export function assertAccountWrite(store:Store,c:Connection,account:string):void {
 if(c.writeAccounts?.some(id=>normalizeAccount(c.gateway,id)===account))return;
 const candidates=store.listConnections(c.tenantId).filter(other=>other.enabled&&other.gateway===c.gateway&&other.accounts.some(id=>normalizeAccount(c.gateway,id)===account));
 throw new MirrorError('WRITE_ACCOUNT_FORBIDDEN','The selected connection has no write grant for this account. Use a listed write-enabled connection explicitly, or enable account writes in AMCP Connections.',{
  gateway:c.gateway,account_id:account,connection_id:c.id,account_selected:true,write_enabled:false,
  connections:candidates.map(other=>({connection_id:other.id,is_default:other.isDefault===true,write_enabled:other.writeAccounts?.some(id=>normalizeAccount(c.gateway,id)===account)===true})),
  applies_to:['campaigns','ad_sets','ads','creatives','media'],remediation:'Connections → Manage → select this account → enable write access → Save. Existing read-only grants are never silently upgraded.'
 },403);
}
