import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';
import {SNAP, bytes, fixture, gateway as snapchat, squadBody} from './snapchat-plan-fixture.js';

/**
 * The owner's item 10 (2026-09-29): "clone this campaign with changes, run from a spec" would have made a rebuild one
 * command. clone reads the source through the account's own lists, builds an ordinary draft plan under a new name
 * with the spec's changes, and sends nothing: the plan is then approved once and run, each step still reviewed.
 */
const wrapped = (kind: string, rows: JsonObject[]) =>
  Response.json({
    request_status: 'SUCCESS',
    paging: {},
    [kind]: rows.map(r => ({sub_request_status: 'SUCCESS', [kind.slice(0, -1)]: r})),
  });
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
// Google reads either JSON spelling; the compiled request uses camelCase.
const snakeKeys = (v: unknown): any =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), snakeKeys(x)]),
        )
      : v;
const sourceCampaign = {
  id: 'src-camp',
  name: 'Spring launch',
  ad_account_id: 'acct1',
  status: 'ACTIVE',
  start_time: '2026-10-01T00:00:00.000Z',
  buy_model: 'AUCTION',
  objective_v2_properties: {objective_v2_type: 'LEADS'},
  measurement_spec: {ios_app_id: '123'},
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-02T00:00:00.000Z',
  delivery_status: ['VALID'],
};
const sourceSquad = (id: string, campaign: string, i: number, status = 'ACTIVE') => {
  const {campaign_id: _, placement_v2: __, ...body} = squadBody(i);
  return {
    ...body,
    id,
    campaign_id: campaign,
    status,
    auto_bid: true,
    created_at: '2026-09-01T00:00:00.000Z',
    delivery_status: ['VALID'],
    placement: 'UNSUPPORTED',
  };
};
const sourceAd = (id: string, squad: string, status = 'ACTIVE') => ({
  id,
  name: 'Ad ' + id,
  ad_squad_id: squad,
  creative_id: 'creative-' + id,
  type: 'REMOTE_WEBPAGE',
  status,
  render_type: 'STATIC',
  review_status: 'APPROVED',
});
function snapSource() {
  const ads = new Map<string, JsonObject>();
  const f = fixture({
    routes: (method, path, _url, body) => {
      let m: RegExpExecArray | null;
      if (method === 'GET' && path === '/v1/adaccounts/acct1/campaigns')
        return wrapped('campaigns', [sourceCampaign, {...sourceCampaign, id: 'other-camp', name: 'Other'}]);
      if (method === 'GET' && path === '/v1/adaccounts/acct1/adsquads')
        return wrapped('adsquads', [
          sourceSquad('src-sq-1', 'src-camp', 1),
          sourceSquad('other-sq', 'other-camp', 9),
          sourceSquad('src-sq-2', 'src-camp', 2, 'PAUSED'),
        ]);
      if (method === 'GET' && path === '/v1/adaccounts/acct1/ads')
        return wrapped('ads', [
          sourceAd('a1', 'src-sq-1'),
          sourceAd('a2', 'src-sq-1'),
          sourceAd('a3', 'src-sq-2', 'PAUSED'),
          sourceAd('a9', 'other-sq'),
        ]);
      if (method === 'GET' && (m = /^\/v1\/creatives\/(creative-a\d)$/.exec(path)))
        return wrapped('creatives', [
          {
            id: m[1]!,
            ad_account_id: 'acct1',
            type: 'WEB_VIEW',
            name: 'Creative',
            web_view_properties: {url: 'https://example.test/original'},
          },
        ]);
      if (method === 'GET' && path === '/v1/adaccounts/acct1/creatives')
        return wrapped(
          'creatives',
          [1, 2, 3, 9].map(i => ({id: 'creative-a' + i, ad_account_id: 'acct1', type: 'WEB_VIEW'})),
        );
      // The clone's own ads: created under the new squad, read back by ID.
      if (method === 'POST' && (m = /^\/v1\/adsquads\/([^/]+)\/ads$/.exec(path))) {
        f.writes.push(method + ' ' + path);
        return wrapped(
          'ads',
          JSON.parse(String(body)).ads.map((a: JsonObject) => {
            const row = {...a, id: 'ad' + (ads.size + 1), ad_squad_id: m![1], review_status: 'PENDING'};
            ads.set(row.id, row);
            return row;
          }),
        );
      }
      if (method === 'GET' && (m = /^\/v1\/ads\/([^/]+)$/.exec(path)) && ads.has(m[1]!))
        return wrapped('ads', [ads.get(m[1]!)!]);
      return undefined;
    },
  });
  return {f, ads};
}
const clone = (f: ReturnType<typeof fixture>, extra: JsonObject = {}) =>
  f.call('amcp_campaign', {
    action: 'clone',
    gateway: snapchat,
    connection_id: SNAP,
    account_id: 'acct1',
    source: {campaign_id: 'src-camp'},
    name: 'Spring launch copy',
    ...extra,
  });

