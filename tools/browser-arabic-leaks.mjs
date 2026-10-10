// Rendered Arabic leak probe (QA-03). The locale check counts selected interface strings; this counts what an Arabic
// reader actually sees: visible text nodes in the page's main content with two or more Latin words that the allow-list
// (brand and provider names, native identifiers and units, values marked data-native, code, bdi or dir=ltr) does not
// cover. Collection runs in the page; classification runs here, so it is testable without a browser.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const defaultLeakAllowlistFile = fileURLToPath(new URL('./arabic-literal-allowlist.json', import.meta.url));
export const defaultLeakBaselineFile = fileURLToPath(new URL('./arabic-leak-baseline.json', import.meta.url));
const latin = /[A-Za-z][A-Za-z'’-]*/g;

/** The allow-list: selectors whose text stays literal and words that are never a leak on their own. */
export function readLeakAllowlist(file = defaultLeakAllowlistFile) {
  const bytes = fs.readFileSync(file),
    value = JSON.parse(bytes.toString('utf8'));
  if (
    value?.schema_version !== 1 ||
    !Array.isArray(value.selectors) ||
    !Array.isArray(value.terms) ||
    [...value.selectors, ...value.terms].some(item => typeof item !== 'string' || !item.trim())
  )
    throw Error('ARABIC_LEAK_ALLOWLIST_INVALID');
  return {
    selectors: [...value.selectors],
    terms: new Set(value.terms.map(term => term.toLowerCase())),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Latin words of a text that the allow-list does not cover (a possessive or plural of a term is covered too). */
export function leakedWords(text, allowlist) {
  return [...String(text).matchAll(latin)]
    .map(match => match[0].replace(/['’-]+$/, ''))
    .filter(word => {
      const lower = word.toLowerCase();
      return (
        word.length > 0 &&
        !allowlist.terms.has(lower) &&
        !allowlist.terms.has(lower.replace(/(?:['’]s|s)$/, '')) &&
        // A single letter or a unit-like token (a version, an ID fragment) is not a sentence.
        !/^[A-Za-z]$/.test(word)
      );
    });
}

/** The collected text nodes that leak: two or more uncovered Latin words. */
export function arabicLeakFindings(nodes, allowlist) {
  const leaks = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const words = leakedWords(node?.text ?? '', allowlist);
    if (words.length >= 2)
      leaks.push({text: String(node.text).replace(/\s+/g, ' ').trim().slice(0, 160), path: node.path ?? ''});
  }
  return leaks;
}

/**
 * Collects the visible text nodes of `main` (and of any open dialog or shown status message, for intermediate states)
 * that are not inside an allow-listed element. Runs in the page.
 */
export function collectVisibleText({selectors, scopes}) {
  const skip = selectors.join(','),
    out = [];
  const visible = element => {
    if (!element || element.closest('[hidden],dialog:not([open]),[inert]')) return false;
    if (typeof element.checkVisibility === 'function')
      return element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
  };
  const path = element => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement)
      parts.unshift(
        node.id ? '#' + node.id : node.tagName.toLowerCase() + (node.classList[0] ? '.' + node.classList[0] : ''),
      );
    return parts.join(' > ');
  };
  const roots = scopes.flatMap(scope => [...document.querySelectorAll(scope)]).filter(visible);
  const seen = new Set();
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data.replace(/\s+/g, ' ').trim(),
        parent = node.parentElement;
      if (!text || !/[A-Za-z]/.test(text) || seen.has(node) || !parent) continue;
      seen.add(node);
      if ((skip && parent.closest(skip)) || !visible(parent)) continue;
      out.push({text: text.slice(0, 400), path: path(parent)});
    }
  }
  return out;
}

/** Probes the rendered page. `intermediate` also covers open dialogs and the shown status message. */
export async function arabicLeakProbe(page, allowlist, {intermediate = false} = {}) {
  const scopes = intermediate ? ['main', 'dialog[open]', '#toast:not([hidden])'] : ['main'];
  const nodes = await page.evaluate(collectVisibleText, {selectors: allowlist.selectors, scopes});
  const leaks = arabicLeakFindings(nodes, allowlist);
  return {checked_nodes: nodes.length, count: leaks.length, leaks: leaks.slice(0, 25)};
}

/** The committed per-route ratchet: leak counts may only go down. A route without an entry is report-only. */
export function readLeakBaseline(file = defaultLeakBaselineFile) {
  const bytes = fs.readFileSync(file),
    value = JSON.parse(bytes.toString('utf8'));
  if (
    value?.schema_version !== 1 ||
    !Array.isArray(value.critical_routes) ||
    !value.routes ||
    typeof value.routes !== 'object' ||
    Object.values(value.routes).some(limit => !Number.isInteger(limit) || limit < 0) ||
    // A critical route always has a limit; its target is zero (the summary reports which are there).
    value.critical_routes.some(route => !Object.hasOwn(value.routes, route))
  )
    throw Error('ARABIC_LEAK_BASELINE_INVALID');
  return {...value, sha256: createHash('sha256').update(bytes).digest('hex')};
}

/** Whether a case's leak count stays within its route's committed limit. */
export function leakRatchet(route, count, baseline) {
  const limit = Object.hasOwn(baseline.routes, route) ? baseline.routes[route] : null;
  return {
    route,
    count,
    limit,
    critical: baseline.critical_routes.includes(route),
    exceeded: limit !== null && count > limit,
  };
}
