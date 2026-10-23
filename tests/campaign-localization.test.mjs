import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {campaignRecipes, campaignRecipe} from '../dist/src/campaign-recipes.js';

const plain = value => JSON.parse(JSON.stringify(value));
function fixture(locale) {
  const nodes = new Map(),
    calls = [],
    bindings = new Map();
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        innerHTML: '',
        value: '',
        checked: false,
        hidden: false,
        isConnected: true,
        elements: {},
        addEventListener() {},
        setAttribute() {},
        // The consent refusal (WEB-03) clears its marks once every box is ticked.
        removeAttribute() {},
        focus() {},
        querySelector: node,
        querySelectorAll: () => [],
      });
    return nodes.get(selector);
  };
  const context = createContext({
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    Intl,
    Date,
    URLSearchParams,
    document: {addEventListener() {}, querySelector: node, querySelectorAll: () => []},
    $: node,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    date: String,
    pretty: value => String(value ?? '').replaceAll('_', ' '),
    toast() {},
    FormData: class {
      constructor(form) {
        return new Map(Object.entries(form.values));
      }
    },
    session: {authenticated: true, workspaceRole: 'operator'},
    platforms: [],
    navigationGeneration: 1,
    identityGeneration: 1,
    accountLabel: (_p, _c, id) => 'Home ' + id,
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  for (const file of [
    'workspace',
    'campaign-workflows',
    'campaign-recipes',
    'creative-push',
    'creative-library',
    'ad-previews',
    'capability-center',
  ])
    run(readFileSync('web/' + file + '.js', 'utf8'));
  context.workspaceBind = (selector, fn) => bindings.set(selector, fn);
  context.workspaceCall = async (tool, args) => {
    calls.push({tool, args: plain(args)});
    return {id: 'retained-001'};
  };
  return {run, context, node, calls, bindings};
}

test('every executable campaign recipe has Arabic discovery copy without translating its identity', () => {
  const f = fixture('ar');
  for (const recipe of campaignRecipes) {
    f.context.recipe = recipe;
    assert.notEqual(f.run('uiText(recipe.name)'), recipe.name);
    assert.notEqual(f.run('uiText(recipe.description)'), recipe.description);
    const translated = f.run('uiText(recipe.name)');
    f.context.search = translated;
    assert.equal(f.run('capabilityMatches(recipe,search)'), true);
    assert.equal(f.run('capabilityMatches(recipe,recipe.name)'), true);
    assert.equal(f.run("capabilityMatches(recipe,'absent-phrase-001')"), false);
    assert.equal(f.run('recipe.id'), recipe.id);
  }
});

function retainedPushFixture(locale = 'en') {
  const f = fixture(locale);
  const source = {
    source_id: 'src-11111111-1111-1111-1111-111111111111',
    filename: 'Exact <original>.png',
    state: 'complete',
    kind: 'image',
    mime: 'image/png',
    size: 68,
    sha256: 'a'.repeat(64),
    expires_at: '2026-10-03T01:30:00.000Z',
    retained: false,
    can_retain: true,
  };
  const held = {
    ...source,
    source_id: source.source_id.replace('src-', 'lib-'),
    retained: true,
    expires_at: null,
    can_retain: false,
    can_remove_retained: true,
    retention: {mode: 'until_removed', original_source_id: source.source_id},
  };
  const requests = [],
    confirmations = [];
  f.context.confirmAction = async value => {
    confirmations.push(plain(value));
    return true;
  };
  f.context.api = async (url, options = {}) => {
    requests.push({url, ...plain(options)});
    return options.method === 'POST' ? held : options.method === 'DELETE' ? {removed: true} : {sources: [source, held]};
  };
  f.context.targets = [];
  f.node('#push-review').elements = {name: {value: ''}, owner_urn: {value: ''}, fit: {checked: true}};
  f.run('bindCreativePush(targets,[])');
  const choose = async s =>
    f.bindings.get('[data-push-source]')({dataset: {pushSource: s.source_id}, isConnected: true});
  return {...f, source, held, requests, confirmations, choose};
}

test('guided creative retention preserves exact source/hash and local consent in both languages', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = retainedPushFixture(locale);
    await f.choose(f.source);
    const html = f.node('#push-file').innerHTML;
    assert.match(html, /data-push-retain/);
    assert.doesNotMatch(html, /<original>/);
    await f.bindings.get('[data-push-retain]')({dataset: {pushRetain: '0'}, isConnected: true});
    const request = f.requests.find(r => r.method === 'POST');
    assert.equal(request.url, '/api/media/sources/' + f.source.source_id + '/retain');
    assert.deepEqual(JSON.parse(request.body), {confirmed: true, expected_sha256: f.source.sha256});
    assert.match(f.confirmations[0].consequence, new RegExp(f.source.sha256));
    assert.match(f.node('#push-file').innerHTML, locale === 'ar' ? /حتى يزيله مالك/ : /until an owner removes/);
    assert.doesNotMatch(f.node('#push-file').innerHTML, /kept until.*null/);
    assert.match(f.node('#push-file').innerHTML, /lib-11111111/);
    assert.equal(f.calls.length, 0);
    transcripts.push(f.requests.filter(r => r.method === 'POST'));
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('retained-file removal names permanent consequence and sends owner-confirmed exact hash', async () => {
  const f = retainedPushFixture();
  await f.choose(f.held);
  await f.bindings.get('[data-push-delete]')({dataset: {pushDelete: '0'}, isConnected: true});
  assert.match(f.confirmations[0].consequence, /Permanently/);
  assert.match(f.confirmations[0].consequence, new RegExp(f.held.sha256));
  assert.deepEqual(JSON.parse(f.requests.find(r => r.method === 'DELETE').body), {
    confirmed: true,
    expected_sha256: f.held.sha256,
  });
});

test('retaining a temporary original already selected as a library copy keeps one upload source', async () => {
  const f = retainedPushFixture();
  await f.choose(f.held);
  await f.choose(f.source);
  assert.match(f.node('#push-file').innerHTML, /Files in this push: 2/);
  await f.bindings.get('[data-push-retain]')({dataset: {pushRetain: '1'}, isConnected: true});
  assert.match(f.node('#push-file').innerHTML, /Files in this push: 1/);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('cancelled or departed creative-retention confirmation cannot send a request or paint another identity', async () => {
  for (const boundary of ['cancel', 'navigation', 'identity', 'detached']) {
    const f = retainedPushFixture();
    await f.choose(f.source);
    f.requests.length = 0;
    let resolve;
    f.context.confirmAction = () =>
      new Promise(done => {
        resolve = done;
      });
    const pending = f.bindings.get('[data-push-retain]')({dataset: {pushRetain: '0'}, isConnected: true});
    if (boundary === 'navigation') f.context.navigationGeneration++;
    if (boundary === 'identity') f.context.identityGeneration++;
    if (boundary === 'detached') f.node('#push-file').isConnected = false;
    resolve(boundary !== 'cancel');
    await pending;
    assert.equal(f.requests.length, 0, boundary);
    assert.doesNotMatch(f.node('#push-file').innerHTML, /lib-11111111/);
  }
});

test('an obsolete retention control and an unrelated response cannot change another selected original', async () => {
  const f = retainedPushFixture();
  await f.choose(f.source);
  const obsolete = f.bindings.get('[data-push-retain]');
  await f.choose(f.held);
  f.requests.length = 0;
  await obsolete({dataset: {pushRetain: '0'}, isConnected: true});
  assert.equal(f.requests.length, 0);
  assert.equal(f.confirmations.length, 0);
  const next = retainedPushFixture();
  await next.choose(next.source);
  next.context.api = async () => ({...next.held, sha256: 'f'.repeat(64)});
  await assert.rejects(
    next.bindings.get('[data-push-retain]')({dataset: {pushRetain: '0'}, isConnected: true}),
    /does not match/,
  );
  assert.match(next.node('#push-file').innerHTML, /data-push-retain/);
  assert.doesNotMatch(next.node('#push-file').innerHTML, /lib-11111111/);
});

test('a delayed retained-source response cannot paint a departed identity', async () => {
  const f = retainedPushFixture();
  await f.choose(f.source);
  let complete, started;
  const entered = new Promise(done => {
    started = done;
  });
  f.context.api = () =>
    new Promise(done => {
      complete = done;
      started();
    });
  const pending = f.bindings.get('[data-push-retain]')({dataset: {pushRetain: '0'}, isConnected: true});
  await entered;
  f.context.identityGeneration++;
  complete(f.held);
  await pending;
  assert.doesNotMatch(f.node('#push-file').innerHTML, /lib-11111111/);
});

test('Arabic campaign review keeps exact native fields and requires every original acknowledgement', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.review = {
      request: {
        action: 'native_update',
        name: 'Home',
        budget_micros: '0001234567890123456789',
        status: 'ACTIVE',
        account_id: '001',
      },
      execute_requirements: {spend_change_confirmed: true, cap_override_confirmed: true, creative_edit_confirmed: true},
    };
    const html = f.run("readableReview(review, uiText('Execute reviewed request'))");
    assert.match(html, /Home/);
    assert.match(html, /0001234567890123456789/);
    assert.match(html, /ACTIVE/);
    assert.doesNotMatch(html, /type="checkbox" checked/);
    if (locale === 'ar') assert.match(html, /مراجعة هذا التغيير/);
    assert.throws(() => f.run('readReviewConsents(review)'));
    for (const id of ['review-consent', 'spend-consent', 'cap-consent']) f.node('#' + id).checked = true;
    assert.throws(() => f.run('readReviewConsents(review)'));
    f.node('#creative-consent').checked = true;
    assert.deepEqual(plain(f.run('readReviewConsents(review)')), {
      confirmed: true,
      spend_change_confirmed: true,
      cap_override_confirmed: true,
      creative_edit_confirmed: true,
    });
  }
});

test('Arabic whole-plan approval remains bound to the displayed hash, original account and spend consent', async () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.workspaceCall = async (tool, args) => {
      f.calls.push({tool, args: plain(args)});
      return args.confirmed
        ? {state: 'approved'}
        : {
            approval: {
              plan_hash: 'hash-001',
              summary_hash: 'summary-001',
              covers: 'Native exact scope',
              steps: [{id: 'Home', gateway: 'meta', account_id: '001', status: [{field: '/status', value: 'ACTIVE'}]}],
            },
          };
    };
    f.run("bindCampaignWorkflow({id:'plan-001',steps:[]},async()=>false,()=>true)");
    await f.bindings.get('#approve-campaign')();
    if (locale === 'ar') assert.match(f.node('#campaign-review').innerHTML, /اعتماد هذه الخطة كاملة/);
    f.node('#plan-consent').checked = true;
    await assert.rejects(f.bindings.get('#approve-plan')());
    assert.equal(f.calls.length, 1);
    f.node('#plan-spend-consent').checked = true;
    await f.bindings.get('#approve-plan')();
    requests.push(f.calls);
  }
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[0][1], {
    tool: 'campaign',
    args: {
      action: 'approve',
      id: 'plan-001',
      plan_hash: 'hash-001',
      summary_hash: 'summary-001',
      confirmed: true,
      spend_change_confirmed: true,
    },
  });
});

