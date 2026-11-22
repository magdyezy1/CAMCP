import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {googleResponder, googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {adminAddress, site} from '../dist/tests/helpers/admin-email-site.js';
import {CampaignRunner, setPlanReadLagWaits} from '../dist/src/campaign-runner.js';
import {
  failure as googleFailure,
  on as providerCheckOn,
  planStep as signalsStep,
  rejecting,
  signals,
  world as signalsWorld,
} from './helpers/google-policy-failure.mjs';
import {planViewBudget} from '../dist/src/campaign-view.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {providerRefusal} from '../dist/src/provider-error-taxonomy.js';
import {secretSpellings} from '../dist/src/secret-fields.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {campaignRecipes} from '../dist/src/campaign-recipes.js';
import {smartPlusWebAccount, smartPlusWebAdvertiser, smartPlusWebBriefs} from './fixtures/tiktok-smart-plus-web.mjs';
import {
  actor as pushActor,
  account as pushAccount,
  endCards,
  gateway as tiktokGateway,
  key as pushKey,
  owner as pushOwner,
  post as pushPost,
  pushFixture,
  pushWorld,
  TIKTOK,
} from './fixtures/tiktok-smart-plus-push.mjs';

/**
 * R2.5 field3 merge (package r25-field3-merge): the joins of the eight field3 packages, each of them tested over the merged tree. Each block names the
 * joint of the brief (impl/r25-field3-merge.md, "The joins") and the packages it joins. A package's own suite proves the package; this file proves
 * what only the merge can: two packages that each pass alone and must still say the same thing together. Nothing here reaches a provider: every
 * account is a package's synthetic fixture behind the real service (the one test that starts the website refuses every request that is not to its
 * own listener or to the synthetic Google), and every ID in it is invented. J-H, the clock probe, is a run of the suites with the deprecation clock
 * at 2027-01-02, not a test of this file.
 */

// ---- J-A: livefix's read retry x errors' provider check ---------------------------------------------------------------------------------------------
// A step that references an object an earlier step of its plan created is prepared again, after a short wait, when the provider's read does not show that
// object yet (livefix, item 6). A step whose prepare the provider rejected when it validated it is stopped at once, unsent (errors, M5-a). The two share
// one prepare: the retry must never repeat a rejected review, a retry that ends in a rejection must say the rejection and not the read delay, and a read
// delay that outlasts the waits must not name a correction, because nothing in the step's arguments is wrong. Nothing but the plan's first step is ever
// written; a prepare sends only reads and, once the targets are read, one validate-only request.
const googleTenant = 'google-world';
// The waits of the retry are the engine's seam (`setPlanReadLagWaits`): two of 1 ms for every test of this file, and the engine's own again at its end.
const engineWaits = setPlanReadLagWaits([1, 1]);
after(() => setPlanReadLagWaits(engineWaits));
const budgetRef = (id, i = 0) => ({$ref: id + '#/data/results/' + i + '/resourceName'});
const googleStep = (id, action, depends_on, operations) => ({
  id,
  kind: 'write',
  depends_on,
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: {action: 'google_ads_v23_' + action, payload: {operations}},
});
/** The plan of J-A: it creates two budgets, and a second step renames them by the two references. */
const budgetPlan = () => [
  googleStep(
    'budgets',
    'campaign_budget_mutate_campaign_budgets',
    [],
    ['one', 'two'].map(n => ({
      create: {
        name: 'DNU budget ' + n,
        amount_micros: '40000000',
        delivery_method: 'STANDARD',
        explicitly_shared: false,
      },
    })),
  ),
  googleStep(
    'rename',
    'campaign_budget_mutate_campaign_budgets',
    ['budgets'],
    ['one', 'two'].map((n, i) => ({
      update: {resource_name: budgetRef('budgets', i), name: 'DNU budget ' + n + ', renamed'},
      update_mask: 'name',
    })),
  ),
];
/** What Google answers a validate-only rename with when the budget's new name is taken (GoogleAdsFailure, the v25 names of the pinned schema). */
const budgetNameTaken = name => ({
  error: {
    code: 400,
    message: 'Request contains an invalid argument.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
        errors: [
          {
            errorCode: {campaignBudgetError: 'DUPLICATE_NAME'},
            message: 'A budget with this name exists.',
            trigger: {stringValue: name},
            location: {
              fieldPathElements: [{fieldName: 'operations', index: 0}, {fieldName: 'update'}, {fieldName: 'name'}],
            },
          },
        ],
        requestId: 'synthetic-google-request',
      },
    ],
  },
});
const renameRead = /^SELECT campaign_budget\.resource_name, campaign_budget\.name FROM campaign_budget WHERE/;
/**
 * The synthetic customer, whose validate-only check passes the creates and rejects every rename, and whose read has not caught up with the budgets:
 * the state read of the renaming step misses the first budget `lag` times (the provider shows one of the two it was asked for).
 */
