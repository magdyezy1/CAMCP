import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {assertSunsetRegistry, providerSunsets, sunsetStatus} from '../dist/src/provider-sunsets.js';
import {providerContractView} from '../dist/src/contract-evidence.js';

// F-56: a registry of when each provider version AMCP sends stops working, kept equal to the versions AMCP sends.
test('the sunset registry records exactly the versions AMCP sends', () => {
  assertSunsetRegistry();
  const without = (id, entry) => [...providerSunsets.filter(s => s.provider !== id), ...(entry ? [entry] : [])],
    google = providerSunsets.find(s => s.provider === 'google');
  assert.throws(
    () => assertSunsetRegistry(without('google', {...google, version: 'v23'})),
    /google: the sunset entry records v23 but AMCP sends v25/,
  );
  assert.throws(() => assertSunsetRegistry(without('google')), /google: no sunset entry for v25/);
  // A date without an official or policy basis, and such a basis without a date, are both refused.
  assert.throws(
    () => assertSunsetRegistry(without('google', {...google, basis: 'unknown', sunset: '2027-08'})),
    /needs an official or policy basis/,
  );
  const {sunset: _sunset, ...undated} = google;
  assert.throws(
    () => assertSunsetRegistry(without('google', {...undated, basis: 'official'})),
    /needs an official or policy basis/,
  );
  assert.throws(
    () => assertSunsetRegistry(without('google', {...google, basis: 'official', sunset: '2027-13'})),
    /malformed sunset/,
  );
});

// PRV-04: the registry held one entry per provider and required it to equal the version sent, so the emergency Meta
// rollback (AMCP_META_API_VERSION=v25.0) made the sunsets tool throw exactly when the rollback was in use.
test('every Meta version AMCP can send has its own entry, and the tool works with and without the rollback', () => {
  const meta = providerSunsets.filter(s => s.provider === 'meta').map(s => s.version);
  assert.deepEqual(meta.sort(), ['v25.0', 'v26.0']);
  assert.throws(
    () => assertSunsetRegistry(providerSunsets.filter(s => !(s.provider === 'meta' && s.version === 'v25.0'))),
    /meta: no sunset entry records v25\.0, a version AMCP can be configured to send/,
  );
  assert.throws(
    () => assertSunsetRegistry([...providerSunsets, {...providerSunsets.find(s => s.provider === 'meta')}]),
    /recorded twice/,
  );
  const {AMCP_META_API_VERSION: _unset, ...base} = process.env;
  const tool = (env, ...args) => {
    const run = spawnSync(process.execPath, ['dist/tools/provider-sunsets.js', ...args], {
      env: {...base, ...env},
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  const current = tool({}),
    rollback = tool({AMCP_META_API_VERSION: 'v25.0'});
  assert.ok(current.configurable_versions.some(v => /^meta v26\.0: sent/.test(v)));
  assert.ok(current.configurable_versions.some(v => /^meta v25\.0: accepted, not sent, no published end/.test(v)));
  assert.ok(rollback.configurable_versions.some(v => /^meta v25\.0: sent, no published end \(checked/.test(v)));
  assert.ok(rollback.configurable_versions.some(v => /^meta v26\.0: accepted, not sent/.test(v)));
  // Each dated deprecation is listed beside the versions.
  assert.ok(current.deprecations.some(d => /reddit_report_breakdowns_2026_12: 2026-12-08/.test(d)));
  // r25-m4-classic: TikTok's cut-off of classic Sales, App Promotion and Lead Generation creates (src/tiktok-manual-cutoff.ts).
  assert.ok(current.deprecations.some(d => /^tiktok tiktok_manual_sales_app_lead_creates: 2027-01-01/.test(d)));
});

test('--alarm reports deprecations within 90 days and stale checks; --now evaluates another day', () => {
  const run = (...args) => spawnSync(process.execPath, ['dist/tools/provider-sunsets.js', ...args], {encoding: 'utf8'});
  const before = run('--alarm', '--now', '2026-11-20');
  assert.equal(before.status, 1);
  const alarms = JSON.parse(before.stdout).alarms;
  assert.ok(alarms.some(a => a.kind === 'deprecation' && a.deprecation === 'reddit_report_breakdowns_2026_12'));
  // r25-m4-classic: the TikTok cut-off is 42 days away on 2026-11-20, inside the 90-day alarm window, and is no alarm once it is in effect.
  assert.ok(
    alarms.some(
      a => a.kind === 'deprecation' && a.deprecation === 'tiktok_manual_sales_app_lead_creates' && a.days_left === 42,
    ),
  );
  const after = JSON.parse(run('--alarm', '--now', '2027-01-02').stdout).alarms;
  assert.equal(
    after.some(a => a.deprecation === 'tiktok_manual_sales_app_lead_creates'),
    false,
  );
  // A version whose recorded check is more than 45 days old asks for the source to be read again.
  assert.ok(alarms.some(a => a.kind === 'stale_check'));
  const registry = run('--now', '2026-11-01');
  assert.equal(registry.status, 0, 'without --alarm the result does not depend on the date');
  assert.equal(run('--alarm', '--now', '2026-13-01').status, 1);
  assert.match(run('--alarm', '--now', '2026-13-01').stderr, /--now takes a day as YYYY-MM-DD/);
});

test('a recorded sunset raises the alarm 90 days ahead and after it passes; an unknown one never does', () => {
  const at = date => Object.fromEntries(sunsetStatus(Date.parse(date)).map(s => [s.provider, s]));
  // Criteo 2026-07 ends with its 12-month support period, counted from 2027-07-01.
  assert.deepEqual([at('2027-04-01').criteo.days_left, at('2027-04-01').criteo.alarm], [91, false]);
  assert.deepEqual([at('2027-04-02').criteo.days_left, at('2027-04-02').criteo.alarm], [90, true]);
  assert.equal(at('2027-08-01').criteo.alarm, true);
  assert.ok(at('2027-08-01').criteo.days_left < 0);
  for (const entry of Object.values(at('2030-01-01')))
    if (!entry.sunset) assert.equal(entry.alarm, false, entry.provider);
});

test('MCP clients read each version end in the provider contract view', () => {
  assert.deepEqual(
    [
      providerContractView('criteo_native_action').version_end.sunset,
      providerContractView('criteo_native_action').version_end.basis,
    ],
    ['2027-07', 'policy'],
  );
  // Google publishes v25's sunset: August 2027 (Sunset dates timetable, read 2026-09-29).
  assert.deepEqual(
    [
      providerContractView('google_ads_native_action').version_end.sunset,
      providerContractView('google_ads_native_action').version_end.basis,
    ],
    ['2027-08', 'official'],
  );
  assert.match(providerContractView('google_ads_native_action').version_end.note, /v23.*2027-02/);
});

test('the contracts page states recorded sunsets and no longer gives Google Ads v23 sunset month as the current one', () => {
  const contracts = fs.readFileSync('docs/CONTRACTS.md', 'utf8');
  assert.doesNotMatch(contracts, /Documented sunset month 2027-02/);
  assert.match(contracts, /Version 2026-07 ends 2027-07 \(the provider's support period\), checked 2026-09-29\./);
  assert.match(contracts, /Version v25 ends 2027-08 \(the published date\), checked 2026-09-29\./);
});
