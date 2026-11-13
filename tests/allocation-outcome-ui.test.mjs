// DEC-02 on the campaign plan page: Meta budget drafts in both languages, and the outcome review panel of an
// allocation plan. Browser scripts run in a VM context with a minimal DOM; nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {allocationOutcomeCopy} from '../dist/src/allocation-outcome.js';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
function page(locale = 'en', extra = {}) {
  const c = createContext({
    document: {addEventListener() {}},
    recordDetails: (_value, title) => '<details>' + title + '</details>',
    badge: String,
    date: String,
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    ...extra,
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
  if (locale === 'ar') {
    c.catalog = catalog;
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(c);
  }
  new Script(readFileSync('web/campaign-workflows.js', 'utf8')).runInContext(c);
  return c;
}
const run = (c, code, values = {}) => {
  Object.assign(c, values);
  return new Script(code).runInContext(c);
};

function metaPlan() {
  const target = (campaign, owner, extra = {}) => ({
    entity_id: campaign,
    campaign_id: campaign,
    name: 'Campaign <' + campaign + '>',
    budget_owner: owner,
    current_daily_budget: '20',
    daily_budget: '62.5',
    daily_budget_micros: '62500000',
    daily_budget_native: '6250',
    period_budget: '125',
    rounding_residual: '0',
    ...extra,
  });
  return {
    id: 'meta-plan',
    name: 'Meta allocation',
    brief: 'Brief',
    state: 'draft',
    revision: 1,
    allocation: {
      gateway: 'meta_native_action',
      account_id: '100',
      connection_id: 'meta',
      currency: 'USD',
      timezone: 'America/New_York',
      report_id: 'source',
      period_days: 2,
      targets: [
        target('10', 'campaign'),
        target('20', 'ad_set', {
          adset_id: '456',
          daily_budget_native: '3750',
          daily_budget: '37.5',
          daily_budget_micros: '37500000',
        }),
      ],
    },
    steps: [
      {
        id: 'allocation-1',
        kind: 'write',
        gateway: 'meta_native_action',
        account_id: '100',
        connection_id: 'meta',
        expected_currency: 'USD',
        description: 'Original Meta description one',
        status: 'pending',
        depends_on: [],
        arguments: {
          action: 'meta_campaign_id_update',
          path_params: {campaign_id: '10'},
          payload: {daily_budget: '6250'},
        },
      },
      {
        id: 'allocation-2',
        kind: 'write',
        gateway: 'meta_native_action',
        account_id: '100',
        connection_id: 'meta',
        expected_currency: 'USD',
        description: 'Original Meta description two',
        status: 'pending',
        depends_on: [],
        arguments: {action: 'meta_ad_set_id_update', path_params: {ad_set_id: '456'}, payload: {daily_budget: '3750'}},
      },
    ],
  };
}

test('a Meta budget draft shows each budget owner and the exact Meta minor units in both languages', () => {
  for (const locale of ['en', 'ar']) {
    const plan = metaPlan(),
      before = JSON.stringify(plan),
      c = page(locale),
      html = run(c, 'campaignJournal(plan)', {plan}),
      descriptions = run(c, 'plan.steps.map(s=>allocationStepDescription(s,allocationReviewContext(plan)))');
    assert.match(html, locale === 'en' ? /Retained budget proposal/ : /مقترح الميزانية المحفوظ/);
    assert.match(html, locale === 'en' ? /Budget owner/ : /مالك الميزانية/);
    assert.match(html, locale === 'en' ? /Campaign budget/ : /ميزانية الحملة/);
    assert.match(html, /<bdi dir="ltr">456<\/bdi>/);
    assert.match(html, /<bdi dir="ltr">6250<\/bdi>/);
    assert.match(html, /<bdi dir="ltr">3750<\/bdi>/);
    assert.match(html, /75%/);
    assert.match(html, /Campaign &lt;10>/);
    assert.doesNotMatch(html, /Native budget in micros/);
    assert.match(descriptions[0], locale === 'en' ? /Proposed daily budget/ : /الميزانية اليومية المقترحة/);
    assert.match(descriptions[1], /<bdi dir="ltr">456<\/bdi>/);
    // The outcome review has its own panel, filled after the page loads.
    assert.match(html, /<section id="allocation-outcome" class="allocation-outcome" aria-live="polite"><\/section>/);
    assert.equal(JSON.stringify(plan), before);
  }
});

test('a Meta step description is shown only for the exact saved budget request', () => {
  for (const mutate of [
    p => (p.steps[0].arguments.payload.daily_budget = '6251'),
    p => (p.steps[0].arguments.payload.status = 'ACTIVE'),
    p => (p.steps[0].arguments.action = 'meta_ad_set_id_update'),
    p => (p.steps[1].arguments.path_params.ad_set_id = '999'),
    p => (p.steps[0].arguments.path_params.campaign_id = '20'),
    p => (p.steps[0].account_id = '200'),
  ]) {
    const plan = metaPlan();
    mutate(plan);
    const c = page('ar'),
      descriptions = run(c, 'plan.steps.map(s=>allocationStepDescription(s,allocationReviewContext(plan)))', {plan});
    assert.ok(descriptions.includes(null));
  }
  // A malformed Meta binding keeps the original brief and descriptions.
  for (const mutate of [
    p => (p.allocation.targets[0].budget_owner = 'account'),
    p => delete p.allocation.targets[1].adset_id,
    p => (p.allocation.targets[0].daily_budget_native = '62.5'),
  ]) {
    const plan = metaPlan();
    mutate(plan);
    const c = page('en'),
      html = run(c, 'campaignJournal(plan)', {plan});
    assert.doesNotMatch(html, /class="allocation-proposal"/);
  }
});

const window = {since: '2026-10-17', until: '2026-10-18', days: 2, timezone: 'UTC'};
const complete = () => ({
  record_kind: 'allocation_outcome',
  plan_id: 'plan/1',
  state: 'complete',
  entity_kind: 'campaign',
  currency: 'USD',
  window,
  entities: [
    {
      entity_id: '10',
      name: 'Campaign <ten>',
      days_with_rows: 2,
      proposed_budget: '125',
      realized_spend: '124',
      spend_to_proposed: '0.992',
      realized_conversions: '28',
      modeled_conversions_low: '20',
      modeled_conversions_high: '30',
      position: 'within',
      spend_conditioned_low: '19.84',
      spend_conditioned_high: '29.76',
      spend_conditioned_position: 'within',
      realized_factor: '1.129032258',
    },
    {
      entity_id: '20',
      name: null,
      days_with_rows: 0,
      proposed_budget: '75',
      realized_spend: null,
      spend_to_proposed: null,
      realized_conversions: null,
      modeled_conversions_low: '6',
      modeled_conversions_high: '9',
      position: 'unknown',
      spend_conditioned_low: null,
      spend_conditioned_high: null,
      spend_conditioned_position: 'unknown',
      realized_factor: null,
    },
  ],
  totals: {
    entity_count: 2,
    proposed_budget: '200',
    realized_spend: null,
    spend_to_proposed: null,
    realized_conversions: null,
    modeled_conversions_low: '26',
    modeled_conversions_high: '39',
    position: 'unknown',
    spend_conditioned_low: null,
    spend_conditioned_high: null,
    spend_conditioned_position: 'unknown',
    realized_factor: null,
  },
  limitations: [allocationOutcomeCopy[0], allocationOutcomeCopy[1], allocationOutcomeCopy[4]],
  calibration_evidence: {report_id: 'out/1', website_path: '/reports?id=out%2F1', meaning: allocationOutcomeCopy[6]},
});

test('every authored outcome sentence has Arabic that keeps its native tokens and numbers', () => {
  for (const message of allocationOutcomeCopy) {
    assert.match(catalog[message] ?? '', /[؀-ۿ]/u, message);
    for (const token of message.match(/\b[a-z]+_[a-z_]+\b|\d+(?:\.\d+)?/g) ?? [])
      assert.ok(catalog[message].includes(token), token + ' in ' + message);
  }
});

test('the outcome panel shows the comparison exactly, uncoloured and with its caveats, in both languages', () => {
  for (const locale of ['en', 'ar']) {
    const c = page(locale),
      out = complete(),
      before = JSON.stringify(out),
      html = run(c, 'allocationOutcomeView(out,false)', {out});
    assert.match(html, locale === 'en' ? /Outcome review/ : /مراجعة النتيجة/);
    assert.match(html, /2026-10-17 – 2026-10-18/);
    assert.match(html, locale === 'en' ? /Within the modeled range/ : /ضمن النطاق المنمذج/);
    for (const value of ['124', '28', '20', '30', '19.84', '29.76', '1.129032258', '26', '39'])
      assert.match(html, new RegExp('<bdi dir="ltr">' + value.replace('.', '\\.') + '</bdi>'), value);
    assert.match(html, locale === 'en' ? /99\.2% of the proposed budget/ : /99\.2% من الميزانية المقترحة/);
    // Unknown stays unknown, never zero.
    assert.match(html, locale === 'en' ? /Unknown/ : /غير معروف/);
    assert.doesNotMatch(html, /<bdi dir="ltr">0<\/bdi>/);
    assert.match(
      html,
      locale === 'en' ? /does not show that the budget change caused/ : /لا تُظهر أن تغيير الميزانية تسبب/,
    );
    assert.match(html, locale === 'en' ? /no reported rows/ : /لا توجد صفوف/);
    assert.match(html, /href="\/reports\?id=out%2F1"/);
    assert.match(html, /Campaign &lt;ten>/);
    assert.doesNotMatch(html, /Campaign <ten>/);
    assert.equal(JSON.stringify(out), before);
  }
});

test('scheduled, due, unavailable and not-scheduled reviews say what happens next; viewers get no capture button', () => {
  for (const locale of ['en', 'ar']) {
    const c = page(locale),
      view = (out, viewer = false) => run(c, 'allocationOutcomeView(out,viewer)', {out, viewer});
    const scheduled = view({state: 'scheduled', window, due_at: Date.parse('2026-10-19T00:00:00Z'), automatic: true});
    assert.match(scheduled, locale === 'en' ? /Nothing is read before then/ : /لا تُقرأ أي بيانات قبل ذلك/);
    assert.doesNotMatch(scheduled, /allocation-outcome-capture/);
    const manual = view({state: 'scheduled', window, due_at: Date.parse('2026-10-19T00:00:00Z'), automatic: false});
    assert.match(manual, locale === 'en' ? /Open this plan after it closes/ : /افتح هذه الخطة بعد انتهاء الفترة/);
    const due = view({state: 'due', window, due_at: 1, last_error: {code: 'REPORT_INCOMPLETE'}});
    assert.match(due, /id="allocation-outcome-capture"/);
    assert.match(due, /REPORT_INCOMPLETE/);
    assert.doesNotMatch(view({state: 'due', window, due_at: 1}, true), /allocation-outcome-capture/);
    const unavailable = view({state: 'unavailable', reason: 'source_report_changed'});
    assert.match(
      unavailable,
      locale === 'en' ? /evidence report changed after the plan was created/ : /تغيّر تقرير البيانات/,
    );
    // An outcome read on other measurement settings than its evidence, among them the way it counted actions (Meta captures that
    // counted the requested windows against evidence that did not): its sentence exists in both languages.
    const changed = view({
      state: 'unavailable',
      reason: 'measurement_definition_changed',
      changed_fields: ['action_count_basis'],
    });
    assert.match(
      changed,
      locale === 'en'
        ? /used different measurement settings than the proposal/
        : /إعدادات قياس تختلف عن إعدادات المقترح/,
    );
    const pending = view({state: 'not_scheduled', reason: 'steps_not_verified', meaning: allocationOutcomeCopy.at(-1)});
    assert.match(pending, locale === 'en' ? /verified by read-back/ : /بقراءة لاحقة/);
    // An unrecognised code is shown literally, never translated into something else.
    assert.match(view({state: 'unavailable', reason: 'future_reason'}), /future_reason/);
  }
});

test('the budget preview names the Meta owner and minor units and Google’s Search budget-lost share in both languages', () => {
  for (const locale of ['en', 'ar']) {
    const c = createContext({
      document: {addEventListener() {}},
      recordDetails: (_value, title) => '<details>' + title + '</details>',
      esc: v =>
        String(v ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('"', '&quot;'),
    });
    new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
    if (locale === 'ar') {
      c.catalog = catalog;
      new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(c);
    }
    new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(c);
    new Script(readFileSync('web/report-allocation.js', 'utf8')).runInContext(c);
    const base = {account_id: '100', currency: 'USD', timezone: 'UTC', period_days: 2, meaning: 'Preview only.'},
      target = extra => ({
        name: 'Campaign',
        entity_id: '10',
        campaign_id: '10',
        current_daily_budget: '20',
        period_budget: '125',
        daily_budget: '62.5',
        daily_budget_micros: '62500000',
        rounding_residual: '0',
        budget_utilization: '0.25',
        low_budget_utilization: true,
        ...extra,
      });
    const meta = run(c, 'allocationPlanPreview(p)', {
      p: {
        ...base,
        gateway: 'meta_native_action',
        targets: [target({budget_owner: 'ad_set', adset_id: '456', daily_budget_native: '6250'})],
      },
    });
    assert.match(meta, locale === 'en' ? /Ad set 456/ : /مجموعة الإعلانات 456/);
    assert.match(meta, locale === 'en' ? /6250 in Meta minor units/ : /6250 بالوحدات الصغرى في Meta/);
    assert.doesNotMatch(meta, /62500000 micros/);
    const google = run(c, 'allocationPlanPreview(p)', {
      p: {
        ...base,
        gateway: 'google_ads_native_action',
        targets: [
          target({
            budget_resource: 'customers/1/campaignBudgets/1',
            search_budget_lost_impression_share: {status: 'read', share: '0.25', above_90_percent: false},
          }),
          target({
            budget_resource: 'customers/1/campaignBudgets/2',
            search_budget_lost_impression_share: {status: 'read', share: '0.9001', above_90_percent: true},
          }),
          target({
            budget_resource: 'customers/1/campaignBudgets/3',
            search_budget_lost_impression_share: {status: 'not_search'},
          }),
          target({
            budget_resource: 'customers/1/campaignBudgets/4',
            search_budget_lost_impression_share: {status: 'unavailable'},
          }),
        ],
      },
    });
    assert.match(google, locale === 'en' ? /lost to budget: 25%/ : /بسبب الميزانية: 25%/);
    assert.match(google, locale === 'en' ? /lost to budget: more than 90%/ : /أكثر من 90%/);
    assert.match(google, locale === 'en' ? /not a Search campaign/ : /ليست حملة بحث/);
    assert.match(google, locale === 'en' ? /not reported/ : /لم يُبلَغ عنها/);
  }
});

test('the panel loads the review, captures only on an explicit click and never repaints a page that was left', async () => {
  const root = {innerHTML: '', isConnected: true},
    calls = [],
    bindings = new Map();
  let live = true;
  const c = page('en', {
    $: selector => (selector === '#allocation-outcome' ? root : null),
    session: {workspaceRole: 'operator'},
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    errorMessage: e => e.message,
    workspaceCall: async (tool, args) => {
      calls.push([tool, args]);
      return args.action === 'allocation_outcome' ? {state: 'due', window, due_at: 1} : complete();
    },
  });
  await run(c, 'mountAllocationOutcome(plan, current)', {plan: {id: 'plan/1', allocation: {}}, current: () => live});
  // The VM's objects have their own prototypes, so compare their JSON form.
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(calls), [['reporting', {action: 'allocation_outcome', id: 'plan/1'}]]);
  assert.match(root.innerHTML, /Review the outcome now/);
  await bindings.get('#allocation-outcome-capture')();
  assert.deepEqual(plain(calls[1]), ['reporting', {action: 'capture_allocation_outcome', id: 'plan/1'}]);
  assert.match(root.innerHTML, /Outcome beside the proposal/);
  // After leaving the plan, a late answer is not painted.
  root.innerHTML = 'Another plan';
  live = false;
  await bindings.get('#allocation-outcome-capture')();
  assert.equal(root.innerHTML, 'Another plan');
});
