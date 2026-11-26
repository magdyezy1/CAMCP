// always-run: the golden collection of every reporting platform and level
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {collectScenarios, runCollectScenario} from './helpers/report-collect-scenarios.mjs';

/**
 * ARC-04 stage F golden collection: what NativeCampaignReports sends, saves and returns for every reporting platform and
 * level (campaign, daily, the native ad group and ad levels, the guided detailed levels' routing, cached account and
 * metadata lookups, checkpoints and every collection refusal), recorded from the platform if-chain before each
 * platform's collection moved into its report source. Each scenario must stay byte-identical: the request plans and
 * their runPlan options, the saved checkpoints, and the normalized rows, warnings, lineage and refusals.
 */
const golden = JSON.parse(fs.readFileSync('tests/fixtures/report-collect-golden.json', 'utf8'));

test('the golden collection covers every reporting platform and level', () => {
  assert.equal(golden.schema_version, 1);
  assert.deepEqual(
    golden.recordings.map(r => r.name),
    collectScenarios.map(s => s.name),
  );
  const platforms = new Set(collectScenarios.map(s => s.source.platform));
  for (const platform of ['google', 'meta', 'tiktok', 'snapchat', 'linkedin', 'x', 'microsoft', 'apple', 'reddit'])
    assert.ok(platforms.has(platform), platform);
  for (const platform of ['ga4', 'gsc']) assert.ok(platforms.has(platform), platform);
  for (const platform of ['microsoft', 'apple', 'reddit', 'linkedin'])
    for (const level of ['adset', 'ad'])
      assert.ok(
        collectScenarios.some(s => s.source.platform === platform && s.source.level === level),
        platform + ' ' + level,
      );
});

for (const [i, scenario] of collectScenarios.entries())
  test('golden collection: ' + scenario.name, async () => {
    const recorded = await runCollectScenario(scenario),
      expected = golden.recordings[i];
    assert.equal(recorded.name, expected.name);
    // Request by request first, so a difference names the request that changed.
    assert.equal(recorded.requests.length, expected.requests.length, 'number of requests');
    for (const [at, request] of recorded.requests.entries())
      assert.equal(JSON.stringify(request), JSON.stringify(expected.requests[at]), 'request ' + at);
    assert.equal(JSON.stringify(recorded), JSON.stringify(expected));
  });
