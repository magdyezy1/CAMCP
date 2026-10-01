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
    downloads = [];
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
      return args.action === 'profiles' ? {profiles} : args.action === 'recipes' ? {recipes: []} : respond(args);
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
