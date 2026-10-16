import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertWriteShape} from '../dist/src/write-shape.js';
import {writeImpact} from '../dist/src/write-impact.js';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {metaApiVersion} from '../dist/src/meta-version.js';
import {
  metaCreativeFeatureBundles,
  metaCreativeFeatureSdkTag,
  metaCreativeFeatures,
  metaEnrollStatuses,
} from '../dist/src/meta-creative-features.js';
import {metaSdkTag} from '../tools/meta-sdk.mjs';
import {
  creativeFeatureEvidence,
  fixturePath,
  pinnedEvidenceProblems,
  sdkModules,
} from '../tools/meta-creative-features.mjs';
import {profileStages} from '../tools/qualify.mjs';
import {spawnSync} from 'node:child_process';

/**
 * Advantage+ creative features chosen one by one (PRV-06 C). Meta's Standard Enhancements page (read 2026-10-08 by
 * the engineering review): from Marketing API v22.0 the bundle is no longer toggled; each Advantage+ creative feature is
 * opted in or out in degrees_of_freedom_spec.creative_features_spec, and the page does not say what a creative made
 * through the API gets for a feature it does not list. The creative contract accepts explicit choices for the features
 * of Meta's SDK 26.0.2 it reviews, says them in the review, never chooses for the user, and compares them on read-back.
 * Before PRV-06 the contract refused degrees_of_freedom_spec as an unsupported field.
 */
