// Browser-case helpers for the shell's own controls (V2-WEB-03). The appearance and language controls sit in the header on a
// wide screen and in the navigation drawer below 851px, where the header keeps only the logo, the client switcher, search
// and the menu; a case that changes the appearance goes where the control is. A page without the workspace shell (About)
// has no menu button and keeps its own control in its header.

/** Runs `action` with the visible appearance select, opening the drawer first where that is where the control is. */
export async function withAppearanceSelect(page, action) {
  if (!(await page.locator('#menu-toggle').isVisible()))
    return action(page.locator('[data-theme-select]:visible').first());
  await page.locator('#menu-toggle').click();
  const inDrawer = page.locator('#workspace-sidebar [data-theme-select]');
  await inDrawer.waitFor({state: 'visible'});
  const out = await action(inDrawer);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.classList.contains('menu-open'));
  return out;
}
/** Chooses an appearance (`system`, `light` or `dark`) wherever the shell keeps the control. */
export const selectAppearance = (page, value) => withAppearanceSelect(page, select => select.selectOption(value));
/** The appearance the control shows now. */
export const appearanceChoice = page => withAppearanceSelect(page, select => select.inputValue());
