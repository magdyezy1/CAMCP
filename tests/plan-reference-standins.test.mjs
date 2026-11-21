import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {campaignPreflight} from '../dist/src/campaign-preflight.js';
import {stepSpendEffects} from '../dist/src/campaign-spend-effects.js';
import {MirrorError} from '../dist/src/errors.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';

/**
 * Package r25-field3-refs, item 1 (AMCP-01): one stand-in for each result a step references. The leaf `src/plan-reference-standins.ts` gives each
 * distinct `<step>#<pointer>` of one step an ordinal (1, 2, 3, ... in first-seen order), the plan's preflight and the approval's spend effects
 * both ask it for the step's stand-in request, and a provider's hook varies only the number. The behaviour of the preflight is in
 * tests/plan-reference-preflight.test.mjs; this file is the unit of the leaf and of the hooks.
 */
// Loaded by each test that needs it, so that a test shows its own result while the leaf is missing.
const load = () => import('../dist/src/plan-reference-standins.js');
const ref = (step, pointer, extra = {}) => ({$ref: step + '#' + pointer, ...extra});
const step = (id, depends_on, args = {}, gateway = 'meta_native_action') => ({
  id,
  kind: 'write',
  gateway,
  account_id: '123',
  arguments: args,
  depends_on,
});
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('the ordinal of a reference is the order its <step>#<pointer> is first met, arrays by index and objects in key order', async () => {
  const leaf = await load();
  const args = {
    a: ref('x', '/data/id'),
    list: [ref('y', '/data/id'), {deep: ref('x', '/data/other')}, ref('x', '/data/id')],
    z: ref('y', '/data/id'),
    // The prefix is how the value is spelled, not which result it is.
    p: ref('x', '/data/id', {prefix: 'urn:li:sponsoredCampaign:'}),
  };
  assert.deepEqual(
    [...leaf.referenceOrdinals(args)],
    [
      ['x#/data/id', 1],
      ['y#/data/id', 2],
      ['x#/data/other', 3],
    ],
  );
  // The same arguments give the same ordinals however many times they are asked, and another step starts from 1 again.
  assert.deepEqual([...leaf.referenceOrdinals(structuredClone(args))], [...leaf.referenceOrdinals(args)]);
  assert.deepEqual([...leaf.referenceOrdinals({only: ref('other', '/data/id')})], [['other#/data/id', 1]]);
  assert.deepEqual([...leaf.referenceOrdinals({nothing: 'here', list: [1, 2, {a: null}]})], []);
});

test('R6: the same <step>#<pointer> is the same stand-in and a different one is a different stand-in', async () => {
  const leaf = await load();
  const asked = [],
    context = reference => ({
      step: step('child', ['x', 'y']),
      steps: [step('x', []), step('y', []), step('child', ['x', 'y'])],
      reference,
      compile: () => assert.fail('no compile'),
    });
  const out = leaf.standInArguments(
    context(({path, ref: pointer, parent, ordinal}) => {
      asked.push([path, pointer, parent.id, ordinal]);
      return 'S' + ordinal;
    }),
    {
      first: ref('x', '/data/id'),
      list: [ref('y', '/data/id'), ref('x', '/data/id')],
      generic: ref('y', '/data/other'),
    },
  );
  assert.deepEqual(out.arguments, {first: 'S1', list: ['S2', 'S1'], generic: 'S3'});
  assert.deepEqual(out.paths, ['/first', '/list/0', '/list/1', '/generic']);
  assert.deepEqual(asked, [
    ['/first', 'x#/data/id', 'x', 1],
    ['/list/0', 'y#/data/id', 'y', 2],
    ['/list/1', 'x#/data/id', 'x', 1],
    ['/generic', 'y#/data/other', 'y', 3],
  ]);
  // A hook that places nothing leaves the generic number; a prefix keeps its URN shape and the same number.
  const plain = leaf.standInArguments(
    context(() => undefined),
    {
      a: ref('x', '/data/id'),
      b: ref('y', '/data/id'),
      c: ref('x', '/data/id', {prefix: 'urn:li:sponsoredCampaign:'}),
      d: [ref('y', '/data/id', {prefix: 'urn:li:sponsoredCampaignGroup:'})],
    },
  );
  assert.deepEqual(plain.arguments, {
    a: '1',
    b: '2',
    c: 'urn:li:sponsoredCampaign:1',
    d: ['urn:li:sponsoredCampaignGroup:2'],
  });
  // No hook at all is the generic number too, and the arguments themselves are never changed.
  const original = {a: ref('x', '/data/id')};
  assert.deepEqual(leaf.standInArguments(context(undefined), original).arguments, {a: '1'});
  assert.deepEqual(original, {a: ref('x', '/data/id')});
});

test('a reference that does not name a declared predecessor is refused INVALID_REFERENCE', async () => {
  const leaf = await load();
  const context = {
    step: step('child', ['x']),
    steps: [step('x', []), step('y', []), step('child', ['x'])],
    compile: () => assert.fail('no compile'),
  };
  for (const bad of [ref('y', '/data/id'), {$ref: 'no-pointer'}, ref('child', '/data/id')])
    assert.throws(
      () => leaf.standInArguments(context, {a: bad}),
      e => e instanceof MirrorError && e.code === 'INVALID_REFERENCE',
    );
});

