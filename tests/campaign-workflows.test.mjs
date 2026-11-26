import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture() {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [];
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        checked: false,
        innerHTML: '',
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        removeAttribute(name) {
          delete this.attributes[name];
        },
        focus() {
          focused.push(id);
        },
      });
    return nodes.get(id);
  };
  const focused = [];
  const context = createContext({
    document: {addEventListener() {}},
    $,
    Object,
    Date,
    JSON,
    encodeURIComponent,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    badge: value => String(value),
    date: String,
    blank: String,
    recordDetails: () => '',
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    workspaceCall: async (_tool, input) => {
      calls.push(input);
      return input.confirmed
        ? {state: 'approved'}
        : {
            approval: {
              plan_hash: 'hash-1',
              summary_hash: 'summary-1',
              covers: 'Exact steps',
              steps: [
                {id: 'activate', gateway: 'meta', account_id: '100', status: [{field: '/status', value: 'ACTIVE'}]},
              ],
            },
          };
    },
  });
  function $(id) {
    return node(id);
  }
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(readFileSync('web/campaign-workflows.js', 'utf8'));
  return {run, nodes, node, bindings, calls, context, focused};
}
test('required review acknowledgements start unchecked and no unrequested spending or cap consent is sent', () => {
  const f = fixture();
  assert.doesNotMatch(
    f.run("readableReview({request:{action:'rename'},execute_requirements:{}}, 'Execute')"),
    /spend-consent|cap-consent|checked/,
  );
  // WEB-03 (design review 2026-10): the refusal is said beside the box, which is marked and focused; before, the box's
  // own label ("… authorize its execution") came back as the error, in a toast. This expectation pinned that label.
  assert.throws(
    () => f.run('readReviewConsents({})'),
    error => error.message === 'Tick the authorization above to execute this request.' && error.presented === true,
  );
  assert.equal(f.node('#review-consent').attributes['aria-invalid'], 'true');
  assert.deepEqual(f.focused, ['#review-consent']);
  f.node('#review-consent').checked = true;
  assert.deepEqual(JSON.parse(JSON.stringify(f.run('readReviewConsents({})'))), {confirmed: true});
  assert.equal(f.node('#review-consent').attributes['aria-invalid'], undefined, 'ticking clears the mark');
  for (const [flag, id] of [
    ['spend_change_confirmed', 'spend-consent'],
    ['cap_override_confirmed', 'cap-consent'],
    ['creative_edit_confirmed', 'creative-consent'],
  ]) {
    const source = `({execute_requirements:{${flag}:true}})`;
    assert.match(f.run(`readableReview(${source}, 'Execute')`), new RegExp(id));
    assert.throws(() => f.run(`readReviewConsents(${source})`));
    f.node('#' + id).checked = true;
    assert.equal(f.run(`readReviewConsents(${source}).${flag}`), true);
  }
});
test('a serving-only plan needs explicit spending consent and binds approval to the displayed hash', async () => {
  const f = fixture();
  f.run("bindCampaignWorkflow({id:'plan-1', steps:[]}, async()=>{}, ()=>true)");
  await f.bindings.get('#approve-campaign')();
  assert.match(f.node('#campaign-review').innerHTML, /plan-spend-consent/);
  await assert.rejects(f.bindings.get('#approve-plan')(), /authorize/);
  f.node('#plan-consent').checked = true;
  await assert.rejects(f.bindings.get('#approve-plan')(), /Acknowledge/);
  assert.equal(f.calls.length, 1);
  f.node('#plan-spend-consent').checked = true;
  await f.bindings.get('#approve-plan')();
  assert.equal(f.calls[1].plan_hash, 'hash-1');
  // WRT-05: the approval is bound to the summary shown as well as to the plan.
  assert.equal(f.calls[1].summary_hash, 'summary-1');
  assert.equal(f.calls[1].confirmed, true);
  assert.equal(f.calls[1].spend_change_confirmed, true);
});
test('a truncated plan summary shows aggregates and keeps approval disabled until every full list was opened', async () => {
  const f = fixture();
  const step = {
    id: 'squads',
    gateway: 'snapchat_native_action',
    account_id: 'acct1',
    action: 'snapchat_adsquad_create',
    fields_total: 40,
    truncated: true,
    aggregates: [
      {field: '/payload/adsquads/*/daily_budget_micro', kind: 'spend', count: 20, distinct_count: 2, values: [1, 2]},
      {field: '/payload/adsquads/*/status', kind: 'status', count: 20, distinct_count: 1, values: ['PAUSED']},
    ],
  };
  const listeners = [],
    body = {innerHTML: ''},
    details = {
      open: false,
      dataset: {approvalStep: 'squads'},
      addEventListener: (_event, fn) => listeners.push(fn),
      querySelector: () => body,
    },
    button = {disabled: true, checked: false, innerHTML: ''};
  f.nodes.set('#approve-plan', button);
  f.context.document = {addEventListener() {}, querySelectorAll: () => [details]};
  f.context.uiNumber = String;
  f.context.toast = () => {};
  f.context.errorMessage = e => String(e?.message ?? e);
  f.context.workspaceCall = async (_tool, input) => {
    f.calls.push(input);
    if (input.step_id)
      return {
        summary_hash: 'summary-2',
        fields: Array.from({length: 40}, (_, i) => ({field: '/payload/adsquads/' + (i >> 1), value: i})),
      };
    return input.confirmed
      ? {state: 'approved'}
      : {approval: {plan_hash: 'hash-2', summary_hash: 'summary-2', covers: 'Exact', steps: [step]}};
  };
  f.run("bindCampaignWorkflow({id:'plan-2', steps:[]}, async()=>{}, ()=>true)");
  await f.bindings.get('#approve-campaign')();
  const html = f.node('#campaign-review').innerHTML;
  assert.match(html, /daily_budget_micro/);
  assert.match(html, /Show all 40 fields/);
  assert.match(html, /id="approve-plan"[^>]* disabled/);
  f.node('#plan-consent').checked = true;
  f.node('#plan-spend-consent').checked = true;
  await assert.rejects(f.bindings.get('#approve-plan')(), /Show all fields/);
  assert.equal(f.calls.length, 1, 'nothing approved while the full list is unopened');
  details.open = true;
  await listeners[0]();
  assert.equal(f.calls[1].step_id, 'squads');
  assert.equal(button.disabled, false);
  assert.match(body.innerHTML, /\/payload\/adsquads\/19/);
  await f.bindings.get('#approve-plan')();
  assert.equal(f.calls[2].summary_hash, 'summary-2');
  assert.equal(f.calls[2].confirmed, true);
});
// R2.5 package r25-approval-fields (the owner's friction report of 2026-11-25, B2): the approval page shows what each step changes, with the strings it
// already has ("Target:", "Field / native unit", "Value", "Show all {count} fields", "(+{count} more)"): nothing new to translate.
test('the plan approval page shows the rows of each step: the object, its id, the field, and the value, money in the account currency', () => {
  const f = fixture();
  f.context.uiNumber = String;
  const page =
    f.run(`approvalView({plan_hash:'h', covers:'Exact steps', spend_steps:[], accounts:[{gateway:'meta_native_action', account_id:'111', name:'Acme', currency:'USD', timezone:'Asia/Riyadh'}], steps:[
    {id:'budget', action:'meta_ad_set_id_update', gateway:'meta_native_action', account_id:'111', spend_effect:true, spend:[{field:'/payload/daily_budget', value:'456050'}], changes:[
      {object:'ad set', id:'1202100000001', field:'daily_budget', new:'456050', shown:'4560.50 USD'},
      {object:'ad set "Spring <b>"', id:'1202100000001', field:'end_time', old:'2026-11-30T23:59:00+0300', new:'2026-12-06T23:59:00+0300'}]},
    {id:'pause', action:'tiktok_adgroup_status_update', gateway:'tiktok_native_action', account_id:'7', changes:[
      {object:'ad group', ids:['1','2'], count:20, field:'operation_status', new:'DISABLE'}]}]})`);
  const item = id => page.split('<li>').find(s => s.includes('<strong>' + id + ' '));
  assert.match(
    item('budget'),
    /<th scope="col">Target:<\/th><th scope="col">Field \/ native unit<\/th><th scope="col">Value<\/th>/,
  );
  assert.match(item('budget'), /<bdi dir="auto">ad set<\/bdi> <code dir="ltr">1202100000001<\/code>/);
  assert.match(
    item('budget'),
    /<code dir="ltr">daily_budget<\/code><\/td><td dir="auto"><strong dir="ltr">4560\.50 USD<\/strong> <small dir="ltr">\(456050\)<\/small>/,
  );
  assert.match(item('budget'), /2026-11-30T23:59:00\+0300 → 2026-12-06T23:59:00\+0300/);
  assert.ok(item('budget').includes('Spring &lt;b>'), 'a name is escaped');
  assert.ok(
    item('budget').includes('Acme') && item('budget').includes('USD') && item('budget').includes('Asia/Riyadh'),
    'the account the step writes to',
  );
  assert.match(item('pause'), /<code dir="ltr">1, 2<\/code> \(\+18 more\)/);
  assert.ok(
    !item('pause').includes('No values supplied'),
    'a step that changes something is not shown as supplying nothing',
  );
  assert.ok(
    !page.includes('approval-all-fields') && !page.includes(' disabled'),
    'every row is listed: nothing to open',
  );
  // A plan the server gave no rows keeps the page it had.
  const old = f.run(
    "approvalView({plan_hash:'h', covers:'Exact steps', steps:[{id:'a', action:'x', gateway:'g', account_id:'1', status:[{field:'/status', value:'PAUSED'}]}]})",
  );
  assert.ok(!old.includes('Target:') && old.includes('Budget, bid and status fields'));
});
test('the summary line of a single review shows the rows of what it changes, with the name and the old value the review read', () => {
  const f = fixture();
  f.context.uiNumber = String;
  const line =
    f.run(`reviewSummaryLine({operation:'update', entity:'ad set', count:1, account:{id:'111', name:'Acme'}, changes:[
    {object:'ad set "Spring promo"', id:'456', field:'daily_budget', old:'400000', new:'456050', shown:'4000.00 → 4560.50 USD'},
    {object:'ad set "Spring promo"', id:'456', field:'end_time', old:'2026-11-30T23:59:00+0300', new:'2026-12-06T23:59:00+0300'}]})`);
  assert.match(line, /<bdi dir="auto">ad set &quot;Spring promo&quot;<\/bdi> <code dir="ltr">456<\/code>/);
  assert.match(
    line,
    /<strong dir="ltr">4000\.00 → 4560\.50 USD<\/strong> <small dir="ltr">\(400000 → 456050\)<\/small>/,
  );
  assert.match(line, /2026-11-30T23:59:00\+0300 → 2026-12-06T23:59:00\+0300/);
  assert.match(line, /A summary only: the exact native request below is what is sent/);
  // A summary without rows is the line it was.
  const old = f.run("reviewSummaryLine({operation:'update', entity:'ad set', count:1, account:{id:'111'}})");
  assert.ok(!old.includes('<table'));
});
test('a group is shown as the steps it is: each step with its own id and the change it shares', () => {
  const f = fixture();
  f.context.uiNumber = String;
  const ids = ['101', '102', '103', '104'],
    step = id =>
      `{id:'${id}', action:'meta_ad_set_id_update', gateway:'meta_native_action', account_id:'111', group:'g1', fields_total:0}`;
  const page = f.run(
    `approvalView({plan_hash:'h', covers:'Exact steps', groups:[{group:'g1', count:4, object:'ad set', ids:${JSON.stringify(ids)}, changes:[{field:'end_time', new:'2026-12-06T23:59:00+0300'}]}], steps:[${ids.map(id => step(id)).join(',')}]})`,
  );
  ids.forEach(id => {
    const item = page.split('<li>').find(s => s.includes('<strong>' + id + ' '));
    assert.match(item, new RegExp('<code dir="ltr">' + id + '</code>'), id);
    assert.ok(item.includes('2026-12-06T23:59:00+0300'), id);
  });
});
test('a step whose rows were cut says where they are, keeps approval locked until they are opened, and lists them then', async () => {
  const f = fixture();
  const step = {
    id: 'wide',
    gateway: 'meta_native_action',
    account_id: '111',
    action: 'meta_ad_set_id_update',
    fields_total: 0,
    changes_total: 12,
    truncated: true,
    all_fields: {tool: 'amcp_campaign', arguments: {action: 'approval_summary', id: 'plan-3', step_id: 'wide'}},
  };
  const listeners = [],
    body = {innerHTML: ''},
    details = {
      open: false,
      dataset: {approvalStep: 'wide'},
      addEventListener: (_event, fn) => listeners.push(fn),
      querySelector: () => body,
    },
    button = {disabled: true, checked: false, innerHTML: ''};
  f.nodes.set('#approve-plan', button);
  f.context.document = {addEventListener() {}, querySelectorAll: () => [details]};
  f.context.uiNumber = String;
  f.context.toast = () => {};
  f.context.errorMessage = e => String(e?.message ?? e);
  f.context.workspaceCall = async (_tool, input) => {
    f.calls.push(input);
    if (input.step_id)
      return {
        summary_hash: 'summary-3',
        fields: [],
        changes_total: 12,
        changes: Array.from({length: 12}, (_, i) => ({object: 'ad set', id: '456', field: 'field_' + i, new: 'v' + i})),
      };
    return {approval: {plan_hash: 'hash-3', summary_hash: 'summary-3', covers: 'Exact', steps: [step]}};
  };
  f.run("bindCampaignWorkflow({id:'plan-3', steps:[]}, async()=>{}, ()=>true)");
  await f.bindings.get('#approve-campaign')();
  const html = f.node('#campaign-review').innerHTML;
  assert.match(html, /Show all 12 fields/);
  assert.match(html, /id="approve-plan"[^>]* disabled/);
  details.open = true;
  await listeners[0]();
  assert.equal(button.disabled, false);
  assert.match(body.innerHTML, /field_11/);
  assert.ok(!body.innerHTML.includes('<table class="review-table"><caption>Every budget'), 'no empty list of fields');
});
// The review of 2026-11-26 (S2-1): a step lists the rows the summary holds of it and says how many more it has (`changes_total`), with its own list a click away;
// approval stays locked until that list is opened, as it is for a step that was cut. A step that lists a value cut to fit, or that was cut to its own list, is the same.
const listRows = n =>
  Array.from({length: n}, (_, i) => ({object: 'ad set', id: '456', field: 'field_' + i, new: 'v' + i}));
