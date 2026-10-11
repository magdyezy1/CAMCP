// CMP-06: the recipe composer lost its place (an in-memory draft map, the first recipe after every visit, nothing
// after a reload), listed every pack with only one platform connected, made the person pick a sole account, took
// schedule times as free text with an offset, accepted Meta images only as Drive links, never showed or applied the
// playbook rules, and could not save or reuse a brief.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {trafficBusiness} from './fixtures/snapchat-traffic-data.mjs';

function fakeNode(nodes, id) {
  if (!nodes.has(id))
    nodes.set(id, {
      id,
      innerHTML: '',
      textContent: '',
      value: '',
      open: false,
      checked: false,
      disabled: false,
      isConnected: true,
      events: new Map(),
      addEventListener(type, fn) {
        this.events.set(type, fn);
      },
      setAttribute() {},
      after() {},
      append() {},
      focus() {},
      reportValidity: () => true,
      querySelector: selector => fakeNode(nodes, selector),
      querySelectorAll: () => [],
    });
  return nodes.get(id);
}
const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const recipes = campaignRecipes.map(r => JSON.parse(JSON.stringify(r)));

function composer({
  connected = ['snapchat'],
  targets,
  conventions,
  storage = new Map(),
  sessionId = 'one',
  profiles,
  excluded = 0,
} = {}) {
  const nodes = new Map(),
    calls = [],
    toasts = [],
    node = id => fakeNode(nodes, id),
    form = node('#recipe-form');
  form.values = {};
  form.elements = new Proxy({}, {get: (_, key) => (key === 'page_id' ? undefined : node('field:' + String(key)))});
  const gateways = {google: 'google_ads_native_action', meta: 'meta_native_action', snapchat: 'snapchat_native_action'};
  const context = createContext({
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {authenticated: true, id: 'person', workspaceId: 'ws-' + sessionId, workspaceRole: 'operator', csrf: 'c'},
    identityKey: value =>
      JSON.stringify([value.authenticated, value.id, value.workspaceId, value.workspaceRole, value.csrf]),
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    platforms: Object.entries(gateways).map(([id, gateway]) => ({
      gateway,
      connections: connected.includes(id) ? [{id: id + '-login', enabled: true, accounts: ['1']}] : [],
    })),
    Intl,
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
    esc,
    uiText: (text, values = {}) => String(text).replace(/\{(\w+)\}/g, (_, k) => values[k] ?? ''),
    pretty: String,
    date: String,
    recordDetails: () => '',
    reviewTable: () => '',
    toast: text => toasts.push(text),
    crypto: {randomUUID: () => 'key-' + calls.length},
    workspaceCall: async (tool, args) => {
      calls.push({tool, ...JSON.parse(JSON.stringify(args))});
      if (args.action === 'recipes') return {recipes};
      if (args.action === 'recipe_context') {
        const recipe = recipes.find(r => r.id === args.recipe);
        return {
          recipe,
          targets: targets ?? [
            {
              connection_id: 'login',
              account_id: 'ad-1',
              label: 'Only',
              currency: 'SAR',
              timezone: 'Asia/Riyadh',
              write_granted: true,
            },
            {connection_id: 'login', account_id: 'ad-2', label: 'Read', currency: 'USD', write_granted: false},
          ],
          defaults: {},
          limitations: [],
          pages: [],
          drive_connections: [],
          profile: args.profile_id ? {id: args.profile_id, name: 'ACME', revision: 3} : null,
          conventions: args.profile_id ? (conventions ?? null) : null,
          excluded_by_playbook: args.profile_id ? excluded : 0,
        };
      }
      if (args.action === 'recipe_eligibility') return {status: 'unknown', eligibility_ref: 'elig-1', dependencies: []};
      if (args.action === 'preview_recipe')
        return {
          ready: true,
          plan: {name: 'x'},
          provenance: {
            conventions: {
              applied: true,
              name: {input: 'Spring', result: 'ACME | Spring'},
              destination_url: {input: 'https://a.test/', result: 'https://a.test/?utm_source=x'},
            },
          },
        };
      if (args.action === 'save_brief') return {id: 'brief-1', revision: 1, name: args.brief.name};
      if (args.action === 'briefs')
        return {briefs: [{id: 'brief-9', name: 'Saved <b>', recipe: 'snapchat_website_traffic', revision: 4}]};
      if (args.action === 'brief')
        return {
          id: 'brief-9',
          revision: 4,
          recipe: 'snapchat_website_traffic',
          profile_id: 'p1',
          business: {...trafficBusiness, country_codes: ['SA', 'AE']},
        };
      if (args.action === 'create_from_recipe') return {id: 'plan-1'};
      throw Error('unexpected ' + args.action);
    },
  });
  new Script(readFileSync('web/campaign-recipes.js', 'utf8')).runInContext(context);
  context.profiles = profiles ?? [{id: 'p1', name: 'ACME', revision: 3}];
  context.conversionRecipePreview = () => '<p>compiled</p>';
  return {
    context,
    node,
    calls,
    toasts,
    storage,
    form,
    run: code => new Script(code).runInContext(context),
    mount: () => new Script('mountRecipeBuilder(profiles, async () => {})').runInContext(context),
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const options = html => [...html.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);

test('with only Snapchat connected, the objective step offers only Snapchat workflows', async () => {
  const f = composer({connected: ['snapchat']});
  await f.mount();
  const html = f.node('section').innerHTML,
    objectives = /<select id="recipe-objective">(.*?)<\/select>/.exec(html)[1],
    workflows = /<select id="recipe-choice">(.*?)<\/select>/.exec(html)[1];
  assert.deepEqual(options(objectives), ['traffic', 'leads']);
  assert.deepEqual(options(workflows), ['snapchat_website_traffic']);
  assert.match(html, /Only workflows for platforms with a connected account are listed/);
  f.node('#recipe-objective').value = 'leads';
  await f.node('#recipe-objective').events.get('change')();
  assert.deepEqual(options(f.node('#recipe-choice').innerHTML), ['snapchat_lead_generation']);
  assert.equal(f.node('#recipe-choice').value, 'snapchat_lead_generation');
  // Google bidding strategies are one sub-choice under Search ads.
  const g = composer({connected: ['google']});
  await g.mount();
  assert.match(
    g.node('section').innerHTML,
    /<optgroup label="Google Search — choose the bidding"><option value="google_search"/,
  );
  assert.equal(
    options(/<select id="recipe-objective">(.*?)<\/select>/.exec(g.node('section').innerHTML)[1]).join(),
    'search',
  );
});

test('a sole eligible account is preselected with its currency and timezone', async () => {
  const f = composer();
  await f.mount();
  const fields = f.node('#recipe-fields').innerHTML;
  assert.match(
    fields,
    /<option value="\{&quot;connection_id&quot;:&quot;login&quot;,&quot;account_id&quot;:&quot;ad-1&quot;\}" selected>/,
  );
  assert.match(fields, /name="currency" value="SAR"/);
  assert.match(fields, /name="schedule_timezone" value="Asia\/Riyadh"/);
  assert.match(fields, /Times are in the account timezone: Asia\/Riyadh\./);
  // Two writable accounts: the person chooses.
  const two = composer({
    targets: [
      {connection_id: 'l', account_id: 'a', label: 'A', currency: 'SAR', write_granted: true},
      {connection_id: 'l', account_id: 'b', label: 'B', currency: 'USD', write_granted: true},
    ],
  });
  await two.mount();
  assert.doesNotMatch(two.node('#recipe-fields').innerHTML, /" selected>/);
  assert.match(two.node('#recipe-fields').innerHTML, /times are read as UTC/);
});

test('the time picker emits the offset timestamp the recipes accept, in the account timezone', async () => {
  const f = composer();
  assert.equal(f.run("recipeOffsetTime('2026-11-01T09:00', 'Asia/Riyadh')"), '2026-11-01T09:00:00+03:00');
  assert.equal(f.run("recipeOffsetTime('2026-07-01T09:30', 'America/New_York')"), '2026-07-01T09:30:00-04:00');
  assert.equal(f.run("recipeOffsetTime('2026-12-01T09:30', 'America/New_York')"), '2026-12-01T09:30:00-05:00');
  assert.equal(f.run("recipeOffsetTime('2026-12-01T09:30', 'Not/AZone')"), '2026-12-01T09:30:00+00:00');
  await f.mount();
  assert.match(f.node('#recipe-fields').innerHTML, /name="start_time_local" required type="datetime-local"/);
  f.form.values = {
    ...Object.fromEntries(
      Object.entries(trafficBusiness).map(([k, v]) => [k, Array.isArray(v) ? v.join('\n') : String(v)]),
    ),
    start_time: '',
    start_time_local: '2026-11-01T09:00',
    end_time_local: '2026-11-08T21:15',
    schedule_timezone: 'Asia/Riyadh',
  };
  delete f.form.values.end_time;
  const business = f.run("readRecipeBusiness($('#recipe-form'))");
  assert.equal(business.start_time, '2026-11-01T09:00:00+03:00');
  assert.equal(business.end_time, '2026-11-08T21:15:00+03:00');
  assert.equal(business.schedule_timezone, undefined);
  assert.equal(business.start_time_local, undefined);
  // preview_recipe compiles exactly these values.
  const plan = campaignRecipe('snapchat_website_traffic', {...trafficBusiness, ...business, regulated_content: false});
  assert.ok(JSON.stringify(plan.steps).includes('2026-11-01T09:00:00+03:00'));
  assert.doesNotThrow(() =>
    campaignRecipe('meta_website_traffic', {
      ...JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8')).recipe_business,
      start_time: business.start_time,
      end_time: business.end_time,
    }),
  );
});

test('in-app navigation and a reload restore the workflow, playbook and fields; sign-out and switching forget them', async () => {
  const storage = new Map();
  const first = composer({storage});
  await first.mount();
  first.node('#recipe-profile').value = 'p1';
  first.node('#recipe-profile').events.get('change')();
  await settle();
  first.form.values = {name: 'Spring push', daily_budget: '9'};
  first.node('#recipe-form').events.get('input')();
  const saved = JSON.parse(storage.get('amcp.recipe-drafts'));
  assert.deepEqual(saved.last, {recipe: 'snapchat_website_traffic', profile: 'p1'});
  assert.deepEqual(saved.drafts['["snapchat_website_traffic","p1"]'], {name: 'Spring push', daily_budget: '9'});
  // A reload: a new page with empty memory, the same tab storage and identity.
  const reload = composer({storage});
  await reload.mount();
  assert.equal(reload.node('#recipe-choice').value, 'snapchat_website_traffic');
  assert.equal(reload.node('#recipe-profile').value, 'p1');
  assert.match(reload.node('#recipe-fields').innerHTML, /name="name" required type="text" value="Spring push"/);
  // Another identity (a different workspace or sign-in) sees none of it.
  const other = composer({storage, sessionId: 'two'});
  await other.mount();
  assert.equal(other.node('#recipe-profile').value, '');
  assert.doesNotMatch(other.node('#recipe-fields').innerHTML, /Spring push/);
  // Signing out or switching workspace forgets the tab's drafts (web/app.js resetTabState()).
  reload.run('recipeDraftsForget()');
  assert.equal(storage.has('amcp.recipe-drafts'), false);
  const app = readFileSync('web/app.js', 'utf8');
  assert.match(app, /url === '\/api\/session' && method === 'DELETE'\) resetTabState\(\)/);
  assert.match(app, /url === '\/api\/workspaces\/switch'\) resetTabState\(\)/);
  assert.match(
    app,
    /function resetTabState\(\) \{\s*resetPrivateState\(\);\s*if \(typeof recipeDraftsForget === 'function'\) recipeDraftsForget\(\);/,
  );
  // A deep link wins over the remembered workflow.
  const link = composer({storage: new Map(storage)});
  link.context.URLSearchParams = URLSearchParams;
  link.context.location = {search: '?recipe=snapchat_lead_generation'};
  await link.mount();
  assert.equal(link.node('#recipe-choice').value, 'snapchat_lead_generation');
});

test('the playbook rules are shown, on by default, and their opt-out reaches the server', async () => {
  const f = composer({conventions: {naming: 'ACME | {{campaign_name}}', utm: {utm_source: 'snap'}, variables: {}}});
  await f.mount();
  f.node('#recipe-profile').value = 'p1';
  f.node('#recipe-profile').events.get('change')();
  await settle();
  const fields = f.node('#recipe-fields').innerHTML;
  assert.match(fields, /name="apply_playbook_rules" value="true" checked/);
  assert.match(fields, /<code dir="ltr">ACME \| \{\{campaign_name\}\}<\/code>/);
  assert.match(fields, /<code dir="ltr">utm_source=snap<\/code>/);
  f.node('field:apply_playbook_rules').checked = true;
  await f.node('#recipe-inspect').events.get('click')();
  assert.equal(f.calls.at(-1).apply_playbook_rules, true);
  assert.match(f.node('#recipe-preview').innerHTML, /Your input.*Playbook result/);
  assert.match(
    f.node('#recipe-preview').innerHTML,
    /<bdi dir="auto">Spring<\/bdi><\/td><td><bdi dir="auto">ACME \| Spring<\/bdi>/,
  );
  f.node('field:apply_playbook_rules').checked = false;
  await f.node('#recipe-inspect').events.get('click')();
  assert.equal(f.calls.at(-1).apply_playbook_rules, false);
  // Without a playbook nothing is sent.
  f.node('#recipe-profile').value = '';
  f.node('#recipe-profile').events.get('change')();
  await settle();
  await f.node('#recipe-inspect').events.get('click')();
  assert.equal(f.calls.at(-1).apply_playbook_rules, undefined);
  // The off state survives a redraw.
  f.form.values = {playbook_rules_seen: '1'};
  f.node('#recipe-profile').value = 'p1';
  f.node('#recipe-profile').events.get('change')();
  await settle();
});

test('a Meta brief chooses one image source and an optional age range', async () => {
  const f = composer({connected: ['meta']});
  await f.mount();
  const fields = f.node('#recipe-fields').innerHTML;
  assert.match(fields, /<select name="image_source"><option value="drive_url" selected>/);
  assert.match(fields, /<option value="image_hash" >Image already in this ad account \(image hash\)<\/option>/);
  assert.match(fields, /name="age_min"  type="number" min="13" max="65"/);
  assert.match(fields, /Meta targets ages 18–65 unless you set a range from 13 to 65\./);
  f.form.values = {name: 'x', image_source: 'image_hash', image_value: ' a1b2c3d4e5f6 ', age_min: '25'};
  const business = f.run("readRecipeBusiness($('#recipe-form'))");
  assert.equal(business.image_hash, 'a1b2c3d4e5f6');
  assert.equal(business.image_source, undefined);
  assert.equal(business.drive_url, undefined);
  assert.equal(business.age_min, '25');
  f.form.values = {name: 'x', image_source: 'not_a_field', image_value: 'v'};
  assert.equal(f.run("readRecipeBusiness($('#recipe-form'))").not_a_field, undefined);
});

test('a brief is saved from the composer, reused from the list, and the plan names it and a matching live check', async () => {
  const f = composer();
  await f.mount();
  f.form.values = {name: 'Ramadan push', daily_budget: '9'};
  await f.node('#recipe-save-brief').events.get('click')();
  const save = f.calls.at(-1);
  assert.equal(save.action, 'save_brief');
  assert.deepEqual(save.brief, {
    name: 'Ramadan push',
    recipe: 'snapchat_website_traffic',
    business: {name: 'Ramadan push', daily_budget: '9'},
  });
  assert.match(f.toasts.at(-1), /Client brief saved/);
  // The list loads only when opened, and a listed brief fills the composer.
  assert.equal(f.calls.filter(c => c.action === 'briefs').length, 0);
  const use = {
    dataset: {recipeBrief: '0'},
    events: new Map(),
    addEventListener(type, fn) {
      this.events.set(type, fn);
    },
  };
  f.node('#recipe-brief-list').querySelectorAll = () => [use];
  f.node('#recipe-briefs').open = true;
  await f.node('#recipe-briefs').events.get('toggle')();
  assert.match(f.node('#recipe-brief-list').innerHTML, /Saved &lt;b&gt;/);
  await use.events.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.node('#recipe-choice').value, 'snapchat_website_traffic');
  assert.equal(f.node('#recipe-profile').value, 'p1');
  assert.match(f.node('#recipe-fields').innerHTML, /SA\nAE/);
  // A live check of these exact values travels with the plan; the brief is named too.
  f.form.values = {name: 'Ramadan push', daily_budget: '9'};
  await f.node('#recipe-eligibility').events.get('click')();
  assert.equal(f.calls.at(-1).live, true);
  await f.node('#recipe-form').events.get('submit')({preventDefault() {}});
  const create = f.calls.at(-1);
  assert.equal(create.action, 'create_from_recipe');
  assert.equal(create.brief_id, 'brief-9');
  assert.equal(create.eligibility_ref, 'elig-1');
  // After an edit the check no longer describes the brief, so it is not sent.
  f.form.values = {name: 'Ramadan push', daily_budget: '10'};
  await f.node('#recipe-form').events.get('submit')({preventDefault() {}});
  assert.equal(f.calls.at(-1).eligibility_ref, undefined);
});

test('an empty account list says whether the playbook bindings or missing connections are the cause', async () => {
  // Was: "Connect and select an account first." even when accounts were connected but the playbook left them out.
  const bound = composer({targets: [], excluded: 2});
  await bound.mount();
  bound.node('#recipe-profile').value = 'p1';
  bound.node('#recipe-profile').events.get('change')();
  await settle();
  const fields = bound.node('#recipe-fields').innerHTML;
  assert.match(fields, /This playbook’s bound accounts do not include an account for this workflow\./);
  assert.match(fields, /href="\/profiles\?profile_id=p1"/);
  assert.doesNotMatch(fields, /Connect and select an account first/);
  const none = composer({targets: []});
  await none.mount();
  assert.match(none.node('#recipe-fields').innerHTML, /Connect and select an account first\..*href="\/connections"/);
});