const actor = {tenantId: 'meta-features', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  gateway = 'meta_native_action';
const story = {page_id: '500', link_data: {link: 'https://example.test/', message: 'Hello'}};
const spec = features => ({creative_features_spec: features});
const choice = enroll_status => ({enroll_status});
const chosen = spec({image_touchups: choice('OPT_OUT'), text_optimizations: choice('OPT_IN')});
const plan = (path, body, action = 'meta_ad_account_id_adcreatives_create') => ({
  gateway,
  accountId: '123',
  action,
  method: 'POST',
  path,
  query: {},
  headers: {},
  body,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic',
  warnings: [],
});
const creative = (extra, version = 'v26.0') =>
  plan('/' + version + '/act_123/adcreatives', {name: 'Creative', object_story_spec: story, ...extra});
const refused = (p, code, check = () => true) =>
  assert.throws(
    () => assertWriteShape(p),
    e => e instanceof MirrorError && e.code === code && check(e),
    JSON.stringify(p.body),
  );

test('explicit Advantage+ creative feature choices are accepted at Graph API v26.0 (regression: the field was refused)', () => {
  assertWriteShape(creative({degrees_of_freedom_spec: chosen}));
  // Every reviewed feature takes either choice, and one request may choose all of them.
  assertWriteShape(
    creative({
      degrees_of_freedom_spec: spec(
        Object.fromEntries(metaCreativeFeatures.map((f, i) => [f, choice(metaEnrollStatuses[i % 2])])),
      ),
    }),
  );
  // The shop opt-out and the feature choices are independent fields of one creative.
  assertWriteShape(
    creative({degrees_of_freedom_spec: chosen, destination_spec: {destination_type: 'WEBSITE_AND_SHOP_OPT_OUT'}}),
  );
});

test('a feature the contract does not review, or a bundle, is refused naming it before anything is read', () => {
  refused(
    creative({degrees_of_freedom_spec: spec({image_touchups: choice('OPT_OUT'), not_a_feature: choice('OPT_OUT')})}),
    'META_ADVANTAGE_CREATIVE_FEATURE_UNAVAILABLE',
    e =>
      e.details.field === 'degrees_of_freedom_spec.creative_features_spec.not_a_feature' &&
      e.details.unsupported_features.join() === 'not_a_feature' &&
      e.details.supported_features.length === metaCreativeFeatures.length &&
      e.details.sdk_tag === '26.0.2',
  );
  for (const bundle of metaCreativeFeatureBundles)
    refused(
      creative({degrees_of_freedom_spec: spec({[bundle]: choice('OPT_OUT')})}),
      'META_ADVANTAGE_CREATIVE_FEATURE_UNAVAILABLE',
      e => e.details.bundles.join() === bundle,
    );
  // Case matters: Meta's field names are lowercase.
  refused(
    creative({degrees_of_freedom_spec: spec({IMAGE_TOUCHUPS: choice('OPT_OUT')})}),
    'META_ADVANTAGE_CREATIVE_FEATURE_UNAVAILABLE',
  );
});

test('every listed feature needs an explicit OPT_IN or OPT_OUT and nothing else; the remedy says to ask the user', () => {
  for (const value of [
    {},
    choice('opt_out'),
    choice('DEFAULT'),
    choice(null),
    'OPT_OUT',
    null,
    [choice('OPT_OUT')],
    {enroll_status: 'OPT_IN', customizations: {text_extraction: {enroll_status: 'OPT_IN'}}},
  ])
    refused(
      creative({degrees_of_freedom_spec: spec({image_touchups: choice('OPT_OUT'), inline_comment: value})}),
      'META_ADVANTAGE_CREATIVE_CHOICE_REQUIRED',
      e =>
        e.details.features.join() === 'inline_comment' &&
        e.details.field === 'degrees_of_freedom_spec.creative_features_spec.inline_comment.enroll_status' &&
        e.details.allowed.join() === 'OPT_IN,OPT_OUT',
    );
  const out = errorResult(new MirrorError('META_ADVANTAGE_CREATIVE_CHOICE_REQUIRED', 'Fixture'), 'ref', 0).error;
  assert.match(out.next_action, /Ask the user/);
  assert.match(out.next_action, /never choose for them/i);
  assert.equal(out.remedy.mutation_retry_safe, false);
  const unknown = errorResult(
    new MirrorError('META_ADVANTAGE_CREATIVE_FEATURE_UNAVAILABLE', 'Fixture'),
    'ref',
    0,
  ).error;
  assert.match(unknown.next_action, /details\.supported_features/);
});

test('degrees_of_freedom_spec holds only a non-empty creative_features_spec, and only at the version the SDK pins', () => {
  for (const value of [
    {degrees_of_freedom_type: 'USER_ENROLLED_NON_DCO'},
    {...chosen, image_transformation_types: ['CROPPING']},
    {...chosen, text_transformation_types: ['TEXT_LIQUIDITY']},
    spec({}),
    spec([]),
    {},
    JSON.stringify(chosen),
    [chosen],
  ])
    refused(creative({degrees_of_freedom_spec: value}), 'WRITE_CONTRACT_UNAVAILABLE', e =>
      e.details.field.startsWith('degrees_of_freedom_spec'),
    );
  refused(
    creative({degrees_of_freedom_spec: {...chosen, degrees_of_freedom_type: 'X'}}),
    'WRITE_CONTRACT_UNAVAILABLE',
    e => e.details.unsupported_fields.join() === 'degrees_of_freedom_spec.degrees_of_freedom_type',
  );
  // A deployment moved back to v25.0 sends to a version whose feature names the pinned SDK does not describe.
  refused(creative({degrees_of_freedom_spec: chosen}, 'v25.0'), 'WRITE_CONTRACT_UNAVAILABLE', e =>
    /v26\.0/.test(e.message),
  );
  // An ad still names an existing creative: an inline creative cannot carry choices past the creative contract.
  refused(
    plan(
      '/v26.0/act_123/ads',
      {
        name: 'Ad',
        adset_id: '222',
        status: 'PAUSED',
        creative: {object_story_spec: story, degrees_of_freedom_spec: chosen},
      },
      'meta_ad_account_id_ads_create',
    ),
    'WRITE_CONTRACT_UNAVAILABLE',
  );
});

test('the impact of a creative without choices says Meta applies its own setting and how to choose', () => {
  const plain = writeImpact(creative({}), [], false, 'c1');
  assert.equal(plain.creative_features.chosen, false);
  assert.match(plain.creative_features.note, /ask the user/);
  assert.match(plain.creative_features.note, /does not document/);
  // The shop destination warning stays.
  assert.match(plain.warning, /WEBSITE_AND_SHOP_OPT_OUT/);
  const both = writeImpact(creative({degrees_of_freedom_spec: chosen}), [], false, 'c1').creative_features;
  assert.deepEqual([both.chosen, both.opted_in, both.opted_out], [true, ['text_optimizations'], ['image_touchups']]);
  // Below v26.0 the field is refused, and the review adds nothing about it.
  assert.equal(writeImpact(creative({}, 'v25.0'), [], false, 'c1'), undefined);
});

function fixture(read) {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64')),
    connection = {
      id: 'features-login',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_management', 'pages_show_list', 'pages_read_engagement'],
    };
  store.putConnection(admin, connection, {accessToken: 'synthetic-user-token'});
  const sent = [],
    reads = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname;
      if (init?.method !== 'GET') {
        const raw = String(init.body);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          body = Object.fromEntries(
            [...new URLSearchParams(raw)].map(([k, v]) => {
              try {
                return [k, JSON.parse(v)];
              } catch {
                return [k, v];
              }
            }),
          );
        }
        sent.push(body);
        return Response.json({id: '900'});
      }
      if (path === '/v26.0/act_123') return Response.json({id: 'act_123', currency: 'USD', account_status: 1});
      if (path.endsWith('/promote_pages')) return Response.json({data: [{id: '500'}]});
      if (path === '/v26.0/900') {
        reads.push(u.searchParams.get('fields'));
        const last = sent.at(-1),
          freedom = read(last.degrees_of_freedom_spec);
        return Response.json({
          id: '900',
          name: last.name,
          object_story_spec: last.object_story_spec,
          ...(freedom === undefined ? {} : {degrees_of_freedom_spec: freedom}),
        });
      }
      throw Error('Unexpected synthetic route ' + path);
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const call = (action, extra) => service.call('amcp_write', {action, ...extra}, actor);
  const prepare = payload =>
    call('prepare', {
      gateway,
      connection_id: connection.id,
      arguments: {action: 'meta_creative_create', account_id: '123', payload},
    });
  const execute = r =>
    call('execute', {review_id: r.data.review_id, idempotency_key: r.data.idempotency_key, confirmed: true});
  const verify = r => service.call('amcp_campaign', {action: 'verify', review_id: r.data.review_id}, actor);
  return {store, sent, reads, prepare, execute, verify};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('the review lists each choice, a creative without choices says so, and AMCP never adds a choice', async () => {
  const f = fixture(sentSpec => sentSpec);
  try {
    const p = ok(await f.prepare({name: 'Creative', object_story_spec: story, degrees_of_freedom_spec: chosen}));
    const impact = p.data.creative_impact.creative_features;
    assert.deepEqual(impact.opted_in, ['text_optimizations']);
    assert.deepEqual(impact.opted_out, ['image_touchups']);
    assert.match(impact.unlisted, /verification reports/);
    ok(await f.execute(p));
    assert.deepEqual(f.sent[0].degrees_of_freedom_spec, chosen);
    const plain = ok(await f.prepare({name: 'Plain', object_story_spec: story}));
    assert.equal(plain.data.creative_impact.creative_features.chosen, false);
    ok(await f.execute(plain));
    assert.equal(Object.hasOwn(f.sent[1], 'degrees_of_freedom_spec'), false);
    // A refused choice never reaches Meta.
    const bad = await f.prepare({
      name: 'Bad',
      object_story_spec: story,
      degrees_of_freedom_spec: spec({image_touchups: {}}),
    });
    assert.equal(bad.success, false);
    assert.equal(bad.error.code, 'META_ADVANTAGE_CREATIVE_CHOICE_REQUIRED');
    assert.equal(f.sent.length, 2);
  } finally {
    f.store.close();
  }
});

test('read-back compares every choice and reports the features Meta shows on its own', async () => {
  // Meta keeps both choices and shows one more feature the request did not list. Provider text is bounded before it
  // is kept in the receipt: a key that is not a feature name is dropped, and a setting that is not an enum is null.
  const f = fixture(sentSpec =>
    sentSpec
      ? {
          creative_features_spec: {
            ...sentSpec.creative_features_spec,
            inline_comment: choice('OPT_IN'),
            'Not a feature name!': choice('OPT_IN'),
            video_highlight: choice('opt in please'),
          },
        }
      : sentSpec,
  );
  try {
    const p = ok(await f.prepare({name: 'Creative', object_story_spec: story, degrees_of_freedom_spec: chosen}));
    ok(await f.execute(p));
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    assert.ok(f.reads.at(-1).split(',').includes('degrees_of_freedom_spec'), f.reads.at(-1));
    assert.deepEqual(v.data.checks[0].provider_creative_features, {inline_comment: 'OPT_IN', video_highlight: null});
  } finally {
    f.store.close();
  }
  // Meta reads back another choice than the one sent: never verified, and the changed choice is named.
  const g = fixture(sentSpec =>
    sentSpec
      ? {creative_features_spec: {...sentSpec.creative_features_spec, text_optimizations: choice('OPT_OUT')}}
      : sentSpec,
  );
  try {
    const p = ok(await g.prepare({name: 'Creative', object_story_spec: story, degrees_of_freedom_spec: chosen}));
    ok(await g.execute(p));
    const v = await g.verify(p);
    assert.notEqual(v.data?.status, 'verified', JSON.stringify(v).slice(0, 900));
    assert.ok(
      v.data.checks[0].changed_fields.includes(
        '/degrees_of_freedom_spec/creative_features_spec/text_optimizations/enroll_status',
      ),
      JSON.stringify(v.data.checks[0]),
    );
  } finally {
    g.store.close();
  }
  // Meta's read leaves the field out: inconclusive with the field named, never verified or failed for the omission.
  const h = fixture(() => undefined);
  try {
    const p = ok(await h.prepare({name: 'Creative', object_story_spec: story, degrees_of_freedom_spec: chosen}));
    ok(await h.execute(p));
    const v = ok(await h.verify(p));
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v).slice(0, 900));
    assert.deepEqual(v.data.checks[0].unacknowledged_fields, ['/degrees_of_freedom_spec']);
    assert.equal(v.data.checks[0].changed_fields.length, 0);
  } finally {
    h.store.close();
  }
});

