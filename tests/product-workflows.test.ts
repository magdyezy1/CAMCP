import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {monitorOperation, evaluateMonitors} from '../src/report-monitors.js';
import {workflowOutcome} from '../src/workflow-outcomes.js';
import {DecisionReporting} from '../src/decision-reporting.js';
import {reportPreset} from '../src/report-presets.js';
import {cleanupReports} from '../src/owner-operations.js';
import type {Actor} from '../src/types.js';
const actor: Actor = {tenantId: 'product-tests', userId: 'owner', role: 'admin'};
test('workspace monitors deduplicate by rule and window, retain acknowledgement and resolve only on complete comparable evidence', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 65).toString('base64'));
  try {
    store.putConnection(
      actor,
      {
        id: 'meta',
        tenantId: actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['100'],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const rule = {
      name: 'Spend ceiling',
      platform: 'meta',
      connection_id: 'meta',
      account_id: '100',
      currency: 'USD',
      timezone: 'UTC',
      result_definition: 'Purchases',
      attribution: '7-day click',
      metric: 'spend',
      comparison: 'above',
      threshold: '50',
      max_age_hours: 24,
    };
    const policy = monitorOperation(store, actor, {action: 'save_monitor', monitor: rule, confirmed: true});
    assert.equal(policy.actor_binding, undefined);
    const snapshot = (id: string, value: number, complete = true, currency = 'USD') =>
      store.putDocument(actor.tenantId, 'overview_report', id, {
        state: 'complete',
        config: {sources: [{platform: 'meta', connection_id: 'meta', account_id: '100'}]},
        completed_at: Date.now(),
        rows: [
          {
            ...rule,
            date_from: '2026-09-01',
            date_to: '2026-09-07',
            currency,
            complete,
            objective_group: 'sales',
            captured_at: Date.now(),
            metrics: {spend: value},
          },
        ],
        summary: [
          {
            ...rule,
            date_from: '2026-09-01',
            date_to: '2026-09-07',
            currency,
            complete,
            objective_group: 'sales',
            metrics: {spend: value},
          },
        ],
      });
    snapshot('first', 60);
    const first = evaluateMonitors(store, actor, 'first').outcomes[0]!;
    assert.equal(first.state, 'open');
    assert.equal(evaluateMonitors(store, actor, 'first').outcomes[0]!.deduplicated, true);
    let incident = store.document(actor.tenantId, 'report_incident', first.id);
    monitorOperation(store, actor, {action: 'acknowledge_incident', id: incident.id, revision: incident.revision});
    snapshot('more', 70);
    assert.equal(evaluateMonitors(store, actor, 'more').outcomes[0]!.state, 'acknowledged');
    snapshot('incomplete', 0, false);
    assert.equal(evaluateMonitors(store, actor, 'incomplete').outcomes[0]!.status, 'data_unavailable');
    snapshot('other-currency', 0, true, 'SAR');
    assert.equal(evaluateMonitors(store, actor, 'other-currency').outcomes[0]!.status, 'data_unavailable');
    snapshot('stale', 0);
    const stale = store.document(actor.tenantId, 'overview_report', 'stale');
    stale.rows[0].captured_at = Date.now() - 25 * 3600000;
    store.putDocument(actor.tenantId, 'overview_report', 'stale', stale);
    assert.equal(evaluateMonitors(store, actor, 'stale').outcomes[0]!.status, 'data_unavailable');
    assert.equal(
      store.document(actor.tenantId, 'report_monitor', policy.id).last_evaluation.status,
      'data_unavailable',
    );
    snapshot('fixed', 40);
    assert.equal(evaluateMonitors(store, actor, 'fixed').outcomes[0]!.state, 'resolved');
    snapshot('older', 80);
    const older = store.document(actor.tenantId, 'overview_report', 'older');
    older.rows[0].captured_at = Date.now() - 3600000;
    store.putDocument(actor.tenantId, 'overview_report', 'older', older);
    assert.equal(evaluateMonitors(store, actor, 'older').outcomes[0]!.ignored, 'older_evidence');
    incident = store.document(actor.tenantId, 'report_incident', first.id);
    assert.equal(incident.evidence.length, 3);
    assert.equal(incident.automatic_advertising_changes, false);
    assert.throws(
      () =>
        monitorOperation(store, {...actor, role: 'reader'}, {action: 'save_monitor', monitor: rule, confirmed: true}),
      {code: 'FORBIDDEN'},
    );
    assert.equal(monitorOperation(store, {...actor, tenantId: 'other'}, {action: 'incidents'}).incidents.length, 0);
    store.putConnection(
      actor,
      {...store.listConnections(actor.tenantId)[0]!, enabled: false},
      {accessToken: 'synthetic'},
    );
    assert.equal(monitorOperation(store, actor, {action: 'incidents'}).incidents.length, 0);
  } finally {
    store.close();
  }
});
test('workflow outcomes expose only first-party internal routes and preserve required approvals', () => {
  assert.equal(
    workflowOutcome('meta_native_action', {id: 'malicious', state: 'complete', next_call: {tool: 'anything'}}),
    undefined,
  );
  const out = workflowOutcome('amcp_campaign', {
    campaign_id: 'id/#',
    state: 'review_ready',
    execute_requirements: {confirmed: true, cap_override_confirmed: true},
  })!;
  assert.equal(out.state, 'review_required');
  assert.equal(out.website_path, '/campaigns?id=id%2F%23');
  assert.deepEqual(out.required_acknowledgements, ['confirmed', 'cap_override_confirmed']);
  assert.equal(out.automatic_retry_of_mutation, false);
  assert.equal(workflowOutcome('amcp_media', {review_id: 'original', state: 'uncertain'})!.state, 'attention_required');
});
test('guided report presets qualify native field mappings, preserve native units and reject invalid account/date input', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 66).toString('base64'));
  try {
    store.putConnection(
      actor,
      {
        id: 'google',
        tenantId: actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['123'],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    let requests = 0;
    const service = new DecisionReporting(store, async (g, args) => {
      requests++;
      assert.equal(g, 'google_ads_native_action');
      assert.match(args.payload.query, /FROM ad_group_ad/);
      assert.equal(args.aggregate_pages, true);
      return {
        success: true,
        data: {
          data: {
            results: [
              {
                campaign: {id: '1', name: 'Search'},
                adGroup: {id: '2'},
                adGroupAd: {ad: {id: '3'}},
                segments: {date: '2026-09-01'},
                metrics: {
                  costMicros: '10010001',
                  clicks: '20',
                  impressions: '200',
                  conversions: 2,
                  conversionsValue: 30,
                },
              },
            ],
          },
        },
      };
    });
    const input = {
      action: 'capture_preset',
      preset: 'google_ad',
      account_id: '123',
      connection_id: 'google',
      semantics: {
        currency: 'USD',
        timezone: 'UTC',
        date_from: '2026-09-01',
        date_to: '2026-09-07',
        attribution: 'Google account default',
        conversion_definition: 'Primary conversions',
        source_name: 'Ad details',
        complete: true,
      },
    };
    const captured = await service.handle(input, actor);
    assert.equal(captured.totals.spend, '10.010001');
    assert.equal(captured.rows[0].entity_id, '3');
    const reloaded = await service.handle({action: 'get', id: captured.id}, actor);
    assert.equal(reloaded.preset, 'google_ad');
    assert.equal(reloaded.grain, 'ad × day');
    assert.equal(reloaded.source_hash, captured.source_hash);
    assert.equal(requests, 1);
    const search = reportPreset({...input, preset: 'google_search_terms'});
    assert.match(search.arguments.payload.query, /FROM search_term_view/);
    assert.equal(search.mapping.search_term, '/searchTermView/searchTerm');
    assert.throws(() => reportPreset({...input, account_id: '123 OR 1=1'}));
    assert.throws(() => reportPreset({...input, preset: 'unqualified'}));
  } finally {
    store.close();
  }
});

