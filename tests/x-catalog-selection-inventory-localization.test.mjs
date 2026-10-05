import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectAccountExplanations, localeProblems} from '../tools/check-locales.mjs';

test('all five authored catalog inspection refusals require Arabic while original enum and action tokens remain literal', () => {
  const files = ['src/x-catalog-selection-inventory.ts', 'src/workspace.ts', 'src/x-catalog-comparison.ts'],
    selected = new Set(files.flatMap(file => [...inspectAccountExplanations(fs.readFileSync(file, 'utf8'), file)])),
    messages = [
      'Choose true or false for inspecting other listed catalog products.',
      'Supplied products do not establish whole-store absence. The absent-source policy must be retain.',
      'Inspection of other listed products is qualified for X catalogs only.',
      'Catalog inventory inspection arguments apply only to catalog_compare.',
      'X listed catalog observations changed during collection. Read them again; no product changes were submitted.',
    ],
    catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
  for (const message of messages) {
    assert.ok(selected.has(message), message);
    assert.ok(Object.hasOwn(catalog, message));
    const missing = {...catalog};
    delete missing[message];
    assert.ok(localeProblems(missing, selected).includes('Missing Arabic message: ' + message));
  }
  assert.match(catalog[messages[0]], /true|false/);
  assert.match(catalog[messages[1]], /retain/);
  assert.match(catalog[messages[3]], /catalog_compare/);
});

test('catalog inspection localization excludes dynamic diagnostics, native member calls, unrelated files and other workspace error codes', () => {
  const code =
    "bad('Owned inspection message.'); bad(error.message); native.bad('Native member message.'); const example='Unrelated example.';";
  assert.deepEqual(
    [...inspectAccountExplanations(code, 'src/x-catalog-selection-inventory.ts')],
    ['Owned inspection message.'],
  );
  assert.deepEqual([...inspectAccountExplanations(code, 'src/other.ts')], []);
  const workspace =
    "bad('Owned selected message.', 'INVALID_CATALOG_INVENTORY'); bad('Other workflow message.', 'OTHER_CODE'); bad(error.message, 'INVALID_CATALOG_INVENTORY'); native.bad('Native member message.', 'INVALID_CATALOG_INVENTORY');";
  assert.deepEqual([...inspectAccountExplanations(workspace, 'src/workspace.ts')], ['Owned selected message.']);
});
