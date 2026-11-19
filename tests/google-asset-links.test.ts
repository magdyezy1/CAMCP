import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService, strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {googleAssetLinkContracts, googleAssetContentFields} from '../src/google-asset-links.js';
import {saveSpendPolicy, checkSpendPolicy} from '../src/spend-policy.js';
import {Compiler} from '../src/compiler.js';
import {MirrorError, errorRemedy} from '../src/errors.js';
import type {JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';

const registry = new Registry(),
  gateway = 'google_ads_native_action',
  actor = {tenantId: 'asset-links', userId: 'writer', role: 'operator' as const},
  admin = {...actor, role: 'admin' as const};
const n = (kind: string, id: string) => 'customers/123/' + kind + '/' + id;
const actions: Record<string, string> = {
  campaignAssets: 'google_ads_v23_campaign_asset_mutate_campaign_assets',
  adGroupAssets: 'google_ads_v23_ad_group_asset_mutate_ad_group_assets',
  customerAssets: 'google_ads_v23_customer_asset_mutate_customer_assets',
  assetGroupAssets: 'google_ads_v23_asset_group_asset_mutate_asset_group_assets',
};
const pack = Array.from({length: 11}, (_, i) => ({
  create: {
    campaign: n('campaigns', '100'),
    asset: n('assets', String(200 + i)),
    fieldType: i < 6 ? 'SITELINK' : i < 10 ? 'CALLOUT' : 'STRUCTURED_SNIPPET',
  },
}));
function setup() {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const records = new Map<string, JsonObject>([
    [
      n('campaigns', '100'),
      {
        resourceName: n('campaigns', '100'),
        name: 'Synthetic',
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: n('campaignBudgets', '10'),
      },
    ],
    [
      n('adGroups', '101'),
      {resourceName: n('adGroups', '101'), name: 'Group', status: 'PAUSED', campaign: n('campaigns', '100')},
    ],
    [
      n('assetGroups', '102'),
      {
        resourceName: n('assetGroups', '102'),
        name: 'Performance Max',
        status: 'PAUSED',
        campaign: n('campaigns', '100'),
      },
    ],
    ...pack.map(
      (op, i) =>
        [
          op.create.asset,
          {
            resourceName: op.create.asset,
            type: op.create.fieldType,
            source: 'ADVERTISER',
            finalUrls: ['https://example.test/' + i],
            ...(i < 6
              ? {sitelinkAsset: {linkText: 'Sitelink ' + i, description1: 'First line', description2: 'Second line'}}
              : i < 10
                ? {calloutAsset: {calloutText: 'Callout ' + i}}
                : {structuredSnippetAsset: {header: 'Types', values: ['First', 'Second', 'Third']}}),
          },
        ] as [string, JsonObject],
    ),
    [
      n('assets', '300'),
      {resourceName: n('assets', '300'), type: 'TEXT', source: 'ADVERTISER', textAsset: {text: 'Example headline'}},
    ],
  ]);
  let writes = 0,
    reads = 0,
    mode = '',
    omitEmpty = true;
  const calls: JsonObject[] = [];
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init) => {
      const path = new URL(String(url)).pathname,
        b = JSON.parse(String(init?.body));
      calls.push({path, body: b});
      if (path.endsWith('googleAds:search')) {
        reads++;
        const entity = b.query.match(/ FROM ([a-z_]+)/)[1],
          key = entity.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase()),
          names = [...b.query.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]);
        const rows: JsonObject[] =
          entity === 'customer'
            ? [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]
            : // R2.5 M3, G3 (package r25-m3-pmax): the review's read of the live links of an asset group asks by the group, not by
              // link names, and Google answers the links whose asset_group is one of those named.
              entity === 'asset_group_asset' && /WHERE asset_group_asset\.asset_group IN /.test(b.query)
              ? [...records.entries()]
                  .filter(([name, r]) => name.includes('/assetGroupAssets/') && names.includes(String(r.assetGroup)))
                  .map(([, r]) => ({[key]: structuredClone(r)}))
              : names.filter(name => records.has(name)).map(name => ({[key]: structuredClone(records.get(name)!)}));
        if (mode === 'empty_object' && entity.endsWith('_asset')) return Response.json({});
        if (mode === 'foreign' && entity.endsWith('_asset'))
          rows.push({[key]: {resourceName: 'customers/999/campaignAssets/100~200~SITELINK'}});
        if (mode === 'duplicate' && rows.length) rows.push(rows[0]!);
        const data: JsonObject = {
          ...(!omitEmpty || rows.length ? {results: rows} : {}),
          fieldMask: b.query.split(' FROM')[0].slice(7),
          queryResourceConsumption: String(reads * 13),
          futureQueryTelemetry: reads,
        };
        if (mode === 'pagination') data.nextPageToken = 'unread-page';
        if (mode === 'read_error') data.error = {code: 403};
        return Response.json(data);
      }
      writes++;
      const kind = path.match(/\/([^/]+):mutate$/)![1],
        cfg = googleAssetLinkContracts[kind as keyof typeof googleAssetLinkContracts];
      const results = b.operations.map((op: JsonObject) => {
        const r = op.create ?? op.update,
          name =
            op.remove ??
            op.update?.resourceName ??
            n(
              kind!,
              [...(cfg.parent ? [r[cfg.parent].split('/').at(-1)] : []), r.asset.split('/').at(-1), r.fieldType].join(
                '~',
              ),
            );
        if (op.remove) records.delete(name);
        else records.set(name, {...records.get(name), ...r, resourceName: name, status: r.status ?? 'ENABLED'});
        return {resourceName: mode === 'wrong_receipt' ? name.replace('~200~', '~999~') : name};
      });
      return Response.json({results: mode === 'partial_receipt' ? results.slice(1) : results});
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const prepare = (kind = 'campaignAssets', operations: JsonObject[] = pack, legacy?: string) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: legacy ?? actions[kind], account_id: '123', payload: {operations, partialFailure: false}},
      },
      actor,
    );
  const execute = (p: JsonObject) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
      },
      actor,
    );
  return {
    store,
    service,
    records,
    calls,
    prepare,
    execute,
    writes: () => writes,
    reads: () => reads,
    mode: (value: string) => {
      mode = value;
    },
    explicitEmpty: () => {
      omitEmpty = false;
    },
  };
}
for (const surface of ['rpc', 'legacy'])
  test(
    'Google eleven-asset pack links and verifies all six sitelinks, four callouts and snippet: ' + surface,
    async () => {
      const x = setup();
      try {
        const inspected = await x.service.call(
          'amcp_write',
          {
            action: 'inspect',
            gateway,
            arguments: {
              action: surface === 'rpc' ? actions.campaignAssets : 'CREATE_CAMPAIGN_ASSET',
              account_id: '123',
              payload: {operations: pack},
            },
          },
          actor,
        );
        assert.equal(inspected.data.review_contract_supported, true, JSON.stringify(inspected));
        assert.equal(x.reads(), 0);
        const p = await x.prepare('campaignAssets', pack, surface === 'legacy' ? 'CREATE_CAMPAIGN_ASSET' : undefined);
        assert.equal(p.success, true, JSON.stringify(p));
        assert.equal(x.writes(), 0);
        assert.equal(x.reads(), 5, 'one link query, one campaign, three asset-type batches');
        assert.ok(x.calls.some(c => c.body.query?.includes('asset.sitelink_asset.description1')));
        assert.ok(x.calls.every(c => !c.body.query?.includes('metrics.')));
        const e = await x.execute(p);
        assert.equal(e.success, true, JSON.stringify(e));
        assert.equal(x.writes(), 1);
        assert.equal((await x.execute(p)).data.replayed, true);
        assert.equal(x.writes(), 1);
        const verified = await x.service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
        assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
        assert.equal(verified.data.checks.length, 11);
        assert.equal(x.writes(), 1);
      } finally {
        x.store.close();
      }
    },
  );