const committedEvidence = () => JSON.parse(readFileSync(fixturePath, 'utf8'));

// PRV-06 C: until 2026-10-16 the allowlist was transcribed from the SDK classes (evidence "transcribed", every sha256
// null, and the create parameter's type mistyped as Object). It is now pinned from the hashed 26.0.2 release files, and
// these tests fail if the committed record goes back to anything else.
test('the accepted features are the pinned SDK 26.0.2 list, hashed from the release files and tied to the Graph API version AMCP sends', () => {
  const evidence = committedEvidence();
  assert.equal(evidence.api_version, metaApiVersion);
  assert.equal(evidence.sdk_tag, metaSdkTag);
  assert.equal(metaCreativeFeatureSdkTag, metaSdkTag);
  assert.deepEqual(evidence.accepted, [...metaCreativeFeatures].sort());
  assert.deepEqual(evidence.enroll_status, [...metaEnrollStatuses]);
  assert.deepEqual(Object.keys(evidence.sources).sort(), [...sdkModules].sort());
  for (const source of Object.values(evidence.sources)) assert.ok(source.url.includes('/' + metaSdkTag + '/'));
  for (const bundle of metaCreativeFeatureBundles) assert.ok(!metaCreativeFeatures.includes(bundle), bundle);
  assert.equal(evidence.evidence, 'sdk_files');
  assert.match(evidence.checked_at, /^\d{4}-\d{2}-\d{2}$/);
  for (const source of Object.values(evidence.sources)) assert.match(source.sha256, /^[0-9a-f]{64}$/);
  // Every accepted name is a field of AdCreativeFeaturesSpec at the release, and so is every bundle the contract
  // refuses: the bundles are refused by choice, not because the release lacks them.
  for (const feature of [...metaCreativeFeatures, ...metaCreativeFeatureBundles])
    assert.ok(evidence.sdk_features.includes(feature), feature);
  // The types the contract relies on, as the release declares them (the transcription had Object for the parameter).
  assert.deepEqual(evidence.types, {
    'AdAccount.create_ad_creative degrees_of_freedom_spec': 'map',
    'AdCreative.degrees_of_freedom_spec': 'AdCreativeDegreesOfFreedomSpec',
    'AdCreativeDegreesOfFreedomSpec.creative_features_spec': 'AdCreativeFeaturesSpec',
    'AdCreativeFeatureDetails.enroll_status': 'string',
  });
});

