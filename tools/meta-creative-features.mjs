// Offline qualification of the Advantage+ creative features the creative contract accepts (PRV-06 C) against Meta's
// versioned public SDK. No credentials or network: the operator downloads the adobjects files of the pinned release
// (facebook-python-business-sdk 26.0.2) into a directory and runs
//   node tools/meta-creative-features.mjs --source-dir <directory>          (pins the fixture)
//   node tools/meta-creative-features.mjs --source-dir <directory> --check  (fails when the pinned fixture differs)
//   node tools/meta-creative-features.mjs --require-pinned                  (release qualification: fails while the
//                                                                            committed fixture is not hashed SDK evidence)
// It refuses when an accepted feature is not a field of AdCreativeFeaturesSpec, or when the SDK no longer types
// degrees_of_freedom_spec, creative_features_spec or enroll_status as the contract expects.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {argumentDirectory, dictionary, metaSdkTag, metaVersion, readSdk, sdkClass, sdkMethod} from './meta-sdk.mjs';

export const fixturePath = 'tests/fixtures/meta-creative-features-sdk-v26.json';
export const sdkModules = [
  'adcreativefeaturesspec',
  'adcreativefeaturedetails',
  'adcreativedegreesoffreedomspec',
  'adcreative',
  'adaccount',
];

/**
 * Why a fixture is not yet the hashed SDK evidence the allowlist needs (PRV-06 C): empty once the pin command has read
 * the release files. A transcribed fixture (no hashes, no pin date) only narrows what AMCP sends; release
 * qualification (tools/qualify.mjs, full profile) fails on it until the owner pins the files.
 */
export function pinnedEvidenceProblems(fixture) {
  const problems = [],
    sources = fixture && typeof fixture.sources === 'object' && fixture.sources ? fixture.sources : {};
  if (fixture?.evidence !== 'sdk_files')
    problems.push('evidence is ' + JSON.stringify(fixture?.evidence ?? null) + ', not sdk_files');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fixture?.checked_at ?? ''))) problems.push('checked_at holds no pin date');
  for (const name of sdkModules)
    if (!/^[0-9a-f]{64}$/.test(String(sources[name]?.sha256 ?? ''))) problems.push(name + ' has no SHA-256');
  if (!Array.isArray(fixture?.sdk_features) || !fixture.sdk_features.length)
    problems.push('sdk_features does not list the release features');
  return problems;
}

/** The pinned evidence for `accepted` from the SDK modules' text and sources. Throws when the SDK disagrees. */
export function creativeFeatureEvidence({sources, text}, accepted, checkedAt) {
  const spec = sdkClass(text.adcreativefeaturesspec),
    features = [...spec.fields].sort(),
    typed = dictionary(text.adcreativefeaturesspec, '_field_types'),
    detail = dictionary(text.adcreativefeaturedetails, '_field_types'),
    freedom = dictionary(text.adcreativedegreesoffreedomspec, '_field_types'),
    creative = dictionary(text.adcreative, '_field_types'),
    create = sdkMethod(text.adaccount, 'create_ad_creative');
  if (spec.class !== 'AdCreativeFeaturesSpec' || !features.length) throw Error('AdCreativeFeaturesSpec changed shape.');
  const missing = accepted.filter(feature => !features.includes(feature));
  if (missing.length) throw Error('Accepted features are not fields of AdCreativeFeaturesSpec: ' + missing.join(', '));
  if (accepted.some(feature => typed[feature] !== 'AdCreativeFeatureDetails'))
    throw Error('An accepted feature is no longer an AdCreativeFeatureDetails.');
  if (detail.enroll_status !== 'string') throw Error('AdCreativeFeatureDetails.enroll_status changed type.');
  if (freedom.creative_features_spec !== 'AdCreativeFeaturesSpec')
    throw Error('AdCreativeDegreesOfFreedomSpec.creative_features_spec changed type.');
  if (creative.degrees_of_freedom_spec !== 'AdCreativeDegreesOfFreedomSpec')
    throw Error('AdCreative.degrees_of_freedom_spec is no longer readable as AdCreativeDegreesOfFreedomSpec.');
  if (!create?.includes("endpoint='/adcreatives'") || !create.includes("method='POST'"))
    throw Error('AdAccount.create_ad_creative changed route.');
  const params = dictionary(create, 'param_types');
  if (!params.degrees_of_freedom_spec)
    throw Error('AdAccount.create_ad_creative no longer takes degrees_of_freedom_spec.');
  return {
    api_version: metaVersion,
    sdk_tag: metaSdkTag,
    evidence: 'sdk_files',
    checked_at: checkedAt,
    sources,
    routes: {
      write: {method: 'POST', edge: '/adcreatives'},
      read: {class: 'AdCreative', field: 'degrees_of_freedom_spec'},
    },
    types: {
      'AdAccount.create_ad_creative degrees_of_freedom_spec': params.degrees_of_freedom_spec,
      'AdCreative.degrees_of_freedom_spec': creative.degrees_of_freedom_spec,
      'AdCreativeDegreesOfFreedomSpec.creative_features_spec': freedom.creative_features_spec,
      'AdCreativeFeatureDetails.enroll_status': detail.enroll_status,
    },
    sdk_features: features,
    accepted: [...accepted].sort(),
    enroll_status: ['OPT_IN', 'OPT_OUT'],
    meaning:
      'Field names and types of the official SDK generated from Meta’s API specification: the accepted single features exist at this release. The OPT_IN and OPT_OUT values, Meta’s default for features a creative made through the API does not list, and live acceptance are not SDK evidence; they come from Meta’s Advantage+ creative documentation and native acceptance.',
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv.includes('--require-pinned')
) {
  // Offline: reads only the committed fixture. Until it is pinned, PRV-06 C stays partial and a release is not qualified.
  const problems = pinnedEvidenceProblems(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
  if (problems.length) {
    console.error(
      'The Advantage+ creative feature allowlist (' +
        fixturePath +
        ') is not pinned from the facebook-python-business-sdk ' +
        metaSdkTag +
        ' files: ' +
        problems.join('; ') +
        '. PRV-06 C stays partial until the owner runs: node tools/meta-creative-features.mjs --source-dir <directory>.',
    );
    process.exitCode = 1;
  } else console.log('The Advantage+ creative feature allowlist is pinned from SDK ' + metaSdkTag + ' files.');
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {metaCreativeFeatures} = await import('../dist/src/meta-creative-features.js');
  const sdk = readSdk(
    argumentDirectory('--source-dir', 'the facebook-python-business-sdk ' + metaSdkTag + ' adobjects files'),
    sdkModules,
  );
  const pinned = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : {};
  // --check compares against the date the fixture was pinned; a new pin records today's date.
  const checkedAt =
    process.argv.includes('--check') && pinned.evidence === 'sdk_files'
      ? pinned.checked_at
      : new Date().toISOString().slice(0, 10);
  const text = JSON.stringify(creativeFeatureEvidence(sdk, metaCreativeFeatures, checkedAt), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(fixturePath) || fs.readFileSync(fixturePath, 'utf8') !== text)
      throw Error(
        'Meta creative feature evidence differs from the pinned fixture ' + fixturePath + '. Review the change.',
      );
  } else fs.writeFileSync(fixturePath, text);
  console.log(
    'Qualified ' +
      metaCreativeFeatures.length +
      ' accepted Advantage+ creative features against SDK ' +
      metaSdkTag +
      '.',
  );
}
