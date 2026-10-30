// The repository's Markdown links (DOC-03). Every relative link resolves to a file that exists, with the exact case a
// Linux build sees, and a link to a section of a Markdown document names a heading or an anchor in it. Documents that
// moved (owner decision P12: the delivery and incident records to docs/records/, superseded reviews to docs/archive/)
// are listed in docs/moved.json: each old address keeps a redirect stub so links from outside the repository still
// land, while every link inside the repository names the new address.
// Later moves (the consolidation the owner instructed on 2026-10-24) are listed under `later`, each batch with its
// date and the decision behind it; a batch also lists the sections that moved to another page (`sections`, old
// page#anchor to new page#anchor). A moved section's old page keeps an anchor of the same name, so a link from outside
// the repository still lands beside a pointer to the new place, while every link inside it names the new place.
// Usage: node tools/docs-links.mjs [--check | --write]
//   --check (the default) lists every broken link, link to a moved address and stale stub, and fails if there is one.
//   --write rewrites the links that name a moved address or section, re-bases the links a moved document still writes
//           for its old directory, and writes the stubs; a link that was broken before stays broken and is listed.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pageMeta} from './docs-front-matter.mjs';

export const movesFile = 'docs/moved.json';
/** The decision behind the first move, which the stubs it left name. */
export const firstDecision = 'DOC-03, owner decision P12';
/** Where the repository keeps Markdown: the top-level files, the documentation, the AI-client guides, the website. */
const roots = ['README.md', 'NOTICE.md', 'docs', 'Skills', 'web'];
const posix = file => file.split(path.sep).join('/');

/** Every Markdown file under the roots, repository-relative and sorted; hidden and dependency folders are skipped. */
export function markdownFiles(root) {
  const out = [];
  const visit = relative => {
    const full = path.join(root, relative);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (relative.endsWith('.md')) out.push(posix(relative));
      return;
    }
    for (const entry of fs.readdirSync(full, {withFileTypes: true}))
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') visit(relative + '/' + entry.name);
  };
  for (const entry of roots) visit(entry);
  return out.sort();
}

/** The text with fenced code blocks blanked (same length), so nothing inside them is a heading or a link. */
function maskFences(text) {
  let fence = null;
  return text
    .split('\n')
    .map(line => {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line))
          fence = null;
        return ' '.repeat(line.length);
      }
      if (open) fence = open[1];
      return open ? ' '.repeat(line.length) : line;
    })
    .join('\n');
}
/** The text with code blocks and inline code spans blanked (same length): links inside code are not links. */
const maskCode = text => maskFences(text).replace(/(`+)(?:(?!\1)[^\n])+?\1/g, span => ' '.repeat(span.length));

/**
 * The link targets of a Markdown text, outside code: inline links and images, reference definitions and HTML
 * href/src attributes, each with its offset in the text so that a rewrite replaces exactly the target.
 */
export function markdownLinks(text) {
  const masked = maskCode(text),
    links = [];
  const add = (target, index) => {
    const angle = target.startsWith('<') && target.endsWith('>');
    links.push({target: angle ? target.slice(1, -1) : target, index: angle ? index + 1 : index});
  };
  for (const m of masked.matchAll(/\]\(\s*(<[^<>\n]+>|[^\s()<>]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g))
    add(m[1], m.index + m[0].indexOf(m[1], 2));
  for (const m of masked.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^<>\n]+>|\S+)/gm))
    add(m[1], m.index + m[0].lastIndexOf(m[1]));
  for (const m of masked.matchAll(/<(?:a|img)\b[^>]*?\s(?:href|src)="([^"]+)"/g))
    add(m[1], m.index + m[0].lastIndexOf(m[1]));
  return links.sort((a, b) => a.index - b.index);
}

/** How a link target reads: external, a section of the same page, or a repository file with an optional section. */
export function parseTarget(target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return {kind: 'external'};
  const hash = target.indexOf('#'),
    file = (hash < 0 ? target : target.slice(0, hash)).split('?')[0],
    fragment = hash < 0 ? '' : target.slice(hash + 1);
  return {kind: file ? 'file' : 'section', file, fragment};
}

/** The repository-relative path a link written in `from` names, or null when it leaves the repository or is invalid. */
export function resolveLink(from, file) {
  let decoded;
  try {
    decoded = decodeURIComponent(file);
  } catch {
    return null;
  }
  const joined = decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(from), decoded),
    normal = path.posix.normalize(joined).replace(/\/$/, '');
  return normal === '..' || normal.startsWith('../') ? null : normal || '.';
}

/** Whether a repository path exists with exactly this case (Windows and macOS ignore case; the Linux build does not). */
function exactExists(root, relative, listings) {
  let directory = '';
  for (const segment of relative.split('/')) {
    if (segment === '.') continue;
    const full = path.join(root, directory);
    if (!listings.has(full)) {
      let names = null;
      try {
        names = new Set(fs.readdirSync(full));
      } catch {}
      listings.set(full, names);
    }
    if (!listings.get(full)?.has(segment)) return false;
    directory = directory ? directory + '/' + segment : segment;
  }
  return true;
}

/** A heading's anchor as GitHub writes it: its text in lower case, punctuation removed, spaces to hyphens. */
export function headingSlug(heading) {
  return heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*`]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}
