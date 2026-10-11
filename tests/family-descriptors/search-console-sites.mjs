// search_console_sites: DELETE https://searchconsole.googleapis.com/webmasters/v3/sites/{site}/sitemaps/{feedpath}
// (Search Console API, Sitemaps.delete) through the delegated gsc_site_ops operation. Deleting a sitemap stops Google
// from reading it; the sitemap's `lastSubmitted`, which a fresh submission after the review moves, is the decisive
// field (crawl observations such as `isPending` or counts change on their own and are not).
const site = 'sc-domain:example.test',
  sitemap = 'https://example.test/sitemap.xml',
  sitePath = '/webmasters/v3/sites/' + encodeURIComponent(site),
  sitemapPath = sitePath + '/sitemaps/' + encodeURIComponent(sitemap);

export default {
  family: 'search_console_sites',
  risk: 'destructive',
  gateway: 'google_search_console_native_action',
  account: site,
  connection: {scopes: ['https://www.googleapis.com/auth/webmasters']},
  arguments: {
    operation: 'gsc_site_ops',
    arguments: {action: 'DELETE_SITEMAP', site_url: site, sitemap_url: sitemap},
  },
  seed: () => ({
    site: {siteUrl: site, permissionLevel: 'siteOwner'},
    sitemap: {
      path: sitemap,
      lastSubmitted: '2026-09-01T00:00:00Z',
      type: 'sitemap',
      isSitemapsIndex: false,
      lastDownloaded: '2026-09-01T00:00:00Z',
      isPending: false,
      errors: '0',
      warnings: '0',
    },
  }),
  unpaginated:
    'GET sites/{site} and GET sites/{site}/sitemaps/{feedpath} each return one resource; Search Console pages neither',
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, state, mode}) {
    if (url.origin !== 'https://searchconsole.googleapis.com') return;
    if (method === 'GET' && path === sitePath) return {json: state.site};
    if (method === 'GET' && path === sitemapPath)
      return state.sitemap
        ? {json: state.sitemap}
        : {status: 404, json: {error: {code: 404, message: 'Requested entity was not found.'}}};
    if (method === 'DELETE' && path === sitemapPath) {
      // A partial answer: Search Console answers a delete with an unexpected body instead of an empty one.
      if (mode.partial) return {json: {warning: 'Synthetic unexpected answer'}};
      state.sitemap = undefined;
      return new Response(null, {status: 204});
    }
  },
  decisive: {change: state => (state.sitemap.lastSubmitted = '2026-09-02T00:00:00Z'), field: /lastSubmitted/},
};