test('Google implicit enabled asset associations require separate spend confirmation', async () => {
  const x = setup();
  try {
    const p = await x.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    const denied = await x.service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
    assert.equal(denied.error.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});
for (const kind of Object.keys(actions))
  test('Google asset associations create, update status and verify removal at ' + kind, async () => {
    const x = setup();
    try {
      const cfg = googleAssetLinkContracts[kind as keyof typeof googleAssetLinkContracts],
        r: JsonObject = {
          asset: n('assets', kind === 'assetGroupAssets' ? '300' : '200'),
          fieldType: kind === 'assetGroupAssets' ? 'HEADLINE' : 'SITELINK',
          status: 'PAUSED',
          ...(cfg.parent
            ? {
                [cfg.parent]: n(
                  cfg.collection,
                  kind === 'campaignAssets' ? '100' : kind === 'adGroupAssets' ? '101' : '102',
                ),
              }
            : {}),
        };
      const p = await x.prepare(kind, [{create: r}]);
      assert.equal(p.success, true, JSON.stringify(p));
      const e = await x.execute(p);
      assert.equal(e.success, true, JSON.stringify(e));
      const name = e.data.data.results[0].resourceName;
      const u = await x.prepare(kind, [{update: {resource_name: name, status: 'ENABLED'}, update_mask: 'status'}]);
      assert.equal(u.success, true, JSON.stringify(u));
      assert.equal((await x.execute(u)).success, true);
      const uv = await x.service.call('amcp_campaign', {action: 'verify', review_id: u.data.review_id}, actor);
      assert.equal(uv.data.status, 'verified', JSON.stringify(uv));
      const d = await x.prepare(kind, [{remove: name}]);
      assert.equal(d.success, true, JSON.stringify(d));
      assert.equal((await x.execute(d)).success, true);
      const dv = await x.service.call('amcp_campaign', {action: 'verify', review_id: d.data.review_id}, actor);
      assert.equal(dv.data.status, 'verified', JSON.stringify(dv));
    } finally {
      x.store.close();
    }
  });
test('Google asset links reject malformed, cross-account, duplicated, mismatched and missing prerequisites', async () => {
  const x = setup();
  try {
    for (const op of [
      {create: {...pack[0]!.create, asset: 'customers/999/assets/200'}},
      {create: {...pack[0]!.create, fieldType: 'HEADLINE'}},
      {create: {...pack[0]!.create, status: 'REMOVED'}},
      {update: {resourceName: n('campaignAssets', '100~200~SITELINK'), asset: n('assets', '201')}, updateMask: 'asset'},
      {create: {...pack[0]!.create, resourceName: n('campaignAssets', '100~200~SITELINK')}},
      {remove: n('campaignAssets', '100~200')},
    ])
      assert.equal((await x.prepare('campaignAssets', [op])).success, false, JSON.stringify(op));
    assert.equal((await x.prepare('campaignAssets', [pack[0]!, pack[0]!])).error.code, 'INVALID_ASSET_LINK');
    assert.equal(x.reads(), 0);
    x.records.get(n('assets', '200'))!.type = 'CALLOUT';
    assert.equal((await x.prepare()).error.code, 'ASSET_TYPE_MISMATCH');
    x.records.delete(n('assets', '200'));
    assert.equal((await x.prepare()).error.code, 'STATE_TARGET_MISMATCH');
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});
for (const change of ['asset_copy', 'parent', 'association'])
  test('Google asset link optimistic concurrency protects ' + change, async () => {
    const x = setup();
    try {
      const p = await x.prepare();
      assert.equal(p.success, true, JSON.stringify(p));
      if (change === 'asset_copy') x.records.get(n('assets', '200'))!.sitelinkAsset.description1 = 'Changed';
      else if (change === 'parent') x.records.get(n('campaigns', '100'))!.name = 'Changed';
      else
        x.records.set(n('campaignAssets', '100~200~SITELINK'), {
          ...pack[0]!.create,
          resourceName: n('campaignAssets', '100~200~SITELINK'),
          status: 'ENABLED',
        });
      const e = await x.execute(p);
      assert.equal(e.error.code, 'STATE_CHANGED', JSON.stringify(e));
      assert.ok(e.error.details.changed_fields.length);
      assert.equal(x.writes(), 0);
      if (change === 'association') assert.equal((await x.prepare()).error.code, 'ASSET_LINK_EXISTS');
    } finally {
      x.store.close();
    }
  });
for (const mode of ['pagination', 'read_error', 'foreign', 'duplicate'])
  test('Google optional association reads cannot hide ' + mode, async () => {
    const x = setup();
    try {
      x.mode(mode);
      assert.equal((await x.prepare()).success, false);
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  });
for (const mode of ['empty_object', 'explicit_empty'])
  test('Google documented ProtoJSON absence: ' + mode, async () => {
    const x = setup();
    try {
      if (mode === 'explicit_empty') x.explicitEmpty();
      else x.mode(mode);
      const p = await x.prepare();
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal((await x.execute(p)).success, true);
    } finally {
      x.store.close();
    }
  });
for (const mode of ['wrong_receipt', 'partial_receipt'])
  test('Google asset mutation requires all exact association receipts: ' + mode, async () => {
    const x = setup();
    try {
      const p = await x.prepare();
      x.mode(mode);
      const e = await x.execute(p);
      assert.equal(e.data.success, false, JSON.stringify(e));
      assert.equal(x.writes(), 1);
      await x.execute(p);
      assert.equal(x.writes(), 1);
      assert.equal(e.data.verification, undefined);
    } finally {
      x.store.close();
    }
  });
test('Google default-enabled links cannot bypass the owner activation policy', async () => {
  const x = setup();
  try {
    saveSpendPolicy(x.store, admin, {gateway, account_id: '123', confirmed: true, policy: {allow_activation: false}});
    assert.equal((await x.prepare()).error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    const paused = pack.map(op => ({create: {...op.create, status: 'PAUSED'}})),
      p = await x.prepare('campaignAssets', paused);
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await x.execute(p)).success, true);
  } finally {
    x.store.close();
  }
});
test('Google concurrent asset executions submit the frozen batch once', async () => {
  const x = setup();
  try {
    const p = await x.prepare();
    const results = await Promise.all([x.execute(p), x.execute(p)]);
    assert.ok(results.some(r => r.success));
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});
test('Google asset content snapshots only select fields in the pinned official GAQL reference', () => {
  const evidence = JSON.parse(fs.readFileSync('tests/fixtures/google-asset-fields-v23.json', 'utf8'));
  assert.equal(evidence.source, 'https://developers.google.com/google-ads/api/fields/v23/asset');
  assert.match(evidence.source_sha256, /^[0-9a-f]{64}$/);
  for (const field of Object.values(googleAssetContentFields).flat())
    assert.equal(evidence.fields[field]?.selectable, true, field);
  assert.ok(
    !Object.values(googleAssetContentFields).flat().includes('lead_form_asset.delivery_methods'),
    'linking never retrieves delivery credentials',
  );
});

test('Google symbolic asset field types build exact legacy remove identities', () => {
  const compiler = new Compiler(registry);
  for (const [action, parts, expected] of [
    [
      'REMOVE_CAMPAIGN_ASSET',
      {campaign_id: '100', asset_id: '200', field_type: 'SITELINK'},
      n('campaignAssets', '100~200~SITELINK'),
    ],
    [
      'REMOVE_AD_GROUP_ASSET',
      {ad_group_id: '101', asset_id: '200', field_type: 'SITELINK'},
      n('adGroupAssets', '101~200~SITELINK'),
    ],
    ['REMOVE_CUSTOMER_ASSET', {asset_id: '200', field_type: 'SITELINK'}, n('customerAssets', '200~SITELINK')],
    [
      'REMOVE_ASSET_GROUP_ASSET',
      {asset_group_id: '102', asset_id: '300', field_type: 'HEADLINE'},
      n('assetGroupAssets', '102~300~HEADLINE'),
    ],
  ] as const) {
    const p = compiler.compile(gateway, {action, account_id: '123', payload: parts}, strictOptions);
    assert.equal((p.body as JsonObject).operations[0].remove, expected);
    assert.throws(
      () =>
        compiler.compile(
          gateway,
          {action, account_id: '123', payload: {...parts, field_type: 'INVENTED'}},
          strictOptions,
        ),
      {code: 'INVALID_RESOURCE_ID'},
    );
  }
});

test('Google POST removals enforce current deletion policy, including older frozen risk flags', async () => {
  const x = setup();
  try {
    const p = await x.prepare();
    assert.equal((await x.execute(p)).success, true);
    const target = n('campaignAssets', '100~200~SITELINK'),
      r = await x.prepare('campaignAssets', [{remove: target}]);
    assert.equal(r.success, true, JSON.stringify(r));
    const review = x.store.document(actor.tenantId, 'write_review', r.data.review_id);
    assert.equal(review.plan.destructive, true);
    saveSpendPolicy(x.store, admin, {gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}});
    assert.equal((await x.execute(r)).error.code, 'POLICY_DELETION_FORBIDDEN');
    assert.equal(x.writes(), 1);
    assert.throws(() => checkSpendPolicy(x.store, actor, {...review.plan, destructive: false}, review.state), {
      code: 'POLICY_DELETION_FORBIDDEN',
    });
  } finally {
    x.store.close();
  }
});

// R2.5 M3, G2 (package r25-m3-pmax): TALL_PORTRAIT_MARKETING_IMAGE is a value of the pinned v25 AssetFieldType, and the one a retail
// launch links to its asset group. It was refused as "not supported at this association level". It links at the asset-group level
// only (Google's asset-requirements page lists no other level for the portrait types), to an image asset.
test('Google links a tall portrait marketing image at the asset-group level and verifies it, and refuses it at any other level', async () => {
  const x = setup();
  try {
    const image = n('assets', '400');
    x.records.set(image, {
      resourceName: image,
      type: 'IMAGE',
      source: 'ADVERTISER',
      imageAsset: {fileSize: '120000', fullSize: {widthPixels: 1080, heightPixels: 1920}, mimeType: 'IMAGE_PNG'},
    });
    const tall = (asset: string, parent: JsonObject = {assetGroup: n('assetGroups', '102')}) => ({
      create: {...parent, asset, fieldType: 'TALL_PORTRAIT_MARKETING_IMAGE', status: 'PAUSED'},
    });
    const p = await x.prepare('assetGroupAssets', [tall(image)]);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 1200));
    const e = await x.execute(p);
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 1200));
    assert.equal(e.data.data.results[0].resourceName, n('assetGroupAssets', '102~400~TALL_PORTRAIT_MARKETING_IMAGE'));
    const verified = await x.service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1200));
    // A text asset is not an image: the link is refused for its type, after the review reads it.
    const text = await x.prepare('assetGroupAssets', [tall(n('assets', '300'))]);
    assertRefused(text, 'ASSET_TYPE_MISMATCH', {writes: x.writes() - 1});
    assert.equal(text.error.details.expected_type, 'IMAGE');
    // Negative: tall portrait is no campaign or ad group role, so those levels still refuse it, before any read.
    const reads = x.reads();
    for (const [kind, parent] of [
      ['campaignAssets', {campaign: n('campaigns', '100')}],
      ['adGroupAssets', {adGroup: n('adGroups', '101')}],
    ] as const)
      assertRefused(await x.prepare(kind, [tall(image, parent)]), 'INVALID_ASSET_LINK', {writes: x.writes() - 1});
    assert.equal(x.reads(), reads, 'refused before any read');
    assert.equal(x.writes(), 1, 'one request in all, the first link');
  } finally {
    x.store.close();
  }
});

