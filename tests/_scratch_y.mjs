import {evaluationFixture, metaConnection, otherConnection, evaluationDestination} from './journeys/harness.mjs';
const f = await evaluationFixture();
const N = Number(process.env.N ?? 1500);
const show = (label, r) => console.log('##', label, String(JSON.stringify(r)).slice(0, N));
const mode = process.argv[2];
try {
  if (mode === 'web') {
    show('session', await f.web.get('/api/session'));
    show('platforms', await f.web.get('/api/platforms'));
    const plan = await f.call('amcp_campaign', {
      action: 'create',
      name: 'Eval',
      brief: 'x',
      steps: [
        {
          id: 'campaign',
          kind: 'write',
          gateway: 'meta_native_action',
          connection_id: metaConnection,
          account_id: '123',
          arguments: {action: 'meta_campaign_create', payload: {name: 'C', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false}},
        },
      ],
    });
    show('webget', await f.web.call('campaign', {action: 'get', id: plan.data.id}));
    show('weblist', await f.web.call('campaign', {action: 'list'}));
    show('webops', await f.web.call('workspace', {action: 'operations'}));
  }
  if (mode === 'capture') {
    const r = await f.call('amcp_reporting', {
      action: 'capture_preset',
      preset: 'meta_ad',
      account_id: process.argv[3] ?? '123',
      connection_id: metaConnection,
      result_action_type: 'offsite_conversion.fb_pixel_purchase',
      attribution_windows: ['7d_click'],
      semantics: {currency: 'USD', timezone: 'UTC', date_from: '2026-09-01', date_to: '2026-09-01', source_name: 'Eval', complete: true},
    });
    show('capture', r);
    if (r.success) {
      show('get', await f.call('amcp_reporting', {action: 'get', id: r.data.id}));
      show('analyze', await f.call('amcp_reporting', {action: 'analyze', id: r.data.id}));
    }
  }
  if (mode === 'export') {
    const newer = f.snapshot();
    show('get', await f.call('amcp_reporting_overview', {action: 'get', id: newer}));
    const e = await f.call('amcp_reporting_overview', {action: 'export', report_id: newer, destination_id: evaluationDestination, confirmed: true});
    show('export', e);
    console.log('work', await f.work());
    show('status', await f.call('amcp_reporting_overview', {action: 'export_status', id: e.data?.id}));
    console.log(f.providers.state.tab.report, newer);
  }
  if (mode === 'media') {
    f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-1', {
      platform: 'meta', account_id: '123', connection_id: metaConnection, gateway: 'meta_native_action', review_id: 'asset-1', name: 'Launch image', media_id: 'hash-1', sha256: 'a'.repeat(64),
    });
    const lib = await f.call('amcp_media', {action: 'library', search: 'launch'});
    show('library', lib);
    show('asset', await f.call('amcp_media', {action: 'asset', asset_id: lib.data?.assets?.[0]?.asset_id ?? 'asset-1'}));
    show('perf', await f.call('amcp_media', {action: 'asset_performance', asset_id: 'asset-1'}));
    show('usage', await f.call('amcp_media', {action: 'asset_usage', asset_id: 'asset-1'}));
  }
  if (mode === 'help') {
    show('help', await f.call('amcp_tool_help', {gateway: process.argv[3], operation: process.argv[4]}));
  }
} finally {
  console.log(JSON.stringify(f.transcript.map(t => [t.surface, t.tool, t.action, t.success, t.code, t.state, t.bytes, t.provider_requests, t.next_call, t.next_step, t.website_path])));
  console.log('egress_refused', f.providers.state.egress_refused);
  await f.close();
}
