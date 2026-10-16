import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const wcagEngineVersion = '4.14.0';
export const wcagEngineSha256 = '20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878';
export const wcagTags = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']);
const refuse = message => {
  throw new Error(message);
};
/** Optional local test asset only. No download, dependency or network request is added to the application. */
export function readPinnedWcagEngine(file) {
  if (file === undefined) return null;
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== 'axe.min.js')
    refuse('WCAG QA requires an explicit absolute path to the pinned local axe.min.js test asset.');
  let bytes;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2097152) refuse('Invalid WCAG test asset.');
    bytes = fs.readFileSync(file);
  } catch {
    refuse('WCAG test asset is unavailable or outside its received-byte bound.');
  }
  if (bytes.length > 2097152 || createHash('sha256').update(bytes).digest('hex') !== wcagEngineSha256)
    refuse('WCAG test asset does not match the qualified axe-core 4.14.0 bytes.');
  return {
    source: bytes.toString('utf8'),
    sha256: wcagEngineSha256,
    version: wcagEngineVersion,
    byte_length: bytes.length,
  };
}
export function summarizeWcagResult(result) {
  if (
    result?.testEngine?.name !== 'axe-core' ||
    result.testEngine.version !== wcagEngineVersion ||
    ['violations', 'incomplete', 'passes', 'inapplicable'].some(field => !Array.isArray(result[field]))
  )
    refuse('WCAG inspection returned incomplete or unexpected engine evidence.');
  const rows = list =>
    list.map(row => {
      if (!row || typeof row.id !== 'string' || !row.id || !Array.isArray(row.nodes))
        refuse('WCAG inspection returned malformed rule evidence.');
      return {
        id: row.id,
        impact: row.impact ?? null,
        tags: row.tags ?? [],
        help: row.help ?? '',
        help_url: row.helpUrl ?? '',
        nodes: row.nodes.map(node => {
          if (!node || !Array.isArray(node.target) || node.target.some(value => typeof value !== 'string'))
            refuse('WCAG inspection returned malformed node evidence.');
          return {
            target: node.target,
            html: node.html ?? '',
            summary: node.failureSummary ?? '',
            checks: ['any', 'all', 'none'].flatMap(kind =>
              (node[kind] ?? []).map(check => ({
                kind,
                id: check.id,
                data: check.data ?? null,
                message: check.message ?? '',
              })),
            ),
          };
        }),
      };
    });
  const violations = rows(result.violations),
    incomplete = rows(result.incomplete);
  return {
    engine: wcagEngineVersion,
    selected_tags: [...wcagTags],
    automated_passed: violations.length === 0,
    manual_review_required: incomplete.length > 0,
    violations,
    incomplete,
    passed_rules: result.passes.length,
    inapplicable_rules: result.inapplicable.length,
  };
}
/**
 * Runs a page-level inspection with the document scrolled to its start, then restores the reader's position. axe
 * evaluates every node of the document wherever it is scrolled (the same color-contrast and target-size node counts
 * were measured at both positions), but the phone top bar is sticky: wherever the last automated click or fill left
 * the page, an in-flow control can sit half beneath the bar's own controls, and target-size then reports it as
 * partially obscured (browser QA wave 2: measurement-identity at 375 px). At the document start the sticky bar
 * overlaps nothing in the flow, so the result no longer depends on where the harness last scrolled. Rules, tags and
 * the evaluated nodes are unchanged; a modal dialog stays in the top layer, and a fixed toast is still evaluated
 * over whatever it covers at the document start.
 *
 * What the sticky bar hides at the reader's own position is not lost: before scrolling, the focused element is checked
 * where the reader is (WCAG 2.4.11, focusObscured), and the inspection's evidence carries the result as focus_obscured.
 */
