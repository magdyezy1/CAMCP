import test from 'node:test';
import assert from 'node:assert/strict';
import {pdfTextLines} from '../dist/src/pdf-text.js';

const width = text => Array.from(text).length;
test('Arabic words remain in logical order within shaped runs while mixed Latin IDs and decimals stay left to right', () => {
  const [line] = pdfTextLines('تقرير الأداء - AMCP 2026', 100, width);
  assert.equal(line.rtl, true);
  assert.deepEqual(
    line.runs.map(r => r.text),
    ['AMCP 2026', 'تقرير الأداء - '],
  );
  assert.equal(line.logical, 'تقرير الأداء - AMCP 2026');
  const [metrics] = pdfTextLines('الإنفاق 12.50 USD | الحساب 00100', 100, width);
  const values = metrics.runs.map(r => r.text).join('|');
  assert.match(values, /12\.50/);
  assert.match(values, /00100/);
  assert.match(values, /USD/);
  assert.doesNotMatch(values, /05\.21|00100.*00100|DSU/);
});

test('Arabic paragraphs wrap in logical reading order, retain whole words and keep each painted line bounded', () => {
  const text = 'هذا تقرير عربي طويل لاختبار التفاف الكلمات داخل الصفحة';
  const lines = pdfTextLines(text, 17, width);
  assert.ok(lines.length > 1);
  assert.equal(lines.map(l => l.logical).join(' '), text);
  for (const line of lines) {
    assert.ok(line.width <= 17);
    assert.equal(line.rtl, true);
  }
  assert.ok(pdfTextLines('12345678901234567890', 5, width).every(l => l.width <= 5));
});

test('bidirectional punctuation and combining marks remain bounded; explicit controls are not drawn as glyphs', () => {
  const [line] = pdfTextLines('تقرير (AMCP 2026) مُراجع', 100, width);
  assert.equal(line.logical, 'تقرير (AMCP 2026) مُراجع');
  assert.ok(line.runs.some(r => r.text.includes('مُراجع')));
  assert.ok(line.runs.some(r => r.text.includes('AMCP 2026')));
  assert.ok(line.runs[0].text.startsWith('('), 'The left visual bracket must open after Arabic shaping.');
  assert.ok(line.runs.at(-1).text.endsWith(')'), 'The right visual bracket must close after Arabic shaping.');
  const controls = pdfTextLines('المعرّف \u2066ID-001\u2069', 100, width);
  assert.doesNotMatch(
    controls
      .flatMap(l => l.runs)
      .map(r => r.text)
      .join(''),
    /[\u2066-\u2069]/,
  );
  const [native] = pdfTextLines('جُمع في \u20682026-09-08T00:00:00.000Z\u2069', 100, width);
  assert.ok(native.runs.some(r => r.text === '2026-09-08T00:00:00.000Z'));
  const [numeric] = pdfTextLines('الإنفاق ١٢٫٥٠', 100, width);
  assert.ok(numeric.runs.some(r => r.text === '١٢٫٥٠' && !r.rtl));
});
