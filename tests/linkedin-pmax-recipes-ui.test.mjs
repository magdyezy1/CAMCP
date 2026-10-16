// CMP-07 (pending P7): the guided LinkedIn lead generation and Google Performance Max packs in the website's
// recipe composer, in English and Arabic. Native values (calls to action, declarations, URNs) stay literal with
// translated explanations; each preview shows the paused launch only when the compiled plan is exactly the pack.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeComposerFixture as fixture} from './fixtures/recipe-composer-ui.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const definitionOf = id => JSON.parse(JSON.stringify(campaignRecipes.find(r => r.id === id)));

for (const locale of ['en', 'ar']) {
  test(
    'LinkedIn ' + locale + ' brief offers the lead form calls to action and the political declaration literally',
    async () => {
      const business = examples.linkedin_lead_business,
        f = fixture(locale, definitionOf('linkedin_lead_generation'), business);
      await f.mount();
      const fields = f.node('#recipe-fields').innerHTML;
      assert.match(fields, locale === 'ar' ? /معرّفات URN لمواقع LinkedIn/ : /LinkedIn location URNs — one per line/);
      assert.match(
        fields,
        locale === 'ar' ? /معرّف URN للمنشور الموجود المراد ترويجه/ : /Existing post URN to sponsor/,
      );
      assert.match(fields, /<option value="REQUEST_DEMO"[^>]*>REQUEST_DEMO<\/option>/);
      assert.doesNotMatch(fields, /SHOP_NOW/, 'TikTok’s calls to action are not LinkedIn lead form labels');
      assert.match(fields, /<option value="NOT_POLITICAL"[^>]*>NOT_POLITICAL — /);
      assert.match(fields, locale === 'ar' ? /ليست إعلانات سياسية/ : /Not political advertising/);
      assert.doesNotMatch(fields, /value="POLITICAL"/, 'political advertising is never offered');
      assert.match(fields, /name="start_time_local" required type="datetime-local"/);
      f.form.values.location_urns = 'urn:li:geo:103644278\n urn:li:geo:101165590 \n';
      f.form.values.start_time_local = '2026-11-01T10:00';
      f.form.values.schedule_timezone = 'Asia/Riyadh';
      const read = f.run("readRecipeBusiness($('#recipe-form'))");
      assert.deepEqual([...read.location_urns], ['urn:li:geo:103644278', 'urn:li:geo:101165590']);
      assert.equal(read.start_time, '2026-11-01T10:00:00+03:00');
      assert.equal(read.political_intent, 'NOT_POLITICAL');
      // What the form reads compiles to the reviewed creates.
      const plan = campaignRecipe('linkedin_lead_generation', {...business, ...read});
      assert.equal(plan.steps[1].arguments.payload.runSchedule.start, Date.parse('2026-11-01T07:00:00Z'));
    },
  );

  test(
    'LinkedIn ' + locale + ' preview shows the paused launch and refuses a plan that is not exactly the pack',
    async () => {
      const business = examples.linkedin_lead_business,
        f = fixture(locale, definitionOf('linkedin_lead_generation'), business);
      await f.mount();
      const {recipe, ...plan} = campaignRecipe('linkedin_lead_generation', {
        ...business,
        name: 'Native <img onerror=bad>',
      });
      f.context.preview = {ready: true, provider_mutations: 0, recipe, plan};
      const html = f.run('conversionRecipePreview(preview)');
      assert.match(
        html,
        locale === 'ar'
          ? /<h3>معاينة خطة LinkedIn المتوقفة لجذب العملاء المحتملين<\/h3>/
          : /<h3>Paused LinkedIn lead generation preview<\/h3>/,
      );
      assert.match(html, /50 USD/);
      assert.match(html, /urn:li:geo:103644278/);
      assert.match(html, /urn:li:share:9001/);
      assert.match(html, /4242/);
      assert.match(html, /2026-11-01T07:00:00Z/, 'the UTC start LinkedIn receives is shown');
      assert.match(html, /Native &lt;img onerror=bad&gt;/);
      assert.doesNotMatch(html, /<img/);
      assert.match(html, locale === 'ar' ? /يتطلب التفعيل مراجعة منفصلة/ : /Activation requires a separate review/);
      assert.match(html, locale === 'ar' ? /إلا بعد نشر نموذجها/ : /serves only once its form is published/);
      // A launch that would serve, a changed budget, another form or an added step is never shown as the paused pack.
      for (const mutate of [
        p => (p.steps[0].arguments.payload.status = 'ACTIVE'),
        p => (p.steps[2].arguments.payload.intendedStatus = 'ACTIVE'),
        p => (p.steps[1].arguments.payload.dailyBudget.amount = '99'),
        p => (p.steps[1].arguments.payload.totalBudget = {amount: '500', currencyCode: 'USD'}),
        p => (p.steps[2].arguments.payload.leadgenCallToAction.destination = 'urn:li:adForm:1'),
        p => p.steps.push(structuredClone(p.steps[2])),
      ]) {
        const copy = structuredClone(plan);
        mutate(copy);
        f.context.preview = {ready: true, provider_mutations: 0, recipe, plan: copy};
        assert.doesNotMatch(f.run('conversionRecipePreview(preview)'), /<h3>/);
      }
    },
  );

  test('Performance Max ' + locale + ' brief and preview show the one paused build with its asset counts', async () => {
    const business = examples.google_pmax_business,
      f = fixture(locale, definitionOf('google_performance_max'), business);
    await f.mount();
    const fields = f.node('#recipe-fields').innerHTML;
    assert.match(
      fields,
      locale === 'ar' ? /عناوين حملة الأداء الأقصى/ : /Performance Max headlines — one per line \(3–15/,
    );
    assert.match(fields, /<option value="DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"/);
    assert.match(fields, /<option value="ACCOUNT_DEFAULT"/);
    const {recipe, ...plan} = campaignRecipe('google_performance_max', {...business, name: 'Native <img onerror=bad>'});
    f.context.preview = {ready: true, provider_mutations: 0, recipe, plan};
    const html = f.run('conversionRecipePreview(preview)');
    assert.match(
      html,
      locale === 'ar' ? /<h3>معاينة حملة الأداء الأقصى المتوقفة<\/h3>/ : /<h3>Paused Performance Max preview<\/h3>/,
    );
    assert.match(html, /50 USD/);
    assert.match(html, /50000000/);
    assert.match(html, /HEADLINE 3 · LONG_HEADLINE 1 · DESCRIPTION 2 · BUSINESS_NAME 1/);
    assert.match(html, /DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING/);
    assert.match(html, locale === 'ar' ? /زيادة التحويلات إلى أقصى حد/ : /Maximize Conversions/);
    assert.match(html, /Native &lt;img onerror=bad&gt;/);
    assert.doesNotMatch(html, /<img/);
    const ops = p => p.steps[0].arguments.payload.mutate_operations,
      create = (p, key) => ops(p).find(o => o[key])[key].create;
    for (const mutate of [
      p => (create(p, 'campaign_operation').status = 'ENABLED'),
      p => (create(p, 'campaign_budget_operation').amount_micros = '99000000'),
      p => (create(p, 'campaign_operation').target_roas = {target_roas: 3}),
      p => ops(p).push({asset_group_asset_operation: {create: {field_type: 'HEADLINE'}}}),
      p => (create(p, 'asset_group_operation').campaign = 'customers/999/campaigns/-2'),
      p => (p.steps[0].arguments.payload.partial_failure = true),
    ]) {
      const copy = structuredClone(plan);
      mutate(copy);
      f.context.preview = {ready: true, provider_mutations: 0, recipe, plan: copy};
      assert.doesNotMatch(f.run('conversionRecipePreview(preview)'), /<h3>/);
    }
  });
}

test('Performance Max is its own workflow, not one of the Google Search bidding choices', () => {
  const f = fixture('en', definitionOf('google_performance_max'), examples.google_pmax_business);
  f.context.recipesList = campaignRecipes.map(r => JSON.parse(JSON.stringify(r)));
  const sales = f.run("recipeOptions(recipesList, 'sales', 'google_performance_max')"),
    search = f.run("recipeOptions(recipesList, 'search', 'google_search_conversions')");
  assert.match(sales, /value="google_performance_max"/);
  assert.doesNotMatch(sales, /<optgroup/, 'Performance Max is not listed as a Search bidding strategy');
  assert.match(search, /<optgroup label="Google Search — choose the bidding">.*value="google_search_conversions"/);
  assert.doesNotMatch(search, /google_performance_max/);
});
