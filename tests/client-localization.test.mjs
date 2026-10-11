import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
};
function fixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [],
    confirmations = [],
    toasts = [],
    downloads = [],
    recipes = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        value: '',
        checked: false,
        isConnected: true,
        elements: {},
        values: {},
        events: new Map(),
        addEventListener(e, fn) {
          this.events.set(e, fn);
        },
        focus() {
          this.focused = true;
        },
        querySelector: node,
        querySelectorAll: () => [],
        insertAdjacentHTML(_position, html) {
          this.innerHTML += html;
        },
      });
    return nodes.get(key);
  };
  const form = node('#profile-form');
  for (const name of [
    'name',
    'naming',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'include_presentation',
    'report_brand_name',
    'report_accent_color',
    'report_footer',
    'report_template',
    'report_artifact_language',
    'additional',
    'templates',
    'preview_template',
    'approve',
    'example_name',
    'example_url',
    'example_variables',
  ])
    form.elements[name] = node('field:' + name);
  form.elements.example_name.value = 'Autumn launch';
  form.elements.example_url.value = 'https://example.com/';
  form.elements.example_variables.value = '{}';
  const profiles = [
    {
      id: 'first',
      name: 'Home <img>',
      revision: 3,
      approved_at: '2026-10-01',
      naming: '{{market}}_{{campaign_name}}',
      utm: {utm_source: 'Home', utm_term: '001'},
      templates: {Home: {steps: [{account_id: '001', amount: '0012.34'}]}},
      bindings: [],
      report_presentation: {brand_name: 'Home', accent_color: '#123ABC', footer: 'Home <img>', template: 'compact'},
    },
    {id: 'second', name: 'Second client', revision: 9},
  ];
  let respond = () => ({}),
    confirm = async () => false,
    renders = 0;
  const context = createContext({
    navigationGeneration: 1,
    identityGeneration: 1,
    Intl,
    structuredClone,
    URL: {createObjectURL: () => 'blob:synthetic', revokeObjectURL() {}},
    setTimeout() {},
    document: {
      addEventListener() {},
      createElement: () => {
        const link = {
          click() {
            downloads.push(this.download);
          },
        };
        return link;
      },
    },
    content: node('content'),
    $: node,
    platforms: [],
    session: {workspaceRole: 'owner'},
    date: String,
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    pretty: String,
    blank: String,
    recipeArrays: new Set(),
    recipeLabels: {},
    controls: (label, type, value, name) =>
      `<label>${label}<input type="${type}" name="${name}" value="${value}"></label>`,
    reviewTable: (value, label) => `<h3>${label}</h3>${JSON.stringify(value)}`,
    toast: message => toasts.push(message),
    renderWorkspacePage: async () => {
      renders++;
    },
    renderReportPack: async () => {
      renders++;
      return true;
    },
    workspaceBind: (s, fn) => bindings.set(s, fn),
    confirmAction: options => {
      confirmations.push(plain(options));
      return confirm(options);
    },
    workspaceCall: async (tool, args) => {
      calls.push({tool, args: plain(args)});
      return args.action === 'profiles' ? {profiles} : args.action === 'recipes' ? {recipes} : respond(args);
    },
    overviewCall: async args => {
      calls.push({tool: 'overview', args: plain(args)});
      return args.action === 'presentation_profiles'
        ? {
            profiles: profiles
              .filter(p => p.report_presentation)
              .map(p => ({...p, presentation: p.report_presentation})),
          }
        : respond(args);
    },
    FormData: class {
      constructor(form) {
        return Object.entries(form.values)[Symbol.iterator]();
      }
    },
    fetch: async () => ({ok: true, blob: async () => 'synthetic'}),
  });
  context.workPageLoader = (selector, _title, fetchPage, render, loaded) => ({
    load: async () => {
      const result = await fetchPage();
      node(selector).innerHTML = render(result);
      loaded(result);
    },
  });
  const run = s => new Script(s).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  if (locale === 'ar') {
    context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    run('uiLocale="ar"; uiMessages=new Map(Object.entries(catalog))');
  }
  run(readFileSync(process.env.AMCP_CLIENT_UI_SOURCE || 'web/client-playbooks.js', 'utf8'));
  run(readFileSync(process.env.AMCP_BRANDING_UI_SOURCE || 'web/report-presentation.js', 'utf8'));
  const select = i => bindings.get('[data-edit-profile]')({dataset: {editProfile: String(i)}});
  const edit = (field = 'name', type = 'input') => form.events.get(type)?.({target: form.elements[field]});
  const branding = async () => {
    for (const key of ['profile_id', 'confirmed'])
      node('#apply-profile-branding').elements[key] = node('branding:' + key);
    context.pack = {
      client_name: 'Home',
      presentation_revision: 7,
      presentation: profiles[0].report_presentation,
      presentation_source: {profile_name: 'Home <img>', profile_revision: 3},
    };
    await run('bindReportPresentation(pack, "snapshot-001")');
    return node('#apply-profile-branding');
  };
  return {
    run,
    context,
    node,
    form,
    bindings,
    calls,
    confirmations,
    toasts,
    downloads,
    select,
    edit,
    profiles,
    recipes,
    branding,
    renders: () => renders,
    confirm: fn => {
      confirm = fn;
    },
    respond: fn => {
      respond = fn;
    },
  };
}

