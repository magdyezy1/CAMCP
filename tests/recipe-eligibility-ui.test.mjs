import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {trafficBusiness} from './fixtures/snapchat-traffic-data.mjs';
import {leadBusiness, leadFixture} from './fixtures/snapchat-leads-data.mjs';
import {valueInspectionFixture} from './fixtures/google-value-inspection-data.mjs';
import {conversionActivityFixture} from './fixtures/google-conversion-activity-data.mjs';

test('English and Arabic activity tables preserve original account-local times, unknowns and escaped action names', async t => {
  for (const missing of [false, true]) {
    const native = conversionActivityFixture(t, {
        data: {customer: {timeZone: 'Asia/Riyadh'}},
        ...(missing ? {activity: () => ({})} : {}),
      }),
      out = await native.call();
    assert.equal(out.success, true);
    for (const locale of ['en', 'ar']) {
      const f = fixture(locale);
      await f.mount();
      f.context.proof = out.data;
      const html = new Script('conversionActivityInspectionView(proof)').runInContext(f.context);
      assert.match(html, locale === 'ar' ? /آخر نشاط تحويل أبلغت عنه المنصة/ : /Last reported conversion activity/);
      assert.match(html, /role="region" tabindex="0"/);
      assert.match(html, /<caption>/);
      assert.match(html, /<th scope="col">/);
      assert.match(html, /Asia\/Riyadh/);
      assert.match(html, /&lt;img onerror=bad&gt;/);
      assert.doesNotMatch(html, /<img/);
      if (missing) assert.match(html, locale === 'ar' ? /لم تُعِدْه المنصة/ : /Not returned/);
      else {
        assert.match(html, /<bdi dir="ltr">2026-10-01<\/bdi>/);
        assert.match(html, /<bdi dir="ltr">2026-10-02 13:14:15<\/bdi>/);
      }
      assert.match(
        html,
        locale === 'ar'
          ? /قد يُرصد الوسم دون تحويل منسوب إلى إعلان/
          : /A detected tag can have no attributable conversion/,
      );
      assert.match(
        new Script('recipeEligibilityView(proof)').runInContext(f.context),
        locale === 'ar' ? /آخر رصد للوسم/ : /Last tag detected/,
      );
    }
  }
});

test('activity views withhold incomplete, wrong-scope, malformed dates and inconsistent collection counts', async t => {
  const native = conversionActivityFixture(t),
    out = await native.call();
  assert.equal(out.success, true);
  const f = fixture('en');
  await f.mount();
  for (const change of [
    p => (p.scope.account_id = '999'),
    p => (p.conversion_goal_inspection.activity_selected = false),
    p => (p.conversion_goal_inspection.complete = false),
    p => (p.conversion_goal_inspection.customer.timezone = 'Wrong/Zone'),
    p => (p.conversion_goal_inspection.primary_actions[0].activity.last_conversion_date = '2026-02-30'),
    p => (p.conversion_goal_inspection.primary_actions[0].activity.last_tag_received_time = '2026-10-02T13:14:15Z'),
    p => (p.conversion_goal_inspection.summary.primary_last_tag_known = 2),
    p => (p.conversion_goal_inspection.summary.primary_last_conversion_known = 0),
  ]) {
    f.context.proof = structuredClone(out.data);
    change(f.context.proof);
    assert.equal(new Script('conversionActivityInspectionView(proof)').runInContext(f.context), '');
  }
});
const base = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8')).recipe_business;
test('current value settings in English and Arabic preserve conversion currency, literal zero and unknown fields', async t => {
  for (const locale of ['en', 'ar'])
    for (const missing of [false, true]) {
      const native = valueInspectionFixture(t, {
          settings: () =>
            missing
              ? {defaultCurrencyCode: 'SAR', alwaysUseDefaultValue: true}
              : {defaultValue: 0, defaultCurrencyCode: 'SAR', alwaysUseDefaultValue: false},
        }),
        out = await native.call();
      assert.equal(out.success, true, JSON.stringify(out));
      const f = fixture(locale);
      await f.mount();
      f.context.proof = out.data;
      const html = new Script('conversionValueInspectionView(proof)').runInContext(f.context);
      assert.match(html, locale === 'ar' ? /إعدادات قيم التحويل الحالية/ : /Current conversion value settings/);
      assert.match(html, /<div class="data-scroll" role="region" tabindex="0"/);
      assert.match(html, /<caption>/);
      assert.match(html, /<th scope="col">/);
      assert.match(html, /<bdi dir="ltr">SAR<\/bdi>/);
      assert.doesNotMatch(html, /<bdi dir="ltr">USD<\/bdi>/);
      assert.match(html, /Synthetic &lt;img onerror=bad&gt; purchase/);
      assert.doesNotMatch(html, /<img/);
      assert.match(html, locale === 'ar' ? /لا تثبت استلام قيم الأحداث/ : /do not prove received event values/);
      if (missing) assert.match(html, locale === 'ar' ? /لم تُعِدْه المنصة/ : /Not returned/);
      else {
        assert.match(html, /<bdi dir="ltr">0<\/bdi>/);
        assert.match(html, locale === 'ar' ? /استخدم قيم الأحداث عندما تكون صحيحة/ : /Use event values when valid/);
      }
      assert.match(
        new Script('recipeEligibilityView(proof)').runInContext(f.context),
        locale === 'ar' ? /إعدادات قيم التحويل الحالية/ : /Current conversion value settings/,
      );
    }
});