test('a Snapchat campaign is cloned into one draft plan with the changes, and nothing is sent', async () => {
  const {f} = snapSource();
  try {
    const r = await clone(f, {
      changes: {
        set: [
          {step_id: 'squad_1', path: '/payload/adsquads/0/placement_v2', value: {config: 'AUTOMATIC'}},
          {step_id: 'squad_2', path: '/payload/adsquads/0/daily_budget_micro', value: 50000000},
        ],
      },
    });
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.equal(r.data.state, 'draft');
    assert.deepEqual(
      r.data.steps.map((s: JsonObject) => s.id),
      ['campaign', 'squad_1', 'squad_1_ads', 'squad_2', 'squad_2_ads'],
    );
    assert.deepEqual(r.data.clone.source, {campaign_id: 'src-camp', ad_squads: 2, ads: 3});
    assert.deepEqual(r.data.clone.set, [
      {step_id: 'squad_1', path: '/payload/adsquads/0/placement_v2', added: true},
      {step_id: 'squad_2', path: '/payload/adsquads/0/daily_budget_micro'},
    ]);
    const notCopied = JSON.stringify(r.data.clone.not_copied);
    assert.match(notCopied, /measurement_spec/);
    assert.match(notCopied, /auto_bid/);
    assert.match(notCopied, /placement_v2 \(never readable\)/);
    assert.match(notCopied, /render_type/);
    assert.deepEqual(r.data.next_call.arguments, {action: 'approve', id: r.data.id});
    assert.ok(bytes(r) <= 12 * 1024, String(bytes(r)));
    assert.equal(f.writes.length, 0);
    assert.ok(
      f.requests.every(q => q.startsWith('GET ')),
      f.requests.join(),
    );
    const plan = (await f.call('amcp_campaign', {action: 'get', id: r.data.id, detail: 'full'})).data;
    const args = (id: string) => plan.steps.find((s: JsonObject) => s.id === id).arguments;
    const campaign = args('campaign').payload.campaigns[0];
    assert.equal(campaign.name, 'Spring launch copy');
    assert.equal(campaign.status, 'PAUSED', 'the source was ACTIVE; the copy starts PAUSED');
    assert.deepEqual(campaign.objective_v2_properties, {objective_v2_type: 'LEADS'});
    assert.equal(campaign.measurement_spec, undefined);
    const squad1 = args('squad_1').payload.adsquads[0],
      squad2 = args('squad_2').payload.adsquads[0];
    // Children keep their status: a paused campaign covers an active squad and its active ads (decision 2).
    assert.equal(squad1.status, 'ACTIVE');
    assert.equal(squad2.status, 'PAUSED');
    assert.deepEqual(squad1.placement_v2, {config: 'AUTOMATIC'});
    assert.deepEqual(squad1.targeting, squadBody(1).targeting);
    assert.deepEqual(squad1.campaign_id, {$ref: 'campaign#/data/campaigns/0/campaign/id'});
    assert.equal(squad2.daily_budget_micro, 50000000);
    assert.equal(squad2.name, squadBody(2).name);
    const ads = args('squad_1_ads');
    assert.deepEqual(ads.path_params, {ad_squad_id: {$ref: 'squad_1#/data/adsquads/0/adsquad/id'}});
    assert.deepEqual(
      ads.payload.ads.map((a: JsonObject) => [a.creative_id, a.status]),
      [
        ['creative-a1', 'ACTIVE'],
        ['creative-a2', 'ACTIVE'],
      ],
    );
    const events = (
      f.store.db.prepare('SELECT event FROM audit WHERE tenant_id=?').all('snap-plan') as {event: string}[]
    ).map(e => JSON.parse(e.event));
    assert.ok(events.some(e => e.event === 'campaign_plan_cloned' && e.source.campaign_id === 'src-camp'));
  } finally {
    f.close();
  }
});

