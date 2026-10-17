import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parsers} from 'prettier/plugins/babel';
import {Registry} from '../dist/src/catalog.js';
import {reviewedFamilies} from '../dist/src/reviewed-families.js';
import * as kit from '../dist/src/family-kit.js';
import {MirrorError} from '../dist/src/errors.js';
import {
  inspectBackendWrapperFailures,
  kitRefusalFactories,
  unlocalizedRefusalModules,
} from '../tools/check-locales.mjs';

const {defineFamily, everyFamilyHookHasAStage, fail} = kit;

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

// Wave 4: the variants with their own codes and statuses. Each module's binding is read from its source, its literal
// arguments are passed to the kit's factory, and every code the module's calls name must refuse with the status its
// local helper gave (transcribed from the helper each module declared before wave 4).
const probe = (refuse, args) => {
  try {
    refuse(...args);
  } catch (error) {
    assert.ok(error instanceof MirrorError);
    return [error.code, error.status, error.details, error.message];
  }
  assert.fail('no refusal');
};
// For a refusal that names its reason first: the module's default code, [code, status] for codes its calls name, and
// the status of any other code.
const reasonFirst = {
  'src/criteo-campaign-writes.ts': [
    'CRITEO_CAMPAIGN_INVALID',
    {CRITEO_CAMPAIGN_STATE_UNVERIFIED: 502, INSUFFICIENT_SCOPE: 400, RESOURCE_SCOPE_REQUIRED: 400},
  ],
  'src/criteo-report-jobs.ts': [
    'CRITEO_REPORT_INVALID',
    {CRITEO_REPORT_STATE_UNVERIFIED: 502, CRITEO_REPORT_PENDING: 400, CRITEO_REPORT_TOO_LARGE: 400},
  ],
  'src/criteo-targeting-writes.ts': [
    'CRITEO_TARGETING_INVALID',
    {CRITEO_STATE_UNVERIFIED: 400, INSUFFICIENT_SCOPE: 400},
  ],
  'src/dv360-targeting-search.ts': [
    'INVALID_DV360_SEARCH',
    {
      DV360_SEARCH_RESPONSE_INVALID: 502,
      DV360_SEARCH_LIMIT: 502,
      PAGINATION_LOOP: 502,
      ACCOUNT_SCOPE_MISMATCH: 403,
      INSUFFICIENT_SCOPE: 403,
    },
  ],
  // Any code other than its input and the scope mismatch was a failed read (502).
  'src/google-place-action-discovery.ts': [
    'INVALID_PLACE_ACTION_READ',
    {ACCOUNT_SCOPE_MISMATCH: 403, PLACE_ACTION_READ_INVALID: 502, PLACE_ACTION_READ_LIMIT: 502, PAGINATION_LOOP: 502},
    502,
  ],
  'src/google-place-action-links.ts': ['INVALID_PLACE_ACTION', {PLACE_ACTION_STATE_UNVERIFIED: 502}],
  'src/meta-insights-jobs.ts': ['META_REPORT_INVALID', {META_REPORT_STATE_UNVERIFIED: 502, INSUFFICIENT_SCOPE: 400}],
  'src/meta-label-writes.ts': ['META_LABEL_INVALID', {META_LABEL_STATE_UNVERIFIED: 400, WRITE_PARTIAL_OR_FAILED: 400}],
  'src/tiktok-report-jobs.ts': [
    'TIKTOK_REPORT_INVALID',
    {
      TIKTOK_REPORT_STATE_UNVERIFIED: 502,
      RESOURCE_SCOPE_REQUIRED: 403,
      TIKTOK_REPORT_TOKEN_CHANGED: 403,
      TIKTOK_REPORT_EXPIRED: 400,
      TIKTOK_REPORT_NOT_CANCELLABLE: 400,
    },
  ],
  'src/x-audience-estimate.ts': [
    'INVALID_X_AUDIENCE_ESTIMATE',
    {
      RESOURCE_SCOPE_REQUIRED: 403,
      ACCOUNT_SCOPE_MISMATCH: 403,
      X_AUDIENCE_RESPONSE_INVALID: 502,
      X_AUDIENCE_LIMIT: 502,
    },
  ],
  'src/x-report-jobs.ts': [
    'X_REPORT_INVALID',
    {X_REPORT_STATE_UNVERIFIED: 502, RESOURCE_SCOPE_REQUIRED: 403, X_REPORT_LOGIN_CHANGED: 403, X_REPORT_EXPIRED: 400},
  ],
  'src/search-exclusion-plan.ts': [
    'SEARCH_EXCLUSION_EVIDENCE_REQUIRED',
    {SEARCH_EXCLUSION_PREVIEW_CHANGED: 400, CONFIRMATION_REQUIRED: 400},
  ],
  // These helpers kept MirrorError's default status for every code, their state codes included.
  'src/google-bid-modifiers.ts': [
    'INVALID_BID_MODIFIER',
    {BID_MODIFIER_STATE_UNVERIFIED: 400, BID_MODIFIER_EXISTS: 400},
  ],
  'src/google-bidding-events.ts': ['INVALID_BIDDING_EVENT', {BIDDING_EVENT_STATE_UNVERIFIED: 400}],
  'src/google-campaign-bid-modifiers.ts': ['INVALID_BID_MODIFIER', {BID_MODIFIER_STATE_UNVERIFIED: 502}],
  'src/google-conversion-actions.ts': ['INVALID_CONVERSION_ACTION', {CONVERSION_ACTION_STATE_UNVERIFIED: 502}],
  'src/google-conversion-goals.ts': ['INVALID_CONVERSION_GOAL', {CONVERSION_GOAL_STATE_UNVERIFIED: 502}],
  'src/google-portfolio-strategies.ts': [
    'INVALID_PORTFOLIO_STRATEGY',
    {PORTFOLIO_STATE_UNVERIFIED: 400, WRITE_CONTRACT_UNAVAILABLE: 400},
  ],
  'src/linkedin-audience-templates.ts': [
    'LINKEDIN_TEMPLATE_STATE_UNVERIFIED',
    {INVALID_AUDIENCE_TEMPLATE: 400, LINKEDIN_TEMPLATE_LIMIT: 400},
  ],
  'src/linkedin-conversion-links.ts': ['INVALID_CONVERSION_LINK', {CONVERSION_LINK_STATE_UNVERIFIED: 400}],
  'src/linkedin-conversion-rules.ts': ['INVALID_CONVERSION_RULE', {CONVERSION_RULE_STATE_UNVERIFIED: 400}],
  'src/meta-existing-posts.ts': [
    'INVALID_META_POST_INPUT',
    {META_POST_RESPONSE_INVALID: 400, ACCOUNT_SCOPE_MISMATCH: 400},
  ],
  'src/x-draft-writes.ts': ['X_DRAFT_STATE_UNVERIFIED', {INVALID_X_DRAFT: 400, X_DRAFT_DISCOVERY_LIMIT: 400}],
  'src/x-targeting-batch.ts': [
    'X_TARGETING_STATE_UNVERIFIED',
    {INVALID_X_TARGETING_BATCH: 400, X_TARGETING_LIMIT: 400},
  ],
};
// For a refusal with a state flag: its input code (400) and its state code (502).
const stateFlagged = {
  'src/google-business-access.ts': ['INVALID_BUSINESS_ACCESS', 'BUSINESS_ACCESS_STATE_UNVERIFIED'],
  'src/google-business-notifications.ts': ['INVALID_BUSINESS_NOTIFICATION', 'BUSINESS_NOTIFICATION_STATE_UNVERIFIED'],
  'src/google-customer-labels.ts': ['INVALID_CUSTOMER_LABEL_REMOVAL', 'CUSTOMER_LABEL_STATE_UNVERIFIED'],
  'src/google-preview-writes.ts': ['INVALID_PREVIEW_REQUEST', 'PREVIEW_STATE_UNVERIFIED'],
  'src/google-recommendation-dismissal.ts': ['INVALID_RECOMMENDATION_DISMISSAL', 'RECOMMENDATION_STATE_UNVERIFIED'],
  'src/google-user-access.ts': ['INVALID_GOOGLE_ACCESS', 'GOOGLE_ACCESS_STATE_UNVERIFIED'],
  'src/snapchat-nested-updates.ts': ['INVALID_SNAPCHAT_UPDATE', 'SNAPCHAT_UPDATE_STATE_UNVERIFIED'],
};
// For a refusal with one code: the code and its status.
const oneCode = {
  'src/apple-entity-writes.ts': ['INVALID_APPLE_REQUEST', 400],
  'src/microsoft-campaign-criteria.ts': ['INVALID_MICROSOFT_REQUEST', 400],
  'src/microsoft-native.ts': ['INVALID_MICROSOFT_REQUEST', 400],
  'src/reddit-writes.ts': ['INVALID_REDDIT_MUTATION', 400],
  'src/x-creative-writes.ts': ['X_CREATIVE_STATE_UNVERIFIED', 400],
  'src/x-report-download.ts': ['X_REPORT_DOWNLOAD_INVALID', 502],
  'src/google-custom-segments.ts': ['INVALID_CUSTOM_SEGMENT', 400],
  'src/measurement-writes.ts': ['WRITE_CONTRACT_UNAVAILABLE', 400],
  'src/microsoft-associations.ts': ['INVALID_MICROSOFT_ASSOCIATION', 400],
};
// For fail with a module's own default status.
const ownStatus = {
  'src/google-lifecycle-goals.ts': 409,
  'src/write-reconciliation.ts': 409,
  'src/linkedin-posts.ts': 403,
};
// The modules whose helper was the kit's fail itself, and the shared helpers that re-export it under their old name.
const kitFail = [
  'src/dv360-line-item-targeting.ts',
  'src/dv360-list-writes.ts',
  'src/google-listing-groups.ts',
  'src/gtm-diagnostics.ts',
  'src/gtm-workflow-writes.ts',
  'src/gtm-workspace-writes.ts',
  'src/meta-brand-safety.ts',
  'src/meta-value-rules.ts',
  'src/tiktok-brand-safety.ts',
  'src/tiktok-negative-keywords.ts',
  'src/ad-previews.ts',
  'src/media-upload.ts',
];
const reexported = ['src/write-common.ts', 'src/personal-data.ts', 'src/x-catalogs.ts'];
const literal = node => {
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral') return node.value;
  if (node.type === 'ObjectExpression')
    return Object.fromEntries(
      node.properties.map(p => {
        assert.equal(p.type, 'ObjectProperty');
        return [p.key.name ?? p.key.value, literal(p.value)];
      }),
    );
  assert.fail('a refusal binding takes literal arguments only, not ' + node.type);
};
/** The module's top-level `const fail: T = factory(...)`: the factory, its type annotation and the refusal it builds. */
const binding = file => {
  const program = parsers['babel-ts'].parse(fs.readFileSync(file, 'utf8'), {filepath: file}).program;
  const found = program.body
    .filter(n => n.type === 'VariableDeclaration' && n.kind === 'const')
    .flatMap(n => n.declarations)
    .filter(d => d.id.name === 'fail');
  assert.equal(found.length, 1, file + ' binds fail once');
  const [declarator] = found,
    factory = declarator.init?.callee?.name;
  assert.ok(Object.hasOwn(kitRefusalFactories, factory), file + ': ' + factory);
  return {
    factory,
    // The annotation makes TypeScript treat a call as the end of its branch, as it treated the local function.
    type: declarator.id.typeAnnotation?.typeAnnotation?.typeName?.name,
    refuse: kit[factory](...declarator.init.arguments.map(literal)),
  };
};

