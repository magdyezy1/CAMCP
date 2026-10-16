import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Static contrast guards for the shell states the rendered runner cannot reach without focus or populated data
// (WEB-01). Values come from the shipped stylesheets, so a palette edit that breaks a pair fails here.
const css = file => readFileSync('web/' + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const block = (text, selector) => {
  const start = text.indexOf(selector + ' {');
  assert.ok(start >= 0, 'Missing rule ' + selector);
  return text.slice(start, text.indexOf('}', start));
};
const declarations = body =>
  new Map([...body.matchAll(/(--[\w-]+|[a-z-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const tokens = css('tokens.css'),
  light = declarations(block(tokens, ':root')),
  dark = new Map([...light, ...declarations(block(tokens, ":root[data-theme='dark']"))]);
const resolve = (theme, value) => {
  for (let depth = 0; depth < 8; depth++) {
    const reference = /^var\((--[\w-]+)\)$/.exec(value);
    if (!reference) return value;
    value = theme.get(reference[1]);
    assert.ok(value, 'Unknown token ' + reference[1]);
  }
  throw Error('Token reference cycle');
};
const channel = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = hex => {
  const value = hex.replace('#', ''),
    full = value.length === 3 ? [...value].map(c => c + c).join('') : value;
  assert.match(full, /^[0-9a-f]{6}$/i, 'Opaque colour expected: ' + hex);
  const [r, g, b] = [0, 2, 4].map(i => channel(parseInt(full.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

test('focus rings on the dark sidebar, toast, connector hero and callback header reach 3:1 in both themes', () => {
  const identity = css('identity.css'),
    surfaces = {
      sidebar: declarations(block(identity, '.sidebar')).get('background'),
      toast: declarations(block(identity, '.toast')).get('background'),
      callback: declarations(block(identity, '.callback-top')).get('background'),
    },
    hero = declarations(block(identity, '.connector-hero')).get('background');
  const backgrounds = [...Object.values(surfaces), ...hero.match(/#[0-9a-f]{6}/gi)];
  assert.equal(backgrounds.length, 5);
  for (const theme of [light, dark]) {
    const ring = resolve(theme, 'var(--focus-on-inverse)');
    for (const background of backgrounds)
      assert.ok(contrast(ring, background) >= 3, ring + ' on ' + background + ': ' + contrast(ring, background));
  }
  // The regression itself: the global ring on these surfaces in the light theme.
  assert.ok(contrast(resolve(light, 'var(--iris-700)'), surfaces.sidebar) < 3);
  const rule = css('accessibility.css');
  assert.match(rule, /:is\(\.sidebar, \.toast, \.connector-hero, \.callback-top\)/);
  assert.match(rule, /outline-color: var\(--focus-on-inverse\)/);
});

test('every skip link takes its text and background from the theme and reaches 4.5:1 in light and dark', () => {
  for (const [file, selector] of [
    ['app.css', '.skip'],
    ['about.css', '.skip'],
    ['privacy.css', '.skip-link'],
  ]) {
    const rule = declarations(block(css(file), selector));
    assert.equal(rule.get('color'), 'var(--ink)', file);
    assert.equal(rule.get('background'), 'var(--white)', file);
    for (const theme of [light, dark])
      assert.ok(contrast(resolve(theme, rule.get('color')), resolve(theme, rule.get('background'))) >= 4.5, file);
  }
});

test('each recommendation decision has its own colour pair at 4.5:1 or more in both themes', () => {
  const reporting = css('reporting.css'),
    pills = {
      hold: '.recommendation-pill',
      positive: '.recommendation-pill.decision-scale',
      steady: '.recommendation-pill.decision-maintain',
      caution: '.recommendation-pill.decision-pull_back',
      negative: '.recommendation-pill.decision-reconsider_pause',
    };
  for (const theme of [light, dark]) {
    const pairs = new Set();
    for (const [meaning, selector] of Object.entries(pills)) {
      const rule = declarations(block(reporting, selector));
      assert.equal(rule.get('color'), 'var(--decision-' + meaning + '-ink)', selector);
      const ink = resolve(theme, rule.get('color')),
        background = resolve(theme, rule.get('background'));
      assert.ok(contrast(ink, background) >= 4.5, selector + ': ' + contrast(ink, background));
      pairs.add(ink + '/' + background);
      assert.match(reporting, new RegExp(selector.replaceAll('.', '\\.') + '::before \\{\\s*content: '));
    }
    assert.equal(pairs.size, 5, 'Two decisions must not share one colour pair');
  }
  // Dark-theme groups must not override the decision tokens again (the original tie made Scale look like Needs review).
  assert.doesNotMatch(css('theme.css'), /recommendation-pill|decision-/);
});

test('troubleshooting and schedule text uses themed colours at the 12px floor', () => {
  const reporting = css('reporting.css');
  assert.equal(declarations(block(reporting, '.source-diagnostic > strong')).get('color'), 'var(--danger)');
  for (const selector of ['.schedule-row small', '.custom-metric-row code']) {
    const rule = declarations(block(reporting, selector));
    assert.equal(rule.get('color'), 'var(--muted)', selector);
    assert.equal(rule.get('font-size'), '12px', selector);
  }
  // No top-bar text in any media query is below the floor (it was 11px and 10px at 850px and narrower).
  const identity = css('identity.css');
  for (const selector of ['.topbar .button', '.topbar .breadcrumb'])
    for (const match of identity.matchAll(new RegExp(selector.replaceAll('.', '\\.') + ' \\{([^}]*)\\}', 'g'))) {
      const size = declarations(match[1]).get('font-size');
      if (size) assert.ok(Number.parseFloat(size) >= 12, selector + ' ' + size);
    }
});

// Browser QA wave 2 regression (QA-03's intermediate-state axe run on the open delivery dialog): the dialog's body text
// was the literal #897593, 4.11:1 on the dialog, 3.69:1 on the report context and 3.57:1 on a notice.
test('report delivery dialog text reaches 4.5:1 on the dialog, its report context and its notices', () => {
  const reporting = css('reporting.css'),
    identity = css('identity.css'),
    text = declarations(block(reporting, '.report-delivery-dialog p')).get('color'),
    notice = declarations(block(reporting, '.report-delivery-dialog p.notice')).get('color'),
    surfaces = [
      declarations(block(reporting, '.report-delivery-dialog')).get('background'),
      declarations(block(reporting, '.delivery-report-context')).get('background'),
    ];
  assert.equal(text, 'var(--muted)');
  for (const background of surfaces)
    assert.ok(contrast(resolve(light, text), background) >= 4.5, text + ' on ' + background);
  const noticeBackground = declarations(block(identity, '.notice')).get('background');
  assert.ok(contrast(resolve(light, notice), noticeBackground) >= 4.5, notice + ' on ' + noticeBackground);
  // The regression itself: the old literal on the same surfaces.
  assert.ok(surfaces.every(background => contrast('#897593', background) < 4.5));
});

// WEB-01 asks for both themes. In the dark theme web/theme.css gives the dialog var(--white), its report context
// var(--surface-subtle) and a notice var(--surface-accent); dialog paragraphs inherit the dialog's ink there, and the
// light theme's muted token is checked too, so either text token stays readable on each dark surface.
const darkBackground = (theme, selector) => {
  const pattern = new RegExp('(^|[\\s(,])' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[,)]', 'g');
  for (const match of theme.matchAll(pattern)) {
    const open = theme.indexOf('{', match.index),
      head = theme.slice(theme.lastIndexOf('}', match.index) + 1, open);
    if (!head.includes("[data-theme='dark']")) continue;
    const background = declarations(theme.slice(open + 1, theme.indexOf('}', open))).get('background');
    if (background) return background;
  }
  assert.fail('No dark-theme background for ' + selector);
};
test('report delivery dialog text reaches 4.5:1 in the dark theme too, on the dialog, its context and a notice', () => {
  const theme = css('theme.css');
  assert.match(theme, /\[data-theme='dark'\]\s*:is\(\s*p,/, 'dark paragraphs inherit their container ink');
  for (const selector of ['.report-delivery-dialog', '.delivery-report-context', '.notice']) {
    const background = resolve(dark, darkBackground(theme, selector));
    for (const text of ['var(--ink)', 'var(--muted)']) {
      const ratio = contrast(resolve(dark, text), background);
      assert.ok(ratio >= 4.5, text + ' on ' + selector + ' (' + background + '): ' + ratio.toFixed(2));
    }
  }
});

// Wave 3a browser qualification regression (axe, final state of the worker-health journey at 320 and 375 pixels): the
// Settings section link under the pointer read at 1.27:1, the light theme's ink on the dark sidebar's hover surface,
// because app.css gave every nav link the sidebar's hover and current-page colours.
test("the sidebar's link hover and current-page colours stay on the sidebar; Settings section links keep their pair", () => {
  const app = css('app.css'),
    selectors = [...app.matchAll(/([^{}]+)\{/g)].flatMap(m => m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ')));
  assert.deepEqual(
    selectors.filter(s => /(^|\s)nav a(:hover|\.active)/.test(s) && !s.startsWith('.sidebar ')),
    [],
    'Sidebar link states in app.css are scoped to .sidebar',
  );
  // The rule body only: the selector's own colon would read as a declaration.
  const hover = declarations(block(app, '.sidebar nav a:hover').split('{')[1]).get('background'),
    section = declarations(block(css('reporting.css'), '.settings-subnav a'));
  assert.equal(hover, '#27392e');
  for (const theme of [light, dark]) {
    const ratio = contrast(resolve(theme, section.get('color')), resolve(theme, section.get('background')));
    assert.ok(ratio >= 4.5, 'Settings section link: ' + ratio.toFixed(2));
  }
  // The regression itself: the section link's light-theme ink on the sidebar's hover surface.
  assert.ok(contrast(resolve(light, section.get('color')), hover) < 4.5);
});
