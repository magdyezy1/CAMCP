import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';

function fixture(locale = 'en', workflow = 'program:linkedin_forecast') {
  const bindings = new Map(),
    calls = [],
    events = new Map(),
    result = {
      innerHTML: '',
      isConnected: true,
      focus() {
        this.focused = true;
      },
    },
    root = {
      isConnected: true,
      querySelectorAll() {
        return [form];
      },
    },
    values = {
      forecast: 'forecastReaches',
      objective: 'BRAND_AWARENESS',
      budget: '00123.450006',
      date_from: '2026-10-08',
      date_to: '2026-10-28',
      locations: 'urn:li:geo:105080838',
      network: 'false',
      expansion: 'false',
      request: '{}',
    },
    form = {
      id: 'synthetic-program',
      dataset: {workflowId: workflow, connectionId: 'original/login', accountId: '123'},
      isConnected: true,
      elements: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, {value: v}])),
      addEventListener(k, f) {
        events.set(k, f);
      },
      querySelector(selector) {
        return {
          hidden: false,
          querySelectorAll() {
            return Object.values(form.elements).filter(e => e !== form.elements.input_kind);
          },
        };
      },
    };
  if (workflow === 'program:linkedin_audience_insights')
    Object.assign(form.elements, {
      input_kind: {value: 'native', addEventListener() {}},
      audience_facet: {value: 'skills'},
      audience_values: {value: 'urn:li:skill:236'},
      group_by: {value: 'jobFunctions'},
      max_segments: {value: '5'},
    });
  let reply = async () => ({
    workflow_id: workflow,
    scope: {connection_id: 'original/login', account_id: '123'},
    state: 'observed',
    meaning: 'Original result',
    blockers: [],
    evidence: {
      forecast: 'forecastReaches',
      metric_curve: [{budgetMicros: 123450006, metricValue: 15}],
      single_point_metric: {budgetMicros: 123450006, metricValue: 15},
      native_name: '<img src=x> Home',
    },
  });
  const context = createContext({
    document: {
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
    },
    navigationGeneration: 1,
    identityGeneration: 1,
    $: () => result,
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    pretty: String,
    badge: v => v,
    recordDetails: v => context.esc(JSON.stringify(v)),
    workspaceBind: (id, fn) => bindings.set(id, fn),
    workspaceCall: async (tool, input) => {
      calls.push({tool, input: JSON.parse(JSON.stringify(input))});
      return reply(input);
    },
    URLSearchParams,
    BigInt,
    Date,
    Intl,
    uiNumber: value => String(value),
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  if (locale === 'ar')
    run('uiLocale="ar"; uiMessages=new Map(Object.entries(' + readFileSync('web/locales/ar.json', 'utf8') + '))');
  run(readFileSync('web/capability-center.js', 'utf8'));
  context.root = root;
  run('bindCapabilityPrograms(root)');
  return {
    context,
    run,
    form,
    root,
    result,
    events,
    calls,
    submit: () => bindings.get('#synthetic-program')(),
    reply: f => {
      reply = f;
    },
  };
}
test('English and Arabic conditional forecast forms submit identical exact native values with no implicit reads', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    assert.equal(f.calls.length, 0);
    await f.submit();
    const args = f.calls[0].input;
    assert.equal(args.action, 'program_check');
    assert.equal(args.live, true);
    assert.equal(args.account_id, '123');
    assert.equal(args.requirements.request.targetBudgetMicros, 123450006);
    assert.equal(args.requirements.request.sponsoredAccountUrn, 'urn:li:sponsoredAccount:123');
    assert.equal(args.requirements.request.enableAudienceExpansion, false);
    assert.equal(args.requirements.request.enableAudienceNetwork, false);
    assert.doesNotMatch(f.result.innerHTML, /<img/);
    assert.match(f.result.innerHTML, /&lt;img/);
    assert.match(f.result.innerHTML, /Home/);
    transcripts.push(args);
    const markup = f.run(
      'capabilityProgram({id:"program:linkedin_forecast",program:{access:"Private",limitations:"Limits",reference:"https://learn.microsoft.com/example",checked_on:"2026-10-06"}}, {connection_id:"original/login",account_id:"123"}, 0)',
    );
    assert.match(markup, /name="locations"/);
    assert.match(markup, /dir="ltr"/);
    if (locale === 'ar') {
      assert.match(markup, /[\u0600-\u06ff]/);
      assert.doesNotMatch(markup, /Read this exact|Forecast metric/);
    }
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});
test('edited, detached, navigated or replaced-identity views never apply a late program result', async () => {
  for (const action of ['edit', 'detach', 'navigate', 'identity', 'root']) {
    const f = fixture();
    let release;
    f.reply(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const pending = f.submit();
    if (action === 'edit') {
      f.form.elements.budget.value = '200';
      f.events.get('input')();
    }
    if (action === 'detach') f.form.isConnected = false;
    if (action === 'navigate') f.context.navigationGeneration++;
    if (action === 'identity') f.context.identityGeneration++;
    if (action === 'root') f.root.isConnected = false;
    release({
      workflow_id: f.form.dataset.workflowId,
      scope: {connection_id: 'original/login', account_id: '123'},
      state: 'observed',
      meaning: 'Old result',
    });
    await pending;
    assert.equal(f.result.innerHTML, '');
    assert.equal(f.result.focused, undefined);
    assert.equal(f.calls.length, 1);
  }
});

test('guided audience requests retain native URNs and exact account while translated views stay read-only', async () => {
  const calls = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale, 'program:linkedin_audience_insights');
    f.form.elements.input_kind.value = 'guided';
    f.reply(async () => ({
      workflow_id: f.form.dataset.workflowId,
      scope: {connection_id: 'original/login', account_id: '123'},
      state: 'observed',
      evidence: {
        total_audience_count: 0,
        grouped_by: null,
        segmentations: null,
        meaning:
          'LinkedIn suppressed audience segments outside its supported range. A reported zero does not establish an empty audience; a large count may be approximate.',
      },
    }));
    assert.equal(f.calls.length, 0);
    await f.submit();
    const request = f.calls[0].input.requirements.request;
    assert.deepEqual(request.requestMetaData, {sponsoredAccountUrn: 'urn:li:sponsoredAccount:123'});
    assert.equal(request.targetingCriteria.include.and[1].or['urn:li:adTargetingFacet:skills'][0], 'urn:li:skill:236');
    assert.equal(request.groupBy, 'urn:li:adTargetingFacet:jobFunctions');
    assert.equal(request.maxReturnCount, 5);
    assert.doesNotMatch(f.result.innerHTML, /<table/);
    if (locale === 'ar') assert.doesNotMatch(f.result.innerHTML, /Reported audience count|No audience segments/);
    calls.push(f.calls[0].input);
  }
  assert.deepEqual(calls[0], calls[1]);
  for (const [name, value] of [
    ['audience_values', 'urn:li:geo:1'],
    ['audience_values', 'urn:li:skill:1 urn:li:skill:1'],
    ['max_segments', '0'],
    ['max_segments', '101'],
  ]) {
    const f = fixture('ar', 'program:linkedin_audience_insights');
    f.form.elements.input_kind.value = 'guided';
    f.form.elements[name].value = value;
    await assert.rejects(f.submit());
    assert.equal(f.calls.length, 0);
  }
  const f = fixture('ar');
  const requirements = f.run(
    'capabilityProgramRequirements({program:{access:"LinkedIn must provision Audience Insights for the application. Marketing API access alone does not establish access to this private product.",limitations:"Native",reference:"https://learn.microsoft.com/example",checked_on:"2026-10-06"}})',
  );
  assert.match(requirements, /https:\/\/learn\.microsoft\.com/);
  assert.doesNotMatch(requirements, /Conditional program requirements|Official program requirements|must provision/);
});