function budgetWorld(lag) {
  const x = googleWorld({
    world: {campaigns: {}, adGroups: {}, assetGroups: {}},
    policy: {providerCheckByDefault: true},
    validation: 'custom',
  });
  x.hooks.validationReply = body => {
    const update = body.operations?.[0]?.update;
    return update ? budgetNameTaken(update.name) : undefined;
  };
  const get = x.created.get.bind(x.created),
    misses = {n: 0};
  x.created.get = name => {
    const query = String(x.log.findLast(row => row.kind === 'read')?.body?.query ?? '');
    if (misses.n < lag && renameRead.test(query) && name === [...x.created.keys()][0]) {
      misses.n++;
      return undefined;
    }
    return get(name);
  };
  return {x, misses, stateReads: () => x.queries().filter(q => renameRead.test(q)).length};
}
/** The approval of a plan: the summary, then the call that records it with the flags it offers (the person approving). */
async function approve(x, id) {
  const summary = (await x.call('amcp_campaign', {action: 'approve', id})).data,
    approved = await x.call('amcp_campaign', {
      ...summary.next_call.arguments,
      ...(summary.next_call.add_after_user_approval ?? {}),
    });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
}
const createdPlan = async (x, steps) => {
  const created = await x.call('amcp_campaign', {action: 'create', name: 'DNU launch', brief: 'Synthetic.', steps});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  return created.data.id;
};
const stepOf = async (x, id, stepId) =>
  (await x.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data.steps.find(s => s.id === stepId);
/** An approved budget plan run once, on a customer whose read lags `lag` times, with the 1 ms waits between prepares that this file sets (the engine's seam). */
async function budgetRun(t, lag) {
  const w = budgetWorld(lag);
  t.after(() => w.x.store.close());
  const id = await createdPlan(w.x, budgetPlan());
  await approve(w.x, id);
  const out = await w.x.call('amcp_campaign', {action: 'run', id});
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
  return {...w, id, out: out.data, rename: await stepOf(w.x, id, 'rename')};
}

test('J-A: a step the provider rejected when it validated it is never prepared again by the read retry: one validate-only request, no read delay on it, nothing but the budgets written', async t => {
  const a = await budgetRun(t, 0);
  assert.equal(a.out.run.stopped, 'needs_attention');
  assert.deepEqual(a.out.run.executed, ['budgets']);
  assert.equal(a.rename.status, 'failed');
  assert.equal(a.rename.error.code, 'PROVIDER_VALIDATION_FAILED');
  assert.equal(a.rename.error.details.read_delay, undefined, 'a rejection is no read delay');
  assert.deepEqual(a.rename.error.details.provider_errors, [
    {
      code: 'CAMPAIGN_BUDGET_ERROR',
      enum: 'DUPLICATE_NAME',
      operation_index: 0,
      field_path: 'operations[0].update.name',
      trigger: 'DNU budget one, renamed',
    },
  ]);
  assert.equal(
    a.x.validations(),
    2,
    'one validate-only request for each step: the rejected review was not prepared again',
  );
  assert.equal(a.stateReads(), 1, 'the two budgets were read once for the step');
  assert.equal(a.x.writes(), 1, 'the budgets are the only write: the rejected step sent nothing');
  assert.equal(a.out.next_call.arguments.action, 'recover_step');
  assert.equal(a.out.next_call.kind, 'correction', 'a rejection names its correction: the arguments are what is wrong');
});

test('J-A: a read that misses a budget of the plan is read again after a wait, and when the retried prepare is rejected the answer is the rejection, validated once', async t => {
  const a = await budgetRun(t, 0),
    b = await budgetRun(t, 1);
  assert.equal(b.misses.n, 1, 'the provider missed the budget once');
  assert.equal(b.stateReads(), a.stateReads() + 1, 'the targets were read once more after the wait');
  assert.equal(b.out.run.stopped, 'needs_attention');
  assert.deepEqual(b.out.run.executed, ['budgets']);
  assert.equal(b.rename.status, 'failed');
  assert.equal(b.rename.error.code, 'PROVIDER_VALIDATION_FAILED', JSON.stringify(b.rename.error).slice(0, 400));
  assert.equal(b.rename.error.details.read_delay, undefined, 'the retry found the budgets: no read delay is reported');
  assert.deepEqual(b.rename.error.details.provider_errors, a.rename.error.details.provider_errors);
  assert.equal(
    b.x.validations(),
    2,
    'the rejection came from one validate-only request, sent after the retry found the budgets',
  );
  assert.equal(b.x.writes(), 1, 'the budgets are the only write');
  assert.equal(b.out.next_call.kind, 'correction');
});

test('J-A: a read delay that outlasts the waits stops the step without a validate-only request and without a correction, and the call it names prepares the same step into the rejection', async t => {
  const c = await budgetRun(t, 3);
  assert.equal(c.misses.n, 3, 'three prepares: the first and the two retries');
  assert.equal(c.out.run.stopped, 'needs_attention');
  assert.deepEqual(c.out.run.executed, ['budgets']);
  assert.equal(c.rename.status, 'failed');
  assert.equal(c.rename.error.code, 'STATE_TARGET_MISMATCH');
  assert.deepEqual(c.rename.error.details.read_delay, {attempts: 3, waited_ms: 2, nothing_sent: true});
  assert.equal(c.rename.review, undefined, 'no review, so no provider check, was made');
  assert.equal(
    c.x.validations(),
    1,
    'the provider was never asked to validate the renaming: its targets were not shown',
  );
  assert.equal(c.x.writes(), 1);
  // The arguments are not wrong, so no correction is offered: the same step is prepared again, and the plan's hash and approval stay.
  const next = c.out.next_call;
  assert.equal(next.arguments.action, 'recover_step');
  assert.equal(next.kind, undefined);
  assert.equal(next.add_after_correction, undefined);
  assert.match(next.meaning, /^Nothing was sent\./);
  // The read delay has cleared (three misses are spent): the same step, prepared again, is validated and rejected, and still nothing is sent.
  const again = await c.x.call('amcp_campaign', next.arguments);
  assert.equal(again.success, true, JSON.stringify(again).slice(0, 600));
  const ran = await c.x.call('amcp_campaign', {action: 'run', id: c.id});
  assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 600));
  assert.equal(ran.data.run.stopped, 'needs_attention');
  const rejected = await stepOf(c.x, c.id, 'rename');
  assert.equal(rejected.error.code, 'PROVIDER_VALIDATION_FAILED');
  assert.equal(c.x.validations(), 2);
  assert.equal(c.x.writes(), 1, 'the budgets are still the only write');
  assert.equal(c.x.store.document(googleTenant, 'campaign_run', c.id).steps[1].submission, 'not_submitted');
});

// ---- J-B: smartpush's secret authorization code x errors' rows of what the provider named ---------------------------------------------------------
// A creator's authorization code is a secret-like value: a review keeps only its digest, execute sends it once, and a reply that echoes it is scrubbed
// of it (smartpush). A refusal now keeps the rows of the tokens the provider named, its own sentence, a journal row and a status line (errors), and the
// rows are checked against the request that was refused. TikTok's refusal of a code echoes it twice, as it was sent ("%2B") and as it read it ("+"):
// no surface that the second package added may keep a piece of it, and each of them must be there, or the test would pass on an empty answer. A plan
// cannot hold the code (its step is refused when the plan is made), so no step view can show one.
const authorize = 'tiktok_tt_video_authorize_apply',
  creatorCode = '#ZmFrZS1hdXRoLWNvZGUtdW5r+bm93bg==',
  wireSpelling = code => code.replaceAll('+', '%2B');
/** Every row of every table of the store, as text: what is kept (BLOB columns as their bytes), to search for a value. */
function everything(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map(t => t.name);
  return tables
    .map(
      t =>
        t +
        ': ' +
        JSON.stringify(store.db.prepare('SELECT * FROM "' + t + '"').all(), (_, v) =>
          v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
        ),
    )
    .join('\n');
}
/** The pieces of `size` characters that a text must not hold of any spelling of a value. */
const piecesOf = (spellings, size) =>
  spellings.flatMap(s => Array.from({length: Math.max(0, s.length - size + 1)}, (_, i) => s.slice(i, i + size)));

test('J-B: a refused authorization code that TikTok echoes in both spellings is in no row, sentence, journal row, status or audit row, and each of them is there', async () => {
  const f = pushFixture();
  try {
    const spellings = [...secretSpellings(creatorCode)],
      payload = {auth_code: wireSpelling(creatorCode)},
      p = await f.prepared(payload, authorize),
      review = p.data.review_id,
      again = {arguments: f.args(payload, authorize)};
    const x = await f.execute(review, again);
    assertRefused(x, 'PLATFORM_ERROR');
    const replay = await f.execute(review, again);
    assertRefused(replay, 'WRITE_REJECTED');
    assert.deepEqual(
      f.writes,
      [{advertiser_id: pushAccount, auth_code: wireSpelling(creatorCode)}],
      'TikTok got the code once',
    );
    // What errors added is there: the provider's own sentence, with the code gone from both of its places; the row of the code it named; a row of the
    // journal; the status of the review; and an audit row of the rejection.
    assert.equal(x.error.details.provider_message, 'Invalid authorization code [secret] (read as [secret])');
    assert.deepEqual(x.error.details.provider_errors, [{code: 40002}]);
    const status = await f.call('amcp_write', {action: 'status', review_id: review});
    assert.equal(status.success, true, JSON.stringify(status).slice(0, 400));
    assert.deepEqual(status.data.last_error.provider_errors, [{code: 40002}]);
    const journal = f.store.operationJournal(pushActor.tenantId, review);
    assert.equal(journal.events.at(-1).phase, 'rejected');
    assert.deepEqual(journal.events.at(-1).provider_errors, [{code: 40002}]);
    const audit = f.store.db.prepare('SELECT * FROM audit').all();
    assert.ok(
      audit.some(row => JSON.parse(row.event).event === 'write_rejected'),
      'the rejection is audited',
    );
    const surfaces = {
      'the answer': JSON.stringify(x),
      'the rows': JSON.stringify(x.error.details.provider_errors),
      'the provider sentence': x.error.details.provider_message,
      'the answer to a replay': JSON.stringify(replay),
      'the status of the review': JSON.stringify(status),
      'the journal': JSON.stringify(journal),
      'the audit table': JSON.stringify(audit),
      'every stored row': everything(f.store),
    };
    for (const [name, text] of Object.entries(surfaces))
      assert.deepEqual(
        piecesOf(spellings, 8).filter(piece => text.includes(piece)),
        [],
        name + ' holds a piece of the code',
      );
  } finally {
    f.store.close();
  }
});

