import assert from 'node:assert/strict';

// RPT-05 changed how retained native rows render, on purpose: long native resource names sit behind a per-viewer
// "Show native IDs" toggle (hidden by default) and are middle-truncated with a copy button; decimals show one
// locale-formatted value with the exact original in a <data value> element; native location types read as plain
// labels with the native enum in an <abbr title>. Browser QA keeps asserting exact native values, read from those
// exact carriers instead of the shortened display text, and asserts the presentation contract itself.

/** The exact native value a retained-row cell carries: its <code title>, <data value> or <abbr title>, else its text. */
export function nativeCellValue(cell) {
  return cell.evaluate(node => {
    const exact = node.querySelector('code[title], data[value], abbr[title]');
    if (!exact) return node.textContent.trim();
    return exact.tagName === 'DATA' ? exact.getAttribute('value') : exact.getAttribute('title');
  });
}

/** The exact totals of the report summary: each metric's <data value>, or its text when display and value agree. */
export function exactMetrics(page) {
  return page
    .locator('.workspace-metrics strong')
    .evaluateAll(cells =>
      cells.map(cell => cell.querySelector('data[value]')?.getAttribute('value') ?? cell.textContent.trim()),
    );
}

/** The exact values every retained row shows in its current page (`data[value]` or text per cell). */
export function exactRowValues(page) {
  return page.locator('#report-native-rows tbody tr').evaluateAll(rows =>
    rows.map(row =>
      [...row.cells].map(cell => {
        const exact = cell.querySelector('code[title], data[value], abbr[title]');
        if (!exact) return cell.textContent.trim();
        return exact.tagName === 'DATA' ? exact.getAttribute('value') : exact.getAttribute('title');
      }),
    ),
  );
}

/**
 * Asserts that long native resource names start hidden, then shows them with the keyboard. Returns what was checked.
 * The toggle keeps focus, the table gains the hidden columns, and every shortened ID keeps its full value in the
 * tooltip and on its labelled copy button.
 */
export async function showNativeIds(page, hiddenLabels) {
  const toggle = page.locator('#evidence-native-ids'),
    headings = () => page.locator('#report-native-rows thead th').allInnerTexts();
  assert.equal(await toggle.isChecked(), false, 'Long native resource names are hidden by default (RPT-05)');
  const before = await headings();
  for (const label of hiddenLabels)
    assert.equal(
      before.some(text => text.startsWith(label)),
      false,
      label + ' starts hidden',
    );
  await toggle.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(
    count => document.querySelectorAll('#report-native-rows thead th').length === count,
    before.length + hiddenLabels.length,
  );
  assert.equal(await page.evaluate(() => document.activeElement.id), 'evidence-native-ids', 'The toggle keeps focus');
  assert.equal(await page.locator('#evidence-native-ids').isChecked(), true);
  const after = await headings();
  for (const label of hiddenLabels)
    assert.equal(
      after.some(text => text.startsWith(label)),
      true,
      label + ' is shown on request',
    );
  const copies = await page.locator('#report-native-rows tbody [data-copy-native]').evaluateAll(buttons =>
    buttons.map(button => ({
      value: button.dataset.copyNative,
      label: button.getAttribute('aria-label'),
      shown: button.previousElementSibling?.tagName === 'CODE' ? button.previousElementSibling.textContent : null,
      title: button.previousElementSibling?.getAttribute('title') ?? null,
    })),
  );
  for (const copy of copies) {
    assert.equal(copy.title, copy.value, 'A shortened ID keeps its full value in the tooltip');
    assert.ok(copy.label?.includes(copy.value), 'The copy button names the full ID it copies');
    assert.ok(copy.shown?.includes('…') && copy.shown.length < copy.value.length, 'Long IDs are middle-truncated');
  }
  return {hidden_by_default: hiddenLabels.length, shortened_ids_with_copy: copies.length};
}

/**
 * The visual lines a cell's native text occupies. Inline carriers such as <data> or <code> add a box per element
 * on the same line, so lines are counted as vertically separate groups of text rectangles, ignoring the copy button.
 */
export function nativeTextLines(cells) {
  return cells.evaluateAll(nodes =>
    nodes.map(cell => {
      const tops = [];
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent.trim() || text.parentElement.closest('button')) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) if (rect.width && rect.height) tops.push(rect);
      }
      tops.sort((a, b) => a.top - b.top);
      let lines = 0,
        bottom = -Infinity;
      for (const rect of tops)
        if (rect.top + rect.height / 2 > bottom) {
          lines++;
          bottom = rect.bottom;
        } else bottom = Math.max(bottom, rect.bottom);
      return {value: cell.textContent, lines};
    }),
  );
}
