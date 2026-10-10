// CMP-06 regressions and capabilities: a client playbook's naming and UTM rules were resolved only for its preview,
// so recipe plans kept the name as typed and untagged landing pages; recipe defaults had to be copied per recipe;
// briefs were not saved; Meta packs accepted only a Drive link and a hidden 18–65 age range; and a live eligibility
// check was thrown away, so the saved plan read the provider again before approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';
import {randomUUID} from 'node:crypto';
import {sha256} from '../dist/src/security.js';
import {WEBSITE_UPLOAD_TTL_MS} from '../dist/src/media-retention.js';

const base = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8')).recipe_business;
const actor = {tenantId: 'playbook-conventions', userId: 'operator', role: 'operator'},
  owner = {...actor, userId: 'owner', role: 'admin'};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64')),
    requests = [];
  store.putConnection(
    owner,
    {
      id: 'synthetic-login',
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      requests.push(String(url) + ' ' + (init.body ?? ''));
      return Response.json({results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (tool, input, who = actor) => service.call(tool, input, who);
  return {
    store,
    service,
    requests,
    campaign: (input, who) => call('amcp_campaign', input, who),
    workspace: (input, who) => call('amcp_workspace', input, who),
    profile: (data, id = 'client') => store.putDocument(actor.tenantId, 'client_profile', id, {name: 'ACME', ...data}),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
const refused = (r, code) => {
  assert.equal(r.success, false, JSON.stringify(r));
  assert.equal(r.error.code, code, JSON.stringify(r.error));
  return r.error;
};
const rules = {
  naming: 'ACME | {{campaign_name}} | Search',
  utm: {utm_source: 'google', utm_medium: 'cpc', utm_campaign: '{{campaign_name}}', utm_content: ''},
};
const planText = out => JSON.stringify(out.plan ?? out);

test('a selected playbook names the plan and tags its landing page, with provenance (was: name as typed, no UTM)', async () => {
  const f = fixture();
  try {
    f.profile(rules);
    const out = ok(
      await f.campaign({action: 'preview_recipe', recipe: 'google_search', profile_id: 'client', business: base}),
    );
    assert.equal(out.plan.name, 'ACME | Synthetic website demand | Search');
    const tagged = 'https://example.test/?utm_source=google&utm_medium=cpc&utm_campaign=Synthetic%20website%20demand';
    assert.ok(planText(out).includes(tagged), 'every landing page in the plan carries the playbook UTMs');
    assert.ok(!planText(out).includes('"https://example.test/"'), 'no untagged landing page remains');
    const conventions = out.provenance.conventions;
    assert.equal(conventions.applied, true);
    assert.deepEqual(conventions.name, {
      input: 'Synthetic website demand',
      result: 'ACME | Synthetic website demand | Search',
      template: rules.naming,
    });
    assert.equal(conventions.destination_url.input, 'https://example.test/');
    assert.equal(conventions.destination_url.result, tagged);
    assert.equal(out.provenance.fields.name.source, 'approved_profile_convention');
    assert.equal(out.provenance.fields.destination_url.source, 'approved_profile_convention');
    assert.equal(out.provenance.fields.daily_budget.source, 'user');
    assert.equal(f.requests.length, 0, 'compilation reads nothing');
    // The saved plan records the same derivation.
    const saved = ok(
      await f.campaign({action: 'create_from_recipe', recipe: 'google_search', profile_id: 'client', business: base}),
    );
    assert.equal(saved.name, 'ACME | Synthetic website demand | Search');
    assert.equal(saved.recipe.provenance.conventions.destination_url.result, tagged);
  } finally {
    f.store.close();
  }
});

test('opting out returns the raw input and records the choice; no playbook means no rules', async () => {
  const f = fixture();
  try {
    f.profile(rules);
    const out = ok(
      await f.campaign({
        action: 'preview_recipe',
        recipe: 'google_search',
        profile_id: 'client',
        business: base,
        apply_playbook_rules: false,
      }),
    );
    assert.equal(out.plan.name, 'Synthetic website demand');
    assert.ok(!planText(out).includes('utm_'));
    assert.deepEqual(out.provenance.conventions, {
      version: 1,
      applied: false,
      source: 'user_override',
      profile: out.provenance.profile,
    });
    const plain = ok(await f.campaign({action: 'preview_recipe', recipe: 'google_search', business: base}));
    assert.equal(plain.plan.name, 'Synthetic website demand');
    assert.equal(plain.provenance.conventions, undefined);
    refused(await f.campaign({action: 'list', apply_playbook_rules: false}), 'INVALID_ARGUMENT');
  } finally {
    f.store.close();
  }
});

test('a conflicting UTM value in the landing page is refused; an equal one is kept once; other query text is untouched', async () => {
  const f = fixture();
  try {
    f.profile(rules);
    const error = refused(
      await f.campaign({
        action: 'preview_recipe',
        recipe: 'google_search',
        profile_id: 'client',
        business: {...base, destination_url: 'https://example.test/?utm_source=bing'},
      }),
      'PLAYBOOK_UTM_CONFLICT',
    );
    assert.deepEqual(
      {
        parameter: error.details.parameter,
        url_value: error.details.url_value,
        playbook_value: error.details.playbook_value,
      },
      {parameter: 'utm_source', url_value: 'bing', playbook_value: 'google'},
    );
    const out = ok(
      await f.campaign({
        action: 'preview_recipe',
        recipe: 'google_search',
        profile_id: 'client',
        business: {...base, destination_url: 'https://example.test/p?q=a%20b&utm_source=google#top'},
      }),
    );
    assert.equal(
      out.provenance.conventions.destination_url.result,
      'https://example.test/p?q=a%20b&utm_source=google&utm_medium=cpc&utm_campaign=Synthetic%20website%20demand#top',
    );
  } finally {
    f.store.close();
  }
});

test('the playbook preview tags a landing page exactly as recipe plans do, and refuses the same conflicts', async () => {
  // Guards the parity the deployed check compares: the preview used to re-serialize the URL and overwrite a
  // conflicting utm_* value that the recipe refuses, so the two previews could disagree.
  const f = fixture();
  try {
    f.profile(rules);
    const destination = 'https://example.test/p?q=a%20b#top';
    const playbook = ok(
      await f.workspace({
        action: 'preview_profile',
        id: 'client',
        preview: {variables: {campaign_name: base.name}, destination_url: destination},
      }),
    );
    const recipe = ok(
      await f.campaign({
        action: 'preview_recipe',
        recipe: 'google_search',
        profile_id: 'client',
        business: {...base, destination_url: destination},
      }),
    );
    assert.equal(playbook.destination_url, recipe.provenance.conventions.destination_url.result);
    assert.equal(playbook.naming, recipe.plan.name);
    refused(
      await f.workspace({
        action: 'preview_profile',
        id: 'client',
        preview: {variables: {campaign_name: base.name}, destination_url: 'https://example.test/?utm_medium=email'},
      }),
      'PLAYBOOK_UTM_CONFLICT',
    );
  } finally {
    f.store.close();
  }
});

test('recipe context counts the connected accounts a playbook leaves out, so an empty list can say why', async () => {
  const f = fixture();
  try {
    f.profile({bindings: [{gateway: 'meta_native_action', connection_id: 'elsewhere', account_id: '9'}]});
    const bound = ok(await f.campaign({action: 'recipe_context', recipe: 'google_search', profile_id: 'client'}));
    assert.deepEqual(bound.targets, []);
    assert.equal(bound.excluded_by_playbook, 1);
    const open = ok(await f.campaign({action: 'recipe_context', recipe: 'google_search'}));
    assert.equal(open.targets.length, 1);
    assert.equal(open.excluded_by_playbook, 0);
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('unresolved variables and over-long derived names are refused with the rule named; playbook variables resolve', async () => {
  const f = fixture();
  try {
    f.profile({naming: '{{market}} · {{campaign_name}}'});
    const error = refused(
      await f.campaign({action: 'preview_recipe', recipe: 'google_search', profile_id: 'client', business: base}),
      'PLAYBOOK_CONVENTION_UNRESOLVED',
    );
    assert.deepEqual(error.details.variables, ['market']);
    f.store.putDocument(
      actor.tenantId,
      'client_profile',
      'client',
      {name: 'ACME', naming: '{{market}} · {{campaign_name}}', variables: {market: 'KSA'}},
      1,
    );
    const out = ok(
      await f.campaign({action: 'preview_recipe', recipe: 'google_search', profile_id: 'client', business: base}),
    );
    assert.equal(out.plan.name, 'KSA · Synthetic website demand');
    f.profile({naming: 'x'.repeat(90) + ' {{campaign_name}}'}, 'long');
    refused(
      await f.campaign({action: 'preview_recipe', recipe: 'google_search', profile_id: 'long', business: base}),
      'PLAYBOOK_NAME_TOO_LONG',
    );
  } finally {
    f.store.close();
  }
});

test('shared playbook defaults apply to every recipe that takes the field; a recipe default wins', async () => {
  const f = fixture();
  try {
    f.profile({
      defaults: {
        common: {daily_budget: '40', keywords: ['shared keyword'], cpc_bid_ceiling: '3', page_id: '99'},
        recipes: {google_search: {daily_budget: '30'}},
      },
    });
    const context = ok(await f.campaign({action: 'recipe_context', recipe: 'google_search', profile_id: 'client'}));
    assert.deepEqual(context.defaults, {daily_budget: '30', keywords: ['shared keyword']});
    // An account without a cached name was labelled "Synthetic · 123 · 123".
    assert.equal(context.targets[0].label, 'Synthetic · 123');
    const clicks = ok(
      await f.campaign({action: 'recipe_context', recipe: 'google_search_clicks', profile_id: 'client'}),
    );
    assert.deepEqual(clicks.defaults, {daily_budget: '40', keywords: ['shared keyword'], cpc_bid_ceiling: '3'});
    refused(
      await f.workspace({
        action: 'save_profile',
        confirmed: true,
        profile: {name: 'Bad', defaults: {common: ['not', 'named']}},
      }),
      'INVALID_PROFILE',
    );
  } finally {
    f.store.close();
  }
});

test('a saved client brief round-trips and a plan created from it records the brief and its revision', async () => {
  const f = fixture();
  try {
    f.profile(rules);
    const brief = ok(
      await f.workspace({
        action: 'save_brief',
        brief: {name: 'ACME autumn search', recipe: 'google_search', profile_id: 'client', business: base},
      }),
    );
    assert.equal(brief.objective, 'search');
    assert.equal(brief.profile_revision, 1);
    assert.equal(brief.created_by, 'operator');
    const listed = ok(await f.workspace({action: 'briefs'}));
    assert.deepEqual(
      listed.briefs.map(b => [b.id, b.name, b.recipe, b.revision]),
      [[brief.id, 'ACME autumn search', 'google_search', 1]],
    );
    assert.deepEqual(ok(await f.workspace({action: 'brief', id: brief.id})).business, base);
    // One call from brief to plan: the recipe, playbook and inputs come from the brief.
    const plan = ok(await f.campaign({action: 'create_from_recipe', brief_id: brief.id}));
    assert.equal(plan.name, 'ACME | Synthetic website demand | Search');
    assert.deepEqual(plan.recipe.provenance.client_brief, {id: brief.id, revision: 1, name: 'ACME autumn search'});
    const stored = f.store.document(actor.tenantId, 'campaign_run', plan.id);
    assert.deepEqual(stored.client_brief, {id: brief.id, revision: 1, name: 'ACME autumn search'});
    // Inputs sent with the call override the brief's; an explicit different recipe is refused.
    const override = ok(
      await f.campaign({action: 'preview_recipe', brief_id: brief.id, business: {daily_budget: '50.00'}}),
    );
    assert.equal(override.provenance.fields.daily_budget.source, 'user');
    assert.ok(planText(override).includes('50000000'));
    refused(
      await f.campaign({action: 'preview_recipe', brief_id: brief.id, recipe: 'google_search_clicks'}),
      'BRIEF_RECIPE_MISMATCH',
    );
    // A revision conflict, a reader and a secret are refused; delete needs the current revision.
    refused(
      await f.workspace({action: 'save_brief', id: brief.id, revision: 7, brief: {...brief, business: base}}),
      'INVALID_ARGUMENT',
    );
    const updated = ok(
      await f.workspace({
        action: 'save_brief',
        id: brief.id,
        revision: 1,
        brief: {name: 'ACME autumn search', recipe: 'google_search', business: {...base, daily_budget: '35.00'}},
      }),
    );
    assert.equal(updated.revision, 2);
    assert.equal(updated.profile_id, null);
    refused(
      await f.workspace(
        {action: 'save_brief', brief: {name: 'Reader', recipe: 'google_search', business: base}},
        {...actor, role: 'reader'},
      ),
      'FORBIDDEN',
    );
    assert.equal(
      (
        await f.workspace({
          action: 'save_brief',
          brief: {name: 'Secret', recipe: 'google_search', business: {...base, access_token: 'x'}},
        })
      ).success,
      false,
    );
    refused(
      await f.workspace({action: 'delete_brief', id: brief.id, revision: 1, confirmed: true}),
      'REVISION_CONFLICT',
    );
    assert.deepEqual(ok(await f.workspace({action: 'delete_brief', id: brief.id, revision: 2, confirmed: true})), {
      deleted: true,
    });
    assert.deepEqual(ok(await f.workspace({action: 'briefs'})).briefs, []);
  } finally {
    f.store.close();
  }
});

test('saved briefs are capped per workspace', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 200; i++)
      f.store.putDocument(actor.tenantId, 'client_brief', 'brief-' + i, {name: 'B' + i, recipe: 'google_search'});
    refused(
      await f.workspace({action: 'save_brief', brief: {name: 'One more', recipe: 'google_search', business: base}}),
      'LIMIT_REACHED',
    );
  } finally {
    f.store.close();
  }
});

test('Meta packs accept exactly one image source and show the age range they target', () => {
  const meta = {...base, drive_url: undefined};
  const sources = {
    drive_url: base.drive_url,
    source_id: 'src-upload_1',
    source_url: 'https://cdn.example.test/image.png',
    image_hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  };
  for (const [key, value] of Object.entries(sources)) {
    const plan = campaignRecipe('meta_website_traffic', {...meta, [key]: value});
    const creative = plan.steps.find(s => s.id === 'creative');
    if (key === 'image_hash') {
      assert.equal(
        plan.steps.some(s => s.kind === 'media'),
        false,
        'an account image needs no upload',
      );
      assert.equal(creative.arguments.payload.object_story_spec.link_data.image_hash, value);
      assert.deepEqual(creative.depends_on, []);
      assert.deepEqual(creative.prerequisites, ['meta_image_hash']);
    } else {
      const image = plan.steps.find(s => s.id === 'image');
      assert.equal(image.arguments[key], value);
      assert.deepEqual(creative.arguments.payload.object_story_spec.link_data.image_hash, {
        $ref: 'image#/image_hash',
      });
    }
    assert.equal(plan.recipe.audience.image_source, key);
  }
  assert.throws(() => campaignRecipe('meta_website_traffic', meta), /Complete the brief/);
  assert.throws(() => campaignRecipe('meta_website_traffic', {...meta, ...sources}), /exactly one image source/);
  // Age: the default is stated; an explicit range is used and validated.
  const plain = campaignRecipe('meta_website_traffic', base);
  assert.deepEqual(plain.recipe.audience, {
    age_min: 18,
    age_max: 65,
    source: 'recipe_default',
    image_source: 'drive_url',
  });
  const aged = campaignRecipe('meta_website_traffic', {...base, age_min: '25', age_max: 44});
  const targeting = aged.steps.find(s => s.id === 'adset').arguments.payload.targeting;
  assert.deepEqual([targeting.age_min, targeting.age_max], [25, 44]);
  assert.equal(aged.recipe.audience.source, 'brief');
  for (const bad of [{age_min: 12}, {age_max: 66}, {age_min: 40, age_max: 30}, {age_min: '2a'}])
    assert.throws(() => campaignRecipe('meta_website_traffic', {...base, ...bad}), /age/i, JSON.stringify(bad));
});

function metaFixture(images) {
  const store = new Store(':memory:', Buffer.alloc(32, 43).toString('base64')),
    requests = [];
  store.putConnection(
    owner,
    {
      id: 'meta-login',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Meta',
      scopes: ['ads_management', 'ads_read', 'pages_show_list'],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async url => {
      const u = new URL(String(url));
      requests.push(u.pathname + u.search);
      if (u.pathname.endsWith('/adimages'))
        return Response.json({data: images.map(hash => ({hash, account_id: '123'}))});
      if (u.pathname.endsWith('/promote_pages')) return Response.json({data: [{id: '456'}]});
      return Response.json({id: 'act_123', account_id: '123', currency: 'USD', name: 'Synthetic'});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {store, service, requests};
}

test('an account image hash passes preflight only when the account returns it', async () => {
  const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  for (const [images, status] of [
    [[hash], 'ready'],
    [['ffffffffffffffffffffffffffffffff'], 'blocked'],
  ]) {
    const f = metaFixture(images);
    try {
      const business = {...base, connection_id: 'meta-login', drive_url: undefined, image_hash: hash};
      const plan = ok(
        await f.service.call(
          'amcp_campaign',
          {action: 'create_from_recipe', recipe: 'meta_website_traffic', business},
          actor,
        ),
      );
      const out = ok(await f.service.call('amcp_campaign', {action: 'preflight', id: plan.id, detail: 'full'}, actor));
      const creative = out.preflight.checks.find(c => c.step === 'creative');
      assert.equal(creative.status === 'blocked' ? 'blocked' : 'ready', status, JSON.stringify(out.preflight));
      assert.ok(f.requests.some(r => r.includes('/act_123/adimages') && r.includes(hash)));
      if (status === 'ready')
        assert.ok(creative.assets.some(a => a.asset_type === 'Meta image' && a.status === 'provider_read_checked'));
      else assert.equal(creative.error.code, 'CAMPAIGN_PREREQUISITE_REQUIRED');
    } finally {
      f.store.close();
    }
  }
});

test('a plan reuses a live eligibility check of the same brief and starts at approval, with fewer calls and reads', async () => {
  // Before: eligibility → create_from_recipe → approve (preflight reads the account again) → approve confirmed.
  const before = fixture();
  let baseline;
  try {
    ok(await before.campaign({action: 'recipe_eligibility', recipe: 'google_search', business: base, live: true}));
    const plan = ok(await before.campaign({action: 'create_from_recipe', recipe: 'google_search', business: base}));
    const reads = before.requests.length;
    const summary = ok(await before.campaign({action: 'approve', id: plan.id}));
    assert.ok(before.requests.length > reads, 'the saved plan read the provider again');
    baseline = {calls: 3, reads: before.requests.length, summary: summary.summary_hash};
  } finally {
    before.store.close();
  }
  // After: eligibility → create_from_recipe with its eligibility_ref returns the approval summary.
  const f = fixture();
  try {
    const checked = ok(
      await f.campaign({action: 'recipe_eligibility', recipe: 'google_search', business: base, live: true}),
    );
    assert.match(checked.eligibility_ref, /^[0-9a-f-]{36}$/);
    const reads = f.requests.length;
    const created = ok(
      await f.campaign({
        action: 'create_from_recipe',
        recipe: 'google_search',
        business: base,
        eligibility_ref: checked.eligibility_ref,
      }),
    );
    assert.equal(created.eligibility_reuse.applied, true);
    assert.equal(created.eligibility_reuse.eligibility_ref, checked.eligibility_ref);
    assert.ok(created.approval, 'the approval summary comes with the plan');
    assert.equal(created.summary_hash, baseline.summary);
    assert.equal(f.requests.length, reads, 'no provider read between the check and the approval summary');
    assert.equal(2 < baseline.calls, true, 'two calls instead of three reach the approval summary');
    assert.ok(f.requests.length < baseline.reads);
    const run = f.store.document(actor.tenantId, 'campaign_run', created.id);
    assert.equal(run.preflight.seeded_from.eligibility_ref, checked.eligibility_ref);
    // Approval and the frozen per-step review still happen; prepare re-reads state at its own review.
    const approved = ok(
      await f.campaign({
        action: 'approve',
        id: created.id,
        plan_hash: created.plan_hash,
        summary_hash: created.summary_hash,
        confirmed: true,
        spend_change_confirmed: true,
      }),
    );
    assert.equal(approved.next_call.arguments.action, 'run');
  } finally {
    f.store.close();
  }
});

test('a reused eligibility check applies only while every binding matches', async () => {
  const cases = {
    brief_changed: async (f, ref) => ({business: {...base, daily_budget: '26.00'}, eligibility_ref: ref}),
    unknown_reference: async (f, ref) => ({eligibility_ref: ref, as: {...actor, userId: 'someone-else'}}),
    expired: async (f, ref) => {
      const record = f.store.document(actor.tenantId, 'recipe_eligibility', ref);
      const {id, revision, ...data} = record;
      f.store.putDocument(actor.tenantId, 'recipe_eligibility', ref, {...data, expires_at: Date.now() - 1}, revision);
      return {eligibility_ref: ref};
    },
    write_pause_changed: async (f, ref) => {
      ok(await f.workspace({action: 'pause_writes', confirmed: true, reason: 'Synthetic'}, owner));
      return {eligibility_ref: ref};
    },
    login_changed: async (f, ref) => {
      f.store.replaceCredentials(actor.tenantId, 'synthetic-login', {accessToken: 'new', developerToken: 'synthetic'});
      return {eligibility_ref: ref};
    },
    profile_revision_changed: async (f, ref) => {
      f.store.putDocument(actor.tenantId, 'client_profile', 'client', {name: 'ACME', ...rules, variables: {v: 2}}, 1);
      return {eligibility_ref: ref, profile_id: 'client'};
    },
  };
  for (const [reason, change] of Object.entries(cases)) {
    const f = fixture();
    try {
      const profiled = reason === 'profile_revision_changed';
      if (profiled) f.profile(rules);
      const checked = ok(
        await f.campaign({
          action: 'recipe_eligibility',
          recipe: 'google_search',
          business: base,
          live: true,
          ...(profiled ? {profile_id: 'client'} : {}),
        }),
      );
      const {as, ...extra} = await change(f, checked.eligibility_ref);
      const created = ok(
        await f.campaign({action: 'create_from_recipe', recipe: 'google_search', business: base, ...extra}, as),
      );
      assert.equal(created.eligibility_reuse.applied, false, reason);
      // A replaced login also changes the connection record, which the account binding covers first.
      assert.ok(
        (reason === 'login_changed' ? [reason, 'account_access_changed'] : [reason]).includes(
          created.eligibility_reuse.reason,
        ),
        reason + ': ' + created.eligibility_reuse.reason,
      );
      assert.equal(created.approval, undefined, reason);
      const run = f.store.document(actor.tenantId, 'campaign_run', created.id);
      assert.equal(run.preflight, undefined, reason + ': the plan runs its own preflight');
    } finally {
      f.store.close();
    }
  }
});

test('an uploaded image (source_id) builds a Meta plan whose preflight prepares that exact upload', async () => {
  const f = metaFixture([]);
  try {
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
      id = 'src-' + randomUUID(),
      created = Date.now();
    f.store.reserveMediaSource(actor.tenantId, id, created + WEBSITE_UPLOAD_TTL_MS);
    f.store.stageMedia(actor.tenantId, id, png);
    f.store.putDocument(actor.tenantId, 'media_source', id, {
      user_id: actor.userId,
      filename: 'plan.png',
      origin: 'upload',
      state: 'complete',
      size: png.length,
      mime: 'image/png',
      kind: 'image',
      sha256: sha256(png),
      created_at: created,
      expires_at: created + WEBSITE_UPLOAD_TTL_MS,
      inspection: 'unavailable',
    });
    const business = {...base, connection_id: 'meta-login', drive_url: undefined, source_id: id},
      create = extra =>
        f.service.call(
          'amcp_campaign',
          {action: 'create_from_recipe', recipe: 'meta_website_traffic', business, ...extra},
          actor,
        );
    refused(await create({}), 'TEMPORARY_MEDIA_SOURCES');
    const plan = ok(await create({acknowledge_temporary_sources: true}));
    const out = ok(await f.service.call('amcp_campaign', {action: 'preflight', id: plan.id, detail: 'full'}, actor));
    const image = out.preflight.checks.find(c => c.step === 'image');
    assert.equal(image.status, 'media_checked', JSON.stringify(out.preflight));
    assert.equal(image.sha256, sha256(png));
  } finally {
    f.store.close();
  }
});