/** The anchors of a Markdown text: its headings' slugs (repeats numbered as GitHub numbers them) and explicit ids. */
export function markdownAnchors(text) {
  const anchors = new Set(),
    seen = new Map();
  for (const m of maskFences(text).matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*(?:#+[ \t]*)?$/gm)) {
    const slug = headingSlug(m[1]),
      count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count ? slug + '-' + count : slug);
  }
  for (const m of text.matchAll(/<[a-z]+\b[^>]*?\s(?:id|name)="([^"]+)"/gi)) anchors.add(m[1].toLowerCase());
  return anchors;
}

/**
 * docs/moved.json: the date of the first move, the map from each old repository path to its new one (every batch), the
 * date and decision of each move, and the sections that moved to another page (old page#anchor to new page#anchor).
 */
export function readMoves(root) {
  const file = path.join(root, movesFile);
  if (!fs.existsSync(file))
    return {date: undefined, moves: new Map(), dates: new Map(), decisions: new Map(), sections: new Map()};
  const data = JSON.parse(fs.readFileSync(file, 'utf8')),
    moves = new Map(),
    dates = new Map(),
    decisions = new Map(),
    sections = new Map();
  for (const batch of [{date: data.date, decision: firstDecision, moved: data.moved}, ...(data.later ?? [])]) {
    for (const [from, to] of Object.entries(batch.moved ?? {})) {
      moves.set(from, to);
      dates.set(from, batch.date);
      decisions.set(from, batch.decision ?? firstDecision);
    }
    for (const [from, to] of Object.entries(batch.sections ?? {})) sections.set(from, to);
  }
  return {date: data.date, moves, dates, decisions, sections};
}

/** The text a moved document leaves at its old address: an archived page for the tier of the page it points to. */
export function stubText(root, from, to, date, decision = firstDecision) {
  const relative = path.posix.relative(path.posix.dirname(from), to);
  if (from.endsWith('.json')) return JSON.stringify({moved_to: relative, moved_on: date, decision}, null, 2) + '\n';
  const title = /^# (.+)$/m.exec(fs.readFileSync(path.join(root, to), 'utf8'))?.[1].trim() ?? path.posix.basename(to),
    tier = (to.endsWith('.md') && pageMeta(root, to)?.tier) || 'engineering';
  return (
    '---\nstatus: archived\ntier: ' +
    tier +
    '\n---\n\n# Moved: ' +
    title +
    '\n\nThis document moved on ' +
    date +
    ' (' +
    decision +
    '). Its text and history are kept at\n[' +
    to +
    '](' +
    relative +
    '); this page only keeps links to the old address working.\n'
  );
}
/** A moved section's old address split into its page and anchor, and the same for its new address. */
const sectionParts = address => {
  const hash = address.indexOf('#');
  return {file: address.slice(0, hash), fragment: address.slice(hash + 1)};
};

