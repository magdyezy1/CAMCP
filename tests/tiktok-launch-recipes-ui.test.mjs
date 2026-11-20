// CMP-07 (implementer default pending P7): the guided TikTok packs in the website's recipe composer, in English and
// Arabic. The brief form offers the native identity types, calls to action and purchase events as literal values with
// translated explanations, reads location IDs one per line, and the preview shows the paused launch only when the
// compiled plan is exactly the pack's three creates under a DISABLE campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeComposerFixture as fixture} from './fixtures/recipe-composer-ui.mjs';
import {pinBeforeTiktokCutoff} from './helpers/tiktok-cutoff-clock.mjs';

// Package r25-m4-classic: TikTok stops classic Sales, App Promotion and Lead Generation creates on 2027-01-01 and AMCP refuses them from
// that day (src/tiktok-manual-cutoff.ts); the recipe composer shows the website purchases pack (a classic Sales campaign), so the clock is pinned before it.
pinBeforeTiktokCutoff();

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));

for (const locale of ['en', 'ar']) {
  test('TikTok ' + locale + ' brief offers literal native choices with translated explanations', async () => {
    const definition = JSON.parse(JSON.stringify(campaignRecipes.find(r => r.id === 'tiktok_website_conversions'))),
      business = examples.tiktok_conversion_business,
      f = fixture(locale, definition, business);
    await f.mount();
    const fields = f.node('#recipe-fields').innerHTML;
    assert.match(fields, locale === 'ar' ? /معرّف منشور تيك توك الموجود/ : /Existing TikTok post ID/);
    assert.match(fields, locale === 'ar' ? /معرّفات مواقع تيك توك/ : /TikTok location IDs — one per line/);
    // Native values stay literal in both languages; only their explanation is translated.
    assert.match(fields, /<option value="TT_USER"[^>]*>TT_USER — /);
    assert.match(fields, /<option value="BC_AUTH_TT"[^>]*>BC_AUTH_TT — /);
    assert.match(
      fields,
      locale === 'ar' ? /حساب تيك توك مفوَّض عبر مركز أعمال/ : /TikTok account authorized through a Business Center/,
    );
    assert.match(fields, /<option value="SHOP_NOW"[^>]*>SHOP_NOW<\/option>/);
    assert.match(fields, /<option value="SHOPPING"[^>]*>SHOPPING — /);
    assert.match(fields, locale === 'ar' ? /إتمام الدفع/ : /Complete payment/);
    assert.doesNotMatch(fields, /CUSTOMIZED_USER/, 'a custom identity is never offered for the TikTok placement');
    // The schedule is a datetime-local picker in the advertiser's timezone, like the other timed packs.
    assert.match(fields, /name="start_time_local" required type="datetime-local"/);
    assert.match(fields, locale === 'ar' ? /هوية مركز الأعمال/ : /Business Center identity/);
    f.form.values.location_ids = '6252001\n 102358 \n';
    f.form.values.start_time_local = '2026-11-01T10:00';
    f.form.values.schedule_timezone = 'Asia/Riyadh';
    const read = f.run("readRecipeBusiness($('#recipe-form'))");
    assert.deepEqual([...read.location_ids], ['6252001', '102358']);
    assert.equal(read.start_time, '2026-11-01T10:00:00+03:00');
    assert.equal(read.identity_type, 'TT_USER');
    assert.equal(read.optimization_event, 'SHOPPING');
    // What the form reads compiles to the reviewed creates.
    const plan = campaignRecipe('tiktok_website_conversions', {...business, ...read});
    assert.equal(plan.steps[1].arguments.payload.schedule_start_time, '2026-11-01 07:00:00');
  });

  test(
    'TikTok ' + locale + ' preview shows the paused launch and refuses a plan that is not exactly the pack',
    async () => {
      for (const id of ['tiktok_website_traffic', 'tiktok_website_conversions']) {
        const definition = JSON.parse(JSON.stringify(campaignRecipes.find(r => r.id === id))),
          business =
            id === 'tiktok_website_traffic' ? examples.tiktok_traffic_business : examples.tiktok_conversion_business,
          f = fixture(locale, definition, business);
        await f.mount();
        const {recipe, ...plan} = campaignRecipe(id, {...business, name: 'Native <img onerror=bad>'});
        f.context.preview = {ready: true, provider_mutations: 0, recipe, plan};
        const html = f.run('conversionRecipePreview(preview)');
        const title =
          id === 'tiktok_website_traffic'
            ? locale === 'ar'
              ? /<h3>معاينة خطة زيارات موقع تيك توك المتوقفة<\/h3>/
              : /<h3>Paused TikTok website traffic preview<\/h3>/
            : locale === 'ar'
              ? /<h3>معاينة خطة مشتريات موقع تيك توك المتوقفة<\/h3>/
              : /<h3>Paused TikTok website purchases preview<\/h3>/;
        assert.match(html, title);
        assert.match(html, /25\.5 USD/);
        assert.match(html, /6252001/);
        assert.match(html, /2026-11-01 07:00:00/, 'the UTC time TikTok receives is shown');
        assert.match(html, /Native &lt;img onerror=bad&gt;/);
        assert.doesNotMatch(html, /<img/);
        assert.match(html, locale === 'ar' ? /يتطلب التفعيل مراجعة منفصلة/ : /Activation requires a separate review/);
        if (id === 'tiktok_website_conversions') assert.match(html, /456 · SHOPPING/);
        // A campaign that would start delivering, or a changed budget, is never shown as the paused pack.
        for (const mutate of [
          p => (p.steps[0].arguments.payload.operation_status = 'ENABLE'),
          p => (p.steps[1].arguments.payload.budget = 99),
          p => p.steps[2].arguments.payload.creatives.push({}),
        ]) {
          const copy = JSON.parse(JSON.stringify(plan));
          mutate(copy);
          f.context.preview = {ready: true, provider_mutations: 0, recipe, plan: copy};
          assert.doesNotMatch(f.run('conversionRecipePreview(preview)'), /<h3>/);
        }
      }
    },
  );
}
