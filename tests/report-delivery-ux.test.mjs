// EXP-04 slices A and B: the delivery dialog's status bar and receipt, export-only choices that are not setup edits,
// AMCP's own leave confirmation, schedule times labelled with their zone (delivery zone first), the live
// "Next 3 deliveries" preview and the /schedules preview table. Synthetic page model only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const app = readFileSync('web/app.js', 'utf8');

function fixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [],
    confirmations = [],
    timers = [],
    focused = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        id: key,
        value: '',
        innerHTML: '',
        textContent: '',
        className: '',
        hidden: false,
        checked: false,
        dataset: {},
        elements: {},
        values: {},
        listeners: {},
        attributes: {},
        isConnected: true,
        open: false,
        addEventListener(type, fn) {
          (this.listeners[type] ??= []).push(fn);
        },
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        focus() {
          focused.push(key);
        },
        closest: () => ({hidden: false}),
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      });
    return nodes.get(key);
  };
  const config = {
    name: 'Weekly sales',
    client_name: 'Client A',
    grain: 'total',
    partial_delivery: 'allow_marked',
    sources: [{platform: 'meta', connection_id: 'login-1', account_id: '123'}],
    date_range: {preset: 'last_complete_days', days: 7, offset_days: 0, timezone: 'Asia/Riyadh'},
    metrics: ['spend'],
    custom_metrics: [],
    targets: {},
    objectives: [],
  };
  const bootstrap = {
    platforms: [{id: 'meta', name: 'Meta', accounts: [{connection_id: 'login-1', account_id: '123', label: 'Main'}]}],
    metrics: {spend: {label: 'Spend', format: 'currency'}},
    views: [],
    templates: [],
    schedules: [],
    sheets_connections: [],
    destinations: [
      {id: 'tab-a', name: 'Client sheet', tab_name: 'Client A', spreadsheet_id: 'sheet1', sheet_id: 7, owners: []},
    ],
    file_destinations: [],
  };
  let handler = args => (args.action === 'bootstrap' ? bootstrap : {});
  const context = createContext({
    Intl,
    Date,
    URLSearchParams,
    structuredClone,
    CSS: {escape: String},
    crypto: {randomUUID: () => 'stable-key'},
    document: {addEventListener() {}, querySelector: node, querySelectorAll: () => []},
    $: node,
    content: node('content'),
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    authBind: (s, fn) => bindings.set(s, fn),
    workspaceBind: (s, fn) => bindings.set(s, fn),
    date: v => 'at-' + v,
    badge: String,
    blank: String,
    toast() {},
    clearTimeout() {},
    setTimeout: (fn, delay) => timers.push({fn, delay}),
    pollTimer: null,
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'operator', authenticated: true},
    location: {pathname: '/reporting-overview', search: ''},
    history: {replaceState() {}},
    approved: false,
    confirm: () => {
      throw Error('The browser confirm() must not be used');
    },
    confirmAction: async options => {
      confirmations.push(plain(options));
      return context.approved;
    },
    api: async (_url, options) => {
      const args = JSON.parse(options.body);
      calls.push(args);
      try {
        return {success: true, data: await handler(args)};
      } catch (error) {
        return {success: false, error: plain({message: error.message, ...error}), meta: {requestId: 'req-42'}};
      }
    },
    FormData: class {
      constructor(form) {
        this.values = form.values;
      }
      get(k) {
        return this.values[k] ?? null;
      }
      getAll(k) {
        const v = this.values[k];
        return Array.isArray(v) ? v : v === undefined ? [] : [v];
      }
      *[Symbol.iterator]() {
        yield* Object.entries(this.values);
      }
    },
    config,
    bootstrap,
    catalog,
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  // AMCP's own error text (reference IDs, catalogued messages) and request errors, as the page has them.
  run(app.slice(app.indexOf('function requestError('), app.indexOf('const content =')));
  for (const file of ['report-library', 'report-quality', 'report-workflows', 'report-delivery', 'reporting-overview'])
    run(readFileSync('web/' + file + '.js', 'utf8'));
  run(
    `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});` +
      'uiViewerTimeZone=()=>"Europe/London";overviewState.bootstrap=bootstrap;overviewState.config=config;',
  );
  for (const key of [
    'report_name',
    'partial_delivery',
    'schedule_kind',
    'hour',
    'minute',
    'weekday',
    'day',
    'timezone',
    'preset',
    'days',
    'offset_days',
    'window_timezone',
  ])
    node('#report-schedule').elements[key] = node('schedule:' + key);
  node('#report-delivery-dialog');
  return {
    run,
    context,
    node,
    bindings,
    calls,
    confirmations,
    timers,
    focused,
    config,
    bootstrap,
    respond: fn => {
      handler = fn;
    },
  };
}
const snapshot = config => ({
  id: 'snap-1',
  state: 'complete',
  row_count: 42,
  captured_at: Date.UTC(2026, 9, 9, 5, 0),
  config: {...config, name: 'Weekly sales'},
  schedule_id: null,
  view_id: null,
});

