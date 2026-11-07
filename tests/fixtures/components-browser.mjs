// V2-WEB-02 rendered cases for the component state page (/design-system): every component is driven with the keys a person
// uses, in English and Arabic, light and dark, at 320, 375, 768 and 1280 pixels. The runner has already run the generic
// checks on the page (axe, focus rings, overflow, the Arabic leak probe); this adds what only a component knows: target
// sizes, the one focus style, the keyboard model of each component, right-to-left behaviour, the open dialog and sheet
// (inert page, trapped Tab, Escape, focus returned), toasts that never take focus, and forced colours.
import assert from 'node:assert/strict';
import path from 'node:path';

const sections = [
  'buttons',
  'badges',
  'chips',
  'fields',
  'choosing',
  'combobox',
  'tree',
  'table',
  'feedback',
  'cards',
  'overlays',
];
/** Every control a person can press, at least 24 by 24 CSS pixels (WCAG 2.2, 2.5.8); a primary action at least 44. */
const targetSelector = [
  '.amcp-button',
  '.amcp-chip',
  '.amcp-chip-remove',
  '.amcp-tab',
  '.amcp-segment-label',
  '.amcp-combobox-toggle',
  '.amcp-tree-expander',
  '.amcp-check',
  '.amcp-ds-index a',
].join(',');

async function key(page, name) {
  await page.keyboard.press(name);
}
/** Focus by keyboard modality: a key press first, so :focus-visible applies to the element focused by script. */
async function focusByKeyboard(page, locator) {
  await page.keyboard.press('Shift');
  await locator.focus();
}
async function attribute(locator, name) {
  return locator.getAttribute(name);
}

async function checkGeometry(page, result) {
  result.component_targets = await page.evaluate(
    ({targetSelector}) => {
      const visible = element =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      const describe = element => element.tagName.toLowerCase() + '.' + [...element.classList].slice(0, 2).join('.');
      return [...document.querySelectorAll('.amcp-ds ' + targetSelector.split(',').join(', .amcp-ds '))]
        .filter(element => visible(element) && !element.closest('[hidden], [inert]'))
        .map(element => {
          const box = element.getBoundingClientRect();
          return {
            name: describe(element),
            text: (element.getAttribute('aria-label') ?? element.textContent).trim().slice(0, 30),
            width: Math.round(box.width),
            height: Math.round(box.height),
            primary: element.matches('[data-variant=primary]'),
          };
        });
    },
    {targetSelector},
  );
  const small = result.component_targets.filter(target => target.width < 24 || target.height < 24);
  assert.deepEqual(small, [], 'Components have targets below 24 by 24 pixels');
  const primaries = result.component_targets.filter(target => target.primary);
  assert.ok(primaries.length > 0, 'The page shows primary buttons');
  assert.deepEqual(
    primaries.filter(target => target.width < 44 || target.height < 44),
    [],
    'A primary action is at least 44 by 44 pixels',
  );
  const escaped = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll('.amcp-ds-specimen > *, .amcp-ds-specimen .amcp-table')]
      .filter(
        element => element.getClientRects().length && !element.closest('.amcp-table-scroll, .amcp-tablist, [hidden]'),
      )
      .filter(element => {
        const box = element.getBoundingClientRect();
        return box.right > width + 1 || box.left < -1;
      })
      .map(element => element.className)
      .slice(0, 8);
  });
  assert.deepEqual(escaped, [], 'A component spills past the viewport');
}

