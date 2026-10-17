import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {availableParallelism} from 'node:os';
import {pathToFileURL} from 'node:url';

/**
 * ARC-04 stage A: every compiled backend module loads when it is the first module a process imports. A module that reads
 * another module's top-level value while it is evaluated fails with a ReferenceError (the temporal dead zone) when an
 * import cycle evaluates it before that module; production entry points happened to import the catalog first, so the
 * failure would only appear after an import reorder, a new entry point or a formatter pass, and would take MCP and the
 * website down together at boot. Before this guard three modules failed: src/microsoft-associations.js
 * (microsoftAssociationContracts), src/tiktok-lookalikes.js and src/verification-reads.js (tiktokAudienceGetPath).
 */
const roots = ['src', 'server'];
/** Process entry points: each starts a listener, the stdio transport or the worker loop when it is imported. */
const entryPoints = ['server/http.js', 'server/stdio.js', 'server/worker.js'];

function modules() {
  const out = [];
  for (const root of roots)
    for (const name of fs.readdirSync(path.resolve('dist', root)).sort())
      if (name.endsWith('.js') && !entryPoints.includes(root + '/' + name)) out.push(root + '/' + name);
  return out;
}

/** Imports one module first in a fresh Node process; resolves to the error it threw, or undefined. */
function importFirst(module) {
  const url = pathToFileURL(path.resolve('dist', module)).href,
    script =
      'try { await import(' +
      JSON.stringify(url) +
      "); process.exit(0); } catch (error) { process.stderr.write(String(error?.name) + ': ' + String(error?.message).split('\\n')[0]); process.exit(1); }";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {...process.env, MIRROR_DB: ':memory:'},
    });
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', code => resolve(code === 0 ? undefined : stderr.trim() || 'exit ' + code));
  });
}

test('every compiled backend module loads when a process imports it first (no ReferenceError from an import cycle)', async () => {
  for (const entry of entryPoints) assert.ok(fs.existsSync(path.resolve('dist', entry)), entry + ' is still an entry');
  const all = modules(),
    failures = [];
  // A real backend: guards a glob that matched nothing.
  assert.ok(all.length > 500, String(all.length));
  let next = 0;
  const worker = async () => {
    while (next < all.length) {
      const module = all[next++],
        error = await importFirst(module);
      if (error) failures.push(module + ': ' + error);
    }
  };
  await Promise.all(Array.from({length: Math.max(2, Math.min(8, availableParallelism() - 1))}, worker));
  assert.deepEqual(
    failures.sort(),
    [],
    'Read another module’s value inside a function, or import it from a leaf module, instead of at the top level.',
  );
});