test('EXP-04 A: the status bar sits after the export action at the foot of the dialog and styles every tone', async () => {
  const f = fixture();
  f.context.snap = snapshot(f.config);
  f.run('overviewState.report = snap');
  await f.run("renderReportDelivery('sheets_now')");
  const html = f.node('#report-delivery-content').innerHTML;
  assert.ok(html.indexOf('id="report-export-now"') < html.indexOf('id="delivery-status"'));
  assert.match(
    html,
    /<div id="delivery-status" class="delivery-status" role="status" aria-live="polite" tabindex="-1" hidden><\/div>\s*$/,
  );
  const css = readFileSync('web/reporting.css', 'utf8');
  const rule = css.slice(css.indexOf('.report-delivery-dialog .delivery-status {'));
  assert.match(rule.slice(0, rule.indexOf('}')), /position: sticky;\s*bottom: 0;/);
  for (const [tone, token] of [
    ['success', '--success-bg'],
    ['warning', '--warning-bg'],
    ['error', '--danger-bg'],
  ])
    assert.match(css, new RegExp('\\.delivery-status\\.' + tone + ' \\{[^}]*var\\(' + token + '\\)'));
  // The dark theme no longer paints every message one colour over the tone (the old success box for errors).
  assert.doesNotMatch(readFileSync('web/theme.css', 'utf8'), /#delivery-status/);
});

test('EXP-04 A: a refused export shows the error tone, Arabic for a catalogued server message and its reference', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.snap = snapshot(f.config);
    f.run('overviewState.report = snap');
    await f.run("renderReportDelivery('sheets_now')");
    f.node('#report-destination').value = 'tab-a';
    f.node('#report-export-confirm').checked = true;
    f.respond(args => {
      if (args.action === 'export')
        throw Object.assign(Error('Another export is using this destination.'), {code: 'EXPORT_BUSY'});
      return f.bootstrap;
    });
    await f.bindings.get('#report-export-now')();
    const bar = f.node('#delivery-status');
    assert.equal(bar.className, 'delivery-status error', locale);
    assert.equal(bar.hidden, false);
    assert.equal(f.focused.at(-1), '#delivery-status', 'focus moves to the status bar');
    if (locale === 'ar') {
      assert.match(bar.textContent, /تستخدم عملية تصدير أخرى هذه الوجهة/);
      assert.match(bar.textContent, /المرجع: req-42/);
    } else assert.equal(bar.textContent, 'Another export is using this destination. Reference: req-42');
  }
});

test('EXP-04 A: a finished export states a receipt with rows, tab, spreadsheet and the snapshot capture time', async () => {
  const f = fixture();
  f.context.snap = snapshot(f.config);
  f.run('overviewState.report = snap');
  await f.run("renderReportDelivery('sheets_now')");
  f.node('#report-destination').value = 'tab-a';
  f.node('#report-export-confirm').checked = true;
  const completed = Date.UTC(2026, 9, 9, 6, 30);
  f.respond(args =>
    args.action === 'export'
      ? {id: 'export-1', state: 'queued'}
      : args.action === 'export_status'
        ? {
            id: 'export-1',
            report_id: 'snap-1',
            destination_id: 'tab-a',
            state: 'complete',
            outcome: 'complete',
            rows: 42,
            completed_at: completed,
            url: 'https://docs.google.com/spreadsheets/d/sheet1/edit#gid=7',
            job: {state: 'complete'},
          }
        : f.bootstrap,
  );
  await f.bindings.get('#report-export-now')();
  const bar = f.node('#delivery-status');
  assert.equal(bar.className, 'delivery-status success');
  assert.match(bar.innerHTML, /Exported 42 rows to the tab “Client A” in “Client sheet” at /);
  assert.ok(bar.innerHTML.includes(f.run(`uiDateZoned(${completed})`)), 'the receipt time names its zone');
  assert.match(bar.innerHTML, /Snapshot captured /);
  assert.match(bar.innerHTML, /Open Google Sheets ↗/);
  assert.equal(f.focused.at(-1), '#delivery-status');
});