test('the kit factories build the refusals the variants declared: codes, statuses, details and the reason', () => {
  const reasons = kit.familyErrors('INVALID_X', {X_STATE_UNVERIFIED: 502, X_SCOPE: 403});
  assert.deepEqual(probe(reasons, ['Bad input.']), ['INVALID_X', 400, {}, 'Bad input.']);
  assert.deepEqual(probe(reasons, ['Unverified.', 'X_STATE_UNVERIFIED']).slice(0, 2), ['X_STATE_UNVERIFIED', 502]);
  assert.deepEqual(probe(reasons, ['Denied.', 'X_SCOPE']).slice(0, 2), ['X_SCOPE', 403]);
  assert.deepEqual(probe(reasons, ['Other.', 'OTHER']).slice(0, 2), ['OTHER', 400]);
  // A code the statuses do not name takes `otherwise`; an inherited property name is not a status.
  const reads = kit.familyErrors('INVALID_READ', {INVALID_READ: 400}, 502);
  assert.deepEqual(probe(reads, ['Read.']).slice(0, 2), ['INVALID_READ', 400]);
  assert.deepEqual(probe(reads, ['Read.', 'READ_LIMIT']).slice(0, 2), ['READ_LIMIT', 502]);
  assert.deepEqual(probe(reads, ['Read.', 'toString']).slice(0, 2), ['toString', 502]);
  const state = kit.familyStateErrors('INVALID_Y', 'Y_STATE_UNVERIFIED');
  assert.deepEqual(probe(state, ['Input.']), ['INVALID_Y', 400, {}, 'Input.']);
  assert.deepEqual(probe(state, ['State.', true]).slice(0, 2), ['Y_STATE_UNVERIFIED', 502]);
  // Another code and details keep the status of the flag.
  assert.deepEqual(probe(state, ['Gone.', false, 'STATE_NOT_FOUND', {id: '1'}]), [
    'STATE_NOT_FOUND',
    400,
    {id: '1'},
    'Gone.',
  ]);
  assert.deepEqual(probe(state, ['Gone.', true, 'STATE_NOT_FOUND']).slice(0, 2), ['STATE_NOT_FOUND', 502]);
  const one = kit.familyCodeError('INVALID_Z');
  assert.deepEqual(probe(one, ['Z.']), ['INVALID_Z', 400, {}, 'Z.']);
  assert.deepEqual(probe(one, ['Z.', {field: 'id'}]), ['INVALID_Z', 400, {field: 'id'}, 'Z.']);
  assert.deepEqual(probe(kit.familyCodeError('Z_DOWNLOAD_INVALID', 502), ['Z.']).slice(0, 2), [
    'Z_DOWNLOAD_INVALID',
    502,
  ]);
  const conflict = kit.failWithStatus(409);
  assert.deepEqual(probe(conflict, ['CHANGED', 'Changed.']), ['CHANGED', 409, {}, 'Changed.']);
  assert.deepEqual(probe(conflict, ['INVALID_ARGUMENT', 'Bad.', {}, 400]).slice(0, 2), ['INVALID_ARGUMENT', 400]);
});

