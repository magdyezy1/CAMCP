import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Round 2.5, package r25-m0-review, T3: the review summary is only a summary. Whatever it says, the exact native request
 * stays shown below it, and that request is what execute sends ("The exact request is what is sent",
 * src/review-summary.ts). Each case prepares a create through amcp_write against a synthetic provider, reads the summary
 * and the request the review shows, executes it, and compares the request that went out with the one that was shown.
 */
const registry = new Registry(),
  key = Buffer.alloc(32, 29).toString('base64'),
  operator = {tenantId: 'synthetic-summary', userId: 'writer', role: 'operator'},
  admin = {...operator, role: 'admin'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
const snapRecord = (kind, id, extra = {}) => ({
  request_status: 'SUCCESS',
  [kind]: [
    {
      sub_request_status: 'SUCCESS',
      [kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1)]: {id, status: 'PAUSED', name: 'Synthetic', ...extra},
    },
  ],
});

const camelKeys = value =>
  Array.isArray(value)
    ? value.map(camelKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), camelKeys(v)]),
        )
      : value;

const cases = [
  {
    label: 'TikTok: the verb is the last segment of the route',
    gateway: 'tiktok_native_action',
    args: {
      action: 'tiktok_campaign_create',
      payload: {campaign_name: 'Synthetic launch', objective_type: 'TRAFFIC', operation_status: 'DISABLE'},
    },
    read: p =>
      p.includes('/advertiser/')
        ? {
            code: 0,
            data: {
              list: [
                {
                  advertiser_id: '123',
                  name: 'Synthetic account',
                  currency: 'USD',
                  timezone: 'UTC',
                  status: 'STATUS_ENABLE',
                },
              ],
            },
          }
        : {
            code: 0,
            data: {list: [{campaign_id: '111', campaign_name: 'Synthetic launch', operation_status: 'DISABLE'}]},
          },
    write: {code: 0, data: {campaign_id: '111'}},
    text: 'Create 1 campaign in account Synthetic account (123); operation_status DISABLE.',
    sent: {method: 'POST', path: '/v1.3/campaign/create/'},
  },
  {
    label: 'Meta: a create on a known collection',
    gateway: 'meta_native_action',
    args: {
      action: 'meta_campaign_create',
      payload: {name: 'Synthetic campaign', status: 'PAUSED', is_adset_budget_sharing_enabled: false},
    },
    read: p =>
      p.endsWith('/act_123')
        ? {id: 'act_123', account_status: 1, currency: 'USD'}
        : {id: '111', name: 'Synthetic campaign', status: 'PAUSED'},
    write: {id: '111'},
    remember: '111',
    canonical: 'meta_ad_account_id_campaigns_create',
    // Meta's wire form is a form: every value is text.
    wire: body => Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])),
    text: 'Create 1 campaign in account 123; status PAUSED.',
    sent: {method: 'POST', path: '/act_123/campaigns', suffix: true},
  },
  {
    label: 'Snapchat: a create on a known collection',
    gateway: 'snapchat_native_action',
    args: {
      action: 'snapchat_campaign_create',
      payload: {campaigns: [{name: 'Synthetic campaign', ad_account_id: '123', status: 'PAUSED'}]},
    },
    read: p =>
      snapRecord(
        p.split('/').at(-2),
        p.split('/').at(-1),
        p.endsWith('/123') ? {name: 'Synthetic account', currency: 'USD', status: 'ACTIVE'} : {},
      ),
    write: snapRecord('campaigns', '111'),
    remember: 'campaigns/111',
    // The review shows the route's canonical action name, whichever alias the caller used.
    canonical: 'snapchat_adaccounts_ad_account_id_campaigns_create',
    text: 'Create 1 campaign in account Synthetic account (123); status PAUSED.',
    sent: {method: 'POST', path: '/v1/adaccounts/123/campaigns'},
  },
  {
    label: 'Google Ads: a create operation of a :mutate request',
    gateway: 'google_ads_native_action',
    args: {
      action: 'google_ads_v23_campaign_mutate_campaigns',
      payload: {
        operations: [{create: {name: 'Synthetic campaign', status: 'PAUSED', advertising_channel_type: 'SEARCH'}}],
      },
    },
    read: (p, init) =>
      String(init.body).includes('FROM customer')
        ? {
            results: [
              {customer: {id: '123', descriptiveName: 'Synthetic account', currencyCode: 'USD', timeZone: 'UTC'}},
            ],
          }
        : {
            results: [
              {campaign: {resourceName: 'customers/123/campaigns/111', name: 'Synthetic campaign', status: 'PAUSED'}},
            ],
          },
    write: {results: [{resourceName: 'customers/123/campaigns/111'}]},
    // Google Ads' wire form writes each key in camel case; the review shows the native snake case.
    wire: camelKeys,
    text: 'Create 1 campaign in account Synthetic account (123); status PAUSED.',
    sent: {method: 'POST', path: '/customers/123/campaigns:mutate', suffix: true},
  },
  {
    // T3b: LinkedIn's campaign collection is none of the names the old path test knew, so this read "Update 1 adCampaigns
    // … status ACTIVE → PAUSED", the ACTIVE being the account's.
    label: 'LinkedIn: a create in the collection directly under the account',
    gateway: 'linkedin_native_action',
    args: {
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
      payload: {name: 'Synthetic campaign', status: 'PAUSED', account: 'urn:li:sponsoredAccount:123'},
    },
    read: p =>
      p.endsWith('/adAccounts/123')
        ? {id: 123, name: 'Synthetic account', currency: 'USD', status: 'ACTIVE'}
        : {id: Number(p.split('/').at(-1)), name: 'Synthetic campaign', status: 'PAUSED'},
    write: null,
    status: 201,
    headers: {'x-restli-id': '111'},
    text: 'Create 1 adCampaigns in account Synthetic account (123); status PAUSED.',
    sent: {method: 'POST', path: '/adAccounts/123/adCampaigns', suffix: true},
  },
  {
    // S2-1: Microsoft Advertising's Add, Update and Delete share one route and differ by method. Its family declares what
    // the write does, so two campaigns read as two creates and not "Update 1 Campaigns". Its reads are POSTs too.
    label: 'Microsoft Advertising: an Add of two campaigns on a route it shares with its Update',
    gateway: 'microsoft_ads_native_action',
    connection: {accountCustomers: {123: '456'}, scopes: ['https://ads.microsoft.com/msads.manage']},
    args: {
      action: 'AddCampaigns',
      payload: {
        Campaigns: [
          {
            Name: 'Synthetic A',
            CampaignType: 'Search',
            DailyBudget: 10,
            BudgetType: 'DailyBudgetStandard',
            Status: 'Paused',
          },
          {
            Name: 'Synthetic B',
            CampaignType: 'Search',
            DailyBudget: 12,
            BudgetType: 'DailyBudgetStandard',
            Status: 'Paused',
          },
        ],
      },
    },
    postRead: p => p.endsWith('/Account/Query'),
    read: () => ({Account: {Id: '123', ParentCustomerId: '456', CurrencyCode: 'USD'}}),
    write: {CampaignIds: ['101', '102'], PartialErrors: null},
    text: 'Create 2 campaigns in account 123; DailyBudget 10.00 in account currency (10 account currency); DailyBudget 12.00 in account currency (12 account currency).',
    sent: {method: 'POST', path: '/CampaignManagement/v13/Campaigns'},
  },
];

