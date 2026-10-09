import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';
import {actor, campaignStep, createPlan, fixture, squadStep} from './snapchat-plan-fixture.js';

/**
 * CMP-02 (a) regression: the website showed "Correct blocked step" only when a step failed or `run.preflight.blocked`
 * was set. It loads the plan with get detail "full", whose stored preflight keeps only `status`; `blocked` exists on
 * the preflight response alone. A plan blocked at preflight (a foreign pixel, a currency mismatch, a missing Meta
 * field) showed the raw state "draft" with the recover_step call buried in JSON. The real server responses below drive
 * the real page script; the form's correction goes back through recover_step.
 */
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
type Call = (tool: string, input: JsonObject) => Promise<JsonObject>;
function page(call: Call, locale: 'en' | 'ar') {
  const nodes = new Map<string, JsonObject>(),
    bindings = new Map<string, (el?: unknown) => Promise<void>>();
  const node = (id: string) => {
    if (!nodes.has(id)) {
      const element: JsonObject = {id, innerHTML: '', checked: false, dataset: {}, addEventListener() {}};
      // Form controls on first use: a select starts at its first option.
      element.elements = new Proxy({} as JsonObject, {
        get: (controls, name: string) =>
          (controls[name] ??= {value: name === 'field' ? '0' : '', checked: false, addEventListener() {}}),
      });
      nodes.set(id, element);
    }
    return nodes.get(id)!;
  };
  const context = createContext({
    document: {addEventListener() {}},
    $: node,
    esc: (v: unknown) =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    badge: (v: unknown) => '<span>' + String(v) + '</span>',
    date: String,
    blank: String,
    recordDetails: () => '',
    workspaceBind: (selector: string, fn: (el?: unknown) => Promise<void>) => bindings.set(selector, fn),
    workspaceCall: async (tool: string, input: JsonObject) => {
      const r = await call('amcp_' + tool, input);
      if (!r.success) throw Error(r.error.message);
      return r.data;
    },
    fixtureCatalog: locale === 'ar' ? catalog : {},
    fixtureLocale: locale,
  });
  const run = (source: string) => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run('uiLocale = fixtureLocale; uiMessages = new Map(Object.entries(fixtureCatalog));');
  run(readFileSync('web/campaign-workflows.js', 'utf8'));
  return {context, node, bindings, run};
}

