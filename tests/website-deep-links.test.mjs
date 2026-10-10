// WEB-06 regressions: hand-offs dropped their context. "Build a campaign" from a client playbook, "Open workflow" from
// Capabilities and Portfolio's create, clone and capture links all landed on generic forms, so the person chose the
// workflow, playbook and account again. Deep links now preselect those values and never read a provider or save
// anything until the person acts; a value this person cannot use is named instead of being silently replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fakeNode(nodes, id) {
  if (!nodes.has(id)) {
    const attributes = new Map();
    nodes.set(id, {
      id,
      innerHTML: '',
      textContent: '',
      value: '',
      hidden: false,
      open: false,
      checked: false,
      disabled: false,
      required: false,
      readOnly: false,
      isConnected: true,
      events: new Map(),
      attributes,
      getAttribute: key => attributes.get(key) ?? null,
      setAttribute: (key, value) => attributes.set(key, String(value)),
      removeAttribute: key => attributes.delete(key),
      addEventListener(type, fn) {
        this.events.set(type, fn);
      },
      insertAdjacentHTML(where, html) {
        this.innerHTML = where === 'afterbegin' ? html + this.innerHTML : this.innerHTML + html;
      },
      after() {},
      append() {},
      focus() {},
      reportValidity: () => true,
      querySelector: selector => fakeNode(nodes, selector),
      querySelectorAll: () => [],
    });
  }
  return nodes.get(id);
}
const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function composer(search, {targets} = {}) {
  const nodes = new Map(),
    calls = [],
    node = id => fakeNode(nodes, id),
    form = node('#recipe-form');
  form.values = {};
  form.elements = new Proxy({}, {get: (_, key) => (key === 'page_id' ? undefined : node('field:' + String(key)))});
  const recipes = [
    {id: 'meta_traffic', name: 'Meta traffic', platform: 'meta'},
    {id: 'snapchat_traffic', name: 'Snapchat traffic', platform: 'snapchat'},
  ];
  const context = createContext({
    URLSearchParams,
    location: {pathname: '/campaigns', search, hash: '#campaign-create'},
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'operator'},
    platforms: [
      {gateway: 'meta_native_action', connections: []},
      {gateway: 'snapchat_native_action', connections: [{id: 'snap-login', enabled: true, accounts: ['ad-1']}]},
    ],
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
    toast() {},
    workspaceCall: async (tool, args) => {
      calls.push({tool, ...JSON.parse(JSON.stringify(args))});
      if (args.action === 'recipes') return {recipes};
      if (args.action === 'recipe_context')
        return {
          recipe: {id: args.recipe, platform: args.recipe.split('_')[0], required: ['name', 'currency']},
          targets: targets ?? [
            {connection_id: 'snap-login', account_id: 'ad-1', label: 'Snap A', currency: 'SAR', write_granted: true},
            {connection_id: 'snap-login', account_id: 'ad-2', label: 'Snap B', currency: 'USD', write_granted: true},
          ],
          defaults: {},
          limitations: [],
          pages: [],
          drive_connections: [],
          ...(args.profile_id ? {profile: {name: 'Client', revision: 2}} : {}),
        };
      throw Error('unexpected ' + args.action);
    },
  });
  new Script(readFileSync('web/campaign-recipes.js', 'utf8')).runInContext(context);
  context.profiles = [{id: 'profile-1', name: 'Client <A>', revision: 2}];
  return {
    context,
    node,
    calls,
    mount: () => new Script('mountRecipeBuilder(profiles, async () => {})').runInContext(context),
  };
}

test('a composer link preselects the workflow, playbook and account and reads only workspace data', async () => {
  const f = composer('?recipe=snapchat_traffic&profile_id=profile-1&connection_id=snap-login&account_id=ad-2');
  await f.mount();
  assert.equal(f.node('#recipe-choice').value, 'snapchat_traffic');
  assert.equal(f.node('#recipe-profile').value, 'profile-1');
  assert.equal(f.node('#campaign-create').open, true);
  const fields = f.node('#recipe-fields').innerHTML;
  assert.match(
    fields,
    /<option value="\{&quot;connection_id&quot;:&quot;snap-login&quot;,&quot;account_id&quot;:&quot;ad-2&quot;\}" selected>/,
  );
  assert.match(fields, /name="currency" value="USD"/, 'the linked account’s currency is filled in');
  assert.deepEqual(
    f.calls.map(c => c.action),
    ['recipes', 'recipe_context'],
    'no preview, eligibility check, provider read or plan save until the person acts',
  );
  assert.equal(f.calls[1].profile_id, 'profile-1');
});