test('value configuration views refuse stale scope, wrong selection, malformed scalars or inconsistent whole-collection counts', async t => {
  const native = valueInspectionFixture(t),
    out = await native.call();
  assert.equal(out.success, true);
  const f = fixture('en');
  await f.mount();
  for (const change of [
    p => (p.scope.account_id = '999'),
    p => (p.conversion_goal_inspection.value_settings_selected = false),
    p => (p.conversion_goal_inspection.complete = false),
    p => (p.conversion_goal_inspection.primary_actions[0].value_settings.default_value = '7.25'),
    p => (p.conversion_goal_inspection.primary_actions[0].value_settings.always_use_default_value = 'false'),
    p => (p.conversion_goal_inspection.summary.primary_value_settings_known = 2),
  ]) {
    f.context.proof = structuredClone(out.data);
    change(f.context.proof);
    assert.equal(new Script('conversionValueInspectionView(proof)').runInContext(f.context), '');
  }
});
const valueIds = ['google_search_conversion_value', 'google_search_target_roas'];
const valueBusiness = id => ({
  ...base,
  cpc_bid: undefined,
  daily_budget: '25.000001',
  conversion_goal_policy: 'ACCOUNT_DEFAULT',
  conversion_value_policy: 'ACCOUNT_RECORDED_VALUES',
  ...(id === valueIds[1] ? {target_roas: '3.5'} : {}),
});

test('value bidding forms in English and Arabic require explicit values and explain ratio input without changing native units', async () => {
  for (const locale of ['en', 'ar'])
    for (const id of valueIds) {
      const definition = campaignRecipes.find(r => r.id === id),
        business = valueBusiness(id),
        f = fixture(locale, [], definition, business);
      await f.mount();
      const fields = f.node('#recipe-fields').innerHTML;
      assert.match(fields, /name="conversion_value_policy" required/);
      assert.match(fields, /<option value="">/);
      assert.match(fields, /value="ACCOUNT_RECORDED_VALUES"/);
      assert.match(fields, locale === 'ar' ? /قيم التحويل لهذه الحملة/ : /Conversion values for this campaign/);
      assert.doesNotMatch(fields, /name="(?:cpc_bid|target_cpa)"/);
      if (id === valueIds[1]) {
        assert.match(fields, /name="target_roas" required/);
        assert.match(fields, /inputmode="decimal"/);
        assert.match(fields, /0\.01/);
        assert.match(fields, /1000/);
        assert.match(fields, /350%/);
      } else assert.doesNotMatch(fields, /name="target_roas"/);
      const parsed = new Script("readRecipeBusiness($('#recipe-form'))").runInContext(f.context);
      assert.equal(parsed.conversion_value_policy, 'ACCOUNT_RECORDED_VALUES');
      assert.equal(parsed.target_roas, id === valueIds[1] ? '3.5' : undefined);
      f.form.values.conversion_value_policy = '';
      assert.equal(
        new Script("readRecipeBusiness($('#recipe-form'))").runInContext(f.context).conversion_value_policy,
        undefined,
      );
      assert.equal(f.calls.filter(c => !['recipes', 'recipe_context'].includes(c.action)).length, 0);
    }
});

