import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {previewLinks} from '../src/ad-previews.js';
import type {Actor, JsonObject} from '../src/types.js';

const key = Buffer.alloc(32, 57).toString('base64'),
  reader: Actor = {tenantId: 't', userId: 'u', role: 'reader'},
  registry = new Registry();

/** One platform connection and a stand-in API answering by path; every request is kept. */
function fixture(gateway: string, account: string, respond: (url: URL, init?: RequestInit) => Response | undefined) {
  const store = new Store(':memory:', key),
    calls: {method: string; path: string; query: string; body: unknown}[] = [];
  store.putConnection(
    {tenantId: 't', userId: 'admin', role: 'admin'},
    {
      id: 'aaaaaaaa-1111-4111-8111-000000000001',
      tenantId: 't',
      gateway,
      accounts: [account],
      writeAccounts: [],
      label: 'Synthetic',
      enabled: true,
      scopes: ['r_ads', 'ads_read'],
      ...(gateway === 'reddit_native_action' ? {userAgent: 'server:amcp-tests:0.1.0 (local mock)'} : {}),
    },
    {accessToken: 'synthetic'},
  );
  const transport = new NativeTransport((async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = respond(url, init);
    if (!r) throw Error('Unexpected request ' + (init?.method ?? 'GET') + ' ' + url.pathname);
    return r;
  }) as typeof fetch);
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: false,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  return {
    store,
    calls,
    previews: (input: JsonObject) => service.call('amcp_ad_previews', {account_id: account, ...input}, reader),
  };
}

test('only HTTPS links on the platform’s own hosts count as preview links', () => {
  const html =
    '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=AQ1&amp;t=AQ2" width="274"></iframe>' +
    '<a href="https://evil.example/phish">x</a><img src="http://www.facebook.com/insecure.png">';
  assert.deepEqual(
    previewLinks('meta', {data: [{body: html}], note: 'https://www.facebook.com/x', other: 'https://example.com/y'}),
    ['https://www.facebook.com/ads/api/preview_iframe.php?d=AQ1&t=AQ2', 'https://www.facebook.com/x'],
  );
  assert.deepEqual(previewLinks('linkedin', {elements: [{preview: 'https://user:pw@www.linkedin.com/a'}]}), []);
  assert.deepEqual(previewLinks('tiktok', 'https://ads.tiktok.com/preview/abc'), [
    'https://ads.tiktok.com/preview/abc',
  ]);
});

test('Meta: lists the account’s ads, then reads each preview for the placement asked', async () => {
  const f = fixture('meta_native_action', '111', url => {
    if (url.pathname === '/v26.0/act_111/ads')
      return Response.json({
        data: [
          {id: '901', name: 'Spring', effective_status: 'ACTIVE'},
          {id: '902', name: 'Summer', effective_status: 'ACTIVE'},
        ].slice(0, Number(url.searchParams.get('limit'))),
      });
    if (/^\/v26\.0\/90[12]$/.test(url.pathname))
      return Response.json({
        id: url.pathname.split('/').at(-1),
        name: 'Summer',
        account_id: '111',
        effective_status: 'PAUSED',
      });
    if (url.pathname === '/v26.0/999') return Response.json({id: '999', account_id: '222'});
    if (/^\/v26\.0\/90[12]\/previews$/.test(url.pathname))
      return Response.json({
        data: [
          {
            body: `<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=${url.pathname.slice(7, 10)}&amp;t=x"></iframe>`,
          },
        ],
      });
  });
  try {
    const r = await f.previews({platform: 'meta', ad_format: 'INSTAGRAM_STORY', limit: 1});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(r.data.previews, [
      {
        ad_id: '901',
        name: 'Spring',
        ad_format: 'INSTAGRAM_STORY',
        links: ['https://www.facebook.com/ads/api/preview_iframe.php?d=901&t=x'],
      },
    ]);
    // Ad names are provider content, and the result says so.
    assert.match(r.meta.untrusted_provider_content, /third-party text/);
    assert.match(f.calls[1]!.query, /ad_format=INSTAGRAM_STORY/);
    // A named ID is checked directly, and a foreign identity never reaches a preview read.
    const other = await f.previews({platform: 'meta', ad_ids: ['902', '999']});
    assert.deepEqual(
      other.data.previews.map((p: JsonObject) => p.ad_id),
      ['902'],
    );
    assert.deepEqual(other.data.not_found, ['999']);
    assert.equal(f.calls.filter(c => c.path === '/v26.0/999/previews').length, 0);
  } finally {
    f.store.close();
  }
});