/** The ring of the focused element against the surface behind it, from the computed styles (any colour syntax). */
async function focusRing(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
    const rgba = value => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = '#000';
      canvas.fillStyle = value;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      return {r, g, b, a: a / 255};
    };
    const channel = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const luminance = c => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    const ratio = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (high + 0.05) / (low + 0.05);
    };
    const element = document.activeElement,
      style = getComputedStyle(element);
    let surface = {r: 255, g: 255, b: 255, a: 1};
    for (let node = element.parentElement; node; node = node.parentElement) {
      const colour = rgba(getComputedStyle(node).backgroundColor);
      if (colour.a === 1) {
        surface = colour;
        break;
      }
    }
    // A tree item draws its ring on its row; a segmented radio on its label.
    const target = element.matches('.amcp-tree-item') ? element.querySelector(':scope > .amcp-tree-row') : element;
    const ring = getComputedStyle(element.matches('.amcp-segment-input') ? element.nextElementSibling : target);
    return {
      name: element.tagName.toLowerCase() + '.' + [...element.classList].slice(0, 2).join('.'),
      focusVisible: element.matches(':focus-visible'),
      style: ring.outlineStyle,
      width: Number.parseFloat(ring.outlineWidth),
      ratio: ratio(rgba(ring.outlineColor), surface),
      own: style.outlineStyle,
    };
  });
}
async function expectRing(page, name) {
  const ring = await focusRing(page);
  assert.equal(ring.focusVisible, true, name + ' shows keyboard focus (' + ring.name + ')');
  assert.equal(ring.style, 'solid', name + ' has a solid focus ring');
  assert.ok(ring.width >= 2, name + ' ring is at least 2px: ' + ring.width);
  assert.ok(ring.ratio >= 3, name + ' ring needs 3:1, measured ' + ring.ratio.toFixed(2));
}

