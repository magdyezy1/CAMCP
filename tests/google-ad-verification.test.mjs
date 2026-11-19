import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {normalize, differing, snake} from '../dist/src/verification-reads.js';
import {reviewVolatile, normalizeReviewState, reviewStateHash} from '../dist/src/review-state.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * r25-field-gverify (2026-11-19, the field report on Google ads): a responsive search ad that was created correctly
 * verified as VERIFICATION_MISMATCH on every read, because Google answers each headline and description with two fields
 * of its own that nothing sent (v25 AdTextAsset: `assetPerformanceLabel` and `policySummaryInfo`) and the read-back
 * compared a text list as one value. The fixture below answers the way Google does, not the way the request was sent.
 * Only those two names are left out (by name, from Google Ads reads only): the text, the pin, the order and the length of
 * a list, and every other field, are still compared. Synthetic values only; nothing leaves the process.
 */
const gateway = 'google_ads_native_action',
  actor = {tenantId: 'google-ad-verification', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  adGroup = 'customers/123/adGroups/100',
  standingAd = 'customers/123/ads/200';

// What Google says of a text asset, in its own JSON spelling: on every headline and description of an ad, and moved on by
// Google while it reviews and ranks the asset (pinned v25 schemas AdTextAsset and AdAssetPolicySummary).
const inReview = {
  assetPerformanceLabel: 'PENDING',
  policySummaryInfo: {reviewStatus: 'REVIEW_IN_PROGRESS', approvalStatus: 'UNKNOWN'},
};
const approved = {
  assetPerformanceLabel: 'GOOD',
  policySummaryInfo: {reviewStatus: 'REVIEWED', approvalStatus: 'APPROVED'},
};
// A review that completed with a finding: the policy summary then holds a list of its own.
const limited = {
  assetPerformanceLabel: 'LEARNING',
  policySummaryInfo: {
    reviewStatus: 'REVIEWED',
    approvalStatus: 'APPROVED_LIMITED',
    policyTopicEntries: [{topic: 'SYNTHETIC_TOPIC', type: 'LIMITED'}],
  },
};
const decorate = (assets, findings) => assets.map(asset => ({...asset, ...findings}));
/** The responsive search ad as Google answers it: the sent text assets, each with Google's findings. */
const asGoogleAnswers = (rsa, findings) => ({
  ...rsa,
  headlines: decorate(rsa.headlines, findings),
  descriptions: decorate(rsa.descriptions, findings),
});

const headlines = () => [
  {text: 'Synthetic widgets'},
  {text: 'Free synthetic returns', pinnedField: 'HEADLINE_1'},
  {text: 'Synthetic season sale'},
];
const descriptions = () => [{text: 'Synthetic widgets for every run.'}, {text: 'Order a synthetic widget today.'}];
const newAd = () => ({
  adGroup,
  status: 'PAUSED',
  ad: {
    finalUrls: ['https://example.test/'],
    responsiveSearchAd: {headlines: headlines(), descriptions: descriptions()},
  },
});

/**
 * One Google Ads customer with a paused ad group and one ad. `findings` is what Google says of the text assets now (the
 * review moves on: set it between two reads); `transform` changes the responsive search ad the read-back of a created ad
 * returns, after Google's findings are on it; `standing` is the ad an update changes, as Google holds it.
 */
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const state = {
      findings: inReview,
      transform: rsa => rsa,
      standing: {headlines: headlines(), descriptions: descriptions()},
    },
    ads = new Map(),
    queries = [],
    writes = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')),
        path = new URL(String(url)).pathname;
      if (path.endsWith('googleAds:search')) {
        const query = String(body.query),
          names = [...query.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]);
        queries.push(query);
        if (/ FROM customer /.test(query + ' '))
          return Response.json({results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]});
        if (/ FROM ad_group /.test(query + ' '))
          return Response.json({
            results: [
              {
                adGroup: {resourceName: adGroup, status: 'PAUSED', campaign: 'customers/123/campaigns/9'},
                campaign: {status: 'PAUSED'},
              },
            ],
          });
        if (/ FROM ad_group_ad /.test(query + ' '))
          return Response.json({
            results: names
              .filter(name => ads.has(name))
              .map(name => {
                const {ad, ...rest} = ads.get(name);
                return {
                  adGroupAd: {
                    ...rest,
                    ad: {
                      ...ad,
                      responsiveSearchAd: state.transform(asGoogleAnswers(ad.responsiveSearchAd, state.findings)),
                    },
                  },
                };
              }),
          });
        // The review of an update of an ad's headlines selects the headlines and nothing else of the ad.
        if (/ FROM ad /.test(query + ' '))
          return Response.json({
            results: names
              .filter(name => name === standingAd)
              .map(name => ({
                ad: {
                  resourceName: name,
                  responsiveSearchAd: {headlines: decorate(state.standing.headlines, state.findings)},
                },
              })),
          });
        throw new Error('Unexpected query ' + query);
      }
      writes.push({path, body});
      if (path.endsWith('/adGroupAds:mutate'))
        return Response.json({
          results: body.operations.map(op => {
            const name = adGroup.replace('adGroups', 'adGroupAds') + '~' + (300 + ads.size);
            ads.set(name, {resourceName: name, ...op.create});
            return {resourceName: name};
          }),
        });
      if (path.endsWith('/ads:mutate'))
        return Response.json({results: body.operations.map(op => ({resourceName: op.update.resourceName}))});
      throw new Error('Unexpected write ' + path);
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = (action, payload) =>
    call('amcp_write', {action: 'prepare', gateway, arguments: {action, account_id: '123', payload}});
  const prepareCreate = () =>
    prepare('google_ads_v23_ad_group_ad_mutate_ad_group_ads', {operations: [{create: newAd()}]});
  /** A change of the headlines of the standing ad: the update a responsive search ad's text is edited with. */
  const prepareHeadlines = texts =>
    prepare('google_ads_v23_ad_mutate_ads', {
      operations: [
        {
          update: {resourceName: standingAd, responsiveSearchAd: {headlines: texts.map(text => ({text}))}},
          updateMask: 'responsive_search_ad.headlines',
        },
      ],
    });
  const execute = review =>
    call('amcp_write', {
      action: 'execute',
      review_id: review.data.review_id,
      idempotency_key: review.data.idempotency_key,
      confirmed: true,
    });
  const verify = review => call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
  /** A created ad, executed once and ready to verify. */
  const created = async () => {
    const review = await prepareCreate();
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 900));
    const done = await execute(review);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 900));
    return review;
  };
  return {store, state, ads, queries, writes, call, prepareCreate, prepareHeadlines, execute, verify, created};
}