test('a cloned plan is approved once and its first steps run as ordinary reviewed writes', async () => {
  const {f} = snapSource();
  try {
    const r = await clone(f, {changes: {drop: ['squad_1_ads', 'squad_2']}});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.deepEqual(
      r.data.steps.map((s: JsonObject) => s.id),
      ['campaign', 'squad_1'],
    );
    assert.deepEqual(r.data.clone.dropped, ['squad_1_ads', 'squad_2', 'squad_2_ads'], 'a dropped step takes its ads');
    // squad_1 has no placement_v2 on GET; Snapchat's default applies unless the spec sets it.
    const summary = (await f.call('amcp_campaign', r.data.next_call.arguments)).data;
    const approved = await f.call('amcp_campaign', {
      ...summary.next_call.arguments,
      ...summary.next_call.add_after_user_approval,
    });
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 800));
    const ran = await f.call('amcp_campaign', {action: 'run', id: r.data.id});
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
    assert.equal(ran.data.state, 'complete', JSON.stringify(ran.data).slice(0, 800));
    assert.equal(f.writes.length, 2);
    assert.equal([...f.squads.values()][0]!.status, 'ACTIVE');
  } finally {
    f.close();
  }
});

test('the whole clone runs under one approval: campaign, both squads and their ads, each verified', async () => {
  const {f, ads} = snapSource();
  try {
    const r = await clone(f);
    const summary = (await f.call('amcp_campaign', r.data.next_call.arguments)).data;
    await f.call('amcp_campaign', {...summary.next_call.arguments, ...summary.next_call.add_after_user_approval});
    const ran = await f.call('amcp_campaign', {action: 'run', id: r.data.id});
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
    assert.equal(ran.data.state, 'complete', JSON.stringify(ran.data).slice(0, 1200));
    assert.deepEqual(ran.data.run.executed, ['campaign', 'squad_1', 'squad_1_ads', 'squad_2', 'squad_2_ads']);
    assert.equal(f.writes.length, 5);
    assert.deepEqual(
      [...ads.values()].map(a => [a.ad_squad_id, a.creative_id, a.status]),
      [
        ['squad1', 'creative-a1', 'ACTIVE'],
        ['squad1', 'creative-a2', 'ACTIVE'],
        ['squad2', 'creative-a3', 'PAUSED'],
      ],
    );
    assert.ok(bytes(ran) <= 12 * 1024, String(bytes(ran)));
  } finally {
    f.close();
  }
});

test('clone refuses a bad spec before creating anything, and names the field', async () => {
  const {f} = snapSource();
  try {
    const cases: [JsonObject, string, RegExp][] = [
      [
        {changes: {set: [{step_id: 'squad_1', path: '/action', value: 'snapchat_ad_create'}]}},
        'INVALID_ARGUMENT',
        /action/,
      ],
      [
        {changes: {set: [{step_id: 'squad_1', path: '/path_params/campaign_id', value: 'x'}]}},
        'INVALID_ARGUMENT',
        /\$ref/,
      ],
      [
        {changes: {set: [{step_id: 'squad_1', path: '/payload/adsquads/0/name', value: {$ref: 'campaign#/x'}}]}},
        'INVALID_ARGUMENT',
        /\$ref/,
      ],
      [
        {changes: {set: [{step_id: 'squad_1', path: '/payload/nothing/here', value: 1}]}},
        'INVALID_ARGUMENT',
        /parent must exist/,
      ],
      [
        {changes: {set: [{step_id: 'squad_1', path: '/payload/__proto__/x', value: 1}]}},
        'INVALID_ARGUMENT',
        /JSON pointer/,
      ],
      [{changes: {set: [{step_id: 'squad_9', path: '/payload', value: 1}]}}, 'INVALID_ARGUMENT', /not a step/],
      [
        {changes: {set: [{step_id: 'squad_1', path: '/payload', value: {adsquads: []}}]}},
        'INVALID_ARGUMENT',
        /holds, a \$ref/,
      ],
      [{changes: {drop: ['campaign']}}, 'INVALID_ARGUMENT', /nothing to create/],
      [{changes: {drop: ['nope']}}, 'INVALID_ARGUMENT', /step IDs/],
      [{changes: {rename: []}}, 'INVALID_ARGUMENT', /changes is/],
      [{source: {campaign_id: 'missing-camp'}}, 'CLONE_SOURCE_NOT_FOUND', /missing-camp/],
      [{source: {}}, 'INVALID_ARGUMENT', /source/],
      [{name: ''}, 'INVALID_ARGUMENT', /name/],
    ];
    for (const [extra, code, message] of cases) {
      const r = await clone(f, extra);
      assert.equal(r.success, false, JSON.stringify(extra));
      assert.equal(r.error.code, code, JSON.stringify([extra, r.error]));
      assert.match(r.error.message, message, JSON.stringify(extra));
      assert.ok(r.error.details.field, JSON.stringify(r.error));
    }
    const other = await f.call('amcp_campaign', {
      action: 'clone',
      gateway: 'x_ads_native_action',
      account_id: 'acct1',
      source: {campaign_id: '1'},
      name: 'x',
    });
    assert.equal(other.error.code, 'CLONE_UNSUPPORTED', 'named before any connection is looked up');
    assert.equal(other.error.details.field, 'gateway');
    assert.equal(f.writes.length, 0);
    assert.equal(f.store.documents('snap-plan', 'campaign_run').length, 0, 'no plan was created');
  } finally {
    f.close();
  }
});

