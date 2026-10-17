// The website's recipe composer (web/campaign-recipes.js) in a synthetic browser context, in English or Arabic, for
// the guided packs' brief forms and paused-launch previews (CMP-07). Nothing reaches a server or provider.
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

export const arabicCatalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));

// `options.context` adds fields to the recipe_context answer and `options.reply(args)` answers every other action
// (CMP-03's Microsoft location lookup); `calls` keeps every request the page sent.
export function recipeComposerFixture(locale, definition, business, target = {}, options = {}) {
  const calls = [];
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
        focus() {},
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
    uiText: value => (locale === 'ar' ? (arabicCatalog[value] ?? value) : value),
    uiNumber: value => new Intl.NumberFormat(locale).format(value),
    pretty: value => String(value).replaceAll('_', ' '),
    badge: value => '<span>' + String(value) + '</span>',
    date: value => String(value),
    recordDetails: value => '<pre>' + JSON.stringify(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre>',
    toast() {},
    crypto: {randomUUID: () => 'synthetic-creation-key'},
    workspaceCall: async (_tool, args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      if (args.action === 'recipes') return {recipes: [definition]};
      if (args.action === 'recipe_context')
        return {
          recipe: definition,
          targets: [
            {
              connection_id: business.connection_id,
              account_id: business.account_id,
              label: 'Synthetic account',
              currency: 'USD',
              timezone: 'Asia/Riyadh',
              write_granted: true,
              ...target,
            },
          ],
          defaults: {},
          limitations: [],
          pages: [],
          drive_connections: [],
          ...options.context,
        };
      return options.reply ? options.reply(args) : {ready: true, plan: {name: 'x'}};
    },
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  context.fixtureLocale = locale;
  context.fixtureCatalog = locale === 'ar' ? arabicCatalog : {};
  new Script('uiLocale = fixtureLocale; uiMessages = new Map(Object.entries(fixtureCatalog));').runInContext(context);
  new Script(readFileSync('web/campaign-recipes.js', 'utf8')).runInContext(context);
  return {
    context,
    node,
    form,
    calls,
    run: code => new Script(code).runInContext(context),
    mount: () => new Script('mountRecipeBuilder([], async () => {})').runInContext(context),
  };
}
