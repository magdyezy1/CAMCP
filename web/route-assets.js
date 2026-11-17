'use strict';
// Only authored same-origin filenames enter the loader. Routes, query strings and provider data never become URLs.
const pageAssetOrder = [
  'tokens-v2.css',
  'components.css',
  'components-controls.css',
  'components-data.css',
  'components-overlays.css',
  'design-system.css',
  'charts.css',
  'campaign-recipes.js',
  'creative-push.js',
  'creative-library.js',
  'ad-previews.js',
  'campaign-workflows.js',
  'client-playbooks.js',
  'operations-center.js',
  'workbook-schedules.js',
  'workbook-bindings.js',
  'workbook-rebinding.js',
  'work-pages.js',
  'work-center.js',
  'capability-center.js',
  'reporting-overview.js',
  'report-workflows.js',
  'evidence-workflows.js',
  'report-allocation.js',
  'report-presentation.js',
  'measurement-trace-import.js',
  'account-workflows.js',
  'portfolio.js',
  'measurement.js',
  'commerce-woocommerce.js',
  'commerce.js',
  'vendor/qrcode-generator-2.0.4.js',
  'mfa-qr.js',
  'account-deletion.js',
  'report-quality.js',
  'report-reference.js',
  'report-library.js',
  'report-source-settings.js',
  'report-delivery.js',
  'owner-operations.js',
  'account-approvals.js',
  'help.js',
  'components.js',
  'components-controls.js',
  'components-table.js',
  'components-overlays.js',
  // After the layer it draws with (V2-EXP-01).
  'charts.js',
  'design-system.js',
];
const pageAssetDependencies = {
  'creative-library.js': ['work-pages.js'],
  'client-playbooks.js': ['campaign-recipes.js', 'campaign-workflows.js'],
  'operations-center.js': ['work-pages.js', 'workbook-schedules.js', 'workbook-bindings.js', 'workbook-rebinding.js'],
  'workbook-bindings.js': ['work-pages.js'],
  'workbook-rebinding.js': ['work-pages.js'],
  // The report builder's script left the shell (WEB-07); the modules that use its state and labels load it.
  'work-center.js': ['report-library.js', 'reporting-overview.js'],
  'capability-center.js': ['work-pages.js'],
  'reporting-overview.js': ['report-library.js'],
  'report-library.js': ['reporting-overview.js'],
  'report-workflows.js': ['report-library.js', 'reporting-overview.js'],
  'evidence-workflows.js': ['report-quality.js', 'report-allocation.js', 'report-presentation.js'],
  'report-allocation.js': ['work-pages.js', 'report-quality.js'],
  'report-presentation.js': ['evidence-workflows.js', 'work-pages.js'],
  'portfolio.js': ['account-workflows.js'],
  'measurement.js': ['account-workflows.js', 'campaign-workflows.js'],
  'commerce.js': ['account-workflows.js', 'commerce-woocommerce.js'],
  'commerce-woocommerce.js': ['account-workflows.js'],
  'mfa-qr.js': ['vendor/qrcode-generator-2.0.4.js'],
  'report-quality.js': ['report-library.js', 'reporting-overview.js'],
  'report-delivery.js': ['report-library.js', 'reporting-overview.js'],
  // The charts of a report (V2-EXP-01): drawn with the V2 layer's button and table, in colours of its tokens, and worded with
  // the report page's own coverage words. Only the report builder loads them.
  'charts.js': [
    'tokens-v2.css',
    'components.css',
    'components-data.css',
    'charts.css',
    'components.js',
    'components-table.js',
    'report-quality.js',
  ],
  'account-approvals.js': ['owner-operations.js'],
  'design-system.js': [
    'tokens-v2.css',
    'components.css',
    'components-controls.css',
    'components-data.css',
    'components-overlays.css',
    'design-system.css',
    'components.js',
    'components-controls.js',
    'components-table.js',
    'components-overlays.js',
  ],
};
// A page's files are its route registry entry's `assets` (web/routes.js).
const pageAssetRoutes = Object.freeze(
  Object.fromEntries(
    routeRegistry.filter(entry => entry.assets).map(entry => [entry.path, Object.freeze([...entry.assets])]),
  ),
);
const pageAssetLoads = new Map();
/**
 * After a versioned file failed to download, asks the server once whether this page's snapshot is still current.
 * A 409 means AMCP was updated: retrying the same address can never succeed, only a reload can (WEB-04).
 */
