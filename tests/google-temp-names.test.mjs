// R2.5 M3 (r25-m3-trees, L2-06 and G4c): the two temporary-name grammars of a Google mutate request, and what follows from
// them. Operations linked by a temporary name travel in one request and are never cut into parts (a part would name a
// resource another part creates); a chain longer than its route takes is refused with TEMP_ID_CHAIN_TOO_LONG, whose message
// never carries the splitter's own trigger. Everything is synthetic: nothing reaches Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {
  assertChainWithin,
  chainLimits,
  containsTempName,
  formatTempName,
  fromStandIn,
  parseTempName,
  standIn,
} from '../dist/src/google-temp-names.js';
import * as tempNameModule from '../dist/src/google-temp-names.js';
import {groupLimitRefusal, groupParts, needsGroup, splittableBatch} from '../dist/src/write-groups.js';
import {googleAdsHooks} from '../dist/src/google-ads-adapter.js';
import {assertGoogleListingGroups} from '../dist/src/google-listing-groups.js';
import {assertGoogleShoppingTree} from '../dist/src/google-shopping-tree.js';
import {assertGoogleAtomicBuild} from '../dist/src/google-atomic-builds.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const google = 'google_ads_native_action';
const plan = (path, body, action = 'google_ads_v23_synthetic') => ({
  gateway: google,
  action,
  method: 'POST',
  path,
  query: {},
  headers: {},
  body,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  accountId: '123',
  evidence: '',
  warnings: [],
});
const customer = name => 'customers/123/' + name;

test('both temporary-name grammars parse, and a stand-in round-trips', () => {
  assert.deepEqual(parseTempName(customer('campaigns/-2')), {customer: '123', collection: 'campaigns', number: '2'});
  assert.deepEqual(parseTempName(customer('adGroupCriteria/-3~-4')), {
    customer: '123',
    collection: 'adGroupCriteria',
    number: '4',
    parent: {id: '3', temporary: true},
  });
  assert.deepEqual(parseTempName(customer('assetGroupListingGroupFilters/700~-8')), {
    customer: '123',
    collection: 'assetGroupListingGroupFilters',
    number: '8',
    parent: {id: '700', temporary: false},
  });
  // Not temporary names: an existing resource, a composite name of a collection that has none, an ID that is not an ID.
  for (const not of [
    customer('campaigns/5'),
    customer('adGroupCriteria/55~901'),
    customer('adGroupCriteria/-3~4'),
    customer('adGroupCriteria/0~-4'),
    customer('campaignCriteria/-3~-4'),
    customer('adGroupCriteria/~-4'),
    customer('adGroupCriteria/-3~-4/extra'),
    'campaigns/-1',
    7,
    undefined,
    null,
  ])
    assert.equal(parseTempName(not), undefined, String(not));
  for (const name of [
    customer('campaigns/-2'),
    customer('adGroupCriteria/-3~-4'),
    customer('adGroupCriteria/55~-4'),
    customer('assetGroupListingGroupFilters/-7~-8'),
  ]) {
    assert.equal(formatTempName(parseTempName(name)), name);
    const real = standIn(name);
    assert.notEqual(real, name);
    assert.equal(parseTempName(real), undefined, 'a stand-in is a positive-ID name: ' + real);
    assert.equal(fromStandIn(real), name, real);
  }
  assert.equal(standIn(customer('adGroupCriteria/-3~-4')), customer('adGroupCriteria/9000000000003~9000000000004'));
  assert.equal(standIn(customer('adGroupCriteria/55~-4')), customer('adGroupCriteria/55~9000000000004'));
  // Any other string is left alone, both ways.
  for (const other of [customer('campaigns/5'), customer('adGroupCriteria/55~901'), 'not a name'])
    (assert.equal(standIn(other), other), assert.equal(fromStandIn(other), other));
});

test('containsTempName finds either form anywhere in a request, and nothing in a request without one', () => {
  assert.equal(containsTempName([{create: {resource_name: customer('campaigns/-1')}}]), true);
  assert.equal(containsTempName([{create: {resource_name: customer('adGroupCriteria/-3~-4')}}]), true);
  assert.equal(containsTempName([{create: {resource_name: customer('adGroupCriteria/55~-4')}}]), true);
  assert.equal(
    containsTempName([{create: {listing_group: {parent_ad_group_criterion: customer('adGroupCriteria/55~-4')}}}]),
    true,
    'a name inside a nested field',
  );
  assert.equal(containsTempName([{create: {ad_group: customer('adGroups/-3')}}]), true, 'a reference, not a creation');
  assert.equal(containsTempName([{create: {note: 'see ' + customer('campaigns/-1')}}]), true, 'fails closed on text');
  assert.equal(containsTempName([{remove: customer('adGroupCriteria/55~901')}]), false);
  assert.equal(containsTempName([{create: {name: 'k1', keyword: {text: 'a-1', match_type: 'EXACT'}}}]), false);
  assert.equal(containsTempName([{update: {resource_name: customer('campaigns/5'), name: '-1'}}]), false);
});