test('client deletion stays bound to the confirmed profile, form and signed-in view', async () => {
  for (const change of ['selection', 'edit', 'identityGeneration', 'navigationGeneration', 'detach']) {
    const f = fixture();
    await f.run('renderClientPlaybooks()');
    f.select(0);
    const gate = deferred();
    f.confirm(options => {
      assert.match(options.title, /Home/);
      return gate.promise;
    });
    const pending = f.bindings.get('#delete-profile')();
    if (change === 'selection') f.select(1);
    else if (change === 'edit') f.edit();
    else if (change === 'detach') f.form.isConnected = false;
    else f.context[change]++;
    gate.resolve(true);
    await pending;
    assert.deepEqual(
      f.calls.filter(x => x.args.action === 'delete_profile'),
      [],
      change,
    );
    assert.equal(f.renders(), 0);
  }
  const f = fixture();
  await f.run('renderClientPlaybooks()');
  f.select(0);
  f.confirm(async () => false);
  await f.bindings.get('#delete-profile')();
  assert.equal(
    f.calls.some(x => x.args.action === 'delete_profile'),
    false,
  );
  f.confirm(async () => true);
  await f.bindings.get('#delete-profile')();
  assert.deepEqual(f.calls.at(-1).args, {action: 'delete_profile', id: 'first', revision: 3, confirmed: true});
});

test('guided conversion references preserve exact strings and structured mappings in bilingual preview and revision-bound approval', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    const mappings = {
      purchase: '9007199254740993',
      lead: 'customers/123/conversionActions/456',
      legacy: {account_id: '001', value: '0012.34'},
    };
    f.profiles[0].conversion_mappings = mappings;
    const source = JSON.stringify(f.profiles[0]);
    f.respond(args => ({naming: 'Client', conversion_mappings: args.profile.conversion_mappings}));
    await f.run('renderClientPlaybooks()');
    f.select(0);
    assert.match(f.node('content').innerHTML, /id="profile-conversion-fields"/);
    assert.equal(f.node('#profile-conversion-name-0').value, 'purchase');
    assert.equal(f.node('#profile-conversion-value-0').value, '9007199254740993');
    assert.deepEqual(JSON.parse(f.form.elements.additional.value).conversion_mappings, {legacy: mappings.legacy});
    await f.bindings.get('#preview-profile')();
    assert.match(f.node('#profile-preview').innerHTML, /9007199254740993/);
    assert.match(
      f.node('#profile-preview').innerHTML,
      locale === 'ar' ? /مراجع التحويل المصرّح بها/ : /Declared conversion references/,
    );
    assert.match(f.node('#profile-preview').innerHTML, locale === 'ar' ? /لم يتم التحقق/ : /not verified/);
    f.form.elements.approve.checked = true;
    await f.bindings.get('#profile-form')();
    assert.deepEqual(f.calls.at(-1).args.profile.conversion_mappings, mappings);
    assert.equal(f.calls.at(-1).args.revision, 3);
    assert.equal(JSON.stringify(f.profiles[0]), source);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});
