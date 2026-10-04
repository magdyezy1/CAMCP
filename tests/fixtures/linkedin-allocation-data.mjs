import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
export const linkedinAllocationIds = ['9007199254740993', '9007199254740995'];
export function linkedinAllocationFixture(t) {
  const gateway = 'linkedin_native_action',
    store = new Store(':memory:', Buffer.alloc(32, 129).toString('base64')),
    owner = {tenantId: 'synthetic-linkedin-allocation', userId: 'operator', role: 'admin'},
    key = store.createKey(owner),
    actor = store.authenticate(key),
    connection = {
      id: '12900000-0000-4000-8000-000000000001',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['100'],
      writeAccounts: ['100'],
      enabled: true,
      label: 'Synthetic daily campaigns',
      scopes: ['r_ads', 'r_ads_reporting', 'rw_ads'],
    },
    account = {id: '100', currency: 'USD', type: 'BUSINESS', status: 'ACTIVE'},
    group = {
      id: '400',
      account: 'urn:li:sponsoredAccount:100',
      name: 'Original group',
      status: 'ACTIVE',
      totalBudget: {amount: '10000', currencyCode: 'USD'},
    },
    campaigns = new Map(
      linkedinAllocationIds.map((id, i) => [
        id,
        {
          id,
          account: 'urn:li:sponsoredAccount:100',
          campaignGroup: 'urn:li:sponsoredCampaignGroup:400',
          type: 'SPONSORED_UPDATES',
          name: 'Original campaign العربية ' + id,
          status: i ? 'ACTIVE' : 'PAUSED',
          versionTag: '1',
          dailyBudget: {amount: i ? '10.50' : '11.25', currencyCode: 'USD'},
          runSchedule: {start: Date.now() - 7 * 86400000},
        },
      ]),
    ),
    requests = [];
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  t.after(() => store.close());
  let hook,
    writes = false;
  const date = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10),
    nativeDate = s => {
      const [year, month, day] = s.split('-').map(Number);
      return {year, month, day};
    },
    capture = {
      action: 'capture_preset',
      preset: 'linkedin_campaign',
      account_id: '100',
      connection_id: connection.id,
      semantics: {
        currency: 'USD',
        timezone: 'UTC',
        date_from: date(2),
        date_to: date(1),
        source_name: 'Synthetic LinkedIn daily campaigns',
        attribution: 'Explicit operator declaration: 7-day click / 1-day view',
        complete: true,
      },
    },
    analytics = {
      elements: [2, 1].flatMap(day =>
        linkedinAllocationIds.map((id, i) => ({
          pivotValues: ['urn:li:sponsoredCampaign:' + id],
          dateRange: {start: nativeDate(date(day)), end: nativeDate(date(day))},
          costInLocalCurrency: '50',
          impressions: 100,
          clicks: 12,
          externalWebsiteConversions: i ? 5 : 10,
          conversionValueInLocalCurrency: '100',
        })),
      ),
      paging: {start: 0, count: 1000, links: []},
    };
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const u = new URL(url);
      requests.push({path: u.pathname, method: init.method, headers: new Headers(init.headers), body: init.body});
      const override = await hook?.(u, requests.length);
      if (override !== undefined) return override;
      if (init.method === 'GET') {
        if (u.pathname === '/rest/adAccounts/100') return Response.json(account);
        if (u.pathname === '/rest/adAnalytics') return Response.json(analytics);
        if (u.pathname === '/rest/adAccounts/100/adCampaignGroups/400') return Response.json(group);
        const c = campaigns.get(u.pathname.split('/').at(-1));
        if (c && u.pathname === '/rest/adAccounts/100/adCampaigns/' + c.id) return Response.json(c);
        return Response.json({message: 'Synthetic missing resource'}, {status: 404});
      }
      if (!writes) throw Error('Synthetic provider updates forbidden');
      if (init.method !== 'POST') throw Error('Unexpected synthetic update method');
      const c = campaigns.get(u.pathname.split('/').at(-1));
      if (!c || u.pathname !== '/rest/adAccounts/100/adCampaigns/' + c.id)
        throw Error('Unexpected synthetic update scope');
      const p = JSON.parse(init.body);
      Object.assign(c, p.patch.$set);
      c.versionTag = String(BigInt(c.versionTag) + 1n);
      return new Response(null, {status: 204});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (args, who = actor) => service.call('amcp_reporting', args, who),
    options = {
      budget: '240',
      allocations: linkedinAllocationIds.map(id => ({
        entity_id: 'urn:li:sponsoredCampaign:' + id,
        minimum: '40',
        maximum: '180',
      })),
      efficiency_low: 0.5,
      efficiency_high: 1.5,
      minimum_conversions: 1,
      maximum_age_days: 7,
    };
  let reportId;
  return {
    store,
    actor,
    owner,
    key,
    connection,
    account,
    group,
    campaigns,
    requests,
    service,
    capture,
    options,
    analytics,
    hook: fn => {
      hook = fn;
    },
    allowUpdates: () => {
      writes = true;
    },
    call,
    captureReport: async () => {
      const out = await call(capture);
      if (out.success) reportId = out.data.id;
      return out;
    },
    preview: (changes = {}, who = actor) =>
      call({action: 'preview_allocation_plan', id: reportId, conversion: 'equal_daily', options, ...changes}, who),
    create: (p, changes = {}, who = actor) =>
      call(
        {
          action: 'create_allocation_plan',
          id: reportId,
          preview_id: p.preview_id,
          preview_hash: p.preview_hash,
          confirmed: true,
          ...changes,
        },
        who,
      ),
    report: () => store.document(actor.tenantId, 'decision_report', reportId),
  };
}
