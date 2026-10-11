// CMP-05 website: the Campaigns list is filtered with its state in the URL and continued with "Load more"; a plan
// can be archived, unarchived and shared with colleagues; a workspace that requires a different approver offers sharing
// instead of the approval form. The real page script runs against the real campaign runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';
import {ownerOperations} from '../dist/src/owner-operations.js';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));

function workspace() {
  const tenantId = 'team-ui-' + randomUUID(),
    store = new Store(':memory:', Buffer.alloc(32, 51).toString('base64')),
    alice = {tenantId, userId: 'alice', role: 'operator'},
    admin = {tenantId, userId: 'owner-admin', role: 'admin'};
  for (const user of ['alice', 'bob', 'carol'])
    store.db
      .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'operator',?)")
      .run(tenantId, user, Date.now());
  store.putConnection(
    admin,
    {
      id: 'snap',
      tenantId,
      gateway: 'snapchat_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const runner = new CampaignRunner(
    store,
    async () => ({success: false, error: {code: 'NOT_EXPECTED', message: 'No provider call is expected.'}}),
    async () => ({status: 'verified'}),
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
  );
  return {tenantId, store, alice, admin, call: input => runner.handle(input, alice)};
}
function page(locale, call, session) {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [];
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        innerHTML: '',
        elements: {},
        dataset: {},
        addEventListener() {},
        querySelector: node,
        querySelectorAll: () => [],
        append() {},
        remove() {},
      });
    return nodes.get(selector);
  };
  const context = createContext({
    catalog,
    Intl,
    Date,
    URLSearchParams,
    location: {search: ''},
    history: {replaceState() {}},
    document: {
      addEventListener() {},
      querySelector: node,
      querySelectorAll: () => [],
      createElement: () => node('new'),
    },
    $: node,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    date: String,
    toast() {},
    confirmAction: async () => true,
    session,
    navigationGeneration: 1,
    identityGeneration: 1,
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync('web/workspace.js', 'utf8'));
  run(readFileSync('web/campaign-workflows.js', 'utf8'));
  context.workspaceBind = (selector, fn) => bindings.set(selector, fn);
  context.workspaceCall = async (tool, args) => {
    assert.equal(tool, 'campaign');
    calls.push(JSON.parse(JSON.stringify(args)));
    return call(args);
  };
  return {context, node, bindings, calls};
}

test('the Campaigns list keeps its filters in the URL and shows each plan’s accounts, access and archive state', () => {
  for (const locale of ['en', 'ar']) {
    const p = page(locale, async () => ({}), {id: 'alice', workspaceRole: 'operator'});
    p.context.location.search = '?state=complete&q=acme&approval=1&archived=1&state2=x';
    const filters = p.context.campaignListFilters();
    assert.deepEqual(JSON.parse(JSON.stringify(filters)), {
      state: 'complete',
      search: 'acme',
      archived: true,
      awaiting_approval: true,
    });
    p.context.location.search = '?state=not-a-state';
    assert.deepEqual(JSON.parse(JSON.stringify(p.context.campaignListFilters())), {});
    const form = p.context.campaignFilterForm(filters, 3);
    assert.match(form, /<option value="complete" selected>/);
    assert.match(form, /name="approval" type="checkbox" checked/);
    assert.match(form, locale === 'ar' ? /جميع الحالات/ : /All states/);
    const row = p.context.campaignPlanRow({
      id: 'p1',
      name: '<b>Acme</b>',
      state: 'complete',
      step_count: 3,
      updated_at: 1,
      platforms: ['snapchat'],
      accounts: [{gateway: 'snapchat_native_action', account_id: '123'}],
      access: 'editor',
      archived: true,
    });
    assert.match(row, /&lt;b&gt;Acme&lt;\/b&gt;/);
    assert.match(row, /Snapchat/);
    assert.match(row, /123/);
    assert.match(row, locale === 'ar' ? /مشتركة معك للتحرير/ : /Shared with you to edit/);
    assert.match(row, locale === 'ar' ? /مؤرشفة/ : /Archived/);
    assert.match(row, /data-run="p1"/);
  }
});