async function exerciseKeyboard(page, locale, result) {
  const rtl = locale === 'ar',
    forward = rtl ? 'ArrowLeft' : 'ArrowRight',
    back = rtl ? 'ArrowRight' : 'ArrowLeft';
  // Buttons: the shared focus style.
  const primary = page
    .locator('#section-buttons .amcp-button[data-variant=primary]:not([data-state]):not([disabled])')
    .first();
  await focusByKeyboard(page, primary);
  await expectRing(page, 'Primary button');
  await focusByKeyboard(
    page,
    page.locator('#section-buttons .amcp-button[data-variant=secondary]:not([data-state]):not([disabled])').first(),
  );
  await expectRing(page, 'Secondary button');

  // Filter chips: Space and Enter toggle; the pressed state is in ARIA.
  const chip = page.locator('#section-chips [data-mode=multi] .amcp-chip').nth(1);
  await focusByKeyboard(page, chip);
  await expectRing(page, 'Chip');
  const before = await attribute(chip, 'aria-pressed');
  await key(page, 'Space');
  assert.notEqual(await attribute(chip, 'aria-pressed'), before, 'Space toggles a filter chip');
  await key(page, 'Space');
  assert.equal(await attribute(chip, 'aria-pressed'), before);
  const remove = page.locator('#section-chips button[data-chip-remove]').first();
  await remove.click();
  assert.equal(await page.locator('#section-chips button[data-chip-remove]').count(), 2, 'a removable chip leaves');

  // Fields: an error field is announced and named; focus is the inset ring on the input.
  const named = await page.evaluate(() => {
    const input = document.querySelector('#ds-text-error');
    return {
      invalid: input.getAttribute('aria-invalid'),
      described: input
        .getAttribute('aria-describedby')
        .split(' ')
        .map(id => document.getElementById(id)?.textContent.trim()),
    };
  });
  assert.equal(named.invalid, 'true');
  assert.ok(named.described.every(Boolean), 'the error text is linked to its field');
  await focusByKeyboard(page, page.locator('#ds-text'));
  await expectRing(page, 'Text input');
  await page.locator('#ds-number').fill('12,345.60');
  assert.equal(await page.locator('#ds-number').inputValue(), '12,345.60', 'a number is kept exactly as typed');

  // Segmented control and tabs.
  const radio = page.locator('#section-choosing input[name=ds-density]').first();
  await focusByKeyboard(page, radio);
  await expectRing(page, 'Segmented control');
  await key(page, forward);
  assert.equal(
    await page.locator('#section-choosing input[name=ds-density][value=compact]').isChecked(),
    true,
    'the arrow selects the next segment',
  );
  const tabs = page.locator('#ds-tabs [role=tab]');
  await focusByKeyboard(page, tabs.nth(0));
  await expectRing(page, 'Tab');
  await key(page, forward);
  assert.equal(await attribute(tabs.nth(1), 'aria-selected'), 'true', 'the next arrow selects the next tab');
  assert.equal(await page.locator('#ds-tabs [role=tabpanel]:not([hidden])').count(), 1);
  await key(page, 'End');
  assert.equal(
    await attribute(tabs.nth(2), 'aria-selected'),
    'true',
    'End goes to the last enabled tab, skipping the disabled one',
  );
  await key(page, back);
  assert.equal(await attribute(tabs.nth(1), 'aria-selected'), 'true');
  await key(page, 'Home');
  assert.equal(await attribute(tabs.nth(0), 'aria-selected'), 'true');
  const manual = page.locator('#ds-tabs-manual [role=tab]');
  await focusByKeyboard(page, manual.nth(0));
  await key(page, forward);
  assert.equal(await attribute(manual.nth(1), 'aria-selected'), 'false', 'manual activation waits');
  await key(page, 'Enter');
  assert.equal(await attribute(manual.nth(1), 'aria-selected'), 'true');

  // Searchable list: typing filters, arrows move by reference, Enter chooses, Escape closes.
  const accounts = page.locator('#ds-accounts');
  await focusByKeyboard(page, accounts);
  await expectRing(page, 'Searchable list');
  await accounts.fill('harbor');
  assert.equal(await attribute(accounts, 'aria-expanded'), 'true');
  const options = page.locator('#ds-accounts-listbox [role=option]');
  assert.equal(await options.count(), 8, 'the list is cut at its limit of eight, so it never scrolls');
  assert.match(await page.locator('#ds-accounts-status').innerText(), /\d/, 'the list says how many results there are');
  await key(page, 'ArrowDown');
  await key(page, 'ArrowDown');
  const active = await attribute(accounts, 'aria-activedescendant');
  assert.equal(await attribute(options.nth(1), 'id'), active, 'the active option is named by aria-activedescendant');
  const label = (await options.nth(1).locator('.amcp-option-label').innerText()).trim();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ds-accounts', 'focus stays in the text box');
  await key(page, 'Enter');
  assert.equal(await accounts.inputValue(), label);
  assert.equal(await attribute(accounts, 'aria-expanded'), 'false');
  await accounts.fill('zzz');
  assert.match(
    await page.locator('#ds-accounts-root .amcp-listbox-note').innerText(),
    /zzz/,
    'an empty result says what was searched',
  );
  assert.equal(await page.locator('#ds-accounts-root button[data-combobox-clear]').count(), 1, 'and offers one way on');
  await key(page, 'Escape');
  await key(page, 'Escape');
  assert.equal(await accounts.inputValue(), label, 'Escape twice puts the chosen value back');
  assert.match(await page.locator('#ds-loading-root .amcp-listbox-note').innerText(), /\S/);
  assert.equal(await attribute(page.locator('#ds-failed-root'), 'aria-busy'), null);
  await page.locator('#ds-failed-root button[data-combobox-retry]').click();
  await page.locator('#ds-failed-listbox [role=option]').first().waitFor();

  // Scope tree.
  const first = page.locator('#ds-tree [role=treeitem]').first();
  await focusByKeyboard(page, first);
  await expectRing(page, 'Tree item');
  const summary = page.locator('#ds-tree-summary');
  const summaryBefore = await summary.innerText();
  await key(page, 'ArrowDown');
  await key(page, 'Space');
  assert.notEqual(await summary.innerText(), summaryBefore, 'checking an item changes the count');
  assert.equal(
    await attribute(page.locator('#ds-tree [data-node=meta]'), 'aria-checked'),
    'mixed',
    'a parent with some leaves checked is mixed',
  );
  await key(page, forward);
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute('data-node')),
    'meta-a1',
    'the arrow into an open branch enters it',
  );

  // Table: the column chooser and the density toggle, then the region scrolls by keyboard.
  const columnsButton = page.locator('#ds-table .amcp-menu > summary');
  await columnsButton.click();
  await page.locator('#ds-table .amcp-menu-panel input[value=rate]').uncheck();
  assert.equal(await page.locator('#ds-table thead th[data-col=rate]').isHidden(), true);
  await key(page, 'Escape');
  assert.equal(
    await page.evaluate(() => document.activeElement.tagName),
    'SUMMARY',
    'Escape closes the chooser and returns focus to it',
  );
  await page
    .locator('#ds-table-density-compact, #ds-table input[name=ds-table-density][value=compact]')
    .first()
    .check({force: true});
  assert.equal(await attribute(page.locator('#ds-table'), 'data-density'), 'compact');
  const region = page.locator('#ds-table .amcp-table-scroll');
  assert.equal(await attribute(region, 'role'), 'region');
  assert.equal(await region.evaluate(el => el.tabIndex), 0);
  result.table_sticky = await page.evaluate(() => {
    const head = document.querySelector('#ds-table thead th'),
      cell = document.querySelector('#ds-table tbody th');
    return {
      row: getComputedStyle(document.querySelector('#ds-table tbody tr')).display,
      head: getComputedStyle(head).position,
      cell: getComputedStyle(cell).position,
    };
  });
  // A table 40rem wide or more keeps its header and first column in view; narrower, each row is a card (exerciseCards).
  if (result.table_sticky.row === 'table-row')
    assert.deepEqual(
      [result.table_sticky.head, result.table_sticky.cell],
      ['sticky', 'sticky'],
      'the header and first column are sticky',
    );
  else assert.equal(result.table_sticky.row, 'grid', 'a narrow table is a stack of cards');
}