test('value previews in both languages explain exact budget, native ratio and unknown measurement while escaping source names', async () => {
  for (const locale of ['en', 'ar'])
    for (const id of valueIds) {
      const f = fixture(
        locale,
        [],
        campaignRecipes.find(r => r.id === id),
        valueBusiness(id),
      );
      await f.mount();
      const {recipe, ...plan} = campaignRecipe(id, {...valueBusiness(id), name: 'Source <img onerror=bad>'});
      f.context.preview = {ready: true, provider_mutations: 0, recipe, plan};
      const html = new Script('conversionRecipePreview(preview)').runInContext(f.context);
      assert.match(
        html,
        locale === 'ar'
          ? /<h3>معاينة حملة قيم التحويل المتوقفة<\/h3>/
          : /<h3>Paused conversion-value campaign preview<\/h3>/,
      );
      assert.match(html, /25\.000001 USD/);
      assert.match(html, /25000001/);
      assert.match(html, /Source &lt;img onerror=bad&gt;/);
      assert.doesNotMatch(html, /<img/);
      assert.match(
        html,
        locale === 'ar' ? /سجل التحويلات وأهلية المنصة/ : /conversion history and provider eligibility/,
      );
      assert.match(html, locale === 'ar' ? /لا يضمن حدًا أدنى للعائد/ : /not a minimum guaranteed return/);
      if (id === valueIds[1]) assert.match(html, /<bdi dir="ltr">3\.5× · 350%<\/bdi>/);
      else assert.match(html, locale === 'ar' ? /لم يُحدّد عائد مستهدف/ : /No target ROAS/);
    }
});

