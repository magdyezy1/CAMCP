// ACC-01: the zero-spend live write acceptance harness. It must refuse to send anything without every explicit owner
// flag, refuse an account Google does not report as a test account before any change, and on a synthetic Google test
// account run the real reviewed-write loop to verified read-back with a duplicate that writes nothing, recording ledger
// rows that hold references only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Store} from '../dist/src/store.js';
import {
  dryRun,
  liveRefusals,
  runWriteAcceptance,
  testAccountFetch,
  validateAcceptancePlan,
} from '../dist/tools/acceptance/write-acceptance.js';
import {appendRows} from '../tools/acceptance/ledger.mjs';
import {googleAdsFake} from './fixtures/recipe-run-fakes.mjs';

const {
  account_id: _a,
  connection_id: _c,
  ...business
} = JSON.parse(fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8')).recipe_business;
const plan = (patch = {}) => ({
  ticket: 'ACC-01',
  authorization_ref: 'owner-auth-2026-10-20-1',
  provider: 'google',
  recipe: 'google_search',
  account_type: 'test',
  account_label: 'google-test-a',
  account_id: '1234567890',
  login_customer_id: '9876543210',
  business,
  release: {revision: '911bc35', package_sha256: 'a'.repeat(64)},
  ...patch,
});
const planBytes = p => Buffer.from(JSON.stringify(p));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const liveEnv = p => ({
  AMCP_ACCEPTANCE_LIVE: 'true',
  AMCP_ACCEPTANCE_AUTHORIZATION: p.authorization_ref,
  AMCP_ACCEPTANCE_PLAN_SHA256: digest(planBytes(p)),
  AMCP_ACCEPTANCE_RUN_ID: 'acc01-synthetic',
  AMCP_ACCEPTANCE_STORAGE_KEY: Buffer.alloc(32, 7).toString('base64'),
  AMCP_ACCEPTANCE_CREDENTIALS_JSON: '{"accessToken":"synthetic"}',
});
/** The environment without any acceptance flag, so a spawned harness sees none from the caller. */
const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AMCP_ACCEPTANCE_')));

test('the plan names a Google test account by label and refuses real accounts, other providers and IDs as labels', () => {
  assert.deepEqual(validateAcceptancePlan(plan()), []);
  const cases = [
    ['a real account', {account_type: 'real'}, /account_type is test/],
    ['Meta without a test proof', {provider: 'meta', recipe: 'meta_website_traffic'}, /provider is google/],
    ['a recipe of another platform', {recipe: 'meta_website_traffic'}, /belongs to provider meta/],
    ['an account ID as label', {account_label: 'acct-1234567890'}, /never an account ID/],
    ['a dashed account ID', {account_id: '123-456-7890'}, /10-digit/],
    ['no release identity', {release: {revision: 'x'}}, /release is/],
    ['no authorization', {authorization_ref: ''}, /authorization_ref/],
    ['an account inside the business', {business: {...business, account_id: '1'}}, /set by the harness/],
    ['an unknown field', {token: 'x'}, /unknown field token/],
  ];
  for (const [label, patch, pattern] of cases)
    assert.ok(
      validateAcceptancePlan(plan(patch)).some(p => pattern.test(p)),
      label + ': ' + validateAcceptancePlan(plan(patch)).join('; '),
    );
});

test('every live flag is required: the switch, the authorization, the exact plan digest, a run ID, a key, credentials', () => {
  const p = plan(),
    bytes = planBytes(p);
  assert.deepEqual(liveRefusals(liveEnv(p), bytes, p), []);
  assert.equal(liveRefusals({}, bytes, p).length, 6);
  for (const [flag, value, pattern] of [
    ['AMCP_ACCEPTANCE_LIVE', 'yes', /LIVE=true/],
    ['AMCP_ACCEPTANCE_AUTHORIZATION', 'owner-auth-other', /authorization_ref/],
    ['AMCP_ACCEPTANCE_PLAN_SHA256', digest(Buffer.from('another plan')), /does not match/],
    ['AMCP_ACCEPTANCE_RUN_ID', '../escape', /run ID/],
    ['AMCP_ACCEPTANCE_STORAGE_KEY', 'short', /32-byte/],
    ['AMCP_ACCEPTANCE_CREDENTIALS_JSON', '', /CREDENTIALS_JSON/],
  ]) {
    const refusals = liveRefusals({...liveEnv(p), [flag]: value}, bytes, p);
    assert.equal(refusals.length, 1, flag);
    assert.match(refusals[0], pattern, flag);
  }
});

test('the dry run compiles the paused plan locally and the CLI sends nothing without the live flags', t => {
  const dry = dryRun(plan(), ['AMCP_ACCEPTANCE_LIVE=true is not set']);
  assert.equal(dry.status, 'compiled');
  assert.equal(dry.provider_requests, 0);
  assert.equal(dry.paused_parent, true);
  assert.deepEqual(
    dry.steps.map(s => s.action),
    ['google_ads_v23_google_ads_mutate'],
  );
  assert.equal(dry.ready_for_live, false);
  assert.doesNotMatch(JSON.stringify(dry), /1234567890|9876543210/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acc01-')),
    file = path.join(directory, 'plan.json');
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(file, JSON.stringify(plan()));
  const cli = args =>
    spawnSync(process.execPath, ['dist/tools/acceptance/write-acceptance.js', file, ...args], {
      encoding: 'utf8',
      env: cleanEnv(),
      cwd: directory === undefined ? process.cwd() : process.cwd(),
    });
  const before = fs.existsSync('.runtime/acceptance/acc01-synthetic');
  const shown = cli([]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).mode, 'dry_run');
  assert.equal(JSON.parse(shown.stdout).live_refusals.length, 6);
  const refused = cli(['--live']);
  assert.equal(refused.status, 1);
  const out = JSON.parse(refused.stdout);
  assert.equal(out.status, 'refused');
  assert.equal(out.provider_requests, 0);
  assert.equal(out.refusals.length, 6);
  // Refused before any state or credential is touched.
  assert.equal(fs.existsSync('.runtime/acceptance/acc01-synthetic'), before);
});

test('the guard refuses a change before Google reports test status, and any other host, account or removal', async () => {
  const sent = [];
  const fetcher = async (url, init) => {
    sent.push(String(url));
    return Response.json({results: [{customer: {id: '1234567890', testAccount: true}}]});
  };
  const guard = testAccountFetch(fetcher, '1234567890'),
    base = 'https://googleads.googleapis.com/v25/customers/';
  const post = (url, body) => guard.fetch(url, {method: 'POST', body: JSON.stringify(body)});
  await assert.rejects(post(base + '1234567890/googleAds:mutate', {mutateOperations: []}), {
    code: 'ACCEPTANCE_TEST_ACCOUNT_REQUIRED',
  });
  await assert.rejects(post('https://example.com/v25/customers/1234567890/x', {}), {code: 'ACCEPTANCE_ROUTE_REFUSED'});
  await assert.rejects(post(base + '1111111111/googleAds:search', {query: 'x'}), {code: 'ACCEPTANCE_ROUTE_REFUSED'});
  assert.equal(sent.length, 0);
  await post(base + '1234567890/googleAds:search', {query: 'SELECT customer.id, customer.test_account FROM customer'});
  assert.equal(guard.state.test_account, true);
  await post(base + '1234567890/googleAds:mutate', {mutateOperations: []});
  await assert.rejects(
    post(base + '1234567890/campaigns:mutate', {operations: [{remove: 'customers/1/campaigns/2'}]}),
    {
      code: 'ACCEPTANCE_ROUTE_REFUSED',
    },
  );
  await assert.rejects(guard.fetch(base + '1234567890/campaigns/1', {method: 'DELETE'}), {
    code: 'ACCEPTANCE_ROUTE_REFUSED',
  });
  assert.equal(sent.length, 2);
  // Another account's answer, or no test flag, is not test status.
  const other = testAccountFetch(
    async () => Response.json({results: [{customer: {id: '5', testAccount: true}}]}),
    '1234567890',
  );
  await other.fetch(base + '1234567890/googleAds:search', {method: 'POST', body: '{"query":"customer.test_account"}'});
  assert.equal(other.state.test_account, false);
});

function run(t, testAccount) {
  const p = plan(),
    google = googleAdsFake({...business, account_id: p.account_id}, {testAccount}),
    store = new Store(':memory:', Buffer.alloc(32, 7).toString('base64'));
  t.after(() => store.close());
  return {
    google,
    p,
    store,
    record: runWriteAcceptance(p, {
      store,
      credentials: {accessToken: 'synthetic-token'},
      runId: 'acc01-synthetic',
      planSha256: digest(planBytes(p)),
      fetcher: google.fetch,
      now: () => Date.parse('2026-10-20T10:00:00Z'),
    }),
  };
}

test('a synthetic Google test account run verifies the paused build, the duplicate writes nothing, rows reach the ledger', async t => {
  const {google, p, store, record: pending} = run(t, true),
    record = await pending;
  // The run's own policy refuses a budget above the plan's and any deletion; it relaxes nothing.
  const [policy] = store.documents('acceptance-acc01-synthetic', 'spend_policy');
  assert.deepEqual([policy.enforcement, policy.allow_deletion, policy.max_budget_native], ['block', false, 25000000]);
  assert.equal(record.outcome, 'accepted', JSON.stringify(record).slice(0, 2000));
  // Google's test status was read before the one all-or-nothing build was sent, and nothing else was written.
  const first = google.requests.findIndex(r => r.url.endsWith(':mutate'));
  assert.ok(google.requests.slice(0, first).some(r => /customer\.test_account/.test(r.body.query ?? '')));
  assert.equal(google.mutations.length, 1);
  assert.equal(record.provider_mutations, 1);
  assert.deepEqual(record.duplicate.provider_writes, 0);
  assert.equal([...google.resources.values()].find(r => r.kind === 'campaign').value.status, 'PAUSED');
  assert.ok(google.requests.every(r => r.url.startsWith('https://googleads.googleapis.com/v25/customers/1234567890/')));
  assert.ok(record.steps.every(s => s.status === 'verified' && s.executed && /^[0-9a-f]{64}$/.test(s.readback_sha256)));
  assert.match(record.contract_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(record.api_version, 'v25');
  // References only: no account ID, login customer, token or payload in the record.
  assert.doesNotMatch(JSON.stringify(record), /1234567890|9876543210|synthetic-token|running shoes/);
  const added = await appendRows({schema_version: 1, rows: []}, record.ledger_rows);
  assert.deepEqual(added.problems, []);
  assert.deepEqual(
    added.ledger.rows.map(r => [r.gateway, r.action, r.effect, r.account_type, r.scope.account_label]),
    [['google_ads_native_action', 'google_ads_v23_google_ads_mutate', 'mutation', 'test', p.account_label]],
  );
});

test('an account Google does not report as a test account is refused before any change is prepared', async t => {
  for (const testAccount of [false, undefined]) {
    const {google, record: pending} = run(t, testAccount),
      record = await pending;
    assert.equal(record.outcome, 'refused', String(testAccount));
    assert.match(record.reason, /not report this account as a test account/);
    assert.equal(google.mutations.length, 0);
    assert.equal(record.provider_mutations, 0);
    assert.deepEqual(record.ledger_rows, []);
    // Only the test status read reached Google.
    assert.equal(google.requests.length, 1);
  }
});

test('the runbook example plan compiles in the dry run, and an incomplete brief is a plan problem', () => {
  const markdown = fs.readFileSync('docs/acceptance/WRITE-ACCEPTANCE.md', 'utf8'),
    example = JSON.parse(
      markdown
        .split('```json')[1]
        .split('```')[0]
        .replace('REPLACE_WITH_TEST_ACCOUNT_ID', '1234567890')
        .replace('REPLACE_WITH_TEST_MANAGER_ID', '9876543210')
        .replace('REPLACE_WITH_VERSIONZ_REVISION', '911bc35')
        .replace('REPLACE_WITH_PACKAGE_SHA256', 'a'.repeat(64)),
    );
  assert.deepEqual(validateAcceptancePlan(example), []);
  assert.equal(dryRun(example).status, 'compiled');
  const {keywords: _k, ...incomplete} = example.business,
    refused = dryRun({...example, business: incomplete});
  assert.equal(refused.status, 'invalid_plan');
  assert.match(refused.problems[0], /^RECIPE_INPUT_REQUIRED/);
  assert.equal(refused.provider_requests, 0);
});