// Google: a Search campaign with three kinds of targeting AMCP copies and one it does not.
const google = 'google_ads_native_action',
  actor: Actor = {tenantId: 'clone-google', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'};
/** `refuseFirst`: the HTTP status Google answers the first build with. */
function googleSource(channel = 'SEARCH', bidding = 'MAXIMIZE_CONVERSIONS', refuseFirst?: number) {
  const store = new Store(':memory:', Buffer.alloc(32, 46).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway: google,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const queries: string[] = [],
    writes: JsonObject[] = [],
    created = new Map<string, JsonObject>();
  const rows: Record<string, JsonObject[]> = {
    campaign: [
      {
        campaign: {
          resourceName: 'customers/123/campaigns/77',
          name: 'Search EN',
          advertisingChannelType: channel,
          biddingStrategyType: bidding,
          containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          networkSettings: {targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false},
          maximizeConversions: {targetCpaMicros: '25000000'},
        },
        campaignBudget: {amountMicros: '40000000', deliveryMethod: 'STANDARD', explicitlyShared: true},
      },
    ],
    campaign_criterion: [
      {campaignCriterion: {type: 'LOCATION', location: {geoTargetConstant: 'geoTargetConstants/2682'}}},
      {campaignCriterion: {type: 'LANGUAGE', language: {languageConstant: 'languageConstants/1000'}}},
      {campaignCriterion: {type: 'KEYWORD', negative: true, keyword: {text: 'free', matchType: 'PHRASE'}}},
      {campaignCriterion: {type: 'AD_SCHEDULE'}},
    ],
    ad_group: [
      {
        adGroup: {
          resourceName: 'customers/123/adGroups/1',
          name: 'Brand',
          type: 'SEARCH_STANDARD',
          status: 'ENABLED',
          cpcBidMicros: '1500000',
        },
      },
      {adGroup: {resourceName: 'customers/123/adGroups/2', name: 'Generic', type: 'SEARCH_STANDARD', status: 'PAUSED'}},
    ],
    ad_group_criterion: [
      {
        adGroupCriterion: {
          adGroup: 'customers/123/adGroups/1',
          status: 'ENABLED',
          keyword: {text: 'acme', matchType: 'EXACT'},
        },
      },
      {
        adGroupCriterion: {
          adGroup: 'customers/123/adGroups/1',
          negative: true,
          keyword: {text: 'jobs', matchType: 'BROAD'},
        },
      },
      {
        adGroupCriterion: {
          adGroup: 'customers/123/adGroups/2',
          status: 'PAUSED',
          keyword: {text: 'widgets', matchType: 'PHRASE'},
        },
      },
    ],
    ad_group_ad: [
      {
        adGroupAd: {
          adGroup: 'customers/123/adGroups/1',
          status: 'ENABLED',
          ad: {
            finalUrls: ['https://example.test/'],
            responsiveSearchAd: {
              headlines: [
                {text: 'Acme'},
                {text: 'Acme widgets'},
                {
                  text: 'Buy Acme',
                  pinnedField: 'HEADLINE_1',
                  assetPerformanceLabel: 'GOOD',
                  policySummaryInfo: {approvalStatus: 'APPROVED'},
                },
              ],
              descriptions: [{text: 'Widgets for all.'}, {text: 'Fast delivery.'}],
              path1: 'widgets',
            },
          },
        },
      },
    ],
  };
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const body = snakeKeys(JSON.parse(String(init?.body ?? '{}'))),
          path = new URL(String(url)).pathname;
        if (path.endsWith('googleAds:search')) {
          queries.push(body.query);
          const from = / FROM ([a-z_]+)/.exec(body.query)?.[1] ?? '';
          if (from === 'customer')
            return Response.json({results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]});
          // Read-back of what a build created, by name; otherwise the source campaign's rows.
          const names = [...String(body.query).matchAll(/IN \('(customers\/[^']+)'\)/g)].map(m => m[1]!);
          if (names.length && names.every(n => created.has(n)))
            return Response.json({results: names.map(n => ({[camel(from)]: created.get(n)}))});
          return Response.json({results: rows[from] ?? []});
        }
        writes.push(body);
        if (!path.endsWith('googleAds:mutate'))
          return Response.json({error: {code: 500, message: 'Synthetic'}}, {status: 500});
        if (refuseFirst && writes.length === 1)
          return Response.json(
            {error: {code: refuseFirst, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.'}},
            {status: refuseFirst},
          );
        // Google applies the whole build, resolving temporary names to the IDs it allocates.
        const temps = new Map<string, string>(),
          real = (v: unknown): unknown =>
            typeof v === 'string' && temps.has(v)
              ? temps.get(v)
              : Array.isArray(v)
                ? v.map(real)
                : v && typeof v === 'object'
                  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, real(x)]))
                  : v;
        return Response.json({
          mutateOperationResponses: body.mutate_operations.map((op: JsonObject) => {
            const key = Object.keys(op)[0]!,
              {resource_name: temp, ...record} = op[key].create,
              kind = camel(key.replace(/_operation$/, '')).replace(/y$/, 'ie') + 's',
              id = String(created.size + 500),
              parent = String(real(record.ad_group ?? record.campaign ?? ''))
                .split('/')
                .at(-1),
              name =
                'customers/123/' +
                (kind === 'campaignCriterions'
                  ? 'campaignCriteria'
                  : kind === 'adGroupCriterions'
                    ? 'adGroupCriteria'
                    : kind) +
                '/' +
                (/Criterion|Ad$/.test(
                  key.replace(/_operation$/, '').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
                )
                  ? parent + '~' + id
                  : id);
            if (temp) temps.set(temp, name);
            created.set(name, {resourceName: name, ...(real(record) as JsonObject)});
            return {[camel(key.replace(/_operation$/, '')) + 'Result']: {resourceName: name}};
          }),
        });
      },
      undefined,
      undefined,
      undefined,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (input: JsonObject) =>
    service.call(
      'amcp_campaign',
      {
        action: 'clone',
        gateway: google,
        account_id: '123',
        source: {campaign_id: '77'},
        name: 'Search EN copy',
        ...input,
      },
      actor,
    ) as Promise<JsonObject>;
  return {store, service, queries, writes, created, call};
}