test('TikTok: previews each ad by advertiser and returns the preview link', async () => {
  const f = fixture('tiktok_native_action', '777', url => {
    if (url.pathname === '/open_api/v1.3/ad/get/')
      return Response.json({
        code: 0,
        message: 'OK',
        data: {
          list: [{ad_id: '5001', ad_name: 'Launch', operation_status: 'ENABLE'}],
          // TikTok echoes the page size it was asked for.
          page_info: {page: 1, page_size: Number(url.searchParams.get('page_size')), total_number: 1, total_page: 1},
        },
      });
    if (url.pathname === '/open_api/v1.3/creative/ads_preview/create/')
      return Response.json({
        code: 0,
        message: 'OK',
        data: {preview_link: 'https://ads.tiktok.com/preview/5001', iframe: '<iframe></iframe>', tips: []},
      });
  });
  try {
    const r = await f.previews({platform: 'tiktok'});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(r.data.previews[0].links, ['https://ads.tiktok.com/preview/5001']);
    assert.equal(r.data.previews[0].name, 'Launch');
    const preview = f.calls.find(c => c.path.endsWith('/ads_preview/create/'))!;
    assert.deepEqual(preview.body, {advertiser_id: '777', preview_type: 'AD', ad_id: '5001'});
  } finally {
    f.store.close();
  }
});

test('Snapchat: previews the account’s creatives', async () => {
  const f = fixture('snapchat_native_action', 'acct1', url => {
    if (url.pathname === '/v1/adaccounts/acct1/ads')
      return Response.json({
        request_status: 'SUCCESS',
        ads: [{ad: {id: 'a1', creative_id: 'cr1', name: 'Snap one', status: 'ACTIVE'}}],
      });
    if (url.pathname === '/v1/adaccounts/acct1/creatives')
      return Response.json({
        request_status: 'SUCCESS',
        creatives: [{sub_request_status: 'SUCCESS', creative: {id: 'cr1', name: 'Snap one', ad_account_id: 'acct1'}}],
      });
    if (url.pathname === '/v1/creatives/cr1/creative_preview')
      return Response.json({
        request_status: 'SUCCESS',
        creative_id: 'cr1',
        expires_at: '2999-01-01T00:00:00Z',
        creative_preview_link:
          'https://adsapi.snapchat.com/media/creative_preview?creative_id=cr1&expires_at=' +
          Date.parse('2999-01-01T00:00:00Z') +
          '&signature=synthetic',
      });
  });
  try {
    const r = await f.previews({platform: 'snapchat'});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(
      r.data.previews.map(({ad_id, source_ad_id, name, links}: JsonObject) => ({ad_id, source_ad_id, name, links})),
      [
        {
          ad_id: 'cr1',
          source_ad_id: 'a1',
          name: 'Snap one',
          links: [
            'https://ad-preview.snapchat.com/?creative_id=cr1&expires_at=' +
              Date.parse('2999-01-01T00:00:00Z') +
              '&signature=synthetic',
          ],
        },
      ],
    );
  } finally {
    f.store.close();
  }
});