test('conversion reference edits and local add/remove clear approval and refuse obsolete handlers without provider calls', async () => {
  const f = fixture();
  f.profiles[0].conversion_mappings = {purchase: '001', lead: '002'};
  await f.run('renderClientPlaybooks()');
  f.select(0);
  const before = f.calls.length;
  f.form.elements.approve.checked = true;
  f.node('#profile-conversion-value-0').value = '003';
  f.edit();
  assert.equal(f.form.elements.approve.checked, false);
  f.node('#profile-conversion-add').events.get('click')();
  assert.equal(f.node('#profile-conversion-value-0').value, '003');
  assert.equal(f.node('#profile-conversion-name-2').focused, true);
  const obsolete = f.node('#profile-conversion-remove-0').events.get('click');
  // CMP-06: opening another playbook over unsaved edits now asks first; this test discards them.
  f.confirm(async () => true);
  await f.select(1);
  assert.match(f.confirmations.at(-1).title, /Discard unsaved edits/);
  obsolete();
  assert.match(f.node('#profile-conversion-fields').innerHTML, /No simple conversion references/);
  f.node('#profile-conversion-add').events.get('click')();
  f.node('#profile-conversion-name-0').value = 'purchase';
  f.node('#profile-conversion-value-0').value = '004';
  f.form.elements.approve.checked = true;
  f.node('#profile-conversion-remove-0').events.get('click')();
  assert.equal(f.form.elements.approve.checked, false);
  assert.equal(f.node('#profile-conversion-add').focused, true);
  assert.equal(f.calls.length, before);
});
test('guided conversion references refuse duplicate, partial, unsafe or oversized entries and collisions with advanced mappings before requests', async () => {
  for (const change of [
    f => {
      f.node('#profile-conversion-name-1').value = 'purchase';
    },
    f => {
      f.node('#profile-conversion-value-0').value = '';
    },
    f => {
      f.node('#profile-conversion-name-0').value = '__proto__';
    },
    f => {
      f.node('#profile-conversion-value-0').value = 'x'.repeat(2049);
    },
    f => {
      f.node('#profile-conversion-name-0').value = 'x'.repeat(81);
    },
    f => {
      f.form.elements.additional.value = '{"conversion_mappings":{"purchase":{"original":"kept"}}}';
    },
    f => {
      f.form.elements.additional.value = '{"conversion_mappings":[]}';
    },
  ]) {
    const f = fixture();
    f.profiles[0].conversion_mappings = {purchase: '001', lead: '002'};
    await f.run('renderClientPlaybooks()');
    f.select(0);
    change(f);
    const before = f.calls.length;
    await assert.rejects(f.bindings.get('#preview-profile')());
    assert.equal(f.calls.length, before);
  }
});
test('unrecognized and excess existing conversion mappings remain intact while guided editing stays bounded', async () => {
  const f = fixture(),
    mappings = Object.fromEntries(
      Array.from({length: 52}, (_, i) => ['goal' + i, String(9007199254740993n + BigInt(i))]),
    );
  Object.assign(mappings, {
    complex: {id: '001', settings: ['unchanged']},
    numeric: 123,
    'unusual/key': 'original',
    multiline: 'original\nreference',
  });
  f.profiles[0].conversion_mappings = mappings;
  await f.run('renderClientPlaybooks()');
  f.select(0);
  assert.equal(f.node('#profile-conversion-add').disabled, true);
  const advanced = JSON.parse(f.form.elements.additional.value).conversion_mappings;
  for (const key of ['goal50', 'goal51', 'complex', 'numeric', 'unusual/key', 'multiline'])
    assert.deepEqual(advanced[key], mappings[key]);
  f.node('#profile-conversion-add').events.get('click')();
  f.form.elements.approve.checked = true;
  await f.bindings.get('#profile-form')();
  assert.deepEqual(f.calls.at(-1).args.profile.conversion_mappings, mappings);
});
test('Google click optimization exposes and preserves its exact CPC ceiling in reusable recipe defaults', async () => {
  const f = fixture();
  f.recipes.push({
    id: 'google_search_clicks',
    name: 'Google Search clicks',
    required: ['daily_budget', 'cpc_bid_ceiling', 'destination_url'],
  });
  f.profiles[0].defaults = {recipes: {google_search_clicks: {daily_budget: '25', cpc_bid_ceiling: '1.234567'}}};
  await f.run('renderClientPlaybooks()');
  f.select(0);
  assert.match(f.node('#profile-default-fields').innerHTML, /data-default-field="cpc_bid_ceiling" value="1\.234567"/);
  f.node('#profile-default-fields').querySelectorAll = () => [
    {dataset: {defaultField: 'cpc_bid_ceiling'}, value: '2.000001'},
  ];
  f.form.elements.approve.checked = true;
  await f.bindings.get('#profile-form')();
  assert.equal(f.calls.at(-1).args.profile.defaults.recipes.google_search_clicks.cpc_bid_ceiling, '2.000001');
  assert.equal(f.profiles[0].defaults.recipes.google_search_clicks.cpc_bid_ceiling, '1.234567');
});

