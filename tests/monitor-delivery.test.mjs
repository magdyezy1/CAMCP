import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {monitorOperation, evaluateMonitors} from '../dist/src/report-monitors.js';

function fixture(t) {
  const master = Buffer.alloc(32, 73).toString('base64');
  const store = new Store(':memory:', master),
    emails = [],
    gates = {status: 200};
  t.after(() => store.close());
  const web = new WebStore(store, {
    origin: 'https://workspace.example.test',
    masterKey: master,
    authEnv: {AMCP_EMAIL_API_KEY: 'synthetic-mail', AMCP_EMAIL_FROM: 'alerts@example.test'},
    fetcher: async (url, init) => {
      assert.equal(String(url), 'https://api.resend.com/emails');
      emails.push({payload: JSON.parse(init.body), key: init.headers['Idempotency-Key']});
      if (gates.wait) await gates.wait;
      if (gates.throw) throw Error('synthetic lost response');
      return new Response('{}', {status: gates.status});
    },
  });
  const accounts = new UserAccounts(web),
    user = accounts.newUser('Member', 'self@example.test', null, true);
  const actor = accounts.session(user).actor;
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
  const context = {
    platform: 'meta',
    connection_id: 'meta',
    account_id: '100',
    currency: 'USD',
    timezone: 'UTC',
    result_definition: 'Purchases',
    attribution: '7-day click',
  };
  const operation = (input, current = actor) => monitorOperation(store, current, input);
  const rule = operation({
    action: 'save_monitor',
    confirmed: true,
    monitor: {
      ...context,
      name: 'Private client ceiling',
      metric: 'spend',
      comparison: 'above',
      threshold: '50',
      max_age_hours: 24,
    },
  });
  const settings = () => operation({action: 'monitor_notifications', id: rule.id});
  const subscribe = (enabled = true) =>
    operation({
      action: 'set_monitor_notifications',
      id: rule.id,
      enabled,
      subscription_version: settings().subscription_version,
      confirmed: true,
    });
  let seq = 0;
  const snapshot = spend => {
    const group = {
        ...context,
        date_from: '2026-09-01',
        date_to: '2026-09-07',
        objective_group: 'sales',
        metrics: {spend},
        complete: true,
      },
      id = 'report-' + ++seq;
    store.putDocument(actor.tenantId, 'overview_report', id, {
      state: 'complete',
      config: {sources: [context]},
      rows: [{...group, captured_at: Date.now()}],
      summary: [group],
    });
    return evaluateMonitors(store, actor, id).outcomes[0].id;
  };
  return {store, web, accounts, actor, user, rule, context, operation, settings, subscribe, snapshot, emails, gates};
}

test('monitor email is explicit, self-only, deduplicated and carries no report or client details', async t => {
  const f = fixture(t);
  assert.equal(f.settings().enabled, false);
  f.snapshot(60);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 0);
  assert.throws(
    () =>
      f.operation({
        action: 'set_monitor_notifications',
        id: f.rule.id,
        enabled: true,
        subscription_version: f.settings().subscription_version,
      }),
    /Confirm/,
  );
  f.subscribe();
  f.snapshot(70); // opting in never backfills an already open incident
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 0);
  f.snapshot(40);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 1);
  const incident = f.snapshot(80);
  await f.accounts.deliverEmails();
  f.snapshot(85);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 2);
  const mail = f.emails.at(-1);
  assert.deepEqual(mail.payload.to, ['self@example.test']);
  assert.match(mail.payload.text, new RegExp('/monitors\\?incident_id=' + incident));
  assert.doesNotMatch(JSON.stringify(mail.payload), /Private client|Purchases|spend|7-day|actor_binding|amcp_monitor/);
  const status = f.settings();
  assert.equal(status.deliveries.length, 2);
  assert.ok(status.deliveries.every(d => d.state === 'sent'));
  assert.doesNotMatch(JSON.stringify(status), /self@example|synthetic-mail|actor_binding/);
});