test('a Google Search campaign is cloned: budget, paused campaign, targeting, ad groups, keywords and ads', async () => {
  const g = googleSource();
  try {
    const r = await g.call({
      atomic: false,
      changes: {set: [{step_id: 'budget', path: '/payload/operations/0/create/amount_micros', value: '60000000'}]},
    });
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.deepEqual(
      r.data.steps.map((s: JsonObject) => s.id),
      [
        'budget',
        'campaign',
        'targeting',
        'adgroup_1',
        'adgroup_1_keywords',
        'adgroup_1_ads',
        'adgroup_2',
        'adgroup_2_keywords',
      ],
    );
    assert.deepEqual(r.data.clone.source, {campaign_id: '77', ad_groups: 2, keywords: 3, ads: 1});
    assert.deepEqual(r.data.clone.not_copied, [
      {fields: ['explicitly_shared (the copy has its own budget of the same amount)'], steps: ['budget']},
      {fields: ['AD_SCHEDULE criteria'], steps: ['targeting']},
    ]);
    assert.equal(g.writes.length, 0);
    // Every read names the source campaign.
    assert.ok(
      g.queries.every(q => q.includes("campaign.resource_name = 'customers/123/campaigns/77'")),
      g.queries.join('\n'),
    );
    const plan = (
      (await g.service.call('amcp_campaign', {action: 'get', id: r.data.id, detail: 'full'}, actor)) as JsonObject
    ).data;
    const create = (id: string, i = 0) =>
      plan.steps.find((s: JsonObject) => s.id === id).arguments.payload.operations[i].create;
    assert.deepEqual(create('budget'), {
      name: 'Search EN copy budget',
      amount_micros: '60000000',
      delivery_method: 'STANDARD',
      explicitly_shared: false,
    });
    assert.deepEqual(create('campaign'), {
      name: 'Search EN copy',
      status: 'PAUSED',
      advertising_channel_type: 'SEARCH',
      campaign_budget: {$ref: 'budget#/data/results/0/resourceName'},
      maximize_conversions: {target_cpa_micros: '25000000'},
      network_settings: {target_google_search: true, target_search_network: false, target_content_network: false},
      contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    });
    const targeting = plan.steps.find((s: JsonObject) => s.id === 'targeting').arguments.payload.operations;
    assert.deepEqual(
      targeting.map((o: JsonObject) => Object.keys(o.create).sort().join()),
      ['campaign,location', 'campaign,language', 'campaign,keyword,negative'],
    );
    // Children keep their own status under the paused campaign (the owner's item 6).
    assert.equal(create('adgroup_1').status, 'ENABLED');
    assert.equal(create('adgroup_1').cpc_bid_micros, '1500000');
    assert.equal(create('adgroup_2').status, 'PAUSED');
    assert.deepEqual(create('adgroup_1_keywords', 0), {
      ad_group: {$ref: 'adgroup_1#/data/results/0/resourceName'},
      status: 'ENABLED',
      keyword: {text: 'acme', match_type: 'EXACT'},
    });
    assert.deepEqual(create('adgroup_1_keywords', 1), {
      ad_group: {$ref: 'adgroup_1#/data/results/0/resourceName'},
      negative: true,
      keyword: {text: 'jobs', match_type: 'BROAD'},
    });
    assert.deepEqual(create('adgroup_1_ads').ad.responsive_search_ad.headlines[2], {
      text: 'Buy Acme',
      pinned_field: 'HEADLINE_1',
    });
    assert.deepEqual(create('adgroup_1_ads').ad.final_urls, ['https://example.test/']);
  } finally {
    g.store.close();
  }
});

