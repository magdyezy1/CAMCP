import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeDependencies} from '../dist/src/capability-eligibility.js';
import {leadFixture, leadBusiness, nativeAd, actor} from './fixtures/snapchat-leads-data.mjs';
import {snapAdLeadFormFollowUps, snapAdCreativePrerequisites} from '../dist/src/snapchat-ad-creatives.js';
const recipe = 'snapchat_lead_generation';
test('native lead creative replacements require their exact owned form and deduplicate its read path', () => {
  const creative = {id: leadBusiness.creative_id, type: 'LEAD_GENERATION', lead_generation_form_id: 'original-form'},
    creativeState = {creatives: [{creative}]},
    formState = {
      lead_generation_forms: [
        {lead_generation_form: {id: 'original-form', ad_account_id: 'acct1', form_fields: [{type: 'EMAIL'}]}},
      ],
    },
    read = {method: 'GET', path: '/v1/creatives/' + creative.id, query: {}, readOnly: true};
  for (const method of ['PUT', 'PATCH']) {
    const plan = {
        gateway: 'snapchat_native_action',
        accountId: 'acct1',
        method,
        path: method === 'PUT' ? '/v1/adaccounts/acct1/ads' : '/v1/adaccounts/acct1/ads/ad1',
        body:
          method === 'PUT'
            ? {ads: [{id: 'ad1', type: 'LEAD_GENERATION', creative_id: creative.id}]}
            : [{op: 'replace', path: '/creative_id', value: creative.id}],
      },
      states = [{ads: [{ad: {id: 'ad1', type: 'LEAD_GENERATION'}}]}, creativeState];
    assert.deepEqual(
      snapAdLeadFormFollowUps(plan, read, creativeState).map(r => r.path),
      ['/v1/lead_generation_forms/original-form'],
    );
    assert.deepEqual(snapAdLeadFormFollowUps(plan, {...read, path: '/v1/creatives/other'}, creativeState), []);
    assert.throws(
      () => snapAdCreativePrerequisites(plan, states),
      e => e.code === 'CAMPAIGN_PREREQUISITE_REQUIRED',
    );
    assert.doesNotThrow(() => snapAdCreativePrerequisites(plan, [...states, formState]));
  }
});
for (const goal of [undefined, '', 'LEADS', 'PIXEL_SIGNUP', 0, true]) {
  test('lead recipe requires an explicit supported goal: ' + String(goal), () => {
    assert.throws(
      () => campaignRecipe(recipe, {...leadBusiness, optimization_goal: goal}),
      error => ['RECIPE_INPUT_REQUIRED', 'RECIPE_INPUT_INVALID'].includes(error.code),
    );
  });
}
test('lead recipe exposes its distinct owned creative and form prerequisites', () => {
  assert.ok(campaignRecipes.some(r => r.id === recipe));
  assert.ok(recipeDependencies[recipe].objects.includes('existing_lead_form'));
});
for (const goal of ['SWIPES', 'LEAD_FORM_SUBMISSIONS'])
  test('lead recipe compiles exact paused native hierarchy for ' + goal, () => {
    const out = campaignRecipe(recipe, {...leadBusiness, optimization_goal: goal});
    const [c, s, a] = out.steps.map(step => Object.values(step.arguments.payload)[0][0]);
    assert.equal(c.objective_v2_properties.objective_v2_type, 'LEADS');
    assert.equal(s.child_ad_type, 'LEAD_GENERATION');
    assert.equal(s.optimization_goal, goal);
    assert.equal(a.type, 'LEAD_GENERATION');
    assert.equal(a.creative_id, leadBusiness.creative_id);
    assert.deepEqual([c.status, s.status, a.status], ['PAUSED', 'PAUSED', 'PAUSED']);
    assert.equal(s.daily_budget_micro, '20000001');
    assert.equal(s.bid_strategy, 'AUTO_BID');
    assert.equal(Object.hasOwn(a, 'lead_generation_form_id'), false, 'The original creative owns its form reference');
  });
