import test from 'node:test';
import assert from 'node:assert/strict';
import {compileEntityRead} from '../dist/src/workflows.js';
import {xAnalyticsTime} from '../dist/src/x-report-jobs.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {assertNamesNoProvider} from './helpers/shared-module-seams.mjs';

// ARC-01 phase B, wave 4c round 6: shared modules that named providers' gateways or imported their modules take those
// facts from the providers' adapters now. Each test's first assertion fails on the build before its move; the others pin
// the facts the shared module reads and pass on both builds.

test('the generic workflows take their platforms’ gateways from the adapters and X’s stats time from its hooks', () => {
  assertNamesNoProvider('src/workflows.ts');
  // The four platforms the generic workflows serve are adapter IDs; each step goes to that adapter's gateway.
  for (const [platform, gateway, account] of [
    ['google', 'google_ads_native_action', '1234567890'],
    ['linkedin', 'linkedin_native_action', '507404993'],
    ['x', 'x_ads_native_action', '18ce54d4x5t'],
    ['dv360', 'dv360_native_action', '4180000'],
  ])
    assert.equal(compileEntityRead('list_campaigns', {platform, account_id: account}).gateway, gateway, platform);
  // A native-only platform is still refused with its own gateway named, another with no adapter of these four.
  assert.throws(
    () => compileEntityRead('list_campaigns', {platform: 'meta', account_id: '1'}),
    e => e.code === 'NATIVE_ONLY_PLATFORM' && e.details.gateway === 'meta_native_action',
  );
  assert.throws(
    () => compileEntityRead('list_campaigns', {platform: 'reddit', account_id: '1'}),
    e => e.code === 'WORKFLOW_UNSUPPORTED' && e.details.platform === 'reddit',
  );
  assert.throws(
    () => compileEntityRead('list_campaigns', {platform: 'toString', account_id: '1'}),
    e => e.code === 'WORKFLOW_UNSUPPORTED',
  );
  // Only X declares a generic workflow fact: its analytics times, whole UTC hours, the function X's report jobs use.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.genericWorkflows).map(h => h.gateway),
    ['x_ads_native_action'],
  );
  const {statsTime} = providerHooks('x_ads_native_action').genericWorkflows;
  assert.equal(statsTime, xAnalyticsTime);
  assert.ok(Object.isFrozen(providerHooks('x_ads_native_action').genericWorkflows));
  assert.equal(statsTime(Date.UTC(2026, 0, 31, 23)), '2026-01-31T23:00:00Z');
  for (const instant of [Date.UTC(2026, 0, 1, 0, 30), 1.5, Number.NaN])
    assert.throws(
      () => statsTime(instant),
      e => e.code === 'INVALID_REPORT_RANGE' && e.message === 'X analytics times are expressed in whole hours.',
    );
});