test('a plan blocked at preflight offers the correction on the website, and its form amends the named field', async () => {
  for (const locale of ['en', 'ar'] as const) {
    const f = fixture({pixels: ['pixel-own', 'pixel-own-2']});
    try {
      const id = (await createPlan(f, [campaignStep(), squadStep(1, {}, {pixel_id: 'pixel-foreign'})])).data.id;
      const p = page(f.call, locale);
      // A plan approval saved earlier for this exact plan: amending a step must void it.
      const {id: _id, revision: _revision, ...saved} = f.store.document(actor.tenantId, 'campaign_run', id);
      f.store.putDocument(actor.tenantId, 'campaign_run', id, {
        ...saved,
        approval: {plan_hash: saved.plan_hash, by: actor.userId, at: Date.now(), spend_change_confirmed: true},
      });
      // What the website's "Check prerequisites" receives, then what it loads to render the plan.
      const preflight = (await f.call('amcp_campaign', {action: 'preflight', id, detail: 'full'})).data;
      assert.equal(preflight.blocked, true);
      const stored = (await f.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data;
      assert.equal(stored.preflight.status, 'blocked');
      assert.equal(stored.preflight.blocked, undefined, 'the field the old check read is not stored');
      Object.assign(p.context, {stored, preflight});
      assert.equal(p.run('campaignNeedsAmendment(stored)'), true);
      assert.equal(
        p.run("campaignNeedsAmendment({steps: [{status: 'pending'}], preflight: {status: 'ready'}})"),
        false,
      );
      assert.equal(p.run("campaignNeedsAmendment({steps: [{status: 'failed'}]})"), true);
      assert.equal(stored.approval.plan_hash, stored.plan_hash);
      let reopened = 0;
      p.context.open = async () => ++reopened > 0;
      p.run('bindCampaignWorkflow(stored, open, () => true, preflight)');
      const html = String(p.node('#campaign-review').innerHTML);
      assert.match(
        html,
        locale === 'ar' ? /المتطلبات المسبقة التي توقف هذه الخطة/ : /Prerequisites that block this plan/,
      );
      assert.match(html, /<code dir="ltr">squad_1<\/code>/);
      // The remedy names the call that amends the step, with its native name kept in both languages.
      assert.match(html, /recover_step/);
      assert.match(html, /id="amend-step"/);
      assert.match(html, /\/payload\/adsquads\/0\/pixel_id/);
      assert.doesNotMatch(html, /id="amend-arguments"/, 'a named choice is a patch, not free-form arguments');
      const choice = String(p.node('#amend-value').innerHTML);
      assert.match(choice, /pixel-foreign/);
      assert.match(choice, /<option value="pixel-own-2">/);
      const form = p.node('#amend-step');
      form.elements.value.value = 'pixel-own-2';
      form.elements.confirmed.checked = true;
      await p.bindings.get('#amend-step')!();
      assert.equal(reopened, 1);
      const amended = (await f.call('amcp_campaign', {action: 'get', id, step_id: 'squad_1'})).data;
      assert.equal(amended.step.status, 'pending');
      assert.deepEqual(amended.step.previous_attempts[0].patch, [
        {path: '/payload/adsquads/0/pixel_id', from: 'pixel-foreign', to: 'pixel-own-2'},
      ]);
      assert.notEqual(amended.plan_hash, stored.plan_hash);
      const full = (await f.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data;
      assert.equal(full.preflight, undefined);
      assert.equal((await f.call('amcp_campaign', {action: 'run', id})).error.code, 'APPROVAL_REQUIRED');
      // Preflight runs again and now passes.
      assert.equal((await f.call('amcp_campaign', {action: 'preflight', id})).data.preflight.status, 'ready');
      assert.equal(f.writes.length, 0);
    } finally {
      f.close();
    }
  }
});

test('a preflight response without a step to correct shows its outcome, not an empty form', async () => {
  const f = fixture();
  try {
    const id = (await createPlan(f, [campaignStep()])).data.id;
    const p = page(f.call, 'en');
    const ready = (await f.call('amcp_campaign', {action: 'preflight', id, detail: 'full'})).data;
    assert.equal(ready.blocked, false);
    Object.assign(p.context, {ready});
    p.run('bindCampaignWorkflow(ready, async () => true, () => true, ready)');
    const html = String(p.node('#campaign-review').innerHTML);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /amend-step|amend-arguments/);
    assert.equal(p.run('campaignNeedsAmendment(ready)'), false);
  } finally {
    f.close();
  }
});

/**
 * CMP-01 migration on the website: a Meta draft saved before the v24+ rule has no is_adset_budget_sharing_enabled.
 * Preflight blocks it, and a patch cannot add a field the step does not have, so the form also offers the step's
 * corrected native arguments (recover_step with arguments). Nothing reaches Meta.
 */
test('a saved Meta draft without the budget-sharing choice is corrected through the arguments form', async () => {
  const meta: Actor = {tenantId: 'meta-amend', userId: 'operator', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64')),
    connection = 'aaaaaaaa-2222-4222-8222-222222222222';
  store.putConnection(
    {...meta, role: 'admin'},
    {
      id: connection,
      tenantId: meta.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const requests: string[] = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport((async (url: string, init?: RequestInit) => {
      requests.push((init?.method ?? 'GET') + ' ' + new URL(String(url)).pathname);
      if (init?.method && init.method !== 'GET') throw Error('No provider write in this test');
      return Response.json({id: 'act_123', currency: 'USD', account_status: 1});
    }) as typeof fetch),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call: Call = (tool, input) => service.call(tool, input, meta) as Promise<JsonObject>;
  try {
    const payload = {name: 'Saved draft', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: []};
    const created = await call('amcp_campaign', {
      action: 'create',
      name: 'Saved Meta draft',
      brief: 'Paused traffic campaign saved before the v24 rule.',
      steps: [
        {
          id: 'campaign',
          kind: 'write',
          gateway: 'meta_native_action',
          connection_id: connection,
          account_id: '123',
          arguments: {action: 'meta_campaign_create', payload},
        },
      ],
    });
    assert.equal(created.success, true, JSON.stringify(created));
    const id = created.data.id;
    const preflight = (await call('amcp_campaign', {action: 'preflight', id, detail: 'full'})).data;
    assert.equal(preflight.blocked, true);
    assert.equal(preflight.missing_requirements[0].error.code, 'INVALID_META_CAMPAIGN');
    assert.deepEqual(preflight.next_call.add_after_correction.arguments.payload, payload);
    const stored = (await call('amcp_campaign', {action: 'get', id, detail: 'full'})).data;
    for (const locale of ['en', 'ar'] as const) {
      const p = page(call, locale);
      Object.assign(p.context, {stored, preflight});
      p.run('bindCampaignWorkflow(stored, async () => true, () => true, preflight)');
      const html = String(p.node('#campaign-review').innerHTML);
      assert.match(html, /is_adset_budget_sharing_enabled/);
      assert.match(html, locale === 'ar' ? /الوسائط الأصلية المصحّحة/ : /Corrected native arguments/);
      assert.match(html, /id="amend-arguments"/);
      assert.match(html, /&quot;special_ad_categories&quot;/, 'the textarea starts from the saved arguments');
    }
    const p = page(call, 'en');
    Object.assign(p.context, {stored, preflight});
    p.run('bindCampaignWorkflow(stored, async () => true, () => true, preflight)');
    const form = p.node('#amend-arguments');
    form.elements.confirmed.checked = true;
    form.elements.arguments.value = '[1]';
    await assert.rejects(p.bindings.get('#amend-arguments')!(form), /one JSON object/);
    form.elements.arguments.value = JSON.stringify({
      action: 'meta_campaign_create',
      payload: {...payload, is_adset_budget_sharing_enabled: false},
    });
    await p.bindings.get('#amend-arguments')!(form);
    const amended = (await call('amcp_campaign', {action: 'get', id, step_id: 'campaign'})).data.step;
    assert.equal(amended.arguments.payload.is_adset_budget_sharing_enabled, false);
    assert.equal(amended.previous_attempts[0].preflight_error.code, 'INVALID_META_CAMPAIGN');
    assert.equal((await call('amcp_campaign', {action: 'preflight', id})).data.preflight.status, 'ready');
    assert.ok(
      requests.every(r => r.startsWith('GET ')),
      requests.join(),
    );
  } finally {
    store.close();
  }
});
