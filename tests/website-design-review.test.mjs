import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

// Static guards for the design review of October 2026 (docs/review/DESIGN-REVIEW-2026-10.md). Each one names the
// rendered defect it guards; the browser runner (tools/browser-workflow-qa.mjs) checks the same states in the page.
const css = file => readFileSync('web/' + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The rules of a stylesheet outside @media blocks' own braces: {selector, body, index}. */
const rules = text =>
  [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m, index) => ({
    selector: m[1]
      .replace(/@media[^{]*$/, '')
      .trim()
      .replace(/\s+/g, ' '),
    body: m[2],
    index,
  }));
const declarations = body =>
  new Map([...body.matchAll(/(--[\w-]+|[a-z-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
/** The top-level selectors of a selector list (commas inside parentheses do not split). */
function splitList(list) {
  const out = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}
/** The argument of the first :is( ... ) of a selector, as a list. */
function isList(selector) {
  const at = selector.indexOf(':is(');
  if (at < 0) return [];
  let depth = 0;
  for (let i = at + 3; i < selector.length; i++) {
    if (selector[i] === '(') depth++;
    else if (selector[i] === ')' && --depth === 0) return splitList(selector.slice(at + 4, i));
  }
  return [];
}
/** CSS specificity [ids, classes, types] of one complex selector (Selectors 4: :is/:not/:has take their maximum). */
function specificity(selector) {
  let a = 0,
    b = 0,
    c = 0;
  const add = ([x, y, z]) => {
    a += x;
    b += y;
    c += z;
  };
  const max = list =>
    splitList(list)
      .map(specificity)
      .reduce((best, s) => (compare(s, best) > 0 ? s : best), [0, 0, 0]);
  for (let i = 0; i < selector.length;) {
    const rest = selector.slice(i);
    let m;
    if ((m = /^:(is|not|has|where)\(/.exec(rest))) {
      let depth = 0,
        j = i + m[0].length - 1;
      for (; j < selector.length; j++) {
        if (selector[j] === '(') depth++;
        else if (selector[j] === ')' && --depth === 0) break;
      }
      if (m[1] !== 'where') add(max(selector.slice(i + m[0].length, j)));
      i = j + 1;
    } else if ((m = /^::?(before|after|marker|placeholder|selection|backdrop)\b/.exec(rest))) {
      c++;
      i += m[0].length;
    } else if ((m = /^:[\w-]+(\([^)]*\))?/.exec(rest))) {
      b++;
      i += m[0].length;
    } else if ((m = /^#[\w-]+/.exec(rest))) {
      a++;
      i += m[0].length;
    } else if ((m = /^\.[\w-]+/.exec(rest)) || (m = /^\[[^\]]*\]/.exec(rest))) {
      b++;
      i += m[0].length;
    } else if ((m = /^[a-zA-Z][\w-]*/.exec(rest))) {
      c++;
      i += m[0].length;
    } else i++;
  }
  return [a, b, c];
}
function compare(x, y) {
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
/** Whether rule `a` wins over rule `b` for an element both match: higher specificity, or equal and later. */
const outranks = (a, b) => {
  const order = compare(specificity(a.selector), specificity(b.selector));
  return order > 0 || (order === 0 && a.index > b.index);
};

test('the specificity helper agrees with Selectors 4 on the shapes the stylesheets use', () => {
  assert.deepEqual(specificity("[data-theme='dark'] :is(.button, #command-results button)"), [1, 1, 1]);
  assert.deepEqual(specificity("[data-theme='dark'] :is(.button.primary, .button.primary:hover)"), [0, 4, 0]);
  assert.deepEqual(specificity('.social-button:hover:not(:disabled)'), [0, 3, 0]);
  assert.deepEqual(specificity(':where(.a, #b) .c'), [0, 1, 0]);
  assert.deepEqual(specificity('.step:before'), [0, 1, 1]);
});

// Before: theme.css's shared dark groups listed #command-results button (and #capture-feedback), and an :is() group
// takes the specificity of its most specific entry, so every .button, .status and .notice in the group was styled at
// ID level (1,1,1). The dark primary, danger and status-tone rules (0,3,0 to 0,4,0) never applied: in dark mode every
// primary and danger button looked like a plain button and every status badge lost its tone, on every page.
test('dark-mode button and status variants outrank the shared dark surfaces they refine', () => {
  const dark = rules(css('theme.css')).filter(r => r.selector.startsWith("[data-theme='dark']"));
  for (const rule of dark) {
    const list = isList(rule.selector);
    assert.ok(
      !(list.some(entry => entry.includes('#')) && list.some(entry => !entry.includes('#'))),
      'A shared dark :is() group mixes an ID entry with class entries, which lifts them all to ID specificity: ' +
        rule.selector.slice(0, 120),
    );
  }
  const holding = entry => dark.find(r => isList(r.selector).includes(entry));
  const surfaces = holding('.button'),
    hover = holding('.button:hover'),
    notices = holding('.notice'),
    primary = holding('.button.primary'),
    danger = holding('.button.danger'),
    online = holding('.status.online'),
    attention = holding('.status.attention');
  for (const [name, rule] of Object.entries({surfaces, hover, notices, primary, danger, online, attention}))
    assert.ok(rule, 'theme.css has no dark rule for ' + name);
  assert.ok(isList(surfaces.selector).includes('.status'), 'the shared surfaces still style .status');
  for (const variant of [primary, danger]) {
    assert.ok(outranks(variant, surfaces), variant.selector + ' must outrank ' + surfaces.selector);
    assert.ok(outranks(variant, hover), variant.selector + ' must outrank the hover states');
  }
  for (const tone of [online, attention]) assert.ok(outranks(tone, surfaces), tone.selector);
  assert.ok(isList(attention.selector).includes('.notice.warning'));
  assert.ok(outranks(attention, notices), 'a warning notice keeps its tone over the shared notice surface');
  // The variants still set the colours the light theme gives them a role for.
  assert.equal(declarations(primary.body).get('background'), 'var(--iris)');
  assert.equal(declarations(danger.body).get('color'), 'var(--danger)');
  // The command palette's results keep their dark surface and hover state, in rules of their own.
  assert.ok(dark.some(r => r.selector.includes('#command-results button') && isList(r.selector).length <= 2));
});

// Before: .dialog-actions laid its buttons out in one right-aligned row that never wrapped; on a 320 or 375 px phone
// the row overflowed to its start side, where the page cannot scroll: Reporting's "New report", Schedules' "Create a
// report and schedule" and Creative's "Previous recovery page" were off screen and unreachable (WCAG 1.4.10).
test('action rows wrap instead of pushing their first action off a phone screen', () => {
  const app = rules(css('app.css')),
    row = app.find(r => r.selector === '.dialog-actions');
  assert.ok(row, 'app.css defines .dialog-actions');
  const values = declarations(row.body);
  assert.equal(values.get('display'), 'flex');
  assert.equal(values.get('flex-wrap'), 'wrap');
  assert.ok(
    !app.some(
      r => splitList(r.selector).includes('.dialog-actions') && declarations(r.body).get('flex-wrap') === 'nowrap',
    ),
  );
});

// Before: the landing page's closing call to action sits on the dark .closing-note band, where the global iris-700
// ring measured 2.32:1 (light theme), and a scroll region Chrome makes focusable without tabindex (the AI connectors'
// command block on a phone) showed the browser's own 1px ring, 1.21:1 on the dark panel.
test('focus rings on the closing call to action and on focusable scroll regions are the identity’s own', () => {
  const access = rules(css('accessibility.css')),
    inverse = access.find(r => r.selector.includes('.closing-note') && declarations(r.body).has('outline-color'));
  assert.ok(inverse, 'the closing band takes the on-inverse ring');
  assert.equal(declarations(inverse.body).get('outline-color'), 'var(--focus-on-inverse)');
  for (const surface of ['.sidebar', '.toast', '.connector-hero', '.callback-top', '.closing-note'])
    assert.ok(isList(inverse.selector).includes(surface), surface);
  const band = declarations(rules(css('identity.css')).find(r => r.selector === '.closing-note').body).get(
    'background',
  );
  assert.equal(band, 'var(--surface-inverse)', 'the band is the theme-invariant inverse surface');
  const any = access.find(r => r.selector === ':focus-visible');
  assert.ok(any, 'any focusable element without its own ring takes the identity ring');
  assert.equal(declarations(any.body).get('outline'), '2px solid var(--iris-700)');
  assert.ok(
    splitList(inverse.selector).some(s => /\)\s+:focus-visible$/.test(s)),
    'every focusable element on an inverse surface takes the on-inverse ring, controls or not',
  );
});

// Before: the sidebar's icon rule (.sidebar nav a span, 20 px wide) also sized each link's label, so a label of two or
// more words broke at every space and centred: "Evidence & analysis" took three lines, and with a group open the
// current page's link could fall below the sidebar's foot at 1280 x 900.
test('a sidebar label takes the row beside its icon and reads from its start', () => {
  const identity = rules(css('identity.css'));
  const find = selector => identity.find(r => r.selector === selector);
  const shared = find('.sidebar nav a span'),
    label = find('.sidebar nav a span + span');
  assert.ok(shared && label, 'the label has a rule of its own beside the icon box');
  assert.equal(declarations(shared.body).get('width'), '20px', 'the icon keeps its 20 px box');
  const values = declarations(label.body);
  assert.equal(values.get('width'), 'auto', 'the label leaves the icon box');
  assert.equal(values.get('text-align'), 'start');
  assert.equal(values.get('min-width'), '0');
  assert.match(values.get('flex'), /^1\b/);
  // The label rule outranks the shared icon box and app.css's `nav a span` (21px, 23px wide, centred).
  assert.ok(outranks(label, shared));
  assert.ok(compare(specificity(label.selector), specificity('nav a span')) > 0);
});

// Before: the delivery dialog's labels were grids, so the export authorization's checkbox stood alone, centred, on a
// line above its text; and the sticky status bar that follows an export covered the authorization and the button.
test('the delivery dialog keeps a checkbox beside its text, and Export now keeps its status in the flow', () => {
  const reporting = rules(css('reporting.css'));
  const row = reporting.find(r => r.selector === ".report-delivery-dialog label:has(> input[type='checkbox'])");
  assert.ok(row, 'labels with a checkbox are rows');
  assert.equal(declarations(row.body).get('display'), 'flex');
  const box = declarations(reporting.find(r => r.selector === ".report-delivery-dialog input[type='checkbox']").body);
  assert.equal(box.get('width'), '18px', 'the box is not stretched across the dialog');
  const flow = reporting.find(r => r.selector === "#report-delivery-content[data-mode='sheets_now'] .delivery-status");
  assert.equal(declarations(flow.body).get('position'), 'static');
  const clear = reporting.find(r => r.selector.startsWith('.report-delivery-dialog:has(.delivery-status'));
  assert.ok(Number.parseFloat(declarations(clear.body).get('scroll-padding-block-end')) >= 120);
  assert.match(readFileSync('web/report-delivery.js', 'utf8'), /setAttribute\?\.\('data-mode', mode\)/);
});

// Before (WEB-06): every platform the deployment had not set up showed a primary "Set up →" to everyone. Only the site
// administrator's Settings hold a platform's setup (renderWorkspaceSettings); anyone else, workspace owners included,
// landed at the top of their own Settings with a six-second toast saying the site administrator sets it up. The card's
// "Administrator setup required" stays the explanation for them.
test('a platform the deployment has not set up offers Set up only to those who can act on it', () => {
  const app = readFileSync('web/app.js', 'utf8'),
    source = app.slice(app.indexOf('function platformConnectButton('), app.indexOf('function renderPlatformCards('));
  const context = createContext({Intl, document: {addEventListener() {}}, session: {}});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(source).runInContext(context);
  const button = (platform, logins, who) => {
    context.session = who;
    return String(context.platformConnectButton(platform, logins));
  };
  const unset = {id: 'reddit', configured: false},
    ready = {id: 'meta', configured: true};
  for (const role of ['viewer', 'operator', 'admin', 'owner']) {
    assert.equal(button(unset, 0, {workspaceRole: role}), 'false', role + ' has nothing to set up');
    assert.match(button(ready, 0, {workspaceRole: role}), /data-connect="meta"[^>]*>\+ Connect</);
  }
  assert.equal(button(unset, 0, {workspaceRole: 'owner', instanceOwner: true}), 'false');
  assert.match(
    button(unset, 0, {workspaceRole: 'owner', administrator: true}),
    /class="button small primary" data-connect="reddit">Set up →</,
  );
  assert.match(button(unset, 1, {workspaceRole: 'viewer'}), /\+ Add login/, 'a login that exists keeps its action');
  // The card still says why there is nothing to press.
  assert.match(app, /uiText\('Administrator setup required'\)/);
});

/** The dark theme's colour tokens (web/tokens.css), with var() references resolved. */
function darkTokens() {
  const text = readFileSync('web/tokens.css', 'utf8'),
    block = selector => {
      const at = text.indexOf(selector + ' {');
      return [...text.slice(at, text.indexOf('\n}', at)).matchAll(/(--[\w-]+):\s*([^;]+);/g)];
    },
    tokens = Object.fromEntries([...block(':root'), ...block(":root[data-theme='dark']")].map(m => [m[1], m[2]]));
  const resolve = value => {
    const m = /^var\((--[\w-]+)\)$/.exec(value?.trim() ?? '');
    return m ? resolve(tokens[m[1]]) : value;
  };
  return name => resolve(`var(${name})`);
}
function contrast(a, b) {
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

// Before: in dark mode a checked metric pill on the report builder is filled with the iris accent, and the formula under
// the metric's name kept the muted shade meant for the page: #c0b5ce on #c7adff, 1.01:1 (axe, period comparison in dark
// mode). The ID-lifted dark group that 2026-10's first fix split had hidden it by never letting the filled pill apply.
test('a checked metric pill keeps its formula readable in dark mode', () => {
  const dark = rules(css('theme.css')).filter(r => r.selector.startsWith("[data-theme='dark']")),
    token = darkTokens(),
    filled = dark.find(r => isList(r.selector).includes('.metric-pills input:checked + span'));
  assert.ok(filled, 'theme.css fills a checked metric pill in dark mode');
  const pill = declarations(filled.body);
  assert.equal(pill.get('background'), 'var(--iris)');
  const formula = dark.find(
    r => r.selector === "[data-theme='dark'] .metric-pills input:checked + span .metric-formula",
  );
  assert.ok(formula, 'the formula on a checked pill has a dark rule of its own');
  const own = declarations(formula.body).get('color');
  const colour = own === 'inherit' ? pill.get('color') : own;
  assert.ok(
    contrast(token(colour.replace(/^var\((.+)\)$/, '$1')), token('--iris')) >= 4.5,
    'formula text on the filled pill reaches 4.5:1',
  );
  // It outranks the shared .metric-formula rule (accessibility.css, loaded last).
  const shared = rules(css('accessibility.css')).find(r => r.selector === '.metric-formula');
  assert.equal(declarations(shared.body).get('color'), 'var(--muted)');
  assert.ok(compare(specificity(formula.selector), specificity(shared.selector)) > 0);
  assert.ok(contrast(token('--muted'), token('--iris')) < 1.5, 'the shade it replaces is unreadable on the pill');
});

// Before: a workspace form laid every label out as a grid, so the plan filters' "Awaiting my approval" and "Archived
// plans" boxes stood alone, centred, on a line above their words, right under the search field they seemed to belong to.
test('a checkbox in a workspace form sits beside its words', () => {
  const app = rules(css('app.css')),
    grid = app.find(r => r.selector === '.workspace-form label'),
    row = app.find(r => r.selector === ".workspace-form label:where(:has(> input[type='checkbox']))");
  assert.equal(declarations(grid.body).get('display'), 'grid');
  assert.ok(row, 'labels holding a checkbox are rows');
  assert.equal(declarations(row.body).get('display'), 'flex');
  // Same weight as the grid rule (:where adds none) and later, so it wins there, and a component's own checkbox
  // layout (.form-note, .review-consents, the report platform checks) still decides its own.
  assert.equal(compare(specificity(row.selector), specificity(grid.selector)), 0);
  assert.ok(row.index > grid.index);
  // The plan filters are such labels.
  assert.match(
    readFileSync('web/campaign-workflows.js', 'utf8'),
    /<form id="campaign-filters" class="workspace-form"[\s\S]{0,800}?<label class="check"><input name="approval" type="checkbox"/,
  );
});

// Before: the owner's Pause all writes, retention and approval forms had no form style: native square inputs with a
// 2 px inset border beside the styled spending-policy form of the same Settings page.
test('the owner settings forms take the workspace form style', () => {
  const source = readFileSync('web/owner-operations.js', 'utf8');
  for (const id of [
    'owner-pause-writes',
    'owner-retention',
    'owner-plan-retention',
    'owner-plan-policy',
    'owner-export-policy',
    'owner-spend-policy',
  ])
    assert.match(source, new RegExp(`<form id="${id}" class="workspace-form"`), id);
  assert.doesNotMatch(source, /<form id="owner-[a-z-]+">/, 'no owner form without the shared style');
});

// Before: the measurement ledger's layer names broke inside words at 1280 px ("Configurat-ion", "diagnostic-s"): the
// three value columns kept 10rem each and the row header shrank below its longest word.
test('the measurement ledger breaks layer names between words', () => {
  const workflows = rules(css('workflows.css')),
    header = workflows.find(r => r.selector === '.measurement-ledger tbody th'),
    shared = workflows.find(r => r.selector === '.measurement-ledger td, .measurement-ledger th');
  assert.ok(header && shared);
  assert.equal(declarations(shared.body).get('overflow-wrap'), 'anywhere');
  assert.equal(declarations(header.body).get('overflow-wrap'), 'normal');
  assert.ok(Number.parseFloat(declarations(header.body).get('min-width')) >= 8);
  assert.ok(compare(specificity(header.selector), specificity('.measurement-ledger th')) > 0);
});