test('the pinned files are the SDK 26.0.2 files the other Meta evidence hashed (regression: their sha256 was null)', () => {
  const evidence = committedEvidence(),
    others = [];
  // Every other v26 fixture that hashed one of the same modules at 26.0.2: the pin read the same bytes.
  for (const file of readdirSync('tests/fixtures').filter(f => /^meta-.*-v26\.json$/.test(f))) {
    if ('tests/fixtures/' + file === fixturePath) continue;
    const fixture = JSON.parse(readFileSync('tests/fixtures/' + file, 'utf8')),
      // meta-sdk-changes-v26.json hashes both releases: its `to` is 26.0.2.
      atRelease = fixture.to?.sdk_tag === metaSdkTag ? 'to' : fixture.sdk_tag === metaSdkTag ? 'sha256' : undefined;
    for (const name of sdkModules) {
      const hash = fixture.sources?.[name]?.[atRelease];
      if (atRelease && typeof hash === 'string') others.push([file, name, hash]);
    }
  }
  // adaccount is hashed by the Insights, post, portfolio and website recipe evidence and the SDK changes record, and
  // adcreative by the SDK changes record; the three feature classes are hashed only here.
  assert.ok(others.some(([, name]) => name === 'adaccount') && others.some(([, name]) => name === 'adcreative'));
  for (const [file, name, hash] of others) assert.equal(evidence.sources[name].sha256, hash, file + ' ' + name);
});

