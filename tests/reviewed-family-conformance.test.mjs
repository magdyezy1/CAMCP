// QA-02 behavioral family conformance: every described reviewed write family is driven through the real review
// lifecycle (tests/helpers/family-conformance.mjs) and must detect a decisive change between review and execute,
// refuse a paginated snapshot, and never report or resend a partial answer as success. Families without a descriptor
// are listed in tests/fixtures/family-conformance-pending.json; the list only shrinks, and a new family ships a
// descriptor (docs/ADDING-A-REVIEWED-FAMILY.md). A family of a parked provider (PRK-02, `parkedProviders` in
// tools/provider-lifecycle.ts) may instead hold a lifecycle-parked exemption entry, valid only while its provider stays
// parked.
// always-run: lists the family descriptors for the conformance of every reviewed family
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {reviewedFamilies} from '../dist/src/reviewed-families.js';
import {parkedProviders} from '../dist/tools/provider-lifecycle.js';
import {conformanceChecks} from './helpers/family-conformance.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// Criteo is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('criteo');

const directory = path.resolve('tests/family-descriptors'),
  descriptors = [],
  // A second request shape a family also serves (PRV-06 A: the ad squad targeting PATCH of snapchat_nested_updates) is
  // described as a variant in tests/family-descriptors/variants/: it runs the same checks, and never stands in for the
  // family's own descriptor.
  variants = [];
for (const file of fs
  .readdirSync(directory)
  .filter(n => n.endsWith('.mjs') && !n.startsWith('_'))
  .sort())
  descriptors.push({file, ...(await import(pathToFileURL(path.join(directory, file)).href)).default});
for (const file of fs
  .readdirSync(path.join(directory, 'variants'))
  .filter(n => n.endsWith('.mjs'))
  .sort())
  variants.push({
    file: 'variants/' + file,
    variant: file.replace(/\.mjs$/, ''),
    ...(await import(pathToFileURL(path.join(directory, 'variants', file)).href)).default,
  });
const pending = JSON.parse(fs.readFileSync('tests/fixtures/family-conformance-pending.json', 'utf8'));

for (const d of [...descriptors, ...variants]) {
  const name = d.family + (d.variant ? ' (variant ' + d.variant + ')' : '');
  for (const [check, run] of Object.entries(conformanceChecks))
    // A family whose state read is one settings object the vendor never pages states why (`unpaginated`); its
    // paginated-snapshot check is reported as not applicable with that reason instead of testing an invented shape.
    // (Not a skipped test: release qualification fails on any skip it was not told about.)
    if (check === 'paginatedSnapshot' && d.unpaginated)
      test(name + ' conformance: paginatedSnapshot not applicable (' + d.unpaginated + ')', t => {
        assert.ok(d.unpaginated.length > 20);
        t.diagnostic('not paged by the vendor: ' + d.unpaginated);
      });
    else test(name + ' conformance: ' + check, () => run(d));
}

test('every registered family has a descriptor or is listed as pending; the pending list only shrinks', t => {
  const registered = reviewedFamilies().map(f => f.name),
    described = descriptors.map(d => d.family);
  assert.deepEqual(
    described.filter(name => !registered.includes(name)),
    [],
    'descriptors name registered families',
  );
  assert.equal(new Set(described).size, described.length, 'one descriptor per family');
  // A variant adds a request shape to a described family; it never covers a family on its own.
  assert.deepEqual(
    variants.filter(v => !described.includes(v.family)).map(v => v.file),
    [],
    'a variant names a family that has its own descriptor',
  );
  const {active, parked} = ratchet(registered, described, pending, parkedProviders);
  for (const d of [...descriptors, ...variants]) {
    assert.ok(['activation', 'budget', 'destructive', 'settings'].includes(d.risk), d.file);
    assert.ok(d.unpaginated === undefined || (typeof d.unpaginated === 'string' && d.unpaginated.length > 20), d.file);
  }
  const spend = new Set(
    reviewedFamilies()
      .filter(f => f.spendConfirmation)
      .map(f => f.name),
  );
  // A family the registry marks spend-affecting is money evidence (risk class R1 counts the activation, budget and
  // destructive descriptors): its descriptor is never labelled settings.
  assert.deepEqual(
    [...descriptors, ...variants].filter(d => spend.has(d.family) && d.risk === 'settings').map(d => d.file),
    [],
    'a spend-affecting family is not labelled settings',
  );
  t.diagnostic(
    'reviewed families: ' +
      registered.length +
      '; with a descriptor: ' +
      described.length +
      '; pending: ' +
      active.length +
      ' (spend-affecting: ' +
      active.filter(name => spend.has(name)).length +
      '); exempt while their provider is parked: ' +
      parked.length,
  );
});

