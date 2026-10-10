import {evaluationFixture, metaConnection, otherConnection, evaluationDestination, gtmConnection} from './journeys/harness.mjs';
const f = await evaluationFixture();
const N = Number(process.env.N ?? 1200);
const show = (label, r) => console.log('##', label, String(JSON.stringify(r)).slice(0, N));
const step = (account = '123', connection = metaConnection) => ({
  id: 'campaign',
  kind: 'write',
  gateway: 'meta_native_action',
  connection_id: connection,
  account_id: account,
  arguments: {action: 'meta_campaign_create', payload: {name: 'C', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false}},
});
const mode = process.argv[2];
try {
  if (mode === 'tasks') {
    const p = await f.call('amcp_campaign', {action: 'create', name: 'T', brief: 'x', steps: [step()]});
    show('preflight', await f.call('amcp_campaign', {action: 'preflight', id: p.data.id}));
    show('get', await f.call('amcp_campaign', {action: 'get', id: p.data.id}));
    f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-1', {platform: 'meta', gateway: 'meta_native_action', account_id: '123', connection_id: metaConnection, review_id: 'asset-1', name: 'Launch image', media_id: 'hash-1', sha256: 'a'.repeat(64)});
    show('reuse', await f.call('amcp_media', {action: 'reuse', asset_id: 'asset-1'}));
    show('ops', await f.call('amcp_workspace', {action: 'operations', connection_id: otherConnection}));
  }
  if (mode === 'j2u') {
    const p = await f.call('amcp_campaign', {action: 'create', name: 'U', brief: 'x', steps: [step('456')]});
    show('create456', p);
    if (p.success) show('prep', await f.call('amcp_campaign', {action: 'prepare_next', id: p.data.id}));
    const q = await f.call('amcp_campaign', {action: 'create', name: 'U', brief: 'x', steps: [step('123', otherConnection)]});
    show('createB123', q);
    if (q.success) show('prepB123', await f.call('amcp_campaign', {action: 'prepare_next', id: q.data.id}));
    show('createA789', await f.call('amcp_campaign', {action: 'create', name: 'U', brief: 'x', steps: [step('789')]}));
    show('caps', await f.call('amcp_workspace', {action: 'capabilities', workflow_id: 'recipe:meta_website_traffic', connection_id: metaConnection, account_id: '123'}));
  }
  if (mode === 'j7') {
    const p = await f.call('amcp_campaign', {action: 'create', name: 'R', brief: 'x', steps: [step()]});
    const id = p.data.id;
    let prep = await f.call('amcp_campaign', {action: 'prepare_next', id});
    f.providers.state.accountStatus = 2;
    let r = prep.data.review;
    await f.call('amcp_campaign', {action: 'execute_next', id, review_id: r.review_id, idempotency_key: r.idempotency_key, confirmed: true});
    f.providers.state.accountStatus = 1;
    show('ops', await f.call('amcp_workspace', {action: 'operations', state: 'attention'}));
    show('getstep', await f.call('amcp_campaign', {action: 'get', id, step_id: 'campaign'}));
    prep = await f.call('amcp_campaign', {action: 'prepare_next', id});
    show('reprepare', prep);
    const nx = prep.data?.next_call ?? prep.meta?.workflow?.next_call; show('next', nx);
    if (nx) { const rec = await f.call(nx.tool, nx.arguments); show('recover', rec); const p2 = await f.call('amcp_campaign', {action: 'prepare_next', id}); show('prep2', p2); r = p2.data?.review; }
    if (r) {
      show('reexec', await f.call('amcp_campaign', {action: 'execute_next', id, review_id: r.review_id, idempotency_key: r.idempotency_key, confirmed: true}));
    }
    show('opslimit', await f.call('amcp_workspace', {action: 'operations', limit: 1}));
  }
  if (mode === 'j5') {
    f.providers.state.sheetsRefusal = true;
    const s = f.snapshot();
    const e = await f.call('amcp_reporting_overview', {action: 'export', report_id: s, destination_id: evaluationDestination, confirmed: true});
    console.log('work', await f.work());
    const st = await f.call('amcp_reporting_overview', {action: 'export_status', id: e.data.id});
    show('status', st);
    f.providers.state.sheetsRefusal = false;
    const rt = await f.call('amcp_reporting_overview', {action: 'retry', id: e.data.id});
    show('retry', rt);
    console.log('work', await f.work());
    show('status2', await f.call('amcp_reporting_overview', {action: 'export_status', id: e.data.id}));
    const older = f.snapshot();
    // superseded: export the newer first then the older
  }
  if (mode === 'j5s') {
    const older = f.snapshot(), newer = f.snapshot();
    const e1 = await f.call('amcp_reporting_overview', {action: 'export', report_id: newer, destination_id: evaluationDestination, confirmed: true});
    await f.work();
    const e2 = await f.call('amcp_reporting_overview', {action: 'export', report_id: older, destination_id: evaluationDestination, confirmed: true});
    await f.work();
    show('status-older', await f.call('amcp_reporting_overview', {action: 'export_status', id: e2.data.id}));
    f.store.putConnection(f.admin, {id: 'aaaaaaaa-5555-4555-8555-00000000000c', tenantId: f.actor.tenantId, gateway: 'google_sheets_native_action', enabled: false, accounts: ['evaluationSheet'], scopes: ['https://www.googleapis.com/auth/spreadsheets'], label: 'x'}, {accessToken: 'x'});
    show('disabled-export', await f.call('amcp_reporting_overview', {action: 'export', report_id: newer, destination_id: evaluationDestination, confirmed: true}));
  }
  if (mode === 'j6') {
    const req = {container_id: '55', workspace_id: '66', tag_ids: ['001', '002'], required_types: ['ad_storage']};
    const pv = await f.call('amcp_workspace', {action: 'preview_consent_plan', gateway: 'gtm_native_action', connection_id: gtmConnection, account_id: '44', requirements: req});
    show('preview', pv);
    if (process.argv[3] === 'change') f.providers.state.gtm.tags.get('001').fingerprint = 'tag-001-changed';
    if (pv.success) {
      const cr = await f.call('amcp_workspace', {action: 'create_consent_plan', preview_id: pv.data.preview_id, preview_hash: pv.data.preview_hash, confirmed: true});
      show('create', cr);
      if (cr.success) show('get', await f.call('amcp_campaign', {action: 'get', id: cr.data.id}));
    }
    show('acc45', await f.call('amcp_workspace', {action: 'preview_consent_plan', gateway: 'gtm_native_action', connection_id: gtmConnection, account_id: '45', requirements: req}));
    show('tag003', await f.call('amcp_workspace', {action: 'preview_consent_plan', gateway: 'gtm_native_action', connection_id: gtmConnection, account_id: '44', requirements: {...req, tag_ids: ['001', '003']}}));
  }
  if (mode === 'j4i') {
    f.providers.state.insightsPaging = true;
    const r = await f.call('amcp_reporting', {
      action: 'capture_preset', preset: 'meta_ad', account_id: '123', connection_id: metaConnection,
      result_action_type: 'offsite_conversion.fb_pixel_purchase', attribution_windows: ['7d_click'],
      semantics: {currency: 'USD', timezone: 'UTC', date_from: '2026-09-01', date_to: '2026-09-01', source_name: 'Eval', complete: true},
    });
    show('paged', r);
    f.providers.state.insightsPaging = false;
    const r2 = await f.call('amcp_reporting', {
      action: 'capture_preset', preset: 'meta_ad', account_id: '123', connection_id: metaConnection,
      result_action_type: 'offsite_conversion.fb_pixel_purchase', attribution_windows: ['7d_click'],
      semantics: {currency: 'USD', timezone: 'UTC', date_from: '2026-09-01', date_to: '2026-09-01', source_name: 'Eval', complete: false},
    });
    show('incomplete', r2);
    if (r2.success) show('analyze', await f.call('amcp_reporting', {action: 'analyze', id: r2.data.id}));
  }
} finally {
  console.log(JSON.stringify(f.transcript.map(t => [t.surface, t.tool, t.action, t.success, t.code, t.state, t.bytes, t.provider_requests, t.next_call, t.next_step])));
  console.log('egress_refused', f.providers.state.egress_refused, 'mutations', f.providers.state.mutations);
  await f.close();
}
