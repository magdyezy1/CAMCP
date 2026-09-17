import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';

/** Endpoint-specific v25 campaign rules, not blanket bans on creative fields. */
export function validateMetaCampaign(plan:CompiledRequest){
 if(plan.gateway!=='meta_native_action'||plan.method!=='POST')return;
 const creating=/^\/v[^/]+\/act_[^/]+\/campaigns$/.test(plan.path);
 if(!creating&&plan.action!=='meta_campaign_id_update')return;
 const b=(plan.body??{}) as JsonObject,fields:string[]=[];
 if(['AUTOMATED_SHOPPING_ADS','SMART_APP_PROMOTION'].includes(b.smart_promotion_type))fields.push('smart_promotion_type');
 if(creating&&Object.hasOwn(b,'existing_customer_budget_percentage'))fields.push('existing_customer_budget_percentage');
 for(const key of ['advantage_state','advantage_budget_state','advantage_audience_state','advantage_placement_state'])if(Object.hasOwn(b,key))fields.push(key);
 if(fields.length)throw new MirrorError('INVALID_META_CAMPAIGN','The campaign uses deprecated legacy Advantage+ inputs or read-only Advantage+ state fields.',{fields,source:'https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-campaigns',next_action:'Build and review a current campaign using its objective, audience, budget and placements. Do not silently translate legacy customer budget percentages or migrate an existing campaign.'});
}