for (const scenario of ['valid', 'wrong_creative_type', 'missing_form', 'global_foreign_form', 'partial_forms'])
  test('lead preflight checks exact dependency evidence: ' + scenario, async t => {
    const f = leadFixture({
      missingForm: scenario === 'missing_form',
      partialForms: scenario === 'partial_forms',
      listFormOwner: scenario === 'global_foreign_form' ? 'acct1' : undefined,
    });
    t.after(() => f.close());
    if (scenario === 'wrong_creative_type') f.creative.type = 'WEB_VIEW';
    if (scenario === 'global_foreign_form') f.form.ad_account_id = 'foreign';
    const out = await f.campaign({action: 'recipe_eligibility', recipe, business: leadBusiness, live: true});
    if (scenario === 'valid') {
      assert.equal(out.success, true, JSON.stringify(out));
      for (const id of ['existing_lead_creative', 'existing_lead_form'])
        assert.equal(out.data.dependencies.find(x => x.id === id)?.status, 'ready');
      assert.equal(out.data.dependencies.find(x => x.id === 'provider_objective_acceptance').status, 'unknown');
    } else {
      assert.equal(out.success, true, JSON.stringify(out.error));
      assert.equal(out.data.status, 'blocked');
      if (scenario === 'partial_forms')
        assert.ok(f.requests.length <= 29, 'Collections stay bounded before any writes');
    }
    assert.equal(f.writes.length + f.adWrites.length, 0);
  });
test('a native lead ad cannot prepare with a website creative', async t => {
  const f = leadFixture();
  t.after(() => f.close());
  await f.inspect();
  f.creative.type = 'WEB_VIEW';
  const out = await f.write({action: 'prepare', ...nativeAd});
  assert.equal(out.success, false, JSON.stringify(out));
  assert.equal(out.error.code, 'CAMPAIGN_PREREQUISITE_REQUIRED');
  assert.equal(f.adWrites.length, 0);
});
test('lead form configuration belongs to the frozen review and cannot change before dispatch', async t => {
  const f = leadFixture();
  t.after(() => f.close());
  await f.inspect();
  const prepared = await f.write({action: 'prepare', ...nativeAd});
  assert.equal(prepared.success, true, JSON.stringify(prepared));
  assert.ok(
    prepared.data.state_reads.some(read => read.path === '/v1/lead_generation_forms/form1'),
    'Read the attached form during native review',
  );
  f.form.title = 'A changed collection purpose';
  const executed = await f.write({
    action: 'execute',
    review_id: prepared.data.review_id,
    idempotency_key: prepared.data.review_id,
    confirmed: true,
    spend_change_confirmed: true,
  });
  assert.equal(executed.success, false, JSON.stringify(executed));
  assert.equal(executed.error.code, 'STATE_CHANGED');
  assert.equal(f.adWrites.length, 0);
});

