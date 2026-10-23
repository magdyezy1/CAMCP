const interactiveRoles = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'spinbutton',
  'switch',
  'radio',
  'slider',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'searchbox',
  'listbox',
  'treeitem',
  'DisclosureTriangle',
  'dialog',
  'alertdialog',
]);

export function accessibilityTreeSummary(nodes) {
  if (!Array.isArray(nodes)) throw Error('Accessibility inspection did not return a node list.');
  const exposed = nodes.filter(node => !node.ignored);
  const controls = exposed.filter(node => interactiveRoles.has(node.role?.value));
  return {
    exposed_nodes: exposed.length,
    interactive_controls: controls.length,
    unnamed_controls: controls
      .filter(node => !String(node.name?.value ?? '').trim())
      .map(node => ({role: node.role.value, backend_dom_node: node.backendDOMNodeId ?? null})),
    main_count: exposed.filter(node => node.role?.value === 'main').length,
    primary_heading_count: exposed.filter(
      node =>
        node.role?.value === 'heading' &&
        node.properties?.some(property => property.name === 'level' && property.value?.value === 1),
    ).length,
  };
}

/** Inspect the actual Chromium tree and local ID references without changing the page. */
export async function inspectBrowserAccessibility(page) {
  const session = await page.context().newCDPSession(page);
  let tree,
    enabled = false;
  try {
    await session.send('Accessibility.enable');
    enabled = true;
    tree = await session.send('Accessibility.getFullAXTree');
  } finally {
    try {
      if (enabled) await session.send('Accessibility.disable');
    } finally {
      await session.detach();
    }
  }
  const ids = await page.evaluate(() => {
    const counts = new Map(),
      missing = [];
    for (const element of document.querySelectorAll('[id]')) counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
    for (const element of document.querySelectorAll('[aria-labelledby],[aria-describedby],[aria-controls]'))
      for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls'])
        for (const reference of (element.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean))
          if (!document.getElementById(reference))
            missing.push({element: element.id || element.tagName, attribute, reference});
    return {
      missing_references: missing,
      duplicate_ids: [...counts].filter(([, count]) => count > 1).map(([id, count]) => ({id, count})),
    };
  });
  return {...accessibilityTreeSummary(tree.nodes), ...ids};
}

export function accessibilityProblems(summary, {requireLandmarks = true} = {}) {
  const problems = [];
  if (summary.unnamed_controls.length)
    problems.push('Unnamed accessibility controls: ' + summary.unnamed_controls.length);
  if (summary.missing_references.length)
    problems.push('Unresolved ARIA ID references: ' + summary.missing_references.length);
  if (summary.duplicate_ids.length) problems.push('Duplicate HTML IDs: ' + summary.duplicate_ids.length);
  if (requireLandmarks && summary.main_count !== 1)
    problems.push('Expected one exposed main landmark, observed ' + summary.main_count);
  if (requireLandmarks && summary.primary_heading_count !== 1)
    problems.push('Expected one exposed primary heading, observed ' + summary.primary_heading_count);
  return problems;
}

// Focus-indicator contrast (QA-03, WCAG 1.4.11): the colour of a focused control's ring against the nearest opaque
// surface behind it. The page reports computed colours; the ratio is computed here, so it is testable without a browser.