/** What Google answers a validate-only request with when a text of the request breaks a policy: the row it names carries that text as its trigger. */
const googleTrigger = trigger => ({
  error: {
    code: 400,
    message: 'Request contains an invalid argument.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
        errors: [
          {
            errorCode: {assetGroupSignalError: 'SEARCH_THEME_POLICY_VIOLATION'},
            message: 'The search theme violates a policy.',
            trigger: {stringValue: trigger},
            location: {
              fieldPathElements: [
                {fieldName: 'operations', index: 0},
                {fieldName: 'create'},
                {fieldName: 'search_theme'},
                {fieldName: 'text'},
              ],
            },
          },
        ],
      },
    ],
  },
});

test('J-B: a row quotes a trigger only when it is the request’s own text, and a value held under a secret name is never that text, in any spelling', () => {
  const request = {
      payload: {auth_code: creatorCode, operations: [{create: {search_theme: {text: 'dental implants'}}}]},
    },
    rowOf = trigger =>
      providerRefusal('google_ads_native_action', googleTrigger(trigger), undefined, request).errors[0];
  // The control: the request's own words are quoted, so the test cannot pass on a rule that quotes nothing.
  assert.equal(rowOf('dental implants').trigger, 'dental implants');
  for (const spelling of secretSpellings(creatorCode)) {
    const row = rowOf(spelling);
    assert.equal(row.trigger, undefined, 'the code spelled ' + spelling + ' is quoted');
    assert.equal(row.trigger_withheld, true);
    assert.ok(!JSON.stringify(row).includes(spelling));
  }
});

test('J-B: a plan cannot hold the code, so the step view has none to show: its step is refused where the plan is made, with a sentence of its own, and nothing is stored', async () => {
  const f = pushFixture();
  try {
    const step = {
      id: 'apply',
      kind: 'write',
      gateway: tiktokGateway,
      connection_id: TIKTOK,
      account_id: pushAccount,
      description: 'apply',
      arguments: {action: authorize, payload: {auth_code: creatorCode}},
      depends_on: [],
    };
    const made = await f.call('amcp_campaign', {
      action: 'create',
      name: 'Apply a code',
      brief: 'Synthetic.',
      steps: [step],
    });
    assertRefused(made, 'INVALID_ARGUMENT', {writes: () => f.writes.length});
    assert.match(made.error.message, /a campaign plan does not keep it\.$/);
    assert.deepEqual(made.error.details.steps, ['apply']);
    assert.equal(f.store.documents(pushActor.tenantId, 'campaign_run').length, 0, 'no plan was saved');
    for (const spelling of secretSpellings(creatorCode))
      assert.ok(!JSON.stringify(made).includes(spelling) && !everything(f.store).includes(spelling), spelling);
  } finally {
    f.store.close();
  }
});

// ---- J-C: refs' distinct stand-ins x livefix's count of the targets of a status change or a deletion ---------------------------------------------
// A step that names two objects its plan creates holds two references. Before anything exists the preflight gives each its own stand-in (refs: one
// ordinal for each distinct reference), so that the family's rule of unique numeric IDs sees two targets; the review made when the step is prepared
// holds the real IDs, and its summary and its destructive reason count and name both (livefix, item 3: they counted one target for a status change or a
// deletion of several). The plan turns on, pauses and deletes the two Upgraded Smart+ campaigns it creates, by the same two references.
const smartTenant = 'field3-merge-joins',
  smartLogin = '18181818-1818-4181-8181-181818181818';
/**
 * How TikTok shows a deleted Upgraded Smart+ campaign (the pages read 2026-11-21): the default read leaves it out, and STATUS_ALL lists it with its own
 * secondary status CAMPAIGN_STATUS_DELETE. The synthetic advertiser records a deletion by setting operation_status DELETE.
 */
const showsDeletedCampaigns =
  world =>
  async (raw, init = {}) => {
    const response = await world.fetch(raw, init),
      url = new URL(String(raw));
    if ((init.method ?? 'GET') !== 'GET' || !/\/smart_plus\/campaign\/get\/$/.test(url.pathname)) return response;
    const answer = await response.json(),
      all = JSON.parse(url.searchParams.get('filtering') ?? '{}').primary_status === 'STATUS_ALL';
    answer.data.list = answer.data.list
      .filter(row => all || row.operation_status !== 'DELETE')
      .map(row =>
        row.operation_status === 'DELETE'
          ? {...row, operation_status: 'DISABLE', secondary_status: 'CAMPAIGN_STATUS_DELETE'}
          : row,
      );
    answer.data.page_info.total_number = answer.data.list.length;
    return Response.json(answer);
  };
/** An advertiser of Upgraded Smart+ campaigns behind the real service, and the calls of the plan engine on it. */
function smartPlusAccount(t, worldOptions = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
    actor = {tenantId: smartTenant, userId: 'operator', role: 'operator'},
    world = smartPlusWebAdvertiser(worldOptions);
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: smartLogin,
      tenantId: smartTenant,
      gateway: 'tiktok_native_action',
      accounts: [smartPlusWebAccount],
      writeAccounts: [smartPlusWebAccount],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(showsDeletedCampaigns(world), undefined, undefined, undefined, 10000),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  t.after(() => store.close());
  return {world, store, call: input => service.call('amcp_campaign', input, actor)};
}
const smartStep = (id, depends_on, payload, action) => ({
  id,
  kind: 'write',
  gateway: 'tiktok_native_action',
  connection_id: smartLogin,
  account_id: smartPlusWebAccount,
  description: id,
  depends_on,
  arguments: {action, payload: {advertiser_id: smartPlusWebAccount, ...payload}},
});
const smartCreate = (id, name, request) =>
  smartStep(
    id,
    [],
    {
      request_id: request,
      operation_status: 'DISABLE',
      objective_type: 'WEB_CONVERSIONS',
      sales_destination: 'WEBSITE',
      campaign_name: name,
      budget_optimize_on: true,
      budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
      budget: 20,
    },
    'tiktok_smart_plus_campaign_create',
  );
const campaignRef = id => ({$ref: id + '#/data/data/campaign_id'});
/** A change of status of the campaigns the references name, in the order they are given. */
const smartStatus = (id, status, depends_on, ids) =>
  smartStep(
    id,
    depends_on,
    {campaign_ids: ids.map(campaignRef), operation_status: status},
    'tiktok_smart_plus_campaign_status_update',
  );
const smartPlan = async (f, steps) => {
  const made = await f.call({action: 'create', name: 'DNU two campaigns', brief: 'Synthetic.', steps});
  assert.equal(made.success, true, JSON.stringify(made).slice(0, 800));
  return made.data.id;
};
const checksOf = async (f, id) => (await f.call({action: 'get', id, detail: 'full'})).data.preflight.checks;

