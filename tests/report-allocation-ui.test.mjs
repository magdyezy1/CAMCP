import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture(request, preset = 'meta_campaign', locale = 'en') {
  const bindings = new Map(),
    events = new Map(),
    nodes = new Map();
  let focused = false,
    input;
  const fields = {
    budget: '200',
    minimum_conversions: '5',
    maximum_age_days: '7',
    efficiency_low: '0.8',
    efficiency_high: '1.2',
  };
  const rows = [
    {entity_id: '10', name: 'Efficient', observed_spend: '100', observed_conversions: '20'},
    {entity_id: '20', name: 'Established', observed_spend: '100', observed_conversions: '10'},
  ];
  const candidateButtons = rows.map(row => ({
    dataset: {allocationAdd: row.entity_id, allocationName: row.name},
    disabled: false,
    textContent: '',
    attributes: {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
  }));
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        textContent: '',
        isConnected: true,
        dataset: {},
        open: true,
        elements: Object.fromEntries(Object.entries(fields).map(([k, value]) => [k, {value}])),
        addEventListener: (event, fn) => events.set(id + ':' + event, fn),
        insertAdjacentHTML(_position, html) {
          this.innerHTML += html;
        },
        focus() {
          focused = true;
        },
        querySelector: selector => node(selector),
        querySelectorAll: selector =>
          selector === '[data-allocation-add]'
            ? candidateButtons
            : rows.map(row => ({
                dataset: {allocationCampaign: row.entity_id},
                querySelector: selector => ({
                  value:
                    row.entity_id === '10'
                      ? selector === '[data-floor]'
                        ? '25'
                        : '125'
                      : selector === '[data-floor]'
                        ? '50'
                        : '175',
                }),
              })),
      });
    return nodes.get(id);
  };
  const context = createContext({
    document: {addEventListener() {}},
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'operator'},
    $: node,
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    esc: String,
    blank: String,
    recordDetails: JSON.stringify,
    workspaceCall: async (_tool, args) => {
      input = args;
      return request();
    },
    workPageLoader: (_selector, _title, _fetch, _render, bind) => {
      bind({candidates: rows});
      return {load: async () => {}};
    },
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  if (locale === 'ar') {
    context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(context);
  }
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-allocation.js', 'utf8')).runInContext(context);
  new Script(
    'mountAllocationModel({id:"snapshot",preset:"' +
      preset +
      '",account_id:"100",semantics:{currency:"USD",timezone:"UTC",date_from:"2026-09-29",date_to:"2026-09-30"}})',
  ).runInContext(context);
  for (const row of rows)
    bindings.get('#allocation-candidates [data-allocation-add]')({dataset: {allocationAdd: row.entity_id}});
  return {
    context,
    node,
    bindings,
    events,
    candidateButtons,
    focused: () => focused,
    input: () => input,
    submit: () => bindings.get('#allocation-model')(),
  };
}
const result = () => ({
  total_budget: '200',
  currency: 'USD',
  period: {days: 2},
  modeled_conversions_low: 26,
  modeled_conversions_high: 39,
  allocations: [
    {
      entity_id: '10',
      name: 'Efficient',
      observed_spend: '100',
      minimum: '25',
      maximum: '125',
      proposed_budget: '125',
      binding_constraints: ['cap'],
      modeled_conversions_low: 20,
      modeled_conversions_high: 30,
    },
  ],
  limitations: [],
});