test('opt-out, revised rules, revoked recipients and paused monitors cancel unsent mail', async t => {
  for (const change of ['unsubscribe', 'revision', 'membership', 'paused', 'email', 'acknowledged']) {
    const f = fixture(t);
    f.subscribe();
    const id = f.snapshot(60);
    if (change === 'unsubscribe') f.subscribe(false);
    if (change === 'revision')
      f.operation({
        action: 'save_monitor',
        id: f.rule.id,
        revision: f.store.document(f.actor.tenantId, 'report_monitor', f.rule.id).revision,
        confirmed: true,
        monitor: {
          ...f.context,
          name: 'Changed',
          metric: 'spend',
          comparison: 'above',
          threshold: '55',
          max_age_hours: 24,
        },
      });
    if (change === 'membership')
      f.store.db.prepare('UPDATE workspace_memberships SET active=0 WHERE user_id=?').run(f.user.id);
    if (change === 'paused')
      f.operation({
        action: 'set_monitor_state',
        id: f.rule.id,
        revision: f.store.document(f.actor.tenantId, 'report_monitor', f.rule.id).revision,
        active: false,
        confirmed: true,
      });
    if (change === 'email')
      f.store.db.prepare('UPDATE amcp_users SET email=? WHERE id=?').run('changed@example.test', f.user.id);
    if (change === 'acknowledged')
      f.operation({
        action: 'acknowledge_incident',
        id,
        revision: f.store.document(f.actor.tenantId, 'report_incident', id).revision,
      });
    await f.accounts.deliverEmails();
    assert.equal(f.emails.length, 0, change);
  }
});

test('temporary delivery failure retries the identical encrypted payload and provider identity', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-10-01T12:00:00Z')});
  const f = fixture(t);
  f.subscribe();
  f.snapshot(60);
  f.gates.throw = true;
  await f.accounts.deliverEmails();
  assert.equal(f.settings().deliveries[0].attempts, 1);
  assert.equal(f.settings().deliveries[0].state, 'queued');
  assert.equal(
    f.store.db.prepare('SELECT secret FROM amcp_email_outbox').get().secret.includes('self@example.test'),
    false,
  );
  t.mock.timers.tick(20000);
  f.gates.throw = false;
  await f.accounts.deliverEmails();
  assert.deepEqual(f.emails[0], f.emails[1]);
  assert.equal(f.settings().deliveries[0].state, 'sent');
  assert.equal(f.store.db.prepare('SELECT secret FROM amcp_email_outbox').get().secret, '');
});

test('five automatic attempts stop; one confirmed original-notice recovery permits at most ten total', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-10-01T12:00:00Z')});
  const f = fixture(t);
  f.subscribe();
  f.snapshot(60);
  f.gates.status = 503;
  for (let i = 0; i < 5; i++) {
    await f.accounts.deliverEmails();
    t.mock.timers.tick(180000);
  }
  let n = f.settings().deliveries[0];
  assert.equal(n.state, 'failed');
  assert.equal(n.attempts, 5);
  assert.equal(n.retry_available, true);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 5);
  assert.throws(
    () =>
      f.operation({
        action: 'retry_monitor_notification',
        notification_id: n.id,
        notification_version: 'old',
        confirmed: true,
      }),
    /Refresh/,
  );
  assert.throws(
    () =>
      f.operation({
        action: 'retry_monitor_notification',
        notification_id: n.id,
        notification_version: n.notification_version,
      }),
    /Confirm/,
  );
  f.operation({
    action: 'retry_monitor_notification',
    notification_id: n.id,
    notification_version: n.notification_version,
    confirmed: true,
  });
  for (let i = 0; i < 5; i++) {
    await f.accounts.deliverEmails();
    t.mock.timers.tick(180000);
  }
  n = f.settings().deliveries[0];
  assert.equal(n.state, 'failed');
  assert.equal(n.attempts, 10);
  assert.equal(n.retry_available, false);
  assert.equal(new Set(f.emails.map(e => e.key)).size, 1);
  t.mock.timers.tick(86400000);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 10);
  assert.equal(f.store.db.prepare('SELECT secret FROM amcp_email_outbox').get().secret, '');
});

