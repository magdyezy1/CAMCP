import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Compiler} from '../src/compiler.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {applyExecutionRisk} from '../src/execution-risk.js';
import {actionContracts} from '../src/action-contracts.js';
import {googleGenerationKind, validateGoogleGeneration} from '../src/google-generation.js';
import type {Connection, JsonObject} from '../src/types.js';

const registry = new Registry(),
  compiler = new Compiler(registry),
  gateway = 'google_ads_native_action',
  account = '123',
  options = {mode: 'strict' as const, flags: {}};
const actor = {tenantId: 'generation', userId: 'reader', role: 'reader' as const},
  admin = {...actor, role: 'admin' as const};
const text = {
  asset_field_types: ['HEADLINE', 'DESCRIPTION'],
  advertising_channel_type: 'SEARCH',
  final_url: 'https://example.com/homes',
  freeform_prompt: 'Describe the supplied offer without inventing claims.',
};
const images = {
  advertising_channel_type: 'DISPLAY',
  asset_field_types: ['MARKETING_IMAGE'],
  freeform_generation: {freeform_prompt: 'A bright empty room.'},
};
const recommendations = {
  advertising_channel_type: 'SEARCH',
  recommendation_types: ['SITELINK_ASSET'],
  campaign_sitelink_count: 0,
};
const actions: [string, JsonObject, JsonObject][] = [
  ['GENERATE_TEXT_ASSETS', text, {generatedText: [{text: 'View homes', assetFieldType: 'HEADLINE'}]}],
  [
    'google_ads_v23_asset_generation_generate_text',
    text,
    {generatedText: [{text: 'View homes', assetFieldType: 'HEADLINE'}]},
  ],
  [
    'GENERATE_IMAGE_ASSETS',
    images,
    {
      generatedImages: [
        {
          imageTemporaryUrl: 'https://images.example.com/generated?signature=synthetic-private-signature',
          assetFieldType: 'MARKETING_IMAGE',
        },
      ],
    },
  ],
  [
    'google_ads_v23_asset_generation_generate_images',
    images,
    {generatedImages: [{imageTemporaryUrl: 'https://images.example.com/generated', assetFieldType: 'MARKETING_IMAGE'}]},
  ],
  [
    'GENERATE_RECOMMENDATIONS',
    recommendations,
    {
      recommendations: [
        {
          type: 'SITELINK_ASSET',
          sitelinkAssetRecommendation: {
            recommendedAssets: [{sitelinkAsset: {linkText: 'Homes', description1: 'Browse homes'}}],
          },
        },
      ],
    },
  ],
  [
    'google_ads_v23_recommendation_generate_recommendations',
    recommendations,
    {recommendations: [{type: 'SITELINK_ASSET', sitelinkAssetRecommendation: {recommendedAssets: []}}]},
  ],
];
function fixture(response: unknown) {
  const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64')),
    calls: JsonObject[] = [];
  const c: Connection = {
    id: 'c',
    tenantId: actor.tenantId,
    gateway,
    accounts: [account],
    scopes: ['https://www.googleapis.com/auth/adwords'],
    enabled: true,
    label: 'Synthetic',
  };
  store.putConnection(admin, c, {accessToken: 'synthetic'});
  let revoke = false,
    code = 200,
    fail = false;
  const transport = new NativeTransport(
    async (url, init) => {
      calls.push({url: String(url), method: init!.method, body: JSON.parse(String(init!.body))});
      if (revoke) store.putConnection(admin, {...c, accounts: [], enabled: false}, {accessToken: 'synthetic'});
      if (fail) throw Error('Synthetic lost response');
      return Response.json(response, {status: code});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: false,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  return {
    store,
    service,
    calls,
    c,
    transport,
    revoke: () => {
      revoke = true;
    },
    status: (v: number) => {
      code = v;
    },
    lost: () => {
      fail = true;
    },
  };
}
for (const [action, payload, response] of actions)
  test(action + ' returns scoped drafts in a read-only deployment without a provider mutation', async () => {
    const f = fixture(response);
    try {
      const result = await f.service.call(gateway, {action, account_id: account, payload, dry_run: false}, actor);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.data.generation.status, 'generated');
      assert.equal(result.data.generation.provider_mutations, false);
      assert.equal(result.data.generation.changes_applied, false);
      assert.equal(result.data.generation.count, 1);
      assert.deepEqual(result.data.data, response);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0]!.method, 'POST');
      assert.match(
        f.calls[0]!.url,
        /^https:\/\/googleads\.googleapis\.com\/v25\/customers\/123\/(?:assetGenerations:generate(?:Text|Images)|recommendations:generate)$/,
      );
      assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM idempotency').get()!.n, 0);
      const row = actionContracts(registry).find(a => a.gateway === gateway && a.action === action);
      assert.equal(row?.status, 'native_read');
      assert.ok(result.meta.untrusted_provider_content);
      assert.ok(!JSON.stringify(f.store.audit(actor.tenantId)).includes('synthetic-private-signature'));
    } finally {
      f.store.close();
    }
  });
