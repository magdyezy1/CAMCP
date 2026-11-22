// always-run: reads every code literal of src/ and server/ against the remedy tables
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorError, errorRemedy, errorResult} from '../dist/src/errors.js';
import {providerById} from '../dist/src/provider-adapters.js';
import {
  providerRemedies,
  providerRemedy,
  providerRemedyTables,
  remedyNamesCode,
} from '../dist/src/provider-remedies.js';
import {providerRemedyModules} from '../tools/check-locales.mjs';

// ARC-04 stage C: errorRemedy (src/errors.ts) was one function of 867 lines whose provider rules sat among the shared
// ones, so every provider's remedy was an edit of the shared chain. Each provider now declares the remedies of its own
// refusals in its table (src/<provider>-remedies.ts, registered in src/provider-remedies.ts), and errorRemedy consults
// the tables before its shared rules. These tests hold what makes that order safe: no two providers answer one code,
// no rule of a table is hidden by an earlier one, no table answers a code a shared rule names, and every declared code
// is one AMCP raises.

/** Two code lists that name a common code: exactly, or through a prefix written with a trailing `*`. */
function overlap(a, b) {
  return a.some(x =>
    b.some(y => {
      const px = x.endsWith('*') ? x.slice(0, -1) : null,
        py = y.endsWith('*') ? y.slice(0, -1) : null;
      if (px !== null && py !== null) return px.startsWith(py) || py.startsWith(px);
      if (px !== null) return y.startsWith(px);
      if (py !== null) return x.startsWith(py);
      return x === y;
    }),
  );
}
/** Every code literal of the backend's own modules (src/ and server/), the remedy tables and src/errors.ts aside. */
function raisedCodes() {
  const raised = new Set();
  for (const dir of ['src', 'server'])
    for (const name of fs.readdirSync(dir))
      if (name.endsWith('.ts') && !name.endsWith('-remedies.ts') && name !== 'errors.ts')
        for (const m of fs.readFileSync(dir + '/' + name, 'utf8').matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g))
          raised.add(m[1]);
  return raised;
}
/** A code a rule's name stands for: the name itself, or a code under its prefix. */
const sample = name => (name.endsWith('*') ? name.slice(0, -1) + 'SYNTHETIC_CASE' : name);

test('each table is registered under its provider’s ID, and the locale inventory reads the registry’s modules', () => {
  assert.ok(Object.keys(providerRemedyTables).length >= 9);
  for (const [id, table] of Object.entries(providerRemedyTables)) {
    assert.ok(providerById(id), id + ' is a provider of src/provider-adapters.ts');
    assert.ok(table.length > 0, id);
  }
  const imported = [
    ...fs.readFileSync('src/provider-remedies.ts', 'utf8').matchAll(/from '\.\/([a-z-]+-remedies)\.js'/g),
  ].map(m => 'src/' + m[1] + '.ts');
  assert.deepEqual(imported.sort(), [...providerRemedyModules].sort());
  // Every rule names a code, and a remedy of the shape errorRemedy returns.
  for (const rule of providerRemedies) {
    assert.ok(rule.codes.length > 0);
    for (const name of rule.codes) assert.match(name, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:_\*)?$/, name);
    assert.deepEqual(Object.keys(rule.remedy), ['category', 'owner', 'action', 'mutation_retry_safe']);
    assert.ok(Object.isFrozen(rule) && Object.isFrozen(rule.codes) && Object.isFrozen(rule.remedy));
  }
});

test('no two providers answer one code, and no rule of a table is hidden by an earlier one', () => {
  const tables = Object.entries(providerRemedyTables);
  for (const [a, first] of tables)
    for (const [b, second] of tables)
      if (a < b)
        for (const x of first)
          for (const y of second)
            assert.ok(!overlap(x.codes, y.codes), a + ' ' + x.codes + ' and ' + b + ' ' + y.codes);
  for (const [id, table] of tables)
    table.forEach((rule, i) => {
      for (const earlier of table.slice(0, i).filter(r => !r.when))
        for (const name of rule.codes)
          assert.ok(
            name.endsWith('*')
              ? !earlier.codes.some(e => e.endsWith('*') && name.startsWith(e.slice(0, -1)))
              : !remedyNamesCode(earlier.codes, name),
            id + ': ' + name + ' is answered by an earlier rule first',
          );
    });
});