test('a lost response after opt-out cannot resurrect its cancelled notice or encrypted recipient', async t => {
  const f = fixture(t);
  f.subscribe();
  f.snapshot(60);
  f.gates.throw = true;
  let release;
  f.gates.wait = new Promise(resolve => {
    release = resolve;
  });
  const pending = f.accounts.deliverEmails();
  assert.equal(f.emails.length, 1);
  f.subscribe(false);
  release();
  await pending;
  assert.equal(f.settings().deliveries[0].state, 'cancelled');
  assert.equal(f.store.documents(f.actor.tenantId, 'monitor_notice')[0].state, 'cancelled');
  assert.equal(f.store.db.prepare('SELECT secret FROM amcp_email_outbox').get().secret, '');
});

test('an exhausted reclaimed mail lease cannot exceed the attempt budget', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-10-01T12:00:00Z')});
  const f = fixture(t);
  f.subscribe();
  f.snapshot(60);
  f.gates.status = 503;
  await f.accounts.deliverEmails();
  f.store.db
    .prepare("UPDATE amcp_email_outbox SET state='sending',attempts=5,lease_until=?,available_at=?")
    .run(Date.now() - 1, Date.now() - 1);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 1);
  assert.equal(f.settings().deliveries[0].state, 'failed');
  assert.equal(f.settings().deliveries[0].attempts, 5);
});

test('snooze defers an unsent notice; a resolution replaces it; stale or missing evidence is withheld', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-10-01T12:00:00Z')});
  const f = fixture(t);
  f.subscribe();
  const id = f.snapshot(60);
  f.operation({
    action: 'snooze_incident',
    id,
    revision: f.store.document(f.actor.tenantId, 'report_incident', id).revision,
    snooze_hours: 1,
  });
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 0);
  t.mock.timers.tick(3600001);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 1);
  f.snapshot(40);
  f.snapshot(60);
  await f.accounts.deliverEmails();
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 2);
  assert.ok(f.emails.every(e => e.payload.subject === 'AMCP monitor needs attention'));
  f.snapshot(40);
  const latest = f.store.document(f.actor.tenantId, 'report_incident', id).last_report_id;
  f.store.db
    .prepare("DELETE FROM documents WHERE tenant_id=? AND kind='overview_report' AND id=?")
    .run(f.actor.tenantId, latest);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 2);
});

test('recipient, current author authority, scoped history and version confirmations remain separate', async t => {
  const f = fixture(t),
    old = f.settings().subscription_version;
  f.subscribe();
  assert.throws(
    () =>
      f.operation({
        action: 'set_monitor_notifications',
        id: f.rule.id,
        enabled: false,
        subscription_version: old,
        confirmed: true,
      }),
    /Refresh/,
  );
  assert.throws(
    () =>
      f.operation({
        action: 'set_monitor_notifications',
        id: f.rule.id,
        enabled: true,
        email: 'other@example.test',
        subscription_version: f.settings().subscription_version,
        confirmed: true,
      }),
    /own verified/,
  );
  const second = f.accounts.newUser('Second', 'second@example.test', null, true);
  f.store.db
    .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,active,created_at) VALUES(?,?,'viewer',1,?)")
    .run(f.actor.tenantId, second.id, Date.now());
  const reader = f.accounts.session(second, f.actor.tenantId).actor;
  let settings = f.operation({action: 'monitor_notifications', id: f.rule.id}, reader);
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.deliveries, []);
  f.operation(
    {
      action: 'set_monitor_notifications',
      id: f.rule.id,
      subscription_version: settings.subscription_version,
      enabled: true,
      confirmed: true,
    },
    reader,
  );
  f.snapshot(60);
  await f.accounts.deliverEmails();
  await f.accounts.deliverEmails();
  assert.deepEqual(f.emails.map(e => e.payload.to[0]).sort(), ['second@example.test', 'self@example.test']);
  assert.equal(f.settings().deliveries.length, 1);
  f.snapshot(40);
  f.store.db.prepare('UPDATE amcp_users SET version=version+1 WHERE id=?').run(f.user.id);
  await f.accounts.deliverEmails();
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 2); // revocation of the rule author also stops the viewer's alert
});

