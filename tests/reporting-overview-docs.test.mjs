// V2-MCP-01: the public reporting reference is pinned to the executable contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {overviewTool} from '../dist/src/reporting-overview.js';
import {detailContractVersion, overviewEntityLevels} from '../dist/src/overview-levels.js';
import {firstPartyContract} from '../dist/src/first-party-contracts.js';

const doc = fs.readFileSync('docs/REPORTING-OVERVIEW.md', 'utf8');
function section(name) {
  const start = '<!-- ' + name + ':start -->',
    end = '<!-- ' + name + ':end -->';
  assert.ok(doc.includes(start) && doc.includes(end), 'missing documented section: ' + name);
  return doc.split(start)[1].split(end)[0];
}
const cells = line =>
  line
    .split('|')
    .slice(1, -1)
    .map(cell => cell.trim().replaceAll('`', ''));

test('REPORTING-OVERVIEW.md names every amcp_reporting_overview action', () => {
  const actions = [...section('overview-actions').matchAll(/`([a-z_]+)`/g)].map(match => match[1]);
  assert.equal(new Set(actions).size, actions.length, 'each action is listed once');
  assert.deepEqual(actions.sort(), [...overviewTool.inputSchema.properties.action.enum].sort());
});
test('the declared-incomplete detail contract label equals detailContractVersion', () => {
  const label = /\*\*Declared incomplete\.\*\*[\s\S]*?detail_contract:"(overview-detail-v\d+)"/.exec(doc)?.[1];
  assert.equal(label, detailContractVersion);
  assert.match(doc, /[Oo]lder[^\n]*overview-detail-v2/);
});
test('the level matrix equals overviewEntityLevels in native position order', () => {
  const actual = Object.fromEntries(
    section('overview-levels')
      .split('\n')
      .filter(line => /^\| `/.test(line))
      .map(line => {
        const [platform, ...levels] = cells(line);
        return [platform, levels];
      }),
  );
  assert.deepEqual(
    actual,
    Object.fromEntries(
      Object.entries(overviewEntityLevels).map(([platform, levels]) => [platform, levels.map(level => level.label)]),
    ),
  );
});
test('documented pages use the action schema bounds, and detailed measurement restrictions are explicit', () => {
  const actual = Object.fromEntries(
    section('overview-pages')
      .split('\n')
      .filter(line => /^\| `/.test(line))
      .map(line => {
        const [action, minimum, maximum, fallback] = cells(line);
        return [action, {minimum: Number(minimum), maximum: Number(maximum), default: Number(fallback)}];
      }),
  );
  const expected = Object.fromEntries(
    ['list', 'get', 'compare_candidates', 'compare', 'presentation_profiles'].map(action => {
      const property = firstPartyContract(overviewTool, action).argumentsSchema.properties.limit;
      return [action, {minimum: property.minimum, maximum: property.maximum, default: property.default}];
    }),
  );
  assert.deepEqual(actual, expected);
  for (const text of ['INVALID_NATIVE_METRICS', 'complete_window:true', 'campaign_id', 'Snapchat', 'TikTok'])
    assert.ok(doc.includes(text), text);
  for (const metric of ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas'])
    assert.ok(section('overview-default-metrics').includes('`' + metric + '`'), metric);
});