/** Every rgb()/rgba() colour in a computed CSS value (a gradient yields each stop). */
export function cssColours(value) {
  return [...String(value ?? '').matchAll(/rgba?\(([^)]+)\)/g)].map(match => {
    const [r, g, b, a = 1] = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(part => (part.endsWith('%') ? Number.parseFloat(part) / 100 : Number(part)));
    return {r, g, b, a};
  });
}
const channel = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = c => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
/** WCAG contrast ratio of two opaque colours. */
export function contrastRatio(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** The controls whose focus ring is measured on every rendered case, in the order they are focused. */
export const focusIndicatorTargets = Object.freeze([
  {name: 'skip link', selector: '.skip, .skip-link'},
  {name: 'sidebar link', selector: '#workspace-sidebar a[href]'},
  {name: 'primary button', selector: 'main .button.primary, main button.primary'},
  {
    name: 'form field',
    selector:
      'main input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), main select, main textarea',
  },
  // Design review 2026-10: the landing page's closing call to action sits on the dark band (2.32:1 with the global
  // ring), and a command block Chrome makes focusable once it scrolls showed the browser's own ring (1.21:1, dark).
  {name: 'inverse band link', selector: '.closing-note a[href]'},
  {name: 'scroll region', selector: 'main pre.code-block'},
]);

/**
 * Runs in the page: the visible controls that lie past the page's start edge, where no scrolling reaches them (WCAG
 * 1.4.10). The reflow check measures only the end side (scrollWidth); a right-aligned action row that did not wrap put
 * Reporting's "New report" at -114 px on a 375 px screen (design review 2026-10). A control inside a horizontal scroll
 * region is left to that region, and the closed phone sidebar and the skip link are off-screen by design.
 */
export function collectStartOverflow() {
  const width = document.documentElement.clientWidth,
    rtl = getComputedStyle(document.documentElement).direction === 'rtl',
    drawerClosed = !document.body.classList.contains('menu-open'),
    out = [];
  const scrolls = element => {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement)
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowX)) return true;
    return false;
  };
  for (const element of document.querySelectorAll(
    'a[href], button, input:not([type=hidden]), select, textarea, summary',
  )) {
    if (element.closest('[inert], [hidden], dialog:not([open]), .skip, .skip-link')) continue;
    if (drawerClosed && element.closest('#workspace-sidebar')) continue;
    const visible =
      typeof element.checkVisibility === 'function'
        ? element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
        : element.getClientRects().length > 0;
    const box = element.getBoundingClientRect();
    if (!visible || box.width <= 1 || box.height <= 1) continue;
    out.push({
      control:
        element.tagName.toLowerCase() +
        (element.id ? '#' + element.id : '') +
        [...element.classList]
          .slice(0, 2)
          .map(name => '.' + name)
          .join(''),
      left: Math.round(box.left),
      right: Math.round(box.right),
      in_scroll_region: scrolls(element),
    });
  }
  return {width, rtl, controls: out};
}
/** The controls of a start-overflow sample that no scrolling can bring into view. */
export function startOverflowProblems(sample) {
  const {width = 0, rtl = false, controls = []} = sample ?? {};
  return controls
    .filter(c => !c.in_scroll_region && (rtl ? c.right > width + 1 : c.left < -1))
    .map(c => `${c.control} lies past the page's start edge (${c.left} to ${c.right} of ${width} px)`);
}

/**
 * Runs in the page: the computed colours of the first visible button and status badge of each variant in main. In
 * the dark theme a shared group of theme.css once outranked every variant (design review 2026-10), so a primary or
 * danger button looked like any other button and status badges lost their tone.
 */
export function collectVariantColours() {
  const first = selector =>
    [...document.querySelectorAll(selector)].find(
      element =>
        !element.closest('[hidden], [inert], dialog:not([open])') &&
        (typeof element.checkVisibility === 'function'
          ? element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
          : element.getClientRects().length > 0),
    );
  const colours = selector => {
    const element = first(selector);
    if (!element) return null;
    const style = getComputedStyle(element);
    return {color: style.color, background: style.backgroundColor, border: style.borderTopColor};
  };
  return {
    plain: colours('main .button:not(.primary):not(.danger):not(.quiet):not(:disabled)'),
    primary: colours('main .button.primary:not(:disabled)'),
    danger: colours('main .button.danger:not(:disabled)'),
    online: colours('main .status.online'),
    attention: colours('main .status.attention'),
    offline: colours('main .status.offline'),
  };
}
/** The variants that render exactly like their plain counterpart; a variant missing from the page is not measured. */
export function variantColourProblems(sample) {
  const same = (a, b, keys) => a && b && keys.every(key => a[key] === b[key]);
  const problems = [];
  if (same(sample?.primary, sample?.plain, ['color', 'background']))
    problems.push('A primary button is coloured like a plain button');
  if (same(sample?.danger, sample?.plain, ['color', 'background', 'border']))
    problems.push('A danger button is coloured like a plain button');
  for (const tone of ['online', 'attention'])
    if (same(sample?.[tone], sample?.offline, ['color', 'background', 'border']))
      problems.push('An ' + tone + ' status badge has the neutral badge’s colours');
  return problems;
}

/**
 * Runs in the page: where each visible checkbox or radio sits against the first line of its label's own words. A
 * workspace form laid its labels out as grids (design review 2026-10), so the plan filters' boxes stood alone, centred,
 * on a line above their words. A label whose words are inside a child element (the report builder's metric pills hide
 * their box and style a span) has no first line of its own and is not measured.
 */
export function collectCheckboxLabels() {
  const out = [];
  for (const label of document.querySelectorAll('label')) {
    const box = label.querySelector('input[type=checkbox], input[type=radio]');
    if (!box || label.closest('[hidden], [inert], dialog:not([open])')) continue;
    const visible =
      typeof box.checkVisibility === 'function'
        ? box.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
        : box.getClientRects().length > 0;
    const words = [...label.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
    const b = box.getBoundingClientRect();
    if (!visible || !words || b.width <= 2 || b.height <= 2) continue;
    const range = document.createRange();
    range.selectNodeContents(words);
    const line = range.getClientRects()[0];
    if (!line) continue;
    out.push({
      label: words.textContent.trim().slice(0, 60),
      box: {left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom)},
      line: {
        left: Math.round(line.left),
        right: Math.round(line.right),
        top: Math.round(line.top),
        bottom: Math.round(line.bottom),
      },
    });
  }
  return out;
}
/** The checkboxes that do not sit beside the first line of their words (they stand above or below them). */
export function checkboxLabelProblems(samples) {
  return (Array.isArray(samples) ? samples : [])
    .filter(({box, line}) => {
      const beside = box.right <= line.left + 2 || box.left >= line.right - 2,
        middle = (box.top + box.bottom) / 2;
      return !beside || middle < line.top - 6 || middle > line.bottom + 6;
    })
    .map(({label}) => `The box of “${label}” is not beside its words`);
}

