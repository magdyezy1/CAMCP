// OPS-05: the Railway deploy gate is recorded twice, in railway.json (Config as Code, until the 2026-12-01 cutoff) and
// in the owner's settings table in docs/DEPLOY-RAILWAY.md; watch paths keep documentation-only pushes from redeploying.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  checkDockerfile,
  checkRailwayConfig,
  checkSettingsTable,
  settingsTable,
  watchTriggers,
} from '../deploy/check-railway.mjs';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const config = JSON.parse(read('railway.json')),
  dockerfile = read('Dockerfile'),
  deployDoc = read('docs/DEPLOY-RAILWAY.md');

test('the documented settings table and railway.json record the same deploy gate', () => {
  assert.deepEqual(checkSettingsTable(deployDoc, config), []);
  const rows = settingsTable(deployDoc);
  assert.deepEqual(rows.get('Healthcheck path'), ['/healthz']);
  assert.deepEqual(rows.get('Healthcheck timeout (seconds)'), ['120']);
  assert.deepEqual(rows.get('Restart policy'), ['ON_FAILURE']);
  assert.deepEqual(rows.get('Restart policy retries'), ['5']);
  assert.deepEqual(rows.get('Replicas'), ['1']);
  // Dashboard-only values are owner records with no repository copy.
  for (const name of [
    'Volume mount path',
    'RAILWAY_DEPLOYMENT_DRAINING_SECONDS',
    'Wait for CI',
    'Build timeout of the plan',
  ])
    assert.deepEqual(rows.get(name), [], name);
  // Drift either way is caught.
  const changed = {...config, deploy: {...config.deploy, healthcheckTimeout: 300}};
  assert.match(checkSettingsTable(deployDoc, changed).join('\n'), /Healthcheck timeout/);
  assert.match(
    checkSettingsTable(deployDoc.replace('| Replicas | `1` |', '| Replicas | `2` |'), config).join('\n'),
    /Replicas/,
  );
  assert.deepEqual(checkSettingsTable('# Deploy\n', config), [
    'docs/DEPLOY-RAILWAY.md has no "Railway service settings" table.',
  ]);
});

test('watch paths skip documentation, including docs/review, and keep every shipped or built path', () => {
  const patterns = config.build.watchPatterns;
  for (const file of [
    'docs/review/DELIVERY-2026-10-04-SCHEDULER-WORKERS.md',
    'docs/review/product/UX.md',
    'docs/OPERATIONS.md',
    // DOC-03 (owner decision P12): the records, the archive and the bilingual owner guide.
    'docs/records/DELIVERY-2026-10-04-SCHEDULER-WORKERS.md',
    'docs/archive/REVIEW-2026-10-01.md',
    'docs/owner/README.md',
    'docs/owner/ar/privacy.md',
  ])
    assert.equal(watchTriggers(patterns, file), false, file);
  for (const file of [
    'src/store.ts',
    'server/http.ts',
    'web/app.js',
    'web/locales/ar.json',
    'generated/cloudflare-ranges.json',
    'Dockerfile',
    'package-lock.json',
    'docs/REPORTING-OVERVIEW.md',
    '.mirror/VENDOR/x.json',
    'README.md',
  ])
    assert.equal(watchTriggers(patterns, file), true, file);
  assert.deepEqual(checkRailwayConfig(config, dockerfile), []);
  assert.deepEqual(checkDockerfile(dockerfile), []);
});

test('a configuration that could skip a needed deploy, drop the gate or redeploy docs is refused', () => {
  const withPatterns = watchPatterns => ({...config, build: {...config.build, watchPatterns}});
  // Without the re-include, the guide the image ships would stop deploying.
  assert.match(
    checkRailwayConfig(withPatterns(['**', '!/docs/**']), dockerfile).join('\n'),
    /docs\/REPORTING-OVERVIEW\.md would not deploy/,
  );
  // A narrow include list misses the build files and the shipped directories.
  const narrow = checkRailwayConfig(withPatterns(['/src/**']), dockerfile).join('\n');
  for (const file of ['Dockerfile', 'package-lock.json', 'generated', 'web', '.mirror/VENDOR'])
    assert.match(narrow, new RegExp(file.replace(/[.]/g, '\\.') + ' would not deploy'), file);
  assert.match(checkRailwayConfig(withPatterns(['**']), dockerfile).join('\n'), /documentation-only change/);
  assert.match(checkRailwayConfig(withPatterns('**'), dockerfile).join('\n'), /must be a list/);
  const ungated = {...config, deploy: {...config.deploy, healthcheckPath: undefined}};
  assert.match(checkRailwayConfig(ungated, dockerfile).join('\n'), /healthcheckPath/);
  assert.match(checkDockerfile(dockerfile + '\nVOLUME /data\n').join('\n'), /VOLUME/);
  // Pattern semantics: the last match decides; an unanchored pattern matches at any depth; no patterns deploy all.
  assert.equal(watchTriggers(['*.md'], 'docs/a/b.md'), true);
  assert.equal(watchTriggers(['/*.md'], 'docs/a/b.md'), false);
  assert.equal(watchTriggers(['**', '!**/*.md'], 'docs/a/b.md'), false);
  assert.equal(watchTriggers([], 'anything'), true);
});

test('the repository passes the Railway configuration check that the workflow runs', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../deploy/check-railway.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checks passed/);
});