test('wave 4: every variant module refuses through the kit with the codes and statuses its own helper gave', () => {
  for (const [file, [input, codes, otherwise = 400]] of Object.entries(reasonFirst)) {
    const {factory, type, refuse} = binding(file);
    assert.deepEqual([factory, type], ['familyErrors', 'ReasonFirstRefusal'], file);
    assert.deepEqual(probe(refuse, ['Reason.']).slice(0, 2), [input, 400], file);
    for (const [code, status] of Object.entries(codes))
      assert.deepEqual(probe(refuse, ['Reason.', code]).slice(0, 2), [code, status], file + ' ' + code);
    assert.deepEqual(probe(refuse, ['Reason.', 'UNNAMED_CODE']).slice(0, 2), ['UNNAMED_CODE', otherwise], file);
  }
  for (const [file, [input, state]] of Object.entries(stateFlagged)) {
    const {factory, type, refuse} = binding(file);
    assert.deepEqual([factory, type], ['familyStateErrors', 'StateFlaggedRefusal'], file);
    assert.deepEqual(probe(refuse, ['Reason.']).slice(0, 2), [input, 400], file);
    assert.deepEqual(probe(refuse, ['Reason.', true]).slice(0, 2), [state, 502], file);
  }
  for (const [file, [code, status]] of Object.entries(oneCode)) {
    const {factory, type, refuse} = binding(file);
    assert.deepEqual([factory, type], ['familyCodeError', 'OneCodeRefusal'], file);
    assert.deepEqual(probe(refuse, ['Reason.', {at: 'x'}]), [code, status, {at: 'x'}, 'Reason.'], file);
  }
  for (const [file, status] of Object.entries(ownStatus)) {
    const {factory, type, refuse} = binding(file);
    assert.deepEqual([factory, type], ['failWithStatus', 'StatusRefusal'], file);
    assert.deepEqual(probe(refuse, ['SOME_CODE', 'Reason.']).slice(0, 2), ['SOME_CODE', status], file);
  }
  for (const file of [...kitFail, ...reexported]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /^(?:export )?(?:function fail\(|const fail\b)/m, file);
    assert.match(source, /^import \{fail\} from '\.\/family-kit\.js';$/m, file);
    if (reexported.includes(file)) assert.match(source, /^export \{fail\};$/m, file);
  }
  const all = [
    ...Object.keys(reasonFirst),
    ...Object.keys(stateFlagged),
    ...Object.keys(oneCode),
    ...Object.keys(ownStatus),
    ...kitFail,
    ...reexported,
  ];
  assert.equal(new Set(all).size, 58);
});