test('J-C: a plan that turns on, pauses and deletes the two campaigns it creates counts two targets at preflight, in each review summary, and in the destructive reason that names both', async t => {
  const f = smartPlusAccount(t),
    creates = [
      smartCreate('camp_a', 'DNU A', '7300000000000000011'),
      smartCreate('camp_b', 'DNU B', '7300000000000000012'),
    ],
    id = await smartPlan(f, [
      ...creates,
      smartStatus('activate', 'ENABLE', ['camp_a', 'camp_b'], ['camp_a', 'camp_b']),
      smartStatus('pause', 'DISABLE', ['camp_a', 'camp_b', 'activate'], ['camp_a', 'camp_b']),
      smartStatus('remove', 'DELETE', ['camp_a', 'camp_b', 'pause'], ['camp_a', 'camp_b']),
    ]);
  // The preflight gives the two references two stand-ins: no step is blocked, and the family's rule of unique numeric IDs holds for each.
  const preflight = await f.call({action: 'preflight', id});
  assert.equal(preflight.success, true, JSON.stringify(preflight).slice(0, 600));
  assert.equal(preflight.data.preflight.status, 'ready', JSON.stringify(preflight.data.preflight.blocked_steps));
  assert.deepEqual(
    (await checksOf(f, id)).map(c => [c.step, c.status]),
    ['camp_a', 'camp_b', 'activate', 'pause', 'remove'].map(step => [step, 'contract_checked']),
  );
  assert.deepEqual(preflight.data.preflight.deferred[0].fields, ['/payload/campaign_ids/0', '/payload/campaign_ids/1']);
  const approval = (await f.call({action: 'approve', id})).data,
    approved = await f.call({
      ...approval.next_call.arguments,
      ...(approval.next_call.add_after_user_approval ?? {}),
    });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
  const ran = await f.call({action: 'run', id});
  assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
  assert.equal(ran.data.run.stopped, 'complete', JSON.stringify(ran.data.run).slice(0, 600));
  assert.deepEqual(ran.data.run.executed, ['camp_a', 'camp_b', 'activate', 'pause', 'remove']);
  assert.deepEqual(
    f.world.writes.map(w => w.path),
    [
      '/v1.3/smart_plus/campaign/create/',
      '/v1.3/smart_plus/campaign/create/',
      '/v1.3/smart_plus/campaign/status/update/',
      '/v1.3/smart_plus/campaign/status/update/',
      '/v1.3/smart_plus/campaign/status/update/',
    ],
  );
  // The review of each step holds the two real IDs the creates were given, and counts and names both.
  const steps = (await f.call({action: 'get', id, detail: 'full'})).data.steps,
    review = name => steps.find(s => s.id === name).review;
  for (const [name, text, operation] of [
    ['activate', 'Update 2 campaigns in account 7001; operation_status ENABLE.', 'update'],
    ['pause', 'Update 2 campaigns in account 7001; operation_status DISABLE.', 'update'],
    ['remove', 'Delete 2 campaigns in account 7001; operation_status DELETE.', 'delete'],
  ]) {
    assert.equal(review(name).summary.text, text, name);
    assert.equal(review(name).summary.count, 2, name);
    assert.equal(review(name).summary.operation, operation, name);
    assert.deepEqual(steps.find(s => s.id === name).resolved.payload.campaign_ids, ['900', '901'], name);
  }
  assert.deepEqual(review('remove').execute_requirements.reasons, [
    {
      effect: 'destructive',
      reason: 'This deletes or removes 2 campaigns: "DNU A" (900), "DNU B" (901). It cannot be undone.',
    },
  ]);
  assert.deepEqual(
    review('remove').creative_impact.changes.map(c => c.campaign_id),
    ['900', '901'],
  );
});

test('J-C: the approval summary of that plan shows the step that deletes (r25-approval-effects, lead review S2-1): destructive, with its status field, the pause lists DISABLE, and the plan-level effects name it', async t => {
  const f = smartPlusAccount(t),
    id = await smartPlan(f, [
      smartCreate('camp_a', 'DNU A', '7300000000000000011'),
      smartCreate('camp_b', 'DNU B', '7300000000000000012'),
      smartStatus('activate', 'ENABLE', ['camp_a', 'camp_b'], ['camp_a', 'camp_b']),
      smartStatus('pause', 'DISABLE', ['camp_a', 'camp_b', 'activate'], ['camp_a', 'camp_b']),
      smartStatus('remove', 'DELETE', ['camp_a', 'camp_b', 'pause'], ['camp_a', 'camp_b']),
    ]);
  assert.equal((await f.call({action: 'preflight', id})).success, true);
  const shown = await f.call({action: 'approval_summary', id});
  assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 600));
  const step = name => shown.data.approval.steps.find(s => s.id === name),
    statusOf = name => (step(name).status ?? []).map(s => [s.field, s.value]);
  assert.equal(step('remove').effects?.destructive, true, JSON.stringify(step('remove')));
  assert.equal(step('remove').effects?.irreversible, true);
  // The check happened (a failed compile would show checked: false), and the creates are no deletion.
  assert.equal(step('remove').effects.checked, undefined);
  assert.equal(step('camp_a').effects, undefined);
  assert.equal(step('camp_b').effects, undefined);
  // The status a step sets is listed, whatever the platform calls it: TikTok's operation_status.
  assert.deepEqual(
    statusOf('remove').filter(([field]) => field.endsWith('/operation_status')),
    [['/payload/operation_status', 'DELETE']],
  );
  assert.deepEqual(
    statusOf('pause').filter(([field]) => field.endsWith('/operation_status')),
    [['/payload/operation_status', 'DISABLE']],
  );
  assert.equal(step('pause').effects, undefined);
  assert.equal(step('activate').effects, undefined);
  assert.deepEqual(
    (shown.data.approval.effects ?? []).map(e => e.step_id),
    ['remove'],
  );
  // The summary stays inside its 6 KB.
  assert.ok(Buffer.byteLength(JSON.stringify(shown.data.approval)) <= 6 * 1024);
});

test('J-C: two references to the same result of one step are still one target, and the preflight refuses them before anything is created', async t => {
  const f = smartPlusAccount(t),
    id = await smartPlan(f, [
      smartCreate('camp_a', 'DNU A', '7300000000000000011'),
      smartStatus('pause', 'DISABLE', ['camp_a'], ['camp_a', 'camp_a']),
    ]);
  const preflight = await f.call({action: 'preflight', id});
  assert.equal(preflight.success, true, JSON.stringify(preflight).slice(0, 600));
  assert.equal(preflight.data.preflight.status, 'blocked');
  const checks = await checksOf(f, id),
    pause = checks.find(c => c.step === 'pause');
  assert.equal(pause.status, 'blocked', JSON.stringify(checks.map(c => [c.step, c.status])));
  assert.match(pause.error.message, /campaign_ids/, JSON.stringify(pause.error).slice(0, 400));
  const ran = await f.call({action: 'run', id});
  assert.equal(ran.data.run.reason, 'preflight_blocked');
  assert.equal(f.world.writes.length, 0, 'nothing was created');
});

// ---- J-D: errors' stop at a rejected step x approvals' answer of `run` for a plan blocked at preflight --------------------------------------------------
// `run` answers every stop with the plan's progress (approvals, AMCP-12) and names the call that corrects the stopped step. Two stops of two packages
// meet there: a step the provider rejected at prepare (errors: failed and unsent, `needs_attention`) and a plan whose preflight blocks a step before any
// request (approvals: `needs_attention` with the reason `preflight_blocked`). Each answer has the progress, names its own stop and its own correction,
// and sends nothing: the first only the validate-only request, the second no request at all.
const runOf = (x, id) => x.call('amcp_campaign', {action: 'run', id});
const correctionOf = (out, id, step) => {
  assert.deepEqual(out.data.next_call.arguments, {action: 'recover_step', id, step_id: step, confirmed: true});
  assert.equal(out.data.next_call.kind, 'correction');
  assert.equal(
    typeof out.data.next_call.add_after_correction.arguments.action,
    'string',
    'the step to change is shown',
  );
};
const progressKeys = ['steps_total', 'settled', 'remaining', 'executed_this_call', 'elapsed_ms', 'budget_ms'];

