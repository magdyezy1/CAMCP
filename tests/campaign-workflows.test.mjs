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
