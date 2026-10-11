// CMP-07 (owner direction P7): the guided TikTok packs in the website's recipe composer, in English and Arabic. The
// brief form offers the native identity types, calls to action and purchase events as literal values with translated
// explanations, reads location IDs one per line, and the preview shows the paused launch only when the compiled plan
// is exactly the pack's three creates under a DISABLE campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));

function fixture(locale, definition, business) {
  const nodes = new Map();
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
        after() {},
        focus() {},
        setAttribute() {},
        append() {},
        querySelector: selector => node(selector),
        querySelectorAll: () => [],
        reportValidity: () => true,
      });
    return nodes.get(id);
  };
  node('#recipe-choice').value = definition.id;
  const form = node('#recipe-form');
  form.values = Object.fromEntries(
    Object.entries(business).map(([k, v]) => [k, Array.isArray(v) ? v.join('\n') : String(v)]),
  );
  form.values.target = JSON.stringify({connection_id: business.connection_id, account_id: business.account_id});
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
    document: {createElement: () => node('section'), addEventListener() {}},
    $: node,
    FormData: class {
      constructor(f) {
        this.f = f;
      }
      [Symbol.iterator]() {
        return Object.entries(this.f.values)[Symbol.iterator]();
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
    crypto: {randomUUID: () => 'synthetic-creation-key'},
    workspaceCall: async (_tool, args) => {
      if (args.action === 'recipes') return {recipes: [definition]};
      if (args.action === 'recipe_context')
        return {
          recipe: definition,
          targets: [
            {
              connection_id: business.connection_id,
              account_id: business.account_id,
              label: 'Synthetic TikTok',
              currency: 'USD',
              timezone: 'Asia/Riyadh',
              write_granted: true,
            },
          ],
          defaults: {},
          limitations: [],
          pages: [],
          drive_connections: [],
        };
      return {ready: true, plan: {name: 'x'}};
    },
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  context.fixtureLocale = locale;
  context.fixtureCatalog = locale === 'ar' ? catalog : {};
  new Script('uiLocale = fixtureLocale; uiMessages = new Map(Object.entries(fixtureCatalog));').runInContext(context);
  new Script(readFileSync('web/campaign-recipes.js', 'utf8')).runInContext(context);
  return {
    context,
    node,
    form,
    run: code => new Script(code).runInContext(context),
    mount: () => new Script('mountRecipeBuilder([], async () => {})').runInContext(context),
  };
}

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
