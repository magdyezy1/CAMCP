import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
function fixture(locale) {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [],
    confirmations = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        textContent: '',
        isConnected: true,
        elements: {},
        setAttribute() {},
        focus() {},
        addEventListener() {},
        querySelector: node,
        querySelectorAll: () => [],
      });
    return nodes.get(key);
  };
  const esc = v =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const context = createContext({
    document: {addEventListener() {}, querySelector: node, querySelectorAll: () => []},
    $: node,
    root: node('root'),
    esc,
    pretty: v => String(v ?? '').replaceAll('_', ' '),
    date: String,
    badge: esc,
    recordDetails: value => '<pre>' + esc(JSON.stringify(value)) + '</pre>',
    errorMessage: e => e.message,
    Intl,
    Date,
    URLSearchParams,
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'operator'},
    toast() {},
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    approved: false,
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    confirmAction: async options => {
      confirmations.push(plain(options));
      return context.approved;
    },
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync('web/operations-center.js', 'utf8'));
  run(readFileSync('web/workbook-schedules.js', 'utf8'));
  const respond = handler => {
    context.workspaceCall = async (tool, args) => {
      calls.push({tool, args: plain(args)});
      return handler(args);
    };
  };
  return {run, context, node, bindings, calls, confirmations, respond};
}

test('Arabic workbook recovery retains original run identity and refuses a cancelled confirmation', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      record = {
        id: 'run-001',
        name: 'Home <img>',
        state: 'prepared',
        gateway: 'meta_native_action',
        account_id: '001',
        connection_id: 'login-001',
        query_id: 'query-001',
        query_revision: 7,
        attempts: 1,
        can_resume: true,
        run_version: 'exact-version',
        next_safe_action: 'Provider guidance',
        created_at: 1,
        updated_at: 2,
      };
    f.respond(args => (args.action === 'report_run' ? record : {}));
    const controller = f.run("workbookRunController(root,'run-001')");
    await controller.load();
    assert.match(f.node('root').innerHTML, /Home &lt;img&gt;/);
    if (locale === 'ar') assert.match(f.node('root').innerHTML, /استئناف التقرير/);
    await f.bindings.get('#workbook-run-resume')();
    assert.equal(f.calls.length, 1);
    f.context.approved = true;
    await f.bindings.get('#workbook-run-resume')();
    assert.match(f.confirmations[1].consequence, /001/);
    if (locale === 'ar') assert.match(f.confirmations[1].title, /استئناف/);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.deepEqual(transcripts[0][1], {
    tool: 'workspace',
    args: {action: 'resume_report_run', id: 'run-001', run_version: 'exact-version', confirmed: true},
  });
});

test('Arabic query review preserves advanced native config and exact revision through confirmation', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      config = {
        gateway: 'meta_native_action',
        account_id: '001',
        connection_id: 'login-001',
        action: 'meta_insights',
        fields: ['spend', 'clicks'],
        name: 'Home',
        custom_amount: '0012.340000',
      },
      record = {
        id: 'query-001',
        name: 'Home',
        query_version: 'exact-query-version',
        can_edit: true,
        account_id: '001',
        gateway: 'meta_native_action',
        connection_id: 'login-001',
        schedules: [],
        query_config: config,
      };
    f.respond(args =>
      args.action === 'report_query'
        ? record
        : args.action === 'preview_report_query'
          ? {
              query: args.query,
              query_version: record.query_version,
              schedules_to_pause: 2,
              changes: ['name', 'query_config'],
            }
          : {prepared_run_id: 'prepared-001'},
    );
    const controller = f.run("workbookQueryController(root,'query-001')");
    await controller.load();
    if (locale === 'ar') assert.match(f.node('root').innerHTML, /إعدادات الاستعلام المتقدمة/);
    const form = {elements: {name: {value: 'Home <img>'}, configuration: {value: JSON.stringify(config)}}};
    await f.bindings.get('#workbook-query-form')(form);
    await f.bindings.get('#workbook-query-save')();
    assert.equal(f.calls.length, 2);
    f.context.approved = true;
    await f.bindings.get('#workbook-query-save')();
    assert.match(f.confirmations[1].consequence, /2/);
    if (locale === 'ar') assert.match(f.confirmations[1].title, /حفظ/);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.equal(transcripts[0][2].args.query.query_config.custom_amount, '0012.340000');
  assert.equal(transcripts[0][2].args.query_version, 'exact-query-version');
  assert.equal(transcripts[0][2].args.confirmed, true);
});

