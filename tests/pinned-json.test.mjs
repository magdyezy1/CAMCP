import test from 'node:test';
import assert from 'node:assert/strict';
import {optionalPinnedJson, pinnedJson} from '../dist/src/pinned-json.js';
import {Registry} from '../dist/src/catalog.js';

// F-64: generated artifacts and pinned vendor documents are parsed once per process, shared and frozen.
test('a pinned document is parsed once, shared, and frozen all the way down', () => {
  const routes = pinnedJson('generated/vendor-routes.json');
  assert.equal(pinnedJson('generated/vendor-routes.json'), routes);
  assert.ok(Object.isFrozen(routes) && Object.isFrozen(routes.routes) && Object.isFrozen(routes.routes[0]));
  assert.throws(() => {
    routes.routes[0].path = '/changed';
  }, TypeError);
  const dv360 = pinnedJson('.mirror/VENDOR/dv360-v4.json').document.schemas.AdGroupAd;
  assert.ok(Object.isFrozen(dv360.properties));
});

test('registries share the parsed catalog and compile validators on first use; every schema still compiles', () => {
  const first = new Registry(),
    second = new Registry();
  assert.equal(first.data, second.data);
  assert.equal(first.data, pinnedJson('generated/registry.json'));
  // Nothing is compiled until a tool is validated; compileAll proves every schema compiles, as construction used to.
  assert.ok(first.compileAll() >= first.data.tools.length);
});

test('an optional capture is undefined only when its file is absent; a present one is the shared frozen copy', () => {
  assert.equal(optionalPinnedJson('.mirror/VENDOR/not-captured-yet.json'), undefined);
  assert.equal(optionalPinnedJson('generated/vendor-routes.json'), pinnedJson('generated/vendor-routes.json'));
  // A file that exists but does not parse is never treated as absent.
  assert.throws(() => optionalPinnedJson('Dockerfile'), SyntaxError);
});