async function exerciseCards(page, width, result) {
  // The narrow table is cards at every window width, because the container query reads the table's own width.
  result.card_table = await page.evaluate(() => {
    const row = document.querySelector('#ds-table-narrow tbody tr'),
      head = document.querySelector('#ds-table-narrow thead');
    return {display: getComputedStyle(row).display, headerHidden: head.getBoundingClientRect().width <= 1};
  });
  assert.equal(result.card_table.display, 'grid', 'below 40rem each row is a card');
  assert.equal(
    result.card_table.headerHidden,
    true,
    'and the header row is out of sight but kept for assistive technology',
  );
  const wide = await page.evaluate(() => getComputedStyle(document.querySelector('#ds-table tbody tr')).display);
  if (width >= 768) assert.equal(wide, 'table-row', 'a wide table stays a table');
}

async function exerciseOverlays(page, locale, output, id, checks, result) {
  const rtl = locale === 'ar';
  const inertShell = () => page.evaluate(() => document.querySelector('.app-shell')?.inert === true),
    gone = () => page.locator('dialog.amcp-dialog').waitFor({state: 'detached'});
  // A confirmation dialog.
  const opener = page.locator('[data-ds-action=dialog-confirm]');
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  const dialog = page.locator('dialog.amcp-dialog[open]');
  await dialog.waitFor();
  assert.equal(await attribute(dialog, 'role'), 'alertdialog');
  assert.equal(await inertShell(), true, 'the page behind the dialog is inert');
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute('data-dialog-action')),
    'cancel',
    'focus starts on the safe choice',
  );
  await focusByKeyboard(page, page.locator('dialog.amcp-dialog[open] [data-dialog-action=cancel]'));
  await expectRing(page, 'Dialog button');
  await page.screenshot({path: path.join(output, id + '-dialog.png')});
  await checks.intermediate('dialog-open');
  const order = [];
  for (let step = 0; step < 4; step++) {
    order.push(
      await page.evaluate(
        () =>
          document.activeElement.getAttribute('data-dialog-action') ??
          (document.activeElement.hasAttribute('data-dialog-close') ? 'close' : '?'),
      ),
    );
    await key(page, 'Tab');
  }
  assert.equal(
    new Set(order).size,
    3,
    'Tab cycles through the close button and the two actions only: ' + order.join(','),
  );
  assert.equal(
    await page.evaluate(() => !!document.activeElement.closest('dialog')),
    true,
    'focus never leaves the dialog',
  );
  await key(page, 'Escape');
  await gone();
  assert.equal(await inertShell(), false, 'the page is usable again');
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute('data-ds-action')),
    'dialog-confirm',
    'focus returns to the button that opened it',
  );
  assert.equal(await page.locator('#ds-toasts .amcp-toast').count(), 1, 'the answer is a toast');
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute('data-ds-action')),
    'dialog-confirm',
    'a toast does not take focus',
  );

  // A form dialog that fails, then succeeds.
  await page.locator('[data-ds-action=dialog-save]').click();
  await page.locator('dialog.amcp-dialog[open]').waitFor();
  await page.locator('dialog.amcp-dialog[open] [data-dialog-action=save]').click();
  assert.equal(await attribute(page.locator('dialog.amcp-dialog[open] [data-amcp=dialog]'), 'aria-busy'), 'true');
  await page.locator('dialog.amcp-dialog[open] .amcp-dialog-error:not([hidden])').waitFor();
  assert.equal(await attribute(page.locator('dialog.amcp-dialog[open] .amcp-dialog-error'), 'role'), 'alert');
  await checks.intermediate('dialog-error');
  await page.locator('dialog.amcp-dialog[open] [data-dialog-action=save]').click();
  await page.locator('dialog.amcp-dialog').waitFor({state: 'detached'});

  // The modal sheet sits at the end edge: the right in English, the left in Arabic.
  await page.locator('[data-ds-action=sheet-modal]').click();
  const sheet = page.locator('dialog.amcp-dialog[data-kind=sheet][open]');
  await sheet.waitFor();
  const box = await sheet.boundingBox(),
    viewport = page.viewportSize();
  result.sheet_box = {left: Math.round(box.x), right: Math.round(box.x + box.width), width: viewport.width};
  if (rtl)
    assert.ok(
      result.sheet_box.left <= 2,
      'the Arabic sheet is against the left edge: ' + JSON.stringify(result.sheet_box),
    );
  else
    assert.ok(
      result.sheet_box.right >= viewport.width - 2,
      'the sheet is against the right edge: ' + JSON.stringify(result.sheet_box),
    );
  await page.screenshot({path: path.join(output, id + '-sheet.png')});
  await checks.intermediate('sheet-open');
  await key(page, 'Escape');
  await gone();

  // The non-modal sheet leaves the page usable.
  await page.locator('[data-ds-action=sheet-side]').click();
  const side = page.locator('dialog.amcp-dialog[data-kind=sheet][open]');
  await side.waitFor();
  assert.equal(await inertShell(), false, 'a sheet beside the page does not make it inert');
  await key(page, 'Escape');
  await gone();

  // Toasts: each tone, never focused, success leaves by itself.
  for (const tone of ['success', 'info', 'warning', 'danger'])
    await page.locator('[data-ds-action=toast-' + tone + ']').click();
  const toasts = page.locator('#ds-toasts .amcp-toast');
  assert.ok((await toasts.count()) >= 1 && (await toasts.count()) <= 3, 'at most three toasts stack');
  assert.equal(
    await page.evaluate(() => !!document.activeElement.closest('.amcp-toasts')),
    false,
    'a toast never takes focus',
  );
  assert.equal(await attribute(page.locator('#ds-toasts ol'), 'aria-live'), 'polite');
  await page.screenshot({path: path.join(output, id + '-toasts.png')});
  await checks.intermediate('toasts');
  // Each Dismiss button removes its toast: the first one is clicked until none is left.
  const dismiss = page.locator('#ds-toasts [data-toast-dismiss]');
  while (await dismiss.count()) await dismiss.first().click();
  assert.equal(await page.locator('#ds-toasts .amcp-toast').count(), 0);
}

