import test from 'node:test';
import assert from 'node:assert/strict';
import {conditionalPrograms} from '../dist/src/conditional-programs.js';
import {conditionalProgramFixture as fixture, forecast, insights, date} from './fixtures/conditional-program-data.mjs';
const good = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('conditional discovery exposes exact native read contracts, separate program prerequisites and zero provider requests', async () => {
  const f = fixture();
  try {
    const graph = good(await f.call({action: 'capabilities'}));
    assert.equal(graph.workflows.filter(w => w.kind === 'conditional_program').length, conditionalPrograms.length);
    for (const program of conditionalPrograms) {
      const w = graph.workflows.find(w => w.id === program.id);
      assert.ok(w.contracts.every(c => c.status === 'native_read' && c.local_supported));
      assert.equal(w.accounts[0].program_evidence.status, 'unverified');
      assert.equal(w.accounts[0].next_call.arguments.action, 'program_check');
      assert.equal(w.accounts[0].next_call.arguments.live, false);
      assert.equal(w.accounts[0].local_state, 'ready_for_preflight');
      assert.equal(w.live_qualification, 'unverified');
    }
    const local = good(await f.call({...f.input(), live: false}));
    assert.equal(local.state, 'unverified');
    assert.equal(local.entitlement, 'unverified');
    assert.equal(local.provider_requests, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'readiness').length, 0);
    f.store.putConnection(f.owner, {...f.connections[1], scopes: []}, {accessToken: 'synthetic-dv360'});
    const blocked = good(await f.call(f.input('dv360_advertiser', {})));
    assert.equal(blocked.state, 'blocked');
    assert.deepEqual(blocked.blockers, ['provider_scope:https://www.googleapis.com/auth/display-video']);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('each forecast retains the exact request, budget point, observation and independent entitlement limit', async () => {
  for (const name of ['forecastReaches', 'forecastImpressions', 'forecastLeads']) {
    const f = fixture();
    try {
      const requirements = forecast(name),
        result = good(await f.call(f.input('linkedin_forecast', requirements)));
      assert.equal(result.state, 'observed', JSON.stringify(result));
      assert.equal(result.entitlement, 'unverified');
      assert.equal(result.advertising_writes, 0);
      assert.equal(result.workspace_documents_saved, 0);
      assert.equal(result.provider_requests, 1);
      assert.equal(result.evidence.forecast, name);
      assert.equal(result.evidence.single_point_metric.budgetMicros, 300000000);
      assert.deepEqual(f.calls[0].body.request, requirements.request);
      assert.equal(f.calls[0].method, 'POST');
      assert.equal(f.calls[0].query.action, name);
      assert.match(result.source_reference.source_hash, /^[a-f0-9]{64}$/);
      assert.ok(result.source_reference.requested_at <= result.source_reference.captured_at);
      assert.ok(result.website_path.endsWith('connection_id=' + f.connections[0].id + '&account_id=123'));
      for (const kind of ['campaign_run', 'allocation_preview', 'readiness', 'decision_report'])
        assert.equal(f.store.documents(f.actor.tenantId, kind).length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('audience and advertiser projections preserve exact identity while excluding unrelated native billing data', async () => {
  const f = fixture();
  try {
    const audience = good(await f.call(f.input('linkedin_audience_insights', insights())));
    assert.equal(audience.evidence.total_audience_count, 420000);
    assert.equal(audience.evidence.grouped_by, insights().request.groupBy);
    const advertiser = good(await f.call(f.input('dv360_advertiser', {})));
    assert.deepEqual(advertiser.evidence, {
      advertiser_id: '123',
      partner_id: '9',
      currency: 'USD',
      entity_status: 'ENTITY_STATUS_PAUSED',
    });
    assert.doesNotMatch(JSON.stringify(advertiser), /private display name|billingConfig|synthetic-/);
    assert.equal(advertiser.source_reference.source_request.pathParams.advertiserId, '123');
    assert.equal(f.calls[1].method, 'GET');
    assert.equal(f.calls[1].body, undefined);
  } finally {
    f.store.close();
  }
});

test('a provider access refusal does not invent a missing scope or approve the application', async () => {
  const f = fixture();
  try {
    f.reply(() =>
      Response.json({status: 403, code: 'ACCESS_DENIED', message: 'Private program unavailable'}, {status: 403}),
    );
    const denied = good(await f.call(f.input()));
    assert.equal(denied.state, 'blocked');
    assert.deepEqual(denied.blockers, ['PROVIDER_ACCESS_DENIED']);
    assert.deepEqual(denied.recorded_scopes.missing, []);
    assert.equal(denied.entitlement, 'unverified');
    assert.equal(denied.provider_requests, 1);
    assert.equal(typeof denied.native_error.request_id, 'string');
    assert.equal(f.store.documents(f.actor.tenantId, 'readiness').length, 0);
  } finally {
    f.store.close();
  }
});

test('native observations project only selected fields and preserve valid suppressed audience evidence', async () => {
  const f = fixture();
  try {
    f.reply(() =>
      Response.json({
        value: {
          reachCurve: {
            metricCurve: [{budgetMicros: 100000000, metricValue: 2, privateMember: 'must not escape'}],
            singlePointMetric: {budgetMicros: 300000000, metricValue: 7, debugSecret: 'must not escape'},
          },
          privateMember: 'must not escape',
        },
      }),
    );
    const out = good(await f.call(f.input()));
    assert.equal(out.evidence.metric_curve[0].metricValue, 2);
    assert.doesNotMatch(JSON.stringify(out), /privateMember|debugSecret|must not escape/);
    for (const totalAudienceCount of [0, 100000000, 125000000]) {
      f.reply(() => Response.json({value: {totalAudienceCount, privateMember: 'must not escape'}}));
      const suppressed = good(await f.call(f.input('linkedin_audience_insights', insights())));
      assert.equal(suppressed.evidence.total_audience_count, totalAudienceCount);
      assert.equal(suppressed.evidence.grouped_by, null);
      assert.equal(suppressed.evidence.segmentations, null);
      assert.equal(suppressed.evidence.audience_range, 'outside_supported_range');
      assert.equal(suppressed.entitlement, 'unverified');
      assert.doesNotMatch(JSON.stringify(suppressed), /privateMember|must not escape/);
    }
    f.reply(() =>
      Response.json({
        value: {
          totalAudienceCount: 420000,
          audienceInsight: {
            groupedBy: insights().request.groupBy,
            segmentations: [
              {
                value: 'urn:li:function:4',
                entityCount: 96000,
                entityPercentage: 23,
                memberRecords: ['must not escape'],
              },
            ],
          },
        },
      }),
    );
    const audience = good(await f.call(f.input('linkedin_audience_insights', insights())));
    assert.deepEqual(audience.evidence.segmentations, [
      {value: 'urn:li:function:4', entityCount: 96000, entityPercentage: 23},
    ]);
    assert.doesNotMatch(JSON.stringify(audience), /memberRecords|must not escape/);
    for (const value of [
      {totalAudienceCount: 420000},
      {
        totalAudienceCount: 420000,
        audienceInsight: {
          groupedBy: insights().request.groupBy,
          segmentations: [{value: '', entityCount: 2, entityPercentage: 0}],
        },
      },
      {
        totalAudienceCount: 420000,
        audienceInsight: {
          groupedBy: insights().request.groupBy,
          segmentations: [{value: 'urn:li:function:4', entityCount: 2, entityPercentage: 0.5}],
        },
      },
      {
        totalAudienceCount: 0,
        audienceInsight: {
          groupedBy: insights().request.groupBy,
          segmentations: [{value: 'urn:li:function:4', entityCount: 0, entityPercentage: 0}],
        },
      },
    ]) {
      f.reply(() => Response.json({value}));
      const invalid = await f.call(f.input('linkedin_audience_insights', insights()));
      assert.equal(invalid.success, false);
      assert.equal(invalid.error.code, 'PROGRAM_EVIDENCE_INVALID');
    }
  } finally {
    f.close();
  }
});

test('wrong scope, selectors, targeting, money, write-shaped arguments and dates fail before egress', async () => {
  for (const edit of [
    i => {
      i.workflow_id = 'program:other';
    },
    i => {
      i.account_id = '456';
    },
    i => {
      i.connection_id = 'dv360';
    },
    i => {
      i.confirmed = true;
    },
    i => {
      i.requirements.forecast = 'createMediaPlan';
    },
    i => {
      i.requirements.request.sponsoredAccountUrn = 'urn:li:sponsoredAccount:456';
    },
    i => {
      i.requirements.request.currencyCode = 'SAR';
    },
    i => {
      i.requirements.request.targetBudgetMicros = 9007199254740992;
    },
    i => {
      i.requirements.request.targetBudgetMicros = 99999999;
    },
    i => {
      i.requirements.request.startDateOn = date(-1);
    },
    i => {
      delete i.requirements.request.targetingCriteria.include;
    },
    i => {
      i.requirements.native_request = {method: 'POST', path: '/rest/mediaPlans'};
    },
  ]) {
    const f = fixture();
    try {
      const input = f.input();
      edit(input);
      const out = await f.call(input);
      assert.ok(
        !out.success || (out.data.state === 'unverified' && out.data.provider_requests === 0),
        JSON.stringify(out),
      );
      assert.equal(f.calls.length, 0);
      assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('malformed or mismatched native program evidence never becomes an observed result', async () => {
  for (const value of [
    {},
    {other: {}},
    {reachCurve: {metricCurve: []}},
    {reachCurve: {metricCurve: [{budgetMicros: 100000000, metricValue: -1}]}},
    {
      reachCurve: {
        metricCurve: [{budgetMicros: 100000000, metricValue: 1}],
        singlePointMetric: {budgetMicros: 200000000, metricValue: 2},
      },
    },
    {
      reachCurve: {
        metricCurve: [
          {budgetMicros: 100000000, metricValue: 1},
          {budgetMicros: 100000000, metricValue: 2},
        ],
        singlePointMetric: {budgetMicros: 300000000, metricValue: 2},
      },
    },
    {
      reachCurve: {
        metricCurve: [{budgetMicros: 100000000, metricValue: 1, metricLower: 2}],
        singlePointMetric: {budgetMicros: 300000000, metricValue: 2},
      },
    },
  ]) {
    const f = fixture();
    try {
      f.reply(() => Response.json({value}));
      const out = await f.call(f.input());
      assert.equal(out.success, false);
      assert.equal(out.error.code, 'PROGRAM_EVIDENCE_INVALID');
    } finally {
      f.store.close();
    }
  }
  for (const [id, requirements, data] of [
    ['dv360_advertiser', {}, {advertiserId: '456', partnerId: '9', generalConfig: {currencyCode: 'USD'}}],
    ['dv360_advertiser', {}, {advertiserId: '123', partnerId: 9, generalConfig: {currencyCode: 'USD'}}],
    [
      'linkedin_audience_insights',
      insights(),
      {value: {totalAudienceCount: 420000, audienceInsight: {groupedBy: 'wrong', segmentations: []}}},
    ],
  ]) {
    const f = fixture();
    try {
      f.reply(() => Response.json(data));
      assert.equal((await f.call(f.input(id, requirements))).success, false);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn audience observations retain documented total and segment suppression boundaries', async () => {
  for (const [total, count, accepted] of [
    [1, null, false],
    [299, null, false],
    [299, 30, false],
    [300, 0, false],
    [300, 29, false],
    [300, 30, true],
    [99999999, 30, true],
    [100000000, 30, false],
  ]) {
    const f = fixture();
    try {
      const request = insights();
      f.reply(() =>
        Response.json({
          value: {
            totalAudienceCount: total,
            ...(count === null
              ? {}
              : {
                  audienceInsight: {
                    groupedBy: request.request.groupBy,
                    segmentations: [
                      {
                        value: 'urn:li:function:4',
                        entityCount: count,
                        entityPercentage: Math.round((count * 100) / total),
                      },
                    ],
                  },
                }),
          },
        }),
      );
      const out = await f.call(f.input('linkedin_audience_insights', request));
      assert.equal(out.success, accepted, JSON.stringify({total, count, out}));
      if (accepted) {
        assert.equal(out.data.state, 'observed');
        assert.equal(out.data.evidence.audience_range, 'within_supported_range');
        assert.equal(out.data.evidence.total_audience_count, total);
        assert.equal(out.data.entitlement, 'unverified');
      } else assert.equal(out.error.code, 'PROGRAM_EVIDENCE_INVALID');
      assert.equal(f.calls.length, 1);
      assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('revocation and credential replacement during a program read preserve the authority fence', async () => {
  for (const change of [
    f => f.store.revokeKey(f.key),
    f => f.store.putConnection(f.owner, f.connections[0], {accessToken: 'replacement'}),
    f =>
      f.store.putConnection(
        f.owner,
        {...f.connections[0], scopes: []},
        {accessToken: 'synthetic-' + f.connections[0].id},
      ),
  ]) {
    const f = fixture();
    try {
      f.hook(() => change(f));
      assert.equal((await f.call(f.input())).success, false);
      assert.equal(f.calls.length, 1);
    } finally {
      f.store.close();
    }
  }
});
