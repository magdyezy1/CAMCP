import express, {type Request, type Response} from 'express';
import {compressedAssets} from './compressed-assets.js';
import {robotsTxt, securityTxt, type PublicPage} from './public-assets.js';
import type {WebsiteSite} from './website-site.js';

/**
 * The public website and the workspace shell (WEB-02): versioned assets, the policy, terms, deletion and About pages
 * without a session or JavaScript, robots.txt, security.txt and the favicon, every page of the route registry
 * (web/routes.js, tools/check-routes.mjs) answered with the shell (/ sends a signed-in visitor to /dashboard, P12),
 * and the branded not-found page with a real 404. Registered last: it answers every address the routes before it left.
 */
export function pageRoutes({router, web, options, directory, publicAssets}: WebsiteSite) {
  router.use(
    '/assets',
    // Pages are served at their own addresses with their own headers; their templates are not assets (WEB-02).
    (req, res, next) =>
      /\.html$/i.test(req.path) ? void res.status(404).setHeader('Cache-Control', 'no-store').end() : next(),
    publicAssets.middleware,
    // Existing versionless links continue to revalidate; new pages bind all assets to one public-file snapshot.
    // Brotli or gzip copies of text assets; everything else falls through to the static handler.
    compressedAssets(directory),
    express.static(directory, {
      dotfiles: 'deny',
      index: false,
      fallthrough: false,
      maxAge: 0,
      setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );
  router.get('/tiktok94H3oMGQTvC0GEzgKcmffbz8W0CAHhan.txt', (_req, res) =>
    res.type('text/plain').sendFile('tiktok94H3oMGQTvC0GEzgKcmffbz8W0CAHhan.txt', {root: directory}),
  );
  // Reviewers and users must be able to read the entire policy, terms and deletion instructions without a session or
  // JavaScript, and while the APIs are unavailable (WEB-02). Provider dashboards may already register these URLs.
  const staticPage =
    (english: PublicPage, arabic: PublicPage, status = 200) =>
    (req: Request, res: Response) => {
      const language = req.query.lang === 'ar' ? 'ar' : 'en';
      res.status(status).setHeader('Content-Language', language);
      res.type('html').send(publicAssets.html(language === 'ar' ? arabic : english));
    };
  router.get('/privacy', staticPage('privacy.html', 'privacy-ar.html'));
  router.get('/terms', staticPage('terms.html', 'terms-ar.html'));
  router.get('/data-deletion', staticPage('data-deletion.html', 'data-deletion-ar.html'));
  router.get('/about', (_req, res) => res.type('html').send(publicAssets.html('about.html')));
  router.get('/robots.txt', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('text/plain').send(robotsTxt);
  });
  router.get('/.well-known/security.txt', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('text/plain').send(securityTxt(web.origin, options.authEnv ?? process.env));
  });
  // The mark is an SVG: /favicon.ico points to it at its own versioned address, whose type matches its path. Temporary,
  // because the version changes with every deployment.
  router.get('/favicon.ico', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.redirect(302, '/assets/v/' + publicAssets.version + '/mark.svg');
  });
  // Owner decision P12 (DOC-03): a signed-in visitor to / goes to Home; everyone else gets the public landing page. The
  // address is a fixed path on this site, never taken from the request, so nothing a visitor sends can steer it.
  const signedIn = (req: Request) => {
    try {
      return web.session(req) !== undefined;
    } catch {
      return false;
    }
  };
  // Whether / sends this visitor to Home. Either answer of / depends on the session cookie, so the response says so
  // itself, whatever middleware runs before these routes: no cache may store it, and a shared cache that ignores that
  // still keys it by the cookie.
  const homeVisitor = (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Cookie');
    return signedIn(req);
  };
  for (const route of [
    '/dashboard',
    '/campaigns',
    '/media',
    '/reports',
    '/reporting-overview',
    '/operations',
    '/capabilities',
    '/report-library',
    '/report-pack',
    '/monitors',
    '/portfolio',
    '/measurement',
    '/commerce',
    '/schedules',
    '/profiles',
    '/',
    '/connections',
    '/connectors',
    '/activity',
    '/settings',
    '/login',
    '/signup',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/account',
    '/auth/complete',
    '/oauth/result',
    '/oauth/consent',
  ])
    router.get(route, (req, res) =>
      route === '/' && homeVisitor(req, res)
        ? res.redirect(302, '/dashboard')
        : res.type('html').send(publicAssets.html('index.html')),
    );
  // Every other page address gets the branded, localized not-found page with a real 404, never Express's default page;
  // an unknown API address gets the JSON error every API caller reads. Protocol and asset paths keep their own
  // responses (WEB-02).
  const notFound = staticPage('404.html', '404-ar.html', 404);
  router.use((req, res, next) => {
    // The shared error handler answers a plain 404 with its JSON NOT_FOUND error.
    if (/^\/api(?:\/|$)/i.test(req.path)) return next(Object.assign(new Error('Not found'), {status: 404}));
    if ((req.method !== 'GET' && req.method !== 'HEAD') || /^\/(?:mcp|assets|\.well-known)(?:\/|$)/i.test(req.path))
      return next();
    res.setHeader('Cache-Control', 'no-store');
    notFound(req, res);
  });
}