/** Synthetic modules in the generated SDK's layout (and its parameter type, map), for the pin tool's parser. */
function sdkText(features, {detailType = 'string', freedomType = 'AdCreativeFeaturesSpec'} = {}) {
  const klass = (name, fields, types) =>
    'from facebook_business.adobjects.abstractobject import AbstractObject\n\nclass ' +
    name +
    '(\n    AbstractObject,\n):\n\n    def __init__(self, api=None):\n        super(' +
    name +
    ', self).__init__()\n        self._api = api\n\n    class Field(AbstractObject.Field):\n' +
    fields.map(f => '        ' + f + " = '" + f + "'\n").join('') +
    '\n    _field_types = {\n' +
    fields.map(f => "        '" + f + "': '" + types(f) + "',\n").join('') +
    '    }\n    @classmethod\n    def _get_field_enum_info(cls):\n        field_enum_info = {}\n        return field_enum_info\n';
  return {
    sources: Object.fromEntries(sdkModules.map(name => [name, {url: 'synthetic/' + name, sha256: '0'.repeat(64)}])),
    text: {
      adcreativefeaturesspec: klass('AdCreativeFeaturesSpec', features, () => 'AdCreativeFeatureDetails'),
      adcreativefeaturedetails: klass('AdCreativeFeatureDetails', ['customizations', 'enroll_status'], f =>
        f === 'enroll_status' ? detailType : 'AdCreativeFeatureCustomizations',
      ),
      adcreativedegreesoffreedomspec: klass(
        'AdCreativeDegreesOfFreedomSpec',
        ['creative_features_spec'],
        () => freedomType,
      ),
      adcreative: klass('AdCreative', ['degrees_of_freedom_spec', 'name'], f =>
        f === 'name' ? 'string' : 'AdCreativeDegreesOfFreedomSpec',
      ),
      adaccount:
        "class AdAccount(\n    AbstractObject,\n):\n\n    def create_ad_creative(self, fields=None, params=None, batch=None, success=None, failure=None, pending=False):\n        param_types = {\n            'degrees_of_freedom_spec': 'map',\n            'name': 'string',\n        }\n        enums = {\n        }\n        request = FacebookRequest(\n            node_id=self['id'],\n            method='POST',\n            endpoint='/adcreatives',\n            api=self._api,\n        )\n\n    def get_ads(self, fields=None):\n        return None\n",
    },
  };
}