test('a list with a temporary name of either form is never split; plain operations still are', () => {
  const plain = Array.from({length: 30}, (_, i) => ({create: {name: 'k' + i}}));
  assert.equal(needsGroup(google, {payload: {operations: plain}}), true);
  assert.equal(splittableBatch(google, {payload: {operations: plain}}).items.length, 30);
  for (const [label, name] of [
    ['simple', customer('campaigns/-1')],
    ['composite, temporary parent', customer('adGroupCriteria/-3~-4')],
    ['composite, existing parent', customer('adGroupCriteria/55~-4')],
    ['composite listing group filter', customer('assetGroupListingGroupFilters/700~-1')],
  ]) {
    const linked = [{create: {resource_name: name}}, ...plain];
    assert.equal(splittableBatch(google, {payload: {operations: linked}}), undefined, label);
    assert.equal(needsGroup(google, {payload: {operations: linked}}), false, label);
    const args = {action: 'x', payload: {operations: linked}};
    assert.deepEqual(groupParts(google, args), [args], label + ': the request stays whole');
  }
  // A temporary name in a reference of the last operation links the list as well.
  const reference = [...plain, {create: {ad_group: customer('adGroups/-3')}}];
  assert.equal(splittableBatch(google, {payload: {operations: reference}}), undefined);
  // An existing node's real name is no temporary name.
  const existing = [{remove: customer('adGroupCriteria/55~901')}, ...plain];
  assert.equal(splittableBatch(google, {payload: {operations: existing}}).items.length, 31);
});

