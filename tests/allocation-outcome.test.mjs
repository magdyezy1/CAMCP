// DEC-02: the outcome review of a verified allocation plan, beside its proposal. Synthetic Google answers behind the
// real service and transport; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {
  allocationOutcomeJob,
  allocationOutcomeKind,
  allocationOutcomeLimit,
  allocationOutcomeWindow,
  verifiedAllocationExecution,
} from '../dist/src/allocation-outcome.js';
import {allocationReport} from './fixtures/allocation-data.mjs';

const day = 86400000;
const customer = {id: '123', resourceName: 'customers/123', currencyCode: 'USD', timeZone: 'UTC'};
const good = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
/** Runs fn with the clock moved by offset milliseconds (the clock keeps moving). */
async function later(offset, fn) {
  const real = Date.now;
  Date.now = () => real() + offset;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 87).toString('base64'));
  const identity = {tenantId: 'allocation-outcome', userId: 'operator', role: 'operator'},
    key = store.createKey(identity),
    actor = store.authenticate(key);
  const connection = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway: 'google_ads_native_action',
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const evidence = allocationReport();
  store.putDocument(actor.tenantId, 'decision_report', 'source', {
    ...evidence,
    gateway: connection.gateway,
    preset: 'google_campaign',
    connection_id: connection.id,
    account_id: '123',
    // The definitions the guided Google preset itself retains, so the outcome capture can match them.
    semantics: {
      ...evidence.semantics,
      attribution: 'Google data-driven, 30-day click',
      conversion_definition: 'metrics.conversions',
    },
  });
  const budgets = ['10', '20'].map(id => ({
    customer,
    campaign: {
      id,
      resourceName: 'customers/123/campaigns/' + id,
      name: 'Campaign ' + id,
      status: 'ENABLED',
      campaignBudget: 'customers/123/campaignBudgets/1' + id,
    },
    campaignBudget: {
      resourceName: 'customers/123/campaignBudgets/1' + id,
      amountMicros: '200000000',
      explicitlyShared: false,
      referenceCount: '1',
      period: 'DAILY',
      status: 'ENABLED',
    },
  }));
  // Outcome-window rows: [campaign id, offset of the day in the window, cost, conversions].
  let outcome = [];
  const requests = [];
  let allowMutation = false;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({url: String(url), query: body.query});
      if (String(url).endsWith('/googleAds:search')) {
        const q = body.query;
        if (q.includes(' FROM campaign_budget'))
          return Response.json({
            results: budgets
              .filter(r => q.includes(r.campaignBudget.resourceName))
              .map(r => ({campaignBudget: r.campaignBudget})),
          });
        if (q.includes(' FROM customer')) return Response.json({results: [{customer}], totalResultsCount: '1'});
        const window = /segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(q);
        if (window) {
          const results = outcome.map(([id, offset, cost, conversions]) => ({
            customer,
            campaign: {id, resourceName: 'customers/123/campaigns/' + id, name: 'Campaign ' + id},
            segments: {date: new Date(Date.parse(window[1] + 'T00:00:00Z') + offset * day).toISOString().slice(0, 10)},
            metrics: {
              costMicros: String(cost * 1000000),
              clicks: '10',
              impressions: '100',
              conversions,
              conversionsValue: 0,
            },
          }));
          return Response.json({results, totalResultsCount: String(results.length)});
        }
        const match = q.match(/campaign.id IN \(([^)]+)\)/);
        return Response.json({results: budgets.filter(r => match[1].split(',').includes(r.campaign.id))});
      }
      if (allowMutation && String(url).endsWith('/campaignBudgets:mutate')) {
        const results = body.operations.map(op => {
          const row = budgets.find(r => r.campaignBudget.resourceName === op.update.resourceName);
          row.campaignBudget.amountMicros = op.update.amountMicros;
          return {resourceName: row.campaignBudget.resourceName};
        });
        return Response.json({results});
      }
      throw Error('Unexpected provider request ' + url);
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const options = {
    budget: '200',
    efficiency_low: 0.8,
    efficiency_high: 1.2,
    maximum_age_days: 7,
    minimum_conversions: 5,
    allocations: [
      {entity_id: '10', minimum: '25', maximum: '125'},
      {entity_id: '20', minimum: '50', maximum: '175'},
    ],
  };
  const call = (tool, input, who = actor) => service.call(tool, input, who);
  // Previews, drafts, approves step by step and verifies both budget steps: a verified allocation execution.
  const executed = async () => {
    const p = good(
      await call('amcp_reporting', {
        action: 'preview_allocation_plan',
        id: 'source',
        options,
        conversion: 'equal_daily',
      }),
    );
    const created = good(
      await call('amcp_reporting', {
        action: 'create_allocation_plan',
        id: 'source',
        preview_id: p.preview_id,
        preview_hash: p.preview_hash,
        confirmed: true,
      }),
    );
    allowMutation = true;
    for (let i = 0; i < 2; i++) {
      const prepared = good(await call('amcp_campaign', {action: 'prepare_next', id: created.id}));
      const result = good(
        await call('amcp_campaign', {
          action: 'execute_next',
          id: created.id,
          review_id: prepared.review.review_id,
          idempotency_key: prepared.review.review_id,
          confirmed: true,
          spend_change_confirmed: true,
        }),
      );
      assert.equal(result.current.status, 'verified', JSON.stringify(result));
    }
    allowMutation = false;
    return created.id;
  };
  return {
    store,
    actor,
    key,
    connection,
    service,
    call,
    executed,
    requests,
    setOutcome: rows => {
      outcome = rows;
    },
    outcomeDoc: id => store.document(actor.tenantId, allocationOutcomeKind, id),
    view: (id, who) => call('amcp_reporting', {action: 'allocation_outcome', id}, who),
    capture: (id, who) => call('amcp_reporting', {action: 'capture_allocation_outcome', id}, who),
  };
}
/** Milliseconds after which the outcome window of `doc` has closed (plus an hour). */
const afterWindow = doc => doc.due_at - Date.now() + 3600000;