/** Every link problem in the repository's Markdown, and every missing or stale stub. An empty list means none. */
export function linkProblems(root = process.cwd()) {
  const {date, moves, dates, decisions, sections} = readMoves(root),
    listings = new Map(),
    anchorCache = new Map(),
    problems = [];
  const anchorsOf = file => {
    if (!anchorCache.has(file)) anchorCache.set(file, markdownAnchors(fs.readFileSync(path.join(root, file), 'utf8')));
    return anchorCache.get(file);
  };
  for (const [from, to] of moves) {
    if (moves.has(to) || !exactExists(root, to, listings)) {
      problems.push(movesFile + ': ' + to + ' (moved from ' + from + ') does not exist');
      continue;
    }
    const stub = path.join(root, from);
    if (
      !fs.existsSync(stub) ||
      fs.readFileSync(stub, 'utf8') !== stubText(root, from, to, dates.get(from) ?? date, decisions.get(from))
    )
      problems.push(from + ': the redirect stub to ' + to + ' is missing or stale (node tools/docs-links.mjs --write)');
  }
  // A moved section: its new page holds it, and its old page keeps an anchor of its name for links from outside.
  for (const [from, to] of sections) {
    const old = sectionParts(from),
      next = sectionParts(to);
    if (!exactExists(root, next.file, listings) || !anchorsOf(next.file).has(next.fragment.toLowerCase()))
      problems.push(movesFile + ': the section ' + to + ' (moved from ' + from + ') does not exist');
    if (!exactExists(root, old.file, listings) || !anchorsOf(old.file).has(old.fragment.toLowerCase()))
      problems.push(old.file + ': keeps no anchor "' + old.fragment + '" pointing to its moved section ' + to);
  }
  for (const file of markdownFiles(root)) {
    if (moves.has(file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const link of markdownLinks(text)) {
      const target = parseTarget(link.target);
      if (target.kind === 'external') continue;
      const at = file + ':' + text.slice(0, link.index).split('\n').length + ': ' + link.target,
        resolved = target.kind === 'section' ? file : resolveLink(file, target.file);
      if (resolved === null) problems.push(at + ' leaves the repository or is not a valid address');
      else if (moves.has(resolved))
        problems.push(at + ' names the old address of ' + moves.get(resolved) + ' (node tools/docs-links.mjs --write)');
      else if (!exactExists(root, resolved, listings)) problems.push(at + ' does not exist');
      else {
        let fragment = target.fragment;
        try {
          fragment = decodeURIComponent(fragment);
        } catch {}
        fragment = fragment.toLowerCase();
        // GitHub's line anchors (#L10, #L10-L20) name lines of a file, not sections.
        if (fragment && resolved.endsWith('.md') && !/^l\d+(?:-l\d+)?$/.test(fragment)) {
          if (sections.has(resolved + '#' + fragment))
            problems.push(
              at +
                ' names the old address of the section ' +
                sections.get(resolved + '#' + fragment) +
                ' (node tools/docs-links.mjs --write)',
            );
          else if (!anchorsOf(resolved).has(fragment)) problems.push(at + ' names no heading or anchor in ' + resolved);
        }
      }
    }
  }
  return problems;
}

/**
 * Rewrites every link that names a moved address or a moved section to its new address, re-bases a moved document's
 * links that it still writes for its old directory (a link that resolves from where the document is now is kept as it
 * is), and writes the stubs. Returns the files it changed.
 */
export function rewriteLinks(root = process.cwd()) {
  const moved = readMoves(root),
    {moves, sections} = moved,
    origin = new Map([...moves].map(([from, to]) => [to, from])),
    listings = new Map(),
    changed = [];
  for (const file of markdownFiles(root)) {
    if (moves.has(file)) continue;
    const full = path.join(root, file),
      text = fs.readFileSync(full, 'utf8'),
      previous = origin.get(file);
    let out = '',
      last = 0;
    const replace = (link, replacement) => {
      out += text.slice(last, link.index) + replacement;
      last = link.index + link.target.length;
    };
    for (const link of markdownLinks(text)) {
      const target = parseTarget(link.target);
      if (target.kind === 'external') continue;
      // A link to a section that moved to another page names that page and its anchor.
      const page = target.kind === 'section' ? file : resolveLink(file, target.file);
      let fragment = target.fragment;
      try {
        fragment = decodeURIComponent(fragment);
      } catch {}
      const section = page && fragment ? sections.get(page + '#' + fragment.toLowerCase()) : undefined;
      if (section) {
        const next = sectionParts(section);
        replace(
          link,
          (next.file === file ? '' : path.posix.relative(path.posix.dirname(file), next.file)) + '#' + next.fragment,
        );
        continue;
      }
      if (target.kind !== 'file') continue;
      let resolved = resolveLink(file, target.file);
      if (resolved === null) continue;
      if (!moves.has(resolved) && exactExists(root, resolved, listings)) continue;
      if (!moves.has(resolved)) {
        // Not found from here: a moved document's link written for its old directory.
        const before = previous && resolveLink(previous, target.file);
        if (!before || !(moves.has(before) || exactExists(root, before, listings))) continue;
        resolved = before;
      }
      const destination = moves.get(resolved) ?? resolved;
      if (!exactExists(root, destination, listings)) continue;
      replace(
        link,
        (path.posix.relative(path.posix.dirname(file), destination) || path.posix.basename(destination)) +
          link.target.slice(target.file.length),
      );
    }
    if (last && out + text.slice(last) !== text) {
      fs.writeFileSync(full, out + text.slice(last));
      changed.push(file);
    }
  }
  return [...changed, ...writeStubs(root, moved)];
}
/** Writes the redirect stub at every old address whose stub is missing or stale; returns the stubs it wrote. */
export function writeStubs(
  root = process.cwd(),
  {date, moves, dates = new Map(), decisions = new Map()} = readMoves(root),
) {
  const written = [];
  for (const [from, to] of moves) {
    const full = path.join(root, from);
    if (!fs.existsSync(path.join(root, to))) continue;
    const stub = stubText(root, from, to, dates.get(from) ?? date, decisions.get(from));
    if (fs.existsSync(full) && fs.readFileSync(full, 'utf8') === stub) continue;
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, stub);
    written.push(from);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (process.argv.includes('--write')) console.log('Rewrote ' + rewriteLinks(root).length + ' files.');
  const problems = linkProblems(root);
  if (problems.length) {
    console.error(problems.join('\n') + '\n' + problems.length + ' link problems.');
    process.exitCode = 1;
  } else
    console.log(
      'Every relative link in ' +
        markdownFiles(root).length +
        ' Markdown files resolves; ' +
        readMoves(root).moves.size +
        ' moved documents keep a stub at their old address.',
    );
}
