import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * The server reads pinned documents at run time through pinnedJson (DV360, GTM and Google goal models, Microsoft REST
 * evidence). Each must be in the runtime stage of the Docker image, which copies only what it names: a missing one
 * fails the families that need it only in production, never in tests run from the repository.
 */
const dockerfile = fs.readFileSync('Dockerfile', 'utf8'),
  runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ')),
  copied = [...runtime.matchAll(/^COPY --from=build \/app\/(\S+) \.\/(\S+)$/gm)].map(m => {
    assert.equal(m[1], m[2], 'the runtime image keeps repository paths');
    return m[1].replace(/\/$/, '');
  });
const reads = new Set();
for (const file of fs.readdirSync('src').filter(f => f.endsWith('.ts')))
  for (const m of fs.readFileSync('src/' + file, 'utf8').matchAll(/pinnedJson(?:<[^>]*>)?\(\s*'([^']+)'/g))
    reads.add(m[1]);

test('every document the server reads through pinnedJson is copied into the runtime image', () => {
  assert.ok(reads.size >= 4, [...reads].join(', '));
  for (const path of reads)
    assert.ok(
      copied.some(dir => path === dir || path.startsWith(dir + '/')),
      path + ' is read at run time but the runtime image copies only ' + copied.join(', '),
    );
});

test('each literal pinned path exists in the repository', () => {
  for (const path of reads) if (!path.endsWith('/')) assert.ok(fs.existsSync(path), path);
});