test('a verified allocation execution schedules its outcome review for the next comparable closed period', async () => {
  const f = fixture();
  try {
    const id = await f.executed(),
      doc = f.outcomeDoc(id),
      run = f.store.document(f.actor.tenantId, 'campaign_run', id),
      executedAt = Math.max(...run.steps.map(s => s.verification.checked_at)),
      since = new Date(Date.parse(new Date(executedAt).toISOString().slice(0, 10)) + day).toISOString().slice(0, 10),
      until = new Date(Date.parse(since) + day).toISOString().slice(0, 10);
    assert.equal(doc.state, 'scheduled');
    assert.equal(doc.executed_at, executedAt);
    // The reference period has two days, so the window is the two account-local (UTC) days after the execution.
    assert.deepEqual(doc.window, {since, until, days: 2, timezone: 'UTC'});
    assert.equal(doc.due_at, Date.parse(until) + day);
    assert.equal(doc.automatic, true);
    assert.equal(doc.modeled.model_fingerprint, run.allocation.model_fingerprint);
    assert.deepEqual(
      doc.modeled.entities.map(e => [e.entity_id, e.proposed_budget, e.observed_spend, e.observed_conversions]),
      [
        ['10', '125', '100', '20'],
        ['20', '75', '100', '10'],
      ],
    );
    assert.equal(doc.capture.preset, 'google_campaign');
    const job = f.store.db
      .prepare('SELECT available_at,input FROM jobs WHERE tenant_id=? AND kind=?')
      .get(f.actor.tenantId, allocationOutcomeKind);
    assert.equal(job.available_at, doc.due_at);
    assert.deepEqual(JSON.parse(job.input), {plan_id: id});
    const shown = good(await f.view(id));
    assert.equal(shown.state, 'scheduled');
    assert.equal(shown.network_requests, 0);
    assert.equal(shown.actor_binding, undefined, 'the sealed job authority is never shown');
    assert.equal(shown.next_call, undefined);
    // Seeing it again keeps the one record and the one job.
    good(await f.view(id));
    assert.equal(f.store.documents(f.actor.tenantId, allocationOutcomeKind).length, 1);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs WHERE kind=?').get(allocationOutcomeKind).n, 1);
  } finally {
    f.store.close();
  }
});

