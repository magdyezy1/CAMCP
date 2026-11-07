// V2-EXP-01: every sentence and label AMCP writes into a chart is listed once and has Arabic in both catalogues: the
// website's (web/locales/ar.json, for the report page) and the artifact catalogue (src/report-localization.ts, for the SVG
// and the PDF). A name from a provider is never in the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectChartMessages, localeProblems} from '../tools/check-locales.mjs';
import {chartKinds, reportChartMessages} from '../dist/src/report-chart-spec.js';
import {artifactLocale} from '../dist/src/report-localization.js';

const web = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
  artifact = artifactLocale({artifact_language: 'ar'}),
  slots = text =>
    [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)]
      .map(match => match[1])
      .sort()
      .join(',');
// Campaign was translated twice before charts existed, in two words; everything else is the same text in both.
const earlierDifference = new Set(['Campaign']);

test('the gate reads the list of chart messages from the module', () => {
  const found = inspectChartMessages(fs.readFileSync('src/report-chart-spec.ts', 'utf8'));
  assert.deepEqual([...found].sort(), [...reportChartMessages].sort());
  assert.equal(new Set(reportChartMessages).size, reportChartMessages.length, 'no message is listed twice');
  assert.deepEqual(localeProblems(web, found), []);
  // A message with no Arabic is a problem the gate names.
  assert.deepEqual(localeProblems(web, new Set(['A sentence nobody translated'])), [
    'Missing Arabic message: A sentence nobody translated',
  ]);
});

test('every chart message has Arabic on the website, with the slots of its English', () => {
  for (const key of reportChartMessages) {
    assert.ok(Object.hasOwn(web, key), 'website Arabic for: ' + key);
    assert.match(web[key], /[؀-ۿ]/u, key);
    assert.equal(slots(web[key]), slots(key), 'slots of: ' + key);
    assert.ok(!/[<>]/.test(web[key]), key);
  }
});

test('every chart message has Arabic in the artifact catalogue, equal to the website’s', () => {
  for (const key of reportChartMessages) {
    const text = artifact.text(key);
    assert.notEqual(text, key, 'artifact Arabic for: ' + key);
    assert.match(text, /[؀-ۿ]/u, key);
    assert.equal(slots(text), slots(key), 'slots of: ' + key);
    if (!earlierDifference.has(key)) assert.equal(text, web[key], 'the two catalogues agree on: ' + key);
  }
});

test('the label of every chart kind is one of the messages', () => {
  assert.equal(chartKinds.length, 6);
  for (const kind of chartKinds) assert.ok(reportChartMessages.includes(kind.label), kind.label);
});

test('no message names a provider, and none carries markup', () => {
  for (const key of reportChartMessages) {
    assert.doesNotMatch(key, /meta|google|tiktok|snapchat|linkedin|microsoft|reddit|apple|x ads/i, key);
    assert.doesNotMatch(key, /[<>&]/, key);
  }
});
