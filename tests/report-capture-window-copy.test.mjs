// The TikTok capture note on the evidence page said "Choose 1–31 closed days" while the presets (and the collector) take
// 1–366 days read in spans of 30. The page's sentence is now held to the server's preset, so the two cannot drift again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {reportPresets} from '../dist/src/report-presets.js';

const bound = text => {
  const match = /(\d+)[–-](\d+) closed days/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
};

test('the TikTok capture note states the day bound of the TikTok presets, and its Arabic entry says the same', () => {
  const source = fs.readFileSync('web/evidence-workflows.js', 'utf8'),
    catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    note = /'(TikTok uses advertiser-local daily dates[^']+)'/.exec(source)?.[1];
  assert.ok(note, 'the capture note is in the page');
  const presets = reportPresets.filter(preset => preset.id.startsWith('tiktok_'));
  assert.equal(presets.length, 3);
  for (const preset of presets) assert.deepEqual(bound(note), bound(preset.meaning), preset.id);
  assert.deepEqual(bound(note), [1, 366]);
  const arabic = catalog[note];
  assert.ok(arabic, 'the sentence has Arabic');
  assert.match(arabic, /366/);
  assert.doesNotMatch(arabic, /(^|\D)31(\D|$)/);
  // No catalogue entry keeps the earlier wording of the sentence (it had no readers, and said 1–31).
  assert.equal(
    Object.keys(catalog).filter(key => key.startsWith('TikTok uses advertiser-local daily dates')).length,
    1,
    'one entry for the sentence',
  );
});
