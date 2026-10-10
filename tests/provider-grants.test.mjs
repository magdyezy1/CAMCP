// CON-03: one grant registry. Before it, the OAuth configuration, measurement write enforcement, the Google Ads and
// Snapchat checks and readiness each kept their own scope strings, readiness knew only four write scopes (so most
// reviewed-write providers could never read "ready"), TikTok's returned scope list and X's access type were dropped,
// and Meta recorded the permissions it asked for as granted. These tests pin the registry to the enforcement it
// replaced (golden values and refusals), its coverage, and what each provider's authorization records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  providerGrants,
  providerGrant,
  requestedScopes,
  missingScopes,
  recordedWriteGrant,
  grantedScopes,
  publicGrants,
  gtmWriteScopes,
} from '../dist/src/provider-grants.js';
import {platforms, PlatformOAuth} from '../dist/server/platform-oauth.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {mediaPlatforms} from '../dist/src/media-routing.js';
import {writeContractGateways} from '../dist/src/write-shape.js';
import {assertGoogleAdsScope} from '../dist/src/google-contracts.js';
import {assertMeasurementScopes} from '../dist/src/measurement-writes.js';
import {assertRedditWriteScopes} from '../dist/src/reddit-writes.js';
import {assertMetaPixelScope} from '../dist/src/meta-pixels.js';
import {assertMetaCatalogScope} from '../dist/src/meta-catalogs.js';
import {assertLinkedInAccountSettingsScope} from '../dist/src/linkedin-account-settings.js';
import {assertPlaceActionScope} from '../dist/src/google-place-action-links.js';
import {metaPermissionGrants} from '../dist/src/meta-auth-diagnostic.js';

const g = s => 'https://www.googleapis.com/auth/' + s;
// The literal values each module enforced before the registry existed (Work-here 60ec2cc).
const legacy = {
  defaults: {
    sheets: [g('drive.file'), g('spreadsheets')],
    drive: [g('drive.readonly')],
    microsoft: ['https://ads.microsoft.com/msads.manage', 'offline_access'],
    google: [g('adwords'), 'openid', 'profile'],
    meta: ['ads_read', 'pages_show_list', 'pages_read_engagement', 'business_management'],
    snapchat: ['snapchat-marketing-api'],
    linkedin: ['r_ads', 'r_ads_reporting'],
    ga4: [g('analytics.readonly')],
    gtm: [g('tagmanager.readonly')],
    gsc: [g('webmasters.readonly')],
    apple: ['searchadsorg'],
    dv360: [g('display-video')],
  },
  writeAdditions: {
    meta: ['ads_management'],
    linkedin: ['rw_ads'],
    gtm: ['tagmanager.edit.containers', 'tagmanager.delete.containers', 'tagmanager.edit.containerversions'].map(g),
    gsc: [g('webmasters')],
    google: [g('datamanager')],
  },
};
legacy.writeAdditions.gtm.push(g('tagmanager.publish'));
const connection = (gateway, scopes) => ({id: 'c', tenantId: 't', gateway, accounts: ['1'], enabled: true, scopes});
const refusal = (fn, code = 'INSUFFICIENT_SCOPE') => assert.throws(fn, e => e.code === code, 'expected ' + code);

test('golden: the registry requests exactly the scopes each platform requested before, Reddit adsedit only with writes', () => {
  const oauth = writes => new PlatformOAuth({origin: 'https://amcp.shop'}, {}, undefined, writes);
  for (const p of platforms) {
    const read = oauth(false).config(p).scopes,
      write = oauth(true).config(p).scopes;
    if (p.id === 'reddit') {
      // D19 (5) / CON-05 (1): least privilege. Reddit asked for adsedit even when writes were off.
      assert.deepEqual(read, ['adsread']);
      assert.deepEqual(write, ['adsread', 'adsedit']);
      continue;
    }
    if (p.id === 'google_business') {
      // CON-06: Business Profile became a website platform. Google documents one scope for its reads and writes, the one
      // its write families already enforced; nothing more is asked for when writes are on.
      assert.deepEqual(
        [read, write, p.scopes],
        [[g('business.manage')], [g('business.manage')], [g('business.manage')]],
      );
      continue;
    }
    if (p.id === 'tiktok' || p.id === 'x') {
      assert.deepEqual([read, write], [[], []], p.id + ' has no OAuth scope parameter');
      continue;
    }
    assert.deepEqual(read, legacy.defaults[p.id], p.id + ' read-only request');
    assert.deepEqual(write, [...legacy.defaults[p.id], ...(legacy.writeAdditions[p.id] ?? [])], p.id + ' with writes');
    // The static platform list shown on Connections is the registry's read request.
    assert.deepEqual(p.scopes, requestedScopes(p.gateway, false), p.id);
  }
  assert.deepEqual(gtmWriteScopes, legacy.writeAdditions.gtm);
});

