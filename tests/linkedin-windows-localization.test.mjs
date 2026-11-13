// V2-RPT-04: the notes a LinkedIn source adds when it joins the windows of the account's conversion rules reach the Arabic
// interface in Arabic, with the window pairs said in the platform's own words, and English keeps the collector's sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {loadRouteRegistry} from '../tools/check-routes.mjs';
import {chunksWith, loaderFiles} from '../tools/locale-chunks.mjs';
import {
  linkedinCurrentMetadataWarning,
  linkedinMixedWindowsWarning,
  linkedinRuleWindowPairsWarning,
  linkedinRuleWindowsWarning,
} from '../dist/src/linkedin-report-source.js';

/** The report builder's scripts and the Arabic catalog chunks it loads, in one language (as the warnings contract does). */
function builder(locale) {
  const {dependencies} = loaderFiles(),
    route = [...loadRouteRegistry()].find(entry => entry.path === '/reporting-overview'),
    catalog = {};
  for (const chunk of new Set([...route.assets].flatMap(file => [...chunksWith(file, dependencies)])))
    Object.assign(catalog, JSON.parse(fs.readFileSync('web/locales/ar/' + chunk + '.json', 'utf8')));
  const context = createContext({document: {addEventListener() {}}, Intl, Date, catalog});
  const run = code => new Script(code).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  if (locale === 'ar') run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))');
  run(fs.readFileSync('web/report-quality.js', 'utf8'));
  return {warning: value => ((context.value = value), run('uiSourceWarning(value)'))};
}

test('the window pairs note names each pair in the platform’s words in Arabic and stays as written in English', () => {
  const sentence = linkedinRuleWindowPairsWarning(['30d click / 7d view', '7d click / 1d view']),
    arabic = builder('ar').warning(sentence),
    english = builder('en').warning(sentence);
  assert.equal(english, sentence);
  assert.match(arabic, /[؀-ۿ]/);
  assert.doesNotMatch(arabic, /click|view/);
  // Each pair keeps its two window sizes, in the words the measurement page uses for the two windows.
  assert.ok(arabic.includes('نافذة النقر 30 أيام / نافذة المشاهدة 7 أيام'), arabic);
  assert.ok(arabic.includes('نافذة النقر 7 أيام / نافذة المشاهدة 1'), arabic);
  // A pair it does not know is shown as LinkedIn’s vocabulary gave it, never dropped.
  assert.ok(
    builder('ar')
      .warning(linkedinRuleWindowPairsWarning(['custom']))
      .includes('custom'),
  );
});

test('the fixed notes of the windows join reach the Arabic interface translated', () => {
  const arabic = builder('ar');
  for (const note of [linkedinRuleWindowsWarning, linkedinMixedWindowsWarning, linkedinCurrentMetadataWarning]) {
    const shown = arabic.warning(note);
    assert.notEqual(shown, note);
    assert.match(shown, /[؀-ۿ]/);
  }
});