test('Search conversion playbooks retain exact CPA defaults without supplying goal-policy consent', async () => {
  const f = fixture();
  f.recipes.push({
    id: 'google_search_target_cpa',
    name: 'Google Search with a target CPA',
    required: ['daily_budget', 'target_cpa', 'conversion_goal_policy', 'destination_url'],
  });
  f.profiles[0].defaults = {recipes: {google_search_target_cpa: {daily_budget: '25', target_cpa: '00015.250001'}}};
  await f.run('renderClientPlaybooks()');
  f.select(0);
  assert.match(f.node('#profile-default-fields').innerHTML, /data-default-field="target_cpa" value="00015\.250001"/);
  assert.doesNotMatch(f.node('#profile-default-fields').innerHTML, /data-default-field="conversion_goal_policy"/);
  f.node('#profile-default-fields').querySelectorAll = () => [
    {dataset: {defaultField: 'target_cpa'}, value: '20.000001'},
  ];
  f.form.elements.approve.checked = true;
  await f.bindings.get('#profile-form')();
  assert.equal(f.calls.at(-1).args.profile.defaults.recipes.google_search_target_cpa.target_cpa, '20.000001');
  assert.equal(f.calls.at(-1).args.profile.defaults.recipes.google_search_target_cpa.conversion_goal_policy, undefined);
  assert.equal(f.profiles[0].defaults.recipes.google_search_target_cpa.target_cpa, '00015.250001');
});
test('playbook preview includes exact recipe defaults and translated first-party context while unknown diagnostic text stays original', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.profiles[0].defaults = {recipes: {google_search_clicks: {daily_budget: '25', cpc_bid_ceiling: '2.000001'}}};
    f.respond(args => ({
      naming: 'Client',
      defaults: args.profile.defaults,
      meaning:
        'Preview only. Defaults are copied into a new draft; existing plans and schedules keep their recorded profile revision. Account bindings do not grant access.',
    }));
    await f.run('renderClientPlaybooks()');
    f.select(0);
    await f.bindings.get('#preview-profile')();
    assert.match(f.node('#profile-preview').innerHTML, /2\.000001/);
    if (locale === 'ar') {
      assert.match(f.node('content').innerHTML, /مصدر UTM/);
      assert.match(f.node('#profile-preview').innerHTML, /المعاينة فقط/);
      assert.doesNotMatch(f.node('#profile-preview').innerHTML, /Preview only\./);
    }
    f.respond(() => ({meaning: 'Unknown provider diagnostic Home'}));
    await f.bindings.get('#preview-profile')();
    assert.match(f.node('#profile-preview').innerHTML, /Unknown provider diagnostic Home/);
  }
});
test('declared conversion reference preview escapes names, text and structured evidence without altering the source', () => {
  const f = fixture(),
    mappings = {
      purchase: '9007199254740993 <img>',
      '<img>': {original: '<script>source</script>'},
      multiline: 'original\nreference',
    };
  f.context.mappingInput = mappings;
  const source = JSON.stringify(mappings);
  const html = f.run('profileConversionPreview(mappingInput)');
  assert.doesNotMatch(html, /<img>|<script>/);
  assert.match(html, /9007199254740993 &lt;img&gt;/);
  assert.match(html, /&lt;script&gt;source&lt;\/script&gt;/);
  assert.equal(JSON.stringify(mappings), source);
});
test('local conversion-row actions invalidate pending preview results and cannot edit a departed identity', async () => {
  for (const action of ['add', 'remove']) {
    const f = fixture(),
      gate = deferred();
    f.profiles[0].conversion_mappings = {purchase: '001'};
    f.respond(() => gate.promise);
    await f.run('renderClientPlaybooks()');
    f.select(0);
    const pending = f.bindings.get('#preview-profile')();
    const control = f.node(action === 'add' ? '#profile-conversion-add' : '#profile-conversion-remove-0');
    control.events.get('click')();
    gate.resolve({naming: 'Old preview', conversion_mappings: {purchase: '001'}});
    await pending;
    assert.equal(f.node('#profile-preview').innerHTML, '');
    const html = f.node('#profile-conversion-fields').innerHTML;
    f.context.identityGeneration++;
    control.events.get('click')();
    assert.equal(f.node('#profile-conversion-fields').innerHTML, html);
  }
});

test('late client previews and errors cannot replace edited, selected or departed settings', async () => {
  for (const change of ['selection', 'input', 'change', 'identityGeneration', 'navigationGeneration', 'detach']) {
    for (const reject of [false, true]) {
      const f = fixture();
      await f.run('renderClientPlaybooks()');
      f.select(0);
      const gate = deferred();
      f.respond(() => gate.promise);
      const pending = f.bindings.get('#preview-profile')();
      if (change === 'selection') f.select(1);
      else if (['input', 'change'].includes(change)) f.edit('name', change);
      else if (change === 'detach') f.form.isConnected = false;
      else f.context[change]++;
      if (reject) gate.reject(Error('Old profile failed'));
      else gate.resolve({naming: 'Old preview', meaning: 'Old settings'});
      await pending;
      assert.equal(f.node('#profile-preview').innerHTML, '', change);
    }
  }
  const f = fixture();
  await f.run('renderClientPlaybooks()');
  const gates = [deferred(), deferred()];
  let index = 0;
  f.respond(() => gates[index++].promise);
  const first = f.bindings.get('#preview-profile')(),
    second = f.bindings.get('#preview-profile')();
  gates[1].resolve({naming: 'Newest preview'});
  await second;
  const latest = f.node('#profile-preview').innerHTML;
  gates[0].resolve({naming: 'Old preview'});
  await first;
  assert.equal(f.node('#profile-preview').innerHTML, latest);
  f.respond(async () => {
    throw Error('Current failure');
  });
  await assert.rejects(f.bindings.get('#preview-profile')(), /Current failure/);
});

test('client edits revoke approval and obsolete local saves cannot reset a newer editor', async () => {
  for (const action of ['#profile-form', '#delete-profile'])
    for (const reject of [false, true]) {
      const f = fixture();
      await f.run('renderClientPlaybooks()');
      f.select(0);
      f.form.elements.approve.checked = true;
      f.edit('approve', 'change');
      assert.equal(f.form.elements.approve.checked, true);
      f.confirm(async () => true);
      const gate = deferred(),
        started = deferred();
      f.respond(() => {
        started.resolve();
        return gate.promise;
      });
      const pending = f.bindings.get(action)();
      await started.promise;
      assert.equal(f.calls.at(-1).args.id, 'first');
      f.form.elements.name.value = 'Changed client';
      f.edit();
      assert.equal(f.form.elements.approve.checked, false);
      if (reject) gate.reject(Error('Old save failure'));
      else gate.resolve({});
      await pending;
      assert.equal(f.renders(), 0);
      assert.deepEqual(f.toasts, []);
      f.context.identityGeneration++;
      const before = f.calls.length;
      await f.bindings.get(action)();
      assert.equal(f.calls.length, before);
    }
});