test('Arabic recipe inputs keep ad copy, precise money strings, IDs and native declaration values', () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    const html = f.run("recipeField('name', 'Home <img>', true)");
    assert.match(html, /name="name"/);
    assert.match(html, /value="Home &lt;img&gt;"/);
    if (locale === 'ar') assert.match(html, /اسم الحملة/);
    const declaration = f.run(
      "recipeField('contains_eu_political_advertising','DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',true)",
    );
    assert.match(declaration, /value="DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" selected/);
    f.context.form = {
      values: {
        name: 'Home',
        message: 'إعلان العميل Home',
        daily_budget: '0012.340000',
        target: '{"connection_id":"login-001","account_id":"001"}',
        headlines: 'Home\nالعرض الجديد',
        special_ad_categories: 'none',
        contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      },
    };
    requests.push(plain(f.run('readRecipeBusiness(form)')));
  }
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[0].daily_budget, '0012.340000');
  assert.equal(requests[0].message, 'إعلان العميل Home');
  assert.deepEqual(requests[0].headlines, ['Home', 'العرض الجديد']);
  assert.deepEqual(requests[0].special_ad_categories, []);
});

test('Arabic creative UI keeps filenames, tags, source hashes and the exact saved upload plan', async () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.asset = {
      name: 'Home <img>',
      platform: 'meta',
      connection_id: 'login-001',
      account_id: '001',
      tags: ['Home'],
      media_id: '00091',
      asset_id: 'asset-001',
    };
    f.context.recordAccountLabelHtml = () => '<bdi>Home 001</bdi>';
    const html = f.run('creativeAssetCard(asset)');
    assert.match(html, /Home &lt;img&gt;/);
    assert.match(html, /00091/);
    if (locale === 'ar') assert.match(html, /فحص المورد واستخدامه/);
    f.context.rows = [
      {
        state: 'ready',
        name: 'Home',
        destination: {platform: 'meta', account_id: '001', connection_id: 'login-001'},
        source: {source_id: 'source-001'},
        file: {sha256: 'exact-source-hash'},
        fit: true,
      },
    ];
    await f.run('saveCreativePushPlan(rows)');
    assert.equal(f.run("pushName('Home.png')"), 'Home');
    requests.push(f.calls);
  }
  assert.deepEqual(requests[1], requests[0]);
  const request = requests[0][0];
  assert.equal(request.tool, 'campaign');
  assert.equal(request.args.action, 'create');
  assert.equal(request.args.steps[0].arguments.expected_sha256, 'exact-source-hash');
  assert.equal(request.args.steps[0].arguments.name, 'Home');
  assert.equal(request.args.confirmed, undefined);
});