/** The review a create gets from amcp_write, and the write that execute then sends. */
async function prepareAndExecute(c) {
  const store = new Store(':memory:', key),
    written = [];
  try {
    const connection = {
      id: 'connection',
      tenantId: operator.tenantId,
      gateway: c.gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
      ...c.connection,
    };
    store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
    // The resource the create makes is the account's, as its read-back needs it to be.
    if (c.remember) store.rememberResource(connection, '123', c.remember);
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async (input, init) => {
        const url = new URL(String(input)),
          p = url.pathname.replace('/open_api', ''),
          // A read is a GET, or a POST the provider reads with (Google Ads' search, Microsoft's account query).
          read = (init?.method ?? 'GET') === 'GET' || p.endsWith('/googleAds:search') || c.postRead?.(p) === true;
        if (!read) {
          const text = String(init.body);
          written.push({
            method: init.method,
            path: p,
            // Meta writes a form, the others JSON.
            body: text.trim().startsWith('{') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text)),
          });
          // LinkedIn answers a create with the new ID in a header and no body.
          return new Response(c.write === null ? null : JSON.stringify(c.write), {
            status: c.status ?? 200,
            headers: c.headers,
          });
        }
        return new Response(JSON.stringify(c.read(p, init ?? {})));
      }),
      undefined,
      policy,
    );
    const prepared = await service.call(
      'amcp_write',
      {action: 'prepare', gateway: c.gateway, arguments: {account_id: '123', ...c.args}},
      operator,
    );
    assert.equal(prepared.success, true, c.label + ' ' + JSON.stringify(prepared.error ?? prepared).slice(0, 600));
    assert.equal(written.length, 0, 'prepare sends nothing');
    const execute = {
      action: 'execute',
      review_id: prepared.data.review_id,
      idempotency_key: prepared.data.idempotency_key,
      confirmed: true,
      spend_change_confirmed: true,
    };
    const executed = await service.call('amcp_write', execute, operator);
    assert.equal(executed.success, true, c.label + ' ' + JSON.stringify(executed.error ?? executed).slice(0, 600));
    return {prepared: prepared.data, written};
  } finally {
    store.close();
  }
}