test('the outcome is never captured before its window has closed in the account time zone', async () => {
  const f = fixture();
  try {
    const id = await f.executed(),
      doc = f.outcomeDoc(id),
      before = f.requests.length;
    for (const offset of [0, doc.due_at - Date.now() - 3600000]) {
      const refused = await later(offset, () => f.capture(id));
      assert.equal(refused.success, false);
      assert.equal(refused.error.code, 'ALLOCATION_OUTCOME_NOT_DUE');
      assert.deepEqual(refused.error.details.window, doc.window);
    }
    assert.equal(f.requests.length, before, 'nothing is read before the window closes');
    assert.equal(f.outcomeDoc(id).state, 'scheduled');
  } finally {
    f.store.close();
  }
});

test('after the window closes the same entities are captured and compared with the proposal, exactly', async () => {
  const f = fixture();
  try {
    const id = await f.executed(),
      doc = f.outcomeDoc(id);
    f.setOutcome([
      ['10', 0, 60, 13],
      ['10', 1, 64, 15],
      ['20', 0, 30, 2],
      ['20', 1, 35, 2],
    ]);
    const before = f.requests.length,
      shown = await later(afterWindow(doc), async () => good(await f.view(id)));
    assert.equal(shown.state, 'due', 'a closed window is shown as due');
    assert.equal(shown.next_call.arguments.action, 'capture_allocation_outcome');
    const out = await later(afterWindow(doc), async () => good(await f.capture(id)));
    assert.equal(out.state, 'complete');
    // The guided capture asked for exactly the outcome window.
    const asked = f.requests.slice(before).find(r => r.query?.includes('segments.date BETWEEN'));
    assert.ok(asked.query.includes(`BETWEEN '${doc.window.since}' AND '${doc.window.until}'`));
    const [first, second] = out.entities;
    // Campaign 10: 124 spent of 125 proposed; 28 conversions inside the modeled 20–30.
    assert.deepEqual(
      {...first, name: undefined},
      {
        entity_id: '10',
        name: undefined,
        days_with_rows: 2,
        proposed_budget: '125',
        realized_spend: '124',
        spend_to_proposed: '0.992',
        realized_conversions: '28',
        modeled_conversions_low: '20',
        modeled_conversions_high: '30',
        position: 'within',
        spend_conditioned_low: '19.84',
        spend_conditioned_high: '29.76',
        spend_conditioned_position: 'within',
        realized_factor: '1.129032258',
      },
    );
    // Campaign 20: 4 conversions, below both ranges; 65/75 rounds half to even at nine places.
    assert.equal(second.spend_to_proposed, '0.866666667');
    assert.equal(second.modeled_conversions_low, '6');
    assert.equal(second.modeled_conversions_high, '9');
    assert.equal(second.position, 'below');
    assert.equal(second.spend_conditioned_low, '5.2');
    assert.equal(second.spend_conditioned_position, 'below');
    assert.equal(second.realized_factor, '0.615384615');
    assert.deepEqual(out.totals, {
      entity_count: 2,
      proposed_budget: '200',
      realized_spend: '189',
      spend_to_proposed: '0.945',
      realized_conversions: '32',
      modeled_conversions_low: '26',
      modeled_conversions_high: '39',
      position: 'within',
      spend_conditioned_low: '25.04',
      spend_conditioned_high: '37.56',
      spend_conditioned_position: 'within',
      realized_factor: '1.022364217',
      basis: 'sums of the entity values',
    });
    assert.match(out.limitations[0], /does not show that the budget change caused/);
    assert.ok(!out.limitations.some(l => /fewer days|no reported rows/.test(l)));
    assert.equal(out.rounding, 'nine decimal places, half to even');
    // The capture is retained guided evidence of the window, offered for later proposals and calibration.
    const evidence = f.store.document(f.actor.tenantId, 'decision_report', out.outcome_report_id);
    assert.equal(evidence.preset, 'google_campaign');
    assert.equal(evidence.semantics.date_from, doc.window.since);
    assert.equal(evidence.semantics.date_to, doc.window.until);
    assert.equal(evidence.semantics.complete, true);
    assert.equal(out.calibration_evidence.report_id, evidence.id);
    assert.equal(out.calibration_evidence.calibration_ready, false, 'two days are too few to calibrate');
    assert.equal(out.calibration_evidence.next_call, undefined);
    // A second capture returns the saved outcome without reading again.
    const reads = f.requests.length,
      again = await later(afterWindow(doc), async () => good(await f.capture(id)));
    assert.equal(f.requests.length, reads);
    assert.equal(again.completed_at, out.completed_at);
  } finally {
    f.store.close();
  }
});

