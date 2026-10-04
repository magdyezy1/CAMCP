'use strict';
// Only author-selected messages are translated. Provider values, IDs, payloads and user content stay untouched.
let uiLocale = 'en',
  uiMessages = new Map(),
  uiLocaleSequence = 0;
const uiCatalogs = new Map();
const uiSlots = text =>
  [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)]
    .map(m => m[1])
    .sort()
    .join(',');
function uiText(message, values = {}) {
  message = String(message ?? '');
  return (uiMessages.get(message) ?? message).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder,
  );
}
function uiNumber(value, options = {}) {
  return (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'bigint'
    ? new Intl.NumberFormat(uiLocale, options).format(value)
    : String(value ?? '');
}
function uiRole(role) {
  switch (role) {
    case 'owner':
      return uiText('Owner');
    case 'admin':
      return uiText('Admin');
    case 'operator':
      return uiText('Operator');
    case 'reader':
    case 'viewer':
      return uiText('Viewer');
    default:
      return String(role ?? '');
  }
}
function uiDate(value, options = {dateStyle: 'medium', timeStyle: 'short'}) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(uiLocale, options).format(date)
    : uiText('Date unavailable');
}
const uiEscape = value =>
  String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
function languageControl() {
  return `<label class="language-control"><span>${uiEscape(uiText('Language'))}</span><select data-language-select aria-label="${uiEscape(uiText('Language'))}"><option value="en" lang="en" ${uiLocale === 'en' ? 'selected' : ''}>English</option><option value="ar" lang="ar" ${uiLocale === 'ar' ? 'selected' : ''}>العربية (جزئي)</option></select></label>`;
}
async function uiCatalog(locale) {
  if (locale === 'en') return new Map();
  if (locale !== 'ar') throw Error('Unsupported interface language');
  if (!uiCatalogs.has(locale)) {
    const pending = (async () => {
      const response = await fetch('/assets/locales/ar.json', {credentials: 'same-origin', cache: 'no-cache'});
      if (!response.ok) throw Error('Language catalog unavailable');
      const text = await response.text();
      if (text.length > 1048576) throw Error('Language catalog too large');
      const data = JSON.parse(text);
      if (!data || Array.isArray(data) || typeof data !== 'object') throw Error('Invalid language catalog');
      const entries = Object.entries(data);
      for (const [key, value] of entries)
        if (typeof value !== 'string' || !value.trim() || uiSlots(key) !== uiSlots(value) || /[<>]/.test(value))
          throw Error('Invalid translated message');
      return new Map(entries);
    })();
    uiCatalogs.set(locale, pending);
    pending.catch(() => uiCatalogs.delete(locale));
  }
  return uiCatalogs.get(locale);
}
function applyUILocale() {
  if (document.documentElement) {
    document.documentElement.lang = uiLocale;
    document.documentElement.dir = uiLocale === 'ar' ? 'rtl' : 'ltr';
  }
  document.querySelectorAll('[data-ui-text]').forEach(el => {
    el.textContent = uiText(el.getAttribute('data-ui-text'));
  });
  for (const [marker, attribute] of [
    ['data-ui-label', 'aria-label'],
    ['data-ui-placeholder', 'placeholder'],
    ['data-ui-title', 'title'],
  ])
    document.querySelectorAll('[' + marker + ']').forEach(el => {
      el.setAttribute(attribute, uiText(el.getAttribute(marker)));
    });
  document.querySelectorAll('[data-language-select]').forEach(el => {
    el.value = uiLocale;
  });
  document
    .querySelectorAll('a[href="/privacy"],a[href="/privacy?lang=en"],a[href="/privacy?lang=ar"]')
    .forEach(link => {
      link.setAttribute('href', '/privacy?lang=' + uiLocale);
    });
}
async function initializeUILocale() {
  const token = ++uiLocaleSequence;
  let saved;
  try {
    saved = localStorage.getItem('amcp.locale');
  } catch {
    /* Private modes may deny storage. English remains usable. */
  }
  try {
    const locale = saved === 'ar' ? 'ar' : 'en';
    const messages = await uiCatalog(locale);
    if (token !== uiLocaleSequence) return;
    uiMessages = messages;
    uiLocale = locale;
  } catch {
    if (token !== uiLocaleSequence) return;
    uiLocale = 'en';
    uiMessages = new Map();
  }
  applyUILocale();
}
function uiHasUnsavedEdits() {
  if (document.querySelector('.recovery-key') || document.querySelector('.token-secret')) return true;
  return [...document.querySelectorAll('input,select,textarea')].some(el => {
    if (el.matches('[data-language-select]') || ['hidden', 'button', 'submit', 'reset'].includes(el.type)) return false;
    if (el.type === 'file') return !!el.files?.length;
    if (['checkbox', 'radio'].includes(el.type)) return el.checked !== el.defaultChecked;
    if (el.tagName === 'SELECT') {
      const options = [...el.options],
        explicit = options.some(option => option.defaultSelected);
      return options.some(
        (option, index) => option.selected !== (explicit || el.multiple ? option.defaultSelected : index === 0),
      );
    }
    return el.value !== el.defaultValue;
  });
}
async function changeUILocale(locale) {
  if (!['en', 'ar'].includes(locale)) return false;
  if (locale === uiLocale) {
    uiLocaleSequence++;
    applyUILocale();
    return false;
  }
  const token = ++uiLocaleSequence,
    generation = typeof navigationGeneration === 'number' ? navigationGeneration : 0,
    identity = typeof identityGeneration === 'number' ? identityGeneration : 0;
  const current = () =>
    token === uiLocaleSequence &&
    generation === (typeof navigationGeneration === 'number' ? navigationGeneration : 0) &&
    identity === (typeof identityGeneration === 'number' ? identityGeneration : 0);
  try {
    if (uiHasUnsavedEdits()) {
      const confirmed = await confirmAction({
        title: uiText('Change interface language?'),
        consequence: uiText(
          'Changing language refreshes this view. Unsaved edits will be cleared. Save any recovery codes or one-time tokens first. Saved work is kept.',
        ),
        confirmLabel: uiText('Change language'),
      });
      if (!confirmed || !current()) return false;
    }
    const messages = await uiCatalog(locale);
    if (!current()) return false;
    uiMessages = messages;
    uiLocale = locale;
    try {
      localStorage.setItem('amcp.locale', locale);
    } catch {
      /* The current view can still use the selected language. */
    }
    applyUILocale();
    await render();
    (
      document.querySelector('#content [data-language-select]') ?? document.querySelector('[data-language-select]')
    )?.focus?.();
    return true;
  } catch {
    if (current()) toast(uiText('The language could not be loaded. Your current view is unchanged.'));
    return false;
  } finally {
    applyUILocale();
  }
}
document.addEventListener('change', event => {
  if (event.target.matches?.('[data-language-select]')) void changeUILocale(event.target.value);
});
