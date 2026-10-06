'use strict';
// Apply before styles load. Appearance never reloads a view or discards an unfinished form.
const AMCPTheme = (() => {
  const key = 'amcp.theme',
    valid = value => ['system', 'light', 'dark'].includes(value),
    system = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  let preference = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch {
    // Storage can be unavailable in private windows; appearance still works in this tab.
  }
  function sync() {
    document.querySelectorAll('[data-theme-select]').forEach(control => {
      control.value = preference;
      for (const option of control.options) option.defaultSelected = option.value === preference;
    });
  }
  function apply() {
    const resolved = preference === 'system' ? (system?.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolved === 'dark' ? '#181522' : '#f7f6fa');
    sync();
  }
  function set(value) {
    if (!valid(value)) return false;
    preference = value;
    try {
      localStorage.setItem(key, value);
    } catch {
      // The selected appearance remains available without persistent storage.
    }
    apply();
    return true;
  }
  system?.addEventListener?.('change', () => {
    if (preference === 'system') apply();
  });
  addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : 'system';
    apply();
  });
  document.addEventListener('change', event => {
    if (event.target.matches?.('[data-theme-select]')) set(event.target.value);
  });
  document.addEventListener('DOMContentLoaded', sync);
  apply();
  return Object.freeze({
    get preference() {
      return preference;
    },
    set,
    sync,
  });
})();