/** A small seeded generator, so a failure names the seed that found it. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const tempNames = value => {
  const found = new Set(),
    walk = v => {
      if (typeof v === 'string')
        for (const m of v.matchAll(/customers\/123\/[A-Za-z]+\/(?:-\d+|\d+~-\d+|-\d+~-\d+)/g)) found.add(m[0]);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
  walk(value);
  return found;
};

test('property: a list of 1 to 120 operations is returned whole whenever a temporary name is present, and no part names one another part creates', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const next = random(seed),
      pick = n => Math.floor(next() * n),
      count = 1 + pick(120),
      linked = next() < 0.6,
      operations = Array.from({length: count}, (_, i) => {
        const kind = linked ? pick(7) : pick(2);
        switch (kind) {
          case 0:
            return {create: {name: 'k' + i}};
          case 1:
            return {remove: customer('adGroupCriteria/55~' + (900 + i))};
          case 2:
            return {create: {resource_name: customer('campaigns/-' + (i + 1)), name: 'c' + i}};
          case 3:
            return {
              create: {resource_name: customer('adGroupCriteria/-3~-' + (i + 1)), ad_group: customer('adGroups/-3')},
            };
          case 4:
            return {
              create: {resource_name: customer('adGroupCriteria/55~-' + (i + 1)), ad_group: customer('adGroups/55')},
            };
          case 5:
            return {
              create: {
                listing_group: {parent_ad_group_criterion: customer('adGroupCriteria/-3~-' + (1 + pick(count)))},
              },
            };
          default:
            return {create: {ad_group: customer('adGroups/-' + (1 + pick(9)))}};
        }
      }),
      args = {action: 'x', payload: {operations}},
      anyTemp = operations.some(op => tempNames(op).size > 0),
      parts = groupParts(google, args);
    if (anyTemp) {
      assert.equal(parts.length, 1, 'seed ' + seed + ': a linked request stays whole');
      assert.deepEqual(parts[0], args, 'seed ' + seed);
    } else {
      assert.deepEqual(
        parts.flatMap(p => p.payload.operations),
        operations,
        'seed ' + seed + ': the parts hold every operation, in order',
      );
      assert.ok(
        parts.every(p => p.payload.operations.length <= 25),
        'seed ' + seed,
      );
    }
    // The plan's property (b): no part names a temporary name that another part creates.
    const creates = parts.map(p => new Set(p.payload.operations.map(op => op.create?.resource_name).filter(Boolean)));
    parts.forEach((p, i) => {
      for (const name of tempNames(p.payload.operations))
        creates.forEach((made, j) => {
          if (j !== i && made.has(name))
            assert.fail('seed ' + seed + ': part ' + i + ' names ' + name + ', which part ' + j + ' creates');
        });
    });
  }
});

test('end to end: a 30-operation chain named with ~-N is one refusal, not a group of parts, and sends nothing', async t => {
  const actor = {tenantId: 'temp-names', userId: 'operator', role: 'operator'},
    owner = {...actor, role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64')),
    calls = [];
  t.after(() => store.close());
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway: google,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      calls.push(new URL(String(url)).pathname + ' ' + String(init?.body).slice(0, 80));
      return Response.json({});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const prepare = operations =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: google,
        arguments: {
          action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
          account_id: '123',
          payload: {operations},
        },
      },
      actor,
    );
  // Keywords carry no temporary name in a real request; the point here is the route's limit and the splitter, which read
  // the names and not what they name.
  const keyword = i => ({
    create: {
      resource_name: customer('adGroupCriteria/55~-' + (i + 1)),
      ad_group: customer('adGroups/55'),
      keyword: {text: 'k' + i, match_type: 'EXACT'},
    },
  });
  const refused = await prepare(Array.from({length: 30}, (_, i) => keyword(i)));
  assertRefused(refused, 'TEMP_ID_CHAIN_TOO_LONG', {writes: calls.length, message: /at most 25/});
  assert.equal(refused.group, undefined, 'it is not turned into a group of parts of 25');
  assert.equal(calls.length, 0, 'not one provider request: ' + calls.join(' | '));
  assert.equal(refused.error.details.operations, 30);
  assert.equal(refused.error.details.limit, 25);
});

test('TEMP_ID_CHAIN_TOO_LONG: a chain over the limit of its route is refused on each route, and its message never triggers the splitter', () => {
  const link = i => ({
    create: {resource_name: customer('adGroupCriteria/-3~-' + (i + 1)), ad_group: customer('adGroups/-3')},
  });
  const chain = n => Array.from({length: n}, (_, i) => link(i));
  const plainList = n => Array.from({length: n}, (_, i) => ({create: {name: 'k' + i}}));
  const refusals = [];
  // 1. The generic one-service shape: 25.
  const shape = googleAdsHooks.checks.shape.after;
  const generic = (operations, action = 'google_ads_v23_asset_mutate_assets') =>
    shape(plan('/v25/customers/123/assets:mutate', {operations}, action), {operations}, () => {});
  assert.throws(
    () => generic(chain(26)),
    e => {
      refusals.push(e);
      return assertRefused(e, 'TEMP_ID_CHAIN_TOO_LONG', {message: /at most 25/});
    },
  );
  assert.deepEqual(refusals[0].details, {
    operations: 26,
    limit: 25,
    route: 'google_ads_v23_asset_mutate_assets',
    field: 'operations',
  });
  // Exactly the limit passes, and a plain list over it keeps the generic refusal the splitter reads.
  generic(chain(25));
  assert.throws(
    () => generic(plainList(26)),
    e => assertRefused(e, 'WRITE_CONTRACT_UNAVAILABLE', {message: /1–25/}),
  );
  // 2. The Performance Max tree family: 500.
  const treePlan = n =>
    plan(
      '/v25/customers/123/assetGroupListingGroupFilters:mutate',
      {
        operations: Array.from({length: n}, (_, i) => ({
          create: {
            resourceName: customer('assetGroupListingGroupFilters/700~-' + (i + 1)),
            assetGroup: customer('assetGroups/700'),
            type: 'UNIT_INCLUDED',
            listingSource: 'SHOPPING',
          },
        })),
      },
      'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters',
    );
  assert.throws(
    () => assertGoogleListingGroups(treePlan(501)),
    e => {
      refusals.push(e);
      return assertRefused(e, 'TEMP_ID_CHAIN_TOO_LONG', {message: /at most 500/});
    },
  );
  assert.deepEqual(refusals[1].details, {
    operations: 501,
    limit: 500,
    route: 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters',
    field: 'operations',
  });
  // 3. A build: 1,000.
  const buildPlan = n =>
    plan(
      '/v25/customers/123/googleAds:mutate',
      {
        mutate_operations: Array.from({length: n}, (_, i) => ({
          campaign_budget_operation: {
            create: {resource_name: customer('campaignBudgets/-' + (i + 1)), name: 'b' + i, amount_micros: '1000000'},
          },
        })),
      },
      'google_ads_v23_google_ads_mutate',
    );
  assert.throws(
    () =>
      assertGoogleAtomicBuild(
        buildPlan(1001),
        () => {},
        () => {},
      ),
    e => {
      refusals.push(e);
      return assertRefused(e, 'TEMP_ID_CHAIN_TOO_LONG', {message: /at most 1,000/});
    },
  );
  assert.deepEqual(refusals[2].details, {
    operations: 1001,
    limit: 1000,
    route: 'google_ads_v23_google_ads_mutate',
    field: 'mutate_operations',
  });
  // 4. The Standard Shopping tree review: 500, as the Performance Max one (a mutation of ad group criteria that creates a listing
  // group is this family's, and it is no raise of Google's 25 for independent operations: Q28, owner 2026-11-15).
  const shoppingPlan = n =>
    plan(
      '/v25/customers/123/adGroupCriteria:mutate',
      {
        operations: Array.from({length: n}, (_, i) => ({
          create: {
            resourceName: customer('adGroupCriteria/55~-' + (i + 1)),
            adGroup: customer('adGroups/55'),
            listingGroup: {type: 'UNIT'},
          },
        })),
      },
      'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
    );
  assert.throws(
    () => assertGoogleShoppingTree(shoppingPlan(501)),
    e => {
      refusals.push(e);
      return assertRefused(e, 'TEMP_ID_CHAIN_TOO_LONG', {message: /at most 500/});
    },
  );
  assert.deepEqual(refusals[3].details, {
    operations: 501,
    limit: 500,
    route: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
    field: 'operations',
  });
  // The shared helper: it refuses only a list over the limit that carries a temporary name.
  assertChainWithin(chain(chainLimits.tree), chainLimits.tree, 'route');
  assertChainWithin(plainList(chainLimits.tree + 1), chainLimits.tree, 'route');
  assert.throws(
    () => assertChainWithin(chain(chainLimits.tree + 1), chainLimits.tree, 'route'),
    e => assertRefused(e, 'TEMP_ID_CHAIN_TOO_LONG'),
  );
  for (const e of refusals) {
    assert.equal(
      groupLimitRefusal(e),
      false,
      'the splitter must not read this refusal as the 25-record limit: ' + e.message,
    );
    assert.match(e.message, /linked by temporary names/);
    assert.match(e.message, /never split/);
    assert.match(e.message, /google_ads_v23_google_ads_mutate|several builds/);
    // A plan is a way forward for another write and for a build (each step is a request of its own), not for a tree review: its tree
    // step is again a review of at most 500 operations, or a build, which the message names (R2.5 M3 round 3, N6).
    if (e.details.limit === chainLimits.tree)
      assert.doesNotMatch(e.message, /\$ref|plan/, 'a plan cannot cut a tree, so it is not offered');
    else assert.match(e.message, /\$ref/, 'names the plan way forward');
    assert.doesNotMatch(e.message, /1[–-]25\b/);
  }
});

test('the two forms of a temporary parent are a frozen value: only a seam changes what a build accepts, for the length of one run (R2.5 M3 round 2, S4-3)', async () => {
  const {temporaryParentForms, temporaryParentFormAccepted, withTemporaryParentForms} = tempNameModule;
  assert.deepEqual(
    temporaryParentForms,
    {adGroupCriteria: true, assetGroupListingGroupFilters: true},
    'both forms are built (Q7)',
  );
  assert.equal(Object.isFrozen(temporaryParentForms), true, 'a value, not a switch a test flips in place');
  assert.throws(() => {
    temporaryParentForms.adGroupCriteria = false;
  }, TypeError);
  assert.equal(temporaryParentFormAccepted('adGroupCriteria'), true);
  // The seam overrides one form for the run it wraps, async or not, and undoes it after, even when the run throws.
  const seen = [];
  await withTemporaryParentForms({adGroupCriteria: false}, async () => {
    await Promise.resolve();
    seen.push(
      temporaryParentFormAccepted('adGroupCriteria'),
      temporaryParentFormAccepted('assetGroupListingGroupFilters'),
    );
  });
  assert.deepEqual(seen, [false, true], 'the other form is untouched');
  assert.equal(temporaryParentFormAccepted('adGroupCriteria'), true, 'undone after the run');
  await assert.rejects(
    withTemporaryParentForms({assetGroupListingGroupFilters: false}, () => {
      assert.equal(temporaryParentFormAccepted('assetGroupListingGroupFilters'), false);
      throw new Error('a run that fails');
    }),
    /a run that fails/,
  );
  assert.equal(temporaryParentFormAccepted('assetGroupListingGroupFilters'), true, 'undone after a run that throws');
  assert.deepEqual(
    temporaryParentForms,
    {adGroupCriteria: true, assetGroupListingGroupFilters: true},
    'the value never changed',
  );
});