test('coverage: every website, report, media and reviewed-write gateway has a registry entry', () => {
  const gateways = new Set([
    ...platforms.map(p => p.gateway),
    ...Object.values(reportPlatforms).map(p => p.gateway),
    ...mediaPlatforms.map(p => p + '_native_action'),
    ...writeContractGateways,
  ]);
  for (const gateway of gateways) assert.ok(providerGrant(gateway), 'registry entry for ' + gateway);
  assert.equal(new Set(providerGrants.map(e => e.gateway)).size, providerGrants.length, 'one entry per gateway');
  for (const e of providerGrants) {
    assert.ok(['token_response', 'permissions_endpoint', 'requested_access_type', 'none'].includes(e.grantSource));
    assert.equal(typeof e.accountReadContract, 'boolean');
    // A read requirement is always satisfiable by what AMCP requests (else no login could ever pass).
    if (e.read && e.requestedRead.length)
      assert.deepEqual(missingScopes(e.read, [...e.requestedRead, ...e.requestedWrite]), [], e.gateway);
    if (e.write && e.requestedRead.length)
      assert.deepEqual(missingScopes(e.write, [...e.requestedRead, ...e.requestedWrite]), [], e.gateway);
  }
  // Sheets and Drive are destinations and sources; Criteo has resource-specific reads. Business Profile reads the
  // selected location or business account exactly since CON-06.
  assert.deepEqual(
    providerGrants.filter(e => !e.accountReadContract).map(e => e.gateway),
    ['criteo_native_action', 'google_sheets_native_action', 'google_drive_native_action'],
  );
});

test('golden refusals: enforcement refuses and accepts exactly where the registry write requirement says', () => {
  const ok = gateway => {
    const w = providerGrant(gateway).write;
    return [...(w.all ?? []), ...(w.any?.slice(0, 1) ?? [])];
  };
  const cases = {
    meta_native_action: c => assertMetaPixelScope(c, true),
    google_ads_native_action: c => assertGoogleAdsScope(c),
    linkedin_native_action: c => assertLinkedInAccountSettingsScope(c, true),
    reddit_native_action: c => assertRedditWriteScopes(c),
    google_business_native_action: c => assertPlaceActionScope(c),
  };
  for (const [gateway, enforce] of Object.entries(cases)) {
    refusal(() => enforce(connection(gateway, [])));
    enforce(connection(gateway, ok(gateway)));
    assert.equal(recordedWriteGrant(connection(gateway, [])), false, gateway);
    assert.equal(recordedWriteGrant(connection(gateway, ok(gateway))), true, gateway);
  }
  // Reddit needs both scopes, as before.
  refusal(() => assertRedditWriteScopes(connection('reddit_native_action', ['adsedit'])));
  // Microsoft's check accepts the full or short scope, as before; write prepare now reads it from the registry.
  for (const s of ['https://ads.microsoft.com/msads.manage', 'msads.manage'])
    assert.equal(recordedWriteGrant(connection('microsoft_ads_native_action', [s])), true);
  assert.equal(recordedWriteGrant(connection('microsoft_ads_native_action', ['offline_access'])), false);
  // Measurement writes: the same strings and the same refusal code.
  const plan = (gateway, extra = {}) => ({
    gateway,
    action: 'SYNTHETIC',
    method: 'POST',
    path: '/x',
    query: {},
    headers: {},
    ...extra,
  });
  for (const [gateway, scopes] of [
    ['ga4_native_action', [g('analytics.readonly')]],
    ['ga4_native_action', [g('analytics')]],
    ['google_search_console_native_action', [g('webmasters')]],
    ['apple_ads_native_action', ['searchadsorg']],
  ]) {
    refusal(() => assertMeasurementScopes(plan(gateway), connection(gateway, [])), 'PROVIDER_WRITE_SCOPE_REQUIRED');
    assertMeasurementScopes(plan(gateway), connection(gateway, scopes));
    assert.equal(recordedWriteGrant(connection(gateway, scopes)), true, gateway);
  }
  refusal(
    () =>
      assertMeasurementScopes(
        plan('google_search_console_native_action'),
        connection('google_search_console_native_action', [g('webmasters.readonly')]),
      ),
    'PROVIDER_WRITE_SCOPE_REQUIRED',
  );
  const publish = plan('gtm_native_action', {action: 'PUBLISH_CONTAINER_VERSION'});
  refusal(
    () => assertMeasurementScopes(publish, connection('gtm_native_action', [g('tagmanager.readonly')])),
    'PROVIDER_WRITE_SCOPE_REQUIRED',
  );
  assertMeasurementScopes(publish, connection('gtm_native_action', [g('tagmanager.publish')]));
  assert.equal(recordedWriteGrant(connection('gtm_native_action', [g('tagmanager.readonly')])), false);
  // Providers without a distinguishing scope are undecided, never granted.
  for (const gateway of ['tiktok_native_action', 'x_ads_native_action', 'criteo_native_action'])
    assert.equal(recordedWriteGrant(connection(gateway, ['anything'])), undefined, gateway);
  assert.equal(providerGrant('snapchat_native_action').write.all[0], 'snapchat-marketing-api');
  assert.equal(providerGrant('dv360_native_action').write.all[0], g('display-video'));
});