test('value preview refuses incompatible native strategy, ratio type, value policy, scope or currency', async () => {
  const f = fixture('en');
  await f.mount();
  const changes = [
    p => (p.recipe.conversion_value_policy = 'IMPLICIT'),
    p =>
      (p.plan.steps.find(
        s => s.id === 'campaign',
      ).arguments.payload.operations[0].create.maximize_conversion_value.target_roas = '3.5'),
    p =>
      (p.plan.steps.find(
        s => s.id === 'campaign',
      ).arguments.payload.operations[0].create.maximize_conversion_value.target_roas = 2),
    p => (p.plan.steps.find(s => s.id === 'campaign').arguments.payload.operations[0].create.manual_cpc = {}),
    p => (p.plan.steps[0].account_id = 'foreign-account'),
    p => (p.plan.steps[0].expected_currency = 'SAR'),
  ];
  for (const change of changes) {
    const {recipe, ...plan} = campaignRecipe(valueIds[1], valueBusiness(valueIds[1]));
    f.context.preview = {ready: true, provider_mutations: 0, recipe, plan};
    change(f.context.preview);
    const html = new Script('conversionRecipePreview(preview)').runInContext(f.context);
    assert.doesNotMatch(html, /<section/);
    assert.match(html, /<pre>/);
  }
});
const deferred = () => {
  let resolve;
  const promise = new Promise(r => (resolve = r));
  return {promise, resolve};
};
for (const locale of ['en', 'ar']) {
  test('lead ' + locale + ' brief and preview preserve the explicit native goal and original creative', async () => {
    const definition = campaignRecipes.find(r => r.id === 'snapchat_lead_generation'),
      f = fixture(locale, [], definition, leadBusiness);
    await f.mount();
    const fields = f.node('#recipe-fields').innerHTML;
    assert.match(fields, /name="optimization_goal" required/);
    assert.match(fields, /value="SWIPES"/);
    assert.match(fields, /value="LEAD_FORM_SUBMISSIONS"/);
    assert.match(
      new Script("recipeField('optimization_goal','LEAD_FORM_SUBMISSIONS',true)").runInContext(f.context),
      /value="LEAD_FORM_SUBMISSIONS" selected/,
    );
    assert.match(
      fields,
      locale === 'ar' ? /معرّف مادة سناب شات الحالية لجمع العملاء المحتملين/ : /Existing Snapchat lead creative ID/,
    );
    assert.equal(
      new Script("readRecipeBusiness($('#recipe-form'))").runInContext(f.context).optimization_goal,
      'LEAD_FORM_SUBMISSIONS',
    );
    const {recipe, ...plan} = campaignRecipe(definition.id, {...leadBusiness, name: 'Source <img onerror=bad>'});
    f.context.preview = {ready: true, provider_mutations: 0, recipe, plan};
    const html = new Script('conversionRecipePreview(preview)').runInContext(f.context);
    assert.match(
      html,
      locale === 'ar' ? /معاينة خطة سناب شات المتوقفة لجمع العملاء المحتملين/ : /Paused Snapchat lead-form preview/,
    );
    assert.match(
      html,
      locale === 'ar'
        ? /<h3>معاينة خطة سناب شات المتوقفة لجمع العملاء المحتملين<\/h3>/
        : /<h3>Paused Snapchat lead-form preview<\/h3>/,
    );
    assert.match(html, /20\.000001 USD/);
    assert.match(html, /Source &lt;img onerror=bad&gt;/);
    assert.doesNotMatch(html, /<img/);
    plan.steps[1].arguments.payload.adsquads[0].optimization_goal = 'PIXEL_PURCHASE';
    assert.doesNotMatch(new Script('conversionRecipePreview(preview)').runInContext(f.context), /<h3>/);
    plan.steps[1].arguments.payload.adsquads[0].optimization_goal = recipe.optimization_goal;
    plan.steps[1].arguments.payload.adsquads[0].child_ad_type = 'REMOTE_WEBPAGE';
    assert.doesNotMatch(new Script('conversionRecipePreview(preview)').runInContext(f.context), /<h3>/);
  });
  test('lead ' + locale + ' evidence displays only the current linked account-owned definition', async t => {
    const native = leadFixture();
    t.after(() => native.close());
    native.form.title = 'Source <img onerror=bad>';
    const out = await native.campaign({
      action: 'recipe_eligibility',
      recipe: 'snapchat_lead_generation',
      business: leadBusiness,
      live: true,
    });
    assert.equal(out.success, true, JSON.stringify(out.error));
    const f = fixture(locale);
    await f.mount();
    f.context.evidence = out.data;
    const html = new Script('snapchatCreativeInspectionView(evidence)').runInContext(f.context);
    assert.match(html, /Source &lt;img onerror=bad&gt;/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /form1/);
    out.data.dependencies.find(x => x.id === 'existing_lead_form').evidence.connection_id = 'foreign-login';
    assert.equal(new Script('snapchatCreativeInspectionView(evidence)').runInContext(f.context), '');
  });
}
for (const locale of ['en', 'ar']) {
  test(
    'Snapchat ' + locale + ' brief preserves explicit boolean declaration, native IDs and offset schedule',
    async () => {
      const definition = campaignRecipes.find(r => r.id === 'snapchat_website_traffic');
      const f = fixture(locale, [], definition, trafficBusiness);
      await f.mount();
      const fields = f.node('#recipe-fields').innerHTML;
      assert.equal((fields.match(/name="start_time"/g) ?? []).length, 1);
      assert.equal((fields.match(/name="end_time"/g) ?? []).length, 1);
      assert.doesNotMatch(fields, /name="start_date"/);
      assert.match(fields, locale === 'ar' ? /إقرار الإعلان الخاضع للقيود/ : /Regulated advertising declaration/);
      const business = new Script("readRecipeBusiness($('#recipe-form'))").runInContext(f.context);
      assert.equal(business.regulated_content, false);
      assert.equal(business.creative_id, trafficBusiness.creative_id);
      assert.equal(business.start_time, trafficBusiness.start_time);
      assert.equal(business.account_id, trafficBusiness.account_id);
      f.form.values.regulated_content = 'true';
      assert.equal(new Script("readRecipeBusiness($('#recipe-form'))").runInContext(f.context).regulated_content, true);
    },
  );
  test('Snapchat ' + locale + ' preview explains exact paused controls and escapes source names', async () => {
    const definition = campaignRecipes.find(r => r.id === 'snapchat_website_traffic'),
      f = fixture(locale, [], definition, trafficBusiness);
    await f.mount();
    const {recipe, ...plan} = campaignRecipe(definition.id, {...trafficBusiness, name: 'Native <img onerror=bad>'});
    f.context.preview = {ready: true, provider_mutations: 0, recipe, plan};
    const html = new Script('conversionRecipePreview(preview)').runInContext(f.context);
    assert.match(html, locale === 'ar' ? /معاينة خطة زيارات سناب شات المتوقفة/ : /Paused Snapchat traffic preview/);
    assert.match(html, /20\.000001 USD/);
    assert.match(html, /20000001/);
    assert.match(html, /Native &lt;img onerror=bad&gt;/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, locale === 'ar' ? /التفعيل إلى مراجعة منفصلة/ : /Activation requires a separate review/);
    f.context.preview.plan.steps[2].arguments.payload.ads[0].status = 'ACTIVE';
    assert.doesNotMatch(new Script('conversionRecipePreview(preview)').runInContext(f.context), /<h3>/);
  });
}
test('Snapchat creative evidence is displayed only for the exact current account and escapes its destination', async () => {
  const f = fixture('ar');
  await f.mount();
  f.context.evidence = {
    provider_mutations: 0,
    scope: {gateway: 'snapchat_native_action', connection_id: 'login', account_id: 'acct1'},
    dependencies: [
      {
        id: 'existing_website_creative',
        status: 'ready',
        evidence: {
          asset_type: 'Snapchat creative',
          asset_id: trafficBusiness.creative_id,
          connection_id: 'login',
          account_id: 'acct1',
          creative_type: 'WEB_VIEW',
          destination_status: 'syntax_checked',
          original_destination: 'https://example.test/?native=<img>',
          review_status: 'APPROVED',
        },
      },
    ],
  };
  const html = new Script('snapchatCreativeInspectionView(evidence)').runInContext(f.context);
  assert.match(html, /الوجهة الأصلية للتصميم/);
  assert.match(html, /&lt;img&gt;/);
  assert.doesNotMatch(html, /<img/);
  f.context.evidence.scope.account_id = 'foreign';
  assert.equal(new Script('snapchatCreativeInspectionView(evidence)').runInContext(f.context), '');
});
test('known recipe spend-policy notices localize their bounded account meaning without changing native approval requirements', async () => {
  const f = fixture('ar');
  await f.mount();
  for (const accounts of [[{account_id: 'acct1'}], [{account_id: 'acct1'}, {account_id: 'acct2'}]]) {
    f.context.notice = {code: 'SPEND_POLICY_MISSING', accounts, message: 'Native unlocalized source warning'};
    const text = new Script('recipePolicyNotice(notice)').runInContext(f.context);
    assert.match(text, /سياسة إنفاق/);
    assert.match(text, /الموافقة على الإنفاق/);
    assert.doesNotMatch(text, /Native unlocalized/);
  }
  f.context.notice = {code: 'UNKNOWN_SOURCE', accounts: [], message: 'Native <script> source'};
  assert.equal(new Script('recipePolicyNotice(notice)').runInContext(f.context), 'Native <script> source');
});
test('conversion goal and CPA limitations localize authored copy and escape unknown source text', async () => {
  const message =
    'Uses account-default conversion goals without changing them. Verify current biddable goals, primary conversion actions, event delivery and provider eligibility before activation. A target CPA is an average optimization target, not a spending cap or guarantee.';
  const f = fixture('ar', [message, 'Native <img onerror=bad> 001']);
  await f.mount();
  assert.match(f.node('#recipe-fields').innerHTML, /أهداف التحويل الافتراضية للحساب/);
  assert.doesNotMatch(f.node('#recipe-fields').innerHTML, /Uses account-default/);
  assert.match(f.node('#recipe-fields').innerHTML, /Native &lt;img onerror=bad&gt; 001/);
  assert.doesNotMatch(f.node('#recipe-fields').innerHTML, /<img/);
});