for (const field of ['privacy_policy_url', 'legal_disclosures', 'form_fields'])
  test('native lead review freezes ' + field + ' without reading submitted leads', async t => {
    const f = leadFixture();
    t.after(() => f.close());
    await f.inspect();
    const prepared = await f.write({action: 'prepare', ...nativeAd});
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    f.form[field] =
      field === 'form_fields'
        ? [{type: 'PHONE_NUMBER'}]
        : field === 'legal_disclosures'
          ? {description: 'Changed collection terms'}
          : 'https://example.test/different-policy';
    const executed = await f.write({
      action: 'execute',
      review_id: prepared.data.review_id,
      idempotency_key: prepared.data.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(executed.success, false, JSON.stringify(executed));
    assert.equal(executed.error.code, 'STATE_CHANGED');
    assert.equal(f.adWrites.length, 0);
    assert.ok(f.requests.every(r => !r.includes('/leads') && !r.includes('webhook')));
  });

for (const scenario of [
  'missing_owner',
  'missing_fields',
  'missing_reference',
  'unsafe_reference',
  'revoked',
  'valid_optional_policy',
])
  test('lead prerequisites retain account and definition controls: ' + scenario, async t => {
    const f = leadFixture({
      beforeFormRead:
        scenario === 'revoked'
          ? f => {
              const c = f.store.resolveConnection(actor, 'snapchat_native_action', 'acct1', leadBusiness.connection_id);
              f.store.putConnection({...actor, role: 'admin'}, {...c, enabled: false}, {accessToken: 'synthetic'});
            }
          : undefined,
    });
    t.after(() => f.close());
    if (scenario === 'missing_owner') delete f.form.ad_account_id;
    if (scenario === 'missing_fields') delete f.form.form_fields;
    if (scenario === 'missing_reference') delete f.creative.lead_generation_form_id;
    if (scenario === 'unsafe_reference') f.creative.lead_generation_form_id = '../foreign';
    if (scenario === 'valid_optional_policy') {
      delete f.form.privacy_policy_url;
      delete f.form.legal_disclosures;
    }
    const out = await f.campaign({action: 'recipe_eligibility', recipe, business: leadBusiness, live: true});
    if (scenario === 'valid_optional_policy') {
      assert.equal(out.success, true, JSON.stringify(out));
      assert.notEqual(out.data.status, 'blocked');
      assert.equal(out.data.dependencies.find(x => x.id === 'lead_form_policy_acceptance').status, 'unknown');
    } else assert.ok(!out.success || out.data.status === 'blocked', JSON.stringify(out));
    assert.equal(f.writes.length + f.adWrites.length, 0);
    if (['missing_owner', 'missing_reference', 'unsafe_reference'].includes(scenario))
      assert.ok(!f.requests.some(r => r.startsWith('GET /v1/lead_generation_forms/')));
  });

async function launch(f) {
  const created = await f.campaign({action: 'create_from_recipe', recipe, business: leadBusiness});
  assert.equal(created.success, true, JSON.stringify(created));
  const id = created.data.id,
    preview = await f.campaign({action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview));
  const approved = await f.campaign({
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved));
  let result = await f.campaign({action: 'run', id});
  // The plan was approved without the flag, so run stops for it once (r25-field-plan): the stop's next call approves the same plan and
  // summary again with the flag, which the operator gives here, and run then covers every step the approval showed. Never a stop a step.
  let passes = 0;
  for (let n = 0; n < 4 && result.success && result.data.run?.stopped === 'needs_spend_change_confirmed'; n++) {
    passes++;
    assert.equal(result.data.next_call.arguments.action, 'approve', 'the stop offers the plan approval again');
    const executed = await f.campaign({
      ...result.data.next_call.arguments,
      confirmed: true,
      spend_change_confirmed: true,
    });
    if (!executed.success) {
      result = executed;
      break;
    }
    result = await f.campaign({action: 'run', id});
  }
  assert.ok(passes <= 1, 'one re-approval covers the plan: ' + passes + ' passes');
  return {id, result};
}
for (const lost of [false, true])
  test(
    'paused lead launch verifies each predecessor and never replays ' + (lost ? 'an ambiguous ad' : 'a complete plan'),
    async t => {
      const f = leadFixture({lostAdReceipt: lost});
      t.after(() => f.close());
      const original = structuredClone({creative: f.creative, form: f.form});
      const {id, result} = await launch(f);
      assert.equal(result.success, true, JSON.stringify(result));
      const full = await f.campaign({action: 'get', id, detail: 'full'});
      assert.equal(full.success, true, JSON.stringify(full));
      assert.equal(full.data.steps[2].status, lost ? 'uncertain' : 'verified', JSON.stringify(full));
      assert.equal(f.writes.length, 2);
      assert.equal(f.adWrites.length, 1);
      assert.equal(f.ads[0].type, 'LEAD_GENERATION');
      assert.equal(f.ads[0].status, 'PAUSED');
      assert.deepEqual({creative: f.creative, form: f.form}, original);
      await f.campaign({action: 'run', id, confirmed: true, spend_change_confirmed: true});
      assert.equal(f.adWrites.length, 1);
      assert.ok(f.requests.every(r => !r.includes('/leads') && !r.includes('webhook')));
    },
  );