test('no provider rule answers a code that one of errorRemedy’s shared rules names', () => {
  const source = fs.readFileSync('src/errors.ts', 'utf8'),
    shared = source.slice(source.indexOf('function workflowRemedy'), source.indexOf('export function preciseMessage'));
  assert.ok(shared.includes('function reviewRemedy') && shared.includes('function workspaceRemedy'));
  // Codes the rules compare with, and the keys of their lookup tables (acknowledgements, state reads).
  const named = new Set(
    [...shared.matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'|\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/g)].map(
      m => m[1] ?? m[2],
    ),
  );
  assert.ok(named.has('STATE_NOT_FOUND') && named.has('CAP_CONFIRMATION_REQUIRED') && named.has('MEDIA_CHANGED'));
  assert.ok(named.size > 100, 'the shared rules name ' + named.size + ' codes');
  for (const rule of providerRemedies)
    for (const code of named) assert.ok(!remedyNamesCode(rule.codes, code), code + ' is named by ' + rule.codes);
});

test('every code a provider declares is raised by AMCP, and each prefix covers one that is', () => {
  const raised = [...raisedCodes()];
  for (const rule of providerRemedies)
    for (const name of rule.codes)
      assert.ok(
        name.endsWith('*') ? raised.some(code => code.startsWith(name.slice(0, -1))) : raised.includes(name),
        name + ' is raised nowhere',
      );
});

// Details that satisfy a rule narrowed by `when`: Meta's rule reads `fields`; TikTok's page-count rule (r25-hotfix) reads
// `page_facts.rule`; Snapchat's four rules (r12-fix item 3) each read one timestamp of `timestamp_field`, and X's (r12-fix
// item 3) reads `parent_kind`; TikTok's rule for a rejected parameter refusal (r25-m2-refusal) reads `submission` and `http_status`;
// Google's two product tree rules for a refusal from a build (r25-m3-trees, item 9) read the `field` path, which a build spells from
// `mutate_operations`, and its two rules for a chain of temporary names, over a build's limit and over a tree review's (r25-m3-trees,
// round 2, S3-4), read `limit`.
// TikTok's rule for a Smart+ ad create or edit that breaks several rules (r25-field-tiktok #6, round 2) reads `violations`.
// TikTok's rule for a Smart+ ad edit whose ad_configuration_patch AMCP merged (r25-m4-smartedits) reads `fix` and `field`.
// A rule none of them satisfies fails the test below, so a new `when` names its sample here.
const whenSamples = [
  {field: 'mutate_operations[7].asset_group_listing_group_filter_operation.create.type'},
  {limit: 1000},
  {limit: 500},
  {fields: ['is_adset_budget_sharing_enabled']},
  {page_facts: {rule: 'page_not_echoed'}},
  {timestamp_field: 'finalized_data_end_time'},
  {timestamp_field: 'conversion_data_processed_end_time'},
  {timestamp_field: 'start_time'},
  {timestamp_field: 'end_time'},
  {parent_kind: 'campaign'},
  {submission: 'rejected', http_status: 200},
  {
    violations: [
      {field: 'operation_status', message: 'Synthetic one.'},
      {field: 'ad_name', message: 'Synthetic two.'},
    ],
  },
  {field: 'ad_configuration_patch', fix: [{path: '/ad_configuration', value: {}}]},
];