test('capability display translates only complete owned explanations while preserving native and mixed text', () => {
  const f = fixture('ar'),
    base =
      'A mapped route passes independent read classification. Exact scope, payload, pagination and account/provider access still require verification.',
    suffix =
      'Documented fixed GET semantics override ambiguous resource names; Business/Catalog/member resources still require exact administrator bindings.';
  f.context.reason = base + ' ' + suffix;
  const translated = f.run('capabilityContractReason(reason)');
  assert.match(translated, /[\u0600-\u06ff]/);
  assert.doesNotMatch(translated, /A mapped route|Documented fixed/);
  for (const value of ['Native Campaign Home <img>', base + ' Unknown provider text', 'Result ' + base]) {
    f.context.reason = value;
    assert.equal(f.run('capabilityContractReason(reason)'), value);
  }
  f.context.reason = 'program:linkedin_forecast';
  assert.equal(f.run('capabilityLabel(reason)'), 'program:linkedin forecast');
  f.context.reason = 'private_application_product';
  assert.match(f.run('capabilityLabel(reason)'), /اعتماد التطبيق/);
});
test('invalid exact money, ambiguous geography and malformed native insight objects fail before a read', async () => {
  for (const [name, value] of [
    ['budget', '100.0000001'],
    ['budget', '99.999999'],
    ['budget', '1e3'],
    ['date_from', '2026-02-30'],
    ['locations', 'urn:li:geo:1 urn:li:geo:1'],
    ['locations', '<img>'],
    ['locations', 'urn:li:skill:1'],
  ]) {
    const f = fixture('ar');
    f.form.elements[name].value = value;
    await assert.rejects(f.submit());
    assert.equal(f.calls.length, 0);
  }
  for (const value of ['{bad}', '[]', 'null']) {
    const f = fixture('en', 'program:linkedin_audience_insights');
    f.form.elements.request.value = value;
    await assert.rejects(f.submit());
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.reply(async () => ({
    workflow_id: 'program:linkedin_forecast',
    scope: {connection_id: 'foreign', account_id: '123'},
  }));
  await assert.rejects(f.submit());
  assert.equal(f.result.innerHTML, '');
});

test('a refused program read shows its time, provider status, code, references and the reported prerequisite', async () => {
  // PRV-02/D21: the sanitized provider status and request IDs are shown, never a response body or provider message.
  const refused = {
    workflow_id: 'program:linkedin_forecast',
    scope: {connection_id: 'original/login', account_id: '123'},
    state: 'blocked',
    checked_at: Date.UTC(2026, 9, 8, 12, 30),
    meaning: 'Original result',
    blockers: ['PROVIDER_ACCESS_DENIED'],
    native_error: {
      code: 'PROVIDER_ACCESS_DENIED',
      http_status: 403,
      provider_code: 'USER_NOT_AUTHORIZED',
      amcp_request_id: 'amcp-request-1',
      request_id: 'amcp-request-1',
      provider_request_id: 'AAYz-li-uuid_01',
    },
    provider_reported_prerequisite: {
      prerequisite_id: 'member_account_access',
      provider_code: 'USER_NOT_AUTHORIZED',
      resolution:
        'LinkedIn reports that the connected member has no role on this ad account. Ask an account manager to give the member a role on the account in Campaign Manager, then check again.',
      reference: 'https://learn.microsoft.com/example',
    },
  };
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.reply(async () => refused);
    await f.submit();
    // The rendered summary, before the original evidence record (raw JSON, kept untranslated).
    const html = f.result.innerHTML.split('{&quot;')[0];
    for (const literal of ['USER_NOT_AUTHORIZED', 'AAYz-li-uuid_01', 'amcp-request-1', '403', 'data-copy-reference'])
      assert.match(html, new RegExp(literal), locale + ' ' + literal);
    assert.match(html, /2026/);
    if (locale === 'en') {
      assert.match(html, /As reported by LinkedIn/);
      assert.match(html, /Provider request reference/);
      assert.match(html, /no role on this ad account/);
      assert.match(html, /No cause is inferred/);
    } else {
      assert.doesNotMatch(html, /As reported by LinkedIn|Provider request reference|no role on this ad account/);
      assert.match(html, /[؀-ۿ]/);
    }
  }
});

