// WEB-07: what each page downloads before it renders (tools/web-route-bytes.mjs: Brotli bytes of its stylesheets, scripts,
// feature scripts and, in Arabic, catalog chunks), against the baseline recorded on Work-here before WEB-07
// (tools/web-route-bytes-baseline.json). Before WEB-07, Live portfolio, Measurement and Commerce loaded one 388 KB script
// with all three pages and the parked WooCommerce source, every Arabic page waited for the whole 1.9 MB catalog, and the
// landing and sign-in pages carried the report builder. These tests fail on that tree; each margin below is wide, so
// ordinary feature work does not trip them, while re-merging a bundle or the catalog does.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readRouteBytesBaseline, routeBytes, routeBytesProblems} from '../tools/web-route-bytes.mjs';

const current = routeBytes(),
  baseline = readRouteBytesBaseline().routes,
  ratio = key => current[key].bytes / baseline[key];

test('the baseline covers every page in both languages and the tool measures each of them', () => {
  assert.deepEqual(Object.keys(current).sort(), Object.keys(baseline).sort());
  for (const [key, value] of Object.entries(current)) assert.ok(value.bytes > 0 && value.files > 0, key);
});

test('each account workflow page downloads well under what it did before (regression: one 388 KB bundle)', () => {
  for (const locale of ['en', 'ar'])
    for (const route of ['/portfolio', '/commerce', '/measurement'])
      assert.ok(ratio(locale + ' ' + route) < 0.9, locale + ' ' + route + ': ' + ratio(locale + ' ' + route));
  assert.ok(ratio('en /portfolio') < 0.7, 'Live portfolio loads only its own code');
});

test('every Arabic page downloads less than before, and the public pages a fraction (regression: one catalog)', () => {
  for (const key of Object.keys(current).filter(key => key.startsWith('ar ')))
    assert.ok(ratio(key) < 0.95, key + ': ' + ratio(key));
  for (const route of ['/', '/login', '/signup', '/forgot-password', '/about'])
    assert.ok(ratio('ar ' + route) < 0.5, 'ar ' + route + ': ' + ratio('ar ' + route));
});

test('the landing and sign-in pages no longer download the report builder (regression: part of the shell)', () => {
  for (const route of ['/', '/login', '/signup', '/connections'])
    assert.ok(ratio('en ' + route) < 0.95, 'en ' + route + ': ' + ratio('en ' + route));
});

test('a route above its recorded value is reported, one at or below it is not', () => {
  const problems = routeBytesProblems(
    {'en /a': {bytes: 11, files: 1}, 'en /b': {bytes: 10, files: 1}, 'en /new': {bytes: 99, files: 1}},
    {routes: {'en /a': 10, 'en /b': 10}},
  );
  assert.deepEqual(problems, ['en /a: 11 Brotli bytes before rendering, above the recorded 10 (WEB-07)']);
});
