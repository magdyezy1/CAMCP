import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  assert.throws(
    () => assertSunsetRegistry(without('google', {...google, sunset: '2027-02'})),
    /needs an official or policy basis/,
  );
  assert.throws(
    () => assertSunsetRegistry(without('google', {...google, basis: 'official'})),
    /needs an official or policy basis/,
  );
  assert.throws(
    () => assertSunsetRegistry(without('google', {...google, basis: 'official', sunset: '2027-13'})),
    /malformed sunset/,
  );
});

test('a recorded sunset raises the alarm 90 days ahead and after it passes; an unknown one never does', () => {
  const at = date => Object.fromEntries(sunsetStatus(Date.parse(date)).map(s => [s.provider, s]));
  // Criteo 2026-01 ends with its 12-month support period, counted from 2027-01-01.
  assert.deepEqual([at('2026-09-28').criteo.days_left, at('2026-09-28').criteo.alarm], [95, false]);
  assert.deepEqual([at('2026-10-03').criteo.days_left, at('2026-10-03').criteo.alarm], [90, true]);
  assert.equal(at('2027-02-01').criteo.alarm, true);
  assert.ok(at('2027-02-01').criteo.days_left < 0);
  for (const entry of Object.values(at('2030-01-01')))
    if (!entry.sunset) assert.equal(entry.alarm, false, entry.provider);
});

test('MCP clients read each version end in the provider contract view', () => {
  assert.deepEqual(
    [
      providerContractView('criteo_native_action').version_end.sunset,
      providerContractView('criteo_native_action').version_end.basis,
    ],
    ['2027-01', 'policy'],
  );
  assert.equal(providerContractView('google_ads_native_action').version_end.basis, 'unknown');
  assert.match(providerContractView('google_ads_native_action').version_end.note, /v23.*2027-02/);
});

test('the contracts page states recorded sunsets and no longer gives Google Ads v23 sunset month as the current one', () => {
  const contracts = fs.readFileSync('docs/CONTRACTS.md', 'utf8');
  assert.doesNotMatch(contracts, /Documented sunset month 2027-02/);
  assert.match(contracts, /Version 2026-01 ends 2027-01 \(the provider's support period\), checked 2026-09-28\./);
});