// Round 2, S3-1 (package r25-m3-pmax): with brand guidelines on, Google wants the business name, the logos and the landscape logos of a
// Performance Max campaign linked to the CAMPAIGN (a CampaignAsset with the field types BUSINESS_NAME, LOGO and LANDSCAPE_LOGO, as its
// create-campaign guide shows), and a link of one of them to an asset group is refused before it is sent (google-asset-links.ts). That
// refusal names this level as the place to link them, so this level takes them: until now it took BUSINESS_NAME and BUSINESS_LOGO only.
test('Google links the brand assets of a Performance Max campaign, LOGO and LANDSCAPE_LOGO, at the campaign level', async () => {
  const x = setup();
  try {
    const image = (id: string, width: number, height: number) => {
      x.records.set(n('assets', id), {
        resourceName: n('assets', id),
        type: 'IMAGE',
        source: 'ADVERTISER',
        imageAsset: {fileSize: '120000', fullSize: {widthPixels: width, heightPixels: height}, mimeType: 'IMAGE_PNG'},
      });
      return n('assets', id);
    };
    for (const [asset, fieldType] of [
      [image('410', 1200, 1200), 'LOGO'],
      [image('411', 1200, 300), 'LANDSCAPE_LOGO'],
    ] as const) {
      const p = await x.prepare('campaignAssets', [
        {create: {campaign: n('campaigns', '100'), asset, fieldType, status: 'PAUSED'}},
      ]);
      assert.equal(p.success, true, fieldType + ' ' + JSON.stringify(p).slice(0, 1200));
      const e = await x.execute(p);
      assert.equal(e.success, true, JSON.stringify(e).slice(0, 1200));
      assert.equal(
        e.data.data.results[0].resourceName,
        n('campaignAssets', '100~' + asset.split('/').at(-1) + '~' + fieldType),
      );
      const verified = await x.service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
      assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1200));
    }
    // A text asset is not an image: refused for its type after the review reads it, as for every image role.
    const text = await x.prepare('campaignAssets', [
      {create: {campaign: n('campaigns', '100'), asset: n('assets', '300'), fieldType: 'LOGO', status: 'PAUSED'}},
    ]);
    assertRefused(text, 'ASSET_TYPE_MISMATCH', {writes: x.writes() - 2});
    assert.equal(text.error.details.expected_type, 'IMAGE');
    // Negative: the ad group level takes neither, before any read.
    const reads = x.reads();
    for (const fieldType of ['LOGO', 'LANDSCAPE_LOGO'])
      assertRefused(
        await x.prepare('adGroupAssets', [
          {create: {adGroup: n('adGroups', '101'), asset: n('assets', '410'), fieldType, status: 'PAUSED'}},
        ]),
        'INVALID_ASSET_LINK',
        {writes: x.writes() - 2},
      );
    assert.equal(x.reads(), reads, 'refused before any read');
  } finally {
    x.store.close();
  }
});