async function assetVersionChanged(path) {
  if (!/^\/assets\/v\/[0-9a-f]{64}\//.test(path) || typeof fetch !== 'function') return false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null,
    timer = setTimeout(() => controller?.abort(), 5000);
  try {
    const response = await fetch(path, {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      ...(controller ? {signal: controller.signal} : {}),
    });
    return response.status === 409;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
function pageAssetsFor(pathname) {
  const wanted = new Set();
  const include = file => {
    if (wanted.has(file)) return;
    wanted.add(file);
    for (const dependency of pageAssetDependencies[file] ?? []) include(dependency);
  };
  for (const file of Object.hasOwn(pageAssetRoutes, pathname) ? pageAssetRoutes[pathname] : []) include(file);
  return pageAssetOrder.filter(file => wanted.has(file));
}
/**
 * The Arabic chunks no page waits for (R25 ar-lazy): refusal sentences, shown only from an answer. An answer that carries
 * one loads it (uiEnsureAnswerChunks); the browser fetches it when idle after a page renders. tools/locale-chunks.mjs reads
 * this list: no page script may rely on these chunks. That gate reads an error by its shape (a code beside the message): a
 * message copied into a field with no code is read by its page, which calls uiEnsureSentences; the backend's copies are
 * listed in tests/web-locale-chunks.test.mjs.
 */
const answerLocaleChunks = Object.freeze(['providers']);
/** A signed-in page's Arabic chunks besides the shell's (WEB-07): workspace and its scripts'; never `answerLocaleChunks`. */
function pageLocaleChunks(pathname) {
  const entry = routeEntry(pathname);
  if (!entry || entry.public) return [];
  return [
    'workspace',
    ...pageAssetsFor(pathname)
      .filter(file => file.endsWith('.js') && !file.startsWith('vendor/'))
      .map(file => file.replace(/\.js$/, '')),
  ];
}
function pageAssetsPending(pathname) {
  return (
    pageAssetsFor(pathname).some(file => pageAssetLoads.get(file)?.state !== 'ready') ||
    !uiChunksReady(pageLocaleChunks(pathname))
  );
}
function loadPageAsset(file) {
  const existing = pageAssetLoads.get(file);
  if (existing) return existing.promise;
  const entry = {state: 'loading', promise: null};
  pageAssetLoads.set(file, entry);
  const initialize = async () => {
    // Page modules only register while they load (WEB-07); async=false scripts still run in request order.
    await new Promise((resolve, reject) => {
      const style = file.endsWith('.css'),
        script = document.createElement(style ? 'link' : 'script'),
        originalPath = '/assets/' + file,
        path = typeof AMCPAssets === 'object' ? AMCPAssets.url(originalPath) : originalPath;
      let settled = false;
      const finish = (code, message, updated = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('error', evaluationError);
        script.onload = script.onerror = null;
        if (code) {
          script.remove();
          reject(Object.assign(Error(message), {code}, updated ? {updated} : {}));
        } else resolve();
      };
      const evaluationError = event => {
        let url;
        try {
          url = new URL(event.filename, location.href);
        } catch {
          return;
        }
        if (url.origin === location.origin && url.pathname === path)
          finish(
            'PAGE_ASSET_RELOAD_REQUIRED',
            uiText('This page could not finish starting. Reload the page to try again.'),
          );
      };
      const timer = setTimeout(
        () => finish('PAGE_ASSET_RELOAD_REQUIRED', uiText('Page loading took too long. Reload the page to try again.')),
        20000,
      );
      window.addEventListener('error', evaluationError);
      Object.assign(script, style ? {rel: 'stylesheet', href: path} : {async: false, src: path});
      script.onload = () => finish();
      // A script error cannot tell a deploy (409) from a network failure, so one probe decides between "Reload" and
      // "Try again"; retrying a superseded snapshot address could never succeed (WEB-04).
      script.onerror = async () => {
        if (settled) return;
        if (await assetVersionChanged(path))
          finish('PAGE_ASSET_RELOAD_REQUIRED', uiText('AMCP was updated. Reload to continue.'), true);
        else
          finish('PAGE_ASSET_UNAVAILABLE', uiText('A file needed for this page could not be downloaded. Try again.'));
      };
      if (style) document.head.insertBefore(script, document.head.querySelector('link[href$="/accessibility.css"]'));
      else document.head.append(script);
    });
    entry.state = 'ready';
  };
  entry.promise = initialize().catch(error => {
    if (error.code === 'PAGE_ASSET_RELOAD_REQUIRED') entry.state = 'reload';
    else pageAssetLoads.delete(file);
    throw error;
  });
  return entry.promise;
}
async function ensurePageAssets(pathname) {
  // The page's scripts and its catalog chunks download together.
  await Promise.all([...pageAssetsFor(pathname).map(loadPageAsset), uiNeedChunks(pageLocaleChunks(pathname))]);
}
/** Whether a page's chunks are in its messages; a document without localization.js needs none. */
function uiChunksReady(chunks) {
  return (
    typeof uiLoadedChunks === 'undefined' ||
    uiLocale === 'en' ||
    chunks.every(chunk => uiLoadedChunks.has(uiLocale + ':' + chunk))
  );
}
/** Adds a page's chunks to its messages (a later language includes them); a failure rejects, so the page retries. */
async function uiNeedChunks(chunks) {
  if (typeof uiCatalogChunks === 'undefined') return;
  for (const chunk of chunks) uiCatalogChunks.add(chunk);
  if (uiChunksReady(chunks)) return;
  const token = uiLocaleSequence,
    locale = uiLocale;
  let messages;
  try {
    messages = await uiCatalogMessages(locale, chunks);
  } catch (error) {
    // A deploy (409) needs a reload; anything else offers Try again, like a script.
    if (error?.code === 'PAGE_ASSET_RELOAD_REQUIRED') throw error;
    throw Object.assign(Error(uiText('A file needed for this page could not be downloaded. Try again.')), {
      code: 'PAGE_ASSET_UNAVAILABLE',
    });
  }
  // A language change meanwhile loads every needed chunk itself.
  if (token !== uiLocaleSequence || locale !== uiLocale) return;
  uiMessages = new Map([...uiMessages, ...messages]);
  for (const chunk of chunks) uiLoadedChunks.add(locale + ':' + chunk);
}
/** Starts the first page's chunks in the saved language while the shell chunk and the session load. */
function uiPrefetchChunks(chunks) {
  let saved;
  try {
    saved = localStorage.getItem('amcp.locale');
  } catch {
    return;
  }
  if (saved === 'ar') for (const chunk of chunks) uiCatalog('ar', chunk).catch(() => {});
}
/**
 * Calls `visit(object, sentences)` for each error-shaped object in an answer (an error, a diagnostic, a refused step), at any
 * depth, with the sentences a page looks up in the catalog from it: its message (its template, when it has one), next step
 * and remedy. A provider's own message is shown as it is, so it is not read. Stops when `visit` returns true (R25 ar-lazy).
 */
function uiEachAnswerMessage(data, visit) {
  const queue = data && typeof data === 'object' ? [data] : [];
  for (let index = 0; index < queue.length && index < 200000; index++) {
    const value = queue[index];
    if (!Array.isArray(value)) {
      const local =
          value.message_localization && typeof value.message_localization === 'object'
            ? value.message_localization
            : null,
        remedy = value.remedy && typeof value.remedy === 'object' ? value.remedy : null,
        sentences = [],
        say = text => typeof text === 'string' && text !== '' && sentences.push(text);
      if (typeof local?.key === 'string') say(local.key);
      else if (
        typeof value.code === 'string' ||
        typeof value.next_action === 'string' ||
        remedy ||
        (value.provider && typeof value.provider === 'object')
      )
        say(value.message);
      say(value.next_action);
      for (const field of ['action', 'message', 'next_action']) say(remedy?.[field]);
      say(value.details?.next_action);
      // The base of a split message (meta.message_parts).
      if (typeof value.suffix === 'string') say(value.base);
      if (sentences.length && visit(value, sentences) === true) return;
    }
    for (const [key, child] of Array.isArray(value) ? value.entries() : Object.entries(value))
      if (child && typeof child === 'object' && !['provider', 'upstream', 'untrusted_provider_content'].includes(key))
        queue.push(child);
  }
}
/** Replaces the sentences of an answer that are not loaded by one fixed sentence in the interface language. */
function uiAnswerWithoutUnloaded(data) {
  const sentence = uiText('The details of this message could not be loaded. Try again.');
  uiEachAnswerMessage(data, (object, sentences) => {
    if (sentences.every(text => uiMessages.has(text))) return false;
    if (typeof object.suffix === 'string') {
      delete object.base;
      delete object.suffix;
      return false;
    }
    // Technical details keep the server's exact text, as when the chunk loads (WEB-03): errorTechnical reads these two.
    const step = object.next_action ?? object.remedy?.action;
    if (typeof object.message === 'string') object.server_message ??= object.message;
    if (typeof step === 'string') object.server_next_action ??= step;
    // A provider's own message replaces `message` on screen, so the sentence goes beside it as the explanation.
    const hasMessage = typeof object.message === 'string';
    if (hasMessage) object.message = sentence;
    if (!hasMessage || typeof object.provider?.message === 'string') object.next_action = sentence;
    else delete object.next_action;
    delete object.message_localization;
    if (object.remedy && typeof object.remedy === 'object')
      for (const field of ['action', 'message', 'next_action']) delete object.remedy[field];
    if (object.details && typeof object.details === 'object') delete object.details.next_action;
    return false;
  });
}
let uiAnswerChunksIdle = false;
/** After a page renders, fetches the chunks no page waits for when the browser is idle: Arabic, signed in, one task at a time. */
function uiPrefetchAnswerChunks() {
  if (
    uiLocale !== 'ar' ||
    typeof session !== 'object' ||
    !session?.authenticated ||
    uiAnswerChunksIdle ||
    uiChunksReady(answerLocaleChunks)
  )
    return;
  uiAnswerChunksIdle = true;
  const load = () =>
    uiNeedChunks(answerLocaleChunks)
      .catch(() => {})
      .finally(() => (uiAnswerChunksIdle = false));
  if (typeof requestIdleCallback === 'function') requestIdleCallback(load, {timeout: 5000});
  else setTimeout(load, 1500);
}
if (typeof AMCP === 'object') AMCP.hooks.afterRender(uiPrefetchAnswerChunks);
/**
 * Before a page reads an answer in Arabic, loads `answerLocaleChunks` when the answer carries a sentence not in the catalog
 * yet: a refusal's, in an error or in a 200 with diagnostics (the catalog's own read: coalesced, 15 seconds). If it cannot
 * load, the answer is kept whole with one fixed sentence in place of the English message; only a deploy (409) throws, for
 * the page's reload, and not for a successful answer (`ok`), whose outcome stays (R25 ar-lazy).
 */
async function uiEnsureAnswerChunks(data, ok = false) {
  if (uiLocale !== 'ar' || uiChunksReady(answerLocaleChunks)) return;
  let unloaded = false;
  uiEachAnswerMessage(data, (object, sentences) => (unloaded = sentences.some(text => !uiMessages.has(text))));
  if (!unloaded) return;
  try {
    await uiNeedChunks(answerLocaleChunks);
  } catch (error) {
    if (error?.code === 'PAGE_ASSET_RELOAD_REQUIRED' && !ok) throw error;
    uiAnswerWithoutUnloaded(data);
  }
}
/**
 * Before a page shows a server sentence that no error field carries (a message stored without its code, such as the connection
 * result's), loads `answerLocaleChunks` when one of `texts` is not in the catalog yet. False when the chunk cannot load: the page
 * then shows `uiSentence(text, false)` (R25 ar-lazy).
 */
async function uiEnsureSentences(texts) {
  if (uiLocale !== 'ar' || uiChunksReady(answerLocaleChunks) || texts.every(text => uiMessages.has(text))) return true;
  try {
    await uiNeedChunks(answerLocaleChunks);
    return true;
  } catch {
    return false;
  }
}
/** A server sentence in the interface language, or the fixed sentence when its chunk could not load (`loaded` false). */
function uiSentence(text, loaded) {
  return loaded || uiLocale !== 'ar' || uiMessages.has(text)
    ? uiText(text)
    : uiText('The details of this message could not be loaded. Try again.');
}
