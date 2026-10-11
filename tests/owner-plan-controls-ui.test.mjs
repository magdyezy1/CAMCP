import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

/**
 * CMP-05 (review 2026-10-08): the owner's Settings offer the campaign plan controls. Archived-plan retention is opt-in:
 * it shows the saved days (0 keeps archived plans), asks before turning on deletion and declining sends nothing; the
 * distinct-approver policy shows the saved choice and asks before either change. Both save through amcp_workspace.
 */
const source = readFileSync('web/owner-operations.js', 'utf8');
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
function fixture(health = {}, {confirmed = true, locale = 'en'} = {}) {
  const areas = [],
    pending = [],
    saves = [],
    confirmations = [],
    bindings = new Map();
  const context = createContext({
    Intl,
    catalog,
    document: {
      addEventListener() {},
      createElement: () => ({}),
    },
    renderSettings() {},
    date: value => String(value),
    esc: value =>
      String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    session: {authenticated: true, administrator: true, workspaceRole: 'owner'},
    location: {pathname: '/settings'},
    navigationGeneration: 7,
    content: {querySelector: () => null, append: area => areas.push(area)},
    platforms: [],
    pretty: String,
    authBind: (selector, fn) => bindings.set(selector, fn),
    $: () => ({addEventListener() {}, scrollIntoView() {}}),
    FormData: class {
      constructor(form) {
        return new Map(Object.entries(form.values));
      }
    },
    confirmAction: async args => {
      confirmations.push(args);
      return confirmed;
    },
    toast() {},
    api(path, options) {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      if (path === '/api/workspace/workspace' && body?.action !== 'health') {
        saves.push(body);
        return Promise.resolve({success: true, data: {}});
      }
      return new Promise(resolve => pending.push({path, resolve}));
    },
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  const app = readFileSync('web/app.js', 'utf8');
  run(app.slice(app.indexOf('const identityKey ='), app.indexOf('function resetPrivateState()')));
  run(source);
  const data = {
    backup: {status: 'unverified'},
    operations: {},
    connections: [],
    jobs: [],
    email: [],
    storage: {database_bytes: 0, report_rows: 0},
    limits: {},
    api_versions: {},
    policies: [],
    ...health,
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    areas,
    saves,
    confirmations,
    bindings,
    settle,
    render: async () => {
      const rendering = run('renderSettings()');
      for (const request of pending.splice(0, 2))
        request.resolve(
          request.path === '/api/account/options' ? {emailEnabled: false, providers: []} : {success: true, data},
        );
      await rendering;
    },
  };
}

test('CMP-05: the owner Settings show the saved plan retention and approval policy (off and 0 by default)', async () => {
  for (const [health, days, checked] of [
    [{}, '0', false],
    [
      {retention: {days: 30, archived_campaign_plans_days: 90}, plan_policy: {require_distinct_approver: true}},
      '90',
      true,
    ],
    [{retention: {days: 30}, plan_policy: {require_distinct_approver: false}}, '0', false],
  ]) {
    const f = fixture(health);
    await f.render();
    const html = f.areas[0].innerHTML;
    assert.match(html, /<section class="panel" id="owner-plan-policy-panel">/);
    assert.match(
      html,
      new RegExp(`<form id="owner-plan-retention"><label>[^<]*<input name="days" [^>]*value="${days}"`),
    );
    assert.equal(/name="distinct" type="checkbox" checked/.test(html), checked);
    assert.ok(f.bindings.has('#owner-plan-retention'));
    assert.ok(f.bindings.has('#owner-plan-policy'));
  }
  // How many plans count toward the bound, and how many archived plans do not.
  const counted = fixture({plan_inventory: {active: 498, archived: 12, limit: 500}});
  await counted.render();
  assert.match(
    counted.areas[0].innerHTML,
    /<p id="owner-plan-inventory">498 of 500 campaign plans in use; 12 archived plans do not count\.<\/p>/,
  );
  const ar = fixture({plan_inventory: {active: 498, archived: 12, limit: 500}}, {locale: 'ar'});
  await ar.render();
  assert.match(ar.areas[0].innerHTML, new RegExp(catalog['Campaign plans']));
  assert.match(ar.areas[0].innerHTML, new RegExp(catalog['Save plan retention']));
  assert.match(ar.areas[0].innerHTML, /خطط الحملات المستخدمة: 498 من 500/);
});

test('CMP-05: turning on archived-plan deletion asks first; declining sends nothing; 0 turns it off without asking', async () => {
  const f = fixture();
  await f.render();
  const save = f.bindings.get('#owner-plan-retention');
  void save({values: {days: '45'}});
  await f.settle();
  assert.match(f.confirmations[0].title, /Delete archived plans older than 45 days/);
  assert.match(f.confirmations[0].consequence, /Audit records, write receipts and reviews are kept/);
  assert.deepEqual(f.saves, [{action: 'save_retention', archived_campaign_plans_days: 45, confirmed: true}]);
  void save({values: {days: '0'}});
  await f.settle();
  assert.equal(f.confirmations.length, 1, 'keeping archived plans needs no confirmation');
  assert.deepEqual(f.saves[1], {action: 'save_retention', archived_campaign_plans_days: 0, confirmed: true});
  const declined = fixture({}, {confirmed: false});
  await declined.render();
  void declined.bindings.get('#owner-plan-retention')({values: {days: '45'}});
  await declined.settle();
  assert.equal(declined.confirmations.length, 1);
  assert.deepEqual(declined.saves, []);
});

test('CMP-05: the distinct-approver policy asks first and saves the checked choice; declining sends nothing', async () => {
  const f = fixture();
  await f.render();
  const save = f.bindings.get('#owner-plan-policy');
  void save({values: {distinct: 'on'}});
  await f.settle();
  void save({values: {}});
  await f.settle();
  assert.match(f.confirmations[0].title, /Require a different approver for spending plans/);
  assert.match(f.confirmations[0].consequence, /One person alone can no longer approve such plans/);
  assert.match(f.confirmations[1].title, /Let plan owners approve their own spending plans/);
  assert.deepEqual(f.saves, [
    {action: 'save_plan_policy', require_distinct_approver: true, confirmed: true},
    {action: 'save_plan_policy', require_distinct_approver: false, confirmed: true},
  ]);
  const declined = fixture({}, {confirmed: false});
  await declined.render();
  void declined.bindings.get('#owner-plan-policy')({values: {distinct: 'on'}});
  await declined.settle();
  assert.equal(declined.confirmations.length, 1);
  assert.deepEqual(declined.saves, []);
  // The confirmation is translated.
  const ar = fixture({}, {locale: 'ar'});
  await ar.render();
  void ar.bindings.get('#owner-plan-policy')({values: {distinct: 'on'}});
  await ar.settle();
  assert.equal(ar.confirmations[0].title, catalog['Require a different approver for spending plans?']);
});