test('errorRemedy answers a provider’s refusal with the remedy it declares, before any shared rule, as a copy', () => {
  for (const rule of providerRemedies)
    for (const name of rule.codes) {
      const code = sample(name),
        details = rule.when ? whenSamples.find(candidate => rule.when(candidate)) : {};
      assert.ok(details, name + ' is narrowed by a `when` that no sample of details satisfies');
      const declared = providerRemedy(code, details);
      assert.ok(declared, code);
      assert.deepEqual(errorRemedy(new MirrorError(code, 'Synthetic.', details)), declared, code);
      // A refusal raised from the provider's reply carries it as details.upstream: the declared remedy still answers.
      assert.deepEqual(errorRemedy(new MirrorError(code, 'Synthetic.', {...details, upstream: {}})), declared, code);
      assert.equal(errorResult(new MirrorError(code, 'Synthetic.', details), 'r', 0).error.category, declared.category);
    }
  // A rule narrowed by the details answers only those details; otherwise the shared rules do.
  assert.match(
    errorRemedy(new MirrorError('INVALID_META_CAMPAIGN', 'Synthetic.', {fields: ['name']})).action,
    /^Correct the argument the message names/,
  );
  assert.equal(providerRemedy('INVALID_META_CAMPAIGN', {}), undefined);
  // TikTok's parameter remedy answers a refusal rejected from an HTTP 200 answer, and no other PLATFORM_ERROR (r25-m2-refusal).
  assert.match(
    providerRemedy('PLATFORM_ERROR', {submission: 'rejected', http_status: 200}).action,
    /^TikTok refused a parameter of this request and applied nothing/,
  );
  for (const details of [
    {},
    {http_status: 200},
    {submission: 'rejected'},
    {submission: 'rejected', http_status: 400},
    {submission: 'uncertain', http_status: 200},
  ])
    assert.equal(providerRemedy('PLATFORM_ERROR', details), undefined, JSON.stringify(details));
  // TikTok's remedy for a Smart+ ad create or edit that breaks several rules answers a refusal that lists more than one violation,
  // and no other refusal of the code: one rule keeps the shared remedy of its code (r25-field-tiktok #6, round 2).
  const two = [
      {field: 'operation_status', message: 'Synthetic one.'},
      {field: 'ad_name', message: 'Synthetic two.'},
    ],
    several = providerRemedy('INVALID_TIKTOK_SMART_PLUS_AD', {violations: two});
  assert.match(several.action, /^This request breaks more than one rule, and the message states the first\./);
  assert.deepEqual([several.category, several.owner, several.mutation_retry_safe], ['request', 'operator', false]);
  for (const details of [{}, {field: 'ad_name'}, {violations: []}, {violations: two.slice(0, 1)}, {violations: 'two'}])
    assert.equal(providerRemedy('INVALID_TIKTOK_SMART_PLUS_AD', details), undefined, JSON.stringify(details));
  assert.match(
    errorRemedy(new MirrorError('INVALID_TIKTOK_SMART_PLUS_AD', 'Synthetic.', {field: 'ad_name'})).action,
    /^Correct the argument the message names/,
  );
  // TikTok's remedy for a Smart+ ad edit whose ad_configuration_patch AMCP merged answers a refusal that carries details.fix for that patch,
  // and no other refusal of the code (r25-m4-smartedits): one that merely names the patch, or carries a fix for another field, keeps the
  // shared remedy of its code, and a patch that breaks several rules keeps the remedy of several.
  const handedBack = providerRemedy('INVALID_TIKTOK_SMART_PLUS_AD', {
    field: 'ad_configuration_patch',
    fix: [{path: '/ad_configuration', value: {}}],
  });
  assert.match(handedBack.action, /^Nothing was sent\. AMCP merged the change into the ad’s current settings/);
  assert.deepEqual(
    [handedBack.category, handedBack.owner, handedBack.mutation_retry_safe],
    ['request', 'operator', false],
  );
  for (const details of [
    {field: 'ad_configuration_patch'},
    {fix: [{path: '/ad_configuration', value: {}}]},
    {field: 'ad_name', fix: [{path: '/ad_configuration', value: {}}]},
    {field: 'ad_configuration_patch', fix: 'merged'},
  ])
    assert.equal(providerRemedy('INVALID_TIKTOK_SMART_PLUS_AD', details), undefined, JSON.stringify(details));
  assert.match(
    providerRemedy('INVALID_TIKTOK_SMART_PLUS_AD', {field: 'ad_configuration_patch', violations: two}).action,
    /^This request breaks more than one rule/,
  );
  // Within a table an exact code comes before its prefix: X's limit and TikTok's pending task have their own remedies.
  assert.match(providerRemedy('X_TARGETING_LIMIT', {}).action, /^Narrow the explicitly reviewed operation/);
  assert.match(providerRemedy('X_TARGETING_OTHER', {}).action, /^Inspect the exact targeting input/);
  assert.match(providerRemedy('TIKTOK_REPORT_PENDING', {}).action, /^Poll the same task later/);
  assert.equal(providerRemedy('META_CREATIVE_IDENTITY_REQUIRED', {}).category, 'grant');
  assert.equal(providerRemedy('META_CREATIVE_UNAVAILABLE', {}).category, 'provider');
  // Codes no provider declares are the shared rules'.
  assert.equal(providerRemedy('STATE_CHANGED', {}), undefined);
  assert.equal(providerRemedy('INTERNAL_ERROR', {}), undefined);
  // The answer is a copy: changing it changes neither the table nor the next answer.
  const answer = errorRemedy(new MirrorError('PRODUCT_SET_EMPTY', 'Synthetic.'));
  answer.action = 'Changed.';
  assert.notEqual(errorRemedy(new MirrorError('PRODUCT_SET_EMPTY', 'Synthetic.')).action, 'Changed.');
});