test('LinkedIn: a creative preview needs the account’s creatives list first, then works', async () => {
  const f = fixture('linkedin_native_action', '505', url => {
    if (url.pathname === '/rest/adAccounts/505/creatives')
      return Response.json({
        elements: url.searchParams.get('creatives')?.includes(':43')
          ? []
          : [{id: 'urn:li:sponsoredCreative:42', name: 'Carousel'}],
      });
    if (url.pathname === '/rest/adPreviews')
      return Response.json({
        elements: [{preview: '<iframe src="https://www.linkedin.com/ads/preview?creative=42"></iframe>'}],
      });
  });
  try {
    const service = new MirrorService(
      registry,
      f.store,
      new NativeTransport((async () => Response.json({})) as typeof fetch),
    );
    const direct = await service.call(
      'linkedin_native_action',
      {
        action: 'linkedin_rest_ad_previews_get',
        account_id: '505',
        query: {q: 'creative', creative: 'urn:li:sponsoredCreative:42'},
      },
      reader,
    );
    assert.equal(direct.error.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(
      direct.error.details.next_call.arguments.action,
      'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
    );
    const r = await f.previews({platform: 'linkedin', ad_ids: ['42']});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(
      r.data.previews.map(({ad_id, name, links}: JsonObject) => ({ad_id, name, links})),
      [
        {
          ad_id: 'urn:li:sponsoredCreative:42',
          name: 'Carousel',
          links: ['https://www.linkedin.com/ads/preview?creative=42'],
        },
      ],
    );
    const finder = f.calls.find(c => c.path === '/rest/adAccounts/505/creatives')!;
    assert.match(finder.query, /q=criteria/);
    // A creative the list did not return stays out of scope.
    const unknown = await f.previews({platform: 'linkedin', ad_ids: ['43']});
    assert.deepEqual(unknown.data.not_found, ['urn:li:sponsoredCreative:43']);
    assert.equal(f.calls.filter(c => c.path === '/rest/adPreviews').length, 1);
  } finally {
    f.store.close();
  }
});

test('Reddit: the ad itself carries its preview link while preview_expiry is ahead', async () => {
  const later = new Date(Date.now() + 86400000).toISOString(),
    earlier = new Date(Date.now() - 86400000).toISOString();
  const f = fixture('reddit_native_action', 'a2_111', url => {
    if (url.pathname === '/api/v3/ad_accounts/a2_111/ads')
      return Response.json({
        data: [
          {
            id: '71',
            name: 'Live',
            configured_status: 'ACTIVE',
            preview_url: 'https://www.reddit.com/?ad=abc',
            preview_expiry: later,
          },
          {
            id: '72',
            name: 'Expired',
            configured_status: 'ACTIVE',
            preview_url: 'https://www.reddit.com/?ad=def',
            preview_expiry: earlier,
          },
        ],
        pagination: {next_url: null},
      });
  });
  try {
    const r = await f.previews({platform: 'reddit'});
    assert.equal(r.success, true, JSON.stringify(r));
    const [live, expired] = r.data.previews;
    assert.deepEqual(live.links, ['https://www.reddit.com/?ad=abc']);
    assert.equal(live.expires_at, later);
    assert.deepEqual(expired.links, []);
    assert.match(expired.note, /reviewed ad change/);
  } finally {
    f.store.close();
  }
});

test('Google Ads names the reviewed write that creates a shareable preview; platforms without a preview say so', async () => {
  const f = fixture('google_ads_native_action', '1234567890', () => undefined);
  try {
    const google = await f.previews({
      platform: 'google_ads',
      ad_ids: ['987654321', 'customers/1234567890/adGroupAds/11~22'],
    });
    assert.equal(google.success, true, JSON.stringify(google));
    // The Google Ads v25 request: asset groups by resource with UI_PREVIEW, video ads with YOUTUBE_LIVE_PREVIEW.
    assert.deepEqual(google.data.next_call.arguments.arguments.payload, {
      operation: {
        shareablePreviews: [
          {assetGroup: 'customers/1234567890/assetGroups/987654321', previewType: 'UI_PREVIEW'},
          {adGroupAd: 'customers/1234567890/adGroupAds/11~22', previewType: 'YOUTUBE_LIVE_PREVIEW'},
        ],
      },
    });
    assert.equal(google.data.next_call.tool, 'amcp_write');
    // X is no longer "not qualified" (package r12-xpreview): it reads its previews, so it needs a connection of its own, and
    // this fixture holds only Google Ads' (tests/x-ad-previews.test.mjs holds X's reads).
    const x = await f.previews({platform: 'x_ads'});
    assert.equal(x.success, false);
    assert.equal(x.error.code, 'CONNECTION_REQUIRED');
    assert.equal((await f.previews({platform: 'dv360'})).data.preview_route, 'none');
    assert.equal(f.calls.length, 0);
    const bad = await f.previews({platform: 'meta', ad_format: 'BILLBOARD'});
    assert.equal(bad.error.code, 'INVALID_ARGUMENT');
  } finally {
    f.store.close();
  }
});