test('Arabic client playbooks preserve native defaults, saved values, preview and approval requests', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.run('renderClientPlaybooks()');
    f.select(0);
    const markup = f.node('content').innerHTML;
    assert.match(markup, /value="Autumn launch"/);
    assert.match(markup, /Home &lt;img&gt;/);
    if (locale === 'ar') assert.match(markup, /العملاء وأدلة العمل المعتمدة/);
    assert.equal(f.form.elements.naming.value, '{{market}}_{{campaign_name}}');
    assert.equal(f.form.elements.utm_term.value, '001');
    f.respond(() => ({
      naming: 'Home',
      meaning: 'Native diagnostic Home',
      destination_url: 'https://example.test/?id=001',
    }));
    await f.bindings.get('#preview-profile')();
    assert.match(f.node('#profile-preview').innerHTML, /Native diagnostic Home/);
    f.form.elements.approve.checked = true;
    await f.bindings.get('#profile-form')();
    const saved = f.calls.at(-1).args;
    assert.equal(saved.profile.templates.Home.steps[0].amount, '0012.34');
    assert.equal(saved.profile.report_presentation.brand_name, 'Home');
    assert.equal(saved.confirmed, true);
    assert.equal(saved.revision, 3);
    f.confirm(async () => true);
    await f.bindings.get('#delete-profile')();
    if (locale === 'ar') assert.match(f.confirmations.at(-1).title, /[\u0600-\u06ff]/);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
});

test('report and client branding expose an explicit artifact language, independently of interface language', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.run('renderClientPlaybooks()');
    f.select(0);
    assert.match(f.node('content').innerHTML, /name="report_artifact_language"/);
    assert.equal(f.form.elements.report_artifact_language.value, 'en');
    f.form.elements.report_artifact_language.value = 'ar';
    f.edit('report_artifact_language');
    assert.equal(f.form.elements.approve.checked, false);
    f.form.elements.approve.checked = true;
    await f.bindings.get('#profile-form')();
    assert.equal(f.calls.at(-1).args.profile.report_presentation.artifact_language, 'ar');
    await f.branding();
    assert.match(f.node('.report-pack').innerHTML, /name="artifact_language"/);
    const presentation = f.node('#report-presentation');
    presentation.values = {
      brand_name: 'Home',
      accent_color: '#123ABC',
      footer: '',
      template: 'compact',
      artifact_language: 'ar',
      confirmed: 'on',
    };
    await f.bindings.get('#report-presentation')(presentation);
    assert.equal(f.calls.at(-1).args.presentation.artifact_language, 'ar');
  }
});

test('Arabic report branding preserves explicit choice, consent, revisions and artifact filenames', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      form = await f.branding();
    if (locale === 'ar') assert.match(f.node('.report-pack').innerHTML, /هوية العميل وتنسيق التنزيل/);
    assert.match(f.node('.report-pack').innerHTML, /Home &lt;img&gt;/);
    await assert.rejects(f.bindings.get('#apply-profile-branding')());
    assert.equal(
      f.calls.some(c => c.args.action === 'apply_profile_presentation'),
      false,
    );
    form.elements.profile_id.value = 'first';
    form.elements.confirmed.checked = true;
    form.elements.profile_id.events.get('change')();
    assert.equal(form.elements.confirmed.checked, false);
    assert.match(f.node('#selected-profile-branding').innerHTML, /Home/);
    form.elements.confirmed.checked = true;
    await f.bindings.get('#apply-profile-branding')();
    assert.deepEqual(f.calls.at(-1).args, {
      action: 'apply_profile_presentation',
      id: 'snapshot-001',
      profile_id: 'first',
      profile_revision: 3,
      presentation_revision: 7,
      confirmed: true,
    });
    const presentation = f.node('#report-presentation');
    presentation.values = {
      brand_name: 'Home',
      accent_color: '#123ABC',
      footer: 'Native footer',
      template: 'compact',
      confirmed: 'on',
    };
    await f.bindings.get('#report-presentation')(presentation);
    assert.deepEqual(f.calls.at(-1).args.presentation, {
      brand_name: 'Home',
      accent_color: '#123ABC',
      footer: 'Native footer',
      template: 'compact',
    });
    for (const format of ['pdf', 'xlsx']) await f.bindings.get('#download-pack-' + format)();
    assert.deepEqual(f.downloads, ['AMCP-report-pack.pdf', 'AMCP-report-pack.xlsx']);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
});

test('departed report branding handlers do not submit or expose stale errors', async () => {
  for (const selector of ['#report-presentation', '#apply-profile-branding']) {
    const f = fixture(),
      form = await f.branding();
    form.elements.profile_id.value = 'first';
    const presentation = f.node('#report-presentation');
    presentation.values = {brand_name: 'Home', confirmed: 'on'};
    const gate = deferred();
    f.respond(() => gate.promise);
    const pending = f.bindings.get(selector)(presentation);
    f.context.identityGeneration++;
    gate.reject(Error('Old branding failure'));
    await pending;
    assert.equal(f.renders(), 0);
    const before = f.calls.length;
    await f.bindings.get(selector)(presentation);
    assert.equal(f.calls.length, before);
  }
});