test('the shared refusal helpers keep their names: write-common, personal-data and x-catalogs re-export the kit fail', async () => {
  for (const module of ['write-common', 'personal-data', 'x-catalogs'])
    assert.equal((await import('../dist/src/' + module + '.js')).fail, fail, module);
});

test('the localization check owns a kit-built refusal reason as it owned the local helper, and nothing outside the kit', () => {
  const owned = (source, file = 'src/x-example.ts') => [...inspectBackendWrapperFailures(source, file)].sort();
  const header =
    "import {familyErrors, failWithStatus, type ReasonFirstRefusal, type StatusRefusal} from './family-kit.js';";
  assert.deepEqual(
    owned(
      header +
        "const fail: ReasonFirstRefusal = familyErrors('INVALID_X');" +
        'const deny: StatusRefusal = failWithStatus(403);' +
        "function invalid(message: string): never { return fail(message, 'INVALID_Y'); }" +
        "fail('Owned reason.');fail('Owned with a code.', 'X_STATE_UNVERIFIED');deny('CODE', 'Denied reason.');" +
        "invalid('Forwarded reason.');",
    ),
    ['Denied reason.', 'Forwarded reason.', 'Owned reason.', 'Owned with a code.'],
  );
  // Shadowed, a let binding, a factory from another module, a type-only import and a factory called inline own nothing.
  assert.deepEqual(
    owned(header + "const fail: ReasonFirstRefusal = familyErrors('X');function f(fail: any) { fail('Shadowed.'); }"),
    [],
  );
  assert.deepEqual(owned(header + "let fail = familyErrors('X');fail('Not a const.');"), []);
  assert.deepEqual(
    owned("import {familyErrors} from './other.js';const fail = familyErrors('X');fail('Elsewhere.');"),
    [],
  );
  assert.deepEqual(
    owned("import {type familyErrors} from './family-kit.js';const fail = familyErrors('X');fail('Type only.');"),
    [],
  );
  assert.deepEqual(owned(header + "familyErrors('X')('Inline.');"), []);
  // A module whose reasons were never in the inventory keeps them out of it.
  assert.deepEqual(
    owned(header + "const fail: ReasonFirstRefusal = familyErrors('X');fail('Unlocalized.');", 'src/media-upload.ts'),
    [],
  );
});