const cutName = {object: 'campaign', id: '9', field: 'name', new: 'N'.repeat(79) + '…', clipped: true};
const wideName = {object: 'campaign', id: '9', field: 'name', new: 'N'.repeat(120)};
const idList = n => Array.from({length: n}, (_, i) => String(i + 1));
const stepOf = more => ({
  id: 'wide',
  action: 'meta_ad_set_id_update',
  gateway: 'meta_native_action',
  account_id: '111',
  fields_total: 0,
  ...more,
});
/** The plan approval page as the runner's own button shows it, with the lists it offers; `own` is what the server answers to the step_id read of each step. */
async function approvalPageOf(approval, own = {}) {
  const f = fixture(),
    button = {disabled: true, checked: false, innerHTML: ''},
    lists = new Map();
  f.nodes.set('#approve-plan', button);
  f.context.document = {
    addEventListener() {},
    querySelectorAll: () =>
      [...f.node('#campaign-review').innerHTML.matchAll(/data-approval-step="([^"]+)"/g)].map(([, id]) => {
        if (!lists.has(id)) {
          const body = {innerHTML: ''},
            list = {
              open: false,
              body,
              listeners: [],
              dataset: {approvalStep: id},
              addEventListener: (_event, fn) => list.listeners.push(fn),
              querySelector: () => body,
            };
          lists.set(id, list);
        }
        return lists.get(id);
      }),
  };
  Object.assign(f.context, {uiNumber: String, toast() {}, errorMessage: e => String(e?.message ?? e)});
  f.context.workspaceCall = async (_tool, input) => {
    f.calls.push(input);
    return input.step_id
      ? {summary_hash: 'summary-4', fields: [], ...own[input.step_id]}
      : {approval: {plan_hash: 'hash-4', summary_hash: 'summary-4', covers: 'Exact', ...approval}};
  };
  f.run("bindCampaignWorkflow({id:'plan-4', steps:[]}, async()=>{}, ()=>true)");
  await f.bindings.get('#approve-campaign')();
  const html = f.node('#campaign-review').innerHTML;
  return {
    f,
    html,
    button,
    lists,
    locked: /id="approve-plan"[^>]* disabled/.test(html),
    counts: [...html.matchAll(/\(\+(\d+) more\)/g)].map(m => m[1]),
  };
}
const openList = async list => {
  list.open = true;
  await list.listeners[0]();
};
for (const [name, more, own, label, counts, last] of [
  [
    '14 rows, 12 of them listed',
    {changes: listRows(12), changes_total: 14, changes_digest: 'd'},
    {changes_total: 14, changes: listRows(14)},
    'Show all 14 fields',
    ['2'],
    'v13',
  ],
  [
    '6 rows of a create, 4 of them listed',
    {changes: listRows(4), changes_total: 6, changes_digest: 'd'},
    {changes_total: 6, changes: listRows(6)},
    'Show all 6 fields',
    ['2'],
    'v5',
  ],
  [
    '6 rows, none listed',
    {changes_total: 6, changes_digest: 'd'},
    {changes_total: 6, changes: listRows(6)},
    'Show all 6 fields',
    [],
    'v5',
  ],
  [
    'a value cut to fit',
    {changes: [cutName], changes_total: 1, changes_digest: 'd'},
    {changes_total: 1, changes: [wideName]},
    'Show all 1 fields',
    [],
    wideName.new,
  ],
  [
    'cut to its one row',
    {truncated: true, aggregates: []},
    {changes_total: 1, changes: listRows(1)},
    'Show all 1 fields',
    [],
    'v0',
  ],
  [
    'cut to its 30 rows',
    {truncated: true, aggregates: [], changes_total: 30},
    {changes_total: 30, changes: listRows(30)},
    'Show all 30 fields',
    [],
    'v29',
  ],
  [
    'the ids of a row cut',
    {
      changes: [{object: 'ad group', ids: idList(12), count: 20, field: 'operation_status', new: 'DISABLE'}],
      changes_total: 20,
      changes_digest: 'd',
    },
    {
      changes_total: 20,
      changes: [{object: 'ad group', ids: idList(20), count: 20, field: 'operation_status', new: 'DISABLE'}],
    },
    'Show all 20 fields',
    ['8'],
    '19, 20',
  ],
]) {
  test(
    'a step that holds more than the page lists (' +
      name +
      ') says so, keeps approval locked and lists all of it when it is opened',
    async () => {
      const page = await approvalPageOf({steps: [stepOf(more)]}, {wide: own});
      assert.ok(page.html.includes(label), label);
      assert.deepEqual(page.counts, counts, 'how many more rows there are, said only where some rows are listed');
      assert.ok(
        page.locked && page.html.includes('approval-fields-note'),
        'approval is locked until the list is opened',
      );
      assert.ok(
        !page.html.includes('No values supplied') && !page.html.includes('summarized by field'),
        'no empty table',
      );
      const list = page.lists.get('wide');
      assert.ok(list, 'the step has a list to open');
      await openList(list);
      assert.equal(page.button.disabled, false);
      assert.equal(page.f.calls.filter(c => c.step_id).length, 1);
      assert.ok(list.body.innerHTML.includes(last), 'the whole list of the step is shown');
    },
  );
}
test('a step that lists every row it has is not locked and offers no list to open', async () => {
  const page = await approvalPageOf({steps: [stepOf({changes: listRows(12)})]});
  assert.equal(page.locked, false);
  assert.ok(!page.html.includes('approval-all-fields') && !page.counts.length);
});
test('a group that lists a value cut to fit gives each of its steps the list to open, and approval waits for every one', async () => {
  const ids = ['101', '102', '103', '104'],
    page = await approvalPageOf(
      {
        groups: [
          {
            group: 'g1',
            count: 4,
            object: 'ad set',
            ids,
            changes: [{field: 'name', new: cutName.new, clipped: true}],
            changes_digest: 'd',
          },
        ],
        steps: ids.map(id => stepOf({id, group: 'g1'})),
      },
      Object.fromEntries(
        ids.map(id => [id, {changes_total: 1, changes: [{object: 'ad set', id, field: 'name', new: wideName.new}]}]),
      ),
    );
  assert.ok(page.locked);
  assert.equal(page.lists.size, 4);
  for (const [i, list] of [...page.lists.values()].entries()) {
    await openList(list);
    assert.equal(page.button.disabled, i < 3, 'unlocked by the last list');
    assert.ok(list.body.innerHTML.includes(wideName.new));
  }
});
test('observed comparison displays the server diff with native units and escapes provider content', () => {
  const f = fixture();
  const html = f.run(
    `verificationComparison({checks:[{status:'mismatch', diff:[{field:'budget_micros', expected:1000000, actual:2000000}, {field:'name', expected:'safe', actual:'<img src=x>'}]}]})`,
  );
  for (const value of ['budget_micros', '1000000', '2000000', '&lt;img']) assert.ok(html.includes(value));
  assert.ok(!html.includes('<img'));
});
test('review summaries bound large requests and amendment fields retain dependency references', () => {
  const f = fixture();
  f.context.payload = Array.from({length: 300}, (_, i) => ({name: String(i)}));
  assert.equal(f.run('reviewFields(payload).length'), 160);
  assert.match(f.run("reviewTable(payload, 'Request')"), /limited to 160/);
  assert.equal(f.run("reviewFields({campaign:{$ref:'first#/id'}})[0].reference"), true);
});
// CMP-01: the native review and the plan approval say what Meta's budget-sharing choice means, in both languages,
// while the native field and value stay literal.
test('Meta budget-sharing choices are explained in the native review and the plan approval in English and Arabic', () => {
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  for (const locale of ['en', 'ar']) {
    const f = fixture();
    f.context.catalog = locale === 'ar' ? catalog : {};
    f.run('uiMessages = new Map(Object.entries(catalog))');
    const review = f.run(
      "readableReview({request:{method:'POST', path:'/v26.0/act_1/campaigns', body:{name:'C', status:'PAUSED', is_adset_budget_sharing_enabled:false}}, execute_requirements:{}}, 'Execute')",
    );
    assert.match(review, /is_adset_budget_sharing_enabled: false/);
    assert.match(
      review,
      locale === 'ar' ? /مشاركة ميزانية المجموعات الإعلانية متوقفة/ : /Ad set budget sharing is off/,
    );
    // The server lists false as a setting and true (Meta may move budget) as a spending field; both are explained.
    const approval = f.run(
      "approvalView({plan_hash:'h', covers:'Exact steps', steps:[{id:'campaign', action:'meta_campaign_create', gateway:'meta_native_action', account_id:'1', status:[{field:'/payload/status', value:'PAUSED'}], settings:[{field:'/payload/is_adset_budget_sharing_enabled', value:false}]}, {id:'shared', action:'meta_campaign_create', gateway:'meta_native_action', account_id:'1', spend:[{field:'/payload/is_adset_budget_sharing_enabled', value:true}]}]})",
    );
    assert.match(approval, /is_adset_budget_sharing_enabled/);
    assert.match(
      approval,
      locale === 'ar' ? /مشاركة ميزانية المجموعات الإعلانية متوقفة/ : /Ad set budget sharing is off/,
    );
    assert.match(
      approval,
      locale === 'ar' ? /مشاركة ميزانية المجموعات الإعلانية مفعّلة/ : /Ad set budget sharing is on/,
    );
    assert.match(approval, /plan-spend-consent/);
    // A request without the field says nothing about it.
    assert.doesNotMatch(
      f.run("readableReview({request:{body:{name:'C'}}, execute_requirements:{}}, 'Execute')"),
      /budget sharing/i,
    );
  }
});
// r25-approval-effects (lead review of the field3 merge, S2-1): the approval page shows a step that deletes, and a step the check could not
// judge, with the badges it already has (an existing string each, with its Arabic): nothing new to translate, nothing new to ship.
// This is a coverage guard, not a red-first test: it passes at 47f04276 too, because the page already rendered these badges for an effect it was given.
test('the plan approval page shows a deleting step with its effect badges, in English and Arabic', () => {
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  const labels = ['Effects that need attention:', 'Deletes or removes', 'Cannot be undone'];
  for (const locale of ['en', 'ar']) {
    const f = fixture();
    f.context.catalog = locale === 'ar' ? catalog : {};
    f.run('uiMessages = new Map(Object.entries(catalog))');
    const say = label => (locale === 'ar' ? catalog[label] : label);
    const step = (id, extra) =>
      `{id:'${id}', action:'tiktok_campaign_status_update', gateway:'tiktok_native_action', account_id:'1', ${extra}}`;
    const page = f.run(
      `approvalView({plan_hash:'h', covers:'Exact steps', steps:[${step('pause', "status:[{field:'/payload/operation_status', value:'DISABLE'}]")}, ${step('remove', "status:[{field:'/payload/operation_status', value:'DELETE'}], effects:{destructive:true, irreversible:true}")}, ${step('odd', 'effects:{destructive:true, irreversible:true, checked:false}')}]})`,
    );
    const item = id => page.split('<li>').find(s => s.includes('<strong>' + id + ' '));
    for (const label of labels) {
      assert.ok(say(label), 'the catalogue has ' + label);
      assert.ok(item('remove').includes(say(label)), locale + ' remove shows ' + label);
      assert.ok(item('odd').includes(say(label)), locale + ' an unchecked step shows ' + label);
      assert.ok(!item('pause').includes(say(label)), locale + ' pause shows none of ' + label);
    }
    assert.ok(item('remove').includes('operation_status') && item('remove').includes('DELETE'));
    assert.ok(item('pause').includes('DISABLE'));
  }
});
// r25-approval-effects fix round (the lead's review S3-1): the spending tick is asked for what the server offers. A summary that names the
// spend effects (`spend_steps`) says which steps spend, so a status row alone (TikTok's operation_status DISABLE or DELETE) is no spending; a
// summary without them (an older one) keeps the old reading, where any status row counts.
test('the plan approval asks for the spending tick only where the server names a spending step, or names none and a status is set', () => {
  const f = fixture(),
    row = "status:[{field:'/payload/operation_status', value:'DISABLE'}]";
  const spending = summary => f.run(`approvalSpending(${summary})`);
  assert.equal(spending(`{spend_steps:[], steps:[{id:'a', ${row}, spend_effect:false}]}`), false);
  assert.equal(spending(`{spend_steps:['a'], steps:[{id:'a', ${row}, spend_effect:true}]}`), true);
  assert.equal(spending(`{steps:[{id:'a', ${row}}]}`), true);
  assert.equal(
    spending(`{spend_steps:[], steps:[{id:'a', spend:[{field:'/payload/budget', value:'5'}], spend_effect:false}]}`),
    true,
  );
  const page = f.run(
    `approvalView({plan_hash:'h', covers:'Exact steps', spend_steps:[], steps:[{id:'pause', action:'tiktok_campaign_status_update', gateway:'tiktok_native_action', account_id:'1', ${row}, spend_effect:false}]})`,
  );
  assert.doesNotMatch(page, /plan-spend-consent/);
});
// r25-field3-merge, the part-2 review's S3-1: the tick follows the server for an aggregated step too. A step with more status fields than the summary lists (a write
// group whose records each set a status, or any step of more than 24 fields) is aggregated by the server, and an aggregate of `status` is no spending: only an aggregate of
// money is, or a step the server names in `spend_steps`. A summary without `spend_steps` (an older one) keeps its old reading, where any aggregate counts.
test('an aggregated step asks for the spending tick only where an aggregate holds money or the server names the step, and an older summary keeps its reading', () => {
  const f = fixture(),
    spending = summary => f.run(`approvalSpending(${summary})`),
    aggregate = (kind, field) => `{field:'${field}', kind:'${kind}', count:30, distinct_count:1, values:['x']}`,
    status = aggregate('status', '/payload/operations/*/update/status'),
    money = aggregate('spend', '/payload/operations/*/update/amount_micros');
  // 30 status fields, aggregated, on a plan the server says holds no spending step: nothing to tick for.
  assert.equal(
    spending(
      `{spend_steps:[], steps:[{id:'a', fields_total:30, truncated:true, aggregates:[${status}], spend_effect:false}]}`,
    ),
    false,
  );
  // An aggregate of money is spending, whatever the server names, and a step the server names is spending whatever it aggregates.
  assert.equal(
    spending(
      `{spend_steps:[], steps:[{id:'a', fields_total:60, truncated:true, aggregates:[${money}, ${status}], spend_effect:false}]}`,
    ),
    true,
  );
  assert.equal(
    spending(
      `{spend_steps:['a'], steps:[{id:'a', fields_total:30, truncated:true, aggregates:[${status}], spend_effect:true}]}`,
    ),
    true,
  );
  // An older summary names no spending steps, and keeps the reading it always had: an aggregate counts.
  assert.equal(spending(`{steps:[{id:'a', fields_total:30, truncated:true, aggregates:[${status}]}]}`), true);
  // The page offers no tick for the aggregated status-only step, and still lists its aggregates behind "Show all fields", which approval waits for.
  f.context.uiNumber = String;
  const page = f.run(
    `approvalView({plan_hash:'h', covers:'Exact steps', spend_steps:[], steps:[{id:'pause', action:'google_ads_v23_campaign_mutate_campaigns', gateway:'google_ads_native_action', account_id:'1', fields_total:30, truncated:true, aggregates:[${status}], spend_effect:false}]})`,
  );
  assert.doesNotMatch(page, /plan-spend-consent/);
  assert.match(page, /Show all 30 fields/);
  assert.match(page, /disabled aria-describedby="approval-fields-note"/);
}); // CMP-02 (b): the clone form sent no key, so a resubmission after a lost response saved a second draft of the source.
test('the clone form sends one creation key per exact clone request, reused only for a retry', async () => {
  const f = fixture();
  let keys = 0,
    lose = true;
  const sent = [],
    opened = [];
  Object.assign(f.context, {
    platforms: [
      {
        gateway: 'snapchat_native_action',
        connections: [{id: 'login', enabled: true, accounts: ['acct1'], writeAccounts: ['acct1']}],
      },
    ],
    accountLabel: () => 'Synthetic Snapchat',
    controls: () => '',
    toast() {},
    crypto: {randomUUID: () => 'synthetic-clone-key-' + ++keys},
    workspaceCall: async (_tool, input) => {
      sent.push(input);
      if (lose) throw Error('Synthetic lost response');
      return {id: 'cloned-plan'};
    },
  });
  f.context.clonedPlans = opened;
  f.run('mountCampaignClone(async id => clonedPlans.push(id))');
  const form = {
    dataset: {},
    elements: {target: {value: '0'}, source: {value: ' src-camp '}, name: {value: 'Spring copy'}},
  };
  const submit = () => f.bindings.get('#clone-form')(form);
  await assert.rejects(submit(), /lost response/);
  lose = false;
  await submit();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].idempotency_key, sent[1].idempotency_key, 'the retry names the same draft');
  assert.match(sent[0].idempotency_key, /^[a-zA-Z0-9_-]{8,100}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1].source)), {campaign_id: 'src-camp'});
  assert.deepEqual(opened, ['cloned-plan']);
  await submit();
  assert.notEqual(sent[2].idempotency_key, sent[0].idempotency_key, 'after a save, another clone gets its own key');
  form.elements.name.value = 'Autumn copy';
  await submit();
  assert.notEqual(sent[3].idempotency_key, sent[2].idempotency_key, 'a changed request gets its own key');
  // An older clone answering late does not retire the key of a newer request that is still unsaved.
  let release;
  f.context.workspaceCall = async (_tool, input) => {
    sent.push(input);
    if (input.name === 'Autumn copy') return new Promise(resolve => (release = () => resolve({id: 'older-plan'})));
    throw Error('Synthetic lost response');
  };
  const older = submit();
  form.elements.name.value = 'Winter copy';
  await assert.rejects(submit(), /lost response/);
  release();
  await older;
  await assert.rejects(submit(), /lost response/);
  assert.equal(sent[6].idempotency_key, sent[5].idempotency_key, 'the newer request is retried under its own key');
  assert.notEqual(sent[5].idempotency_key, sent[4].idempotency_key);
});
