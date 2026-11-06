import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {overviewEntityLevels} from '../dist/src/overview-levels.js';
import * as registry from '../dist/src/report-sources.js';

const {reportSourceList} = registry;

const root = new URL('../', import.meta.url);

/** Runs `script` in a fresh Node process (no module of this test is loaded) and returns what it printed as JSON. */
function fresh(script) {
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {cwd: root, encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

// The level table is one declaration. Before this, X's levels reached it only when report-sources.ts happened to be
// loaded, so which levels a platform had depended on what else a process had imported.
for (const imports of [
  [],
  ['x-report-source'],
  ['x-overview-detail'],
  ['snapchat-report-source'],
  ['overview-native-detail'],
  ['overview-v4'],
])
  test(
    'a fresh process that imports overview-levels after ' + (imports.join(', ') || 'nothing') + ' sees X levels',
    () => {
      const levels = fresh(
        imports.map(name => `await import('./dist/src/${name}.js');`).join('') +
          `const {overviewEntityLevels, overviewSourceLevel} = await import('./dist/src/overview-levels.js');
         const level = id => {
           try { return overviewSourceLevel({platform: 'x', level: id, reporting_contract: 'overview-config-v4'}).label; }
           catch (e) { return e.code; }
         };
         console.log(JSON.stringify({x: overviewEntityLevels.x ?? null, line: level('adset'), tweet: level('ad')}));`,
      );
      assert.deepEqual(
        levels.x?.map(level => [level.id, level.label, level.native_type, level.preset ?? null]),
        [
          ['campaign', 'Campaign', 'campaign', null],
          ['adset', 'Line item', 'line_item', 'x_line_item'],
          ['ad', 'Promoted tweet', 'promoted_tweet', 'x_promoted_tweet'],
        ],
      );
      assert.equal(levels.line, 'Line item');
      assert.equal(levels.tweet, 'Promoted tweet');
    },
  );

test('every reporting platform declares the levels of the table itself, not a second copy', () => {
  assert.deepEqual(Object.keys(overviewEntityLevels).sort(), [
    'apple',
    'google',
    'linkedin',
    'meta',
    'microsoft',
    'reddit',
    'snapchat',
    'tiktok',
    'x',
  ]);
  for (const source of reportSourceList) {
    if (Object.hasOwn(overviewEntityLevels, source.platform))
      assert.equal(source.overview.levels, overviewEntityLevels[source.platform], source.platform);
    else
      assert.deepEqual(
        source.overview.levels,
        [{id: 'campaign', label: 'Campaign / resource', native_type: 'campaign_or_resource'}],
        source.platform + ' has one campaign or resource position and no entry in the table',
      );
  }
});

test('the native detail platforms are the sources that declare native detail, in registry order', () => {
  assert.deepEqual([...(registry.nativeDetailPlatforms ?? [])], ['linkedin', 'x', 'microsoft', 'apple', 'reddit']);
  assert.deepEqual(
    [...registry.nativeDetailPlatforms],
    reportSourceList.filter(source => source.nativeDetail === true).map(source => source.platform),
  );
});
