import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

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
