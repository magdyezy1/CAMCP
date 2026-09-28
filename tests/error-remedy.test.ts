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

test('frequent refusals name their own next step instead of a generic "prepare again"',()=>{
 const expect:[string,string,RegExp][]=[
  ['STATE_NOT_FOUND','state',/belongs to this account/],['STATE_TARGET_MISMATCH','state',/different object/],['INCOMPLETE_STATE','state',/never authorizes a write/],
  ['STATE_READ_FAILED','state',/Retry the same call/],['STATE_TOO_LARGE','state',/Narrow/],
  ['POLICY_BUDGET_LIMIT','policy',/No confirmation flag overrides it/],['POLICY_ACTIVATION_FORBIDDEN','policy',/ask the owner/],['WRITES_PAUSED','policy',/after the owner resumes/],
  ['CONFIGURATION_EXISTS','state',/update of it instead of another create/],['PAUSED_CREATION_REQUIRED','request',/separate change/],
  ['CONNECTION_REQUIRED','grant',/Connections page/],['AMBIGUOUS_CONNECTION','request',/connection_id/],['PROVIDER_WRITE_SCOPE_REQUIRED','grant',/write scope/],
  ['ENCRYPTION_REQUIRED','deployment',/MIRROR_MASTER_KEY/],['LIVE_WRITES_DISABLED','deployment',/operator/],['TOKEN_REFRESH_FAILED','provider',/Reconnect/],
  ['MEDIA_RESPONSE_INVALID','provider',/do not resubmit/],['REPORT_SHAPE_CHANGED','provider',/do not resubmit/],
  ['INVALID_ARGUMENT','request',/argument the message names/],['MISSING_PARAMETER','request',/argument the message names/]];
 for(const [code,category,action] of expect){
  const r=errorResult(new MirrorError(code,'Fixture'),'req',1);
  assert.equal(r.error.category,category,code);assert.match(r.error.remedy.action!,action,code);assert.equal(r.error.remedy.mutation_retry_safe,false,code);
  if(code.startsWith('STATE_')||code.startsWith('POLICY_'))assert.doesNotMatch(r.error.remedy.action!,/prepare again/i,code);
 }
});