test('an entity without outcome rows stays unknown and partial days are named, never counted as zero', async () => {
  const f = fixture();
  try {
    const id = await f.executed(),
      doc = f.outcomeDoc(id);
    f.setOutcome([['10', 1, 50, 9]]);
    const out = await later(afterWindow(doc), async () => good(await f.capture(id)));
    const [first, second] = out.entities;
    assert.equal(first.days_with_rows, 1);
    assert.equal(first.realized_conversions, '9');
    assert.equal(first.position, 'below');
    assert.equal(second.days_with_rows, 0);
    assert.equal(second.realized_spend, null);
    assert.equal(second.realized_conversions, null);
    assert.equal(second.position, 'unknown');
    assert.equal(second.realized_factor, null);
    assert.equal(out.totals.realized_conversions, null);
    assert.equal(out.totals.position, 'unknown');
    assert.ok(out.limitations.some(l => /no reported rows in the outcome window/.test(l)));
    assert.ok(out.limitations.some(l => /fewer days than the outcome window/.test(l)));
  } finally {
    f.store.close();
  }
});

test('a plan that is not complete, or whose steps were not all verified, has no outcome review', async () => {
  const f = fixture();
  try {
    const p = good(
      await f.call('amcp_reporting', {
        action: 'preview_allocation_plan',
        id: 'source',
        options: {
          budget: '200',
          efficiency_low: 0.8,
          efficiency_high: 1.2,
          maximum_age_days: 7,
          minimum_conversions: 5,
          allocations: [
            {entity_id: '10', minimum: '25', maximum: '125'},
            {entity_id: '20', minimum: '50', maximum: '175'},
          ],
        },
        conversion: 'equal_daily',
      }),
    );
    const draft = good(
      await f.call('amcp_reporting', {
        action: 'create_allocation_plan',
        id: 'source',
        preview_id: p.preview_id,
        preview_hash: p.preview_hash,
        confirmed: true,
      }),
    );
    const shown = good(await f.view(draft.id));
    assert.equal(shown.state, 'not_scheduled');
    assert.equal(shown.reason, 'plan_not_complete');
    const refused = await f.capture(draft.id);
    assert.equal(refused.error.code, 'ALLOCATION_OUTCOME_NOT_READY');
    assert.equal(f.store.documents(f.actor.tenantId, allocationOutcomeKind).length, 0);
  } finally {
    f.store.close();
  }
  const step = (status, verification) => ({id: 's', status, verification});
  for (const [run, reason] of [
    [{steps: [step('verified', {status: 'verified', checked_at: 1})]}, 'not_an_allocation_plan'],
    [
      {allocation: {}, state: 'in_progress', steps: [step('verified', {status: 'verified', checked_at: 1})]},
      'plan_not_complete',
    ],
    [
      {
        allocation: {},
        state: 'complete',
        steps: [step('verified_with_acceptance', {status: 'mismatch', checked_at: 1})],
      },
      'steps_not_verified',
    ],
    [{allocation: {}, state: 'complete', steps: [step('verified', {status: 'verified'})]}, 'steps_not_verified'],
    [{allocation: {}, state: 'complete', steps: []}, 'steps_not_verified'],
  ])
    assert.deepEqual(verifiedAllocationExecution(run), {reason});
  assert.deepEqual(
    verifiedAllocationExecution({
      allocation: {},
      state: 'complete',
      steps: [
        step('verified', {status: 'verified', checked_at: 5}),
        step('verified', {status: 'verified', checked_at: 9}),
      ],
    }),
    {executed_at: 9},
  );
});