test('Maximize Clicks ceiling input is bilingual and preserves exact decimal text', () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      html = f.run("recipeField('cpc_bid_ceiling','0001.250001',true)");
    assert.match(html, /name="cpc_bid_ceiling" required/);
    assert.match(html, /value="0001.250001"/);
    assert.match(html, /inputmode="decimal"/);
    assert.match(html, locale === 'ar' ? /الحد الأقصى للنقرة على مستوى الحملة/ : /Campaign CPC ceiling/);
    f.context.form = {
      values: {cpc_bid_ceiling: '0001.250001', target: '{"connection_id":"login-001","account_id":"001"}'},
    };
    requests.push(plain(f.run('readRecipeBusiness(form)')));
  }
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].cpc_bid_ceiling, '0001.250001');
  assert.equal(requests[0].cpc_bid, undefined);
});

test('Search conversion bidding keeps exact CPA and explicit goal policy identical in both languages', () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      cpa = f.run("recipeField('target_cpa','00015.250001',true)"),
      goals = f.run("recipeField('conversion_goal_policy',undefined,true)");
    assert.match(cpa, /name="target_cpa" required/);
    assert.match(cpa, /value="00015\.250001"/);
    assert.match(cpa, /inputmode="decimal"/);
    assert.match(goals, /name="conversion_goal_policy" required/);
    assert.match(goals, /value="ACCOUNT_DEFAULT"/);
    assert.doesNotMatch(goals, /selected/);
    assert.match(cpa, locale === 'ar' ? /التكلفة المستهدفة لكل تحويل/ : /Target cost per conversion/);
    assert.match(goals, locale === 'ar' ? /أهداف التحويل الافتراضية للحساب/ : /account-default conversion goals/);
    f.context.form = {
      values: {
        target_cpa: '00015.250001',
        conversion_goal_policy: 'ACCOUNT_DEFAULT',
        target: '{"connection_id":"login-001","account_id":"001"}',
      },
    };
    requests.push(plain(f.run('readRecipeBusiness(form)')));
  }
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].target_cpa, '00015.250001');
  assert.equal(requests[0].conversion_goal_policy, 'ACCOUNT_DEFAULT');
});