test('J-D: a plan whose step the provider rejected, and a plan blocked at preflight, each answer run with their progress, their own stop and their own correction, and send nothing', async t => {
  // The plan whose step the provider rejects when it validates it at prepare.
  const rejected = rejecting();
  t.after(() => rejected.store.close());
  const rejectedId = await createdPlan(rejected, [signalsStep()]);
  await approve(rejected, rejectedId);
  const stopped = await runOf(rejected, rejectedId);
  assert.equal(stopped.success, true, JSON.stringify(stopped).slice(0, 600));
  assert.equal(stopped.data.run.stopped, 'needs_attention');
  assert.equal(stopped.data.run.reason, undefined, 'a rejected step is no blocked plan: it has no preflight reason');
  assert.deepEqual(stopped.data.run.executed, []);
  assert.ok(stopped.data.run.progress, 'the stop of a rejected step carries the progress of the plan');
  for (const key of progressKeys) assert.equal(typeof stopped.data.run.progress[key], 'number', key);
  assert.deepEqual(
    [stopped.data.run.progress.steps_total, stopped.data.run.progress.settled, stopped.data.run.progress.remaining],
    [1, 0, 1],
  );
  assert.equal(stopped.data.state, 'attention');
  assert.equal(stopped.data.blocked, true);
  correctionOf(stopped, rejectedId, 'signals');
  assert.equal((await stepOf(rejected, rejectedId, 'signals')).error.code, 'PROVIDER_VALIDATION_FAILED');
  assert.equal(rejected.validations(), 1, 'the provider was asked once, by a validate-only request');
  assert.equal(rejected.writes(), 0, 'nothing was written');

  // The plan whose second step names a result of a step it does not wait for: the preflight blocks it before any request.
  const blocked = googleWorld({
    world: {campaigns: {}, adGroups: {}, assetGroups: {}},
    policy: {providerCheckByDefault: true},
  });
  t.after(() => blocked.store.close());
  const [budgets, rename] = budgetPlan(),
    blockedId = await createdPlan(blocked, [budgets, {...rename, depends_on: []}]);
  const out = await runOf(blocked, blockedId);
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 600));
  assert.equal(out.data.run.stopped, 'needs_attention');
  assert.equal(out.data.run.reason, 'preflight_blocked');
  assert.deepEqual(out.data.run.executed, []);
  assert.ok(out.data.run.progress, 'the stop of a blocked plan carries the progress of the plan');
  for (const key of progressKeys.filter(k => k !== 'elapsed_ms' && k !== 'budget_ms'))
    assert.equal(typeof out.data.run.progress[key], 'number', key);
  assert.deepEqual(
    [out.data.run.progress.steps_total, out.data.run.progress.settled, out.data.run.progress.remaining],
    [2, 0, 2],
  );
  assert.equal(out.data.state, 'draft', 'the plan was never approved or run');
  assert.equal(out.data.blocked, true);
  correctionOf(out, blockedId, 'rename');
  assert.deepEqual([blocked.validations(), blocked.writes()], [0, 0], 'no validate-only request and no write was sent');
  assert.ok(
    blocked.queries().every(query => /FROM customer\b/.test(query)),
    'nothing of the plan was read, only the account: ' + blocked.queries().join(' | '),
  );
});

// ---- J-E: recipes' declared inputs x livefix's pixel-event preflight -------------------------------------------------------------------------------
// The Smart+ purchases pack declares the events its `optimization_event` takes, and reads a brief by them, in any case of their letters (recipes, AMCP-08).
// Its preflight reads the pixel and refuses an ad group that optimizes an event the pixel does not hold, before anything is created (livefix, item 5). The
// two must agree on what an event is: the event a brief writes, in whatever case, is the declared value that the preflight compares with the pixel's list,
// and the refusal names that value and the events the pixel does hold.
const smartConversion = 'tiktok_smart_plus_website_conversions';
/** A pixel row that holds the events named, as "Get pixels" lists them (each with its `event_type`, and its `optimization_event`). */
const pixelHolding = (...names) => ({events: names.map(name => ({event_type: name, optimization_event: name}))});
/** create_from_recipe, approve (preview), approve (confirmed) and run: the calls of a launch. */
async function launchRecipe(f, recipe, business) {
  const made = await f.call({action: 'create_from_recipe', recipe, business});
  assert.equal(made.success, true, JSON.stringify(made).slice(0, 800));
  const id = made.data.id,
    preview = await f.call({action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 800));
  const approved = await f.call({
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 800));
  return {id, ran: await f.call({action: 'run', id})};
}

test('J-E: each event the Smart+ purchases pack declares is built once when the pixel holds it, in any case, and is refused at preflight when it does not, naming the events the pixel holds', async t => {
  const declared = campaignRecipes.find(recipe => recipe.id === smartConversion).inputs.optimization_event.values;
  assert.deepEqual(declared, ['SHOPPING', 'ON_WEB_ORDER', 'INITIATE_ORDER', 'ON_WEB_CART']);
  const brief = (event, as = event) => ({...smartPlusWebBriefs(smartLogin).conversions, optimization_event: as});
  for (const [i, event] of declared.entries()) {
    const other = declared[(i + 1) % declared.length];
    // The pixel holds the event: the brief may write it in lowercase, and the pack builds its campaign, ad group and ad once, with the declared value.
    const held = smartPlusAccount(t, {pixel: pixelHolding(event)}),
      {ran: built} = await launchRecipe(held, smartConversion, brief(event, event.toLowerCase()));
    assert.equal(built.success, true, event + ' ' + JSON.stringify(built).slice(0, 600));
    assert.equal(built.data.run.stopped, 'complete', event + ' ' + JSON.stringify(built.data.run).slice(0, 400));
    assert.deepEqual(
      held.world.writes.map(w => w.path),
      ['/v1.3/smart_plus/campaign/create/', '/v1.3/smart_plus/adgroup/create/', '/v1.3/smart_plus/ad/create/'],
      event,
    );
    assert.equal(
      held.world.writes[1].body.optimization_event,
      event,
      'the ad group optimizes the declared value, not the lowercase text',
    );
    // The pixel holds another event: preflight refuses the plan with the declared value and the events the pixel holds, and nothing is created.
    const missing = smartPlusAccount(t, {pixel: pixelHolding(other)}),
      made = await missing.call({
        action: 'create_from_recipe',
        recipe: smartConversion,
        business: brief(event, event.toLowerCase()),
      });
    assert.equal(made.success, true, JSON.stringify(made).slice(0, 600));
    const preflight = await missing.call({action: 'preflight', id: made.data.id});
    assert.equal(preflight.success, true, JSON.stringify(preflight).slice(0, 600));
    assert.equal(preflight.data.preflight.status, 'blocked', event);
    const check = (await checksOf(missing, made.data.id)).find(c => c.status === 'blocked');
    assert.equal(check.step, 'smart_plus_adgroup', event);
    assert.equal(check.error.code, 'CAMPAIGN_PREREQUISITE_REQUIRED', event);
    assert.equal(check.error.details.field, 'optimization_event');
    assert.equal(check.error.details.optimization_event, event, 'the declared value, not the case it was written in');
    assert.deepEqual(check.error.details.pixel_events, [other]);
    assert.match(check.error.message, new RegExp(event + '.*holds ' + other));
    const ran = await missing.call({action: 'run', id: made.data.id});
    assert.equal(ran.data.run.reason, 'preflight_blocked', event);
    assert.equal(missing.world.writes.length, 0, 'no campaign was created: ' + event);
  }
  // A pixel row that lists no events is unknown, not empty: nothing is refused on it, and the pack builds (the list is not asked for or not returned).
  const unknown = smartPlusAccount(t),
    {ran: launched} = await launchRecipe(unknown, smartConversion, brief('SHOPPING'));
  assert.equal(launched.data.run.stopped, 'complete', JSON.stringify(launched.data.run).slice(0, 400));
  assert.equal(unknown.world.writes.length, 3);
});

