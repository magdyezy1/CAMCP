'use strict';
// Only authored same-origin filenames enter the loader. Routes, query strings and provider data never become URLs.
const pageAssetOrder = [
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
  'work-center.js',
  'capability-center.js',
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
  'report-quality.js',
  'report-reference.js',
  'report-library.js',
  'report-delivery.js',
  'owner-operations.js',
  'account-approvals.js',
];
const pageAssetDependencies = {
  'creative-library.js': ['operations-center.js'],
  'client-playbooks.js': ['campaign-recipes.js', 'campaign-workflows.js'],
  'operations-center.js': ['workbook-schedules.js', 'workbook-bindings.js', 'workbook-rebinding.js'],
  'workbook-bindings.js': ['operations-center.js'],
  'workbook-rebinding.js': ['operations-center.js'],
  'work-center.js': ['report-library.js', 'campaign-workflows.js'],
  'capability-center.js': ['operations-center.js'],
  'report-workflows.js': ['report-library.js'],
  'evidence-workflows.js': ['report-quality.js', 'report-allocation.js', 'report-presentation.js'],
  'report-allocation.js': ['operations-center.js', 'report-quality.js'],
  'report-presentation.js': ['evidence-workflows.js', 'operations-center.js'],
  // WEB-07: one module per account workflow page over a small shared helper; only Measurement shows a review table.
  // A parked store source is a module of its own behind the Commerce page.
  'portfolio.js': ['account-workflows.js'],
  'measurement.js': ['account-workflows.js', 'campaign-workflows.js'],
  'commerce.js': ['account-workflows.js', 'commerce-woocommerce.js'],
  'commerce-woocommerce.js': ['account-workflows.js'],
  'mfa-qr.js': ['vendor/qrcode-generator-2.0.4.js'],
  'report-quality.js': ['report-library.js'],
  'report-delivery.js': ['report-library.js'],
  'account-approvals.js': ['owner-operations.js'],
};
// The files each page loads are its route registry entry's `assets` (web/routes.js, WEB-07): a page is declared once.
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
 * The Arabic catalog chunks a page needs besides the shell's (WEB-07): a signed-in page needs the workspace's and the
 * providers' messages, and each of its feature scripts' own. Public pages need none.
 */
function pageLocaleChunks(pathname) {
  const entry = routeEntry(pathname);
  if (!entry || entry.public) return [];
  return [
    'workspace',
    'providers',
    ...pageAssetsFor(pathname)
      .filter(file => !file.startsWith('vendor/'))
      .map(file => file.replace(/\.js$/, '')),
  ];
}
function pageAssetsPending(pathname) {
  return (
    pageAssetsFor(pathname).some(file => pageAssetLoads.get(file)?.state !== 'ready') ||
    (typeof uiChunksReady === 'function' && !uiChunksReady(pageLocaleChunks(pathname)))
  );
}
function loadPageAsset(file) {
  const existing = pageAssetLoads.get(file);
  if (existing) return existing.promise;
  const entry = {state: 'loading', promise: null};
  pageAssetLoads.set(file, entry);
  const initialize = async () => {
    // No script captures another's globals while it initializes: page modules register with the shell's extension
    // points (WEB-07) and call their dependencies only once the page renders, after every file of the page is ready.
    // Scripts inserted with async=false still run in the order they were requested.
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'),
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
      script.async = false;
      script.src = path;
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
      document.head.append(script);
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
  await Promise.all([
    ...pageAssetsFor(pathname).map(loadPageAsset),
    ...(typeof uiNeedChunks === 'function' ? [uiNeedChunks(pageLocaleChunks(pathname))] : []),
  ]);
}