test('Google campaigns AMCP cannot recreate are refused by name, with nothing created', async () => {
  for (const [channel, bidding, pattern] of [
    ['PERFORMANCE_MAX', 'MAXIMIZE_CONVERSIONS', /Search campaigns; this one is PERFORMANCE_MAX/],
    ['SEARCH', 'TARGET_IMPRESSION_SHARE', /uses TARGET_IMPRESSION_SHARE/],
  ] as const) {
    const g = googleSource(channel, bidding);
    try {
      const r = await g.call({});
      assert.equal(r.error.code, 'CLONE_UNSUPPORTED', JSON.stringify(r.error));
      assert.match(r.error.message, pattern);
      assert.equal(r.error.remedy?.owner ?? 'operator', 'operator');
      assert.equal(g.store.documents(actor.tenantId, 'campaign_run').length, 0);
      assert.equal(g.writes.length, 0);
    } finally {
      g.store.close();
    }
  }
});

test('a Google clone is one all-or-nothing build by default, with the changes applied before it is composed', async () => {
  const g = googleSource();
  try {
    const r = await g.call({
      changes: {
        set: [{step_id: 'budget', path: '/payload/operations/0/create/amount_micros', value: '60000000'}],
        drop: ['adgroup_2'],
      },
    });
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.deepEqual(
      r.data.steps.map((s: JsonObject) => s.id),
      ['build'],
    );
    assert.equal(r.data.clone.all_or_nothing, true);
    assert.deepEqual(r.data.clone.steps, [
      'budget',
      'campaign',
      'targeting',
      'adgroup_1',
      'adgroup_1_keywords',
      'adgroup_1_ads',
    ]);
    assert.deepEqual(r.data.clone.dropped, ['adgroup_2', 'adgroup_2_keywords']);
    const plan = (
      (await g.service.call('amcp_campaign', {action: 'get', id: r.data.id, detail: 'full'}, actor)) as JsonObject
    ).data;
    const ops = plan.steps[0].arguments.payload.mutate_operations as JsonObject[];
    assert.equal(plan.steps[0].arguments.payload.partial_failure, false);
    assert.deepEqual(
      ops.map(o => Object.keys(o)[0]),
      [
        'campaign_budget_operation',
        'campaign_operation',
        'campaign_criterion_operation',
        'campaign_criterion_operation',
        'campaign_criterion_operation',
        'ad_group_operation',
        'ad_group_criterion_operation',
        'ad_group_criterion_operation',
        'ad_group_ad_operation',
      ],
    );
    const create = (i: number) => (Object.values(ops[i]!)[0] as JsonObject).create;
    assert.equal(create(0).resource_name, 'customers/123/campaignBudgets/-1');
    assert.equal(create(0).amount_micros, '60000000', 'the change is in the build');
    assert.equal(create(1).resource_name, 'customers/123/campaigns/-2');
    assert.equal(create(1).campaign_budget, 'customers/123/campaignBudgets/-1');
    assert.equal(create(2).campaign, 'customers/123/campaigns/-2');
    assert.equal(create(5).resource_name, 'customers/123/adGroups/-3');
    assert.equal(create(6).ad_group, 'customers/123/adGroups/-3');
    assert.equal(create(8).ad_group, 'customers/123/adGroups/-3');
    assert.ok(!JSON.stringify(ops).includes('$ref'));
    assert.equal(g.writes.length, 0);
  } finally {
    g.store.close();
  }
});