test('the plan preflight and the approval’s spend effects judge byte-identical stand-in requests', async () => {
  const f = googleReconcileFixture({tenant: 'plan-reference-standins'});
  try {
    const link = 'google_ads_v23_asset_group_asset_mutate_asset_group_assets',
      steps = [
        {
          id: 'en_texts',
          kind: 'write',
          gateway: 'google_ads_native_action',
          connection_id: 'g',
          account_id: '123',
          arguments: {
            action: 'google_ads_v23_asset_mutate_assets',
            payload: {operations: [0, 1, 2].map(i => ({create: {text_asset: {text: 'Synthetic headline ' + i}}}))},
          },
          depends_on: [],
        },
        {
          id: 'en_text_links',
          kind: 'write',
          gateway: 'google_ads_native_action',
          connection_id: 'g',
          account_id: '123',
          arguments: {
            action: link,
            payload: {
              operations: [2, 0, 1, 0].map(i => ({
                create: {
                  asset_group: at('assetGroups', '77'),
                  field_type: i === 0 ? 'DESCRIPTION' : 'HEADLINE',
                  asset: {$ref: 'en_texts#/data/results/' + i + '/resourceName'},
                },
              })),
            },
          },
          depends_on: ['en_texts'],
        },
      ];
    // What each compiles of the link step: the arguments the compiler is given.
    const compiled = [],
      original = f.service.compiler.compile.bind(f.service.compiler);
    f.service.compiler.compile = (gateway, args, options) => {
      if (args.action === link) compiled.push(JSON.stringify(args));
      return original(gateway, args, options);
    };
    compiled.length = 0;
    await campaignPreflight(f.service, f.actor, steps);
    const byPreflight = [...compiled];
    compiled.length = 0;
    stepSpendEffects(f.service, steps);
    const bySpendEffects = [...compiled];
    assert.ok(byPreflight.length >= 1 && bySpendEffects.length >= 1, 'both compile the link step');
    assert.equal(bySpendEffects[0], byPreflight[0], 'the same request, byte for byte');
    // Three results, four links: the stand-ins are three different resources, and the repeat of the third (result 0) is the same one.
    const assets = JSON.parse(byPreflight[0]).payload.operations.map(op => op.create.asset);
    assert.equal(new Set(assets).size, 3);
    assert.equal(assets[1], assets[3]);
  } finally {
    f.close();
  }
});

test('each provider’s hook varies only the number it is given', () => {
  const hook = gateway => providerHooks(gateway)?.campaign?.preflight?.reference,
    none = () => assert.fail('no compile');
  // X: its media key and card URI by their own shapes, any other reference is the generic number.
  for (const n of [1, 2, 17]) {
    assert.equal(hook('x_ads_native_action')({path: '/payload/media_key', ordinal: n, compile: none}), '13_' + n);
    assert.equal(hook('x_ads_native_action')({path: '/payload/card_uri', ordinal: n, compile: none}), 'card://' + n);
  }
  assert.equal(hook('x_ads_native_action')({path: '/payload/line_item_id', ordinal: 2, compile: none}), undefined);
  // Snapchat: a UUID whose last twelve hex digits are the number.
  assert.equal(
    hook('snapchat_native_action')({path: '/payload/x', ordinal: 1, compile: none}),
    '00000000-0000-4000-8000-000000000001',
  );
  assert.equal(
    hook('snapchat_native_action')({path: '/payload/x', ordinal: 2, compile: none}),
    '00000000-0000-4000-8000-000000000002',
  );
  assert.equal(
    hook('snapchat_native_action')({path: '/payload/x', ordinal: 255, compile: none}),
    '00000000-0000-4000-8000-0000000000ff',
  );
  // Google: a media predecessor is an account asset, a service create is the collection's resource, an update is its own named resource.
  assert.equal(
    hook('google_ads_native_action')({
      path: '/payload/x',
      ref: 'm#/media_id',
      ordinal: 3,
      parent: {kind: 'media', account_id: '123-456-7890', arguments: {platform: 'google_ads'}},
      compile: none,
    }),
    'customers/1234567890/assets/3',
  );
  const service = (n, operations) =>
    hook('google_ads_native_action')({
      path: '/payload/x',
      ref: 'c#/data/results/0/resourceName',
      ordinal: n,
      parent: {gateway: 'google_ads_native_action', account_id: '123', arguments: {action: 'a'}},
      compile: () => ({path: '/v25/customers/123/campaigns:mutate', body: {operations}}),
    });
  assert.equal(service(1, [{create: {name: 'C'}}]), 'customers/123/campaigns/1');
  assert.equal(service(4, [{create: {name: 'C'}}]), 'customers/123/campaigns/4');
  assert.equal(
    service(9, [{update: {resource_name: 'customers/123/campaigns/55', name: 'N'}, update_mask: 'name'}]),
    'customers/123/campaigns/55',
  );
  assert.equal(service(9, [{remove: 'customers/123/campaigns/56'}]), 'customers/123/campaigns/56');
});

test('the leaf names no provider and imports no provider module', () => {
  const source = read('src/plan-reference-standins.ts');
  assert.deepEqual(
    [...source.matchAll(/['"]([a-z0-9_]+_native_action)['"]/g)].map(m => m[1]),
    [],
  );
  const imported = [...source.matchAll(/^import (?!type )[^;]*? from '\.\/([^']+)\.js';/gms)].map(
    m => 'src/' + m[1] + '.ts',
  );
  assert.deepEqual(
    imported.filter(file => isProviderModule(file) && !providerRegistries.includes(file)),
    [],
  );
  // The two callers use it, and neither keeps a stand-in walk of its own.
  assert.match(read('src/campaign-preflight.ts'), /standInArguments/);
  assert.match(read('src/campaign-spend-effects.ts'), /standInArguments/);
  assert.doesNotMatch(read('src/campaign-preflight.ts'), /prefix \+ '1'/);
  assert.doesNotMatch(read('src/campaign-spend-effects.ts'), /prefix \+ '1'/);
});