test('conversion preview presents exact native money, goal limits and scope in both languages', () => {
  const {cpc_bid, ...base} = JSON.parse(
    readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business;
  for (const id of ['google_search_conversions', 'google_search_target_cpa']) {
    const {recipe, ...plan} = campaignRecipe(id, {
      ...base,
      name: 'Native <img onerror=bad>',
      conversion_goal_policy: 'ACCOUNT_DEFAULT',
      ...(id.endsWith('target_cpa') ? {target_cpa: '9007199254.740991'} : {}),
    });
    for (const locale of ['en', 'ar']) {
      const f = fixture(locale);
      f.context.out = {ready: true, provider_mutations: 0, plan, recipe};
      const html = f.run('conversionRecipePreview(out)');
      assert.match(html, /conversion-recipe-preview/);
      assert.match(html, /Native &lt;img onerror=bad&gt;/);
      assert.doesNotMatch(html, /<img/);
      assert.match(html, new RegExp(base.account_id));
      assert.match(html, new RegExp(base.connection_id));
      if (id.endsWith('target_cpa')) {
        assert.match(html, /9007199254\.740991 USD/);
        assert.match(html, /9007199254740991/);
      } else assert.match(html, locale === 'ar' ? /دون تكلفة مستهدفة/ : /No target CPA/);
      assert.match(html, locale === 'ar' ? /معاينة حملة تحويل موقوفة مؤقتًا/ : /Paused conversion campaign preview/);
      assert.match(html, locale === 'ar' ? /ليست حدًا للإنفاق/ : /not a per-conversion spending cap/);
      assert.equal(f.calls.length, 0);
    }
  }
});

test('conversion preview with changed target, currency, goal policy or account falls back to exact source details', () => {
  const {cpc_bid, ...base} = JSON.parse(
    readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business;
  // CMP-04: the campaign record sits in the one build step by default, or in its own step with atomic: false.
  const campaignOf = out =>
    out.plan.steps[0].id === 'build'
      ? out.plan.steps[0].arguments.payload.mutate_operations.find(o => o.campaign_operation).campaign_operation.create
      : out.plan.steps.find(s => s.id === 'campaign').arguments.payload.operations[0].create;
  for (const atomic of [true, false]) {
    const {recipe, ...plan} = campaignRecipe('google_search_target_cpa', {
      ...base,
      atomic,
      conversion_goal_policy: 'ACCOUNT_DEFAULT',
      target_cpa: '15.250001',
    });
    const original = {ready: true, provider_mutations: 0, plan, recipe};
    for (const mutate of [
      out => (out.recipe.target_cpa_micros = '999'),
      out => (out.recipe.currency = 'EUR'),
      out => (out.recipe.conversion_goal_policy = 'CUSTOM'),
      out => (out.plan.steps[0].account_id = 'foreign'),
      out => (campaignOf(out).status = 'ENABLED'),
    ]) {
      const f = fixture();
      f.context.out = structuredClone(original);
      assert.match(f.run('conversionRecipePreview(out)'), /conversion-recipe-preview/);
      mutate(f.context.out);
      const html = f.run('conversionRecipePreview(out)');
      assert.doesNotMatch(html, /conversion-recipe-preview/);
      assert.match(html, /Compiled plan and input provenance/);
    }
  }
});

const conversionGoalView = () => ({
  provider_mutations: 0,
  scope: {gateway: 'google_ads_native_action', account_id: '123', connection_id: 'synthetic-login'},
  conversion_goal_inspection: {
    record_kind: 'google_conversion_goal_inspection',
    provider_mutations: 0,
    complete: true,
    scope: {gateway: 'google_ads_native_action', account_id: '123', connection_id: 'synthetic-login'},
    captured_at: 1791029739000,
    summary: {goals: 2, biddable_goals: 1, actions: 3, matching_primary_actions: 1, unknown_primary_flags: 1},
    goals: [
      {
        resource_name: 'customers/123/customerConversionGoals/PURCHASE~WEBSITE',
        category: 'PURCHASE',
        origin: 'WEBSITE',
        biddable: true,
        matching_primary_actions: 1,
      },
      {
        resource_name: 'customers/123/customerConversionGoals/SUBMIT_LEAD_FORM~WEBSITE',
        category: 'SUBMIT_LEAD_FORM',
        origin: 'WEBSITE',
        biddable: false,
        matching_primary_actions: 0,
      },
    ],
    primary_actions: [
      {
        resource_name: 'customers/123/conversionActions/1',
        name: 'Native <img onerror=bad>',
        status: 'ENABLED',
        primary_for_goal: true,
      },
    ],
    display_omissions: {goals: 0, primary_actions: 5},
  },
});

test('conversion configuration view localizes counts and scrollable goal settings while preserving native IDs and escaped names', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.out = conversionGoalView();
    const html = f.run('conversionGoalInspectionView(out)');
    assert.match(html, /role="region" tabindex="0"/);
    assert.match(html, /scope="col"/);
    assert.match(html, /dir="ltr" class="goal-resource"/);
    assert.match(html, /customers\/123\/customerConversionGoals\/PURCHASE~WEBSITE/);
    assert.match(html, /SUBMIT_LEAD_FORM~WEBSITE/);
    assert.match(html, /Native &lt;img onerror=bad&gt;/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, locale === 'ar' ? /إعدادات التحويل الحالية/ : /Current conversion configuration/);
    assert.match(html, locale === 'ar' ? /الأداء بحاجة إلى تحقق/ : /performance still need verification/);
    assert.match(
      html,
      locale === 'ar' ? /لا يعرض الجدول 0 صفوف أهداف و5 صفوف/ : /Display omits 0 goal rows and 5 primary-action rows/,
    );
    assert.equal(f.calls.length, 0);
  }
});

