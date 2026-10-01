import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {monitorOperation, evaluateMonitors} from '../dist/src/report-monitors.js';
const actor = {tenantId: 'inbox', userId: 'operator', role: 'operator'};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 69).toString('base64'));
  store.putConnection(
    {...actor, role: 'admin'},
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
  const context = {
    platform: 'meta',
    connection_id: 'meta',
    account_id: '100',
    currency: 'USD',
    timezone: 'UTC',
    result_definition: 'Purchases',
    attribution: '7-day click',
  };
  const rule = monitorOperation(store, actor, {
    action: 'save_monitor',
    confirmed: true,
    monitor: {
      ...context,
      name: 'Spend ceiling',
      metric: 'spend',
      comparison: 'above',
      threshold: '50',
      max_age_hours: 24,
    },
  });
  const snapshot = (id, spend, complete = true) => {
    const group = {
      ...context,
      date_from: '2026-09-01',
      date_to: '2026-09-07',
      objective_group: 'sales',
      metrics: {spend},
      complete,
    };
    store.putDocument(actor.tenantId, 'overview_report', id, {
      state: complete ? 'complete' : 'partial',
      config: {sources: [context]},
      rows: [{...group, captured_at: Date.now()}],
      summary: [group],
    });
    return evaluateMonitors(store, actor, id);
  };
  const read = id => monitorOperation(store, actor, {action: 'incident', id});
  return {store, context, rule, snapshot, read};
}
test('snooze expires without new evidence, updates evidence while deferred, and cannot hide resolution or later recurrence', t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-10-01T10:00:00Z')});
  const f = fixture();
  try {
    const id = f.snapshot('first', 60).outcomes[0].id;
    let p = f.read(id);
    p = monitorOperation(f.store, actor, {action: 'snooze_incident', id, revision: p.revision, snooze_hours: 1});
    assert.equal(p.state, 'open');
    assert.equal(p.attention_state, 'snoozed');
    assert.equal(p.snoozed_until, Date.now() + 3600000);
    t.mock.timers.tick(1000);
    f.snapshot('still-breached', 80);
    p = f.read(id);
    assert.equal(p.attention_state, 'snoozed');
    assert.equal(p.evidence.length, 2);
    t.mock.timers.tick(3600000);
    p = f.read(id);
    assert.equal(p.attention_state, 'open');
    assert.equal(p.state, 'open');
    p = monitorOperation(f.store, actor, {action: 'acknowledge_incident', id, revision: p.revision});
    p = monitorOperation(f.store, actor, {action: 'snooze_incident', id, revision: p.revision, snooze_hours: 24});
    p = monitorOperation(f.store, actor, {action: 'resume_incident', id, revision: p.revision});
    assert.equal(p.attention_state, 'acknowledged');
    assert.equal(p.snoozed_until, null);
    p = monitorOperation(f.store, actor, {action: 'snooze_incident', id, revision: p.revision, snooze_hours: 24});
    t.mock.timers.tick(1);
    f.snapshot('missing', 0, false);
    assert.equal(f.read(id).attention_state, 'snoozed');
    t.mock.timers.tick(1);
    f.snapshot('resolved', 40);
    p = f.read(id);
    assert.equal(p.attention_state, 'resolved');
    assert.equal(p.snoozed_until, null);
    assert.throws(() =>
      monitorOperation(f.store, actor, {action: 'snooze_incident', id, revision: p.revision, snooze_hours: 1}),
    );
    t.mock.timers.tick(1);
    f.snapshot('recurred', 70);
    p = f.read(id);
    assert.equal(p.attention_state, 'open');
    assert.equal(p.resolved_at, null);
    const events = f.store.db
      .prepare('SELECT event FROM audit WHERE tenant_id=?')
      .all(actor.tenantId)
      .map(r => JSON.parse(r.event).event);
    assert.ok(events.includes('incident_snoozed'));
    assert.ok(events.includes('incident_resumed'));
    assert.ok(events.includes('incident_acknowledged'));
  } finally {
    f.store.close();
  }
});
test('incident actions enforce revisions, current authority, duration bounds and independent filtering', () => {
  const f = fixture();
  try {
    const id = f.snapshot('first', 60).outcomes[0].id,
      p = f.read(id);
    for (const duration of [0, -1, 0.5, 169, '1'])
      assert.throws(() =>
        monitorOperation(f.store, actor, {action: 'snooze_incident', id, revision: p.revision, snooze_hours: duration}),
      );
    assert.throws(
      () =>
        monitorOperation(
          f.store,
          {...actor, role: 'reader'},
          {action: 'snooze_incident', id, revision: p.revision, snooze_hours: 1},
        ),
      {code: 'FORBIDDEN'},
    );
    const snoozed = monitorOperation(f.store, actor, {
      action: 'snooze_incident',
      id,
      revision: p.revision,
      snooze_hours: 1,
    });
    assert.throws(() => monitorOperation(f.store, actor, {action: 'resume_incident', id, revision: p.revision}), {
      code: 'REVISION_CONFLICT',
    });
    assert.equal(monitorOperation(f.store, actor, {action: 'incidents', state: 'open'}).incidents.length, 0);
    assert.equal(
      monitorOperation(f.store, actor, {action: 'incidents', state: 'snoozed', search: 'Spend', account_id: '100'})
        .incidents.length,
      1,
    );
    assert.equal(monitorOperation(f.store, actor, {action: 'incidents', account_id: '200'}).incidents.length, 0);
    assert.equal(snoozed.website_path, '/monitors?incident_id=' + id);
    f.store.putConnection(
      {...actor, role: 'admin'},
      {...f.store.listConnections(actor.tenantId)[0], enabled: false},
      {accessToken: 'synthetic'},
    );
    assert.throws(() => f.read(id));
    assert.throws(() => monitorOperation(f.store, actor, {action: 'resume_incident', id, revision: snoozed.revision}));
  } finally {
    f.store.close();
  }
});
test('inbox pagination reaches older incidents and rule revisions preserve paused state and historical evidence', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 107; i++)
      f.store.putDocument(actor.tenantId, 'report_incident', 'incident-' + String(i).padStart(3, '0'), {
        ...f.context,
        monitor_id: f.rule.id,
        monitor_name: 'Spend ceiling',
        state: 'open',
        updated_at: 1000 - i,
      });
    let offset = 0,
      ids = [];
    do {
      const page = monitorOperation(f.store, actor, {action: 'incidents', offset, limit: 20, state: 'open'});
      ids.push(...page.incidents.map(p => p.id));
      offset = page.next_offset;
    } while (offset !== null);
    assert.equal(ids.length, 107);
    assert.equal(new Set(ids).size, 107);
    assert.equal(ids.at(-1), 'incident-106');
    const paused = monitorOperation(f.store, actor, {
      action: 'set_monitor_state',
      id: f.rule.id,
      revision: f.rule.revision,
      active: false,
      confirmed: true,
    });
    const saved = monitorOperation(f.store, actor, {
      action: 'save_monitor',
      id: paused.id,
      revision: paused.revision,
      confirmed: true,
      monitor: {
        ...f.context,
        name: 'Revised ceiling',
        metric: 'spend',
        comparison: 'above',
        threshold: '70',
        max_age_hours: 24,
      },
    });
    assert.equal(saved.active, false);
    assert.equal(saved.rule_version, 2);
    assert.equal(f.read('incident-000').monitor_name, 'Spend ceiling');
    const superseded = f.read('incident-000');
    assert.equal(superseded.attention_state, 'superseded');
    assert.equal(superseded.state, 'open');
    assert.equal(superseded.superseded_by_version, 2);
    assert.equal(monitorOperation(f.store, actor, {action: 'incidents', state: 'open'}).total, 0);
    assert.throws(() =>
      monitorOperation(f.store, actor, {
        action: 'snooze_incident',
        id: superseded.id,
        revision: superseded.revision,
        snooze_hours: 1,
      }),
    );
    assert.throws(
      () =>
        monitorOperation(f.store, actor, {
          action: 'save_monitor',
          id: paused.id,
          revision: paused.revision,
          confirmed: true,
          monitor: {
            ...f.context,
            name: 'Stale edit',
            metric: 'spend',
            comparison: 'above',
            threshold: '80',
            max_age_hours: 24,
          },
        }),
      {code: 'REVISION_CONFLICT'},
    );
  } finally {
    f.store.close();
  }
});