// --- Create: the read-back of an ad Google decorates --------------------------------------------------------------------

test('a responsive search ad that Google decorates with its own findings verifies, and still does once its review is complete', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  t.after(() => t.mock.timers.reset());
  const f = fixture();
  try {
    const review = await f.created();
    assert.equal(f.writes.length, 1);
    const first = await f.verify(review);
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 1200));
    assert.equal(first.data.status, 'verified', JSON.stringify(first.data).slice(0, 1500));
    assert.deepEqual(first.data.checks[0].changed_fields, []);
    assert.equal(first.data.checks[0].read_attempts, 1, 'the first read agreed: no retry was needed');
    // Google's review moves on; a verification a while later reads the ad again (a verified answer is kept for 10 seconds).
    for (const findings of [approved, limited]) {
      f.state.findings = findings;
      t.mock.timers.tick(11000);
      const reads = f.queries.length,
        later = await f.verify(review);
      assert.ok(f.queries.length > reads, 'the round read the ad again: ' + findings.policySummaryInfo.approvalStatus);
      assert.equal(later.data.cached, undefined);
      assert.equal(later.data.status, 'verified', JSON.stringify(later.data).slice(0, 1500));
      assert.deepEqual(later.data.checks[0].changed_fields, []);
    }
    assert.equal(f.writes.length, 1, 'verification sends nothing');
  } finally {
    f.store.close();
  }
});

/** Two rounds of verification: the first cannot tell a mismatch from a read still catching up; the second can. */
async function twoRounds(f, review) {
  const first = await f.verify(review);
  assert.equal(first.data.status, 'inconclusive', JSON.stringify(first.data).slice(0, 1500));
  return {first: first.data, second: (await f.verify(review)).data};
}
const headlinePath = '/ad/responsive_search_ad/headlines',
  descriptionPath = '/ad/responsive_search_ad/descriptions';