// CON-04: forecast budgets read as currency, with the exact six-decimal micros value kept in the title. Before, the
// website printed "300.000000 USD" as the only form.
test('a forecast budget renders in USD currency style with the exact micros value in its title', () => {
  const en = fixture('en');
  assert.deepEqual(JSON.parse(en.run('JSON.stringify(capabilityUsd("300000000"))')), {
    text: '$300.00',
    title: '300.000000 USD',
  });
  assert.match(en.run('capabilityUsdHtml("123450006")'), /title="123\.450006 USD">\$123\.45</);
  const ar = fixture('ar');
  const html = ar.run('capabilityUsdHtml("300000000")');
  assert.match(html, /title="300\.000000 USD"/);
  assert.match(html, /dir="ltr"/);
  assert.doesNotMatch(html, /300\.000000 USD</);
});

const denied = {
  workflow_id: 'program:linkedin_forecast',
  scope: {connection_id: 'original/login', account_id: '123'},
  state: 'blocked',
  checked_at: Date.UTC(2026, 9, 8, 12, 30),
  provider_requests: 1,
  meaning: 'Original result',
  blockers: ['PROVIDER_ACCESS_DENIED'],
  native_error: {
    code: 'PROVIDER_ACCESS_DENIED',
    http_status: 403,
    provider_code: 'OTHER',
    amcp_request_id: 'amcp-request-1',
    request_id: 'amcp-request-1',
    provider_request_id: 'AAYz-li-uuid_01',
  },
  owner_action: {
    kind: 'contact_provider',
    reference: 'https://learn.microsoft.com/example',
    text: 'LinkedIn refused this exact request without a documented code. AMCP infers no cause. Confirm the application approval for this product and the member’s role on this ad account with LinkedIn, citing the provider request reference, then check again.',
  },
  retry_after_provisioning: true,
  next_call: null,
};
test('after a refused read the card shows the owner action, and its chip and last-observed line change (en/ar)', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      chip = {innerHTML: 'ready_for_preflight|Ready for native inspection'},
      last = {innerHTML: ''},
      parts = {'[data-program-status]': chip, '[data-program-last]': last};
    f.context.badge = (state, label) => state + '|' + label;
    f.form.closest = selector => (selector === '.operation-card' ? {querySelector: s => parts[s]} : null);
    f.reply(async () => denied);
    await f.submit();
    const html = f.result.innerHTML.split('{&quot;')[0];
    assert.match(chip.innerHTML, /^blocked\|/);
    assert.match(chip.innerHTML, /2026/);
    assert.match(last.innerHTML, /AAYz-li-uuid_01/);
    assert.match(last.innerHTML, /OTHER/);
    if (locale === 'en') {
      assert.match(chip.innerHTML, /Provider refused · /);
      assert.match(html, /Owner action/);
      assert.match(html, /without a documented code/);
      assert.match(html, /Repeating the same request now returns the same refusal/);
      assert.match(last.innerHTML, /Last observed:/);
      assert.match(last.innerHTML, /not a grant/);
    } else {
      for (const english of [
        /Provider refused/,
        /Owner action/,
        /without a documented code/,
        /Last observed/,
        /not a grant/,
      ])
        assert.doesNotMatch(chip.innerHTML + html + last.innerHTML, english);
      assert.match(chip.innerHTML, /رفضت المنصة/);
      assert.match(html, /إجراء المالك/);
    }
    // A re-rendered card in the same session keeps the observation.
    const card = f.run(
      'capabilityReadChip({id:"program:linkedin_forecast",program:{}}, {connection_id:"original/login",account_id:"123",local_state:"ready_for_preflight"})',
    );
    assert.match(card, /^blocked\|/);
  }
});

