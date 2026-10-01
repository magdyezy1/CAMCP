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