test('changed branding choices and presentation settings retain the new editor during a pending save', async () => {
  for (const selector of ['#report-presentation', '#apply-profile-branding']) {
    const f = fixture(),
      form = await f.branding();
    form.elements.profile_id.value = 'first';
    const presentation = f.node('#report-presentation');
    presentation.values = {brand_name: 'Home', confirmed: 'on'};
    presentation.elements.confirmed = {checked: true};
    const gate = deferred();
    f.respond(() => gate.promise);
    const pending = f.bindings.get(selector)(presentation);
    if (selector === '#apply-profile-branding') {
      form.elements.profile_id.value = '';
      form.elements.profile_id.events.get('change')();
    } else {
      presentation.events.get('input')?.({target: {name: 'brand_name'}});
      assert.equal(presentation.elements.confirmed.checked, false);
    }
    gate.resolve({});
    await pending;
    assert.equal(f.renders(), 0);
    assert.deepEqual(f.toasts, []);
  }
});

test('late report downloads and errors stay with their original view while current failures remain visible', async () => {
  for (const reject of [false, true])
    for (const change of ['identityGeneration', 'navigationGeneration', 'detach']) {
      const f = fixture();
      await f.branding();
      const gate = deferred();
      let requests = 0;
      f.context.fetch = async () => {
        requests++;
        return gate.promise;
      };
      const pending = f.bindings.get('#download-pack-pdf')();
      if (change === 'detach') f.node('.report-pack').isConnected = false;
      else f.context[change]++;
      if (reject) gate.reject(Error('Old download failure'));
      else gate.resolve({ok: true, blob: async () => 'synthetic'});
      await pending;
      assert.deepEqual(f.downloads, []);
      assert.deepEqual(f.toasts, []);
      await f.bindings.get('#download-pack-pdf')();
      assert.equal(requests, 1);
    }
  const f = fixture();
  await f.branding();
  f.context.fetch = async () => {
    throw Error('Current download failure');
  };
  await assert.rejects(f.bindings.get('#download-pack-pdf')(), /Current download failure/);
});

// WEB-06 regression: the page also asked the campaign tool for recipes, which the server refuses for a test account
// (TEST_ACCOUNT_SCOPE), so Clients & templates showed "This page could not open" to platform reviewers.
test('Clients & templates opens from the profiles response alone, so a test account can use it', async () => {
  const f = fixture(),
    scope = Object.assign(Error('This test account does not include that area of AMCP.'), {code: 'TEST_ACCOUNT_SCOPE'});
  f.context.workspaceCall = async (tool, args) => {
    f.calls.push({tool, args: plain(args)});
    if (tool === 'campaign') throw scope;
    return args.action === 'profiles'
      ? {
          profiles: f.profiles,
          recipe_defaults: [
            {
              id: 'google_search_clicks',
              name: 'Google Search with Maximize Clicks',
              fields: ['daily_budget', 'cpc_bid_ceiling'],
            },
          ],
        }
      : {};
  };
  await f.run('renderClientPlaybooks()');
  assert.deepEqual(
    f.calls.map(call => call.tool),
    ['workspace'],
    'only the workspace tool is used',
  );
  const html = f.node('content').innerHTML;
  assert.match(html, /<option value="google_search_clicks">Google Search with Maximize Clicks<\/option>/);
  assert.match(html, /id="profile-recipe-defaults" >/);
  f.profiles[0].defaults = {recipes: {google_search_clicks: {daily_budget: '25'}}};
  f.select(0);
  assert.match(f.node('#profile-default-fields').innerHTML, /data-default-field="daily_budget" value="25"/);
  assert.match(f.node('#profile-default-fields').innerHTML, /data-default-field="cpc_bid_ceiling"/);
  f.form.elements.approve.checked = true;
  await f.bindings.get('#profile-form')();
  assert.equal(f.calls.at(-1).args.action, 'save_profile');
  assert.equal(f.calls.at(-1).tool, 'workspace');
});

test('an older server without recipe fields still opens the page; a refused recipe list hides only the defaults', async () => {
  const f = fixture(),
    scope = Object.assign(Error('Refused'), {code: 'TEST_ACCOUNT_SCOPE'});
  f.context.workspaceCall = async (tool, args) => {
    f.calls.push({tool, args: plain(args)});
    if (tool === 'campaign') throw scope;
    return args.action === 'profiles' ? {profiles: f.profiles} : {};
  };
  await f.run('renderClientPlaybooks()');
  assert.match(f.node('content').innerHTML, /id="profile-recipe-defaults" hidden>/);
  assert.match(f.node('content').innerHTML, /id="profile-form"/);
  // Any other failure still opens the page error, as before.
  const g = fixture();
  g.context.workspaceCall = async (tool, args) => {
    if (tool === 'campaign') throw Object.assign(Error('Server unavailable'), {code: 'INTERNAL_ERROR'});
    return args.action === 'profiles' ? {profiles: g.profiles} : {};
  };
  await assert.rejects(g.run('renderClientPlaybooks()'), /Server unavailable/);
});

