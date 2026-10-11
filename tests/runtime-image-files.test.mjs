import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * The server reads pinned documents at run time through pinnedJson (DV360, GTM and Google goal models, Microsoft REST
 * evidence). Each must be in the runtime stage of the Docker image, which copies only what it names: a missing one
 * fails the families that need it only in production, never in tests run from the repository. A capture that may be
 * absent until the owner records it is read through optionalPinnedJson instead, and is named below.
 */
const dockerfile = fs.readFileSync('Dockerfile', 'utf8'),
  runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ')),
  copied = [...runtime.matchAll(/^COPY --from=build \/app\/(\S+) \.\/(\S+)$/gm)].map(m => {
    assert.equal(m[1], m[2], 'the runtime image keeps repository paths');
    return m[1].replace(/\/$/, '');
  });
const reads = new Set(),
  optionalReads = new Set();
for (const file of fs.readdirSync('src').filter(f => f.endsWith('.ts'))) {
  const source = fs.readFileSync('src/' + file, 'utf8');
  for (const m of source.matchAll(/pinnedJson(?:<[^>]*>)?\(\s*'([^']+)'/g)) reads.add(m[1]);
  for (const m of source.matchAll(/optionalPinnedJson(?:<[^>]*>)?\(\s*'([^']+)'/g)) optionalReads.add(m[1]);
}

test('every document the server reads through pinnedJson is copied into the runtime image', () => {
  assert.ok(reads.size >= 4, [...reads].join(', '));
  for (const path of [...reads, ...optionalReads])
    assert.ok(
      copied.some(dir => path === dir || path.startsWith(dir + '/')),
      path + ' is read at run time but the runtime image copies only ' + copied.join(', '),
    );
});

test('each literal pinned path exists in the repository', () => {
  for (const path of reads) if (!path.endsWith('/')) assert.ok(fs.existsSync(path), path);
});

test('only a declared capture may be absent, and a present one parses', () => {
  // Meta's currency offsets (WRT-07 Stage C) were the one optional capture until Meta's currency table was recorded
  // (2026-10-11). Now that Meta caps stated in account currency depend on it, it is a required read: removing the file
  // or the Dockerfile copy fails the tests above instead of quietly turning those caps back into refusals. Another
  // optional document needs its own entry here.
  assert.ok(reads.has('.mirror/VENDOR/meta-currencies.json'), 'the Meta currency capture is read as required');
  assert.deepEqual([...optionalReads].sort(), []);
  for (const path of optionalReads) {
    assert.ok(!reads.has(path), path + ' is read both as required and as optional');
    if (fs.existsSync(path)) JSON.parse(fs.readFileSync(path, 'utf8'));
  }
});