test('the cloned build is approved once and runs as one request; every resource is read back', async () => {
  const g = googleSource();
  try {
    const r = await g.call({});
    const call = (input: JsonObject) => g.service.call('amcp_campaign', input, actor) as Promise<JsonObject>;
    const summary = (await call(r.data.next_call.arguments)).data;
    const approved = await call({...summary.next_call.arguments, ...summary.next_call.add_after_user_approval});
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 800));
    const ran = await call({action: 'run', id: r.data.id});
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 1200));
    assert.equal(ran.data.state, 'complete', JSON.stringify(ran.data).slice(0, 1500));
    assert.deepEqual(ran.data.run.executed, ['build']);
    assert.equal(g.writes.length, 1, 'one googleAds:mutate');
    assert.equal(g.created.size, 11, 'budget, campaign, three criteria, two ad groups, three keywords and an ad');
    const step = ran.data.steps[0];
    assert.equal(step.verification, 'verified');
    assert.equal(step.resource_count, 11);
    // Everything under the paused campaign keeps its status; enabling the campaign is the one activation.
    const campaign = [...g.created.values()].find(c => c.advertising_channel_type === 'SEARCH')!;
    assert.equal(campaign.status, 'PAUSED');
    assert.equal([...g.created.values()].find(c => c.name === 'Brand')!.status, 'ENABLED');
  } finally {
    g.store.close();
  }
});

const runBuild = async (g: ReturnType<typeof googleSource>, id: string) => {
  const call = (input: JsonObject) => g.service.call('amcp_campaign', input, actor) as Promise<JsonObject>;
  const summary = (await call({action: 'approve', id})).data;
  await call({...summary.next_call.arguments, ...summary.next_call.add_after_user_approval});
  return {call, ran: await call({action: 'run', id})};
};

test('a build Google refuses (HTTP 400) created nothing, so it is amended and reviewed under a new key', async () => {
  const g = googleSource('SEARCH', 'MAXIMIZE_CONVERSIONS', 400);
  try {
    const id = (await g.call({})).data.id;
    const {call, ran} = await runBuild(g, id);
    assert.equal(ran.data.run.stopped, 'needs_attention', JSON.stringify(ran.data).slice(0, 1200));
    assert.equal(g.writes.length, 1);
    assert.equal(g.created.size, 0, 'Google applied nothing');
    const next = await call({action: 'prepare_next', id});
    assert.match(JSON.stringify(next.data), /none of it was created/);
    const recovery = next.data.next_call;
    assert.equal(recovery.arguments.action, 'recover_step');
    const amended = await call({
      ...recovery.arguments,
      patch: [{path: '/payload/mutate_operations/0/campaign_budget_operation/create/amount_micros', value: '50000000'}],
    });
    assert.equal(amended.success, true, JSON.stringify(amended).slice(0, 800));
    const again = await runBuild(g, id);
    assert.equal(again.ran.data.state, 'complete', JSON.stringify(again.ran.data).slice(0, 1200));
    assert.equal(g.writes.length, 2, 'the refused request is not sent again; the amended build is');
    assert.equal(g.writes[1]!.mutate_operations[0].campaign_budget_operation.create.amount_micros, '50000000');
    assert.equal(g.created.size, 11);
    const plan = (await call({action: 'get', id, detail: 'full'})).data;
    const attempt = plan.steps[0].previous_attempts[0];
    assert.equal(attempt.rejected_build.http_status, 400);
    // The refused key stays uncertain and is never usable again.
    const old = g.store.db
      .prepare('SELECT state FROM idempotency WHERE key=?')
      .get(attempt.rejected_build.key_retired) as {state: string};
    assert.equal(old.state, 'uncertain');
    const events = (
      g.store.db.prepare('SELECT event FROM audit WHERE tenant_id=?').all(actor.tenantId) as {event: string}[]
    ).map(e => JSON.parse(e.event));
    assert.ok(events.some(e => e.event === 'campaign_step_recovered_after_rejection' && e.http_status === 400));
  } finally {
    g.store.close();
  }
});

