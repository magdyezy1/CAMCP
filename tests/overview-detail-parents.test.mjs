import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeGraph} from '../tools/architecture-map.mjs';
import * as parents from '../dist/src/overview-parents.js';
import * as contract from '../dist/src/report-source.js';
import {reportSourceList} from '../dist/src/report-sources.js';
import {linkedinVersion} from '../dist/src/linkedin-version.js';
import {MirrorError} from '../dist/src/errors.js';

/**
 * ARC-01 (reporting, wave 4c round 6): the Overview's native parent reads of detailed rows (RPT-07) are the platforms'
 * report sources' (`detailParents`), and src/overview-parents.ts keeps the cache, the connection and authority checks,
 * the read path, the drift check, the refusals and the warnings. Each test pins what the module answered before.
 */
function legacyDetailParentKind(platform, level, scoped = false) {
  if (platform === 'tiktok') return level === 'adset' ? 'tiktok_adgroup' : level === 'ad' ? 'tiktok_ad' : undefined;
  if (platform === 'snapchat' && level === 'ad' && !scoped) return 'snapchat_ad';
  if (platform === 'linkedin' && level === 'ad') return 'linkedin_creative';
  return undefined;
}

test('the detailed levels with parent reads are the ones the module named, read by their platforms’ sources', () => {
  const platforms = [
    ...reportSourceList.map(source => source.platform),
    'constructor',
    '__proto__',
    'toString',
    '',
    undefined,
  ];
  for (const platform of platforms)
    for (const level of ['campaign', 'adset', 'ad', 'keyword', 'creative', '', 'constructor', undefined])
      for (const scoped of [undefined, false, true, 'c1', 0])
        assert.equal(
          parents.detailParentKind(platform, level, scoped),
          legacyDetailParentKind(platform, level, scoped),
          [platform, level, scoped].join(':'),
        );
  assert.deepEqual(
    reportSourceList.filter(source => source.detailParents).map(source => source.platform),
    ['tiktok', 'snapchat', 'linkedin'],
  );
  for (const source of reportSourceList.filter(source => source.detailParents))
    assert.ok(Object.isFrozen(source.detailParents), source.platform);
});

test('each parent read sends the headers the module sent: LinkedIn’s version and finder headers, none elsewhere', () => {
  const reader = platform => reportSourceList.find(source => source.platform === platform).detailParents;
  assert.deepEqual(reader('linkedin').headers(), {
    'LinkedIn-Version': linkedinVersion(),
    'X-Restli-Protocol-Version': '2.0.0',
    'X-RestLi-Method': 'FINDER',
  });
  assert.equal(reader('tiktok').headers, undefined);
  assert.equal(reader('snapchat').headers, undefined);
  // LinkedIn versions its API by header, so the parent reads' lineage names that header's value, as before.
  assert.equal(reportSourceList.find(source => source.platform === 'linkedin').versionHeader, 'LinkedIn-Version');
});

test('the optional-read rules keep their import path and answer as before', () => {
  assert.equal(parents.optionalReadRefused, contract.optionalReadRefused);
  assert.equal(parents.accessRefusalCodes, contract.accessRefusalCodes);
  assert.equal(parents.detailParentsUnavailableWarning, contract.detailParentsUnavailableWarning);
  assert.equal(
    parents.detailParentsUnavailableWarning,
    'Native parents could not be read for this source, so its rows show entity IDs without parent campaigns or ad groups.',
  );
  assert.deepEqual(
    [...parents.accessRefusalCodes],
    [
      'CONNECTION_REQUIRED',
      'CONNECTION_AUTHORITY_CHANGED',
      'RESOURCE_SCOPE_REQUIRED',
      'ACCOUNT_SCOPE_MISMATCH',
      'ACCOUNT_REQUIRED',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'MEMBERSHIP_REVOKED',
      'ACCOUNT_ACCESS_REVOKED',
    ],
  );
  const legacy = e =>
    e instanceof MirrorError &&
    !e.retryable &&
    !e.code.startsWith('REPORT_') &&
    !parents.accessRefusalCodes.has(e.code) &&
    [400, 403, 404].includes(e.status);
  const errors = [
    new MirrorError('PLATFORM_ERROR', 'x', {}, 400),
    new MirrorError('PLATFORM_ERROR', 'x', {}, 403),
    new MirrorError('PLATFORM_ERROR', 'x', {}, 404),
    new MirrorError('PLATFORM_ERROR', 'x', {}, 409),
    new MirrorError('PLATFORM_ERROR', 'x', {}, 500),
    new MirrorError('REPORT_SHAPE_CHANGED', 'x', {}, 400),
    new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'x', {}, 403),
    new MirrorError('UNAUTHORIZED', 'x', {}, 401),
    Object.assign(new MirrorError('PLATFORM_RATE_LIMIT', 'x', {}, 429), {retryable: true}),
    Object.assign(new MirrorError('PLATFORM_ERROR', 'x', {}, 400), {retryable: true}),
    new Error('plain'),
    undefined,
  ];
  for (const e of errors) assert.equal(parents.optionalReadRefused(e), legacy(e), String(e?.code ?? e));
  assert.equal(parents.detailParentLimit, 1000);
});

test('the report sources do not reach the parent reads, so they may consult the report source registry', () => {
  const graph = runtimeGraph(process.cwd()),
    reached = new Set(),
    queue = ['src/report-sources.ts'];
  while (queue.length)
    for (const next of graph.get(queue.shift()) ?? []) if (!reached.has(next)) reached.add(next) && queue.push(next);
  assert.equal(reached.has('src/overview-parents.ts'), false);
  assert.ok(graph.get('src/overview-parents.ts').has('src/report-sources.ts'));
  for (const reader of [
    'src/tiktok-detail-parents.ts',
    'src/snapchat-detail-parents.ts',
    'src/linkedin-detail-parents.ts',
  ])
    assert.ok(reached.has(reader), reader);
});