test('EXP-04 A regression: choosing a tab for an export-only action is not a setup edit and raises no prompt', async () => {
  const f = fixture();
  f.context.snap = snapshot(f.config);
  f.run('overviewState.report = snap');
  f.run("overviewState.destinationId='saved-destination';overviewState.dirty=false");
  await f.run("renderReportDelivery('sheets_now')");
  const select = f.node('#report-destination');
  select.value = 'tab-a';
  for (const listener of select.listeners.change) listener({target: select});
  // The old dialog marked the setup changed and replaced the report's saved destination here.
  assert.equal(f.run('overviewState.dirty'), false);
  assert.equal(f.run('overviewState.destinationId'), 'saved-destination');
  assert.equal(f.run('overviewState.exportDestinationId'), 'tab-a');
  assert.equal(await f.run('overviewMayLeave()'), true);
  assert.equal(f.confirmations.length, 0, 'opening another snapshot after an export-only action asks nothing');
  // The export choice is preselected the next time, without touching the report's own destination.
  await f.run("renderReportDelivery('sheets_now')");
  assert.match(f.node('#report-delivery-content').innerHTML, /<option value="tab-a" selected/);
});

test('EXP-04 A: unsaved setup edits are confirmed in AMCP’s own dialog instead of the browser’s confirm()', async () => {
  const f = fixture('ar');
  f.run('overviewState.dirty=true');
  assert.equal(await f.run('overviewMayLeave()'), false);
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0].title, /هل تريد تجاهل التغييرات غير المحفوظة/);
  assert.notEqual(f.confirmations[0].confirmLabel, 'Discard changes');
  f.context.approved = true;
  assert.equal(await f.run('overviewMayLeave()'), true);
  // In the delivery dialog (not export-only) a destination choice is still an edit of the report's setup.
  await f.run('renderReportDelivery()');
  f.run('overviewState.dirty=false');
  const select = f.node('#report-destination');
  select.value = 'tab-a';
  for (const listener of select.listeners.change) listener({target: select});
  assert.equal(f.run('overviewState.dirty'), true);
  assert.equal(f.run('overviewState.destinationId'), 'tab-a');
});

test('EXP-04 B: schedule times lead with the delivery zone across the America/New_York DST changes (EN/AR)', () => {
  const f = fixture();
  const zoned = (at, zone) => f.run(`uiZonedTime(${at}, ${JSON.stringify(zone)})`);
  // March 8, 2026: 02:00 EST becomes 03:00 EDT. November 1, 2026: 02:00 EDT becomes 01:00 EST.
  assert.match(zoned(Date.UTC(2026, 2, 8, 6, 30), 'America/New_York'), /Mar 8, 2026, 1:30\sAM EST/);
  assert.match(zoned(Date.UTC(2026, 2, 8, 7, 30), 'America/New_York'), /Mar 8, 2026, 3:30\sAM EDT/);
  assert.match(zoned(Date.UTC(2026, 10, 1, 5, 30), 'America/New_York'), /Nov 1, 2026, 1:30\sAM EDT/);
  assert.match(zoned(Date.UTC(2026, 10, 1, 6, 30), 'America/New_York'), /Nov 1, 2026, 1:30\sAM EST/);
  // The delivery zone comes first and is named; the viewer's own time (London here) follows.
  const label = f.run(`uiScheduleTime(${Date.UTC(2026, 9, 12, 5)}, 'Asia/Riyadh')`);
  assert.match(
    label,
    /^Mon, Oct 12, 2026, 8:00\sAM GMT\+3 \(Asia\/Riyadh\) · your time: Mon, Oct 12, 2026, 6:00\sAM GMT\+1$/,
  );
  assert.doesNotMatch(f.run(`uiScheduleTime(${Date.UTC(2026, 9, 12, 5)}, 'Europe/London')`), /your time/);
  const ar = fixture('ar');
  const arabic = ar.run(`uiScheduleTime(${Date.UTC(2026, 2, 8, 7, 30)}, 'America/New_York')`);
  assert.match(arabic, /\(America\/New_York\) · وقتك: /);
  assert.notEqual(arabic, f.run(`uiScheduleTime(${Date.UTC(2026, 2, 8, 7, 30)}, 'America/New_York')`));
  assert.match(arabic, /[0-9]/, 'Latin digits (owner decision D27)');
  assert.doesNotMatch(arabic, /[٠-٩]/);
});

