import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export function googleSearchFixture(t, business, options = {}) {
  const native = options.native === true;
  const actor = {tenantId: 'click-recipe', userId: 'operator', role: 'operator'},
    admin = {...actor, role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 108).toString('base64')),
    requests = [],
    resources = new Map(),
    mutations = [];
  t.after(() => store.close());
  const connection = {
    id: business.connection_id,
    tenantId: actor.tenantId,
    gateway: 'google_ads_native_action',
    accounts: [business.account_id],
    writeAccounts: [business.account_id],
    enabled: true,
    label: 'Synthetic',
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const body = JSON.parse(init.body),
        path = new URL(url).pathname;
      requests.push({url: String(url), body});
      if (!native || / FROM customer(?: |$)/.test(body.query ?? '')) {
        assert.match(String(url), /googleAds:search$/);
        return Response.json({results: [{customer: {id: business.account_id, currencyCode: 'USD', timeZone: 'UTC'}}]});
      }
      const kinds = {
        campaignBudgets: 'campaignBudget',
        campaigns: 'campaign',
        campaignCriteria: 'campaignCriterion',
        adGroups: 'adGroup',
        adGroupCriteria: 'adGroupCriterion',
        adGroupAds: 'adGroupAd',
      };
      if (path.endsWith('googleAds:search')) {
        const from = / FROM ([a-z_]+)/.exec(body.query)?.[1],
          kind = from?.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        if (from === 'geo_target_constant' || from === 'language_constant')
          return Response.json({
            results: (from === 'geo_target_constant'
              ? business.country_criterion_ids
              : business.language_criterion_ids
            ).map(id => ({
              [kind]: {
                id,
                name: 'Synthetic',
                resourceName: (from === 'geo_target_constant' ? 'geoTargetConstants/' : 'languageConstants/') + id,
                countryCode: 'US',
                code: 'en',
                status: 'ENABLED',
              },
            })),
          });
        const names = [...body.query.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]);
        return Response.json({
          results: [...resources.values()]
            .filter(r => r.kind === kind && (!names.length || names.includes(r.value.resourceName)))
            .map(r => ({
              [kind]: r.value,
              ...(kind === 'adGroup' && /\bcampaign\./.test(body.query)
                ? {campaign: resources.get(r.value.campaign)?.value}
                : {}),
            })),
        });
      }
      assert.ok(native);
      const collection = /\/([A-Za-z]+):mutate$/.exec(path)?.[1];
      assert.ok(kinds[collection], path);
      mutations.push({path, body});
      return Response.json({
        results: body.operations.map(op => {
          assert.ok(op.create);
          const id = String(resources.size + 1),
            value = structuredClone(op.create),
            parent = (value.campaign ?? value.adGroup ?? '').split('/').at(-1);
          const resourceName = `customers/${business.account_id}/${collection}/${['campaignCriteria', 'adGroupCriteria', 'adGroupAds'].includes(collection) ? parent + '~' : ''}${id}`;
          Object.assign(value, {resourceName, id});
          if (collection === 'campaigns') {
            value.biddingStrategyType = value.maximizeConversionValue
              ? 'MAXIMIZE_CONVERSION_VALUE'
              : value.maximizeConversions
                ? 'MAXIMIZE_CONVERSIONS'
                : value.targetSpend
                  ? 'TARGET_SPEND'
                  : 'MANUAL_CPC';
            if (options.wrongTarget && value.maximizeConversions) value.maximizeConversions.targetCpaMicros = '9999999';
            if (options.wrongValueTarget && value.maximizeConversionValue)
              value.maximizeConversionValue.targetRoas = 2.5;
            if (options.valueTarget !== undefined && value.maximizeConversionValue)
              value.maximizeConversionValue.targetRoas = options.valueTarget;
            if (options.omitValueTarget && value.maximizeConversionValue)
              delete value.maximizeConversionValue.targetRoas;
            if (options.omitValueMessage) delete value.maximizeConversionValue;
            if (options.wrongStrategy) {
              value.biddingStrategyType = 'TARGET_SPEND';
              delete value.manualCpc;
              delete value.maximizeConversions;
              delete value.maximizeConversionValue;
            }
            if (options.omitStrategy) delete value.biddingStrategyType;
            if (options.unexpectedTarget && value.maximizeConversions)
              value.maximizeConversions.targetCpaMicros = '9999999';
            if (options.wrongCeiling) value.targetSpend.cpcBidCeilingMicros = '9999999';
          }
          resources.set(resourceName, {kind: kinds[collection], value});
          return {resourceName};
        }),
      });
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {
    actor,
    admin,
    store,
    service,
    requests,
    connection,
    resources,
    mutations,
    call: (input, as = actor) => service.call('amcp_campaign', input, as),
  };
}
