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
