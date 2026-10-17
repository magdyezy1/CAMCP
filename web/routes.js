'use strict';
// WEB-06: the one route registry. Every page the workspace shell serves is listed once, in navigation order: its path,
// its canonical name (the navigation label, owner decision D27), the navigation group it sits in, the names it was
// known by before (the command palette still finds them), and whether a test account, a sign-in return or the
// command palette may open it. Titles, breadcrumbs, headings, the palette, client routing, sign-in returns and
// test-account scope all read this list. server/website.ts serves exactly these paths (tests/route-registry.test.mjs)
// and tools/check-routes.mjs fails `check-web` when the navigation in index.html drifts from it.
//
// Fields: label is the canonical name; group is the navigation disclosure that holds the link; nav marks a sidebar
// link; palette marks a command-palette entry; testAccount marks a page a test account may open; public marks a page
// for people who are not signed in; returnable:false keeps a page out of sign-in returns; parent names the page a
// child page belongs to (its breadcrumb and highlighted navigation link); section is the page key the renderer
// dispatches on when it differs from the path. Only English interface text is written here; the Arabic catalog
// translates labels, groups, aliases and descriptions like every other message (tools/check-locales.mjs).
const routeRegistry = [
  {path: '/', label: 'Make room for your next move', public: true},
  {path: '/login', label: 'Sign in', public: true},
  {path: '/signup', label: 'Create your account', public: true},
  {path: '/forgot-password', label: 'Password recovery', public: true},
  {path: '/reset-password', label: 'Reset password', public: true},
  {path: '/verify-email', label: 'Verify email', public: true},
  {path: '/auth/complete', label: 'Sign in', section: '', testAccount: true, returnable: false},
  {
    path: '/dashboard',
    label: 'Home',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Overview', 'Dashboard'],
    description: 'Work needing attention and account readiness',
  },
  {
    path: '/campaigns',
    label: 'Campaigns',
    nav: true,
    palette: true,
    aliases: ['Campaign plans'],
    description: 'Plans, dependencies, reviews',
  },
  {
    path: '/portfolio',
    label: 'Live portfolio',
    group: 'Campaign tools',
    nav: true,
    palette: true,
    aliases: ['Live account portfolio', 'Portfolio'],
    description: 'Browse current campaigns, ad groups, ad sets and ads',
  },
  {
    path: '/commerce',
    label: 'Commerce',
    group: 'Campaign tools',
    nav: true,
    palette: true,
    aliases: ['Product catalog'],
    description: 'Product imports with per-item reviews and receipts',
  },
  {
    path: '/media',
    label: 'Creative',
    nav: true,
    palette: true,
    aliases: ['Media library', 'Media'],
    description: 'Drive imports, formats, and reuse',
  },
  {
    path: '/report-library',
    label: 'Reporting',
    nav: true,
    palette: true,
    aliases: ['Report library'],
    description: 'Saved client definitions, templates and retained snapshots',
  },
  {
    path: '/reporting-overview',
    label: 'Report builder',
    group: 'Reporting tools',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Reporting overview'],
    description: 'Campaign metrics, recommendations and scheduled Sheets exports',
  },
  {
    path: '/reports',
    label: 'Evidence & analysis',
    group: 'Reporting tools',
    nav: true,
    palette: true,
    aliases: ['Reports'],
    description: 'Evidence, totals, and recommendations',
  },
  {
    path: '/schedules',
    label: 'Schedules',
    group: 'Reporting tools',
    nav: true,
    palette: true,
    aliases: ['Schedules & deliveries'],
    description: 'Delivery times, windows and recovery',
  },
  {
    path: '/profiles',
    label: 'Clients & templates',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Client profiles', 'Client playbooks'],
    description: 'Templates, naming, and defaults',
  },
  {
    path: '/connections',
    label: 'Connections',
    nav: true,
    palette: true,
    testAccount: true,
    description: 'Platforms, accounts, and permissions',
  },
  {
    path: '/measurement',
    label: 'Measurement',
    group: 'Connection tools',
    nav: true,
    palette: true,
    aliases: ['Measurement diagnostics'],
    description: 'Tag Manager audits and measurement evidence',
  },
  {
    path: '/connectors',
    label: 'AI connectors',
    group: 'Connection tools',
    nav: true,
    palette: true,
    aliases: ['MCP connectors'],
    description: 'Codex, Claude, Cursor, and tokens',
  },
  {
    path: '/capabilities',
    label: 'Capabilities',
    group: 'Connection tools',
    nav: true,
    palette: true,
    description: 'Workflow eligibility and native action contracts',
  },
  {
    path: '/operations',
    label: 'Operations',
    nav: true,
    palette: true,
    description: 'Campaign, media and delivery recovery',
  },
  {
    path: '/monitors',
    label: 'Monitoring inbox',
    group: 'Management',
    nav: true,
    palette: true,
    description: 'Read-only rules and evidence-linked incidents',
  },
  {
    path: '/activity',
    label: 'Audit activity',
    group: 'Management',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Activity'],
    description: 'Your workspace audit history',
  },
  {
    path: '/settings',
    label: 'Workspace settings',
    group: 'Management',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Settings'],
    description: 'Platform and deployment setup',
  },
  {
    path: '/account',
    label: 'Your account',
    palette: true,
    testAccount: true,
    description: 'Profile, social sign-in, and security',
  },
  {path: '/report-pack', label: 'Report pack', parent: '/report-library'},
  {
    path: '/oauth/consent',
    label: 'Authorize access',
    parent: '/connections',
    section: 'connections',
    testAccount: true,
  },
  {
    path: '/oauth/result',
    label: 'Connection result',
    parent: '/connections',
    section: 'connections',
    testAccount: true,
    returnable: false,
  },
];
/** The registry entry for a path (without query or fragment), or undefined. */
function routeEntry(path) {
  return typeof path === 'string' ? routeRegistry.find(entry => entry.path === path) : undefined;
}
/** The canonical English name of a registered page, or undefined; callers translate it with uiText. */
function routeLabel(path) {
  return routeEntry(path)?.label;
}
/** The page key a path renders as ('' for public, sign-in and unregistered paths). */
function routeSection(path) {
  const entry = routeEntry(path);
  if (!entry || entry.public) return '';
  return entry.section ?? entry.path.slice(1);
}
/** The navigation link a path highlights: a child page highlights its parent. */
function routeNavigationKey(path) {
  const entry = routeEntry(path);
  if (!entry || entry.public) return '';
  return (entry.parent ?? entry.path).slice(1);
}
/** The palette entries that match a query, best match first: a page's own name, then a former name, then text. */
function routeMatches(query, translate = text => text) {
  const q = String(query ?? '')
      .trim()
      .toLowerCase(),
    names = text => [text, translate(text)].filter(Boolean).map(value => String(value).toLowerCase());
  return routeRegistry
    .filter(entry => entry.palette && routeAvailable(entry.path))
    .map((entry, order) => {
      const label = names(entry.label),
        aliases = (entry.aliases ?? []).flatMap(names),
        other = [...names(entry.group), ...names(entry.description)];
      const score = !q
        ? 0
        : label.includes(q)
          ? 0
          : label.some(value => value.startsWith(q))
            ? 1
            : aliases.includes(q)
              ? 2
              : [...label, ...aliases].some(value => value.includes(q))
                ? 3
                : other.some(value => value.includes(q))
                  ? 4
                  : null;
      return {entry, order, score};
    })
    .filter(row => row.score !== null)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map(row => row.entry);
}
/**
 * Whether the signed-in person may open a page. Only a test account is narrower: it opens the pages marked for it and
 * the public pages. The server refuses everything else on its own (server/website.ts); this keeps the shell honest.
 */
