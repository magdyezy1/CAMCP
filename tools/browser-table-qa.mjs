import assert from 'node:assert/strict';

/**
 * Whether the scroll region that took the key press has moved (run in the page by waitForFunction). It must be the
 * same element, still in the document: the earlier wait looked the region up again by a marker selector, and once a
 * re-render replaced it querySelector returned null, `undefined !== startingPosition` held and the wait passed without
 * any scroll. A detached element now throws, which fails the wait at once instead of passing or timing out.
 */
export function regionScrolled({element, startingPosition}) {
  if (!element || !element.isConnected)
    throw new Error('BROWSER_TABLE_REGION_DETACHED: the table scroll region left the document before it scrolled');
  return element.scrollLeft !== startingPosition;
}

export async function checkBrowserTables(page, result) {
  result.tables = [];
  for (const region of await page.locator('.report-table-wrap[role=region],.data-scroll[role=region]').all()) {
    if (!(await region.isVisible()) || !(await region.locator('table').count())) continue;
    const before = await region.evaluate(el => ({
      width: el.clientWidth,
      scrollWidth: el.scrollWidth,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      direction: getComputedStyle(el).direction,
      caption: el.querySelector('caption')?.textContent.trim(),
      label: el.getAttribute('aria-label'),
      tabIndex: el.tabIndex,
    }));
    assert.ok(before.caption && before.label, 'Native table needs a caption and named region');
    assert.equal(before.tabIndex, 0, 'Native table scroll region needs keyboard access');
    if (before.scrollWidth > before.width + 1) {
      // The element itself, not a selector that a re-render could leave pointing at nothing.
      const element = await region.elementHandle();
      try {
        await element.evaluate(el => {
          el.scrollLeft = 0;
        });
        await region.focus();
        const startingPosition = await element.evaluate(el => el.scrollLeft);
        await page.keyboard.press(before.direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
        await page.waitForFunction(regionScrolled, {element, startingPosition});
        // Read once more after the wait: the same element is attached and has moved.
        const after = await element.evaluate(el => ({connected: el.isConnected, scrollLeft: el.scrollLeft}));
        assert.equal(after.connected, true, 'Native table scroll region left the document');
        assert.notEqual(after.scrollLeft, startingPosition, 'Native table scroll region did not scroll by keyboard');
      } finally {
        await element.evaluate((el, position) => {
          el.scrollLeft = position.scrollLeft;
          el.scrollTop = position.scrollTop;
        }, before);
        await element.dispose();
      }
    }
    result.tables.push(before);
  }
}