test('unknown or unusable composer link values are named, not silently replaced', async () => {
  const f = composer('?recipe=retired_recipe&profile_id=other-workspace&connection_id=snap-login&account_id=gone');
  await f.mount();
  const html = f.node('section').innerHTML;
  assert.match(html, /The linked workflow is not available\. Choose a workflow\./);
  assert.match(html, /The linked client playbook is not available in this workspace\. Choose a playbook\./);
  assert.equal(f.node('#recipe-choice').value, 'snapchat_traffic', 'the first workflow with an account');
  assert.equal(f.node('#recipe-profile').value, '');
  const fields = f.node('#recipe-fields').innerHTML;
  assert.match(fields, /The linked account is not available to you for this workflow/);
  assert.match(fields, /<option value="" selected>Previously selected account — check access<\/option>/);
  assert.doesNotMatch(fields, /&quot;ad-1&quot;\}" selected/);
});

test('without a link the composer starts on the first workflow with a connected account', async () => {
  const f = composer('');
  await f.mount();
  assert.equal(f.node('#recipe-choice').value, 'snapchat_traffic', 'Meta has no connected account here');
  assert.equal(f.node('#campaign-create').open, false);
  assert.doesNotMatch(f.node('section').innerHTML, /class="notice"/);
});

function clone(search, writeAccounts = ['100']) {
  const nodes = new Map(),
    node = id => fakeNode(nodes, id),
    calls = [];
  const context = createContext({
    URLSearchParams,
    location: {pathname: '/campaigns', search, hash: '#campaign-clone'},
    platforms: [
      {
        id: 'google',
        gateway: 'google_ads_native_action',
        connections: [{id: 'g-login', enabled: true, accounts: ['100', '200'], writeAccounts}],
      },
    ],
    $: node,
    esc,
    uiText: String,
    accountLabel: (_p, c, id) => c.id + ' ' + id,
    controls: (label, type, value, name) => `<input name="${name}" value="${esc(value)}">`,
    workspaceBind() {},
    workspaceCall: async (_tool, args) => calls.push(args),
  });
  const source = readFileSync('web/campaign-workflows.js', 'utf8');
  new Script(source.slice(source.indexOf('function mountCampaignClone('))).runInContext(context);
  new Script('mountCampaignClone(async () => {})').runInContext(context);
  return {node, calls};
}

test('Portfolio’s Clone into a draft preselects the account and source and reads nothing', () => {
  const f = clone('?clone=1&connection_id=g-login&account_id=100&source_id=987%3Cx%3E');
  const html = f.node('#campaign-clone').innerHTML;
  assert.match(html, /<option value="0" selected>g-login 100<\/option>/);
  assert.match(html, /name="source" value="987&lt;x&gt;"/);
  assert.equal(f.node('#campaign-clone').open, true);
  assert.equal(f.node('#campaign-create').open, true);
  assert.deepEqual(f.calls, []);
  const missing = clone('?clone=1&connection_id=g-login&account_id=100&source_id=1', []);
  assert.match(missing.node('#campaign-clone').innerHTML, /The linked account is not available for cloning/);
  assert.match(missing.node('#campaign-clone').innerHTML, /<option value="" selected>Previously selected account/);
  const plain = clone('');
  assert.doesNotMatch(plain.node('#campaign-clone').innerHTML, / selected>/);
  assert.equal(plain.node('#campaign-clone').open, false);
});