test('Build a campaign opens the composer with that playbook chosen, only where Campaigns is in scope', async () => {
  const f = fixture();
  await f.run('renderClientPlaybooks()');
  assert.match(f.node('content').innerHTML, /href="\/campaigns\?profile_id=first#campaign-create"/);
  const g = fixture();
  g.context.routeAvailable = path => path !== '/campaigns';
  await g.run('renderClientPlaybooks()');
  assert.doesNotMatch(g.node('content').innerHTML, /Build a campaign/);
});

test('a client save refresh cannot announce success after the signed-in view changes', async () => {
  const f = fixture();
  await f.run('renderClientPlaybooks()');
  f.select(0);
  f.form.elements.approve.checked = true;
  f.context.renderWorkspacePage = async () => {
    f.context.identityGeneration++;
  };
  await f.bindings.get('#profile-form')();
  assert.deepEqual(f.toasts, []);
});

// CMP-06: Clients & templates at agency scale. The list was unsorted with no search or URL state, opening another
// playbook silently dropped unsaved edits, bound accounts were one flat list of every resource, shared defaults had to
// be copied per workflow and a new client could not start from an existing playbook.
function agencyFixture(search = '') {
  const f = fixture(),
    locations = [];
  f.context.location = {pathname: '/profiles', search};
  f.context.URLSearchParams = URLSearchParams;
  f.context.setViewLocation = url => locations.push(url);
  f.context.pageLeaveGuard = null;
  f.context.uiNumber = String;
  f.context.accountLabel = (p, c, id) => p.name + ' · ' + id;
  f.context.platforms = [
    {
      gateway: 'meta_native_action',
      name: 'Meta',
      connections: [{id: 'meta-login', enabled: true, accounts: ['1', '2']}],
    },
    {
      gateway: 'google_sheets_native_action',
      name: 'Google Sheets',
      selectionKind: 'spreadsheets',
      connections: [{id: 'sheets-login', enabled: true, accounts: ['sheet']}],
    },
  ];
  f.profiles[0].bindings = [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: '1'}];
  return {...f, locations};
}

test('the playbook list names bindings, narrows by search, and the address reopens a playbook (CMP-06)', async () => {
  const f = agencyFixture('?profile_id=second');
  await f.run('renderClientPlaybooks()');
  const html = f.node('content').innerHTML;
  assert.match(html, /1 bound accounts · Meta/);
  assert.match(html, /No bound accounts: any connected account can be chosen/);
  assert.match(html, /id="profile-search"/);
  // The linked playbook opens; opening another records it in the address.
  assert.equal(f.node('#profile-heading').textContent, 'Edit Second client · revision 9');
  assert.equal(f.locations.at(-1), '/profiles?profile_id=second');
  f.select(0);
  assert.equal(f.locations.at(-1), '/profiles?profile_id=first');
  await f.bindings.get('#new-client')();
  assert.equal(f.locations.at(-1), '/profiles');
  // Search hides the rows whose client name does not match; it is not an unsaved edit.
  const rows = [0, 1].map(i => ({dataset: {profileRow: String(i)}, hidden: false}));
  f.node('#profile-list').querySelectorAll = () => rows;
  f.node('#profile-search').events.get('input')({target: {value: ' SECOND '}});
  assert.deepEqual(
    rows.map(r => r.hidden),
    [true, false],
  );
  assert.equal(f.node('#profile-search-empty').hidden, true);
  f.node('#profile-search').events.get('input')({target: {value: 'nobody'}});
  assert.equal(f.node('#profile-search-empty').hidden, false);
  assert.equal(f.context.pageLeaveGuard(), false);
  // A playbook this workspace does not have is named, and the editor starts empty.
  const g = agencyFixture('?profile_id=gone');
  await g.run('renderClientPlaybooks()');
  assert.equal(g.node('#profile-link-missing').hidden, false);
  assert.equal(g.node('#profile-heading').textContent, 'New client playbook');
});

test('unsaved playbook edits ask before another playbook, a new one or an in-app link replaces them (CMP-06)', async () => {
  const f = agencyFixture();
  await f.run('renderClientPlaybooks()');
  f.select(0);
  assert.equal(f.context.pageLeaveGuard(), false, 'an opened playbook is not an edit');
  // Looking at another example or other defaults is not an edit either.
  f.form.elements.example_name.name = 'example_name';
  f.edit('example_name');
  assert.equal(f.context.pageLeaveGuard(), false);
  f.form.elements.name.value = 'Home edited';
  f.edit();
  assert.equal(f.context.pageLeaveGuard(), true, 'in-app links ask before leaving');
  f.confirm(async () => false);
  await f.select(1);
  assert.match(f.confirmations.at(-1).title, /Discard unsaved edits/);
  assert.equal(f.node('#profile-heading').textContent, 'Edit Home <img> · revision 3', 'kept on cancel');
  assert.equal(f.form.elements.name.value, 'Home edited');
  await f.bindings.get('#new-client')();
  assert.equal(f.node('#profile-heading').textContent, 'Edit Home <img> · revision 3');
  f.confirm(async () => true);
  await f.select(1);
  assert.equal(f.node('#profile-heading').textContent, 'Edit Second client · revision 9');
  assert.equal(f.context.pageLeaveGuard(), false);
  // A sign-out or workspace switch is never blocked: the guard belongs to this view only.
  f.form.elements.name.value = 'Second edited';
  f.edit();
  f.context.identityGeneration++;
  assert.equal(f.context.pageLeaveGuard(), false);
});

