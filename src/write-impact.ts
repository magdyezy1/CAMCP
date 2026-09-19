import {microsoftAssociationWrite,microsoftAssociationActivates} from './microsoft-associations.js';
import {xCreativeImpact} from './x-creative-writes.js';
import {googleAssetLinkKind,googleAssetLinkActivates} from './google-asset-links.js';
import {MirrorError} from './errors.js';
import {appleEntityKind} from './apple-entity-writes.js';
import {dv360ListKind} from './dv360-list-writes.js';
import {gtmWorkflowKind} from './gtm-workflow-writes.js';
import {gtmWorkspaceKind} from './gtm-workspace-writes.js';
import {stable} from './security.js';
import type {CompiledRequest,JsonObject} from './types.js';
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** PUT resets omitted configuration. Never silently merge live state into the
 * frozen request or treat a sparse update as a complete replacement. */
function assertSnapchatReplacement(plan:CompiledRequest,state:unknown[]){
 const rows=(plan.body as JsonObject).creatives as JsonObject[];
 for(const row of rows){
  const before=state.flatMap(s=>object(s)?s.creatives??[]:[]).map(r=>r.creative).find(r=>r?.id===row.id);
  if(!before||before.ad_account_id!==plan.accountId)throw new MirrorError('STATE_TARGET_MISMATCH','The creative replacement requires its exact selected-account state.');
  for(const field of ['id','ad_account_id','type'])if(row[field]!==before[field]||row[field]===undefined)throw new MirrorError('INVALID_CREATIVE_REPLACEMENT','Preserve the exact creative ID, account and immutable type.',{field});
  for(const field of ['skippable','collection_properties'])if(Object.hasOwn(row,field)&&stable(row[field])!==stable(before[field]))throw new MirrorError('INVALID_CREATIVE_REPLACEMENT','This creative field is immutable.',{field});
  const missing:string[]=[];
  const check=(old:JsonObject,next:JsonObject,path:string)=>{for(const [key,value] of Object.entries(old)){
   if(!path&&/^(?:created_at|updated_at|packaging_status|review_status(?:_.*)?|rejection(?:_.*)?|approval(?:_.*)?)$/.test(key))continue;
   if(!Object.hasOwn(next,key)){missing.push(path+'/'+key);continue;}
   if(object(value)&&object(next[key]))check(value,next[key],path+'/'+key);
  }};check(before,row,'');
  if(missing.length)throw new MirrorError('INCOMPLETE_CREATIVE_REPLACEMENT','Snapchat PUT can reset omitted fields; review a complete creative replacement or use the qualified PATCH route.',{creative_id:row.id,missing_fields:missing,source:'https://developers.snap.com/marketing-api/Ads-API/creatives',next_action:'Read the exact creative, preserve its intended configuration explicitly, remove provider-only status metadata, and prepare a new review. Optional removal must be explicit or use PATCH.'});
 }
}
export function writeImpact(plan:CompiledRequest,state:unknown[],override:boolean,connectionId:string):JsonObject|undefined{
 if(gtmWorkspaceKind(plan))return {provider:'gtm',workflow:gtmWorkspaceKind(plan),effect:'Changes this workspace without publishing. Sync and quick preview can replace or remove unmodified entities using the latest version; bulk deletions and conflict resolutions can discard workspace edits.',verification:'Reads every entity collection with bounded pagination. Quick preview checks the temporary version receipt and workspace contents, without treating it as a saved or published version. It does not verify browser tag execution or consent.',limits:'100 changes per bulk call; 1000 entities per kind, 5000 per workspace and 100 pages per collection. Temporary creates need unique names per kind for unambiguous unordered receipt matching.',recovery:'Sync conflicts, partial receipts and lost responses retain the submission claim. Read workspace status, preserve completed changes, and prepare each correction separately.'};
 if(gtmWorkflowKind(plan))return {provider:'gtm',workflow:gtmWorkflowKind(plan),effect:'Reverts discard the selected workspace edits and can remove entities. Folder and variable edits remain in the selected workspace; version latest changes the synchronization baseline, not the published version. Account permissions and environment reauthorization affect current users or preview snippets immediately.',security:'Administrator workflows require the matching native manage.accounts, manage.users or publish scope. Environment codes are never included in the retained review or result; obtain the new environment snippet in Tag Manager.',verification:'Native scoped read-back verifies the exact result. It does not prove browser tag execution or consent behavior. Gallery imports pin a SHA and require explicit permission acknowledgement.',recovery:'A partial or lost response retains the claim. Inspect state and prepare a separately reviewed correction; never automatically retry the mutation.'};
 if(dv360ListKind(plan))return {provider:'dv360',effect:'Channel, location and negative-keyword lists can be shared by enabled line items. Membership edits affect all consumers of this selected-advertiser list. Replacement removes previous members not in the supplied complete list.',verification:'Complete membership read-back, including all pages, compares the resulting set. It does not establish serving or policy approval.',limits:'Advertiser-owned lists only; partner ownership requires separate grants. Maximum 1000 changes, 10000 snapshot members and 100 pages per review.',recovery:'Partial receipts and lost responses do not authorize replay. Preserve the frozen request and inspect membership; corrections require a fresh review.'};
 if(appleEntityKind(plan))return {provider:'apple',scope:appleEntityKind(plan),affected_account_ids:plan.scopeContext?.appleSharedAccountIds??[plan.accountId],effect:appleEntityKind(plan)==='shared_budget'?'Changes a budget shared by all listed accounts. Every affected account must remain write-authorized; each account policy reserves the entire positive increase conservatively.':'Changes the selected entity. Creative edits and exclusions may affect already enabled ads.',verification:'Exact configuration read-back proves the requested fields, not creative approval or serving. Provider business constraints and access remain live checks.',recovery:'Never repeat an uncertain mutation. Read the exact resources and retained receipt; a correction needs a fresh review.'};
 if(googleConfigurationKind(plan))return {provider:'google',scope:googleConfigurationKind(plan),effect:googleConfigurationServing(plan)?'Changes configuration used by existing ads. Customizer values and ad parameters can change served text; signals and exclusions can change eligible traffic.':'Changes organizational or measurement configuration.',may_affect_serving:googleConfigurationServing(plan),verification:'Exact selected-customer configuration read-back; no claim of serving, policy approval, conversion accrual or tracking installation.',recovery:'A rejected or lost response never authorizes replay. Inspect the original receipt and exact resources; corrections require a fresh review.'};
 if(googleAssetLinkKind(plan))return {provider:'google',effect:'Changes associations of existing assets; it does not create new assets. Enabled links may serve under enabled parents. An omitted create status is treated as activation for owner policy checks.',may_activate:googleAssetLinkActivates(plan),scope:googleAssetLinkKind(plan),source:'https://developers.google.com/google-ads/api/docs/assets/working-with-assets',limits:'Provider policy approval, campaign-type rules and asset-count requirements remain provider checks. Link read-back proves configuration, not impressions or approval. Lead-form delivery credentials are never read by this contract.'};
 if(microsoftAssociationWrite(plan))return {provider:'microsoft',effect:'Changes existing extension associations without modifying the asset library. Linking may serve immediately under an enabled parent.',may_activate:microsoftAssociationActivates(plan),limits:'Exact membership read-back does not establish editorial approval or delivery. Search parents only; ad-group associations require campaign_id. Review freezes the discovered extension types and asset content.'};
 const x=xCreativeImpact(plan,state,override,connectionId);
 if(x)return {provider:'x',...x};
 if(plan.gateway==='snapchat_native_action'&&['PUT','PATCH'].includes(plan.method)&&/\/creatives(?:\/[^/]+)?$/.test(plan.path)){
  if(plan.method==='PUT')assertSnapchatReplacement(plan,state);
  const rows=(plan.body as JsonObject)?.creatives;
  return {provider:'snapchat',effect:'All ads referencing an edited creative use the changed creative. Reviewable creative edits can pause delivery during provider re-review. PUT requires a complete replacement; omitted fields can reset to defaults.',affected_creative_ids:Array.isArray(rows)?rows.map(r=>r.id):[plan.path.split('/').at(-1)],affected_ad_ids:null,enumeration:'not_available_in_this_contract',source:'https://developers.snap.com/marketing-api/Ads-API/creatives',recovery:'Inspect the ads sharing this creative before execution. Use a new creative and separately reviewed ad attachment when the change must affect only selected ads. No automatic ad replay is performed.'};
 }
 return undefined;
}
import {googleConfigurationKind,googleConfigurationServing} from './google-configuration-writes.js';
