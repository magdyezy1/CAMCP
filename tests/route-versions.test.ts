// PRV-04: lifecycle was governed per gateway default, not per route, so two X reads still compiled to the retired v5
// API. Every mapped route must carry the version AMCP sends for its provider, or be an evidence-backed exception
// listed here; a new off-version route fails this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {actionContracts} from '../src/action-contracts.js';
import {providerContracts, effectiveProviderContract} from '../src/provider-contracts.js';

/** The first path segment that names an API version: v25, v26.0, v1beta, 12, 2026-07 (before any `:verb`). */
export function routeVersion(path: string): string | undefined {
  const pathname = path.startsWith('https://') ? new URL(path.replace(/[{}]/g, '')).pathname : path.split('?')[0]!;
  for (const segment of pathname.split('/').slice(1, 4)) {
    const head = segment.split(':')[0]!;
    if (/^(?:v\d+(?:\.\d+)?(?:alpha|beta)?|\d{1,3}(?:\.\d+)?|\d{4}-\d{2})$/.test(head)) return head;
  }
  return undefined;
}
/** Off-version or version-free routes kept on evidence; each names why. */
const allowed: {gateway: string; path: RegExp; reason: string}[] = [
  {
    gateway: 'linkedin_native_action',
    path: /^\/v2\/(?:geo|me|people|endorsement|shares|ugcPosts|adLiftTestBenchmark)\b/,
    reason:
      'Still documented or not confirmed withdrawn under /v2 (retired-provider-actions.ts, F-58); versioned LinkedIn routes use /rest with the LinkedIn-Version header.',
  },
  {gateway: 'linkedin_native_action', path: /^\/rest\//, reason: 'Versioned by the LinkedIn-Version header.'},
  {
    gateway: 'x_ads_native_action',
    path: /^https:\/\/upload\.x\.com\/1\.1\//,
    reason: 'X media upload is the v1.1 upload API.',
  },
  {
    gateway: 'snapchat_native_action',
    path: /^\/v3\//,
    reason: 'Snapchat Conversions API v3 (pixel and app events), separate from the Marketing API v1.',
  },
  {
    gateway: 'snapchat_native_action',
    path: /^\/v2\/conversion$/,
    reason: 'Legacy Conversions API v2; a blocked write.',
  },
  {gateway: 'dv360_native_action', path: /^\/(?:media|download)\//, reason: 'DV360 media upload and download paths.'},
  {
    gateway: 'google_ads_native_action',
    path: /^https:\/\/datamanager\.googleapis\.com\/v1\//,
    reason: 'The Data Manager API v1, a separate Google API.',
  },
];
/** Versions per provider: the one AMCP sends, split where a provider sends several APIs (ga4 v1beta/v1alpha). */
function expectedVersions(id: string): string[] {
  const version = String(effectiveProviderContract(id)?.api_version ?? '');
  return version.split('/').map(v => v.trim());
}
const unversioned = new Set(['amazon', 'adjust', 'linkedin']);

test('every mapped route carries the provider version AMCP sends, or is an evidence-backed exception', () => {
  const offVersion: string[] = [];
  for (const contract of actionContracts(new Registry())) {
    const path = contract.path;
    if (!path || contract.status === 'provider_unsupported' || contract.status === 'unmapped') continue;
    const provider = providerContracts.find(c => c.gateway === contract.gateway);
    if (!provider) continue;
    const id = String(provider.id),
      full = contract.origin && !path.startsWith('https://') ? contract.origin + path : path,
      exception = allowed.find(a => a.gateway === contract.gateway && (a.path.test(path) || a.path.test(full)));
    if (exception) continue;
    const version = routeVersion(path);
    if (unversioned.has(id) && version === undefined) continue;
    if (!version || !expectedVersions(id).includes(version))
      offVersion.push(contract.gateway + ' ' + contract.method + ' ' + path + ' (' + contract.status + ')');
  }
  assert.deepEqual(offVersion, []);
});

test('the retired X v5 recommendation reads are provider_unsupported, and the version check would catch them', () => {
  const contracts = actionContracts(new Registry()).filter(c => c.gateway === 'x_ads_native_action');
  for (const action of [
    'x_accounts_account_id_recommendations_get',
    'x_accounts_account_id_recommendations_recommendation_id_get',
  ]) {
    const row = contracts.find(c => c.action === action);
    assert.equal(row?.status, 'provider_unsupported', action);
    assert.equal(routeVersion(row!.path!), '5');
    assert.ok(!expectedVersions('x').includes('5'));
  }
  assert.equal(routeVersion('/v25:generateConversionRates'), 'v25');
  assert.equal(routeVersion('/api/v3/ad_accounts/{ad_account_id}/reports'), 'v3');
  assert.equal(routeVersion('https://upload.x.com/1.1/media/upload.json'), '1.1');
  assert.equal(routeVersion('/rest/adAccounts'), undefined);
});