test('incomplete shared conversion state gives a localized reason without rendering partial goal evidence', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      out = conversionGoalView();
    out.conversion_goal_inspection.complete = false;
    out.conversion_goal_inspection.reason = 'shared_conversion_customer';
    f.context.out = out;
    const html = f.run('conversionGoalInspectionView(out)');
    assert.match(html, locale === 'ar' ? /تتبع تحويلات مشتركًا/ : /shared conversion tracking/);
    assert.doesNotMatch(html, /<table|PURCHASE~WEBSITE|Native &lt;img/);
  }
});

test('goal display refuses altered scope, mutation evidence, impossible counts and non-primary action rows', () => {
  for (const change of [
    p => (p.scope.account_id = '999'),
    p => (p.scope.connection_id = 'other-login'),
    p => (p.provider_mutations = 1),
    p => (p.summary.biddable_goals = 100),
    p => (p.summary.matching_primary_actions = -1),
    p => (p.primary_actions[0].primary_for_goal = false),
    p => (p.goals[0].resource_name = 'customers/999/customerConversionGoals/PURCHASE~WEBSITE'),
  ]) {
    const f = fixture('en'),
      out = conversionGoalView();
    change(out.conversion_goal_inspection);
    f.context.out = out;
    assert.equal(f.run('conversionGoalInspectionView(out)'), '');
  }
});

