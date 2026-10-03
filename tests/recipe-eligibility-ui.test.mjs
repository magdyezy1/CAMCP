import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
const base = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8')).recipe_business;
const deferred = () => {
  let resolve;
  const promise = new Promise(r => (resolve = r));
  return {promise, resolve};
};
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

function fixture(locale = 'en', limitations = []) {
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
  node('#recipe-choice').value = 'google_search';
  const form = node('#recipe-form');
  form.values = Object.fromEntries(
    Object.entries(base).map(([k, v]) => [k, Array.isArray(v) ? v.join('\n') : String(v)]),
  );
  form.values.target = JSON.stringify({connection_id: 'synthetic-login', account_id: '123'});
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
    document: {createElement: () => node('section-' + sections.length)},
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
    pretty: value => String(value).replaceAll('_', ' '),
    badge: value => '<span>' + String(value) + '</span>',
    date: value => String(value),
    recordDetails: value => '<pre>' + JSON.stringify(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre>',
    toast() {},
    workspaceCall: async (_tool, args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      if (args.action === 'recipes') return {recipes: [{id: 'google_search', name: 'Google Search'}]};
      if (args.action === 'recipe_context')
        return {
          recipe: {
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