// ---- J-F: smartpush's Push ads (uploads) x livefix's pixel of a website ad x end cards ---------------------------------------------------------------
// An ad built from uploads (Spark Ads Push) is edited as an ad of posts is, and keeps its kind (smartpush). A website ad's pixel is its ad group's, so an
// edit that names another pixel for it is refused before anything is written, and the pixel a UI-made website ad already holds, restated unchanged, is
// accepted and says so (livefix, item 4). Both write into the review's one impact block, with the end cards an edit names (end cards): the block holds
// each package's part, and the ad is still an ad of uploads while its configuration is restated.
const pushLogin = {
  accounts: [pushAccount],
  writeAccounts: [pushAccount],
  enabled: true,
  label: 'Synthetic TikTok',
  scopes: [],
};
const pixelsOfPush = {
  7001: {pixel_id: '7001', pixel_code: 'C7001', pixel_name: 'Site pixel', asset_ownership: {ownership_status: true}},
  7002: {pixel_id: '7002', pixel_code: 'C7002', pixel_name: 'Second pixel', asset_ownership: {ownership_status: true}},
};
/** The Push advertiser behind the real service, with the pixel list read it needs: the fixture of smartpush, and the pixels of the edits fixture. */
function pushAdvertiser(t) {
  const store = new Store(':memory:', pushKey),
    world = pushWorld();
  store.putConnection(
    pushOwner,
    {id: TIKTOK, tenantId: pushActor.tenantId, gateway: tiktokGateway, ...pushLogin},
    {accessToken: 'synthetic'},
  );
  const fetch = async (raw, init = {}) => {
    const url = new URL(String(raw));
    if ((init.method ?? 'GET') !== 'GET' || url.pathname.replace(/^\/open_api/, '') !== '/v1.3/pixel/list/')
      return world.handle(raw, init);
    const pixel = pixelsOfPush[url.searchParams.get('pixel_id')];
    return Response.json({
      code: 0,
      message: 'OK',
      request_id: 'r',
      data: {
        pixels: pixel ? [structuredClone(pixel)] : [],
        page_info: {page: 1, page_size: 10, total_number: pixel ? 1 : 0, total_page: 1},
      },
    });
  };
  const service = new MirrorService(new Registry(), store, new NativeTransport(fetch), undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool, input) => service.call(tool, input, pushActor);
  t.after(() => store.close());
  return {
    world,
    call,
    edit: payload =>
      call('amcp_write', {
        action: 'prepare',
        gateway: tiktokGateway,
        connection_id: TIKTOK,
        arguments: {action: 'tiktok_smart_plus_ad_update', account_id: pushAccount, payload},
      }),
    execute: id => call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true}),
    verify: id => call('amcp_campaign', {action: 'verify', review_id: id}),
  };
}
/** The whole configuration an edit restates (every edit of an ad's configuration must), with the keys an edit changes. */
const pushConfig = extra => ({
  call_to_action_id: '700',
  creative_auto_add_toggle: false,
  creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
  utm_params: [
    {key: 'utm_source', value: 'tiktok'},
    {key: 'utm_campaign', value: '__CAMPAIGN_NAME__'},
  ],
  ...extra,
});
const restatedMeaning =
  'The ad already holds this pixel, and the edit restates it unchanged. TikTok keeps "0" on a website ad when a pixel is sent to it, so the read-back must still show this pixel: a read-back that shows "0" is never reported as a success.';

test('J-F: a website Push ad that holds a pixel set in TikTok’s UI restates it unchanged and prepares and verifies, another pixel is refused before anything is written, and the ad stays an ad of uploads', async t => {
  const f = pushAdvertiser(t);
  // Ad 5113 is an ad of uploads in a website CONVERT ad group (pixel 7001), on the profile (dark_post_status OFF); its pixel was set in TikTok's UI.
  f.world.ads['5113'].ad_configuration.tracking_info.tracking_pixel_id = '7002';
  const restate = extra => ({
    smart_plus_ad_id: '5113',
    ad_configuration: pushConfig({dark_post_status: 'OFF', ...extra}),
  });
  const p = await f.edit(restate({tracking_info: {tracking_pixel_id: '7002'}}));
  assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 600));
  assert.deepEqual(p.data.creative_impact.tracking_pixel, {
    pixel_id: '7002',
    name: 'Second pixel',
    owned: true,
    restated_unchanged: true,
    meaning: restatedMeaning,
  });
  assert.ok(p.data.creative_impact.dark_post, 'smartpush’s part of the same impact block is there');
  assert.equal(p.data.creative_impact.dark_post.dark_post_status, 'OFF');
  assert.equal(f.world.writes.length, 0, 'a prepare sends nothing');
  const x = await f.execute(p.data.review_id);
  assert.equal(x.success, true, JSON.stringify(x.error ?? x).slice(0, 400));
  assert.equal(f.world.writes.length, 1);
  assert.equal(f.world.writes[0].ad_configuration.tracking_info.tracking_pixel_id, '7002');
  assert.equal(f.world.writes[0].ad_configuration.dark_post_status, 'OFF');
  const v = await f.verify(p.data.review_id);
  assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  // Another pixel, even the pixel of its ad group, is a pixel edit of a website ad: refused, nothing is written. Leaving the held pixel out is refused as well.
  const other = await f.edit(restate({tracking_info: {tracking_pixel_id: '7001'}}));
  assertRefused(other, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.world.writes.length - 1});
  assert.match(
    other.error.message,
    /^TikTok applies an ad-level pixel only to Instant Form lead ads and app promotion ads/,
  );
  assert.match(other.error.message, /Nothing was sent: ad_configuration\.tracking_info\.tracking_pixel_id\.$/);
  assertRefused(await f.edit(restate({})), 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.world.writes.length - 1});
  // The ad is still an ad of uploads: it takes no posts, and its uploads and texts are still edited as an ad of uploads is.
  const posts = await f.edit({smart_plus_ad_id: '5113', creative_list: [pushPost('9001')]});
  assertRefused(posts, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.world.writes.length - 1});
  assert.match(posts.error.message, /is built from uploads \(Spark Ads Push\)/);
  const texts = await f.edit({smart_plus_ad_id: '5113', ad_text_list: [{ad_text: 'Profile sale, again'}]});
  assert.equal(texts.success, true, JSON.stringify(texts.error ?? texts.data).slice(0, 400));
});

test('J-F: the impact block of one edit of a Push ad holds the part of each package: the end cards it names, the pixel it restates and the profile choice it makes', async t => {
  const f = pushAdvertiser(t);
  f.world.behaviour.endCardsAllowlisted = true;
  f.world.ads['5141'].ad_configuration.tracking_info.tracking_pixel_id = '7002';
  const p = await f.edit({
    smart_plus_ad_id: '5141',
    ad_configuration: pushConfig({dark_post_status: 'ON', tracking_info: {tracking_pixel_id: '7002'}}),
    end_card_list: endCards('8803', '8801'),
  });
  assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 600));
  const impact = p.data.creative_impact;
  for (const part of ['end_cards', 'tracking_pixel', 'dark_post'])
    assert.ok(impact[part], 'the impact block holds ' + part + ': ' + Object.keys(impact).join(', '));
  assert.deepEqual(impact.end_cards.end_card_ids, ['8803', '8801']);
  assert.match(impact.end_cards.allowlist, /allowlist-only feature of TikTok/);
  assert.equal(impact.tracking_pixel.restated_unchanged, true);
  assert.equal(impact.tracking_pixel.pixel_id, '7002');
  assert.equal(impact.dark_post.dark_post_status, 'ON');
  assert.deepEqual(
    Object.keys(impact).filter(k => ['end_cards', 'tracking_pixel', 'dark_post'].includes(k)),
    ['end_cards', 'tracking_pixel', 'dark_post'],
  );
  assert.equal(f.world.writes.length, 0);
  assert.equal((await f.execute(p.data.review_id)).success, true);
  assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
});

// ---- J-G: the default step view x approvals' timings and progress x errors' bounded rows x a write group of 40 parts ------------------------------------
// The default view of a plan step stays within the plan views' 11 KB (errors, AMCP-11). Since then a step keeps the time each phase took (`timing_ms`) and
// a run answers with its progress (approvals, AMCP-12), and a refusal carries the rows the provider named (errors), at most five of them in a view, and a
// group of 1,000 operations is 40 parts, which the view counts and lists five of. Each case holds the stored step with all it keeps, and the view of it
// is what a person reads after a stop: it must fit, with its rows bounded, whatever the provider named.
const kb = 1024,
  sizeOf = value => Buffer.byteLength(JSON.stringify(value)),
  syntheticThemes = Array.from({length: 1000}, (_, i) => signals('synthetic theme ' + i)[0]),
  lastTheme = 'synthetic theme 999';