test('a headline whose text differs is still VERIFICATION_MISMATCH, with the text in the diff and nothing else', async () => {
  const f = fixture();
  try {
    f.state.transform = rsa => ({
      ...rsa,
      headlines: rsa.headlines.map((h, i) => (i === 2 ? {...h, text: 'Synthetic season sale (edited elsewhere)'} : h)),
    });
    const review = await f.created();
    const {second} = await twoRounds(f, review);
    assert.equal(second.status, 'mismatch', JSON.stringify(second).slice(0, 1500));
    assert.equal(second.code, 'VERIFICATION_MISMATCH');
    const [check] = second.checks;
    assert.equal(check.code, 'VERIFICATION_MISMATCH');
    // The descriptions are the ones sent, with Google's findings: only the headlines disagree.
    assert.deepEqual(check.changed_fields, [headlinePath]);
    assert.equal(check.diff.length, 1);
    assert.equal(check.diff[0].field, headlinePath);
    assert.ok(JSON.stringify(check.diff[0].expected).includes('Synthetic season sale'));
    assert.ok(JSON.stringify(check.diff[0].actual).includes('Synthetic season sale (edited elsewhere)'));
    // The diff shows the text, not Google's findings: they are left out of both sides.
    assert.doesNotMatch(JSON.stringify(check.diff), /REVIEW_IN_PROGRESS|PENDING|policy_summary_info|policySummaryInfo/);
    assert.equal(f.writes.length, 1, 'a mismatch sends nothing');
  } finally {
    f.store.close();
  }
});

for (const [name, transform, path] of [
  [
    'a pin that moved to another headline',
    rsa => ({
      ...rsa,
      headlines: rsa.headlines.map((h, i) => {
        const {pinnedField, ...rest} = h;
        return i === 0 ? {...rest, pinnedField: 'HEADLINE_1'} : rest;
      }),
    }),
    headlinePath,
  ],
  ['a pin that was dropped', rsa => ({...rsa, headlines: rsa.headlines.map(({pinnedField, ...h}) => h)}), headlinePath],
  ['a description that is missing', rsa => ({...rsa, descriptions: rsa.descriptions.slice(0, 1)}), descriptionPath],
  [
    'headlines that come back in another order',
    rsa => ({...rsa, headlines: [rsa.headlines[1], rsa.headlines[0], rsa.headlines[2]]}),
    headlinePath,
  ],
  ['a headline that is missing', rsa => ({...rsa, headlines: rsa.headlines.slice(0, 2)}), headlinePath],
]) {
  test('still VERIFICATION_MISMATCH on ' + name + ', and only on that list', async () => {
    const f = fixture();
    try {
      f.state.transform = transform;
      const review = await f.created();
      const {second} = await twoRounds(f, review);
      assert.equal(second.status, 'mismatch', JSON.stringify(second).slice(0, 1500));
      assert.equal(second.code, 'VERIFICATION_MISMATCH');
      assert.deepEqual(second.checks[0].changed_fields, [path]);
      assert.equal(second.checks[0].diff[0].field, path);
      assert.equal(f.writes.length, 1, 'a mismatch sends nothing');
    } finally {
      f.store.close();
    }
  });
}

// --- Update: the review of an ad whose text assets Google reviews while the review waits ------------------------------------

/** One update of the headlines of the standing ad, prepared, then Google moves on (`between`), then executed. */
async function updateAcrossAChange(between, texts = ['Synthetic widgets', 'Free synthetic returns', 'Synthetic sale']) {
  const f = fixture();
  try {
    const review = await f.prepareHeadlines(texts);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 1200));
    between(f);
    const done = await f.execute(review);
    return {f, review, done, writes: () => f.writes.length};
  } finally {
    f.store.close();
  }
}

