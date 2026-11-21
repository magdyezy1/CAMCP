import assert from 'node:assert/strict';
import {assetGroup, campaign, googleWorld} from '../../dist/tests/helpers/google-write-fake.js';

/**
 * The synthetic Google of the tests of r25-field3-errors (AMCP-03, M5-a, AMCP-11): customer 123, an asset group the search themes of a
 * request attach to, and the GoogleAdsFailure the provider answers a validate-only check with when a theme breaks a policy (the owner's report of
 * 2026-11-21: Google's health policy refused two search themes of a Performance Max build). Every name and text is synthetic.
 */
export const google = 'google_ads_native_action',
  action = 'asset_group_signal_mutate_asset_group_signals',
  theme = 'dental implants',
  externalName = 'Personalized advertising: health in personalized ads (synthetic policy sentence)',
  on = {providerCheckByDefault: true},
  signals = (text = theme) => [{create: {asset_group: assetGroup(200), search_theme: {text}}}],
  world = () => ({
    campaigns: {[campaign(9)]: {status: 'PAUSED', channel: 'PERFORMANCE_MAX'}},
    assetGroups: {[assetGroup(200)]: {status: 'PAUSED', campaign: campaign(9)}},
  });
/**
 * Google's GoogleAdsFailure for a search theme the health policy refuses, in the v25 names of the pinned schema (GoogleAdsError:
 * errorCode, message, trigger, location, details; ErrorDetails.policyViolationDetails: isExemptible, externalPolicyName, key
 * {policyName, violatingText}, externalPolicyDescription). `index` is the operation the error names (the index in the request's own list);
 * `field` is the name of the last element of the field path.
 */
export const failure = (options = {}) => {
  const {
    trigger = theme,
    policyName = 'HEALTH_IN_PERSONALIZED_ADS',
    isExemptible = true,
    description = 'Synthetic policy description.',
    index = 0,
    field = 'text',
  } = options;
  return {
    error: {
      code: 400,
      message: 'Request contains an invalid argument.',
      status: 'INVALID_ARGUMENT',
      details: [
        {
          '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
          errors: [
            {
              errorCode: {assetGroupSignalError: 'SEARCH_THEME_POLICY_VIOLATION'},
              message: 'The search theme violates a policy.',
              trigger: {stringValue: trigger},
              location: {
                fieldPathElements: [
                  {fieldName: 'operations', index},
                  {fieldName: 'create'},
                  {fieldName: 'search_theme'},
                  {fieldName: field},
                ],
              },
              details: {
                policyViolationDetails: {
                  externalPolicyDescription: description,
                  key: {policyName, violatingText: theme},
                  externalPolicyName: externalName,
                  isExemptible,
                },
              },
            },
          ],
          requestId: 'synthetic-google-request',
        },
      ],
    },
  };
};
/** The row that failure() comes to: what a caller is told of it. */
export const expectedRow = {
  code: 'ASSET_GROUP_SIGNAL_ERROR',
  enum: 'SEARCH_THEME_POLICY_VIOLATION',
  operation_index: 0,
  field_path: 'operations[0].create.search_theme.text',
  policy: {name: 'HEALTH_IN_PERSONALIZED_ADS', exemptible: true},
  trigger: theme,
};
/** A synthetic customer whose validate-only check answers with `failure(options)`. */
export function rejecting(options = {}) {
  const x = googleWorld({policy: on, world: world(), validation: 'custom'});
  x.hooks.validationReply = () => failure(options);
  return x;
}
/** One write step of a plan: the search themes of `operations` attached to the synthetic asset group. */
export const planStep = (id = 'signals', operations = signals()) => ({
  id,
  kind: 'write',
  gateway: google,
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: {action: 'google_ads_v23_' + action, payload: {operations}},
});
export const createPlan = async (x, steps) => {
  const created = await x.call('amcp_campaign', {action: 'create', name: 'DNU launch', brief: 'Synthetic.', steps});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  return created.data.id;
};