test('workspace prerequisite blockers explain the current write control in both languages and retain its diagnostic code', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.out = {
      provider_mutations: 0,
      status: 'blocked',
      dependencies: [],
      blockers: [{code: 'deployment_writes_disabled', source: 'current_workspace_prerequisite'}],
    };
    const html = f.run('recipeEligibilityView(out)');
    const readable = html.split('<details class="workspace-details">')[0],
      reason = f.run("uiText('Reviewed writes are disabled in this deployment')");
    if (locale === 'ar') assert.notEqual(reason, 'Reviewed writes are disabled in this deployment');
    assert.ok(readable.includes(reason));
    assert.match(html, /deployment_writes_disabled/);
    assert.doesNotMatch(readable, /current_workspace_prerequisite/);
  }
});

test('Arabic preview labels preserve placement enums and exact requested ad IDs', async () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.platforms = [
      {gateway: 'meta_native_action', connections: [{id: 'login-001', enabled: true, accounts: ['001']}]},
    ];
    const html = f.run('adPreviewsPanel()');
    assert.match(html, /value="INSTAGRAM_STORY"/);
    if (locale === 'ar') assert.match(html, /معاينة إعلاناتك/);
    const form = f.node('#preview-form');
    form.elements = {target: {value: '0'}, ad_ids: {value: '0001,0002'}, ad_format: {value: 'INSTAGRAM_STORY'}};
    f.context.workspaceCall = async (tool, args) => {
      f.calls.push({tool, args: plain(args)});
      return {previews: [], meaning: 'Provider explanation'};
    };
    f.run('bindAdPreviews()');
    await f.bindings.get('#preview-form')(form);
    requests.push(f.calls);
  }
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[0], [
    {
      tool: 'previews',
      args: {
        platform: 'meta',
        account_id: '001',
        connection_id: 'login-001',
        ad_ids: ['0001', '0002'],
        ad_format: 'INSTAGRAM_STORY',
      },
    },
  ]);
});

