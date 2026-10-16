// MED-06: the website shows the advisory placement check under "What it receives" in English and Arabic. Before this
// the push table showed only the file's facts, so a file no recorded placement takes looked as ready as any other.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function page(locale) {
  const node = () => ({innerHTML: '', textContent: '', addEventListener() {}, querySelectorAll: () => []});
  const context = createContext({
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    Intl,
    Date,
    Blob,
    URLSearchParams,
    setTimeout: () => 0,
    clearTimeout() {},
    document: {addEventListener() {}, querySelector: node, querySelectorAll: () => []},
    $: node,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    session: {authenticated: true, workspaceRole: 'operator'},
    sessionStorage: {getItem: () => null, setItem() {}},
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync('web/creative-push.js', 'utf8'));
  return context;
}
const snapchat = {
  spec_version: '2026-10-11',
  advisory: true,
  verified_against_source: false,
  stale: false,
  fits_any: false,
  suggested_preset: 'vertical',
  placements: [
    {
      placement: 'Single Image',
      fits: false,
      issues: [
        {check: 'aspect_ratio', actual: '3:2', expected: '9:16'},
        {check: 'max_bytes', actual: 6_000_000, expected: 5_000_000},
      ],
      unchecked: [],
      source_url: 'https://businesshelp.snapchat.com/s/article/creative-specs',
    },
  ],
};
const meta = {
  ...snapchat,
  fits_any: true,
  suggested_preset: undefined,
  stale: true,
  placements: [
    {placement: 'Feed', fits: true, issues: [], unchecked: []},
    {
      placement: 'Stories and Reels',
      fits: false,
      issues: [{check: 'aspect_ratio', actual: '3:2', expected: '9:16'}],
      unchecked: [],
    },
  ],
};

test('English: what does not fit, why, the suggested variant and the advisory label', () => {
  const html = page('en').pushPlacementNote(snapchat);
  assert.match(html, /<details class="push-placement" open>/, 'a file no placement takes opens its note');
  assert.match(html, /Placements: none of the recorded placements fits/);
  assert.match(html, /Single Image: shape 3:2; it takes 9:16; 5\.7 MiB; it takes at most 4\.8 MiB/);
  assert.match(html, /A vertical \(9:16\) variant would match the shape and size these placements take\./);
  assert.match(html, /Advisory: AMCP’s recorded provider specifications\. The platform’s own check decides\./);
  const partial = page('en').pushPlacementNote(meta);
  assert.match(partial, /<details class="push-placement"><summary>Placements: fits Feed<\/summary>/);
  assert.match(partial, /Stories and Reels: shape 3:2; it takes 9:16/);
  assert.match(partial, /are due for review/, 'a stale table is labelled');
  assert.equal(page('en').pushPlacementNote(undefined), '', 'no check, no note');
});

test('Arabic: every sentence is translated while provider placement and shape names stay literal', () => {
  const html = page('ar').pushPlacementNote(snapchat);
  assert.match(html, /مواضع العرض: لا يناسب أيًّا من المواضع المسجلة/);
  assert.match(html, /Single Image: نسبة الأبعاد 3:2؛ وهذا الموضع يقبل 9:16/);
  assert.match(html, /نسخة رأسية \(9:16\) ستطابق/);
  assert.match(html, /للاسترشاد فقط/);
  assert.doesNotMatch(html, /Placements:|Advisory|it takes/, 'no English sentence leaks into the Arabic page');
});