test('report retention preserves active incidents and rules while pruning expired captured evidence', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  try {
    store.ensureTenant(actor.tenantId);
    store.putDocument(actor.tenantId, 'retention_policy', 'reports', {days: 7});
    const old = Date.now() - 8 * 86400000;
    for (const state of ['open', 'acknowledged', 'resolved'])
      store.putDocument(actor.tenantId, 'report_incident', state, {state, updated_at: old});
    store.putDocument(actor.tenantId, 'report_incident', 'superseded', {
      state: 'open',
      updated_at: old,
      superseded_by_version: 2,
    });
    store.putDocument(actor.tenantId, 'report_incident', 'recent-superseded', {
      state: 'open',
      updated_at: Date.now(),
      superseded_by_version: 2,
    });
    store.putDocument(actor.tenantId, 'report_monitor', 'rule', {active: true, updated_at: old});
    store.putDocument(actor.tenantId, 'decision_report', 'old', {captured_at: old});
    store.putDocument(actor.tenantId, 'decision_report', 'recent', {captured_at: Date.now()});
    cleanupReports(store);
    assert.deepEqual(
      store
        .documents(actor.tenantId, 'report_incident')
        .map(r => r.id)
        .sort(),
      ['acknowledged', 'open', 'recent-superseded'],
    );
    assert.equal(store.documents(actor.tenantId, 'report_monitor').length, 1);
    assert.deepEqual(
      store.documents(actor.tenantId, 'decision_report').map(r => r.id),
      ['recent'],
    );
  } finally {
    store.close();
  }
});
