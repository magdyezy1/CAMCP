import {MirrorError} from './errors.js';
import type {CompiledRequest} from './types.js';

/** Official withdrawal overrides a historical catalog or Discovery mapping.
 * Keep these entries discoverable; never turn them into executable contracts. */
export const retiredProviderActions=[
 {gateway:'gtm_native_action',action:'COMBINE_CONTAINERS',method:'POST',path:/^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+:combine$/,source:'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/combine',updated:'2026-08-25'},
 {gateway:'gtm_native_action',action:'MOVE_TAG_ID',method:'POST',path:/^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+:move_tag_id$/,source:'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/move_tag_id',updated:'2026-08-25'},
 {gateway:'gtm_native_action',action:'LINK_DESTINATION',method:'POST',path:/^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+\/destinations:link$/,source:'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations/link',updated:'2026-06-04'},
 {gateway:'gtm_native_action',action:'GET_DESTINATION',method:'GET',path:/^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+\/destinations\/[^/:]+$/,source:'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations/get',updated:'2026-06-04'}
];
export const retiredProviderAction=(p:CompiledRequest)=>retiredProviderActions.find(r=>r.gateway===p.gateway&&r.method===p.method&&r.path.test(p.path));
/** These aliases were captured but never corresponded to the versioned provider
 * operation. Match the alias, not its shared mutate route: create/remove work. */
export const unsupportedProviderAliases=[{
 gateway:'google_ads_native_action',action:'UPDATE_CUSTOMIZER_ATTRIBUTE',version:'v23',
 source:'https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v23/services/customizer_attribute_service.proto',checked_at:'2026-09-25',
 reason:'The v23 CustomizerAttributeOperation oneof contains create and remove only. An update_mask field or broad service comment does not define an update operation.',
 replacement:'Create a new attribute with the correct name/type. Separately review replacement customizer associations and affected ads before considering removal of the old attribute. AMCP does not automatically migrate or delete it.'
}];
export const unsupportedProviderAlias=(gateway:string,action:string)=>unsupportedProviderAliases.find(r=>r.gateway===gateway&&r.action===action);
export function assertProviderAliasAvailable(gateway:string,action:string):void{const unavailable=unsupportedProviderAlias(gateway,action);if(unavailable)throw new MirrorError('PROVIDER_ACTION_UNSUPPORTED',unavailable.reason,unavailable);}
export function assertProviderActionAvailable(p:CompiledRequest):void{
 assertProviderAliasAvailable(p.gateway,p.action);
 const retired=retiredProviderAction(p);if(retired)throw new MirrorError('PROVIDER_ACTION_UNSUPPORTED','Google documents this method as no longer supported. A historical mapping cannot make it executable.',{action:retired.action,source:retired.source,documentation_updated:retired.updated,checked_at:'2026-09-19',replacement:'Use the current Google tag management interface and supported list/get workflows; no equivalent API mutation has been established.'});
}
