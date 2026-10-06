import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
export const date = offset => {
  const d = new Date(Date.now() + offset * 86400000);
  return {year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate()};
};
export const forecast = (name = 'forecastReaches') => ({
  forecast: name,
  request: {
    sponsoredAccountUrn: 'urn:li:sponsoredAccount:123',
    currencyCode: 'USD',
    objectiveType: 'BRAND_AWARENESS',
    targetBudgetMicros: 300000000,
    targetingCriteria: {include: {and: [{or: {'urn:li:adTargetingFacet:locations': ['urn:li:geo:105080838']}}]}},
    startDateOn: date(2),
    endDateOn: date(20),
  },
});
export const insights = () => ({
  request: {
    requestMetaData: {sponsoredAccountUrn: 'urn:li:sponsoredAccount:123'},
    targetingCriteria: {
      include: {
        and: [
          ...forecast().request.targetingCriteria.include.and,
          {or: {'urn:li:adTargetingFacet:skills': ['urn:li:skill:236']}},
        ],
      },
    },
    groupBy: 'urn:li:adTargetingFacet:jobFunctions',
    maxReturnCount: 5,
  },
});
export function conditionalProgramFixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 86).toString('base64'));
  const owner = {tenantId: 'program-tests', userId: 'owner', role: 'admin'},
    key = store.createKey({tenantId: owner.tenantId, userId: 'reader', role: 'reader'}),
    actor = store.authenticate(key),
    connections = ['linkedin', 'dv360'].map(name => ({
      id: name === 'linkedin' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
      tenantId: actor.tenantId,
      gateway: name + '_native_action',
      accounts: ['123'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic ' + name,
      scopes: name === 'dv360' ? ['https://www.googleapis.com/auth/display-video'] : ['r_ads'],
    }));
  for (const c of connections) store.putConnection(owner, c, {accessToken: 'synthetic-' + c.id});
  let hook = () => {},
    reply,
    calls = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const u = new URL(url),
        body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({path: u.pathname, method: init.method, query: Object.fromEntries(u.searchParams), body});
      await hook();
      if (reply) return reply(u, body);
      if (u.pathname === '/v4/advertisers/123')
        return Response.json({
          advertiserId: '123',
          partnerId: '9',
          entityStatus: 'ENTITY_STATUS_PAUSED',
          generalConfig: {currencyCode: 'USD'},
          displayName: 'private display name',
          billingConfig: {private: 'not projected'},
        });
      if (u.pathname === '/rest/targetingAudienceInsights')
        return Response.json({
          value: {
            totalAudienceCount: 420000,
            audienceInsight: {
              groupedBy: body.request.groupBy,
              segmentations: [{value: 'urn:li:function:4', entityCount: 96000, entityPercentage: 23}],
            },
          },
        });
      assert.equal(u.pathname, '/rest/mediaPlanning');
      const field = {forecastReaches: 'reachCurve', forecastImpressions: 'impressionCurve', forecastLeads: 'leadCurve'}[
        u.searchParams.get('action')
      ];
      return Response.json({
        value: {
          [field]: {
            metricCurve: [
              {budgetMicros: 100000000, metricValue: 1000, metricLower: 900, metricUpper: 1100},
              {budgetMicros: 300000000, metricValue: 2500},
            ],
            singlePointMetric: {budgetMicros: 300000000, metricValue: 2500},
          },
        },
      });
    }),
    undefined,
    {allowWrites: false, requireBeforeState: true, maxBudgetChange: 0},
  );
  const input = (id = 'linkedin_forecast', requirements = forecast()) => ({
    action: 'program_check',
    workflow_id: 'program:' + id,
    connection_id: id.startsWith('dv360') ? connections[1].id : connections[0].id,
    account_id: '123',
    requirements,
    live: true,
  });
  return {
    keyByte: 86,
    close: () => store.close(),
    service,
    store,
    owner,
    actor,
    key,
    connections,
    calls,
    input,
    call: (i, who = actor) => service.call('amcp_workspace', i, who),
    hook: f => {
      hook = f;
    },
    reply: f => {
      reply = f;
    },
  };
}
