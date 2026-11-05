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
// dispatches on when it differs from the path; assets are the feature scripts web/route-assets.js loads for it. Only
// English interface text is written here; the Arabic catalog translates it like every other message.
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
    assets: ['work-center.js'],
  },
  {
    path: '/campaigns',
    testAccount: true,
    label: 'Campaigns',
    nav: true,
    palette: true,
    aliases: ['Campaign plans'],
    description: 'Plans, dependencies, reviews',
    assets: ['campaign-recipes.js', 'campaign-workflows.js'],
  },
  {
    path: '/portfolio',
    testAccount: true,
    label: 'Live portfolio',
    group: 'Campaign tools',
    nav: true,
    palette: true,
    aliases: ['Live account portfolio', 'Portfolio'],
    description: 'Browse current campaigns, ad groups, ad sets and ads',
    assets: ['portfolio.js'],
  },
  {
    path: '/commerce',
    testAccount: true,
    label: 'Commerce',
    group: 'Campaign tools',
    nav: true,
    palette: true,
    aliases: ['Product catalog'],
    description: 'Product imports with per-item reviews and receipts',
    assets: ['commerce.js'],
  },
  {
    path: '/media',
    testAccount: true,
    label: 'Creative',
    nav: true,
    palette: true,
    aliases: ['Media library', 'Media'],
    description: 'Drive imports, formats, and reuse',
    assets: ['creative-push.js', 'creative-library.js', 'ad-previews.js', 'campaign-workflows.js'],
  },
  {
    path: '/report-library',
    testAccount: true,
    label: 'Reporting',
    nav: true,
    palette: true,
    aliases: ['Report library'],
    description: 'Saved client definitions, templates and retained snapshots',
    assets: ['report-workflows.js'],
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
    assets: [
      'reporting-overview.js',
      'report-quality.js',
      'report-library.js',
      'report-source-settings.js',
      'report-workflows.js',
    ],
  },
  {
    path: '/reports',
    testAccount: true,
    label: 'Evidence & analysis',
    group: 'Reporting tools',
    nav: true,
    palette: true,
    aliases: ['Reports'],
    description: 'Evidence, totals, and recommendations',
    assets: ['evidence-workflows.js', 'report-reference.js', 'report-quality.js'],
  },
  {
    path: '/schedules',
    testAccount: true,
    label: 'Schedules',
    group: 'Reporting tools',
    nav: true,
    palette: true,
    aliases: ['Schedules & deliveries'],
    description: 'Delivery times, windows and recovery',
    assets: ['work-center.js'],
  },
  {
    path: '/profiles',
    label: 'Clients & templates',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Client profiles', 'Client playbooks'],
    description: 'Templates, naming, and defaults',
    assets: ['client-playbooks.js'],
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
    testAccount: true,
    label: 'Measurement',
    group: 'Connection tools',
    nav: true,
    palette: true,
    aliases: ['Measurement diagnostics'],
    description: 'Tag Manager audits and measurement evidence',
    assets: ['measurement.js', 'measurement-trace-import.js'],
  },
  {
    path: '/connectors',
    testAccount: true,
    label: 'AI connectors',
    group: 'Connection tools',
    nav: true,
    palette: true,
    aliases: ['MCP connectors'],
    description: 'Codex, Claude, Cursor, and tokens',
  },
  {
    path: '/capabilities',
    testAccount: true,
    label: 'Capabilities',
    group: 'Connection tools',
    nav: true,
    palette: true,
    description: 'Workflow eligibility and native action contracts',
    assets: ['capability-center.js'],
  },
  {
    path: '/operations',
    testAccount: true,
    label: 'Operations',
    nav: true,
    palette: true,
    description: 'Campaign, media and delivery recovery',
    assets: ['operations-center.js'],
  },
  {
    path: '/monitors',
    testAccount: true,
    label: 'Monitoring inbox',
    group: 'Management',
    nav: true,
    palette: true,
    description: 'Read-only rules and evidence-linked incidents',
    assets: ['operations-center.js'],
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
    assets: ['owner-operations.js', 'account-approvals.js'],
  },
  {
    path: '/account',
    label: 'Your account',
    palette: true,
    testAccount: true,
    description: 'Profile, social sign-in, and security',
    assets: ['mfa-qr.js', 'account-deletion.js'],
  },
  // DOC-03: members only, opened from the shell footer and the palette (server/help-routes.ts).
  {
    path: '/help',
    label: 'Help',
    palette: true,
    aliases: ['Owner guide', 'Documentation'],
    description: 'The owner guide, task by task',
    assets: ['help.js'],
  },
  {
    path: '/report-pack',
    testAccount: true,
    label: 'Report pack',
    parent: '/report-library',
    assets: ['evidence-workflows.js'],
  },
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
// WEB-07: the shell's extension points (docs/PRODUCT-WORKFLOWS.md); scripts register, never reassign a shell function.
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
      renderer: path => renderers.get(path),
      extend(path, part, {order = 0} = {}) {
        known(path);
        if (!Number.isFinite(order)) throw TypeError('AMCP_EXTENSION_ORDER_INVALID');
        // Stable: equal orders keep registration order.
        parts.set(
          path,
          [...(parts.get(path) ?? []), {part: callable(part), order}].sort((a, b) => a.order - b.order),
        );
      },
      parts: path => (parts.get(path) ?? []).map(entry => entry.part),
      // A failing part stops the rest, as an unfinished page would. Each part gets what the page passes (its data).
      async renderParts(path, ...page) {
        for (const {part} of [...(parts.get(path) ?? [])]) await part(...page);
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
