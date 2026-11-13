'use strict';
// WEB-06: the one route registry. Every page the workspace shell serves is listed once, in navigation order: its path,
// its canonical name (the navigation label, owner decision D27), the navigation group it sits in, the names it was
// known by before (the command palette still finds them), and whether a test account, a sign-in return or the
// command palette may open it. Titles, breadcrumbs, headings, the palette, client routing, sign-in returns and
// test-account scope all read this list. server/website.ts serves exactly these paths (tests/route-registry.test.mjs)
// and tools/check-routes.mjs fails `check-web` when a consumer that cannot read it drifts from it.
//
// V2-WEB-03: the registry also draws the shell. Pages are listed group by group (routeGroups gives the seven groups in the
// order the sidebar shows them) and web/identity.js builds the navigation from this list, so a page is added, renamed
// or moved here and nowhere else. Every path is as it was: bookmarks and links keep working.
//
// Fields: label is the canonical name; group is the navigation group that holds the link (one of routeGroups); icon
// names the glyph of a link (web/identity.js, one glyph per link); subtitle is the sentence under the page's heading;
// nav marks a sidebar link; menu: 'user' marks a link of the user menu and the sidebar footer (Account, Help); palette
// marks a command-palette entry; testAccount marks a page a test account may open; public marks a page for people who
// are not signed in; returnable:false keeps a page out of sign-in returns; parent names the page a page leads back to:
// the hub of its group (the group's first page) for a page of the navigation, the page it belongs to for a child page
// (its breadcrumb, its highlighted navigation link and where a failed page offers to go); section is the page key the
// renderer dispatches on when it differs from the path; assets are the files web/route-assets.js loads for it. Only
// English interface text is written here; the Arabic catalog translates it like every other message.
const routeGroups = Object.freeze([
  'Home',
  'Reports',
  'Creatives',
  'Campaigns',
  'Connections',
  'Operations',
  'Settings',
]);
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
    group: 'Home',
    icon: 'overview',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Overview', 'Dashboard'],
    description: 'Work needing attention and account readiness',
    subtitle: 'Welcome back. Continue your work or start a new task.',
    assets: ['work-center.js'],
  },
  {
    path: '/report-library',
    testAccount: true,
    label: 'Reporting',
    group: 'Reports',
    icon: 'library',
    nav: true,
    palette: true,
    aliases: ['Report library'],
    description: 'Saved client definitions, templates and retained snapshots',
    subtitle: 'Saved reports, templates and the snapshots kept for each client.',
    assets: ['report-workflows.js'],
  },
  {
    path: '/reporting-overview',
    label: 'Report builder',
    group: 'Reports',
    icon: 'builder',
    parent: '/report-library',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Reporting overview'],
    description: 'Campaign metrics, recommendations and scheduled Sheets exports',
    subtitle: 'Campaigns, ad sets and ads in one report. Every number keeps its source and measurement context.',
    assets: [
      'reporting-overview.js',
      'report-quality.js',
      'report-library.js',
      'report-source-settings.js',
      'report-workflows.js',
      'charts.js',
    ],
  },
  {
    path: '/schedules',
    testAccount: true,
    label: 'Schedules',
    group: 'Reports',
    icon: 'schedules',
    parent: '/report-library',
    nav: true,
    palette: true,
    aliases: ['Schedules & deliveries'],
    description: 'Delivery times, windows and recovery',
    subtitle: 'When each report is delivered, which dates it covers and how a missed delivery recovers.',
    assets: ['work-center.js'],
  },
  {
    path: '/reports',
    testAccount: true,
    label: 'Evidence & analysis',
    group: 'Reports',
    icon: 'evidence',
    parent: '/report-library',
    nav: true,
    palette: true,
    aliases: ['Reports'],
    description: 'Evidence, totals, and recommendations',
    subtitle: 'The evidence behind each number, with its totals and the recommendations it supports.',
    assets: ['evidence-workflows.js', 'report-reference.js', 'report-quality.js'],
  },
  {
    path: '/media',
    testAccount: true,
    label: 'Creative',
    group: 'Creatives',
    icon: 'media',
    nav: true,
    palette: true,
    aliases: ['Media library', 'Media'],
    description: 'Drive imports, formats, and reuse',
    subtitle: 'Bring creative in from Drive, preview it for each placement and reuse it.',
    assets: ['creative-push.js', 'creative-library.js', 'ad-previews.js', 'campaign-workflows.js'],
  },
  {
    path: '/campaigns',
    testAccount: true,
    label: 'Campaigns',
    group: 'Campaigns',
    icon: 'campaign',
    nav: true,
    palette: true,
    aliases: ['Campaign plans'],
    description: 'Plans, dependencies, reviews',
    subtitle: 'Plan campaigns, check what each one depends on and review every change before it runs.',
    assets: ['campaign-recipes.js', 'campaign-workflows.js'],
  },
  {
    path: '/portfolio',
    testAccount: true,
    label: 'Live portfolio',
    group: 'Campaigns',
    icon: 'portfolio',
    parent: '/campaigns',
    nav: true,
    palette: true,
    aliases: ['Live account portfolio', 'Portfolio'],
    description: 'Browse current campaigns, ad groups, ad sets and ads',
    subtitle: 'Browse the campaigns, ad groups, ad sets and ads that are running in your accounts.',
    assets: ['portfolio.js'],
  },
  {
    path: '/commerce',
    testAccount: true,
    label: 'Commerce',
    group: 'Campaigns',
    icon: 'commerce',
    parent: '/campaigns',
    nav: true,
    palette: true,
    aliases: ['Product catalog'],
    description: 'Product imports with per-item reviews and receipts',
    subtitle: 'Import product catalogs and review each item before it is sent.',
    assets: ['commerce.js'],
  },
  {
    path: '/connections',
    label: 'Connections',
    group: 'Connections',
    icon: 'connection',
    nav: true,
    palette: true,
    testAccount: true,
    description: 'Platforms, accounts, and permissions',
    subtitle: 'Connect your platforms. Choose what AMCP can access.',
  },
  {
    path: '/measurement',
    testAccount: true,
    label: 'Measurement',
    group: 'Connections',
    icon: 'measurement',
    parent: '/connections',
    nav: true,
    palette: true,
    aliases: ['Measurement diagnostics'],
    description: 'Tag Manager audits and measurement evidence',
    subtitle: 'Tag Manager audits and the evidence behind your conversion tracking.',
    assets: ['measurement.js', 'measurement-trace-import.js'],
  },
  {
    path: '/connectors',
    testAccount: true,
    label: 'AI connectors',
    group: 'Connections',
    icon: 'connector',
    parent: '/connections',
    nav: true,
    palette: true,
    aliases: ['MCP connectors'],
    description: 'Codex, Claude, Cursor, and tokens',
    subtitle: 'Give your AI tools access to the accounts you select.',
  },
  {
    path: '/capabilities',
    testAccount: true,
    label: 'Capabilities',
    group: 'Connections',
    icon: 'capabilities',
    parent: '/connections',
    nav: true,
    palette: true,
    description: 'Workflow eligibility and native action contracts',
    subtitle: 'What AMCP can do on each account, and which of it has been verified.',
    assets: ['capability-center.js'],
  },
  {
    path: '/operations',
    testAccount: true,
    label: 'Operations',
    group: 'Operations',
    icon: 'operations',
    nav: true,
    palette: true,
    description: 'Campaign, media and delivery recovery',
    subtitle:
      'Follow work across campaigns, uploads, reports and monitoring. Open the original record to inspect its evidence and continue.',
    assets: ['operations-center.js'],
  },
  {
    path: '/monitors',
    testAccount: true,
    label: 'Monitoring inbox',
    group: 'Operations',
    icon: 'monitors',
    parent: '/operations',
    nav: true,
    palette: true,
    description: 'Read-only rules and evidence-linked incidents',
    subtitle: 'Follow evidence, triage incidents and adjust account-specific rules.',
    assets: ['operations-center.js'],
  },
  {
    path: '/activity',
    label: 'Audit activity',
    group: 'Operations',
    icon: 'activity',
    parent: '/operations',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Activity'],
    description: 'Your workspace audit history',
    subtitle: 'Account activity and your workspace events, within current access.',
  },
  {
    path: '/settings',
    label: 'Workspace settings',
    group: 'Settings',
    icon: 'settings',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Settings'],
    description: 'Platform and deployment setup',
    subtitle: 'Your account, your connected platforms and how this deployment is set up.',
    assets: ['owner-operations.js', 'account-approvals.js'],
  },
  {
    path: '/profiles',
    label: 'Clients & templates',
    group: 'Settings',
    icon: 'profile',
    parent: '/settings',
    nav: true,
    palette: true,
    testAccount: true,
    aliases: ['Client profiles', 'Client playbooks'],
    description: 'Templates, naming, and defaults',
    subtitle: 'Client profiles with their naming, tracking and reusable templates.',
    assets: ['client-playbooks.js'],
  },
  {
    path: '/account',
    label: 'Your account',
    icon: 'account',
    menu: 'user',
    parent: '/dashboard',
    palette: true,
    testAccount: true,
    description: 'Profile, social sign-in, and security',
    subtitle: 'Your profile, your sign-in methods, and the sessions you control.',
    assets: ['mfa-qr.js', 'account-deletion.js'],
  },
  // DOC-03: members only, opened from the shell footer, the user menu and the palette (server/help-routes.ts).
  {
    path: '/help',
    label: 'Help',
    icon: 'help',
    menu: 'user',
    parent: '/dashboard',
    palette: true,
    aliases: ['Owner guide', 'Documentation'],
    description: 'The owner guide, task by task',
    subtitle: 'The owner guide: what AMCP does for you and what stays with you, task by task.',
    assets: ['help.js'],
  },
  {
    path: '/report-pack',
    testAccount: true,
    label: 'Report pack',
    group: 'Reports',
    parent: '/report-library',
    subtitle: 'A retained snapshot, ready to review, print or download.',
    assets: ['evidence-workflows.js'],
  },
  // V2-WEB-02: every component in every state, for members, not in the navigation (docs/DESIGN-SYSTEM.md).
  {
    path: '/design-system',
    label: 'Design system',
    subtitle: 'Every shared component in every state, in both languages and both themes.',
    assets: ['design-system.js'],
  },
  {
    path: '/oauth/consent',
    label: 'Authorize access',
    parent: '/connections',
    section: 'connections',
    testAccount: true,
    subtitle: 'Review what an AI client is asking to reach before you allow it.',
  },
  {
    path: '/oauth/result',
    label: 'Connection result',
    parent: '/connections',
    section: 'connections',
    testAccount: true,
    returnable: false,
    subtitle: 'How your platform connection finished, and what to do next.',
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
/** The link a path highlights: a page with a link of its own (navigation, user menu) that link, any other page its parent's. */
function routeNavigationKey(path) {
  const entry = routeEntry(path);
  if (!entry || entry.public) return '';
  return (entry.nav || entry.menu ? entry.path : (entry.parent ?? entry.path)).slice(1);
}
/** The English sentence under a page's heading, from the registry; callers translate it with uiText. */
function routeSubtitle(path) {
  return routeEntry(path)?.subtitle ?? '';
}
/** The navigation as data (V2-WEB-03): each group in order with its pages and its hub, the page that opens the group. */
function routeNavigation() {
  return routeGroups.map(name => {
    const entries = routeRegistry.filter(entry => entry.nav && entry.group === name);
    return {name, hub: entries[0]?.path, entries};
  });
}
/** The page a failed or empty page leads back to: its parent, Home for a hub, nothing for Home and the public pages. */
function routeBack(path) {
  const entry = routeEntry(path);
  if (!entry || entry.public || entry.path === '/dashboard') return undefined;
  return routeEntry(entry.parent ?? '/dashboard');
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
