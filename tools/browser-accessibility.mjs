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
]);

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