function capture(search) {
  const nodes = new Map(),
    node = id => fakeNode(nodes, id),
    calls = [];
  const form = node('#capture-preset');
  form.querySelector = () => node('#capture-submit');
  form.elements = new Proxy({}, {get: (_, key) => node('field:' + String(key))});
  // A select starts on its first option, as in a browser.
  form.elements.preset.value = 'google_campaign';
  const context = createContext({
    URLSearchParams,
    location: {pathname: '/reports', search, hash: '#report-capture'},
    document: {addEventListener() {}},
    Intl,
    Date,
    navigationGeneration: 1,
    identityGeneration: 1,
    $: node,
    platforms: [
      {id: 'google', connections: [{id: 'g-login', enabled: true, accounts: ['123']}]},
      {id: 'snapchat', connections: [{id: 's-login', enabled: true, accounts: ['ad-9']}]},
    ],
    accountLabel: (_p, c, id) => c.id + ' ' + id,
    controls: () => '',
    workspaceBind() {},
    workspaceCall: async (_tool, input) => {
      calls.push(input.action);
      return {
        presets: [
          {id: 'google_campaign', name: 'Google campaigns', gateway: 'google_ads_native_action'},
          {id: 'snapchat_campaign', name: 'Snapchat campaigns', gateway: 'snapchat_native_action'},
          {id: 'snapchat_adsquad', name: 'Snapchat ad squads', gateway: 'snapchat_native_action'},
        ],
      };
    },
    esc,
    toast() {},
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run('uiLocale="en";uiMessages=new Map();');
  const app = readFileSync('web/app.js', 'utf8');
  run(app.slice(app.indexOf('function requestError('), app.indexOf("const content = $('#content')")));
  const source = readFileSync('web/evidence-workflows.js', 'utf8');
  run(source.slice(source.indexOf('function evidencePresetLabel('), source.indexOf('\nfunction mountScenarioModel(')));
  return {node, form, calls, mount: () => run('mountCaptureWizard(async () => {})')};
}

test('Capture evidence for this campaign preselects the account and Snapchat parent campaign, reading nothing', async () => {
  const f = capture('?connection_id=s-login&account_id=ad-9&campaign_id=camp-1');
  await f.mount();
  assert.equal(f.form.elements.preset.value, 'snapchat_adsquad');
  assert.equal(f.form.elements.target.value, '1');
  assert.equal(f.form.elements.campaign_id.value, 'camp-1');
  assert.equal(f.node('#report-capture').open, true);
  assert.deepEqual(f.calls, ['capture_presets'], 'only the local preset list');
  const google = capture('?connection_id=g-login&account_id=123&campaign_id=1');
  await google.mount();
  assert.equal(google.form.elements.preset.value, 'google_campaign');
  assert.equal(google.form.elements.target.value, '0');
  const missing = capture('?connection_id=g-login&account_id=999');
  await missing.mount();
  assert.match(missing.form.elements.target.innerHTML, /^<option value="" selected>Previously selected account/);
  assert.equal(missing.node('#report-capture').open, false);
});

test('MCP and Capabilities hand-offs name the workflow, playbook and account they checked', async () => {
  const {workflowOutcome} = await import('../dist/src/workflow-outcomes.js');
  const out = workflowOutcome(
    'amcp_campaign',
    {
      record_kind: 'recipe_eligibility',
      recipe_id: 'google_search_clicks',
      provenance: {profile: {id: 'profile 1'}},
      scope: {connection_id: 'login-1', account_id: '123-456'},
    },
    'recipe_eligibility',
  );
  assert.equal(
    out.website_path,
    '/campaigns?recipe=google_search_clicks&profile_id=profile%201&connection_id=login-1&account_id=123-456#campaign-create',
  );
  const bare = workflowOutcome('amcp_campaign', {record_kind: 'recipe_eligibility'}, 'recipe_eligibility');
  assert.equal(bare.website_path, '/campaigns#campaign-create');
  const {capabilityGraph} = await import('../dist/src/capability-graph.js'),
    {Store} = await import('../dist/src/store.js'),
    {Registry} = await import('../dist/src/catalog.js'),
    store = new Store(':memory:', Buffer.alloc(32, 7).toString('base64'));
  try {
    const graph = capabilityGraph(store, new Registry(), {tenantId: 'deep-links', userId: 'u', role: 'reader'}, true);
    assert.equal(
      graph.workflows.find(w => w.id === 'recipe:meta_website_traffic').website_path,
      '/campaigns?recipe=meta_website_traffic#campaign-create',
    );
  } finally {
    store.close();
  }
});
