import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {reviewedFamilies} from '../dist/src/reviewed-families.js';
import {defineFamily, everyFamilyHookHasAStage, fail} from '../dist/src/family-kit.js';
import {MirrorError} from '../dist/src/errors.js';

// ARC-04 stage C: the reviewed-family kit. Loading the catalog first evaluates the registry, as entry points do.
new Registry();

test('the kit fail is the refusal the family modules copied: code, reason, details and status 400 by default', () => {
  const caught = f => {
    try {
      f();
    } catch (error) {
      return error;
    }
    assert.fail('no refusal');
  };
  const plain = caught(() => fail('INVALID_X', 'Reason.'));
  assert.ok(plain instanceof MirrorError);
  assert.deepEqual(
    [plain.code, plain.message, plain.details, plain.status, plain.retryable],
    ['INVALID_X', 'Reason.', {}, 400, false],
  );
  const read = caught(() => fail('X_STATE_UNVERIFIED', 'Unverified.', {field: 'id'}, 502));
  assert.deepEqual([read.code, read.details, read.status], ['X_STATE_UNVERIFIED', {field: 'id'}, 502]);
});

test('every registered family is a well-formed declaration, and defineFamily returns it unchanged', () => {
  assert.equal(everyFamilyHookHasAStage, true);
  const families = reviewedFamilies();
  assert.ok(families.length >= 167);
  for (const family of families) assert.equal(defineFamily(family), family, family.name);
});

test('defineFamily refuses a malformed declaration when its module loads', () => {
  const valid = {
    name: 'x_example_family',
    files: ['src/x-example.ts', ['tests/x-example.test.mjs']],
    kind: () => false,
  };
  assert.equal(defineFamily(valid), valid);
  for (const [what, family] of [
    ['a name outside the ledger form', {...valid, name: 'Example'}],
    ['a name without its provider prefix', {...valid, name: 'example'}],
    ['an implementation outside src', {...valid, files: ['tools/x-example.ts', ['tests/x-example.test.mjs']]}],
    ['one of several modules outside src', {...valid, files: ['src/x-a.ts / lib/x-b.ts', ['tests/x-a.test.mjs']]}],
    ['no test file', {...valid, files: ['src/x-example.ts', []]}],
    ['a test outside tests', {...valid, files: ['src/x-example.ts', ['src/x-example.test.mjs']]}],
    ['no kind hook', {...valid, kind: undefined}],
  ])
    assert.throws(
      () => defineFamily(family),
      e => e.code === 'REVIEWED_FAMILY_INVALID' && e.status === 500,
      what,
    );
  assert.ok(defineFamily({...valid, files: ['src/x-a.ts / src/x-b.ts', ['tests/x-a.test.mjs']]}));
});

test('the X families declare themselves through the kit and no wave-1 or wave-2 module keeps a local fail copy', () => {
  const wave = [
    ...[
      'conversation-cards',
      'curated-categories',
      'custom-audiences',
      'entity-batches',
      'line-item-associations',
      'media-library',
      'preroll-ctas',
      'scheduled-tweets',
      'tracking-tags',
    ].map(m => 'src/x-' + m + '.ts'),
    ...[
      'ad-comments',
      'audience-edits',
      'blocked-words',
      'change-logs',
      'conversion-edits',
      'deletions',
      'image-edits',
      'library-assets',
      'pixels',
      'rule-audiences',
    ].map(m => 'src/tiktok-' + m + '.ts'),
    ...[
      'auto-assets',
      'business-location-attributes',
      'business-location-edits',
      'business-lodging',
      'campaign-drafts',
      'customer-settings',
      'data-manager',
      'experiments',
      'pmax-brand-guidelines',
      'recommendation-apply',
      'recommendation-subscriptions',
      'smart-campaign-settings',
      'user-list-customer-types',
      'youtube-uploads',
    ].map(m => 'src/google-' + m + '.ts'),
  ];
  for (const file of wave) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /^function fail\(/m, file);
    assert.match(source, /^import \{(?:defineFamily, )?fail\} from '\.\/family-kit\.js';$/m, file);
    if (file.startsWith('src/x-')) assert.match(source, /: ReviewedFamily = defineFamily\(\{$/m, file);
  }
});