test('the modules outside the localization inventory only shrink: each exists, refuses through the kit, and none is new', () => {
  // The modules whose helper the inventory never followed (an arrow function, or a forwarder to another module's).
  const beforeTheKit = new Set([
    'src/ad-previews.ts',
    'src/google-bid-modifiers.ts',
    'src/google-bidding-events.ts',
    'src/google-campaign-bid-modifiers.ts',
    'src/google-conversion-actions.ts',
    'src/google-conversion-goals.ts',
    'src/google-custom-segments.ts',
    'src/google-portfolio-strategies.ts',
    'src/linkedin-audience-templates.ts',
    'src/linkedin-conversion-links.ts',
    'src/linkedin-conversion-rules.ts',
    'src/linkedin-posts.ts',
    'src/measurement-writes.ts',
    'src/media-upload.ts',
    'src/meta-existing-posts.ts',
    'src/microsoft-associations.ts',
    'src/search-exclusion-plan.ts',
    'src/x-draft-writes.ts',
    'src/x-targeting-batch.ts',
  ]);
  for (const file of unlocalizedRefusalModules) {
    assert.ok(beforeTheKit.has(file), file + ' was inside the inventory before the kit; translate its reasons instead');
    assert.match(fs.readFileSync(file, 'utf8'), /^import \{[^}]*\} from '\.\/family-kit\.js';$/m, file);
  }
});