for (const [name, between] of [
  [
    'its policy review completes (policy_summary_info only)',
    f => (f.state.findings = {...inReview, policySummaryInfo: approved.policySummaryInfo}),
  ],
  [
    'its performance label moves on (asset_performance_label only)',
    f => (f.state.findings = {...inReview, assetPerformanceLabel: approved.assetPerformanceLabel}),
  ],
  ['its review completes and it is ranked (both)', f => (f.state.findings = approved)],
  ['its review completes with a finding (policy topic entries)', f => (f.state.findings = limited)],
]) {
  test('an update of an ad’s headlines is sent when, between review and execute, ' + name, async () => {
    const {review, done, writes} = await updateAcrossAChange(between);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(writes(), 1, 'the one update was sent');
    // The state the approver reads holds the text being edited, and none of Google's findings of it.
    assert.match(JSON.stringify(review.data.before_state), /Synthetic widgets/);
    assert.doesNotMatch(JSON.stringify(review.data.before_state), /policySummaryInfo|assetPerformanceLabel/);
  });
}

test('the same update is STATE_CHANGED when a headline’s text changed between review and execute, whatever else Google moved on', async () => {
  const {done, writes} = await updateAcrossAChange(f => {
    f.state.standing = {
      ...f.state.standing,
      headlines: f.state.standing.headlines.map((h, i) =>
        i === 0 ? {...h, text: 'Synthetic widgets (edited elsewhere)'} : h,
      ),
    };
    f.state.findings = limited;
  });
  assertRefused(done, 'STATE_CHANGED', {writes});
  // The refusal names the text and nothing of Google's findings, which are no change.
  assert.equal(done.error.details.changed_fields.length, 1, JSON.stringify(done.error.details.changed_fields));
  assert.match(done.error.details.changed_fields[0], /\["headlines"\]\[0\]\["text"\]$/);
  assert.doesNotMatch(JSON.stringify(done.error.details.changed_fields), /olicy|erformance/);
});

// --- The comparison itself: two names, by name, from Google Ads only ----------------------------------------------------
// Every case below is built from the pinned v25 schema (.mirror/VENDOR/google-ads-v25.json), not from the code: the ads that
// keep their text in lists of AdTextAsset, and what an AdTextAsset holds.

const pinned = (() => {
  const doc = JSON.parse(readFileSync(new URL('../.mirror/VENDOR/google-ads-v25.json', import.meta.url), 'utf8'));
  return (doc.document ?? doc).schemas;
})();
const common = name => pinned['GoogleAdsGoogleadsV25Common__' + name];
const own = reviewVolatile(gateway);
/** The paths at which what was sent and what Google answers differ, as a verification compares them. */
const compare = (sent, answered, table = own) => differing(normalize(sent, table), normalize(answered, table));
const textLists = Object.entries(pinned.GoogleAdsGoogleadsV25Resources__Ad.properties).flatMap(([adKey, property]) => {
  const fields = Object.entries(common(property.$ref?.replace('GoogleAdsGoogleadsV25Common__', ''))?.properties ?? {})
    .filter(([, field]) => field.type === 'array' && field.items?.$ref === 'GoogleAdsGoogleadsV25Common__AdTextAsset')
    .map(([name]) => name);
  return fields.length ? [{adKey, fields}] : [];
});

test('the pinned v25 AdTextAsset holds the text and the pin a request chooses and the two fields Google fills: a fifth is noticed', () => {
  assert.deepEqual(Object.keys(common('AdTextAsset').properties).sort(), [
    'assetPerformanceLabel',
    'pinnedField',
    'policySummaryInfo',
    'text',
  ]);
  assert.deepEqual(Object.keys(common('AdAssetPolicySummary').properties).sort(), [
    'approvalStatus',
    'policyTopicEntries',
    'reviewStatus',
  ]);
  // The two names the table drops are the two fields of the message that no request chooses.
  assert.ok(own.includes('policy_summary_info') && own.includes('asset_performance_label'));
  // A schema of ten ad kinds keeps text in these lists; the loop below is not empty.
  assert.ok(textLists.length >= 10, 'ads with lists of text assets: ' + textLists.map(a => a.adKey).join());
  assert.ok(textLists.some(a => a.adKey === 'responsiveSearchAd' && a.fields.join() === 'descriptions,headlines'));
});

