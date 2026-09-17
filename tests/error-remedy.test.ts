import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError,errorResult,providerHttpErrorCode} from '../src/errors.js';

test('remedies distinguish local contracts and grants from provider denial without inventing a missing scope',()=>{
 for(const [code,category] of [['WRITE_CONTRACT_UNAVAILABLE','contract'],['VENDOR_SCHEMA_UNAVAILABLE','contract'],['SANDBOX_ROUTE_UNQUALIFIED','contract'],['WRITE_ACCOUNT_FORBIDDEN','grant'],['RESOURCE_SCOPE_REQUIRED','grant'],['LINKEDIN_ORGANIZATION_BINDING_REQUIRED','grant'],['LINKEDIN_MEDIA_BINDING_REQUIRED','grant'],['STATE_CHANGED','state'],['WRITE_OUTCOME_UNCERTAIN','state'],['WRITE_PARTIAL_OR_FAILED','provider'],['REAUTHORIZATION_REQUIRED','provider']]){
  const r=errorResult(new MirrorError(code!,'Fixture'),'req',1);assert.equal(r.error.category,category);assert.equal(r.error.remedy.mutation_retry_safe,false);assert.ok(r.error.next_action);
 }
 const upstream={status:403,message:'Access denied'},code=providerHttpErrorCode(403,upstream),r=errorResult(new MirrorError(code,'Provider denied',{upstream,http_status:403}),'req',2);
 assert.equal(code,'PROVIDER_ACCESS_DENIED');assert.equal(r.error.category,'provider');assert.deepEqual(r.error.details?.upstream,upstream);
 assert.ok(!r.error.remedy.action.includes('w_organization_social'));assert.ok(r.meta.untrusted_provider_content);
 assert.equal(errorResult(new MirrorError('INSUFFICIENT_SCOPE','Local scopes missing'),'req',0).error.category,'grant');
 assert.equal(errorResult(new MirrorError('INSUFFICIENT_SCOPE','Provider scope error',{upstream}),'req',0).error.category,'provider');
});