test('EXP-04 B: the delivery dialog previews the next three deliveries of unsaved settings and follows edits', async () => {
  const f = fixture();
  await f.run('renderReportDelivery()');
  const form = f.node('#report-schedule');
  form.values = {
    report_name: 'Weekly sales',
    partial_delivery: 'allow_marked',
    schedule_kind: 'daily',
    hour: '8',
    minute: '0',
    timezone: 'Asia/Riyadh',
    preset: 'last_complete_days',
    days: '7',
    offset_days: '0',
    window_timezone: 'Asia/Riyadh',
  };
  const occurrence = (day, dst = false) => ({
    delivery_at: new Date(Date.UTC(2026, 9, day, 5)).toISOString(),
    delivery_timezone: 'Asia/Riyadh',
    window_timezone: 'Asia/Riyadh',
    date_range: {since: '2026-10-0' + (day - 7), until: '2026-10-' + String(day - 1).padStart(2, '0')},
    sources: [{platform: 'meta', account_id: '123', open_at_delivery: false}],
    ...(dst ? {dst_shifted: true} : {}),
  });
  f.respond(args =>
    args.action === 'preview_schedule'
      ? {network_requests: 0, occurrences: [occurrence(10), occurrence(11, true), occurrence(12)]}
      : f.bootstrap,
  );
  // The first preview is scheduled when the dialog opens; edits schedule another, debounced.
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 0);
  await f.timers.shift().fn();
  const request = f.calls.find(c => c.action === 'preview_schedule');
  assert.deepEqual(plain(request.schedule), {
    schedule_kind: 'daily',
    timezone: 'Asia/Riyadh',
    schedule_config: {minute: 0, hour: 8},
  });
  assert.equal(request.config.date_range.timezone, 'Asia/Riyadh');
  assert.equal(request.confirmed, undefined, 'a preview is not a save');
  const html = f.node('#delivery-schedule-preview').innerHTML;
  assert.match(html, /<caption>Next 3 deliveries<\/caption>/);
  assert.match(
    html,
    /Delivery time \(Asia\/Riyadh\)<\/th><th scope="col">Your time \(Europe\/London\)<\/th><th scope="col">Collected dates \(Asia\/Riyadh\)/,
  );
  assert.equal((html.match(/<tr><th scope="row">/g) ?? []).length, 3);
  assert.match(html, /Oct 10, 2026, 8:00\sAM GMT\+3/);
  assert.match(html, /Moved forward by the daylight-saving change/);
  assert.doesNotMatch(html, /delivery_at|\/0\//, 'no raw JSON-pointer dump');
  // An edit of the clock schedules a new, debounced preview; the hourly warning follows the frequency.
  form.values = {...form.values, schedule_kind: 'hourly'};
  f.node('schedule:schedule_kind').value = 'hourly';
  for (const listener of form.listeners.change) listener();
  assert.equal(f.node('#delivery-hourly-warning').hidden, false);
  assert.equal(f.timers.at(-1).delay, 400);
  await f.timers.at(-1).fn();
  assert.deepEqual(plain(f.calls.filter(c => c.action === 'preview_schedule').at(-1).schedule.schedule_config), {
    minute: 0,
  });
  f.node('schedule:schedule_kind').value = 'daily';
  for (const listener of form.listeners.change) listener();
  assert.equal(f.node('#delivery-hourly-warning').hidden, true);
});

test('EXP-04 B: a stale or refused preview never replaces the newest one, and refusals stay in the preview', async () => {
  const f = fixture();
  await f.run('renderReportDelivery()');
  f.node('#report-schedule').values = {schedule_kind: 'daily', hour: '', minute: '0', timezone: 'Mars/Base'};
  f.respond(args => {
    if (args.action === 'preview_schedule')
      throw Object.assign(Error('Provide an IANA timezone.'), {code: 'INVALID_TIMEZONE'});
    return f.bootstrap;
  });
  const first = f.timers.shift();
  f.run('deliveryPreviewSoon(config, () => true)');
  await first.fn();
  assert.equal(f.calls.filter(c => c.action === 'preview_schedule').length, 0, 'a superseded preview is not sent');
  await f.timers.at(-1).fn();
  assert.match(
    f.node('#delivery-schedule-preview').innerHTML,
    /No preview for these settings yet: Provide an IANA timezone\./,
  );
  assert.equal(f.node('#delivery-status').className, '', 'a preview refusal is not a delivery status');
});

