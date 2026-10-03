import test from 'node:test';
import assert from 'node:assert/strict';
import {DelegatedNativeCompiler} from '../dist/src/delegated-native.js';

const compiler = new DelegatedNativeCompiler(),
  gateway = 'google_business_native_action',
  reads = [
    ['gmb_location_ops', 'GET_LOCATION', 'locations/456'],
    ['gmb_lodging_ops', 'GET_LODGING', 'locations/456/lodging'],
  ];
const compile = (operation, action, name, selectors = {}) =>
  compiler.compile(gateway, {operation, arguments: {action, params: {name}, ...selectors}});

test('Business Profile location and lodging reads require the field mask documented in their pinned contracts', () => {
  for (const [operation, action, name] of reads) {
    const route = compiler.data.routes.find(
      r => r.gateway === gateway && r.operation === operation && r.action === action,
    );
    assert.match(route.parameters.readMask.description, /^Required\./);
    assert.throws(
      () => compile(operation, action, name),
      error => error.code === 'MISSING_PARAMETER' && error.details.parameter === 'readMask',
    );
    for (const value of ['', '   ', '\t\n'])
      assert.throws(
        () => compile(operation, action, name, {query: {readMask: value}}),
        error =>
          error.code === (value === '' ? 'MISSING_PARAMETER' : 'INVALID_PARAMETER') &&
          error.details.parameter === 'readMask',
      );
  }
});

test('explicit Business Profile field masks preserve native bytes, aliases and conflicts without changing other reads', () => {
  for (const [operation, action, name] of reads) {
    for (const [mask, selectors] of [
      ['*', {query: {readMask: '*'}}],
      ['name', {params: {name, readMask: 'name'}}],
      ['name', {query: {'Read-Mask': 'name'}}],
    ]) {
      const input = {operation, arguments: {action, params: {name}, ...selectors}},
        before = JSON.stringify(input),
        plan = compiler.compile(gateway, input);
      assert.equal(plan.query.readMask, mask);
      assert.equal(plan.path, '/v1/' + name);
      assert.equal(plan.accountId, 'locations/456');
      assert.equal(plan.readOnly, true);
      assert.equal(JSON.stringify(input), before);
    }
    assert.throws(
      () => compile(operation, action, name, {params: {name, readMask: '*'}, query: {readMask: 'name'}}),
      error => error.code === 'CONFLICTING_PARAMETER',
    );
  }
  assert.equal(compile('gmb_account_ops', 'GET_ACCOUNT', 'accounts/100').query.readMask, undefined);
  const attributes = compiler.compile(gateway, {
    operation: 'gmb_location_ops',
    arguments: {action: 'GET_LOCATION_ATTRIBUTES', location_id: '456'},
  });
  assert.equal(attributes.query.readMask, undefined);
});