test('Duplicate playbook starts an unsaved new client from every saved setting (CMP-06)', async () => {
  const f = agencyFixture();
  f.profiles[0].naming = {campaign: '{{market}} | {{campaign_name}}', ad: '{{campaign_name}} ad'};
  f.profiles[0].utm = {utm_source: 'Home', utm_id: '{{campaign_name}}'};
  await f.run('renderClientPlaybooks()');
  f.select(0);
  assert.equal(f.node('#duplicate-profile').hidden, false);
  await f.bindings.get('#duplicate-profile')();
  assert.equal(f.node('#profile-heading').textContent, 'New client playbook');
  assert.equal(f.form.elements.name.value, 'Copy of Home <img>');
  assert.equal(f.node('#delete-profile').hidden, true);
  assert.equal(f.context.pageLeaveGuard(), true, 'the copy is not saved yet');
  f.form.elements.approve.checked = true;
  await f.bindings.get('#profile-form')();
  const save = f.calls.at(-1).args;
  assert.equal(save.action, 'save_profile');
  assert.equal(save.id, undefined, 'saved as a new playbook');
  assert.equal(save.revision, undefined);
  assert.equal(save.profile.name, 'Copy of Home <img>');
  assert.deepEqual(save.profile.naming, f.profiles[0].naming, 'structured naming is kept');
  assert.equal(save.profile.utm.utm_id, '{{campaign_name}}', 'UTM keys without a field are kept');
  assert.deepEqual(save.profile.templates, f.profiles[0].templates);
});

test('bound accounts are grouped by platform; files and sheets appear on request or when bound (CMP-06)', async () => {
  const f = agencyFixture();
  await f.run('renderClientPlaybooks()');
  f.select(0);
  let accounts = f.node('#profile-accounts').innerHTML;
  assert.match(accounts, /<legend>Meta · 2<\/legend>/);
  assert.doesNotMatch(accounts, /Google Sheets/);
  assert.match(accounts, /id="profile-accounts-all"/);
  f.node('#profile-accounts-all').events.get('change')({target: {checked: true}});
  accounts = f.node('#profile-accounts').innerHTML;
  assert.match(accounts, /<legend>Google Sheets · 1<\/legend>/);
  assert.equal(f.context.pageLeaveGuard(), false, 'listing more accounts is not an edit');
  // A bound sheet is always listed, checked.
  const g = agencyFixture();
  g.profiles[0].bindings.push({
    gateway: 'google_sheets_native_action',
    connection_id: 'sheets-login',
    account_id: 'sheet',
  });
  await g.run('renderClientPlaybooks()');
  g.select(0);
  assert.match(g.node('#profile-accounts').innerHTML, /<legend>Google Sheets · 1<\/legend>/);
  assert.match(g.node('#profile-accounts').innerHTML, /&quot;sheet&quot;\}" checked/);
});

test('shared defaults are edited once for every workflow and kept out of Advanced settings (CMP-06)', async () => {
  const f = agencyFixture();
  f.recipes.push(
    {id: 'google_search', name: 'Google Search', required: ['daily_budget', 'destination_url']},
    {id: 'meta_website_traffic', name: 'Meta traffic', required: ['daily_budget', 'country_codes']},
  );
  f.profiles[0].defaults = {common: {destination_url: 'https://example.test/'}, recipes: {}};
  await f.run('renderClientPlaybooks()');
  assert.match(f.node('content').innerHTML, /<option value="\*common">Shared by every workflow<\/option>/);
  f.select(0);
  assert.doesNotMatch(f.form.elements.additional.value, /common/, 'not duplicated in Advanced settings');
  f.node('#profile-recipe').events.get('change')({target: {value: '*common'}});
  const shared = f.node('#profile-default-fields').innerHTML;
  assert.match(shared, /data-default-field="destination_url" value="https:\/\/example\.test\/"/);
  assert.match(shared, /data-default-field="country_codes"/);
  f.node('#profile-default-fields').querySelectorAll = () => [
    {dataset: {defaultField: 'destination_url'}, value: 'https://example.test/shared'},
    {dataset: {defaultField: 'daily_budget'}, value: '25'},
  ];
  f.form.elements.approve.checked = true;
  await f.bindings.get('#profile-form')();
  assert.deepEqual(f.calls.at(-1).args.profile.defaults.common, {
    destination_url: 'https://example.test/shared',
    daily_budget: '25',
  });
  // Shared defaults typed into Advanced settings are refused before any request, like recipe defaults.
  const before = f.calls.length;
  f.form.elements.additional.value = JSON.stringify({defaults: {common: {daily_budget: '1'}}});
  await assert.rejects(f.bindings.get('#profile-form')(), /Shared by every workflow/);
  assert.equal(f.calls.length, before);
});
