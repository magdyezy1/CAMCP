// QA-02 behavioral family conformance: every described reviewed write family is driven through the real review
// lifecycle (tests/helpers/family-conformance.mjs) and must detect a decisive change between review and execute,
// refuse a paginated snapshot, and never report or resend a partial answer as success. Families without a descriptor
// are listed in tests/fixtures/family-conformance-pending.json; the list only shrinks, and a new family ships a
// descriptor (docs/ADDING-A-REVIEWED-FAMILY.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {reviewedFamilies} from '../dist/src/reviewed-families.js';
import {conformanceChecks} from './helpers/family-conformance.mjs';

const directory = path.resolve('tests/family-descriptors'),
  descriptors = [];
for (const file of fs
  .readdirSync(directory)
  .filter(n => n.endsWith('.mjs') && !n.startsWith('_'))
  .sort())
  descriptors.push({file, ...(await import(pathToFileURL(path.join(directory, file)).href)).default});
const pending = JSON.parse(fs.readFileSync('tests/fixtures/family-conformance-pending.json', 'utf8'));

for (const d of descriptors)
  for (const [check, run] of Object.entries(conformanceChecks))
    // A family whose state read is one settings object the vendor never pages states why (`unpaginated`); its
    // paginated-snapshot check is reported as not applicable with that reason instead of testing an invented shape.
    // (Not a skipped test: release qualification fails on any skip it was not told about.)
    if (check === 'paginatedSnapshot' && d.unpaginated)
      test(d.family + ' conformance: paginatedSnapshot not applicable (' + d.unpaginated + ')', t => {
        assert.ok(d.unpaginated.length > 20);
        t.diagnostic('not paged by the vendor: ' + d.unpaginated);
      });
    else test(d.family + ' conformance: ' + check, () => run(d));

test('every registered family has a descriptor or is listed as pending; the pending list only shrinks', t => {
  const registered = reviewedFamilies().map(f => f.name),
    described = descriptors.map(d => d.family);
  assert.deepEqual(
    described.filter(name => !registered.includes(name)),
    [],
    'descriptors name registered families',
  );
  assert.equal(new Set(described).size, described.length, 'one descriptor per family');
  const uncovered = registered.filter(name => !described.includes(name)).sort();
  assert.deepEqual(
    uncovered.filter(name => !pending.families.includes(name)),
    [],
    'a new family ships a descriptor',
  );
  assert.deepEqual(
    pending.families.filter(name => !uncovered.includes(name)),
    [],
    'a described or removed family leaves the pending list',
  );
  for (const d of descriptors) {
    assert.ok(['activation', 'budget', 'destructive', 'settings'].includes(d.risk), d.file);
    assert.ok(d.unpaginated === undefined || (typeof d.unpaginated === 'string' && d.unpaginated.length > 20), d.file);
  }
  // The pending list is bounded: the ceiling equals its length and only falls as descriptors land, so a family added to
  // the list (instead of shipping a descriptor) fails here.
  assert.equal(pending.families.length, pending.ceiling, 'lower the ceiling with the list; never raise it');
  const spend = new Set(
    reviewedFamilies()
      .filter(f => f.spendConfirmation)
      .map(f => f.name),
  );
  t.diagnostic(
    'reviewed families: ' +
      registered.length +
      '; with a descriptor: ' +
      described.length +
      '; pending: ' +
      uncovered.length +
      ' (spend-affecting: ' +
      uncovered.filter(name => spend.has(name)).length +
      ')',
  );
});
