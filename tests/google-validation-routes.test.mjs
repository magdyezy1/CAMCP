import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';

/**
 * R2.5 M3 round 2, S1-1 (lead review 2026-11-18): the default validate-only check sends `validate_only: true` to a mutate route, and
 * four Google Ads `:mutate` requests have no such field (they take one singular `operation`): `batchJobs`, `billingSetups`,
 * `customerUserAccessInvitations` and `customerUserAccesses`. The wire contract of the validation request refuses an unknown field
 * (`INVALID_VENDOR_BODY`, before anything is sent, and Google's REST front end would refuse it with HTTP 400 too), so every Google
 * user-access prepare was refused once the default was on. The route's `validation.request` therefore answers `undefined` for exactly
 * the services whose request in the pinned Discovery document has no `validateOnly`. This test walks that document, so a pin that
 * changes the set fails here and not in production.
 */
const google = registeredProviderHooks.find(h => h.gateway === 'google_ads_native_action');
const pinned = JSON.parse(fs.readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')).document;

/** Every `customers/{customerId}/<Service>:mutate` method of the pinned document, and whether its request has `validateOnly`. */
function mutateMethods() {
  const found = [];
  const walk = resources => {
    for (const resource of Object.values(resources ?? {})) {
      for (const method of Object.values(resource.methods ?? {})) {
        const service = /^v\d+\/customers\/\{\+customerId\}\/([A-Za-z]+):mutate$/.exec(method.path ?? '')?.[1];
        if (service)
          found.push({
            id: method.id,
            service,
            validateOnly: Object.hasOwn(pinned.schemas[method.request?.$ref]?.properties ?? {}, 'validateOnly'),
          });
      }
      walk(resource.resources);
    }
  };
  walk(pinned.resources);
  return found;
}
const planOf = (service, body = {operations: [{create: {name: 'DNU'}}]}) => ({
  gateway: 'google_ads_native_action',
  action: 'google_ads_v23_' + service,
  method: 'POST',
  path: '/v25/customers/123/' + service + ':mutate',
  query: {},
  body,
  headers: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  accountId: '123',
  evidence: 'synthetic',
  warnings: [],
});

test('Google validates by default on a :mutate route exactly when its request in the pinned Discovery document has validateOnly', () => {
  const methods = mutateMethods();
  assert.ok(methods.length >= 70, 'the walk found the document’s mutate methods: ' + methods.length);
  const without = methods.filter(m => !m.validateOnly).map(m => m.service);
  assert.ok(
    without.length > 0,
    'the pinned document has requests with no validateOnly, which is what this test is about',
  );
  for (const method of methods) {
    const sent = google.validation.request(planOf(method.service));
    assert.equal(
      sent === undefined,
      !method.validateOnly,
      method.id +
        (method.validateOnly
          ? ' has validateOnly in the pinned document, so its check must be sent'
          : ' has no validateOnly in the pinned document, so nothing may be sent to it') +
        ' (without validateOnly: ' +
        without.join(', ') +
        ')',
    );
    if (sent) {
      assert.equal(sent.body.validate_only, true, method.id);
      assert.equal(Object.hasOwn(sent.body, 'validateOnly'), false, method.id);
      assert.equal(sent.path, planOf(method.service).path);
    }
  }
});

test('the routes that have validateOnly still validate: one-service writes, a build, ad group criteria and listing group filters', () => {
  for (const service of ['campaigns', 'adGroups', 'adGroupCriteria', 'googleAds', 'assetGroupListingGroupFilters']) {
    const sent = google.validation.request(planOf(service, {operations: [{create: {}}], validateOnly: false}));
    assert.ok(sent, service + ' is validated');
    assert.equal(sent.body.validate_only, true, service);
    assert.equal(Object.hasOwn(sent.body, 'validateOnly'), false, service);
    assert.equal(Object.hasOwn(sent.body, 'validate_only'), true);
    assert.deepEqual(sent.body.operations, [{create: {}}], service + ' keeps its operations');
  }
});

test('the four routes without validateOnly are the user access, batch job and billing setup services, and no other shape is validated', () => {
  for (const service of ['customerUserAccesses', 'customerUserAccessInvitations', 'batchJobs', 'billingSetups'])
    assert.equal(google.validation.request(planOf(service, {operation: {create: {}}})), undefined, service);
  // The request must still be a mutate POST on a customer: nothing else is a route this check knows.
  assert.equal(google.validation.request({...planOf('campaigns'), method: 'GET'}), undefined);
  assert.equal(
    google.validation.request({...planOf('campaigns'), path: '/v25/customers/123/googleAds:search'}),
    undefined,
  );
});
