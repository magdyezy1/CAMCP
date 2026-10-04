import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
const source = () => ({
  id: 'draft',
  name: 'Client <draft>',
  brief: 'Original brief <kept>',
  state: 'draft',
  revision: 1,
  allocation: {
    gateway: 'snapchat_native_action',
    account_id: '001-ABC',
    currency: 'USD',
    timezone: 'UTC',
    report_id: 'original/report',
    period_days: 2,
    parent_campaign_id: 'parent-001',
    targets: [
      {
        entity_id: 'squad-001',
        campaign_id: 'parent-001',
        name: '<native name>',
        current_daily_budget: '200.000001',
        daily_budget: '62.500001',
        daily_budget_micros: '62500001',
        period_budget: '125.000002',
        rounding_residual: '0',
      },
    ],
  },
  steps: [
    {
      id: 'allocation-1',
      kind: 'write',
      gateway: 'snapchat_native_action',
      account_id: '001-ABC',
      description: 'Original native description',
      status: 'pending',
      depends_on: [],
      arguments: {
        action: 'snapchat_adsquad_update',
        path_params: {campaign_id: 'parent-001', ad_squad_id: 'squad-001'},
        payload: [{op: 'replace', path: '/daily_budget_micro', value: 62500001}],
      },
    },
  ],
});
function linkedinSource() {
  const r = source(),
    t = r.allocation.targets[0],
    id = '9007199254740993';
  Object.assign(r.allocation, {
    gateway: 'linkedin_native_action',
    account_id: '100',
    connection_id: 'conn',
    api_version: '202609',
  });
  Object.assign(t, {entity_id: 'urn:li:sponsoredCampaign:' + id, campaign_id: id});
  Object.assign(r.steps[0], {
    gateway: 'linkedin_native_action',
    account_id: '100',
    connection_id: 'conn',
    expected_currency: 'USD',
    arguments: {
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
      api_version: '202609',
      restli_method: 'PARTIAL_UPDATE',
      path_params: {ad_account_id: '100', campaign_id: id},
      payload: {patch: {$set: {dailyBudget: {amount: '62.500001', currencyCode: 'USD'}}}},
    },
  });
  return r;
}
function render(run, locale = 'en') {
  const records = [],
    c = createContext({
      run,
      document: {addEventListener() {}},
      recordDetails: (value, title) => {
        records.push(value);
        return '<details>' + title + '</details>';
      },
      badge: String,
      date: String,
      esc: v =>
        String(v ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('"', '&quot;'),
    });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
  if (locale === 'ar') {
    c.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(c);
  }
  new Script(readFileSync('web/campaign-workflows.js', 'utf8')).runInContext(c);
  return {
    html: new Script('campaignJournal(run)').runInContext(c),
    descriptions: new Script(
      'run.steps.map(s=>allocationStepDescription(s,allocationReviewContext(run)))',
    ).runInContext(c),
    records,
  };
}

test('LinkedIn saved proposals show exact native decimals, retained source and daily overage in both languages', () => {
  for (const locale of ['en', 'ar']) {
    const r = linkedinSource(),
      before = JSON.stringify(r),
      out = render(r, locale);
    assert.match(out.html, /urn:li:sponsoredCampaign:9007199254740993/);
    assert.match(out.html, /62\.500001/);
    assert.match(out.html, /150%/);
    assert.doesNotMatch(out.html, /62500001|Native budget in micros/);
    assert.match(out.descriptions[0], locale === 'ar' ? /الميزانية اليومية المقترحة/ : /Proposed daily budget/);
    assert.equal(JSON.stringify(r), before);
    assert.match(out.html, /Original native description/);
  }
});

test('LinkedIn readable budget descriptions require exact native currency, account, REST.li method, version and no additional changes', () => {
  for (const mutate of [
    r => (r.steps[0].arguments.payload.patch.$set.status = 'ACTIVE'),
    r => (r.steps[0].arguments.payload.patch.$set.dailyBudget.currencyCode = 'SAR'),
    r => (r.steps[0].arguments.payload.patch.$set.dailyBudget.amount = '62.500002'),
    r => (r.steps[0].arguments.api_version = '202608'),
    r => (r.steps[0].arguments.restli_method = 'UPDATE'),
    r => (r.steps[0].arguments.path_params.ad_account_id = '99'),
    r => (r.steps[0].arguments.path_params.campaign_id = '9007199254740992'),
    r => (r.steps[0].arguments.extra = 'unknown'),
  ]) {
    const r = linkedinSource();
    mutate(r);
    assert.equal(render(r, 'ar').descriptions[0], null);
  }
});
test('a saved guided Snapchat brief localizes its authored context and keeps the original source text intact', () => {
  for (const locale of ['en', 'ar']) {
    const run = {...source(), allocation: undefined, recipe: {id: 'snapchat_website_traffic'}};
    const before = JSON.stringify(run),
      html = render(run, locale).html;
    assert.match(html, locale === 'ar' ? /مسار سناب شات المحفوظ/ : /saved Snapchat workflow/);
    assert.match(html, /Original brief &lt;kept>/);
    assert.match(html, locale === 'ar' ? /ملخص الخطة الأصلي/ : /Original plan brief/);
    assert.equal(JSON.stringify(run), before);
  }
});
test('allocation review presents retained exact amounts and source context in both languages without changing the plan', () => {
  for (const locale of ['en', 'ar']) {
    const run = source(),
      before = JSON.stringify(run),
      r = render(run, locale);
    assert.match(r.html, locale === 'ar' ? /مقترح الميزانية المحفوظ/ : /Retained budget proposal/);
    assert.match(r.html, /200\.000001/);
    assert.match(r.html, /62\.500001/);
    assert.match(r.html, /62500001/);
    assert.match(r.html, /<bdi dir="ltr">001-ABC<\/bdi>/);
    assert.match(r.html, /reports\?id=original%2Freport/);
    assert.match(r.html, /Client &lt;draft>/);
    assert.match(r.html, /Original brief &lt;kept>/);
    assert.match(r.html, /&lt;native name>/);
    assert.doesNotMatch(r.html, /<native name>/);
    assert.equal(JSON.stringify(run), before);
    assert.equal(r.records.at(-1).allocation, run.allocation);
  }
});
test('a translated native-step description requires the exact allocation target and native amount; other descriptions remain unchanged', () => {
  const run = source(),
    r = render(run, 'ar');
  assert.match(r.descriptions[0], /الميزانية اليومية المقترحة/);
  for (const mutate of [
    r => (r.steps[0].account_id = 'foreign'),
    r => (r.steps[0].arguments.path_params.ad_squad_id = 'other'),
    r => (r.steps[0].arguments.payload[0].value = 62500002),
    r => r.steps[0].arguments.payload.push({op: 'replace', path: '/status', value: 'ACTIVE'}),
    r => (r.steps[0].expected_currency = 'EUR'),
    r => (r.steps[0].kind = 'read'),
  ]) {
    const changed = source();
    mutate(changed);
    const result = render(changed, 'ar');
    assert.equal(result.descriptions[0], null);
    assert.match(result.html, /<strong><bdi dir="auto">Original native description<\/bdi><\/strong>/);
  }
  const other = source();
  delete other.allocation;
  assert.match(render(other, 'ar').html, /<p><bdi dir="auto">Original brief &lt;kept><\/bdi><\/p>/);
});
test('Google saved budgets preserve their average daily meaning and bind to the exact native resource and update mask', () => {
  const run = source();
  Object.assign(run.allocation, {gateway: 'google_ads_native_action', account_id: '000123', connection_id: 'conn'});
  Object.assign(run.allocation.targets[0], {
    campaign_id: 'campaign-001',
    budget_resource: 'customers/000123/campaignBudgets/001',
  });
  Object.assign(run.steps[0], {
    gateway: 'google_ads_native_action',
    account_id: '000123',
    connection_id: 'conn',
    arguments: {
      action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
      payload: {
        operations: [
          {
            update: {resource_name: 'customers/000123/campaignBudgets/001', amount_micros: '62500001'},
            update_mask: 'amount_micros',
          },
        ],
        partial_failure: false,
      },
    },
  });
  const original = JSON.stringify(run),
    r = render(run, 'ar');
  assert.match(r.descriptions[0], /متوسط الميزانية اليومية المقترح/);
  assert.match(r.html, /<bdi dir="ltr">000123<\/bdi>/);
  assert.equal(JSON.stringify(run), original);
  for (const mutate of [
    r => (r.steps[0].connection_id = 'different'),
    r => (r.steps[0].arguments.payload.operations[0].update.resource_name = 'foreign'),
    r => (r.steps[0].arguments.payload.operations[0].update_mask = 'name'),
    r => (r.steps[0].arguments.payload.operations[0].update.name = 'Extra change'),
    r => (r.steps[0].arguments.payload.partial_failure = true),
  ]) {
    const changed = JSON.parse(original);
    mutate(changed);
    assert.equal(render(changed, 'ar').descriptions[0], null);
  }
});
test('unknown provider and malformed legacy allocations keep the original brief and original descriptions', () => {
  for (const mutate of [
    r => (r.allocation.gateway = 'unqualified_provider'),
    r => delete r.allocation.gateway,
    r => (r.allocation.targets = [null]),
    r => (r.allocation.period_days = 0),
    r => (r.allocation.currency = '<bad>'),
    r => (r.allocation.targets[0].daily_budget_micros = '62.5'),
    r => (r.allocation.targets[0].daily_budget = '62.500002'),
  ]) {
    const run = source();
    mutate(run);
    const r = render(run, 'ar');
    assert.equal(r.descriptions[0], null);
    assert.match(r.html, /<p><bdi dir="auto">Original brief &lt;kept><\/bdi><\/p>/);
    assert.doesNotMatch(r.html, /class="allocation-proposal"/);
  }
});