/**
 * Findings for measured focus samples. A ring that is shown must reach the threshold against every opaque colour
 * behind it (the worst gradient stop counts); a focused control that shows no outline and no shadow has no indicator.
 */
export function focusIndicatorFindings(samples, threshold = 3) {
  return (Array.isArray(samples) ? samples : []).map(sample => {
    if (!sample?.found) return {name: sample?.name, measured: false, reason: 'not_present'};
    if (!sample.focus_visible)
      return {name: sample.name, target: sample.target, measured: false, reason: 'not_focus_visible'};
    if (sample.outline_style === 'none' || !(Number.parseFloat(sample.outline_width) > 0)) {
      const shadow = sample.box_shadow && sample.box_shadow !== 'none';
      return {
        name: sample.name,
        target: sample.target,
        measured: false,
        reason: shadow ? 'shadow_indicator' : 'no_indicator',
        passed: shadow,
      };
    }
    const [ring] = cssColours(sample.ring).filter(colour => colour.a === 1),
      surfaces = cssColours((sample.backgrounds ?? []).join(' ')).filter(colour => colour.a === 1);
    if (!ring) return {name: sample.name, target: sample.target, measured: false, reason: 'translucent_ring'};
    const behind = surfaces.length ? surfaces : [{r: 255, g: 255, b: 255, a: 1}],
      ratio = Math.min(...behind.map(colour => contrastRatio(ring, colour)));
    return {
      name: sample.name,
      target: sample.target,
      measured: true,
      ratio: Math.round(ratio * 100) / 100,
      passed: ratio >= threshold,
    };
  });
}

/** Collects the focus samples in the page: the first visible match of each target, focused by script after a key. */
export function collectFocusSamples(targets) {
  const visible = element =>
    !element.closest('[hidden],[inert],dialog:not([open])') &&
    (typeof element.checkVisibility === 'function'
      ? element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
      : element.getClientRects().length > 0);
  // The surface behind a ring: the first ancestor (from the parent, since an outline sits outside its element) with
  // opaque background-image stops or an opaque background colour. Computed opaque colours are `rgb(...)`.
  const backgrounds = element => {
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node),
        stops = (style.backgroundImage.match(/rgba?\([^)]*\)/g) ?? []).filter(colour => colour.startsWith('rgb('));
      if (stops.length) return stops;
      if (style.backgroundColor.startsWith('rgb(')) return [style.backgroundColor];
    }
    return ['rgb(255, 255, 255)'];
  };
  const before = document.activeElement,
    samples = [];
  for (const target of targets) {
    const element = [...document.querySelectorAll(target.selector)].find(
      candidate => visible(candidate) && !candidate.disabled,
    );
    if (!element) {
      samples.push({name: target.name, found: false});
      continue;
    }
    element.focus({preventScroll: true});
    const style = getComputedStyle(element);
    samples.push({
      name: target.name,
      found: true,
      target: element.id ? '#' + element.id : element.tagName.toLowerCase() + '.' + [...element.classList].join('.'),
      focused: document.activeElement === element,
      focus_visible: element.matches(':focus-visible'),
      outline_style: style.outlineStyle,
      outline_width: style.outlineWidth,
      box_shadow: style.boxShadow,
      ring: style.outlineColor,
      backgrounds: backgrounds(element.parentElement ?? element),
    });
  }
  if (before && typeof before.focus === 'function' && before.isConnected) before.focus({preventScroll: true});
  return samples;
}

/** Measures the focus ring of each target in the rendered page; a key press first makes script focus keyboard focus. */
export async function focusIndicatorContrast(page, targets = focusIndicatorTargets, threshold = 3) {
  await page.keyboard.press('Shift');
  const samples = await page.evaluate(
    collectFocusSamples,
    targets.map(target => ({...target})),
  );
  return focusIndicatorFindings(samples, threshold);
}

/** The findings that fail: a measured ring below the threshold or a focused control without any indicator. */
export function focusIndicatorProblems(findings) {
  return (findings ?? [])
    .filter(finding => (finding.measured && !finding.passed) || finding.reason === 'no_indicator')
    .map(finding =>
      finding.measured
        ? `Focus ring on ${finding.name} (${finding.target}) needs 3:1, measured ${finding.ratio}`
        : `Focused ${finding.name} (${finding.target}) shows no focus indicator`,
    );
}
