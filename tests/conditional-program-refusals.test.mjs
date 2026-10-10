// PRV-02: a refused LinkedIn program read keeps the provider's HTTP status, its documented code as a closed set, the
// prerequisite that code names (worded as reported by LinkedIn) and LinkedIn's x-li-uuid. Before this change the two
// documented 403 bodies (ACCESS_DENIED, USER_NOT_AUTHORIZED) gave byte-identical results with only AMCP's own request
// ID, and a forecast whose singlePointMetric followed LinkedIn's schema table (an array) was refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import {conditionalProgramFixture as fixture, forecast, insights} from './fixtures/conditional-program-data.mjs';
import {AssetDiscovery} from '../dist/server/asset-discovery.js';

const good = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
const refusal = (code, headers = {'x-li-uuid': 'AAYz-li-uuid_01'}) =>
  Response.json(
    {status: 403, ...(code ? {code} : {}), serviceErrorCode: 100, message: 'Private message from LinkedIn ' + code},
    {status: 403, headers},
  );

test('the two documented LinkedIn 403 bodies give distinct provider codes and reported prerequisites', async () => {
  const seen = [];
  for (const [workflow, requirements] of [
    ['linkedin_forecast', forecast()],
    ['linkedin_audience_insights', insights()],
  ])
    for (const [code, prerequisite] of [
      ['ACCESS_DENIED', 'private_application_product'],
      ['USER_NOT_AUTHORIZED', 'member_account_access'],
    ]) {
      const f = fixture();
      try {
        f.reply(() => refusal(code));
        const out = good(await f.call(f.input(workflow, requirements)));
        assert.equal(out.state, 'blocked');
        assert.equal(out.entitlement, 'unverified');
        assert.deepEqual(out.blockers, ['PROVIDER_ACCESS_DENIED']);
        assert.equal(out.native_error.code, 'PROVIDER_ACCESS_DENIED');
        assert.equal(out.native_error.http_status, 403);
        assert.equal(out.native_error.provider_code, code);
        assert.equal(out.native_error.provider_request_id, 'AAYz-li-uuid_01');
        assert.equal(typeof out.native_error.amcp_request_id, 'string');
        assert.equal(out.native_error.request_id, out.native_error.amcp_request_id, 'one-release alias');
        assert.equal(out.provider_reported_prerequisite.prerequisite_id, prerequisite);
        assert.equal(out.provider_reported_prerequisite.provider_code, code);
        assert.match(out.provider_reported_prerequisite.reference, /^https:\/\/learn\.microsoft\.com\//);
        assert.match(out.provider_reported_prerequisite.meaning, /infers no other cause/);
        // No free provider text or unlisted upstream property is retained.
        assert.doesNotMatch(JSON.stringify(out), /Private message|serviceErrorCode|upstream/);
        assert.equal(f.calls.length, 1);
        seen.push(JSON.stringify([out.native_error.provider_code, out.provider_reported_prerequisite]));
      } finally {
        f.close();
      }
    }
  assert.equal(new Set(seen.slice(0, 2)).size, 2, 'distinct results for the two documented bodies');
});

test('an undocumented or absent provider code is not mapped, and a malformed request reference is dropped', async () => {
  for (const [code, headers, expected] of [
    ['SOMETHING_ELSE', {'x-li-uuid': 'has spaces in it'}, 'OTHER'],
    ['', {'x-li-request-id': 'legacy-request.1'}, 'OTHER'],
    ['access denied', {'x-li-uuid': 'x'.repeat(129)}, 'OTHER'],
  ]) {
    const f = fixture();
    try {
      f.reply(() => refusal(code, headers));
      const out = good(await f.call(f.input()));
      assert.equal(out.state, 'blocked');
      assert.equal(out.native_error.http_status, 403);
      // serviceErrorCode 100 is the only token when no code is sent; any unlisted code is OTHER.
      assert.equal(out.native_error.provider_code, expected);
      assert.equal(out.provider_reported_prerequisite, undefined);
      assert.equal(out.native_error.provider_request_id, headers['x-li-request-id'] ?? null);
      assert.equal(out.entitlement, 'unverified');
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    f.reply(() => Response.json({message: 'no code'}, {status: 403}));
    const out = good(await f.call(f.input()));
    assert.equal(out.native_error.provider_code, null);
    assert.equal(out.native_error.provider_request_id, null);
  } finally {
    f.close();
  }
});

const curve = singlePointMetric => ({
  value: {
    reachCurve: {
      metricCurve: [
        {budgetMicros: 100000000, metricValue: 1000},
        {budgetMicros: 300000000, metricValue: 2500},
      ],
      singlePointMetric,
    },
    costPerReach: {singlePointMetric: [{budgetMicros: 300000000, metricValue: 0.12}]},
    costPerThousandImpressions: {singlePointMetric: {budgetMicros: 300000000, metricValue: 9.5}},
    averageFrequency: {singlePointMetric: {budgetMicros: 200000000, metricValue: 2.1}},
    costPerLead: 'not a forecast metric',
  },
});

test('a forecast single point is accepted as an object or a one-element array with the exact budget', async () => {
  for (const single of [{budgetMicros: 300000000, metricValue: 2500}, [{budgetMicros: 300000000, metricValue: 2500}]]) {
    const f = fixture();
    try {
      f.reply(() => Response.json(curve(single)));
      const out = good(await f.call(f.input()));
      assert.equal(out.state, 'observed');
      assert.deepEqual(out.evidence.single_point_metric, {budgetMicros: 300000000, metricValue: 2500});
      const estimates = out.evidence.directional_estimates;
      assert.deepEqual(estimates.points, {
        costPerReach: {budgetMicros: 300000000, metricValue: 0.12},
        costPerThousandImpressions: {budgetMicros: 300000000, metricValue: 9.5},
      });
      // A budget mismatch and an unrecognized shape are unavailable, never zero.
      assert.deepEqual(estimates.unavailable, ['costPerLead', 'averageFrequency']);
      assert.match(estimates.meaning, /Directional/);
      assert.match(out.source_reference.source_hash, /^[a-f0-9]{64}$/);
    } finally {
      f.close();
    }
  }
  for (const single of [
    [
      {budgetMicros: 300000000, metricValue: 2500},
      {budgetMicros: 300000000, metricValue: 2600},
    ],
    [],
    [{budgetMicros: 200000000, metricValue: 2500}],
    {budgetMicros: 200000000, metricValue: 2500},
  ]) {
    const f = fixture();
    try {
      f.reply(() => Response.json(curve(single)));
      const out = await f.call(f.input());
      assert.equal(out.success, false, JSON.stringify(single));
      assert.equal(out.error.code, 'PROGRAM_EVIDENCE_INVALID');
    } finally {
      f.close();
    }
  }
});

test('discovery keeps the member role with its observation time and capabilities expose it as evidence', async () => {
  const f = fixture();
  try {
    const connection = f.connections[0],
      before = Date.now();
    const discovery = new AssetDiscovery(f.store, async url => {
      const u = new URL(String(url));
      if (u.pathname === '/rest/adAccountUsers')
        return Response.json({
          elements: [
            {account: 'urn:li:sponsoredAccount:123', role: 'CAMPAIGN_MANAGER'},
            {account: 'urn:li:sponsoredAccount:456', role: 'free text role'},
          ],
          paging: {start: 0, count: 100, total: 2, links: []},
        });
      return Response.json({id: Number(u.pathname.split('/').pop()), name: 'Account', currency: 'USD'});
    });
    const result = await discovery.sync(connection);
    const assets = Object.fromEntries(result.groups[0].assets.map(a => [a.id, a]));
    assert.equal(assets['123'].linkedinRole, 'CAMPAIGN_MANAGER');
    assert.ok(assets['123'].linkedinRoleObservedAt >= before);
    assert.equal(assets['456'].linkedinRole, undefined, 'only a closed-set role token is retained');
    const graph = good(await f.call({action: 'capabilities', workflow_id: 'program:linkedin_forecast'}));
    assert.equal(graph.workflows[0].accounts[0].program_evidence.member_account_access.status, 'not_observed');
    f.store.putDocument(f.actor.tenantId, 'website_assets', connection.id, {groups: result.groups});
    const observed = good(await f.call({action: 'capabilities', workflow_id: 'program:linkedin_forecast'}));
    const evidence = observed.workflows[0].accounts[0].program_evidence;
    assert.equal(evidence.status, 'unverified');
    assert.equal(evidence.member_account_access.role, 'CAMPAIGN_MANAGER');
    assert.equal(evidence.member_account_access.observed_at, assets['123'].linkedinRoleObservedAt);
    assert.match(evidence.member_account_access.meaning, /not current access/);
    const dv360 = good(await f.call({action: 'capabilities', workflow_id: 'program:dv360_advertiser'}));
    assert.equal(dv360.workflows[0].accounts[0].program_evidence.member_account_access, undefined);
  } finally {
    f.close();
  }
});