test('a build whose outcome is unknown (HTTP 500) is never amended or sent again', async () => {
  const g = googleSource('SEARCH', 'MAXIMIZE_CONVERSIONS', 500);
  try {
    const id = (await g.call({})).data.id;
    const {call, ran} = await runBuild(g, id);
    assert.equal(ran.data.run.stopped, 'needs_attention');
    const refused = await call({action: 'recover_step', id, step_id: 'build', confirmed: true, arguments: {}});
    assert.equal(refused.error?.code, 'RECOVERY_NOT_SAFE', JSON.stringify(refused).slice(0, 600));
    assert.equal(g.writes.length, 1);
  } finally {
    g.store.close();
  }
});

// CMP-02 (b) regression: clone dropped idempotency_key, so a retried clone saved a second draft of the same campaign.
test('a keyed clone returns its original draft without reading the source again; the key with another request conflicts', async () => {
  const {f} = snapSource();
  try {
    const key = {idempotency_key: 'clone-request-0001'};
    const first = await clone(f, key);
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 800));
    const reads = f.requests.length,
      saved = (await f.call('amcp_campaign', {action: 'get', id: first.data.id, detail: 'full'})).data;
    const again = await clone(f, key);
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 800));
    assert.equal(again.data.id, first.data.id);
    assert.deepEqual(again.data.clone, first.data.clone);
    assert.deepEqual(again.data.next_call.arguments, {action: 'approve', id: first.data.id});
    assert.equal(f.requests.length, reads, 'a replay reads nothing');
    assert.equal(
      (await f.call('amcp_campaign', {action: 'get', id: first.data.id, detail: 'full'})).data.revision,
      saved.revision,
    );
    for (const extra of [
      {name: 'Another copy'},
      {changes: {drop: ['squad_2']}},
      {source: {campaign_id: 'other-camp'}},
    ]) {
      const conflict = await clone(f, {...key, ...extra});
      assert.equal(conflict.error?.code, 'IDEMPOTENCY_CONFLICT', JSON.stringify([extra, conflict.error]));
    }
    assert.equal(f.requests.length, reads, 'a conflicting key is refused before any read');
    assert.equal((await clone(f, {idempotency_key: 'bad key'})).error?.code, 'INVALID_ARGUMENT');
    const events = (
      f.store.db.prepare('SELECT event FROM audit WHERE tenant_id=?').all('snap-plan') as {event: string}[]
    ).map(e => JSON.parse(e.event));
    assert.equal(events.filter(e => e.event === 'campaign_plan_cloned').length, 1);
    assert.equal(f.store.documents('snap-plan', 'campaign_run').length, 1);
    // Without a key each clone is a new draft, as before.
    await clone(f);
    assert.equal(f.store.documents('snap-plan', 'campaign_run').length, 2);
    // A double submit (both requests in flight at once) under one key saves one draft, cloned once.
    const both = await Promise.all([
      clone(f, {idempotency_key: 'clone-request-0002'}),
      clone(f, {idempotency_key: 'clone-request-0002'}),
    ]);
    assert.ok(
      both.every(r => r.success),
      JSON.stringify(both.map(r => r.error)),
    );
    assert.equal(both[0].data.id, both[1].data.id);
    assert.deepEqual(both[1].data.clone, both[0].data.clone);
    assert.equal(f.store.documents('snap-plan', 'campaign_run').length, 3);
    const cloned = (
      f.store.db.prepare('SELECT event FROM audit WHERE tenant_id=?').all('snap-plan') as {event: string}[]
    ).filter(e => JSON.parse(e.event).event === 'campaign_plan_cloned');
    assert.equal(cloned.length, 3, 'the double submit audited one clone');
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});