test('a plan is archived, shared and unarchived from the website through the real runner', async () => {
  const w = workspace();
  try {
    const plan = await w.call({
      action: 'create',
      name: 'Launch',
      brief: 'Synthetic.',
      steps: campaignRecipe('snapchat_website_traffic', {...examples.snapchat_traffic_business, connection_id: 'snap'})
        .steps,
    });
    await w.call({action: 'cancel', id: plan.id, confirmed: true});
    let run = await w.call({action: 'get', id: plan.id, detail: 'full'});
    const p = page('en', w.call, {id: 'alice', workspaceRole: 'operator'});
    // The owner sees archive and share; a colleague who does not own it sees no share control.
    const actions = p.context.campaignTeamActions(run);
    assert.match(actions, /id="archive-campaign"/);
    assert.match(actions, /id="share-campaign"/);
    assert.doesNotMatch(
      page('en', w.call, {id: 'bob', workspaceRole: 'operator'}).context.campaignTeamActions(run),
      /share-campaign/,
    );
    assert.match(
      page('en', w.call, {id: 'bob', workspaceRole: 'admin'}).context.campaignTeamActions(run),
      /share-campaign/,
    );
    const opened = [];
    p.context.bindCampaignWorkflow(
      run,
      async id => opened.push(id),
      () => true,
    );
    // Share: the member list comes from assign; the form names one member and a role.
    await p.bindings.get('#share-campaign')();
    const team = p.node('#campaign-review').innerHTML;
    assert.match(team, /<option value="bob">bob<\/option>/);
    assert.match(team, /<option value="approver">Approver: can approve and run<\/option>/);
    await p.bindings.get('#assign-form')({elements: {user_id: {value: 'bob'}, role: {value: 'editor'}}});
    assert.deepEqual(p.calls.at(-2), {action: 'assign', id: plan.id, user_id: 'bob', role: 'editor'});
    assert.match(p.node('#campaign-review').innerHTML, /data-unassign="bob"/);
    await p.bindings.get('[data-unassign]')({dataset: {unassign: 'bob'}});
    assert.deepEqual(p.calls.at(-2), {action: 'unassign', id: plan.id, user_id: 'bob'});
    // Archive asks first, then archives with confirmation; unarchive restores it.
    await p.bindings.get('#archive-campaign')();
    assert.deepEqual(p.calls.at(-1), {action: 'archive', id: plan.id, confirmed: true});
    run = await w.call({action: 'get', id: plan.id, detail: 'full'});
    assert.equal(typeof run.archived.at, 'number');
    assert.match(p.context.campaignTeamActions(run), /id="unarchive-campaign"/);
    assert.match(p.context.campaignJournal(run), /This plan is archived/);
    await p.bindings.get('#unarchive-campaign')();
    assert.equal((await w.call({action: 'get', id: plan.id, detail: 'full'})).archived, undefined);
    assert.deepEqual(opened, [plan.id, plan.id]);
  } finally {
    w.store.close();
  }
});

test('Home lists the plans the bounded dashboard returns as needing attention, including the attention state', () => {
  // Before CMP-05 Home filtered every plan for older record states and never showed a plan in the attention state.
  const context = createContext({
    Intl,
    document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
    session: {name: 'Alice'},
    esc: value => String(value ?? ''),
    header: title => `<h1>${title}</h1>`,
    glyph: () => '',
    date: () => '',
    badge: value => value,
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/work-center.js', 'utf8')).runInContext(context);
  context.data = {
    campaigns: [
      {id: 'stuck', name: 'Stuck launch', state: 'attention', updated_at: 3},
      {id: 'waiting', name: 'Waiting launch', state: 'awaiting_review', updated_at: 2},
      {id: 'drafted', name: 'Draft launch', state: 'draft', updated_at: 1},
    ],
    writes_paused: null,
  };
  const html = new Script('workHome(data,[{}])').runInContext(context),
    attention = html.slice(html.indexOf('Needs attention'), html.indexOf('Continue recent work'));
  assert.match(attention, /campaigns\?id=stuck/);
  assert.match(attention, /campaigns\?id=waiting/);
  assert.doesNotMatch(attention, /campaigns\?id=drafted/);
});

test('with a distinct-approver policy, Review whole plan offers sharing instead of the approval form', async () => {
  for (const locale of ['en', 'ar']) {
    const w = workspace();
    try {
      ownerOperations(w.store, {action: 'save_plan_policy', require_distinct_approver: true, confirmed: true}, w.admin);
      const plan = await w.call({
        action: 'create',
        name: 'Launch',
        brief: 'Synthetic.',
        steps: campaignRecipe('snapchat_website_traffic', {
          ...examples.snapchat_traffic_business,
          connection_id: 'snap',
        }).steps,
      });
      const run = await w.call({action: 'get', id: plan.id, detail: 'full'}),
        p = page(locale, w.call, {id: 'alice', workspaceRole: 'operator'});
      p.context.bindCampaignWorkflow(
        run,
        async () => {},
        () => true,
      );
      await p.bindings.get('#approve-campaign')();
      const html = p.node('#campaign-review').innerHTML;
      assert.match(html, locale === 'ar' ? /تتطلب مساحة العمل هذه/ : /requires someone other than the plan’s owner/);
      assert.match(html, /id="share-for-approval"/);
      assert.doesNotMatch(html, /approve-plan/);
    } finally {
      w.store.close();
    }
  }
});