function routeAvailable(path, who = typeof session === 'object' ? session : null) {
  if (!who?.authenticated || !who.testAccount) return true;
  const entry = routeEntry(path);
  return !!entry && (entry.public === true || entry.testAccount === true);
}
/** A same-origin path a sign-in may return to, or the Home page. */
function routeReturnable(path) {
  if (typeof path !== 'string' || path.length >= 10000 || !path.startsWith('/') || path.startsWith('//')) return false;
  const entry = routeEntry(path.split(/[?#]/)[0]);
  return !!entry && !entry.public && entry.returnable !== false;
}
/**
 * WEB-07: the shell's explicit extension points, built on the registry above. A script adds to the shell by
 * registering, never by reassigning a shell function (render, renderSettings and renderAccountPage were wrapped by
 * reassignment, so a wrapper dropped or loaded out of order changed pages silently):
 *   AMCP.routes.register(path, {render})  the one renderer of a page that has none in the shell; a second renderer for
 *                                         the same page is refused, never an override;
 *   AMCP.routes.extend(path, part)        a part of a page that renders after the page itself, in the order the
 *                                         scripts load (the owner sections of /settings, account security on /account);
 *   AMCP.hooks.beforeRender(hook)         runs synchronously at the start of every page render (test-account scope);
 *   AMCP.hooks.afterRender(hook)          runs once that render has finished.
 * Only registered pages take renderers and parts. Lazily loaded files still come from route-assets.js, the loader's
 * fixed list of authored filenames.
 */
const AMCP = (() => {
  const renderers = new Map(),
    parts = new Map(),
    hooks = {before: [], after: []};
  const known = path => {
    if (!routeEntry(path)) throw Error('AMCP_ROUTE_UNKNOWN: ' + path);
  };
  const callable = value => {
    if (typeof value !== 'function') throw TypeError('AMCP_EXTENSION_NOT_A_FUNCTION');
    return value;
  };
  return Object.freeze({
    routes: Object.freeze({
      register(path, {render} = {}) {
        known(path);
        if (renderers.has(path)) throw Error('AMCP_ROUTE_ALREADY_REGISTERED: ' + path);
        renderers.set(path, callable(render));
      },
      /** The renderer a script registered for a page, or undefined when the shell renders it itself. */
      renderer: path => renderers.get(path),
      extend(path, part) {
        known(path);
        parts.set(path, [...(parts.get(path) ?? []), callable(part)]);
      },
      /** Runs the parts of a page in order; a part that fails stops the rest, as an unfinished page would. */
      async renderParts(path) {
        for (const part of parts.get(path) ?? []) await part();
      },
    }),
    hooks: Object.freeze({
      beforeRender: hook => void hooks.before.push(callable(hook)),
      afterRender: hook => void hooks.after.push(callable(hook)),
      runBefore() {
        for (const hook of hooks.before) hook();
      },
      async runAfter() {
        for (const hook of hooks.after) await hook();
      },
    }),
  });
})();