/** Checks the pending ratchet and the parked exemptions against the registry; returns the families each one holds. */
function ratchet(registered, described, pending, parkedProviders) {
  const uncovered = registered.filter(name => !described.includes(name)).sort(),
    parked = pending.parked?.families ?? [],
    active = uncovered.filter(name => !parked.includes(name));
  // A lifecycle-parked exemption names a family of a provider tools/provider-lifecycle.ts still parks; unparking the
  // provider fails here until its families ship descriptors.
  for (const name of parked)
    assert.ok(
      [...parkedProviders].some(provider => name.startsWith(provider + '_')),
      name + ' is exempt as parked, but its provider is not parked in tools/provider-lifecycle.ts',
    );
  assert.deepEqual(
    parked.filter(name => pending.families.includes(name)),
    [],
    'a family is pending or parked, not both',
  );
  assert.deepEqual(
    parked.filter(name => !uncovered.includes(name)),
    [],
    'a described or removed family leaves the parked exemption list',
  );
  assert.deepEqual(
    active.filter(name => !pending.families.includes(name)),
    [],
    'a new family ships a descriptor',
  );
  assert.deepEqual(
    pending.families.filter(name => !active.includes(name)),
    [],
    'a described or removed family leaves the pending list',
  );
  // Both lists are bounded: each ceiling equals its list's length and only falls as descriptors land, so a family added
  // to either list (instead of shipping a descriptor) fails here.
  assert.equal(pending.families.length, pending.ceiling, 'lower the ceiling with the list; never raise it');
  assert.equal(parked.length, pending.parked?.ceiling ?? 0, 'the parked exemption list never grows');
  return {active, parked};
}

// Regression guards of the lifecycle-parked exemption (QA-02 part C): it covers only a parked provider's families.
test('a parked exemption for an active provider family, or after its provider is unparked, fails the ratchet', () => {
  const registered = ['criteo_campaigns', 'tiktok_pixels'],
    pendingWith = (families, parked) => ({
      ceiling: families.length,
      families,
      parked: {ceiling: parked.length, families: parked},
    });
  // The accepted shape: the parked provider's family exempt, the active one described.
  assert.deepEqual(ratchet(registered, ['tiktok_pixels'], pendingWith([], ['criteo_campaigns']), new Set(['criteo'])), {
    active: [],
    parked: ['criteo_campaigns'],
  });
  // An active provider's family cannot hide under the parked exemption.
  assert.throws(
    () => ratchet(registered, ['criteo_campaigns'], pendingWith([], ['tiktok_pixels']), new Set(['criteo'])),
    /tiktok_pixels is exempt as parked, but its provider is not parked/,
  );
  // Unparking Criteo ends its exemption.
  assert.throws(
    () => ratchet(registered, ['tiktok_pixels'], pendingWith([], ['criteo_campaigns']), new Set()),
    /criteo_campaigns is exempt as parked, but its provider is not parked/,
  );
  // A family is not both pending and parked, a described family leaves the parked list, and the list never grows.
  assert.throws(
    () =>
      ratchet(
        registered,
        ['tiktok_pixels'],
        pendingWith(['criteo_campaigns'], ['criteo_campaigns']),
        new Set(['criteo']),
      ),
    /pending or parked, not both/,
  );
  assert.throws(
    () => ratchet(registered, registered, pendingWith([], ['criteo_campaigns']), new Set(['criteo'])),
    /leaves the parked exemption list/,
  );
  assert.throws(
    () =>
      ratchet(
        registered,
        ['tiktok_pixels'],
        {ceiling: 0, families: [], parked: {ceiling: 0, families: ['criteo_campaigns']}},
        new Set(['criteo']),
      ),
    /parked exemption list never grows/,
  );
});