test('Meta /me/permissions becomes granted and declined permissions; anything else is not knowledge', () => {
  const grants = metaPermissionGrants(
    {
      data: [
        {permission: 'ads_read', status: 'granted'},
        {permission: 'ads_management', status: 'declined'},
        {permission: 'catalog_management', status: 'granted'},
        {permission: 'pages_show_list', status: 'expired'},
      ],
    },
    5,
  );
  assert.deepEqual(grants, {
    source: 'permissions_endpoint',
    known: true,
    granted: ['ads_read', 'catalog_management'],
    declined: ['ads_management'],
    expired: ['pages_show_list'],
    checked_at: 5,
  });
  assert.deepEqual(grantedScopes(grants), ['ads_read', 'catalog_management']);
  for (const body of [
    null,
    {},
    {data: [{permission: 'ads_read'}]},
    {data: [{permission: 'ADS READ', status: 'granted'}]},
    {data: [], paging: {next: 'https://graph.facebook.com/next'}},
  ])
    assert.equal(metaPermissionGrants(body).known, false, JSON.stringify(body));
  assert.equal(grantedScopes({known: false, granted: ['ads_management']}), undefined);
  // Connections shows names and dates only.
  assert.deepEqual(publicGrants({...grants, token: 'secret', granted: ['ads_read', '<b>x</b>']}), {
    source: 'permissions_endpoint',
    known: true,
    granted: ['ads_read'],
    declined: ['ads_management'],
    expired: ['pages_show_list'],
    checked_at: 5,
  });
  assert.equal(publicGrants(undefined), null);
});

test('a Facebook Login for Business grant of catalog_management passes the catalog gate; a declined one does not', () => {
  const granted = grantedScopes(
    metaPermissionGrants({
      data: ['ads_read', 'ads_management', 'catalog_management', 'business_management'].map(permission => ({
        permission,
        status: 'granted',
      })),
    }),
  );
  assertMetaCatalogScope(connection('meta_native_action', granted), true, 'Product sets');
  // The default request never asks for catalog_management, so before CON-03 this gate always refused.
  refusal(() =>
    assertMetaCatalogScope(
      connection('meta_native_action', requestedScopes('meta_native_action', true)),
      true,
      'Product sets',
    ),
  );
});

const tokenOAuth = (body, env = {}) => {
  const calls = [];
  const all = {};
  for (const p of platforms) {
    all['AMCP_' + p.env + '_CLIENT_ID'] = 'synthetic-' + p.id;
    all['AMCP_' + p.env + '_CLIENT_SECRET'] = 'synthetic-secret-' + p.id;
  }
  const oauth = new PlatformOAuth(
    {origin: 'https://amcp.shop'},
    {...all, ...env},
    async (url, init) => {
      calls.push(String(url));
      return typeof body === 'string'
        ? new Response(body, {headers: {'Content-Type': 'application/x-www-form-urlencoded'}})
        : Response.json(body);
    },
    true,
  );
  return {oauth, calls};
};

test('TikTok records its returned scope list verbatim instead of an empty list', async () => {
  const {oauth} = tokenOAuth({
    code: 0,
    message: 'OK',
    data: {access_token: 'synthetic-tiktok', advertiser_ids: ['7000'], scope: [4, 5, 'ad.read']},
  });
  const r = await oauth.exchange(
    'tiktok',
    {redirectUri: 'https://amcp.shop/api/auth/tiktok/callback'},
    {auth_code: 'a'},
  );
  assert.deepEqual(r.scopes, ['4', '5', 'ad.read']);
  // A malformed list is not recorded as a grant.
  const bad = tokenOAuth({code: 0, data: {access_token: 'synthetic-tiktok', scope: [{}, 'x']}});
  const r2 = await bad.oauth.exchange(
    'tiktok',
    {redirectUri: 'https://amcp.shop/api/auth/tiktok/callback'},
    {auth_code: 'a'},
  );
  assert.deepEqual(r2.scopes, []);
});

test('X records the access type AMCP requested, labelled as not confirmed by X', async () => {
  for (const requestedAccessType of ['read', 'write']) {
    const {oauth} = tokenOAuth('oauth_token=user-token&oauth_token_secret=user-secret&user_id=42&screen_name=brand');
    const r = await oauth.exchange(
      'x',
      {requestToken: 'request', requestSecret: 'request-secret', requestedAccessType},
      {oauth_token: 'request', oauth_verifier: 'verifier'},
    );
    assert.equal(r.grants.source, 'requested_access_type');
    assert.equal(r.grants.known, false);
    assert.equal(r.grants.requested_access_type, requestedAccessType);
    assert.deepEqual(r.scopes, []);
  }
});