test('EXP-04 B: saved schedules name the zone of their next delivery, and the save message does too', async () => {
  const f = fixture();
  f.bootstrap.schedules.push({
    id: 'schedule-1',
    view_id: 'view-1',
    revision: 2,
    config: f.config,
    schedule_kind: 'weekly',
    timezone: 'Asia/Riyadh',
    schedule_config: {hour: 8, minute: 0, weekday: 1},
    destination_id: 'tab-a',
    is_active: true,
    next_run_at: Date.UTC(2026, 9, 12, 5),
  });
  await f.run('renderReportDelivery()');
  const html = f.node('#report-delivery-content').innerHTML;
  assert.match(
    html,
    /Next: Mon, Oct 12, 2026, 8:00\sAM GMT\+3 \(Asia\/Riyadh\) · your time: Mon, Oct 12, 2026, 6:00\sAM GMT\+1/,
  );
  assert.doesNotMatch(html, /Next: at-/);
  // Saving a new schedule reports its next run in the delivery zone, then the viewer's time.
  f.bootstrap.views.push({id: 'view-2', revision: 1, config: f.config});
  f.run('renderReportingOverview = async () => {}');
  f.node('#report-destination').value = 'tab-a';
  f.respond(args =>
    args.action === 'schedule'
      ? {view_id: 'view-2', is_active: true, next_run_at: Date.UTC(2026, 9, 13, 5), timezone: 'Asia/Riyadh'}
      : f.bootstrap,
  );
  await f.bindings.get('#report-schedule')({
    dataset: {},
    values: {
      report_name: 'Weekly sales',
      partial_delivery: 'allow_marked',
      schedule_kind: 'daily',
      hour: '8',
      minute: '0',
      timezone: 'Asia/Riyadh',
      preset: 'last_complete_days',
      days: '7',
      offset_days: '0',
      window_timezone: 'Asia/Riyadh',
    },
  });
  const bar = f.node('#delivery-status');
  assert.equal(bar.className, 'delivery-status success');
  assert.match(
    bar.textContent,
    /^Schedule saved\. Next run: Tue, Oct 13, 2026, 8:00\sAM GMT\+3 \(Asia\/Riyadh\) · your time: Tue, Oct 13, 2026, 6:00\sAM GMT\+1$/,
  );
});

test('EXP-04 B: the /schedules preview is a three-column table with a localized frequency, not a JSON dump', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.run(readFileSync('web/work-center.js', 'utf8'));
    f.bootstrap.schedules.push({
      id: 'schedule-1',
      view_id: 'view-1',
      revision: 2,
      config: f.config,
      schedule_kind: 'weekly',
      timezone: 'Asia/Riyadh',
      schedule_config: {hour: 8, minute: 0, weekday: 1},
      destination_id: 'tab-a',
      is_active: true,
      next_run_at: Date.UTC(2026, 9, 12, 5),
    });
    f.respond(args =>
      args.action === 'preview_schedule'
        ? {
            network_requests: 0,
            occurrences: [
              {
                delivery_at: '2026-10-12T05:00:00.000Z',
                delivery_timezone: 'Asia/Riyadh',
                window_timezone: 'UTC',
                date_range: {since: '2026-10-05', until: '2026-10-11'},
                sources: [{platform: 'meta', account_id: '123', open_at_delivery: true}],
              },
            ],
          }
        : f.bootstrap,
    );
    await f.run('renderScheduleCenter()');
    const page = f.context.content.innerHTML;
    assert.match(page, locale === 'ar' ? /أسبوعي/ : /<p>Weekly · Asia\/Riyadh/);
    assert.match(page, /\(Asia\/Riyadh\)/);
    await f.bindings.get('[data-schedule-preview]')({dataset: {schedulePreview: 'schedule-1'}});
    const table = f.node('#schedule-preview-schedule-1').innerHTML;
    assert.equal((table.match(/<th scope="col">/g) ?? []).length, 3, locale);
    assert.match(table, /\(Asia\/Riyadh\)/);
    assert.match(table, /\(UTC\)/);
    assert.doesNotMatch(table, /delivery_at|\/0\//);
    assert.match(table, locale === 'ar' ? /جزئية/ : /that snapshot is partial/);
  }
});
