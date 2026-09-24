import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,Script} from 'node:vm';

function browserFixture(api){
 const root={innerHTML:''},context=createContext({api,Intl,URLSearchParams,clearTimeout(){},pollTimer:null,deliveryTimer:null,session:{workspaceRole:'owner'},document:{querySelector:()=>null},location:{pathname:'/reporting-overview'},authBind(){},date:()=>'',esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),$:selector=>selector==='#overview-results'?root:null});
 for(const file of ['report-library','report-quality','reporting-overview'])new Script(readFileSync('web/'+file+'.js','utf8')).runInContext(context);
 new Script('overviewState.bootstrap={platforms:[],metrics:{}}').runInContext(context);
 return {root,run:code=>new Script(code).runInContext(context),context};
}
const snapshot=id=>({id,state:'complete',rows:[],row_count:0,sources:[],summary:[],exports:[],config:{name:id,date_range:{since:'2026-09-01',until:'2026-09-01'},metrics:['spend'],custom_metrics:[]},job:{state:'complete'}});

test('switching snapshots fences an older response so it cannot replace the newly selected report',async()=>{
 let release;const gate=new Promise(r=>release=r),f=browserFixture(async(_url,options)=>{const {id}=JSON.parse(options.body);if(id==='old snapshot')await gate;return {success:true,data:snapshot(id)};});
 const old=f.run("loadOverviewReport('old snapshot')");await f.run("loadOverviewReport('new snapshot')");release();await old;
 assert.equal(f.run('overviewState.report.id'),'new snapshot');assert.match(f.root.innerHTML,/new snapshot/);assert.ok(!f.root.innerHTML.includes('old snapshot'));
});

test('starting a separate client setup fences an in-flight report response and clears destination identity',async()=>{
 let release;const gate=new Promise(r=>release=r),f=browserFixture(async()=>{await gate;return {success:true,data:snapshot('old snapshot')};});
 f.run("overviewState.selection={kind:'view',id:'old-client',revision:1};overviewState.destinationId='old-tab';overviewState.deliveryDraft={schedule_kind:'monthly'}");const pending=f.run("loadOverviewReport('old snapshot')");f.run('resetOverviewSelection()');release();await pending;
 assert.equal(f.run('overviewState.report'),null);assert.equal(f.run('overviewState.selection'),null);assert.equal(f.run('overviewState.destinationId'),null);assert.equal(f.run('overviewState.deliveryDraft'),null);assert.equal(f.root.innerHTML,'');
});

test('unavailable saved sources remain explicit selections and untrusted library names are escaped',()=>{
 const f=browserFixture(async()=>({}));f.context.config={sources:[{platform:'meta',connection_id:'revoked-login',account_id:'100'}]};f.context.bootstrap={platforms:[{id:'meta',accounts:[]}]};
 const html=f.run('renderUnavailableReportSources(config,bootstrap)');assert.match(html,/explicitly uncheck/);assert.match(html,/revoked-login/);assert.match(html,/checked/);
 f.context.library={views:[{id:'one',config:{client_name:'<script>',name:'Untrusted'}}],templates:[]};const options=f.run('overviewLibraryOptions(library)');assert.ok(!options.includes('<script>'));assert.match(options,/&lt;script>/);
});
