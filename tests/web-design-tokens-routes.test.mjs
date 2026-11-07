// V2-WEB-02: a stylesheet the route loader adds to a page (web/route-assets.js) is loaded by that page. The token check
// asks, for every custom property a stylesheet reads, whether each page loading the stylesheet also loads a sheet that
// defines it. It used to know pages only by the <link> elements of their HTML, so a component sheet loaded by a route
// looked like an orphan, and a route that loads the component sheet without the V2 token sheet looked fine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pageStylesheets, undefinedTokenProblems} from '../tools/check-design-tokens.mjs';

function tree(registry, order) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-token-routes-')),
    web = path.join(root, 'web'),
    write = (file, text) => fs.writeFileSync(path.join(web, file), text);
  fs.mkdirSync(web);
  write('tokens.css', ':root { --line: #e5e1eb; }\n');
  write('public-tokens.css', ':root {}\n');
  write('tokens-v2.css', ':root { --v2-x: #17141f; }\n');
  write(
    'index.html',
    '<link rel="stylesheet" href="/assets/tokens.css"><link rel="stylesheet" href="/assets/app.css">',
  );
  write('app.css', '.a { border-color: var(--line); }\n');
  write('routes.js', 'const routeRegistry = ' + JSON.stringify(registry) + ';\n');
  write(
    'route-assets.js',
    fs
      .readFileSync('web/route-assets.js', 'utf8')
      .replace(
        'const pageAssetOrder = [\n',
        'const pageAssetOrder = [\n' + order.map(file => "'" + file + "',").join('\n'),
      ),
  );
  return {root, write};
}

test('a route that loads a component sheet and the V2 token sheet may read V2 tokens; one that does not is named', () => {
  const {root, write} = tree(
    [
      {path: '/good', label: 'Good', assets: ['tokens-v2.css', 'v2.css']},
      {path: '/bad', label: 'Bad', assets: ['v2b.css']},
      {path: '/plain', label: 'Plain'},
    ],
    ['tokens-v2.css', 'v2.css', 'v2b.css'],
  );
  try {
    write('v2.css', '.g { color: var(--v2-x); }\n');
    write('v2b.css', '.b { color: var(--v2-x); }\n');
    write('orphan.css', '.o { color: var(--v2-x); }\n');
    const pages = Object.fromEntries(pageStylesheets(root).map(({page, sheets}) => [page, sheets]));
    assert.deepEqual(pages['route /good'], ['tokens.css', 'app.css', 'tokens-v2.css', 'v2.css']);
    assert.deepEqual(pages['route /bad'], ['tokens.css', 'app.css', 'v2b.css']);
    assert.equal(pages['route /plain'], undefined, 'a route without stylesheets is not a page of its own');
    assert.deepEqual(undefinedTokenProblems(root), [
      'web/orphan.css:1: --v2-x is defined only in tokens-v2.css, and no page links this sheet to load it (.o)',
      'web/v2b.css:1: --v2-x is defined only in tokens-v2.css, which route /bad does not load (.b)',
    ]);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a tree without a route loader has only its HTML pages', () => {
  const {root} = tree([], []);
  try {
    fs.rmSync(path.join(root, 'web', 'route-assets.js'));
    assert.deepEqual(
      pageStylesheets(root).map(({page}) => page),
      ['index.html'],
    );
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