export async function atDocumentStart(page, inspect) {
  const position = await page.evaluate(() => [scrollX, scrollY]),
    obscured = await focusObscured(page);
  try {
    await page.evaluate(() => scrollTo(0, 0));
    return {...(await inspect()), focus_obscured: obscured};
  } finally {
    await page.evaluate(([x, y]) => scrollTo(x, y), position);
  }
}
/**
 * Runs in the page: whether the focused element is entirely hidden by a fixed or sticky layer at the current scroll
 * position (WCAG 2.4.11 Focus Not Obscured, minimum), such as the sticky phone top bar. Nine points of the element
 * that lie in the viewport are hit-tested; it is obscured only when every one of them shows a fixed or sticky layer
 * that does not contain it. An element scrolled out of view, or none focused, is not obscured. Null when nothing is.
 */
export function collectFocusObscured() {
  const focused = typeof document === 'undefined' ? null : document.activeElement;
  if (!focused || focused === document.body || focused === document.documentElement) return null;
  const r = focused.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const points = [];
  for (const x of [r.left + 1, (r.left + r.right) / 2, r.right - 1])
    for (const y of [r.top + 1, (r.top + r.bottom) / 2, r.bottom - 1])
      if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) points.push([x, y]);
  if (!points.length) return null;
  const layerOf = node => {
    for (let n = node; n && n !== document.body && n !== document.documentElement; n = n.parentElement)
      if (['fixed', 'sticky'].includes(getComputedStyle(n).position)) return n;
    return null;
  };
  const describe = el =>
    el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].map(name => '.' + name).join('');
  let cover = null;
  for (const [x, y] of points) {
    const top = document.elementFromPoint(x, y);
    // This point shows the focused element (or something inside it): it is not entirely hidden.
    if (!top || focused.contains(top) || top.contains(focused)) return null;
    const layer = layerOf(top);
    if (!layer || layer.contains(focused)) return null;
    cover = layer;
  }
  return {focused: describe(focused), covered_by: describe(cover)};
}
/** Whether the focused element of `page` is entirely hidden by a fixed or sticky layer where the reader is. */
export async function focusObscured(page) {
  return page.evaluate(collectFocusObscured);
}
/**
 * Run selected automated A/AA checks in an owned browser page. Incomplete rules remain explicit manual work. The
 * deadline bounds a hung engine, not the page: on a fully loaded machine inspections measured 1.4 to 1.8 seconds on
 * the Arabic capabilities pages and up to 6.1 seconds elsewhere, and one of about 2,500 in the wave 2 qualification
 * passed 10 seconds and failed its case. 20 seconds keeps a hung engine a failure without failing a qualification on
 * a scheduling spike.
 */
export async function inspectBrowserWcag(page, engine, timeoutMs = 20000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    refuse('WCAG inspection requires a bounded local deadline.');
  if (
    !engine ||
    engine.version !== wcagEngineVersion ||
    engine.sha256 !== wcagEngineSha256 ||
    typeof engine.source !== 'string' ||
    Buffer.byteLength(engine.source, 'utf8') > 2097152 ||
    createHash('sha256').update(engine.source).digest('hex') !== wcagEngineSha256
  )
    refuse('WCAG inspection requires qualified engine bytes and a bounded local deadline.');
  let timer;
  const started = performance.now();
  const inspect = async () => {
    await page.evaluate(engine.source);
    const result = await page.evaluate(
      async tags => {
        const r = await globalThis.axe.run(document, {runOnly: {type: 'tag', values: tags}});
        return {
          testEngine: r.testEngine,
          violations: r.violations,
          incomplete: r.incomplete,
          passes: r.passes.map(row => ({id: row.id})),
          inapplicable: r.inapplicable.map(row => ({id: row.id})),
        };
      },
      [...wcagTags],
    );
    // How long the engine took, against the deadline: one wave 2 case (Arabic /capabilities, 768 px) ran past it.
    return {
      ...summarizeWcagResult(result),
      elapsed_ms: Math.round(performance.now() - started),
      deadline_ms: timeoutMs,
    };
  };
  try {
    return await Promise.race([
      inspect(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WCAG inspection exceeded its local deadline.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
