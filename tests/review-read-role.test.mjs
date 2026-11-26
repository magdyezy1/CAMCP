// always-run: lists src/ and the family descriptors for the read role of every review
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {familyFixture} from './helpers/family-conformance.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';
import {standardCreates} from './helpers/tiktok-standard-creates.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {readRole} from '../dist/src/review-state-core.js';
import {materialFields} from '../dist/src/review-diff.js';

/**
 * Round 2.5, merge r25-m1-merge (the one design join of r25-m1-hash and r25-m1-diff, review S3-6 of both): the role of a state
 * read, decided in ONE place for the hash and for `material`.
 *
 * r25-m1-hash gives a read its role (`CompiledRequest.stateRole`: account, parent or reference; none is the TARGET) and keeps
 * a review's state accordingly: only an ACCOUNT container is kept to its identity, a PARENT is read like a target, a read with
 * no role is protected like a target. r25-m1-diff ranks the paths a STATE_CHANGED names by the role of their read, and lists
 * every changed field of a target, a parent or a reference as material. Before the merge each package decided a read's role by
 * itself, and diff's decided more reads than hash's: a read of exactly the provider's account path counted as an account for
 * `material` although the hash read it whole. A role the hash has not given a read must not be one for `material` either, and
 * the other way round, or one of the two protections is not the one the other thinks it is.
 *
 * Nothing leaves the process; every value is synthetic.
 */
offerParkedProviders('criteo');

test('the role of a read is the three roles the hash package stamps, and anything else is a target', () => {
  for (const role of ['account', 'parent', 'reference']) assert.equal(readRole({stateRole: role}), role, role);
  // The target is a read with no role. A value that is none of the three is no role, whatever it looks like: a saved review is
  // JSON and may hold anything, and what is not placed is protected like a target. The name is `stateRole` and no other.
  for (const read of [
    undefined,
    null,
    {},
    {stateRole: undefined},
    {stateRole: null},
    {stateRole: ''},
    {stateRole: 'target'},
    {stateRole: 'Account'},
    {stateRole: 'ACCOUNT'},
    {stateRole: ' account'},
    {stateRole: 'account_parent'},
    {stateRole: 'account or parent'},
    {stateRole: 'banana'},
    {stateRole: 3},
    {stateRole: true},
    {stateRole: {}},
    {stateRole: ['account']},
    {role: 'account'},
    {Role: 'parent'},
    {state_role: 'reference'},
    'account',
    7,
    true,
  ])
    assert.equal(readRole(read), 'target', JSON.stringify(read));
});

