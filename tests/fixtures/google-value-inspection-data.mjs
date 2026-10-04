import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {googleRecipeGoalsData, googleConversionBrief} from './google-recipe-goals-data.mjs';

export const valueInspectionBusiness = {
  ...googleConversionBrief,
  target_cpa: undefined,
  conversion_value_policy: 'ACCOUNT_RECORDED_VALUES',
  target_roas: '3.5',
};

/** Selected synthetic configuration only; there is no transport route for events or mutations. */
export function valueInspectionFixture(t, options = {}) {
  const data = googleRecipeGoalsData(options.data),
    store = new Store(':memory:', Buffer.alloc(32, 126).toString('base64'));
  t.after(() => store.close());
  const actor = {tenantId: 'synthetic-value-inspection', userId: 'operator', role: 'operator'},
    admin = {...actor, role: 'admin'},
    business = valueInspectionBusiness;
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
  let valueReads = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const out = data.response(url, init),
        query = JSON.parse(init.body).query;
      if (query.includes('conversion_action.value_settings.')) {
        valueReads++;
        for (const r of out.results ?? [])
          if (r.conversionAction) {
            const settings = options.settings
              ? options.settings(r.conversionAction, valueReads)
              : {defaultValue: 7.25, defaultCurrencyCode: 'SAR', alwaysUseDefaultValue: false};
            if (settings !== undefined) r.conversionAction.valueSettings = settings;
          }
      }
      options.afterResponse?.({store, data, actor, admin, connection, query, valueReads});
      return Response.json(out);
    }),
    undefined,
    {allowWrites: options.allowWrites !== false, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {
    store,
    service,
    actor,
    admin,
    connection,
    data,
    business,
    call: (input = {}, as = actor) =>
      service.call(
        'amcp_campaign',
        {action: 'recipe_eligibility', recipe: 'google_search_target_roas', business, live: true, ...input},
        as,
      ),
  };
}
