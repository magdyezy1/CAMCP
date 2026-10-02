import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {campaignRecipes} from '../dist/src/campaign-recipes.js';

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
        elements: {},
        addEventListener() {},
        setAttribute() {},
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
    args: {action: 'approve', id: 'plan-001', plan_hash: 'hash-001', confirmed: true, spend_change_confirmed: true},
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
    f.context.recordAccountLabel = () => 'Home 001';
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
  assert.deepEqual(transcripts[0][2], {
    tool: 'media',
    args: {action: 'execute', review_id: 'original-review', confirmed: true},
  });
});