test('a retained observation shows after reload, and a program with no account shows its setup path', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.badge = (state, label) => state + '|' + label;
    const account = {
      connection_id: 'login',
      account_id: '123',
      label: 'Synthetic',
      local_state: 'ready_for_preflight',
      blockers: [],
      unresolved: [],
      next_call: {tool: 'amcp_workspace', arguments: {action: 'program_check'}},
      provider_evidence: {status: 'missing', checked_at: null, meaning: 'Exact account-read evidence only.'},
      program_evidence: {
        status: 'unverified',
        last_observation: {
          state: 'blocked',
          code: 'PROVIDER_ACCESS_DENIED',
          provider_code: 'ACCESS_DENIED',
          provider_request_id: 'li-ref-1',
          checked_at: Date.UTC(2026, 9, 8, 12, 30),
          grant: false,
        },
      },
    };
    const workflow = accounts => ({
      id: 'program:dv360_advertiser',
      name: 'Display & Video 360 advertiser access',
      objective: 'advertiser_access',
      description: 'Read the exact configured advertiser and retain its native partner, currency and status.',
      effect_details: 'This read changes no advertiser settings, line items, reports or download jobs.',
      program: {access: 'Access', limitations: 'Limits', reference: 'https://example.test/', checked_on: '2026-10-06'},
      required_inputs: ['connection_id', 'account_id'],
      dependencies: [],
      lifecycle: [],
      contracts: [],
      website_path: '/connections',
      next_call: null,
      accounts,
      ...(accounts.length
        ? {}
        : {
            setup: {
              text: 'No Display & Video 360 advertiser is selected for AMCP. On the Connections page, connect the Google identity that has Display & Video 360 access, sync it and select the advertiser, then inspect this program again.',
              prerequisites: [
                {
                  id: 'dv360_customer_role',
                  text: 'The Google identity needs a Display & Video 360 user profile with Admin, Standard or Read only access to the partner or advertiser.',
                },
              ],
              website_path: '/connections',
            },
          }),
    });
    f.context.w = workflow([account]);
    const kept = f.run('capabilityCard(w)');
    assert.match(kept, /blocked\|/);
    assert.match(kept, /li-ref-1/);
    assert.doesNotMatch(kept, /ready_for_preflight\|/);
    f.context.w = workflow([]);
    const setup = f.run('capabilityCard(w)');
    assert.match(setup, /href="\/connections"/);
    assert.match(setup, /Admin, Standard or Read only|Admin أو Standard أو Read only/);
    if (locale === 'en') {
      assert.match(kept, /Last observed:/);
      assert.match(setup, /Set up access first/);
      assert.doesNotMatch(setup, /Connect and select a matching account first/);
    } else {
      assert.doesNotMatch(
        kept + setup,
        /Last observed|Set up access first|No Display & Video 360 advertiser is selected/,
      );
      assert.match(setup, /اضبط الوصول أولًا/);
    }
  }
});