// Round 3, N2 (package r25-m3-pmax): LOGO and LANDSCAPE_LOGO became campaign-level roles in round 2 because a campaign with brand
// guidelines on links them there. Google refuses them at that level on a Performance Max campaign with brand guidelines OFF
// (AssetLinkError.BRAND_ASSETS_NOT_LINKED_AT_ASSET_GROUP_LEVEL: "For Performance Max campaigns where brand_guidelines_enabled is
// false, business name and logo assets must be linked as AssetGroupAssets"), after the review was spent. The campaign-level read
// selects brand_guidelines_enabled, and such a create is refused at prepare, naming the asset-group level. Other channels stay with
// Google: its rule for them is not documented here.
test('Google refuses a LOGO or LANDSCAPE_LOGO at the campaign level of a Performance Max campaign with brand guidelines off, and takes it with them on', async () => {
  const x = setup();
  try {
    const campaign = n('campaigns', '100');
    const campaignRecord = (channel: string, brandGuidelines?: boolean) =>
      x.records.set(campaign, {
        resourceName: campaign,
        name: 'Synthetic',
        status: 'PAUSED',
        advertisingChannelType: channel,
        campaignBudget: n('campaignBudgets', '10'),
        // Google leaves out a boolean that is false, as it leaves out every default value.
        ...(brandGuidelines ? {brandGuidelinesEnabled: true} : {}),
      });
    const logo = n('assets', '410'),
      landscape = n('assets', '411');
    for (const [name, width, height] of [
      [logo, 1200, 1200],
      [landscape, 1200, 300],
    ] as const)
      x.records.set(name, {
        resourceName: name,
        type: 'IMAGE',
        source: 'ADVERTISER',
        imageAsset: {fileSize: '120000', fullSize: {widthPixels: width, heightPixels: height}, mimeType: 'IMAGE_PNG'},
      });
    const create = (asset: string, fieldType: string) => ({create: {campaign, asset, fieldType, status: 'PAUSED'}});
    // Brand guidelines on: both link.
    campaignRecord('PERFORMANCE_MAX', true);
    for (const [asset, fieldType] of [
      [logo, 'LOGO'],
      [landscape, 'LANDSCAPE_LOGO'],
    ] as const)
      assert.equal((await x.prepare('campaignAssets', [create(asset, fieldType)])).success, true, fieldType);
    // The read asks for the campaign's brand guideline mode.
    assert.ok(
      x.calls.some(
        c => /FROM campaign WHERE/.test(c.body.query ?? '') && /campaign\.brand_guidelines_enabled/.test(c.body.query),
      ),
      'the campaign-level read selects brand_guidelines_enabled',
    );
    // Brand guidelines off, or absent (Google leaves out false): refused before anything is sent, naming the asset-group level.
    for (const mode of [false, undefined]) {
      campaignRecord('PERFORMANCE_MAX', mode);
      for (const [asset, fieldType] of [
        [logo, 'LOGO'],
        [landscape, 'LANDSCAPE_LOGO'],
      ] as const) {
        const r = await x.prepare('campaignAssets', [create(asset, fieldType)]);
        assertRefused(r, 'INVALID_ASSET_LINK', {writes: x.writes()});
        assert.deepEqual(
          [r.error.details.operation, r.error.details.field, r.error.details.field_type],
          [0, 'operations[0].create.fieldType', fieldType],
        );
        assert.match(r.error.message, /BRAND_ASSETS_NOT_LINKED_AT_ASSET_GROUP_LEVEL/);
        assert.match(r.error.message, /google_ads_v23_asset_group_asset_mutate_asset_group_assets/);
      }
    }
    // The operation it names is the one in the request, wherever it is.
    const second = await x.prepare('campaignAssets', [create(n('assets', '200'), 'SITELINK'), create(logo, 'LOGO')]);
    assertRefused(second, 'INVALID_ASSET_LINK', {writes: x.writes()});
    assert.equal(second.error.details.operation, 1);
    // Negative: another channel is unchanged, whatever its brand guideline mode; Google decides.
    for (const channel of ['SEARCH', 'DEMAND_GEN']) {
      campaignRecord(channel, false);
      assert.equal((await x.prepare('campaignAssets', [create(logo, 'LOGO')])).success, true, channel);
    }
    // Negative: a link a Performance Max campaign without brand guidelines already holds can be removed.
    campaignRecord('PERFORMANCE_MAX', false);
    const legacy = n('campaignAssets', '100~410~LOGO');
    x.records.set(legacy, {resourceName: legacy, campaign, asset: logo, fieldType: 'LOGO', status: 'ENABLED'});
    assert.equal((await x.prepare('campaignAssets', [{remove: legacy}])).success, true);
    // Negative: the other roles of the level are not judged by this rule.
    assert.equal((await x.prepare('campaignAssets', pack)).success, true);
    assert.equal(x.writes(), 0, 'nothing was sent');
  } finally {
    x.store.close();
  }
});