test('queued creative uploads retain their pending state and original review in both languages', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.navigationGeneration = 1;
    const source = {
      source_id: 'source-001',
      filename: 'Home.png',
      kind: 'image',
      state: 'complete',
      mime: 'image/png',
      size: 200,
    };
    f.context.api = async () => ({sources: [source]});
    f.context.targets = [{platform: 'meta', account_id: '001', connection_id: 'login-001', label: 'Home 001'}];
    const form = f.node('#push-review');
    form.elements = {name: {value: ''}, owner_urn: {value: ''}, fit: {checked: true}};
    form.querySelectorAll = selector => (selector === 'input[name=target]:checked' ? [{value: '0'}] : []);
    f.node('#push-reviews').insertAdjacentHTML = (_position, html) => {
      f.node('#push-reviews').innerHTML += html;
    };
    f.context.workspaceCall = async (tool, args) => {
      f.calls.push({tool, args: plain(args)});
      if (args.action === 'plan')
        return {destinations: [{ready: true, file: {sha256: 'exact-source-hash', size: 200, mime: 'image/png'}}]};
      if (args.action === 'prepare') return {review_id: 'original-review'};
      return {state: 'queued', job_id: 'job-001'};
    };
    // MED-03 A: the row is queued as a durable job and followed by polling; the member leaves the page while it is
    // still queued (the poll's wait ends on another page), so the row keeps its queued state and original review.
    f.context.setTimeout = fn => {
      f.context.navigationGeneration++;
      fn();
    };
    f.run('bindCreativePush(targets,[])');
    await f.bindings.get('[data-push-source]')({dataset: {pushSource: 'source-001'}});
    await f.bindings.get('#push-review')();
    await assert.rejects(f.bindings.get('#push-execute')());
    assert.equal(f.calls.length, 1);
    f.node('#push-consent').checked = true;
    await f.bindings.get('#push-execute')();
    const html = f.node('#push-reviews').innerHTML;
    assert.match(html, locale === 'ar' ? /في قائمة الانتظار/ : /Queued/);
    assert.match(html, /original-review/);
    assert.doesNotMatch(html, locale === 'ar' ? />تم الرفع</ : />Uploaded</);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.equal(transcripts[0][1].args.expected_sha256, 'exact-source-hash');
  assert.equal(transcripts[0][1].args.name, 'Home');
  // MED-03 A: a durable job (execute_async) followed by job_status, not a synchronous execute held open in the tab.
  assert.deepEqual(transcripts[0][2], {
    tool: 'media',
    args: {action: 'execute_async', review_id: 'original-review', confirmed: true},
  });
  assert.deepEqual(transcripts[0][3], {tool: 'media', args: {action: 'job_status', review_id: 'original-review'}});
  assert.equal(transcripts[0].length, 4, 'nothing more is sent once the page changed');
});
