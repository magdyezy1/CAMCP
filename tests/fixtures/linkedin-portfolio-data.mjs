import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
export const linkedinPortfolioGateway = 'linkedin_native_action',
  account = 'urn:li:sponsoredAccount:100';
const gateway = linkedinPortfolioGateway;
export const linkedinPortfolioGroup = id => ({
  id,
  account,
  name: 'Group ' + id,
  status: 'ACTIVE',
  totalBudget: {amount: '123456789012345678.90', currencyCode: 'USD'},
  createdBy: 'PRIVATE-PERSON',
});
const group = linkedinPortfolioGroup;
const campaign = id => ({
  id,
  account,
  name: 'Campaign ' + id,
  campaignGroup: 'urn:li:sponsoredCampaignGroup:10',
  status: 'PAUSED',
  dailyBudget: {amount: '80.25', currencyCode: 'USD'},
  unitCost: {amount: '0.50', currencyCode: 'USD'},
  objectiveType: 'WEBSITE_VISIT',
});
const creative = id => ({
  id: 'urn:li:sponsoredCreative:' + id,
  account,
  campaign: 'urn:li:sponsoredCampaign:201',
  name: 'Creative ' + id,
  intendedStatus: 'ACTIVE',
  isServing: false,
  servingHoldReasons: ['CAMPAIGN_STOPPED'],
  content: {reference: 'PRIVATE-CONTENT'},
  createdBy: 'PRIVATE-PERSON',
});
export function linkedinPortfolioFixture(t) {
  const actor = {tenantId: 'linkedin-portfolio', userId: 'reader', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 96).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'cccccccc-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway,
    accounts: ['100', '200'],
    scopes: ['r_ads'],
    enabled: true,
    label: 'Synthetic',
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const requests = [];
  let change = body => body;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init) => {
        const url = new URL(String(raw));
        assert.equal(init.method, 'GET');
        assert.equal(url.origin, 'https://api.linkedin.com');
        requests.push({url, init});
        let body;
        const route = url.pathname.replace('/rest/adAccounts/100', '');
        if (route === '') body = {id: 100, currency: 'USD', name: 'Account'};
        else if (route === '/adCampaignGroups')
          body = url.searchParams.has('pageToken')
            ? {elements: [group('30')], metadata: {nextPageToken: null}}
            : {elements: [group('10'), group('20')], metadata: {nextPageToken: 'opaque-next'}};
        else if (route === '/adCampaignGroups/10') body = group('10');
        else if (route === '/adCampaigns') body = {elements: [campaign('201')], metadata: {}};
        else if (route === '/adCampaigns/201') body = campaign('201');
        else if (route === '/creatives') body = {elements: [creative('301')], metadata: {}};
        else throw Error('Unexpected fixture request ' + route);
        return Response.json(change(body, route, url));
      },
      async () => {},
    ),
  );
  const call = (input = {}, user = actor) =>
    service.call(
      'amcp_workspace',
      {action: 'portfolio', gateway, account_id: '100', connection_id: connection.id, limit: 2, ...input},
      user,
    );
  return {
    actor,
    service,
    store,
    connection,
    requests,
    call,
    setChange: f => {
      change = f;
    },
  };
}