test('native snake_case and ProtoJSON camelCase compile to the same generation request', async () => {
  const f = fixture(actions[0]![2]);
  try {
    for (const payload of [
      text,
      {
        assetFieldTypes: ['HEADLINE', 'DESCRIPTION'],
        advertisingChannelType: 'SEARCH',
        finalUrl: 'https://example.com/homes',
        freeformPrompt: text.freeform_prompt,
      },
    ]) {
      const r = await f.service.call(gateway, {action: actions[1]![0], account_id: account, payload}, actor);
      assert.equal(r.success, true, JSON.stringify(r));
    }
    assert.deepEqual(f.calls[0]!.body, f.calls[1]!.body);
  } finally {
    f.store.close();
  }
});
test('all image generation modes and both existing text contexts use the native v23 contract', async () => {
  for (const payload of [
    images,
    {advertising_channel_type: 'PERFORMANCE_MAX', final_url_generation: {final_url: 'https://example.com/homes'}},
    {
      advertising_channel_type: 'DEMAND_GEN',
      product_recontext_generation: {source_images: [{image_data: 'aW1hZ2U='}], prompt: 'Keep the product unchanged.'},
    },
  ]) {
    const f = fixture(actions[2]![2]);
    try {
      const r = await f.service.call(gateway, {action: actions[3]![0], account_id: account, payload}, actor);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(f.calls.length, 1);
      if ('product_recontext_generation' in payload) {
        assert.equal(f.calls[0]!.body.productRecontextGeneration.sourceImages[0].imageData, 'aW1hZ2U=');
        assert.ok(!JSON.stringify(f.store.audit(actor.tenantId)).includes('aW1hZ2U='));
      }
    } finally {
      f.store.close();
    }
  }
  for (const context of [
    {existing_ad_group_ad: 'customers/123/adGroupAds/45~67'},
    {existing_asset_group: 'customers/123/assetGroups/89'},
  ]) {
    const f = fixture(actions[0]![2]);
    try {
      const r = await f.service.call(
        gateway,
        {
          action: actions[1]![0],
          account_id: account,
          payload: {asset_field_types: ['HEADLINE'], existing_generation_context: context},
        },
        actor,
      );
      assert.equal(r.success, true, JSON.stringify(r));
    } finally {
      f.store.close();
    }
  }
});
test('generation rejects missing context, wrong oneofs, invented fields, unsafe URLs, unsupported field types and malformed image bytes before egress', async () => {
  const invalid: [string, JsonObject][] = [
    [actions[1]![0], {asset_field_types: ['HEADLINE']}],
    [actions[1]![0], {...text, existing_generation_context: {existing_asset_group: 'customers/123/assetGroups/89'}}],
    [
      actions[1]![0],
      {
        asset_field_types: ['HEADLINE'],
        existing_generation_context: {
          existing_asset_group: 'customers/123/assetGroups/89',
          existing_ad_group_ad: 'customers/123/adGroupAds/45~67',
        },
      },
    ],
    [actions[1]![0], {...text, freeform_prompt: 'x'.repeat(1501)}],
    [actions[1]![0], {...text, asset_field_types: ['CALL']}],
    [actions[1]![0], {...text, asset_field_types: ['HEADLINE', 'HEADLINE']}],
    [actions[1]![0], {...text, save_asset: true}],
    [actions[1]![0], {...text, assetFieldTypes: ['DESCRIPTION']}],
    [
      actions[1]![0],
      {
        asset_field_types: ['HEADLINE'],
        existing_generation_context: {existing_asset_group: 'customers/999/assetGroups/89'},
      },
    ],
    [actions[3]![0], {...images, final_url_generation: {final_url: 'https://example.com'}}],
    [actions[3]![0], {...images, existing_generation_context: {existing_asset_group: 'customers/123/assetGroups/89'}}],
    [
      actions[3]![0],
      {
        advertising_channel_type: 'DISPLAY',
        product_recontext_generation: {source_images: [{image_data: 'not base64!'}]},
      },
    ],
    [actions[3]![0], {advertising_channel_type: 'DISPLAY', product_recontext_generation: {source_images: []}}],
    ...[
      'http://127.0.0.1',
      'https://169.254.169.254',
      'https://[::1]/',
      'file:///tmp/image',
      'https://user:pass@example.com',
      'https://example.com/?access_token=synthetic',
    ].map(url => [actions[1]![0], {...text, final_url: url}] as [string, JsonObject]),
  ];
  const f = fixture({});
  try {
    for (const [action, payload] of invalid) {
      const r = await f.service.call(gateway, {action, account_id: account, payload, dry_run: false}, actor);
      assert.equal(r.success, false, action + JSON.stringify(payload));
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('account selection, Ads scope and in-flight revocation are enforced independently of draft generation', async () => {
  for (const mode of ['account', 'scope', 'disabled', 'revoke'] as const) {
    const f = fixture(actions[0]![2]);
    try {
      if (mode === 'scope')
        f.store.putConnection(
          admin,
          {...f.c, scopes: ['openid', 'https://www.googleapis.com/auth/analytics.readonly']},
          {accessToken: 'synthetic'},
        );
      if (mode === 'disabled') f.store.putConnection(admin, {...f.c, enabled: false}, {accessToken: 'synthetic'});
      if (mode === 'revoke') f.revoke();
      const r = await f.service.call(
        gateway,
        {action: actions[1]![0], account_id: mode === 'account' ? '999' : account, payload: text, dry_run: false},
        actor,
      );
      assert.equal(r.success, false);
      assert.equal(f.calls.length, mode === 'revoke' ? 1 : 0);
    } finally {
      f.store.close();
    }
  }
});
test('every supported recommendation type receives required evidence without inferring missing business inputs', async () => {
  const bidding = [
    'MAXIMIZE_CLICKS_OPT_IN',
    'MAXIMIZE_CONVERSIONS_OPT_IN',
    'MAXIMIZE_CONVERSION_VALUE_OPT_IN',
    'SET_TARGET_CPA',
    'SET_TARGET_ROAS',
    'TARGET_CPA_OPT_IN',
    'TARGET_ROAS_OPT_IN',
  ];
  const f = fixture({recommendations: []});
  try {
    for (const type of ['SITELINK_ASSET', 'KEYWORD', 'CAMPAIGN_BUDGET', ...bidding]) {
      const payload: JsonObject = {
        advertising_channel_type: 'SEARCH',
        recommendation_types: [type],
        ...(type === 'SITELINK_ASSET'
          ? {campaign_sitelink_count: 0}
          : type === 'KEYWORD'
            ? {seed_info: {keyword_seeds: ['homes']}}
            : type === 'CAMPAIGN_BUDGET'
              ? {
                  bidding_info: {bidding_strategy_type: 'MANUAL_CPC'},
                  asset_group_info: [{final_url: 'https://example.com'}],
                  ad_group_info: [{keywords: [{text: 'homes', match_type: 'EXACT'}]}],
                  country_codes: ['SA'],
                  language_codes: ['en'],
                  positive_locations_ids: ['2682'],
                  budget_info: {current_budget: '0'},
                }
              : {
                  bidding_info: {bidding_strategy_type: 'MANUAL_CPC'},
                  conversion_tracking_status: 'NOT_CONVERSION_TRACKED',
                }),
      };
      const r = await f.service.call(gateway, {action: actions[5]![0], account_id: account, payload}, actor);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.generation.status, 'no_output');
      assert.deepEqual(r.data.generation.types_without_output, [type]);
      assert.match(r.data.generation.empty_result_meaning, /insufficient/);
    }
    assert.equal(f.calls.length, 10);
  } finally {
    f.store.close();
  }
});
test('incomplete recommendation evidence is a local error instead of a misleading successful empty result', async () => {
  const f = fixture({});
  try {
    for (const payload of [
      {advertising_channel_type: 'SEARCH', recommendation_types: ['SITELINK_ASSET']},
      {advertising_channel_type: 'SEARCH', recommendation_types: ['KEYWORD'], seed_info: {}},
      {advertising_channel_type: 'SEARCH', recommendation_types: ['CAMPAIGN_BUDGET']},
      {advertising_channel_type: 'SEARCH', recommendation_types: ['MAXIMIZE_CLICKS_OPT_IN'], bidding_info: {}},
      {...recommendations, merchant_center_account_id: '7'},
      {...recommendations, campaign_sitelink_count: -1},
      {...recommendations, budget_info: null},
      {...recommendations, recommendation_types: ['TEXT_AD']},
    ]) {
      const r = await f.service.call(gateway, {action: actions[5]![0], account_id: account, payload}, actor);
      assert.equal(r.success, false);
      assert.equal(r.error.code, 'INVALID_VENDOR_BODY', JSON.stringify(r));
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('empty protobuf output is explicit and malformed or partial responses never look successful', async () => {
  for (const [action, payload, key] of [
    [actions[1]![0], text, 'generatedText'],
    [actions[3]![0], images, 'generatedImages'],
    [actions[5]![0], recommendations, 'recommendations'],
  ] as const) {
    for (const response of [{}, {[key]: []}]) {
      const f = fixture(response);
      try {
        const r = await f.service.call(gateway, {action, account_id: account, payload}, actor);
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal(r.data.generation.status, 'no_output');
      } finally {
        f.store.close();
      }
    }
    for (const response of [
      {[key]: null},
      {[key]: {}},
      {[key]: [{}]},
      {[key]: [], nextPageToken: 'next'},
      {partialFailureError: {message: 'failed'}},
    ]) {
      const f = fixture(response);
      try {
        const r = await f.service.call(gateway, {action, account_id: account, payload}, actor);
        assert.equal(r.success, false, JSON.stringify(r));
        assert.equal(f.calls.length, 1);
      } finally {
        f.store.close();
      }
    }
  }
});
test('generation never paginates, retries lost responses or enables apply and shareable-preview mutations', async () => {
  const p = compiler.compile(gateway, {action: actions[1]![0], account_id: account, payload: text}, options);
  for (const path of [
    '/v25/customers/123/recommendations:apply',
    '/v25/customers/123/recommendations:dismiss',
    '/v25/customers/123:generateShareablePreviews',
    '/v25/customers/123/campaigns:generateText',
  ])
    assert.equal(applyExecutionRisk({...p, path}).readOnly, false);
  assert.equal(googleGenerationKind({...p, origin: 'https://attacker.example'}), undefined);
  assert.throws(() => validateGoogleGeneration({...p, headers: {'X-HTTP-Method-Override': 'DELETE'}}), {
    code: 'INVALID_VENDOR_BODY',
  });
  assert.throws(() => validateGoogleGeneration({...p, query: {method: 'DELETE'}}), {code: 'INVALID_VENDOR_BODY'});
  for (const mode of ['paginate', 'lost', '429', '503'] as const) {
    const f = fixture({error: {message: 'Synthetic unavailable'}});
    try {
      if (mode === 'lost') f.lost();
      if (mode === '429' || mode === '503') f.status(Number(mode));
      const r = await f.service.call(
        gateway,
        {action: actions[1]![0], account_id: account, payload: text, ...(mode === 'paginate' ? {paginate: true} : {})},
        actor,
      );
      assert.equal(r.success, false);
      assert.equal(f.calls.length, mode === 'paginate' ? 0 : 1);
    } finally {
      f.store.close();
    }
  }
});
test('dry-run generation validates inputs and labels drafts without needing a connection', async () => {
  const f = fixture({});
  try {
    const r = await f.service.call(
      gateway,
      {action: actions[1]![0], account_id: account, payload: text, dry_run: true},
      actor,
    );
    assert.equal(r.success, true);
    assert.equal(r.data.executed, false);
    assert.match(r.data.request.warnings.join(' '), /does not save assets/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('Search impression-share and retail Performance Max inputs preserve native units and validate required evidence', async () => {
  const shared = {recommendation_types: ['CAMPAIGN_BUDGET'], asset_group_info: [{final_url: 'https://example.com'}]};
  const search = {
    ...shared,
    advertising_channel_type: 'SEARCH',
    country_codes: ['SA'],
    language_codes: ['en'],
    negative_locations_ids: ['2840'],
    ad_group_info: [{keywords: [{text: 'homes', match_type: 'PHRASE'}]}],
    bidding_info: {
      bidding_strategy_type: 'TARGET_IMPRESSION_SHARE',
      target_impression_share_info: {
        target_impression_share_micros: '10000',
        location: 'TOP_OF_PAGE',
        max_cpc_bid_ceiling: '1234567',
      },
    },
  };
  const retail = {
    ...shared,
    advertising_channel_type: 'PERFORMANCE_MAX',
    merchant_center_account_id: '789',
    bidding_info: {bidding_strategy_type: 'MAXIMIZE_CONVERSION_VALUE', target_roas: 3.5},
    budget_info: {current_budget: '25000000'},
  };
  const f = fixture({});
  try {
    for (const payload of [search, retail]) {
      const r = await f.service.call(gateway, {action: actions[5]![0], account_id: account, payload}, actor);
      assert.equal(r.success, true, JSON.stringify(r));
    }
    assert.equal(f.calls[0]!.body.biddingInfo.targetImpressionShareInfo.targetImpressionShareMicros, '10000');
    assert.equal(f.calls[1]!.body.budgetInfo.currentBudget, '25000000');
    assert.equal(f.calls[1]!.body.biddingInfo.targetRoas, 3.5);
    for (const value of ['0', '1000001', null]) {
      const payload = {
        ...search,
        bidding_info: {
          ...search.bidding_info,
          target_impression_share_info: {target_impression_share_micros: value, location: 'TOP_OF_PAGE'},
        },
      };
      assert.equal(
        (await f.service.call(gateway, {action: actions[5]![0], account_id: account, payload}, actor)).success,
        false,
      );
    }
    for (const payload of [
      {...search, ad_group_info: []},
      {...search, country_codes: []},
      {...retail, bidding_info: {bidding_strategy_type: 'MANUAL_CPC', target_roas: 3.5}},
    ])
      assert.equal(
        (await f.service.call(gateway, {action: actions[5]![0], account_id: account, payload}, actor)).success,
        false,
      );
    assert.equal(f.calls.length, 2);
  } finally {
    f.store.close();
  }
});
test('duplicate customer IDs require selecting one connection and revoked Ads scopes stop the result', async () => {
  const f = fixture(actions[0]![2]);
  try {
    f.store.putConnection(admin, {...f.c, id: 'other', scopes: []}, {accessToken: 'synthetic-other'});
    const args = {action: actions[1]![0], account_id: account, payload: text};
    assert.equal((await f.service.call(gateway, args, actor)).error?.code, 'AMBIGUOUS_CONNECTION');
    assert.equal(
      (await f.service.call(gateway, {...args, connection_id: 'other'}, actor)).error?.code,
      'INSUFFICIENT_SCOPE',
    );
    assert.equal((await f.service.call(gateway, {...args, connection_id: 'c'}, actor)).success, true);
    assert.equal(f.calls.length, 1);
    const service = new MirrorService(
      registry,
      f.store,
      new NativeTransport(async () => {
        f.store.putConnection(admin, {...f.c, scopes: []}, {accessToken: 'synthetic'});
        return Response.json(actions[0]![2]);
      }),
    );
    const r = await service.call(gateway, {...args, connection_id: 'c'}, actor);
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'INSUFFICIENT_SCOPE');
  } finally {
    f.store.close();
  }
});
test('wrong output field types, malformed temporary URLs and unrelated recommendations are rejected', async () => {
  for (const [action, payload, response] of [
    [actions[1]![0], text, {generatedText: [{text: 'Unrequested', assetFieldType: 'LONG_HEADLINE'}]}],
    [actions[1]![0], text, {generatedText: [{text: ' ', assetFieldType: 'HEADLINE'}]}],
    [
      actions[3]![0],
      images,
      {generatedImages: [{imageTemporaryUrl: 'https://127.0.0.1/image', assetFieldType: 'MARKETING_IMAGE'}]},
    ],
    [
      actions[3]![0],
      images,
      {generatedImages: [{imageTemporaryUrl: 'http://images.example.com/image', assetFieldType: 'MARKETING_IMAGE'}]},
    ],
    [
      actions[5]![0],
      recommendations,
      {
        recommendations: [
          {type: 'CAMPAIGN_BUDGET', campaignBudgetRecommendation: {recommendedBudgetAmountMicros: '5000000'}},
        ],
      },
    ],
  ] as [string, JsonObject, JsonObject][]) {
    const f = fixture(response);
    try {
      const r = await f.service.call(gateway, {action, account_id: account, payload}, actor);
      assert.equal(r.success, false);
      assert.equal(r.error.code, 'UPSTREAM_RESPONSE_INVALID');
      assert.equal(f.calls.length, 1);
    } finally {
      f.store.close();
    }
  }
});