/** A refusal of Google that names `count` errors, each quoting a text of the request, in the order of the request's operations. */
const manyErrors = count => {
  const refusal = googleFailure({trigger: lastTheme}),
    [first] = refusal.error.details[0].errors;
  refusal.error.details[0].errors = Array.from({length: count}, (_, index) => ({
    ...first,
    location: {
      fieldPathElements: [
        {fieldName: 'operations', index},
        {fieldName: 'create'},
        {fieldName: 'search_theme'},
        {fieldName: 'text'},
      ],
    },
  }));
  return refusal;
};
const viewOf = (x, id, extra = {}) => x.call('amcp_campaign', {action: 'get', id, step_id: 'signals', ...extra});
const storedStep = (x, id) => x.store.document(googleTenant, 'campaign_run', id).steps[0];

test('J-G: a group of 40 parts whose last part the provider rejected with 30 errors has a step view of about 4 KB with five rows, the timing of its prepare, and the progress of the run', async t => {
  const x = rejecting();
  t.after(() => x.store.close());
  x.hooks.validationReply = body =>
    body.operations.some(op => op.create.search_theme.text === lastTheme) ? manyErrors(30) : undefined;
  const id = await createdPlan(x, [signalsStep('signals', syntheticThemes)]);
  // The approval of a group of 40 parts judges it by its parts: it is no deletion and no failed check (r25-approval-effects, fix round S2-1).
  const shown = await x.call('amcp_campaign', {action: 'approve', id});
  assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 400));
  assert.equal(shown.data.approval.steps[0].effects, undefined, JSON.stringify(shown.data.approval.steps[0]));
  await approve(x, id);
  const out = await runOf(x, id);
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 600));
  assert.equal(out.data.run.stopped, 'needs_attention');
  assert.deepEqual([out.data.run.progress.steps_total, out.data.run.progress.settled], [1, 0]);
  assert.equal(x.validations(), 40, 'all 40 parts were validated, and the last one was rejected');
  assert.equal(x.writes(), 0);
  // Approvals' part: the step kept the time its prepare took.
  assert.equal(typeof storedStep(x, id).timing_ms.prepare, 'number');
  const view = await viewOf(x, id);
  assert.equal(view.success, true, JSON.stringify(view).slice(0, 400));
  assert.ok(sizeOf(view.data) <= planViewBudget, 'the step view is ' + sizeOf(view.data) + ' bytes');
  assert.ok(sizeOf(view) <= 12 * kb, 'the answer is ' + sizeOf(view) + ' bytes');
  // Errors' part: the rows are bounded to five in the view, the rest are counted, and so are the field paths.
  const error = view.data.step.last_error;
  assert.equal(error.code, 'PROVIDER_VALIDATION_FAILED');
  assert.ok(error.details.provider_errors.length > 0 && error.details.provider_errors.length <= 5, 'at most five rows');
  assert.ok(error.details.provider_errors_omitted >= 1, 'the rows left out are counted');
  assert.ok(error.details.field_paths.length <= 10, 'at most ten field paths');
  assert.ok(
    sizeOf((await x.call('amcp_campaign', {action: 'get', id})).data) <= planViewBudget,
    'the plan view fits too',
  );
});

test('J-G: a group of 40 parts whose first part the provider refused at execute keeps its 40 parts, the timings of its phases and the progress of the run in a view within 11 KB, and pages its parts within 25 KB', async t => {
  const x = googleWorld({policy: providerCheckOn, world: signalsWorld()});
  t.after(() => x.store.close());
  x.hooks.writeReply = () => ({status: 400, body: manyErrors(30)});
  const id = await createdPlan(x, [signalsStep('signals', syntheticThemes)]);
  await approve(x, id);
  const out = await runOf(x, id);
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 600));
  assert.equal(out.data.run.stopped, 'needs_attention');
  assert.deepEqual(out.data.run.executed, ['signals']);
  assert.ok(out.data.run.progress, 'the stop carries the progress of the plan');
  assert.equal(x.validations(), 40, 'all 40 parts were validated before anything was sent');
  assert.equal(x.writes(), 1, 'only the first part reached the provider, and the 39 others were never sent');
  const step = storedStep(x, id);
  assert.equal(step.review.parts.length, 40);
  assert.equal(typeof step.timing_ms.prepare, 'number');
  assert.equal(typeof step.timing_ms.execute, 'number');
  const view = await viewOf(x, id);
  assert.equal(view.success, true, JSON.stringify(view).slice(0, 400));
  assert.ok(sizeOf(view.data) <= planViewBudget, 'the step view is ' + sizeOf(view.data) + ' bytes');
  assert.equal(view.data.step.review.parts_count, 40);
  assert.equal(view.data.step.review.parts.length, 5, 'five parts are listed, the rest are paged');
  assert.equal(view.data.step.review.parts_omitted, 35);
  // Every part is one call away, in pages: the first was rejected by the provider, and the others were never sent.
  const page = await viewOf(x, id, {topic: 'parts'}),
    parts = JSON.parse(page.data.text);
  assert.ok(sizeOf(page) <= 25000, 'a page of the parts is ' + sizeOf(page) + ' bytes');
  assert.equal(parts.length, 40);
  assert.equal(parts[0].state, 'rejected');
  assert.ok(parts.slice(1).every(part => part.state === 'unsubmitted'));
});

