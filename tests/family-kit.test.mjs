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

// The modules each codemod wave moved onto the kit's fail, by provider prefix: wave 1 the X families, wave 2 the TikTok
// and Google Ads families, wave 3 the Criteo, DV360, LinkedIn, Meta and Snapchat families with a byte-identical copy.
const waves = {
  1: {
    x: [
      'conversation-cards',
      'curated-categories',
      'custom-audiences',
      'entity-batches',
      'line-item-associations',
      'media-library',
      'preroll-ctas',
      'scheduled-tweets',
      'tracking-tags',
    ],
  },
  2: {
    tiktok: [
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
    ],
    google: [
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
    ],
  },
  3: {
    criteo: [
      'auction-line-items',
      'audience-segments',
      'budget-overrides',
      'catalog-requests',
      'creatives',
      'line-item-bidding',
      'preferred-line-items',
      'promoted-products',
    ],
    dv360: [
      'ad-assets',
      'advertiser-settings',
      'audience-edits',
      'custom-bidding-files',
      'custom-bidding',
      'demand-gen-ad-groups',
      'demand-gen-ads',
      'inventory-source-groups',
      'line-item-bulk-update',
      'line-item-duplicate',
      'sdf-downloads',
    ],
    linkedin: [
      'ab-tests',
      'account-settings',
      'dsc-edits',
      'engagement-audiences',
      'entity-deletes',
      'insight-domains',
      'insight-tags',
      'lead-form-states',
      'lift-tests',
      'message-ads',
      'publisher-restrictions',
      'third-party-tracking',
      'tracking-parameters',
    ],
    meta: [
      'account-settings',
      'ad-images',
      'ad-rules',
      'ad-videos',
      'budget-schedules',
      'catalog-products',
      'custom-conversions',
      'customer-lists',
      'object-edits',
      'offline-conversions',
      'pixels',
      'product-catalogs',
      'product-feeds',
      'product-sets',
      'split-tests',
    ],
    snapchat: [
      'adsquad-targeting',
      'catalog-comparison',
      'catalogs',
      'claim-media',
      'custom-conversions',
      'dynamic-templates',
      'event-details',
      'media-copy',
      'offer-disclaimers',
      'pixel-names',
      'product-feeds',
      'product-sets',
      'segment-deletions',
      'targeting-specs',
    ],
  },
};
const waveModules = number =>
  Object.entries(waves[number]).flatMap(([prefix, modules]) => modules.map(m => 'src/' + prefix + '-' + m + '.ts'));

test('the X families declare themselves through the kit and no module of waves 1 to 3 keeps a local fail copy', () => {
  const wave = [1, 2, 3].flatMap(waveModules);
  assert.equal(wave.length, 9 + 24 + 61);
  for (const file of wave) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /^function fail\(/m, file);
    assert.match(source, /^import \{(?:defineFamily, )?fail\} from '\.\/family-kit\.js';$/m, file);
    if (file.startsWith('src/x-')) assert.match(source, /: ReviewedFamily = defineFamily\(\{$/m, file);
  }
});