for (const c of cases)
  test('a create reads as a create and the exact request below it is the one sent: ' + c.label, async () => {
    const {prepared, written} = await prepareAndExecute(c);
    assert.equal(prepared.summary.operation, 'create');
    assert.equal(prepared.summary.text, c.text);
    assert.equal(
      prepared.summary.authority,
      'The exact native request below is what is sent; this line only summarizes it.',
    );
    // The request the review shows is the compiled request whole, beside the summary and unchanged by it.
    const shown = prepared.request;
    assert.equal(shown.method, c.sent.method);
    assert.ok(
      c.sent.suffix ? shown.path.endsWith(c.sent.path) : shown.path === c.sent.path,
      c.label + ' shows ' + shown.path,
    );
    assert.equal(shown.gateway, c.gateway);
    assert.equal(shown.action, c.canonical ?? c.args.action);
    assert.equal(written.length, 1, 'one write is sent');
    // What went out is what was shown: the same method, path and body.
    assert.equal(written[0].method, shown.method);
    assert.ok(
      written[0].path.endsWith(shown.path.replace(/^\/v\d+(?:\.\d+)?(?=\/)/, '')) || written[0].path === shown.path,
      written[0].path + ' vs ' + shown.path,
    );
    assert.deepEqual(written[0].body, (c.wire ?? (body => body))(shown.body));
  });

test('the website review prints the summary line, then the exact native request it summarizes', async () => {
  const {prepared} = await prepareAndExecute(cases[0]);
  const context = createContext({
    document: {addEventListener() {}},
    $: () => ({checked: false, innerHTML: '', textContent: '', hidden: true, disabled: false}),
    Object,
    JSON,
    String,
    Number,
    Math,
    Date,
    encodeURIComponent,
    esc: value => String(value ?? ''),
    badge: String,
    date: String,
    blank: String,
    recordDetails: () => '',
    workspaceBind() {},
    setInterval: () => 1,
    clearInterval() {},
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/campaign-workflows.js', 'utf8')).runInContext(context);
  context.review = prepared;
  const html = new Script('readableReview(review, "Execute")').runInContext(context);
  const summary = html.indexOf('class="review-summary"'),
    request = html.indexOf('Request to submit — exact native fields');
  assert.ok(summary > -1 && request > summary, 'the summary comes first, the exact request after it');
  assert.match(html.slice(summary, request), /Create<\/strong> <bdi dir="ltr">1 × campaign<\/bdi>/);
  // The request table lists the route and each field of the body as the review froze them.
  const table = html.slice(request);
  for (const field of ['/path', '/body/advertiser_id', '/body/campaign_name', '/body/operation_status'])
    assert.ok(table.includes('<code dir="ltr">' + field + '</code>'), field);
  assert.ok(table.includes('/v1.3/campaign/create/'));
  assert.ok(!html.slice(summary, request).includes('STATUS_ENABLE'), 'the advertiser’s status is not the campaign’s');
});