for (const {adKey, fields} of textLists)
  for (const field of fields)
    test(
      'v25 ' + adKey + ' ' + field + ': Google’s findings are no difference, and every other difference is one',
      () => {
        const path = '/ad/' + snake(adKey) + '/' + snake(field),
          assets = [{text: 'One'}, {text: 'Two', pinnedField: 'HEADLINE_1'}, {text: 'Three'}],
          at = list => ({ad: {[adKey]: {[field]: list}}});
        // Google answers the sent assets with its findings, in either state of its review.
        for (const findings of [inReview, approved, limited])
          assert.deepEqual(compare(at(assets), at(decorate(assets, findings))), [], JSON.stringify(findings));
        const answered = decorate(assets, limited),
          unpinned = ({pinnedField, ...asset}) => asset;
        for (const [what, list] of Object.entries({
          'a text that differs': answered.map((a, i) => (i === 2 ? {...a, text: 'Three, edited'} : a)),
          'a pin that moved': answered.map((a, i) => (i === 0 ? {...a, pinnedField: 'HEADLINE_1'} : unpinned(a))),
          'a pin that was dropped': answered.map(unpinned),
          'an element that is missing': answered.slice(0, 2),
          'an element that is extra': [...answered, {text: 'Four', ...limited}],
          'another order': [answered[1], answered[0], answered[2]],
          // No blanket ignore: a field of an asset that is not in the table stays compared, whoever adds it.
          'a field nothing names': answered.map((a, i) => (i === 0 ? {...a, someFieldAddedLater: 'x'} : a)),
        }))
          assert.deepEqual(compare(at(assets), at(list)), [path], what);
      },
    );

test('another provider’s table does not leave these names out of a comparison: the list differs for every other gateway', () => {
  const sent = {headlines: [{text: 'One'}]},
    answered = {headlines: [{text: 'One', ...inReview}]};
  assert.deepEqual(compare(sent, answered), []);
  const others = registeredProviderHooks.filter(hooks => hooks.gateway !== gateway);
  for (const other of ['google_business_native_action', 'meta_native_action', 'tiktok_native_action'])
    assert.ok(
      others.some(hooks => hooks.gateway === other),
      other + ' is compared',
    );
  for (const hooks of others)
    assert.deepEqual(compare(sent, answered, hooks.review?.volatile ?? []), ['/headlines'], hooks.gateway);
});

test('the review projection leaves the two names out at any depth, and nothing else of a text asset', () => {
  const display = (findings, edit = ad => ad) => ({
    results: [
      {
        ad: edit({
          resourceName: standingAd,
          responsiveDisplayAd: {
            headlines: decorate([{text: 'A'}, {text: 'B', pinnedField: 'HEADLINE_1'}], findings),
            // A single text asset is not in a list; the review projection reaches it all the same.
            longHeadline: {text: 'Long', ...findings},
            descriptions: decorate([{text: 'D'}], findings),
          },
        }),
      },
    ],
  });
  for (const findings of [approved, limited]) {
    assert.equal(reviewStateHash(display(inReview), own), reviewStateHash(display(findings), own));
    assert.deepEqual(normalizeReviewState(display(findings), own), normalizeReviewState(display({}), own));
  }
  // Every other part of an asset still counts: its text, its pin, the order and the length of a list.
  const rda = ad => ad.responsiveDisplayAd,
    edits = {
      'a text': ad => (rda(ad).headlines[0].text = 'A, edited'),
      'a single text': ad => (rda(ad).longHeadline.text = 'Long, edited'),
      'a pin': ad => (rda(ad).headlines[0].pinnedField = 'HEADLINE_1'),
      'the order': ad => rda(ad).headlines.reverse(),
      'the length': ad => rda(ad).descriptions.push({text: 'E', ...limited}),
    };
  for (const [what, edit] of Object.entries(edits))
    assert.notEqual(
      reviewStateHash(
        display(limited, ad => (edit(ad), ad)),
        own,
      ),
      reviewStateHash(display(limited), own),
      what,
    );
  // From Google Ads reads only: the same state under another provider's table keeps both names.
  assert.notEqual(
    reviewStateHash(display(inReview), reviewVolatile('google_business_native_action')),
    reviewStateHash(display(limited), reviewVolatile('google_business_native_action')),
  );
});
