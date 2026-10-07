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
  'account-workflows.js',
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
  'account-workflows.js': ['campaign-workflows.js'],
  'mfa-qr.js': ['vendor/qrcode-generator-2.0.4.js'],
  'report-quality.js': ['report-library.js'],
  'report-delivery.js': ['report-library.js'],
  'account-approvals.js': ['owner-operations.js'],
};
const pageAssetRoutes = {
  '/dashboard': ['work-center.js'],
  '/campaigns': ['campaign-recipes.js', 'campaign-workflows.js'],
  '/media': ['creative-push.js', 'creative-library.js', 'ad-previews.js', 'campaign-workflows.js'],
  '/reports': ['evidence-workflows.js', 'report-reference.js', 'report-quality.js'],
  '/reporting-overview': ['report-quality.js', 'report-library.js', 'report-delivery.js', 'report-workflows.js'],
  '/operations': ['operations-center.js'],
  '/capabilities': ['capability-center.js'],
  '/report-library': ['report-workflows.js'],
  '/report-pack': ['evidence-workflows.js'],
  '/monitors': ['operations-center.js'],
  '/portfolio': ['account-workflows.js'],
  '/measurement': ['account-workflows.js'],
  '/commerce': ['account-workflows.js'],
  '/schedules': ['work-center.js'],
  '/profiles': ['client-playbooks.js'],
  '/account': ['mfa-qr.js'],
  '/settings': ['owner-operations.js', 'account-approvals.js'],
};
const pageAssetLoads = new Map();
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
function pageAssetsPending(pathname) {
  return pageAssetsFor(pathname).some(file => pageAssetLoads.get(file)?.state !== 'ready');
}
function loadPageAsset(file) {
  const existing = pageAssetLoads.get(file);
  if (existing) return existing.promise;
  const entry = {state: 'loading', promise: null};
  pageAssetLoads.set(file, entry);
  const initialize = async () => {
    // These scripts capture existing globals during initialization. Other dependencies run only after page loading.
    if (file === 'account-approvals.js') await loadPageAsset('owner-operations.js');
    if (file === 'mfa-qr.js') await loadPageAsset('vendor/qrcode-generator-2.0.4.js');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'),
        originalPath = '/assets/' + file,
        path = typeof AMCPAssets === 'object' ? AMCPAssets.url(originalPath) : originalPath;
      let settled = false;
      const finish = (code, message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('error', evaluationError);
        script.onload = script.onerror = null;
        if (code) {
          script.remove();
          reject(Object.assign(Error(message), {code}));
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
      script.onerror = () =>
        finish('PAGE_ASSET_UNAVAILABLE', uiText('A file needed for this page could not be downloaded. Try again.'));
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
  await Promise.all(pageAssetsFor(pathname).map(loadPageAsset));
}