test('parallel workers share the original lease; permanent failures cannot be recovered', async t => {
  const f = fixture(t);
  f.subscribe();
  f.snapshot(60);
  let release;
  f.gates.wait = new Promise(resolve => {
    release = resolve;
  });
  f.gates.status = 422;
  const first = f.accounts.deliverEmails(),
    second = new UserAccounts(f.web).deliverEmails();
  await second;
  assert.equal(f.emails.length, 1);
  release();
  await first;
  const n = f.settings().deliveries[0];
  assert.equal(n.state, 'failed');
  assert.equal(n.retry_available, false);
  assert.equal(f.store.db.prepare('SELECT secret FROM amcp_email_outbox').get().secret, '');
});

test('pause followed by resume never resurrects pending notices; disabled transport still expires private payloads', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-10-01T12:00:00Z')});
  const f = fixture(t);
  f.subscribe();
  f.snapshot(60);
  f.gates.status = 503;
  await f.accounts.deliverEmails();
  for (const active of [false, true])
    f.operation({
      action: 'set_monitor_state',
      id: f.rule.id,
      revision: f.store.document(f.actor.tenantId, 'report_monitor', f.rule.id).revision,
      active,
      confirmed: true,
    });
  t.mock.timers.tick(30000);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 1);
  f.snapshot(40);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 2);
  f.accounts.env.AMCP_EMAIL_API_KEY = '';
  t.mock.timers.tick(86400000);
  await f.accounts.deliverEmails();
  assert.ok(
    f.store.db
      .prepare('SELECT secret FROM amcp_email_outbox')
      .all()
      .every(r => r.secret === ''),
  );
  t.mock.timers.tick(30 * 86400000);
  await f.accounts.deliverEmails();
  assert.equal(f.store.documents(f.actor.tenantId, 'monitor_notice').length, 0);
});

test('mail overload and lost connectivity preserve the inbox; current source and identity guards still apply on retry', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-10-01T12:00:00Z')});
  const f = fixture(t);
  f.subscribe();
  f.snapshot(60);
  f.gates.status = 409;
  await f.accounts.deliverEmails();
  assert.equal(f.settings().deliveries[0].state, 'queued');
  f.store.putConnection(
    f.actor,
    {
      id: 'meta',
      tenantId: f.actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: false,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  t.mock.timers.tick(30000);
  await f.accounts.deliverEmails();
  assert.equal(f.emails.length, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM amcp_email_outbox').get().state, 'cancelled');
  assert.equal(f.store.db.prepare('SELECT secret FROM amcp_email_outbox').get().secret, '');
});

test('bounded notice capacity preserves incident evaluation and admin/test identities cannot opt in', t => {
  const f = fixture(t);
  f.subscribe();
  for (let i = 0; i < 1000; i++)
    f.store.putDocument(f.actor.tenantId, 'monitor_notice', 'filled-' + i, {
      expires_at: Date.now() + 86400000,
      state: 'sent',
    });
  const id = f.snapshot(60);
  assert.equal(f.store.document(f.actor.tenantId, 'report_incident', id).state, 'open');
  assert.equal(f.store.documents(f.actor.tenantId, 'monitor_notice').length, 1000);
  const admin = {...f.actor, userId: 'workspace-admin', ownerUserId: undefined};
  const status = f.operation({action: 'monitor_notifications', id: f.rule.id}, admin);
  assert.equal(status.eligible, false);
  assert.deepEqual(status.deliveries, []);
  assert.throws(
    () =>
      f.operation(
        {
          action: 'set_monitor_notifications',
          id: f.rule.id,
          enabled: true,
          subscription_version: status.subscription_version,
          confirmed: true,
        },
        admin,
      ),
    /verified personal/,
  );
});
