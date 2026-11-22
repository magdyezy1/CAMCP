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