// R2.5 M3, L2-07 (package r25-m3-pmax): the refusals of this module named neither the operation nor the field, so a 19-operation
// batch with one bad role (the WF26 report) said only "not supported at this association level". Each now carries
// {operation, field}, and the field type refusal also the value and the roles the level takes.
test('Google asset links: an invalid role names its operation, field, field type and the roles the level allows', async () => {
  const x = setup();
  try {
    // The WF26 request rebuilt with synthetic IDs: 19 links, mixing headlines, long headlines, descriptions, a square image, a
    // tall portrait image and a call to action; operation 7 takes AD_IMAGE, which asset groups do not.
    const roles = [
      ...Array.from({length: 7}, (_, i) => (i < 4 ? 'HEADLINE' : i < 5 ? 'LONG_HEADLINE' : 'DESCRIPTION')),
      'AD_IMAGE',
      'SQUARE_MARKETING_IMAGE',
      'TALL_PORTRAIT_MARKETING_IMAGE',
      ...Array.from({length: 8}, () => 'HEADLINE'),
      'CALL_TO_ACTION_SELECTION',
    ];
    assert.equal(roles.length, 19);
    const operations = roles.map((fieldType, i) => ({
      create: {assetGroup: n('assetGroups', '102'), asset: n('assets', String(300 + i)), fieldType},
    }));
    const r = await x.prepare('assetGroupAssets', operations);
    assertRefused(r, 'INVALID_ASSET_LINK', {writes: x.writes()});
    // The message carries the field too, as the service appends it: the sentence the WF26 report quoted, now with its place.
    assert.equal(
      r.error.message,
      'The asset fieldType is not supported at this association level: operations[7].create.fieldType.',
    );
    assert.equal(r.error.details.operation, 7);
    assert.equal(r.error.details.field, 'operations[7].create.fieldType');
    assert.equal(r.error.details.field_type, 'AD_IMAGE');
    assert.deepEqual(r.error.details.allowed, [...googleAssetLinkContracts.assetGroupAssets.roles]);
    assert.ok(r.error.details.allowed.includes('TALL_PORTRAIT_MARKETING_IMAGE'));
    assert.equal(x.reads(), 0, 'refused before any read');
    // The campaign level names its own roles, not the asset group's.
    const campaign = await x.prepare('campaignAssets', [
      {create: {campaign: n('campaigns', '100'), asset: n('assets', '200'), fieldType: 'HEADLINE'}},
    ]);
    assertRefused(campaign, 'INVALID_ASSET_LINK', {writes: x.writes()});
    assert.deepEqual(campaign.error.details.allowed, [...googleAssetLinkContracts.campaignAssets.roles]);
    assert.ok(!campaign.error.details.allowed.includes('TALL_PORTRAIT_MARKETING_IMAGE'));
  } finally {
    x.store.close();
  }
});
test('Google asset links: every other local refusal names its operation and its field', async () => {
  const x = setup();
  try {
    const good = pack[0]!.create;
    const name = n('campaignAssets', '100~200~SITELINK');
    const cases: [string, JsonObject[], number, string][] = [
      [
        'cross-account asset',
        [pack[1]!, {create: {...good, asset: 'customers/999/assets/200'}}],
        1,
        'operations[1].create.asset',
      ],
      ['unknown key', [{create: {...good, resourceName: name}}], 0, 'operations[0].create.resourceName'],
      ['removed status', [pack[1]!, {create: {...good, status: 'REMOVED'}}], 1, 'operations[1].create.status'],
      [
        'an update of the asset',
        [{update: {resourceName: name, asset: n('assets', '201')}, updateMask: 'asset'}],
        0,
        'operations[0].updateMask',
      ],
      ['a malformed remove', [{remove: n('campaignAssets', '100~200')}], 0, 'operations[0].remove'],
      ['a mask on a remove', [{remove: name, updateMask: 'status'}], 0, 'operations[0].updateMask'],
      ['the same link twice', [pack[0]!, pack[1]!, pack[0]!], 2, 'operations[2]'],
    ];
    for (const [what, operations, operation, field] of cases) {
      const r = await x.prepare('campaignAssets', operations);
      assertRefused(r, 'INVALID_ASSET_LINK', {writes: x.writes()});
      assert.equal(r.error.details.operation, operation, what + ': ' + JSON.stringify(r.error.details));
      assert.equal(r.error.details.field, field, what);
    }
    assert.deepEqual(
      (await x.prepare('campaignAssets', [{create: {...good, status: 'REMOVED'}}])).error.details.allowed,
      ['ENABLED', 'PAUSED'],
    );
    assert.equal((await x.prepare('campaignAssets', [pack[0]!, pack[0]!])).error.details.first_operation, 0);
    assert.equal(x.reads(), 0, 'all of these are refused before any read');
  } finally {
    x.store.close();
  }
});
test('Google asset links: the refusals of the state read name their operation and field too', async () => {
  const x = setup();
  try {
    x.records.get(n('assets', '200'))!.type = 'CALLOUT';
    const mismatch = await x.prepare();
    assertRefused(mismatch, 'ASSET_TYPE_MISMATCH', {writes: x.writes()});
    assert.deepEqual(
      [mismatch.error.details.operation, mismatch.error.details.field, mismatch.error.details.expected_type],
      [0, 'operations[0].create.asset', 'SITELINK'],
    );
    x.records.get(n('assets', '200'))!.type = 'SITELINK';
    x.records.get(n('campaigns', '100'))!.status = 'REMOVED';
    const parent = await x.prepare();
    assertRefused(parent, 'INVALID_ASSET_PARENT', {writes: x.writes()});
    assert.deepEqual(
      [parent.error.details.operation, parent.error.details.field],
      [0, 'operations[0].create.campaign'],
    );
    x.records.get(n('campaigns', '100'))!.status = 'PAUSED';
    x.records.set(n('campaignAssets', '100~200~SITELINK'), {
      ...pack[0]!.create,
      resourceName: n('campaignAssets', '100~200~SITELINK'),
      status: 'ENABLED',
    });
    const exists = await x.prepare();
    assertRefused(exists, 'ASSET_LINK_EXISTS', {writes: x.writes()});
    assert.deepEqual([exists.error.details.operation, exists.error.details.field], [0, 'operations[0].create']);
    assert.equal(exists.error.details.resource_name, n('campaignAssets', '100~200~SITELINK'));
    // A link that is REMOVED is no link: removing it again is refused by this module. (A link the account does not return at all
    // is refused earlier, by the adapter's own exact read check.)
    const removedLink = n('campaignAssets', '100~201~SITELINK');
    x.records.set(removedLink, {...pack[1]!.create, resourceName: removedLink, status: 'REMOVED'});
    const gone = await x.prepare('campaignAssets', [{remove: removedLink}]);
    assertRefused(gone, 'STATE_NOT_FOUND', {writes: x.writes()});
    assert.deepEqual([gone.error.details.operation, gone.error.details.field], [0, 'operations[0].remove']);
  } finally {
    x.store.close();
  }
});
test('Google asset links: the refusals carry the Google remedy, which names the next call', async () => {
  const x = setup();
  try {
    const role = await x.prepare('assetGroupAssets', [
      {create: {assetGroup: n('assetGroups', '102'), asset: n('assets', '300'), fieldType: 'AD_IMAGE'}},
    ]);
    assertRefused(role, 'INVALID_ASSET_LINK');
    assert.match(role.error.remedy.action, /^Nothing was sent to Google\./);
    assert.match(role.error.remedy.action, /details\.operation/);
    assert.match(role.error.remedy.action, /details\.allowed/);
    assert.match(role.error.remedy.action, /amcp_write prepare/);
    assert.equal(role.error.remedy.category, 'request');
    x.records.get(n('assets', '200'))!.type = 'CALLOUT';
    const mismatch = await x.prepare();
    assertRefused(mismatch, 'ASSET_TYPE_MISMATCH');
    assert.match(mismatch.error.remedy.action, /details\.expected_type/);
    assert.match(mismatch.error.remedy.action, /google_ads_v23_google_ads_search/);
    assert.match(mismatch.error.remedy.action, /amcp_write prepare/);
    // A code another provider raises keeps the shared answer: the Google table never answers it.
    assert.doesNotMatch(
      errorRemedy(new MirrorError('ASSET_LINK_EXISTS', 'Synthetic.')).action,
      /Nothing was sent to Google/,
    );
  } finally {
    x.store.close();
  }
});
