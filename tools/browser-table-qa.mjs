import assert from 'node:assert/strict';

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
      try {
        const selector = await region.evaluate(el => {
          el.dataset.browserQaScroll = 'selected';
          el.scrollLeft = 0;
          return '[data-browser-qa-scroll=selected]';
        });
        await region.focus();
        const startingPosition = await region.evaluate(el => el.scrollLeft);
        await page.keyboard.press(before.direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
        await page.waitForFunction(
          ({selector, startingPosition}) => document.querySelector(selector)?.scrollLeft !== startingPosition,
          {selector, startingPosition},
        );
      } finally {
        await region.evaluate((el, position) => {
          delete el.dataset.browserQaScroll;
          el.scrollLeft = position.scrollLeft;
          el.scrollTop = position.scrollTop;
        }, before);
      }
    }
    result.tables.push(before);
  }
}