test('one lookup: no module reads a read’s role except readRole, and the diff has no second one', () => {
  const lookup = 'review-state-core.ts',
    readers = [];
  for (const file of fs.readdirSync('src').filter(n => n.endsWith('.ts'))) {
    // Comments may name the property; code may only stamp it (`stateRole: 'account'`, `read.stateRole = 'parent'`).
    const code = fs
      .readFileSync('src/' + file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const reads =
      /(?:\.|\?\.)stateRole\b(?!\s*=(?!=))/.test(code) ||
      /\[\s*['"`]stateRole['"`]\s*\]/.test(code) ||
      /\{[^{}]*\bstateRole\b[^{}]*\}\s*=(?!=)/.test(code);
    if (reads && file !== lookup) readers.push(file);
  }
  assert.deepEqual(readers, [], 'these modules read the role themselves: ask readRole');
  const text = name => fs.readFileSync('src/' + name, 'utf8');
  // The two consumers ask it: the state stage that keeps an account to its identity, and `material`.
  assert.match(text('review-state.ts'), /\breadRole\b/);
  assert.match(text('review-diff.ts'), /\breadRole\b/);
  // The diff keeps no lookup of its own: no second name for the role, no label map, no account-path inference.
  assert.doesNotMatch(text('review-diff.ts'), /declaredRole|readRoleOf|roleNames|accountPath|providerHooks/);
  assert.match(text('review-state-core.ts'), /export function readRole\(/);
});

// ---- Every family descriptor: the role the hash keys on is the role `material` uses ------------------------------------------

const directory = path.resolve('tests/family-descriptors'),
  descriptors = [];
for (const file of fs
  .readdirSync(directory)
  .filter(n => n.endsWith('.mjs') && !n.startsWith('_'))
  .sort())
  descriptors.push({file, ...(await import(pathToFileURL(path.join(directory, file)).href)).default});
for (const file of fs
  .readdirSync(path.join(directory, 'variants'))
  .filter(n => n.endsWith('.mjs'))
  .sort())
  descriptors.push({
    file: 'variants/' + file,
    variant: file.replace(/\.mjs$/, ''),
    ...(await import(pathToFileURL(path.join(directory, 'variants', file)).href)).default,
  });
const name = d => d.family + (d.variant ? ' (variant ' + d.variant + ')' : '');

/** `material` lists a target first, then a parent, a reference and the account (src/review-diff.ts); the order is its contract. */
const ranking = ['target', 'parent', 'reference', 'account'];
/**
 * The role `materialFields` gives one read, found from outside: the read goes first among one probe read of each role, one
 * changed path (a key no list names) is named in each, and the place of the read's own path in what `material` lists says its
 * rank. On equal rank the order the diff found is kept, so the read, which comes first, sits before the probe of its own role.
 */
function materialRole(read) {
  const reads = [read, {}, {stateRole: 'parent'}, {stateRole: 'reference'}, {stateRole: 'account'}],
    changed = reads.map((_, i) => '$[' + i + ']["zz_probe"]');
  return ranking[materialFields(changed, reads).indexOf(changed[0])];
}
/** The role the hash keys on, written out as the hash package states it: the stamp is the role, and a read with none is the target. */
const hashRole = read => (['account', 'parent', 'reference'].includes(read.stateRole) ? read.stateRole : 'target');

const seen = {target: 0, parent: 0, reference: 0, account: 0};
for (const d of descriptors)
  test(name(d) + ': every read of the review has the same role for the hash and for material', async () => {
    const f = familyFixture(d);
    try {
      const prepared = await f.prepare();
      assert.equal(
        prepared.success,
        true,
        name(d) + ' prepares: ' + JSON.stringify(prepared.error ?? prepared).slice(0, 500),
      );
      const review = f.store.document('conformance-' + d.family, 'write_review', prepared.data.review_id);
      assert.ok(Array.isArray(review.reads) && review.reads.length > 0, name(d) + ' stores the reads it checks');
      for (const read of review.reads) {
        // Only the three roles are ever stamped (tests/review-roles.test.mjs holds the vocabulary).
        assert.ok(
          [undefined, 'account', 'parent', 'reference'].includes(read.stateRole),
          name(d) + ': ' + read.stateRole,
        );
        const expected = hashRole(read);
        seen[expected]++;
        assert.equal(
          materialRole(read),
          expected,
          name(d) + ': ' + read.method + ' ' + read.path + ' has one role for the hash and another for material',
        );
      }
    } finally {
      f.close();
    }
  });

test('coverage: every role is met by the real reads of the descriptors, so the comparison is not vacuous', t => {
  t.diagnostic('reads by role across ' + descriptors.length + ' descriptors: ' + JSON.stringify(seen));
  // The floors are what the descriptors showed when the merge was made (r25-m1-merge): the reads the code stamps an account (15),
  // a parent (the two Smart+ ones) and a reference (Reddit's funding instrument), and the reads it leaves as targets. A family
  // that loses its stamp, or a role that stops being met, falls under them and fails here.
  assert.ok(seen.account >= 15, 'account reads: ' + seen.account);
  assert.ok(seen.parent >= 2, 'parent reads: ' + seen.parent);
  assert.ok(seen.reference >= 1, 'reference reads: ' + seen.reference);
  assert.ok(seen.target >= 200, 'target reads: ' + seen.target);
});

test('the three standard TikTok creates: the advertiser is the account, the campaign or ad group they go under is the parent, for the hash and for material', async () => {
  // No family descriptor reads these parents (nothing claims the standard creates), and they are the most common parents there
  // are. The roles are written out by hand, as tests/review-roles.test.mjs pins them.
  const expected = {campaign: ['account'], adgroup: ['account', 'parent'], ad: ['account', 'parent']};
  for (const [kind, roles] of Object.entries(expected)) {
    const world = advertiserWorld(),
      f = standardCreates(world, {tenant: 'read-role-' + kind});
    try {
      const prepared = await f.prepare(kind);
      assert.equal(
        prepared.success,
        true,
        kind + ' prepares: ' + JSON.stringify(prepared.error ?? prepared).slice(0, 400),
      );
      const saved = f.store.document(f.tenant, 'write_review', prepared.data.review_id);
      assert.deepEqual(saved.reads.map(hashRole), roles, kind + ': the roles the hash keys on');
      assert.deepEqual(saved.reads.map(materialRole), roles, kind + ': the roles material gives');
    } finally {
      f.close();
    }
  }
});
