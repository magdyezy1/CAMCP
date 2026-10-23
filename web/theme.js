'use strict';
// The server versions the complete public snapshot. Lazy modules and locale data use that same identity.
const AMCPAssets = (() => {
  const source = document.currentScript?.getAttribute?.('src') ?? '',
    version = /^\/assets\/v\/([0-9a-f]{64})\/theme\.js$/.exec(source)?.[1];
  return Object.freeze({
    url(path) {
      if (
        !/^\/assets\/[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(path) ||
        path
          .slice(8)
          .split('/')
          .some(part => !part || part.startsWith('.'))
      )
        throw Error('INVALID_PUBLIC_ASSET_PATH');
      return version ? '/assets/v/' + version + '/' + path.slice(8) : path;
    },
  });
})();
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
    // The light and the dark meta both take the chosen theme.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]'))
      meta.setAttribute('content', resolved === 'dark' ? '#181522' : '#f7f6fa');
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
  // A language link on the static pages (privacy, terms, data deletion) also chooses the workspace language, so the
  // workspace opens in it next time. The page itself follows its address, with or without storage (WEB-05).
  document.addEventListener('click', event => {
    const choice = event.target?.closest?.('a[data-locale-choice]')?.getAttribute('data-locale-choice');
    if (choice !== 'en' && choice !== 'ar') return;
    try {
      localStorage.setItem('amcp.locale', choice);
    } catch {
      // Private windows may deny storage; the chosen page still opens in its language.
    }
  });
  apply();
  return Object.freeze({
    get preference() {
      return preference;
    },
    set,
    sync,
  });
})();
