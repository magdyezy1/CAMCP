// closing-fixes. The Monitoring inbox offers each measurement context once, from the summary of the top level a rule watches
// (web/operations-center.js, monitorContexts). Which level that is, is the server's rule: the first of campaign, ad set, ad
// among the levels the source requested (src/report-monitors.ts, levelOrder, F-L5-06). The page cannot import the server's
// table, so it keeps a copy (monitorLevels). The two lists are read here as text and held equal, so a level added or reordered
// on one side and not on the other fails this test instead of quietly offering rules a level the server does not evaluate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/** The names listed by the array literal `name` is declared as, in a source that declares it exactly once. */
function levelsOf(source, name, file) {
  const declaration = new RegExp('\\b(?:const|let|var)\\s+' + name + '\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]', 'g'),
    found = [...source.matchAll(declaration)];
  assert.equal(found.length, 1, file + ' declares ' + name + ' once, as an array literal');
  const items = found[0][1]
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  assert.ok(items.length > 0, file + ': ' + name + ' lists at least one level');
  return items.map(item => {
    const literal = /^(['"])([a-z_]+)\1$/.exec(item);
    assert.ok(literal, file + ': ' + name + ' lists plain level names, not ' + item);
    return literal[2];
  });
}

test('the page lists the report levels in the order the server uses to pick the one a monitor watches', () => {
  const page = levelsOf(readFileSync('web/operations-center.js', 'utf8'), 'monitorLevels', 'web/operations-center.js'),
    server = levelsOf(readFileSync('src/report-monitors.ts', 'utf8'), 'levelOrder', 'src/report-monitors.ts');
  assert.deepEqual(
    page,
    server,
    'monitorLevels in web/operations-center.js and levelOrder in src/report-monitors.ts must list the same levels in the same order',
  );
});
