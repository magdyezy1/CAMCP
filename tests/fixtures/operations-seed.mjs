// Optional synthetic records for the local browser fixture. Never imports credentials or persisted databases.
import {sha256, stable} from '../../dist/src/security.js';
import {monitorOperation} from '../../dist/src/report-monitors.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
export async function seedOperations(store, service) {
  const actor = {tenantId: 'local', userId: 'workspace-admin', role: 'admin'},
    at = Date.now();
  const overview = new ReportingOverview(service);
  const config = overview.config(
    {
      name: 'Synthetic weekly results',
      client_name: 'Demo workspace',
      sources: [{platform: 'meta', connection_id: 'meta-fixture', account_id: '100'}],
      date_range: {since: '2026-09-01', until: '2026-09-07'},
      metrics: ['spend', 'impressions', 'clicks'],
      targets: {},
      custom_metrics: [],
    },
    actor,
  );
  const queued = overview.queue(actor, config);
  const worker = new ReportWorker(
    store,
    async () => {
      throw Error('Unexpected legacy fixture report');
    },
    (t, k, i) => overview.work(t, k, i),
  );
  await worker.once();
  const report = store.document('local', 'overview_report', queued.id);
  if (report.state !== 'complete' || !report.summary.length)
    throw Error('The synthetic snapshot did not collect completely.');
  const reportId = report.id,
    group = report.summary[0],
    observed = group.metrics.spend;
  const context = {
    platform: 'meta',
    connection_id: 'meta-fixture',
    account_id: '100',
    currency: group.currency,
    timezone: group.timezone,
    result_definition: group.result_definition,
    attribution: group.attribution,
  };
  const rule = monitorOperation(store, actor, {
    action: 'save_monitor',
    id: 'synthetic-spend-rule',
    confirmed: true,
    monitor: {
      ...context,
      name: 'Synthetic spend ceiling',
      metric: 'spend',
      comparison: 'above',
      threshold: '40',
      max_age_hours: 24,
    },
  });
  for (let i = 0; i < 27; i++)
    store.putDocument('local', 'report_incident', 'synthetic-incident-' + String(i + 1).padStart(2, '0'), {
      ...context,
      monitor_id: rule.id,
      monitor_name: 'Synthetic spend ceiling · ' + String(i + 1).padStart(2, '0'),
      rule_version: 1,
      state: i % 7 === 6 ? 'acknowledged' : 'open',
      metric: 'spend',
      comparison: 'above',
      threshold: '40',
      value: observed,
      date_from: '2026-09-01',
      date_to: '2026-09-07',
      opened_at: at - i * 60000,
      updated_at: at - i * 60000,
      observed_at: at,
      last_report_id: reportId,
      evidence: [{report_id: reportId, value: observed, captured_at: at, source_hash: sha256('synthetic-' + i)}],
      automatic_advertising_changes: false,
      delivery: 'workspace_inbox',
    });
  for (let i = 0; i < 3; i++) {
    const result = await service.call(
      'amcp_campaign',
      {
        action: 'create',
        name: ['Synthetic launch plan', 'Synthetic audience refresh', 'Synthetic creative update'][i],
        brief: 'Synthetic browser qualification only',
        steps: [
          {
            id: 'campaign',
            kind: 'write',
            gateway: 'meta_native_action',
            connection_id: 'meta-fixture',
            account_id: '100',
            arguments: {action: 'meta_campaign_create', payload: {name: 'Synthetic campaign', status: 'PAUSED'}},
            depends_on: [],
          },
        ],
      },
      actor,
    );
    if (!result.success) throw Error(JSON.stringify(result.error));
  }
  const plan = {
    platform: 'meta',
    connection_id: 'meta-fixture',
    account_id: '100',
    name: 'Synthetic launch creative',
    kind: 'image',
    mime: 'image/png',
    filename: 'synthetic.png',
    size: 10,
    sha256: sha256('synthetic-image'),
  };
  const fingerprint = sha256(stable({tenant: 'local', user: actor.userId, plan}));
  store.putDocument('local', 'media_review', 'synthetic-upload', {
    user_id: actor.userId,
    plan,
    created_at: at,
    expires_at: at + 300000,
    fingerprint,
    state: {},
    state_hash: sha256('{}'),
  });
  store.claim('local', 'synthetic-upload', fingerprint);
  store.uncertain('local', 'synthetic-upload');
}
