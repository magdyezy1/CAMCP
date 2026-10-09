import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture() {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {checked: false, innerHTML: ''});
    return nodes.get(id);
  };
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
  return {run, nodes, node, bindings, calls, context};
}
test('required review acknowledgements start unchecked and no unrequested spending or cap consent is sent', () => {
  const f = fixture();
  assert.doesNotMatch(
    f.run("readableReview({request:{action:'rename'},execute_requirements:{}}, 'Execute')"),
    /spend-consent|cap-consent|checked/,
  );
  assert.throws(() => f.run('readReviewConsents({})'), /authorize/);
  f.node('#review-consent').checked = true;
  assert.deepEqual(JSON.parse(JSON.stringify(f.run('readReviewConsents({})'))), {confirmed: true});
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
  assert.equal(f.calls[1].confirmed, true);
  assert.equal(f.calls[1].spend_change_confirmed, true);
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
    assert.match(review, locale === 'ar' ? /مشاركة ميزانية المجموعات الإعلانية متوقفة/ : /Ad set budget sharing is off/);
    // The server lists false as a setting and true (Meta may move budget) as a spending field; both are explained.
    const approval = f.run(
      "approvalView({plan_hash:'h', covers:'Exact steps', steps:[{id:'campaign', action:'meta_campaign_create', gateway:'meta_native_action', account_id:'1', status:[{field:'/payload/status', value:'PAUSED'}], settings:[{field:'/payload/is_adset_budget_sharing_enabled', value:false}]}, {id:'shared', action:'meta_campaign_create', gateway:'meta_native_action', account_id:'1', spend:[{field:'/payload/is_adset_budget_sharing_enabled', value:true}]}]})",
    );
    assert.match(approval, /is_adset_budget_sharing_enabled/);
    assert.match(approval, locale === 'ar' ? /مشاركة ميزانية المجموعات الإعلانية متوقفة/ : /Ad set budget sharing is off/);
    assert.match(approval, locale === 'ar' ? /مشاركة ميزانية المجموعات الإعلانية مفعّلة/ : /Ad set budget sharing is on/);
    assert.match(approval, /plan-spend-consent/);
    // A request without the field says nothing about it.
    assert.doesNotMatch(
      f.run("readableReview({request:{body:{name:'C'}}, execute_requirements:{}}, 'Execute')"),
      /budget sharing/i,
    );
  }
});
