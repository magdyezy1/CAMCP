// Runs the tests related to changed files: the changed tests themselves and every test that imports a changed module.
// Usage: npm run test:related [-- file ...]   (default: files changed against HEAD, including untracked ones)
// This is a fast inner loop; the full `npm run check` in a release candidate remains the qualification.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';

const git = args => execFileSync('git', args, {encoding: 'utf8'}).split('\n').filter(Boolean);
const changed = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [...new Set([...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])])];
const tests = fs
  .readdirSync('tests')
  .filter(f => /\.test\.(ts|mjs)$/.test(f))
  .map(f => 'tests/' + f);
const selected = new Set();
for (const file of changed.map(f => f.replaceAll(path.sep, '/'))) {
  if (/^tests\/.+\.test\.(ts|mjs)$/.test(file) && fs.existsSync(file)) {
    selected.add(file);
    continue;
  }
  const m = /^(src|server|tools|generated)\/(.+)\.(ts|mjs|json)$/.exec(file);
  if (!m) continue;
  // A test imports a module as ../src/x.js (TypeScript tests) or ../dist/src/x.js (.mjs tests).
  const needle = '/' + m[1] + '/' + m[2] + (m[3] === 'json' ? '.json' : '.js');
  for (const test of tests) if (fs.readFileSync(test, 'utf8').includes(needle)) selected.add(test);
}
if (!selected.size) {
  console.log('No related tests for: ' + (changed.join(', ') || '(no changes)'));
  process.exit(0);
}
const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);
const run = [...selected].sort().map(t => (t.endsWith('.ts') ? 'dist/' + t.replace(/\.ts$/, '.js') : t));
console.log('Running ' + run.length + ' related test file(s).');
process.exit(spawnSync(process.execPath, ['--test', ...run], {stdio: 'inherit'}).status ?? 1);
