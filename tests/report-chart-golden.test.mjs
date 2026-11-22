// V2-EXP-01: golden SVGs. Each drawn shape (ranked bars, the fold into Other, bars with a target, a stack with and without
// the fold, a line, a line with a hollow period, the key figures) is recorded as the SVG chartSvg draws it, in both themes in
// English, in Arabic (the layout mirrors, time still runs left to right), and in print texture. A golden moves only when a
// chart deliberately looks different: regenerate with
//   AMCP_UPDATE_GOLDEN=1 node --test tests/report-chart-golden.test.mjs
// and look at the files (tests/fixtures/charts/) before committing them.
// always-run: lists the golden chart directory, so no golden goes stale
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chartSvg} from '../dist/src/report-chart-render.js';
import {artifactLocale} from '../dist/src/report-localization.js';
import {specimens} from './helpers/chart-specimens.mjs';
import {parseXml} from './helpers/xml-check.mjs';

const directory = 'tests/fixtures/charts',
  locales = {en: artifactLocale({artifact_language: 'en'}), ar: artifactLocale({artifact_language: 'ar'})},
  shapes = specimens();
const cases = [
  ...Object.keys(shapes).flatMap(name => [
    {name, theme: 'light', language: 'en'},
    {name, theme: 'dark', language: 'en'},
  ]),
  ...['bars', 'folded-bars', 'stack', 'line', 'tiles'].map(name => ({name, theme: 'light', language: 'ar'})),
  ...['folded-bars', 'folded-stack'].map(name => ({name, theme: 'light', language: 'en', texture: true})),
].map(item => ({...item, file: `${item.name}.${item.theme}.${item.language}${item.texture ? '.texture' : ''}.svg`}));

for (const item of cases)
  test('golden: ' + item.file, () => {
    const svg = chartSvg(shapes[item.name], {theme: item.theme, locale: locales[item.language], texture: item.texture});
    assert.ok(svg, 'the shape is drawn');
    parseXml(svg);
    const file = path.join(directory, item.file);
    if (process.env.AMCP_UPDATE_GOLDEN === '1') {
      fs.mkdirSync(directory, {recursive: true});
      fs.writeFileSync(file, svg);
    }
    assert.equal(svg, fs.readFileSync(file, 'utf8'));
  });

test('the golden directory holds exactly the cases above, none stale', () => {
  const expected = cases.map(item => item.file).sort();
  assert.deepEqual(fs.readdirSync(directory).sort(), expected);
  assert.equal(new Set(expected).size, expected.length);
});
