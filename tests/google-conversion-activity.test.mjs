import test from 'node:test';
import assert from 'node:assert/strict';
import {conversionActivityFixture} from './fixtures/google-conversion-activity-data.mjs';

const inspect = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data.conversion_goal_inspection;
};
const dependency = (out, id = 'reported_conversion_activity') => out.data.dependencies.find(d => d.id === id);

test('both value recipes inspect complete repeated native conversion dates in the original account timezone', async t => {
  for (const recipe of ['google_search_conversion_value', 'google_search_target_roas']) {
    const f = conversionActivityFixture(t, {data: {customer: {timeZone: 'Asia/Riyadh'}}}),
      out = await f.call({
        recipe,
        business: {...f.business, ...(recipe.endsWith('conversion_value') ? {target_roas: undefined} : {})},
      }),
      p = inspect(out);
    assert.equal(p.complete, true);
    assert.equal(p.activity_selected, true);
    assert.deepEqual(p.primary_actions[0].activity, {
      last_conversion_date: '2026-10-01',
      last_tag_received_time: '2026-10-02 13:14:15',
    });
    assert.equal(p.customer.timezone, 'Asia/Riyadh');
    assert.equal(p.summary.primary_last_conversion_known, 1);
    assert.equal(p.summary.primary_last_tag_known, 1);
    assert.equal(dependency(out).status, 'ready');
    assert.equal(out.data.status, 'unknown');
    for (const id of [
      'conversion_event_delivery',
      'conversion_value_delivery',
      'conversion_history_eligibility',
      'provider_objective_acceptance',
    ])
      assert.equal(dependency(out, id).status, 'unknown');
    const refs = p.source_references.filter(r => r.resource === 'conversion_action_activity');
    assert.equal(refs.length, 2);
    assert.ok(refs.every(r => r.rows === 4 && r.pages.length === 2));
    for (const ref of refs)
      assert.equal(
        ref.request.query,
        "SELECT conversion_action.resource_name, metrics.conversion_last_conversion_date, metrics.conversion_last_received_request_date_time FROM conversion_action WHERE conversion_action.status != 'REMOVED'",
      );
    assert.equal(f.data.requests.length, 13);
    assert.equal(p.provider_mutations, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  }
});

test('absent, empty and partial optional date metrics remain independent unknown observations', async t => {
  for (const metrics of [
    undefined,
    null,
    {},
    {conversionLastConversionDate: null, conversionLastReceivedRequestDateTime: ''},
    {conversionLastConversionDate: '2024-02-29'},
    {conversionLastReceivedRequestDateTime: '2026-10-02 01:02:03.123456'},
  ]) {
    const f = conversionActivityFixture(t, {activity: () => metrics}),
      out = await f.call(),
      p = inspect(out);
    assert.equal(p.complete, true);
    assert.equal(dependency(out).status, 'unknown');
    assert.equal(dependency(out, 'conversion_value_configuration').status, 'ready');
    assert.equal(p.primary_actions[0].activity.last_conversion_date, metrics?.conversionLastConversionDate || null);
    assert.equal(
      p.primary_actions[0].activity.last_tag_received_time,
      metrics?.conversionLastReceivedRequestDateTime || null,
    );
    assert.equal(p.summary.primary_last_conversion_known, metrics?.conversionLastConversionDate ? 1 : 0);
    assert.equal(p.summary.primary_last_tag_known, metrics?.conversionLastReceivedRequestDateTime ? 1 : 0);
  }
  const f = conversionActivityFixture(t, {
      transformActivity: ({envelope}) => ({...envelope, results: [], totalResultsCount: '0', nextPageToken: undefined}),
    }),
    out = await f.call(),
    p = inspect(out);
  assert.equal(p.complete, true);
  assert.deepEqual(p.primary_actions[0].activity, {last_conversion_date: null, last_tag_received_time: null});
  assert.equal(dependency(out).status, 'unknown');
});

test('coerced, invalid calendar/time, mixed metrics and mismatched action identities withhold activity proof', async t => {
  for (const value of [
    [],
    false,
    'date',
    {conversionLastConversionDate: 20261001},
    {conversionLastConversionDate: '2026-02-30'},
    {conversionLastConversionDate: '2026-13-01'},
    {conversionLastConversionDate: '0000-01-01'},
    {conversionLastReceivedRequestDateTime: '2026-10-02T01:02:03Z'},
    {conversionLastReceivedRequestDateTime: '2026-10-02 24:00:00'},
    {conversionLastReceivedRequestDateTime: '2026-02-30 13:14:15'},
    {conversionLastReceivedRequestDateTime: '2026-10-02 13:14:15.1234567'},
    {conversions: 3},
    // A resource name belongs to the FROM resource of the row (r25-mf-goals), never to its metrics.
    {conversionLastConversionDate: '2026-10-01', resourceName: 'customers/123/conversionActions/1'},
  ]) {
    const f = conversionActivityFixture(t, {activity: () => value}),
      out = await f.call(),
      p = inspect(out);
    assert.equal(p.complete, false, JSON.stringify(value));
    assert.equal(dependency(out).status, 'unknown');
    assert.equal(p.primary_actions, undefined);
  }
  for (const edit of [
    r => (r.conversionAction.resourceName = 'customers/999/conversionActions/1'),
    r => (r.conversionAction.resourceName = 'customers/123/conversionActions/999'),
    r => (r.conversionAction.name = 'unselected'),
    r => (r.segments = {date: '2026-10-01'}),
  ]) {
    const f = conversionActivityFixture(t, {
        transformActivity: ({envelope}) => {
          edit(envelope.results[0]);
          return envelope;
        },
      }),
      p = inspect(await f.call());
    assert.equal(p.complete, false);
  }
});

test('changed or disappearing activity across complete repeats cannot retain the first observation', async t => {
  for (const missing of [false, true]) {
    const f = conversionActivityFixture(t, {
        activity: (_, pass) => ({
          conversionLastConversionDate: pass === 1 ? '2026-10-01' : '2026-10-02',
          conversionLastReceivedRequestDateTime: '2026-10-02 13:14:15',
        }),
        transformActivity: ({pass, envelope}) =>
          missing && pass === 2 ? {results: [], totalResultsCount: '0'} : envelope,
      }),
      out = await f.call(),
      p = inspect(out);
    assert.equal(p.complete, false);
    assert.equal(p.error.code, 'GOOGLE_GOAL_INSPECTION_CHANGED');
    assert.equal(p.primary_actions, undefined);
    assert.equal(dependency(out).status, 'unknown');
  }
});

test('whole primary collections include unknown dates beyond the twenty displayed actions', async t => {
  const f = conversionActivityFixture(t, {
    data: {pageSize: 5},
    activity: a =>
      a.resourceName.endsWith('/25')
        ? {}
        : {conversionLastConversionDate: '2026-10-01', conversionLastReceivedRequestDateTime: '2026-10-02 13:14:15'},
  });
  f.data.actions.splice(
    0,
    f.data.actions.length,
    ...Array.from({length: 25}, (_, i) => f.data.action(String(i + 1), 'PURCHASE', true)),
  );
  // The final native primary row has unknown activity, even though it is outside the display projection.
  const out = await f.call(),
    p = inspect(out);
  assert.equal(p.complete, true);
  assert.equal(p.primary_actions.length, 20);
  assert.equal(p.summary.matching_primary_actions, 25);
  assert.equal(p.summary.primary_last_conversion_known, 24);
  assert.equal(p.summary.primary_last_tag_known, 24);
  assert.equal(p.display_omissions.primary_actions, 5);
  assert.equal(dependency(out).status, 'unknown');
});

test('readers and disabled-write deployments retain date inspection while revoked login authority refuses it', async t => {
  const f = conversionActivityFixture(t, {allowWrites: false}),
    out = await f.call({}, {...f.actor, role: 'reader'}),
    p = inspect(out);
  assert.equal(p.complete, true);
  assert.equal(out.data.status, 'blocked');
  assert.equal(p.provider_mutations, 0);
  const revoked = conversionActivityFixture(t, {
    afterResponse: ({store, admin, connection, query}) => {
      if (query.includes('metrics.conversion_last_conversion_date'))
        store.putConnection(
          admin,
          {...connection, enabled: false},
          {accessToken: 'synthetic', developerToken: 'synthetic'},
        );
    },
  });
  assert.equal((await revoked.call()).success, false);
});

test('malformed activity pagination or unqualified account timezone refuses complete evidence within original limits', async t => {
  for (const edit of [
    out => (out.totalResultsCount = '999'),
    out => (out.nextPageToken = 'synthetic-page-0'),
    out => out.results.push(out.results[0]),
  ]) {
    const f = conversionActivityFixture(t, {
        transformActivity: ({envelope}) => {
          edit(envelope);
          return envelope;
        },
      }),
      out = await f.call(),
      p = inspect(out);
    assert.equal(p.complete, false);
    assert.equal(dependency(out).status, 'unknown');
    assert.ok(p.network_requests <= 64);
  }
  const f = conversionActivityFixture(t, {data: {customer: {timeZone: 'Unqualified/Zone'}}}),
    p = inspect(await f.call());
  assert.equal(p.complete, false);
});

test('local, conversion-count and shared-customer checks do not select or infer new activity', async t => {
  const f = conversionActivityFixture(t);
  assert.equal((await f.call({live: false})).success, true);
  assert.equal(f.data.requests.length, 0);
  const count = inspect(
    await f.call({
      recipe: 'google_search_conversions',
      business: {...f.business, conversion_value_policy: undefined, target_roas: undefined},
    }),
  );
  assert.equal(count.complete, true);
  assert.equal(count.activity_selected, undefined);
  assert.equal(count.primary_actions[0].activity, undefined);
  assert.ok(f.data.requests.every(r => !r.body.query.includes('metrics.conversion_last')));
  const shared = conversionActivityFixture(t, {
      data: {customer: {conversionTrackingSetting: {googleAdsConversionCustomer: 'customers/999'}}},
    }),
    out = await shared.call();
  assert.equal(inspect(out).complete, false);
  assert.equal(dependency(out).status, 'unknown');
  assert.ok(shared.data.requests.every(r => r.resource === 'customer'));
});
