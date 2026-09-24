'use strict';

function overviewLabel(config){return [config.client_name,config.name].filter(Boolean).join(' · ');}
function overviewLibraryOptions(b){
 const selected=overviewState.selection;
 return '<option value="">Open a saved report or template</option>'+[['view','Saved reports',b.views],['template','Templates',b.templates??[]]].map(([kind,label,records])=>`<optgroup label="${label}">${[...records].sort((a,b)=>overviewLabel(a.config).localeCompare(overviewLabel(b.config))).map(r=>`<option value="${kind}:${esc(r.id)}" ${selected?.kind===kind&&selected.id===r.id?'selected':''}>${esc(overviewLabel(r.config))}</option>`).join('')}</optgroup>`).join('');
}
function renderOverviewLibrary(b,reader){
 const s=overviewState.selection,template=s?.kind==='template';
 return `<section class="panel report-library" aria-label="Report library"><div class="report-actions"><label>Report library<select id="overview-saved">${overviewLibraryOptions(b)}</select></label><button id="overview-new" class="button primary" ${reader?'disabled':''}>+ New report</button><button id="overview-duplicate" class="button" ${reader?'disabled':''}>Duplicate setup</button><button id="overview-template" class="button" ${reader?'disabled':''}>Save as new template</button>${template?'<button id="overview-use-template" class="button primary">Create report from template</button>':''}${s?`<button id="overview-delete" class="button danger" ${reader?'disabled':''}>Delete ${template?'template':'report'}</button>`:''}<a class="button" href="/connections">+ Connect accounts</a></div><p class="form-note" id="overview-definition-status" role="status">${template?'Editing a reusable template. Account selections, client names, destinations and schedules are excluded. Create a report from it to select a client and accounts.':s?'Editing a saved report. Save changes to update its settings and any linked schedule. Completed snapshots retain their original data.':'New report setup. Give it a client and name, choose accounts, then save or pull a report.'}</p></section>`;
}
function renderUnavailableReportSources(config,bootstrap){
 const missing=(config.sources??[]).filter(s=>!bootstrap.platforms.find(p=>p.id===s.platform)?.accounts.some(a=>a.connection_id===s.connection_id&&a.account_id===s.account_id));
 return missing.length?'<div class="notice"><strong>Some saved accounts are unavailable</strong><p>Reconnect the saved login, or explicitly uncheck an account to remove it from this report.</p>'+missing.map(s=>`<label class="report-account"><input type="checkbox" data-report-account="${esc(s.platform)}" value="${esc(JSON.stringify([s.platform,s.connection_id,s.account_id]))}" checked><span>${esc(pretty(s.platform))} · ${esc(s.account_id)}<small>Login: ${esc(s.connection_id)}</small></span></label>`).join('')+'<a href="/connections">Manage connections ↗</a></div>':'';
}
function reportWindowLabel(range){
 if(range?.preset==='last_complete_week')return 'Previous complete week (Monday–Sunday)';
 if(range?.preset==='last_complete_month')return 'Previous complete calendar month';
 if(range?.preset)return 'Last '+(range.days??7)+' complete days'+(range.offset_days?' · skip '+range.offset_days+' recent days':'');
 return reportRangeLabel(range);
}
function reportWindowOptions(range,custom=true){
 const value=range?.preset??'custom';
 return [['last_complete_days','Last complete days'],['last_complete_week','Previous complete week'],['last_complete_month','Previous calendar month'],['custom','Custom dates']].filter(([v])=>custom||v!=='custom').map(([v,label])=>`<option value="${v}" ${value===v?'selected':''}>${label}</option>`).join('');
}
function renderReportSetupFields(c){
 const range=c.date_range,zone=range.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone;
 return `<div class="report-control-top"><label class="report-name">Client name<input name="client_name" value="${esc(c.client_name??'')}" maxlength="100" placeholder="e.g. Client A"></label><label class="report-name">Report name<input name="name" value="${esc(c.name)}" maxlength="100" required></label><label>Group data by<select name="grain">${[['total','Whole period'],['daily','Day'],['weekly','Week (Monday–Sunday)'],['monthly','Calendar month']].map(([v,label])=>`<option value="${v}" ${(c.grain??'total')===v?'selected':''}>${label}</option>`).join('')}</select></label><label>Date window<select name="rangeMode" id="report-range-mode">${reportWindowOptions(range)}</select></label><div id="report-rolling" class="report-date-fields"><label data-rolling-days>Days<input type="number" name="days" min="1" max="366" value="${range.days??7}"></label><label data-rolling-days>Skip recent days<input name="offset_days" type="number" min="0" max="90" value="${range.offset_days??0}" title="Exclude recent days to allow conversions to mature"></label><label>Window timezone<input name="timezone" value="${esc(zone)}" list="report-timezones"></label></div><div id="report-dates" class="report-date-fields"><label>Set a full month<input type="month" id="report-calendar-month" aria-label="Reporting month and year"></label><label>From<input type="date" name="since" value="${esc(range.since??new Date(Date.now()-7*86400000).toISOString().slice(0,10))}"></label><label>Through<input type="date" name="until" value="${esc(range.until??new Date(Date.now()-86400000).toISOString().slice(0,10))}"></label></div><p id="report-range-summary" class="report-date-summary" aria-live="polite"></p><p class="form-note">Grouping controls the rows in your report. Delivery frequency is set separately in Sheets & schedules. Each period is collected directly from the provider; longer ranges and more accounts take more requests.</p></div>`;
}
function resetOverviewSelection(){
 clearTimeout(pollTimer);clearTimeout(deliveryTimer);overviewState.loadSequence=(overviewState.loadSequence??0)+1;
 overviewState.deliveryDraft=null;overviewState.selection=null;overviewState.destinationId=null;overviewState.report=null;overviewState.page=0;overviewState.dirty=false;
}
function selectOverviewDefinition(record,kind='view'){
 resetOverviewSelection();overviewState.selection={id:record.id,revision:record.revision,kind};
 overviewState.config={...overviewDefault(),...structuredClone(record.config)};overviewState.destinationId=record.destination_id??null;
}
function overviewMayLeave(){return !overviewState.dirty||confirm('Discard the unsaved changes to this report setup?');}
async function newOverviewReport(config=overviewDefault()){
 resetOverviewSelection();overviewState.config=config;await renderReportingOverview();$('[name="name"]')?.focus();
}
async function saveOverviewDefinition(asTemplate=false){
 if(!$('#overview-config').reportValidity())return;
 const config=overviewConfig(),selection=asTemplate?null:overviewState.selection,kind=asTemplate?'template':selection?.kind??'view';
 const saved=await overviewCall({action:kind==='template'?'save_template':'save',config,...(selection?{id:selection.id,expected_revision:selection.revision}:{}),...(kind==='view'&&overviewState.destinationId?{destination_id:overviewState.destinationId}:{}),confirmed:true});
 selectOverviewDefinition(saved,kind);await renderReportingOverview();toast(kind==='template'?'Template saved. Use it to create separate client reports.':'Report saved.');
}
function renderOverviewHistory(history,reader){
 return '<div class="panel-header"><h2>Recent snapshots</h2><span class="muted">Collected results with their original settings and source evidence</span></div>'+(history.map(r=>`<div class="report-history-item"><button class="report-history-row" data-report-open="${esc(r.id)}"><span><strong>${esc(overviewLabel(r.config))}</strong><small>${esc(reportRangeLabel(r.config.date_range))} · ${esc(pretty(r.config.grain??'total'))} · ${date(r.created_at)}</small></span><span class="status">${reportDisplayState(r)}</span><span>${r.row_count??0} rows ↗</span></button><button class="button small danger" data-report-delete="${esc(r.id)}" aria-label="Delete snapshot ${esc(overviewLabel(r.config))}" ${reader?'disabled':''}>Delete</button></div>`).join('')||'<p class="empty">Choose accounts and pull your first report.</p>');
}
async function openOverviewHistory(id){
 if(!overviewMayLeave())return;resetOverviewSelection();await loadOverviewReport(id);const r=overviewState.report;if(!r||r.id!==id)return;
 overviewState.config={...overviewDefault(),...structuredClone(r.config)};overviewState.destinationId=r.destination_id??null;
 await renderReportingOverview();$('#overview-results')?.scrollIntoView({block:'start'});
}
function bindOverviewHistory(){
 authBind('.report-history [data-report-open]',async b=>openOverviewHistory(b.dataset.reportOpen));
 authBind('.report-history [data-report-delete]',async b=>{
  const r=overviewState.history.find(r=>r.id===b.dataset.reportDelete);if(!r||!confirm('Delete the collected snapshot “'+overviewLabel(r.config)+'”? Its active jobs will stop. Saved report setups, other snapshots and external spreadsheets are kept.'))return;
  await overviewCall({action:'delete_report',id:r.id,confirmed:true});if(overviewState.report?.id===r.id){clearTimeout(pollTimer);overviewState.loadSequence++;overviewState.report=null;}
  overviewState.config=overviewConfig();await renderReportingOverview();toast('Snapshot deleted.');
 });
}
function bindOverviewLibrary(){
 $('#overview-config').addEventListener('input',()=>{overviewState.dirty=true;});$('#overview-config').addEventListener('change',()=>{overviewState.dirty=true;});
 authBind('#overview-new',async()=>{if(overviewMayLeave())await newOverviewReport();});
 authBind('#overview-duplicate',async()=>{const c=overviewConfig();await newOverviewReport({...c,name:(c.name+' copy').slice(0,100)});toast('New copy. Choose its client, destination and schedule.');});
 authBind('#overview-template',async()=>saveOverviewDefinition(true));
 authBind('#overview-use-template',async()=>{const c=overviewConfig();await newOverviewReport({...c,client_name:'',sources:[]});toast('Choose the client and accounts for this report.');});
 authBind('#overview-delete',async()=>{
  const s=overviewState.selection;if(!s)return;const noun=s.kind==='template'?'template':'saved report';if(!confirm('Delete the '+noun+' “'+overviewState.config.name+'”?'+(s.kind==='view'?' Its schedule and pending deliveries will stop. Collected snapshots and external spreadsheets are kept.':' Reports already created from it are kept.')))return;
  await overviewCall({action:s.kind==='template'?'delete_template':'delete_view',id:s.id,expected_revision:s.revision,confirmed:true});await newOverviewReport();toast(pretty(noun)+' deleted.');
 });
 $('#overview-saved').addEventListener('change',async e=>{
  const current=overviewState.selection;if(!overviewMayLeave()){e.target.value=current?current.kind+':'+current.id:'';return;}
  const [kind,id]=e.target.value.split(':'),r=(kind==='template'?overviewState.bootstrap.templates:overviewState.bootstrap.views)?.find(r=>r.id===id);if(!r)return;
  try{selectOverviewDefinition(r,kind);await renderReportingOverview();}catch(error){$('#auth-error').textContent=error.message;}
 });
 bindOverviewHistory();
}
