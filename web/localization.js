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
/**
 * An error's text for display (WEB-05). Its next action is always AMCP's guidance and is translated. Its message is
 * AMCP's own unless the error carries a provider object: then the provider's message is shown exactly as written and
 * nothing in it is translated.
 */
function uiOwnedError(error) {
  if (!error || typeof error !== 'object') return {message: '', nextAction: ''};
  const provider = error.provider && typeof error.provider === 'object' ? error.provider : null,
    message =
      typeof provider?.message === 'string' ? provider.message : typeof error.message === 'string' ? error.message : '';
  return {
    message: provider ? message : uiText(message),
    nextAction: typeof error.next_action === 'string' ? uiText(error.next_action) : '',
  };
}
/** The workspace's name; the unedited default ("<owner>’s workspace") reads in the interface language (WEB-05). */
function uiWorkspaceName(name, owner) {
  if (typeof name !== 'string' || !name) return uiText('AMCP workspace');
  return typeof owner === 'string' && owner && name === owner + '’s workspace'
    ? uiText('{name}’s workspace', {name: owner})
    : name;
}
/** A list in the interface language's own conjunction and separators (Arabic uses "،" and "و"). */
function uiList(items) {
  const values = [...items].map(String);
  try {
    return new Intl.ListFormat(uiLocale, {style: 'long', type: 'conjunction'}).format(values);
  } catch {
    return values.join(', ');
  }
}
// Digits are Latin in both languages (owner decision D27); naming the numbering system keeps a runtime whose Arabic
// default is Arabic-Indic from changing them (WEB-05).
function uiNumber(value, options = {}) {
  return (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'bigint'
    ? new Intl.NumberFormat(uiLocale, {numberingSystem: 'latn', ...options}).format(value)
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
    ? new Intl.DateTimeFormat(uiLocale, {numberingSystem: 'latn', ...options}).format(date)
    : uiText('Date unavailable');
}
/** An audit, session or token time with its time zone, so a reader elsewhere cannot misread it (WEB-05, D27). */
function uiDateZoned(value) {
  return uiDate(value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
/** The viewer's own IANA time zone, or UTC when the runtime does not report one. */
function uiViewerTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
/** A wall-clock time in `timeZone` with that zone's abbreviation for that date (EDT or EST, for example). */
function uiZonedTime(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return uiText('Date unavailable');
  try {
    return new Intl.DateTimeFormat(uiLocale, {
      numberingSystem: 'latn',
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return uiDateZoned(value);
  }
}
/**
 * A schedule time (EXP-04, owner policy P6): the delivery time zone first, named, then the viewer's own time when the
 * viewer is elsewhere. A time shown without its zone made an 08:00 Riyadh delivery read as 06:00 in London.
 */
function uiScheduleTime(value, timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return uiDateZoned(value);
  const zoned = uiZonedTime(value, timeZone) + ' (' + timeZone + ')',
    viewer = uiViewerTimeZone();
  return viewer === timeZone
    ? zoned
    : uiText('{time} · your time: {local}', {time: zoned, local: uiZonedTime(value, viewer)});
}
const uiEscape = value =>
  String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
/**
 * Escaped text in its own direction (WEB-05): a name or label decides its direction from its first strong character,
 * and an identifier, address or native value (`'ltr'`) always reads left to right inside Arabic text.
 */
function uiBidi(value, direction = 'auto') {
  return (direction === 'ltr' ? '<bdi dir="ltr">' : '<bdi>') + uiEscape(value ?? '') + '</bdi>';
}
/** A translated message as markup: its text is escaped and each {slot} receives the given markup (WEB-05). */
function uiMarkup(message, markup = {}) {
  return uiEscape(uiText(message)).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, key) =>
    Object.hasOwn(markup, key) ? String(markup[key]) : placeholder,
  );
}
function authLegalNotice() {
  return `<p class="auth-legal" lang="${uiLocale}" dir="${uiLocale === 'ar' ? 'rtl' : 'ltr'}">${uiEscape(uiText('By continuing, you agree to AMCP’s'))} <a href="/terms?lang=${uiLocale}">${uiEscape(uiText('Terms'))}</a> ${uiEscape(uiText('and'))} <a href="/privacy?lang=${uiLocale}">${uiEscape(uiText('Privacy Policy'))}</a>.</p>`;
}
function languageControl() {
  return `<div class="appearance-controls"><label class="language-control"><span>${uiEscape(uiText('Language'))}</span><select data-language-select aria-label="${uiEscape(uiText('Language'))}"><option value="en" lang="en" ${uiLocale === 'en' ? 'selected' : ''}>English</option><option value="ar" lang="ar" ${uiLocale === 'ar' ? 'selected' : ''}>العربية (جزئي)</option></select></label>${themeControl()}</div>`;
}
function themeControl() {
  const preference = typeof AMCPTheme === 'object' ? AMCPTheme.preference : 'system';
  const themeLabels = {system: 'System', light: 'Light', dark: 'Dark'};
  return `<label class="theme-control"><span>${uiEscape(uiText('Appearance'))}</span><select data-theme-select aria-label="${uiEscape(uiText('Appearance'))}">${Object.entries(
    themeLabels,
  )
    .map(
      ([value, label]) =>
        `<option value="${value}" ${preference === value ? 'selected' : ''}>${uiEscape(uiText(label))}</option>`,
    )
    .join('')}</select></label>`;
}
async function uiCatalog(locale) {
  if (locale === 'en') return new Map();
  if (locale !== 'ar') throw Error('Unsupported interface language');
  if (!uiCatalogs.has(locale)) {
    const pending = (async () => {
      const controller = new AbortController(),
        deadline = performance.now() + 15000,
        timer = setTimeout(() => controller.abort(), 15000);
      const checkDeadline = () => {
        if (controller.signal.aborted || performance.now() >= deadline) throw Error('Language catalog unavailable');
      };
      const bounded = async operation => {
        checkDeadline();
        let refuse;
        const expired = new Promise((_, reject) => {
          refuse = () => reject(Error('Language catalog unavailable'));
          controller.signal.addEventListener('abort', refuse, {once: true});
        });
        try {
          const result = await Promise.race([operation(), expired]);
          checkDeadline();
          return result;
        } finally {
          controller.signal.removeEventListener('abort', refuse);
        }
      };
      let reader;
      try {
        const response = await bounded(() =>
          fetch(
            typeof AMCPAssets === 'object' ? AMCPAssets.url('/assets/locales/ar.json') : '/assets/locales/ar.json',
            {
              credentials: 'same-origin',
              cache: 'no-cache',
              redirect: 'error',
              signal: controller.signal,
            },
          ),
        );
        // The page's asset snapshot was replaced by a deploy: this address can never succeed again (WEB-04).
        if (response.status === 409)
          throw Object.assign(Error(uiText('AMCP was updated. Reload to continue.')), {
            code: 'PAGE_ASSET_RELOAD_REQUIRED',
            updated: true,
          });
        if (!response.body) throw Error('Language catalog unavailable');
        reader = response.body.getReader();
        if (!response.ok) throw Error('Language catalog unavailable');
        const decoder = new TextDecoder('utf-8', {fatal: true});
        let bytes = 0,
          emptyChunks = 0,
          text = '';
        while (true) {
          const next = await bounded(() => reader.read());
          if (next.done) break;
          bytes += next.value.byteLength;
          emptyChunks = next.value.byteLength ? 0 : emptyChunks + 1;
          if (bytes > 2097152 || emptyChunks > 64) throw Error('Language catalog too large');
          text += decoder.decode(next.value, {stream: true});
        }
        text += decoder.decode();
        const data = JSON.parse(text);
        if (!data || Array.isArray(data) || typeof data !== 'object') throw Error('Invalid language catalog');
        const entries = Object.entries(data);
        for (const [key, value] of entries)
          if (typeof value !== 'string' || !value.trim() || uiSlots(key) !== uiSlots(value) || /[<>]/.test(value))
            throw Error('Invalid translated message');
        checkDeadline();
        return new Map(entries);
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (reader) {
          reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
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
  if (typeof AMCPTheme === 'object') AMCPTheme.sync();
  // The static policy pages follow their address, so every link to them names the current language (WEB-05).
  document
    .querySelectorAll(
      ['/privacy', '/terms', '/data-deletion']
        .flatMap(page => [page, page + '?lang=en', page + '?lang=ar'].map(href => 'a[href="' + href + '"]'))
        .join(','),
    )
    .forEach(link => {
      link.setAttribute('href', link.getAttribute('href').replace(/\?lang=(?:en|ar)$/, '') + '?lang=' + uiLocale);
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
    // A read-only or derived field holds what the page computed, never something the person typed (WEB-05).
    if (
      el.matches('[data-language-select],[data-theme-select],[data-derived]') ||
      el.readOnly ||
      ['hidden', 'button', 'submit', 'reset'].includes(el.type)
    )
      return false;
    if (el.type === 'file') return !!el.files?.length;
    if (['checkbox', 'radio'].includes(el.type)) return el.checked !== el.defaultChecked;
    // A colour field reports its value in lower case whatever case its markup used.
    if (el.type === 'color') return el.value.toLowerCase() !== el.defaultValue.toLowerCase();
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
/** Fills a field as part of the page's starting state, so the value is not mistaken for an unsaved edit (WEB-05). */
function uiSetInitialValue(field, value) {
  field.value = value;
  if (field.tagName === 'SELECT') for (const option of field.options) option.defaultSelected = option.selected;
  else field.defaultValue = field.value;
}
/** Marks every field in a form the page just filled from saved data as its starting state (WEB-05). */
function uiMarkPristine(root) {
  for (const field of root.querySelectorAll('input,select,textarea'))
    if (field.tagName === 'SELECT') for (const option of field.options) option.defaultSelected = option.selected;
    else if (['checkbox', 'radio'].includes(field.type)) field.defaultChecked = field.checked;
    else if (field.type !== 'file') field.defaultValue = field.value;
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
  } catch (error) {
    if (!current()) return false;
    // After a deploy the catalog exists only in the new snapshot: offer the reload, and open it in the chosen language.
    if (error?.code === 'PAGE_ASSET_RELOAD_REQUIRED' && typeof reloadForUpdate === 'function')
      await reloadForUpdate(() => {
        try {
          localStorage.setItem('amcp.locale', locale);
        } catch {
          /* The reloaded page opens in the previous language. */
        }
      });
    else if (error?.code === 'PAGE_ASSET_RELOAD_REQUIRED') toast(error.message);
    else toast(uiText('The language could not be loaded. Your current view is unchanged.'));
    return false;
  } finally {
    applyUILocale();
  }
}
document.addEventListener('change', event => {
  if (event.target.matches?.('[data-language-select]')) void changeUILocale(event.target.value);
});
// A language chosen in another tab applies here too, through the same unsaved-edit confirmation (WEB-05).
if (typeof addEventListener === 'function')
  addEventListener('storage', event => {
    if (event.key !== 'amcp.locale' || !['en', 'ar'].includes(event.newValue) || event.newValue === uiLocale) return;
    void changeUILocale(event.newValue);
  });