async function exerciseForcedColours(page, result) {
  await page.emulateMedia({forcedColors: 'active'});
  try {
    result.forced_colours = await page.evaluate(() => {
      const style = selector => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element) : null;
      };
      const pressed = style('#section-chips .amcp-chip[aria-pressed=true]'),
        marker = style('#section-badges .amcp-marker'),
        error = style('#ds-text-error-root .amcp-control, #ds-fields .amcp-control[data-state=error]');
      return {
        pressedBorder: pressed ? Number.parseFloat(pressed.borderTopWidth) : null,
        markerVisible: marker ? marker.backgroundColor !== 'rgba(0, 0, 0, 0)' : null,
        errorBorder: error ? Number.parseFloat(error.borderTopWidth) : null,
      };
    });
    assert.ok(result.forced_colours.pressedBorder >= 1, 'a pressed chip keeps a border in forced colours');
    await focusByKeyboard(
      page,
      page.locator('#section-buttons .amcp-button[data-variant=primary]:not([data-state]):not([disabled])').first(),
    );
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return {style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth)};
    });
    assert.equal(ring.style, 'solid', 'the focus ring survives forced colours');
    assert.ok(ring.width >= 2);
  } finally {
    await page.emulateMedia({forcedColors: 'none'});
  }
}

export async function exerciseComponents({page, locale, width, output, id, result, checks}) {
  for (const section of sections)
    assert.equal(
      await page.locator('#section-' + section + ' > h2').count(),
      1,
      'The state page has the ' + section + ' section',
    );
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector('.amcp-ds')).direction),
    locale === 'ar' ? 'rtl' : 'ltr',
  );
  await checkGeometry(page, result);
  await exerciseCards(page, width, result);
  await exerciseKeyboard(page, locale, result);
  await exerciseOverlays(page, locale, output, id, checks, result);
  await exerciseForcedColours(page, result);
  await checks.intermediate('components-final');
}