test('Arabic schedule previews retain native clock values and only save the inspected version', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      field = value => ({value, addEventListener() {}}),
      form = f.node('#workbook-schedule-form');
    form.elements = {
      name: field('Home'),
      timezone: field('Africa/Cairo'),
      schedule_kind: field('weekly'),
      weekday: field('0'),
      day: field('1'),
      hour: field('23'),
      minute: field('55'),
      active: {checked: false},
    };
    const record = {
      id: 'schedule-001',
      name: 'Home',
      state: 'active',
      active: true,
      schedule_kind: 'weekly',
      schedule: {hour: 9, minute: 0, weekday: 1},
      timezone: 'UTC',
      query_id: 'query-001',
      query_revision: 7,
      account_id: '001',
      can_edit: true,
      schedule_version: 'exact-schedule-version',
      occurrences: [Date.UTC(2026, 9, 5, 9)],
      meaning: 'Original semantics',
      last_run: null,
    };
    f.respond(args =>
      args.action === 'report_schedule'
        ? record
        : args.action === 'preview_report_schedule'
          ? {
              id: record.id,
              active: args.active,
              account_id: '001',
              query_revision: 7,
              schedule: args.schedule,
              occurrences: record.occurrences,
              changes: [{field: 'active', from: true, to: false}],
            }
          : {},
    );
    const controller = f.run("workbookScheduleController(root,'schedule-001')");
    await controller.load();
    if (locale === 'ar') {
      assert.match(f.node('root').innerHTML, /مراجعة تغييرات الجدول/);
      assert.ok(
        f
          .node('root')
          .innerHTML.includes(
            new Intl.DateTimeFormat('ar', {timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short'}).format(
              record.occurrences[0],
            ),
          ),
      );
      assert.match(f.node('root').innerHTML, /value="weekly"/);
    }
    await f.bindings.get('#workbook-schedule-form')(form);
    assert.equal(f.calls.length, 2);
    f.context.approved = true;
    await f.bindings.get('#workbook-schedule-form')(form);
    assert.match(f.confirmations[1].consequence, /Africa\/Cairo/);
    assert.match(f.confirmations[1].consequence, /Home/);
    if (locale === 'ar') assert.match(f.confirmations[1].title, /حفظ/);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.deepEqual(transcripts[0][3].args, {
    action: 'save_report_schedule',
    id: 'schedule-001',
    schedule_version: 'exact-schedule-version',
    confirmed: true,
    active: false,
    schedule: {name: 'Home', timezone: 'Africa/Cairo', schedule_kind: 'weekly', hour: 23, minute: 55, weekday: 0},
  });
});

test('Arabic personal monitor notices retain explicit consent and original subscription or notice version', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      settings = {
        eligible: true,
        enabled: false,
        subscription_version: 'exact-subscription-version',
        deliveries: [
          {
            id: 'notice-001',
            incident_id: 'incident-001',
            event: 'opened',
            state: 'failed',
            attempts: 5,
            created_at: 1,
            retry_available: true,
            notification_version: 'exact-notice-version',
          },
        ],
      };
    f.respond(args => (args.action === 'monitor_notifications' ? settings : {}));
    const controller = f.run("monitorNotificationController(root,'rule-001')");
    await controller.load();
    if (locale === 'ar') assert.match(f.node('root').innerHTML, /إشعاراتك عبر البريد/);
    await f.bindings.get('#monitor-email-toggle')();
    assert.equal(f.calls.length, 1);
    f.context.approved = true;
    await f.bindings.get('#monitor-email-toggle')();
    await f.bindings.get('[data-retry-monitor-notice]')({dataset: {retryMonitorNotice: 'notice-001'}});
    if (locale === 'ar') assert.match(f.confirmations[1].title, /تفعيل/);
    f.context.monitorContext = {
      platform: 'meta',
      connection_id: 'login-001',
      account_id: '001',
      currency: 'USD',
      timezone: 'Africa/Cairo',
      result_definition: 'Home',
      attribution: '7d_click',
    };
    f.context.form = {
      elements: {
        name: {value: 'Home'},
        metric: {value: 'spend'},
        comparison: {value: 'above'},
        threshold: {value: '0012.340000'},
        max_age_hours: {value: '24'},
      },
    };
    assert.deepEqual(plain(f.run('monitorValues(form,monitorContext)')), {
      ...f.context.monitorContext,
      name: 'Home',
      metric: 'spend',
      comparison: 'above',
      threshold: '0012.340000',
      max_age_hours: 24,
    });
    assert.equal(f.run("operationLabel('native_unknown_code')"), 'native unknown code');
    if (locale === 'ar') assert.match(f.run("operationLabel('sent')"), /قبله مزوّد البريد/);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.deepEqual(transcripts[0][1].args, {
    action: 'set_monitor_notifications',
    id: 'rule-001',
    enabled: true,
    subscription_version: 'exact-subscription-version',
    confirmed: true,
  });
  assert.deepEqual(transcripts[0][3].args, {
    action: 'retry_monitor_notification',
    notification_id: 'notice-001',
    notification_version: 'exact-notice-version',
    confirmed: true,
  });
});
