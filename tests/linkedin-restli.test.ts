import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedinQuery} from '../src/linkedin-restli.js';
import {buildUrl} from '../src/transport.js';
import type {CompiledRequest,Connection} from '../src/types.js';

test('LinkedIn finder wire syntax preserves structural punctuation and encodes URN leaves once',()=>{
 const expected='q=criteria&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A123,urn%3Ali%3AsponsoredCampaign%3A456)';
 for(const campaigns of [['urn:li:sponsoredCampaign:123','urn:li:sponsoredCampaign:456'],'List(urn:li:sponsoredCampaign:123,urn:li:sponsoredCampaign:456)','List(urn%3Ali%3AsponsoredCampaign%3A123,urn%3Ali%3AsponsoredCampaign%3A456)',encodeURIComponent('List(urn:li:sponsoredCampaign:123,urn:li:sponsoredCampaign:456)').replaceAll('(','%28').replaceAll(')','%29')])assert.equal(linkedinQuery({q:'criteria',campaigns}),expected);
 assert.equal(linkedinQuery({q:'search',search:{status:{values:['ACTIVE']}}}),'q=search&search=(status:(values:List(ACTIVE)))');
 assert.equal(linkedinQuery({search:'(status:(values:List(ACTIVE)))'}),'search=(status:(values:List(ACTIVE)))');
});
test('REST.li leaves cannot inject a sibling filter; Unicode and literal punctuation survive',()=>{
 assert.equal(linkedinQuery({names:['A,B (en)','a&account=999','نص'],empty:[],zero:0,enabled:false}),
  'names=List(A%2CB%20%28en%29,a%26account%3D999,%D9%86%D8%B5)&empty=List()&zero=0&enabled=false');
 assert.equal(linkedinQuery({names:'List(A%2CB%20%28en%29)'}),'names=List(A%2CB%20%28en%29)');
 for(const value of ['List(a,)', '(a:1,a:2)', '(a:List(x)', 'List(%zz)', '(constructor:x)'])assert.throws(()=>linkedinQuery({search:value}),{code:'INVALID_RESTLI_QUERY'});
 assert.throws(()=>linkedinQuery({ids:[9007199254740992]}),{code:'INVALID_RESTLI_QUERY'});
});
test('only LinkedIn uses REST.li at the actual transport URL boundary',()=>{
 const plan:CompiledRequest={gateway:'linkedin_native_action',action:'test',method:'GET',path:'/rest/adAccounts/1/creatives',query:{q:'criteria',campaigns:['urn:li:sponsoredCampaign:123']},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'SYNTHETIC',warnings:[]};
 const connection={} as Connection;
 assert.equal(buildUrl(plan,connection).href,'https://api.linkedin.com/rest/adAccounts/1/creatives?q=criteria&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A123)');
 const other=buildUrl({...plan,gateway:'tiktok_native_action',path:'/v1.3/ad/get/'},connection);
 assert.equal(other.searchParams.get('campaigns'),'["urn:li:sponsoredCampaign:123"]');
});