// ---- J-I: admin-email's owner-level AI credentials x approvals' summary and the owner's plan policy ----------------------------------------------------
// An owner of the deployment may give an AI client Owner access (admin-email, D16 lifted for owners only): its key reaches the owner-gated actions, and its
// person is the owner it acts for. Approvals added the approval summary a plan shows and the stop of a plan whose approval must be someone else's (the
// distinct-approver policy, CMP-05). Over the real website, with synthetic Google behind its service: the owner-level credential reads the summary and
// records an approval; the operator-level credential of the same person, and an administrator's, cannot change the owner's policy; under the policy the
// same person's two credentials are one approver and a second owner's credential is another; and an administrator is still offered no Owner access.
test('J-I: an owner-level credential reads approval_summary and records an approval as its owner; operator-level and administrator credentials change no owner policy; under the policy one person is one approver', async t => {
  // Nothing leaves the process: the website's own listener is reached, the provider is the synthetic Google, and any other request is refused.
  const google = googleResponder({world: {campaigns: {}, adGroups: {}, assetGroups: {}}}),
    realFetch = globalThis.fetch,
    outside = [];
  globalThis.fetch = (url, init) => {
    const host = new URL(String(url)).hostname;
    if (host === '127.0.0.1') return realFetch(url, init);
    if (host === 'googleads.googleapis.com') return google.fetcher(url, init);
    outside.push(String(url));
    throw new TypeError('no request leaves the process in this test: ' + host);
  };
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  t.after(async () => {
    globalThis.fetch = realFetch;
    await f.close();
  });
  await f.deploymentOwner('owner@example.test');
  await f.account(adminAddress, 'Second owner');
  const member = async (email, role) => {
    const account = await f.account(email);
    f.store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(f.tenant, account.id, role, Date.now());
    return (await f.switchTo(await f.signedIn(email))).headers;
  };
  const sessions = {
    secondOwner: (await f.switchTo(await f.signedIn(adminAddress))).headers,
    originalOwner: (await f.switchTo(await f.signedIn('owner@example.test'))).headers,
    administrator: await member('plain-admin@example.test', 'admin'),
  };
  const connectorToken = async (headers, body) =>
    (await f.request('/api/connector-tokens', 'POST', {name: 'Synthetic connector', ...body}, headers)).json();
  const tokens = {
    secondOwner: await connectorToken(sessions.secondOwner, {role: 'owner', confirmed: true}),
    secondOperator: await connectorToken(sessions.secondOwner, {role: 'operator', confirmed: true}),
    originalOwner: await connectorToken(sessions.originalOwner, {role: 'owner', confirmed: true}),
    administrator: await connectorToken(sessions.administrator, {role: 'operator', confirmed: true}),
  };
  // D16 is unchanged for an administrator: Owner is not offered, and the credential it may mint is the operator's.
  const refused = await connectorToken(sessions.administrator, {role: 'owner', confirmed: true});
  assert.equal(
    refused.error?.code,
    'INVALID_ROLE',
    'an administrator is offered no Owner access (the answer holds: ' + Object.keys(refused) + ')',
  );
  assert.equal(tokens.administrator.role, 'operator');
  const mcp = async (token, name, args) => {
    const response = await realFetch(f.base + '/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer ' + token.token,
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}),
      }),
      body = await response.json(),
      text = body.result?.content?.[0]?.text;
    assert.ok(text, 'the wire answered a tool result: ' + JSON.stringify(body).slice(0, 300));
    return JSON.parse(text);
  };
  const campaign = (token, args) => mcp(token, 'amcp_campaign', args),
    workspace = (token, args) => mcp(token, 'amcp_workspace', args);
  assert.ok(
    'policies' in (await workspace(tokens.secondOwner, {action: 'health'})).data,
    'the owner view is the owner level’s',
  );
  assert.equal((await workspace(tokens.secondOperator, {action: 'health'})).error?.code, 'OWNER_REQUIRED');
  f.store.putConnection(
    {tenantId: f.tenant, userId: 'admin', role: 'admin'},
    {
      id: 'g',
      tenantId: f.tenant,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const plan = async (token, name) => {
    const made = await campaign(token, {action: 'create', name, brief: 'Synthetic.', steps: [budgetPlan()[0]]});
    assert.equal(made.success, true, JSON.stringify(made).slice(0, 500));
    return made.data.id;
  };
  const approving = async (token, id) => {
    const shown = await campaign(token, {action: 'approve', id});
    assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 400));
    return campaign(token, {
      action: 'approve',
      id,
      plan_hash: shown.data.plan_hash,
      summary_hash: shown.data.summary_hash,
      confirmed: true,
      spend_change_confirmed: true,
    });
  };
  // The agent's plan is read, as its summary, by the owner-level credential of the same person, and approved by it, as that credential.
  const first = await plan(tokens.secondOperator, 'Plan of the agent');
  const summary = await campaign(tokens.secondOwner, {action: 'approval_summary', id: first});
  assert.equal(summary.success, true, JSON.stringify(summary).slice(0, 400));
  assert.equal(summary.data.approver_required, undefined, 'no policy governs the plan yet');
  assert.deepEqual(
    summary.data.approval.steps.map(s => s.id),
    ['budgets'],
  );
  assert.match(summary.data.summary_hash, /^[0-9a-f]{64}$/);
  const approved = await approving(tokens.secondOwner, first);
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 400));
  assert.equal(approved.data.approved.by, 'connector/' + tokens.secondOwner.id);
  // The owner's policy is the owner's: the person’s operator-level credential and an administrator's refuse it, the owner-level credential saves it.
  for (const [who, token] of [
    ['the operator-level credential of the same person', tokens.secondOperator],
    ['an administrator’s credential', tokens.administrator],
  ])
    assert.equal(
      (await workspace(token, {action: 'save_plan_policy', require_distinct_approver: true, confirmed: true})).error
        ?.code,
      'OWNER_REQUIRED',
      who,
    );
  const saved = await workspace(tokens.secondOwner, {
    action: 'save_plan_policy',
    require_distinct_approver: true,
    confirmed: true,
  });
  assert.equal(saved.success, true, JSON.stringify(saved).slice(0, 400));
  assert.equal(saved.data.require_distinct_approver, true);
  // Under the policy a plan of the agent is governed: its summary says that someone else approves it, and one person is one approver whichever of their
  // credentials approves; the second owner's credential is another person.
  const second = await plan(tokens.secondOperator, 'Plan of the agent, under the policy');
  const governed = await campaign(tokens.secondOwner, {action: 'approval_summary', id: second});
  assert.equal(governed.success, true, JSON.stringify(governed).slice(0, 400));
  assert.equal(governed.data.approver_required, true);
  assert.equal(typeof governed.data.notice, 'string');
  assert.equal((await approving(tokens.secondOwner, second)).error?.code, 'DISTINCT_APPROVER_REQUIRED');
  assert.equal((await approving(tokens.secondOperator, second)).error?.code, 'DISTINCT_APPROVER_REQUIRED');
  const other = await approving(tokens.originalOwner, second);
  assert.equal(other.success, true, JSON.stringify(other).slice(0, 400));
  assert.equal(other.data.approved.by, 'connector/' + tokens.originalOwner.id);
  // An administrator's credential still reaches another actor's plan no more than before.
  assert.equal(
    (await campaign(tokens.administrator, {action: 'approval_summary', id: second})).error?.code,
    'FORBIDDEN',
  );
  assert.deepEqual(outside, [], 'no request left the process');
});

// ---- J-J: approvals' approval_summary x errors' hold of a plan while its continuation is made (merge 12) -----------------------------------------------
// The errors package holds the old plan of a continuation before it makes the new one (the fifth check G): the plan is superseded, with `superseded_by:
// {pending: true, to}` and no `id` yet, and every action but the repeat of the continuation is refused as for any superseded plan, naming the plan that is
// being made. Approvals' approval_summary is a read: it answers before that dispatch and refuses a superseded plan through the one refusal it shares with
// approve (refusePlanSuperseded), which read `superseded_by.id` alone. A held plan therefore answered "superseded by plan , ..." and a `get` without an id.
// The merge has one reading of the successor in that one refusal: the read names the plan that is being made as every other action does, and it is the plan
// the continuation then makes.
test('J-J: approval_summary of a plan whose continuation is making the new plan is refused as every other action is, naming the plan that is being made', async t => {
  const {x} = budgetWorld(0);
  t.after(() => x.store.close());
  const id = await createdPlan(x, budgetPlan());
  // The creation of the continuation's plan is held, as a slow one is, until `open`; only the first creation of a continuation is held.
  const handle = CampaignRunner.prototype.handle,
    gate = {reached: 0, open: undefined},
    closed = new Promise(resolve => {
      gate.open = resolve;
    });
  CampaignRunner.prototype.handle = async function (input, actor) {
    if (
      input?.action === 'create' &&
      String(input.idempotency_key ?? '').startsWith('continue-') &&
      gate.reached++ === 0
    )
      await closed;
    return handle.call(this, input, actor);
  };
  t.after(() => {
    CampaignRunner.prototype.handle = handle;
  });
  const continuing = x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true});
  for (let i = 0; i < 1000 && gate.reached === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(gate.reached > 0, 'the continuation came to make its new plan');
  const held = x.store.document(googleTenant, 'campaign_run', id);
  assert.equal(held.state, 'superseded', 'the old plan is held');
  assert.equal(held.superseded_by.pending, true);
  assert.equal(held.superseded_by.id, undefined, 'the new plan has no id yet: only the continuation’s key names it');
  const named = refusal => {
    assert.equal(refusal.success, false);
    assert.equal(refusal.error.code, 'INVALID_ARGUMENT', JSON.stringify(refusal.error).slice(0, 300));
    assert.match(refusal.error.message, /superseded by plan [0-9a-f]{64}, which carries its remaining steps/);
    assert.equal(refusal.error.details.next_call.arguments.id, refusal.error.details.superseded_by);
    return refusal.error.details.superseded_by;
  };
  const byRead = named(await x.call('amcp_campaign', {action: 'approval_summary', id})),
    byApprove = named(await x.call('amcp_campaign', {action: 'approve', id}));
  assert.equal(byRead, byApprove, 'the read and the write name the same plan');
  assert.equal(byRead, held.superseded_by.to, 'and it is the plan the hold names');
  gate.open();
  const carried = await continuing;
  assert.equal(carried.success, true, JSON.stringify(carried.error ?? carried).slice(0, 300));
  assert.equal(carried.data.id, byRead, 'the plan the refusals named is the one the continuation made');
  assert.equal(x.store.document(googleTenant, 'campaign_run', id).superseded_by.id, byRead);
  assert.equal(
    named(await x.call('amcp_campaign', {action: 'approval_summary', id})),
    byRead,
    'once the continuation is made, the read is refused in the same words',
  );
});