test('the pin tool reads the SDK classes and refuses a feature or type the release does not have', () => {
  const all = [...metaCreativeFeatures, 'standard_enhancements', 'video_highlight'];
  const evidence = creativeFeatureEvidence(sdkText(all), metaCreativeFeatures, '2026-10-16');
  assert.equal(evidence.evidence, 'sdk_files');
  assert.deepEqual(evidence.accepted, [...metaCreativeFeatures].sort());
  assert.deepEqual(evidence.sdk_features, [...all].sort());
  assert.equal(evidence.types['AdCreativeFeatureDetails.enroll_status'], 'string');
  // The parameter type is read from the release, not transcribed.
  assert.equal(evidence.types['AdAccount.create_ad_creative degrees_of_freedom_spec'], 'map');
  assert.throws(
    () => creativeFeatureEvidence(sdkText(metaCreativeFeatures.slice(1)), metaCreativeFeatures, '2026-10-16'),
    new RegExp(metaCreativeFeatures[0]),
  );
  assert.throws(
    () => creativeFeatureEvidence(sdkText(all, {detailType: 'int'}), metaCreativeFeatures, '2026-10-16'),
    /enroll_status/,
  );
  assert.throws(
    () => creativeFeatureEvidence(sdkText(all, {freedomType: 'Object'}), metaCreativeFeatures, '2026-10-16'),
    /creative_features_spec/,
  );
});

// PRV-06 C: release qualification (a blocking full-profile stage; npm run check and the fast gate do not run it) passes on
// the committed allowlist, which is now pinned from the hashed 26.0.2 files, and still fails on a transcribed record
// such as the one committed before the pin.
test('release qualification passes on the pinned allowlist and still fails on a transcribed one (regression: it was transcribed)', () => {
  const committed = committedEvidence();
  assert.deepEqual(pinnedEvidenceProblems(committed), []);
  const cli = spawnSync(process.execPath, ['tools/meta-creative-features.mjs', '--require-pinned'], {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /pinned from SDK 26\.0\.2 files/);
  // The record committed before the pin: transcribed, no pin date, no hashes and no list of the release's features.
  const {sdk_features, ...transcribed} = {
    ...committed,
    evidence: 'transcribed',
    checked_at: null,
    sources: Object.fromEntries(
      Object.entries(committed.sources).map(([name, s]) => [name, {url: s.url, sha256: null}]),
    ),
  };
  assert.ok(sdk_features.length > metaCreativeFeatures.length);
  assert.deepEqual(pinnedEvidenceProblems(transcribed), [
    'evidence is "transcribed", not sdk_files',
    'checked_at holds no pin date',
    ...sdkModules.map(name => name + ' has no SHA-256'),
    'sdk_features does not list the release features',
  ]);
  // The qualification command refuses it: run where the fixture path holds the transcribed record.
  const directory = mkdtempSync(path.join(tmpdir(), 'amcp-meta-features-'));
  try {
    mkdirSync(path.join(directory, path.dirname(fixturePath)), {recursive: true});
    writeFileSync(path.join(directory, fixturePath), JSON.stringify(transcribed, null, 2) + '\n');
    const transcribedRun = spawnSync(
      process.execPath,
      [path.resolve('tools/meta-creative-features.mjs'), '--require-pinned'],
      {cwd: directory, encoding: 'utf8'},
    );
    assert.equal(transcribedRun.status, 1, transcribedRun.stdout);
    assert.match(transcribedRun.stderr, /PRV-06 C stays partial until the owner runs/);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
  // The pin command's own output passes: hashed files, a pin date and the release's features.
  const pinned = creativeFeatureEvidence(
    sdkText([...metaCreativeFeatures, 'video_highlight']),
    metaCreativeFeatures,
    '2026-10-16',
  );
  assert.deepEqual(pinnedEvidenceProblems(pinned), []);
  assert.deepEqual(pinnedEvidenceProblems({...pinned, checked_at: null}), ['checked_at holds no pin date']);
  assert.deepEqual(
    pinnedEvidenceProblems({...pinned, sources: {...pinned.sources, adaccount: {url: 'x', sha256: null}}}),
    ['adaccount has no SHA-256'],
  );
  const stage = profileStages('full').find(s => s.name === 'meta_creative_features_pinned');
  assert.deepEqual([stage?.args, stage?.blocking], [['tools/meta-creative-features.mjs', '--require-pinned'], true]);
  assert.ok(!profileStages('fast').some(s => s.name === 'meta_creative_features_pinned'));
});