function fixture(locale = 'en', limitations = [], definition, business = base) {
  const nodes = new Map(),
    calls = [],
    sections = [],
    opened = [],
    catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  let reply = () => ({ready: true, plan: {name: 'Original brief'}});
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        innerHTML: '',
        textContent: '',
        value: '',
        isConnected: true,
        disabled: false,
        events: new Map(),
        addEventListener(event, fn) {
          this.events.set(event, fn);
        },
        after(section) {
          sections.push(section);
        },
        focus() {},
        setAttribute() {},
        append() {},
        querySelector: selector => node(selector),
        querySelectorAll: () => [],
        reportValidity: () => true,
      });
    return nodes.get(id);
  };
  node('#recipe-choice').value = definition?.id ?? 'google_search';
  const form = node('#recipe-form');
  form.values = Object.fromEntries(
    Object.entries(business).map(([k, v]) => [k, Array.isArray(v) ? v.join('\n') : String(v)]),
  );
  form.values.target = JSON.stringify({
    connection_id: business.connection_id ?? 'synthetic-login',
    account_id: business.account_id ?? '123',
  });
  form.elements = new Proxy(
    {},
    {
      get: (_, key) => ({
        get value() {
          return form.values[key] ?? '';
        },
        set value(v) {
          form.values[key] = v;
        },
        addEventListener() {},
        setAttribute() {},
      }),
    },
  );
  const context = createContext({
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'operator'},
    document: {createElement: () => node('section-' + sections.length), addEventListener() {}},
    $: node,
    FormData: class {
      constructor(form) {
        this.form = form;
      }
      [Symbol.iterator]() {
        return Object.entries(this.form.values)[Symbol.iterator]();
      }
    },
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    uiText: value => (locale === 'ar' ? (catalog[value] ?? value) : value),
    uiNumber: value => new Intl.NumberFormat(locale).format(value),
    pretty: value => String(value).replaceAll('_', ' '),
    badge: value => '<span>' + String(value) + '</span>',
    date: value => String(value),
    recordDetails: value => '<pre>' + JSON.stringify(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre>',
    toast() {},
    workspaceCall: async (_tool, args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      if (args.action === 'recipes') return {recipes: [definition ?? {id: 'google_search', name: 'Google Search'}]};
      if (args.action === 'recipe_context')
        return {
          recipe: definition ?? {
            id: 'google_search',
            platform: 'google',
            required: ['name', 'currency', 'account_id', 'connection_id', 'daily_budget', 'cpc_bid'],
          },
          targets: [
            {
              connection_id: 'synthetic-login',
              account_id: '123',
              label: 'Synthetic',
              currency: 'USD',
              write_granted: true,
            },
          ],
          defaults: {},
          limitations,
          pages: [],
          drive_connections: [],
        };
      return reply(args);
    },
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  context.fixtureLocale = locale;
  context.fixtureCatalog = locale === 'ar' ? catalog : {};
  new Script('uiLocale = fixtureLocale; uiMessages = new Map(Object.entries(fixtureCatalog));').runInContext(context);
  new Script(readFileSync('web/campaign-recipes.js', 'utf8')).runInContext(context);
  context.openCampaign = async id => opened.push(id);
  return {
    context,
    node,
    calls,
    sections,
    opened,
    form,
    respond: fn => {
      reply = fn;
    },
    mount: () => new Script('mountRecipeBuilder([], openCampaign)').runInContext(context),
  };
}
test('recipe inspections discard results for a brief edited during the request', async () => {
  const f = fixture();
  await f.mount();
  const wait = deferred();
  f.respond(() => wait.promise);
  const pending = f.node('#recipe-inspect').events.get('click')();
  f.form.values.name = 'Changed brief';
  wait.resolve({ready: true, plan: {name: 'Old brief'}});
  await pending;
  assert.equal(f.node('#recipe-preview').innerHTML, '');
});
for (const locale of ['en', 'ar'])
  test('recipe eligibility is readable in ' + locale + ' and uses the current exact brief', async () => {
    const f = fixture(locale);
    await f.mount();
    f.respond(() => ({
      status: 'unknown',
      scope: {account_id: '123', connection_id: 'synthetic-login'},
      dependencies: [
        {id: 'account_currency', status: 'ready', meaning: 'Currency <img> confirmed', evidence: {currency: 'USD'}},
        {id: 'provider_objective_acceptance', status: 'unknown', meaning: 'Unverified'},
      ],
      blockers: [],
      deferred: [],
      accounts: [],
      provider_mutations: 0,
    }));
    const check = f.node('#recipe-eligibility').events.get('click');
    assert.ok(check, 'Eligibility button');
    await check();
    const sent = f.calls.find(c => c.action === 'recipe_eligibility');
    assert.equal(sent.live, true);
    assert.equal(sent.business.account_id, '123');
    assert.equal(sent.business.connection_id, 'synthetic-login');
    assert.ok(f.node('#recipe-preview').innerHTML.includes('account_currency'));
    assert.ok(f.node('#recipe-preview').innerHTML.includes('&lt;img&gt;'));
    assert.ok(!f.node('#recipe-preview').innerHTML.includes('Currency <img>'));
    assert.ok(!f.calls.some(c => c.action === 'create_from_recipe'));
    if (locale === 'ar') assert.ok(f.node('#recipe-preview').innerHTML.includes('أدلة متطلبات الحساب'));
  });
// CON-03: the capability graph names recipe_eligibility with live:false as the resolver of brief dependencies; the
// builder offers it as "Check this brief", which checks the exact brief without a provider read.
test('Check this brief checks the current brief with live:false', async () => {
  const f = fixture();
  await f.mount();
  f.respond(() => ({
    status: 'unknown',
    scope: {account_id: '123', connection_id: 'synthetic-login'},
    dependencies: [{id: 'landing_page', status: 'needs_user_input', meaning: 'Brief input'}],
    blockers: [],
    deferred: [],
    accounts: [],
    provider_mutations: 0,
  }));
  const check = f.node('#recipe-brief-check').events.get('click');
  assert.ok(check, 'Check this brief button');
  await check();
  const sent = f.calls.find(c => c.action === 'recipe_eligibility');
  assert.equal(sent.live, false);
  assert.equal(sent.business.account_id, '123');
  assert.ok(f.node('#recipe-preview').innerHTML.includes('landing_page'));
  assert.ok(!f.calls.some(c => c.action === 'create_from_recipe'));
});
test('late recipe failures cannot replace a changed form with an old error', async () => {
  const f = fixture();
  await f.mount();
  let reject;
  f.respond(() => new Promise((_r, j) => (reject = j)));
  const pending = f.node('#recipe-inspect').events.get('click')();
  f.form.values.currency = 'SAR';
  reject(Error('Old provider diagnostic'));
  await pending;
  assert.equal(f.node('#recipe-error').textContent, '');
});

test('targeting results are discarded after a different advertising account is selected', async () => {
  const f = fixture();
  await f.mount();
  const wait = deferred();
  f.respond(() => wait.promise);
  f.node('#recipe-lookup-kind').value = 'country';
  f.node('#recipe-lookup-query').value = 'Saudi';
  const pending = f.node('#recipe-lookup').events.get('click')();
  f.form.values.target = JSON.stringify({connection_id: 'another-login', account_id: '999'});
  wait.resolve({results: [{id: '2682', name: 'Saudi Arabia'}]});
  await pending;
  assert.equal(f.node('#recipe-lookup-results').innerHTML, '');
});

test('targeting errors are discarded after the query is edited', async () => {
  const f = fixture();
  await f.mount();
  let reject;
  f.respond(() => new Promise((_r, j) => (reject = j)));
  f.node('#recipe-lookup-kind').value = 'country';
  f.node('#recipe-lookup-query').value = 'Old';
  const pending = f.node('#recipe-lookup').events.get('click')();
  f.node('#recipe-lookup-query').value = 'New';
  reject(Error('Old targeting failure'));
  await pending;
  assert.equal(f.node('#recipe-error').textContent, '');
});

for (const epoch of ['navigationGeneration', 'identityGeneration'])
  test('recipe results cannot cross ' + epoch, async () => {
    const f = fixture();
    await f.mount();
    const wait = deferred();
    f.respond(() => wait.promise);
    const pending = f.node('#recipe-inspect').events.get('click')();
    f.context[epoch]++;
    wait.resolve({ready: true, plan: {name: 'Obsolete workspace'}});
    await pending;
    assert.equal(f.node('#recipe-preview').innerHTML, '');
  });

test('editing an already inspected brief clears its old result immediately', async () => {
  const f = fixture();
  await f.mount();
  await f.node('#recipe-inspect').events.get('click')();
  assert.ok(f.node('#recipe-preview').innerHTML);
  f.form.values.daily_budget = '99';
  f.form.events.get('input')();
  assert.equal(f.node('#recipe-preview').innerHTML, '');
});

test('saving a recipe removes its unsaved preview only after a successful local save in both languages', async () => {
  for (const locale of ['en', 'ar']) {
    for (const refused of [false, true]) {
      const f = fixture(locale);
      await f.mount();
      await f.node('#recipe-inspect').events.get('click')();
      const preview = f.node('#recipe-preview').innerHTML;
      assert.ok(preview);
      f.respond(() => {
        if (refused) throw Error('Synthetic save refused');
        return {id: 'synthetic-paused-plan'};
      });
      await f.form.events.get('submit')({preventDefault() {}});
      assert.equal(f.node('#recipe-preview').innerHTML, refused ? preview : '');
      assert.deepEqual(f.opened, refused ? [] : ['synthetic-paused-plan']);
      assert.equal(f.node('#recipe-error').textContent, refused ? 'Synthetic save refused' : '');
      assert.equal(f.calls.filter(c => c.action === 'create_from_recipe').length, 1);
    }
  }
});