test('LinkedIn guided allocation shows the independent budget qualification, decimal conversion and daily overage in both languages', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(async () => result(), 'linkedin_campaign', locale);
    await f.submit();
    const html = f.node('#allocation-result').innerHTML;
    assert.match(html, /LinkedIn/);
    assert.match(html, /150%/);
    assert.doesNotMatch(html, /Read current Google|Read current Snapchat/);
    assert.match(html, locale === 'ar' ? /ست منازل عشرية بعملة الحساب/ : /six decimal places in account currency/);
    assert.match(
      f.node('#allocation-selection-count').textContent,
      locale === 'ar' ? /20 حملة LinkedIn/ : /2–20 LinkedIn campaigns/,
    );
    assert.equal(f.input().action, 'allocation');
  }
});
test('selected allocation candidates show Added and cannot be added again until removed', () => {
  const f = fixture(async () => result());
  for (const button of f.candidateButtons) {
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'Added');
    assert.equal(button.attributes['aria-label'], 'Added ' + button.dataset.allocationName);
  }
  f.bindings.get('#allocation-selection [data-allocation-remove]')({dataset: {allocationRemove: '10'}});
  assert.equal(f.candidateButtons[0].disabled, false);
  assert.equal(f.candidateButtons[0].textContent, 'Add');
  assert.equal(f.candidateButtons[0].attributes['aria-label'], 'Add Efficient');
  assert.equal(f.candidateButtons[1].disabled, true);
});
test('Snapchat retained report exposes ad-squad allocation and the qualified draft handoff', async () => {
  const f = fixture(async () => result(), 'snapchat_adsquad');
  assert.match(f.node('#report-detail').innerHTML, /Allocate a budget across ad squads/);
  assert.match(f.node('#report-detail').innerHTML, /Minimum observed conversions per ad squad/);
  await f.submit();
  assert.match(f.node('#allocation-result').innerHTML, /Only auction campaigns with ad-squad pacing/);
  assert.ok(f.bindings.has('#allocation-preview-plan'));
});
test('allocation results name the selected native unit in English and Arabic', async () => {
  const twoUnits = () => ({
    ...result(),
    allocations: [result().allocations[0], {...result().allocations[0], entity_id: '20', name: 'Established'}],
  });
  for (const locale of ['en', 'ar']) {
    const f = fixture(async () => twoUnits(), 'snapchat_adsquad', locale);
    await f.submit();
    const html = f.node('#allocation-result').innerHTML;
    if (locale === 'ar') {
      assert.doesNotMatch(f.node('#allocation-selection').innerHTML, /للحملة/);
      assert.doesNotMatch(html, /للحملات الأعلى/);
    }
    assert.match(html, locale === 'en' ? /across 2 ad squads/ : /مجموعات إعلانية/);
    assert.match(
      html,
      locale === 'en' ? /Proposed ad-squad allocation, scroll for all columns/ : /توزيع ميزانية المجموعات الإعلانية/,
    );
    assert.doesNotMatch(html, /across 2 campaigns|Proposed campaign allocation/);
  }
  const campaign = fixture(async () => twoUnits());
  await campaign.submit();
  assert.match(campaign.node('#allocation-result').innerHTML, /across 2 campaigns/);
});
test('allocation UI sends exact selected bounds and removes stale results when inputs change', async () => {
  const f = fixture(async () => result());
  await f.submit();
  assert.equal(f.input().action, 'allocation');
  assert.deepEqual(JSON.parse(JSON.stringify(f.input().options.allocations)), [
    {entity_id: '10', minimum: '25', maximum: '125'},
    {entity_id: '20', minimum: '50', maximum: '175'},
  ]);
  assert.match(f.node('#allocation-result').innerHTML, /125 USD/);
  assert.equal(f.focused(), true);
  f.events.get('#allocation-model:input')();
  assert.doesNotMatch(f.node('#allocation-result').innerHTML, /125 USD/);
  assert.match(f.node('#allocation-result').innerHTML, /Model again/);
});
test('pending allocations cannot repaint after edits, navigation, identity changes or report replacement', async () => {
  for (const change of ['input', 'navigationGeneration', 'identityGeneration', 'detach']) {
    let resolve;
    const f = fixture(
      () =>
        new Promise(r => {
          resolve = r;
        }),
    );
    const pending = f.submit();
    f.node('#allocation-result').innerHTML = 'Current state';
    if (change === 'input') f.events.get('#allocation-model:input')();
    else if (change === 'detach') f.node('#allocation-panel').isConnected = false;
    else f.context[change]++;
    resolve(result());
    await pending;
    assert.equal(f.node('#allocation-result').innerHTML, 'Current state', change);
    assert.equal(f.bindings.has('#allocation-download'), false, change);
  }
});