test('another person, or a login that lost the account, cannot read or capture the outcome', async () => {
  const f = fixture();
  try {
    const id = await f.executed();
    const other = f.store.authenticate(
      f.store.createKey({tenantId: f.actor.tenantId, userId: 'someone-else', role: 'operator'}),
    );
    for (const result of [await f.view(id, other), await f.capture(id, other)]) {
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'FORBIDDEN');
    }
    // The login no longer selects the plan's account.
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {...f.connection, accounts: ['999'], writeAccounts: ['999']},
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    for (const result of [await f.view(id), await f.capture(id)]) {
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'CONNECTION_REQUIRED');
    }
  } finally {
    f.store.close();
  }
});

test('an outcome whose proposal can no longer be reproduced is recorded unavailable, never compared', async () => {
  const f = fixture();
  try {
    const id = await f.executed();
    // An older plan reviewed for the first time after its evidence was replaced.
    f.store.deleteDocument(f.actor.tenantId, allocationOutcomeKind, id);
    const source = f.store.document(f.actor.tenantId, 'decision_report', 'source');
    f.store.putDocument(f.actor.tenantId, 'decision_report', 'source', {...source, source_hash: 'replaced'});
    const shown = good(await f.view(id));
    assert.equal(shown.state, 'unavailable');
    assert.equal(shown.reason, 'source_report_changed');
    const reads = f.requests.length,
      refused = await f.capture(id);
    assert.equal(refused.error.code, 'ALLOCATION_OUTCOME_UNAVAILABLE');
    assert.equal(refused.error.details.reason, 'source_report_changed');
    assert.equal(f.requests.length, reads, 'nothing is read for an outcome that cannot be compared');
  } finally {
    f.store.close();
  }
});

test('the background review runs as the executing person, retries an unfinalized window and records a revoked identity', async () => {
  const f = fixture();
  try {
    const id = await f.executed(),
      doc = f.outcomeDoc(id),
      jobs = () =>
        f.store.db
          .prepare('SELECT available_at FROM jobs WHERE kind=? ORDER BY available_at')
          .all(allocationOutcomeKind);
    // A provider that has not finalized the window yet: retried an hour later, the attempt recorded.
    const unfinalized = await later(afterWindow(doc), () =>
      allocationOutcomeJob(
        f.store,
        async () => ({success: false, error: {code: 'REPORT_INCOMPLETE', retryable: false}}),
        f.actor.tenantId,
        {plan_id: id},
        () => {},
      ),
    );
    assert.equal(unfinalized.state, 'due');
    assert.equal(f.outcomeDoc(id).attempts, 1);
    assert.equal(f.outcomeDoc(id).last_error.code, 'REPORT_INCOMPLETE');
    assert.ok(unfinalized.next_attempt_at >= doc.due_at + 2 * 3600000);
    assert.equal(jobs().length, 2);
    // The worker dispatch runs the real capture as the bound person.
    f.setOutcome([
      ['10', 0, 62, 14],
      ['20', 1, 70, 7],
    ]);
    const overview = new ReportingOverview(f.service);
    const done = await later(afterWindow(doc), () =>
      overview.work(f.actor.tenantId, allocationOutcomeKind, {plan_id: id}),
    );
    assert.equal(done.state, 'complete');
    assert.equal(f.outcomeDoc(id).state, 'complete');
    assert.equal(f.outcomeDoc(id).entities[1].realized_conversions, '7');
    // A finished review is not run again.
    const again = await later(afterWindow(doc), () =>
      overview.work(f.actor.tenantId, allocationOutcomeKind, {plan_id: id}),
    );
    assert.equal(again.state, 'complete');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    const id = await g.executed(),
      doc = g.outcomeDoc(id);
    g.store.revokeKey(g.key);
    const revoked = await later(afterWindow(doc), () =>
      allocationOutcomeJob(
        g.store,
        (t, a, u) => g.service.call(t, a, u),
        g.actor.tenantId,
        {plan_id: id},
        () => {},
      ),
    );
    assert.equal(revoked.state, 'due');
    assert.equal(revoked.next_attempt_at, null, 'a revoked identity is not retried automatically');
    assert.equal(g.outcomeDoc(id).state, 'due');
    assert.match(g.outcomeDoc(id).last_error.code, /UNAUTHORIZED|REAUTHORIZATION/);
  } finally {
    g.store.close();
  }
});

test('the outcome window follows the account time zone, across daylight saving and fractional offsets', () => {
  // 18:30 on 7 March in New York: the window starts on 8 March (the DST change) and closes at 00:00 EDT on 11 March.
  assert.deepEqual(allocationOutcomeWindow(Date.parse('2026-03-07T23:30:00Z'), 3, 'America/New_York'), {
    since: '2026-03-08',
    until: '2026-03-10',
    days: 3,
    timezone: 'America/New_York',
    due_at: Date.parse('2026-03-11T04:00:00Z'),
  });
  // 01:30 on 2 June in Kolkata (UTC+05:30).
  assert.deepEqual(allocationOutcomeWindow(Date.parse('2026-06-01T20:00:00Z'), 1, 'Asia/Kolkata'), {
    since: '2026-06-03',
    until: '2026-06-03',
    days: 1,
    timezone: 'Asia/Kolkata',
    due_at: Date.parse('2026-06-03T18:30:00Z'),
  });
  assert.throws(() => allocationOutcomeWindow(Date.now(), 0, 'UTC'), {code: 'ALLOCATION_OUTCOME_UNQUALIFIED'});
});

test('at most the bounded number of outcome records is kept; finished ones are removed first', async () => {
  const f = fixture();
  try {
    const id = await f.executed(),
      tenant = f.actor.tenantId;
    f.store.deleteDocument(tenant, allocationOutcomeKind, id);
    f.store.putDocument(tenant, allocationOutcomeKind, 'pending', {
      plan_id: 'pending',
      state: 'scheduled',
      updated_at: 0,
    });
    for (let i = 1; i < allocationOutcomeLimit; i++)
      f.store.putDocument(tenant, allocationOutcomeKind, 'done-' + i, {
        plan_id: 'done-' + i,
        state: 'complete',
        updated_at: i,
      });
    good(await f.view(id));
    const kept = f.store.documents(tenant, allocationOutcomeKind).map(d => d.id);
    assert.equal(kept.length, allocationOutcomeLimit);
    assert.ok(kept.includes('pending'), 'a pending review is kept');
    assert.ok(!kept.includes('done-1'), 'the oldest finished review is removed');
    assert.ok(kept.includes(id));
    // Only pending reviews left: a new one is refused rather than dropping work.
    f.store.deleteDocument(tenant, allocationOutcomeKind, id);
    for (const d of f.store.documents(tenant, allocationOutcomeKind))
      f.store.putDocument(tenant, allocationOutcomeKind, d.id, {...d, state: 'scheduled'});
    f.store.putDocument(tenant, allocationOutcomeKind, 'one-more', {
      plan_id: 'one-more',
      state: 'scheduled',
      updated_at: 1,
    });
    const refused = await f.view(id);
    assert.equal(refused.error.code, 'ALLOCATION_OUTCOME_LIMIT');
  } finally {
    f.store.close();
  }
});
