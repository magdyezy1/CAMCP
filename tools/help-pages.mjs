// The members-only Help page (DOC-03; owner instruction of 2026-10-24: "DOCS AND HELP ARE MEMBERS ONLY"). The owner
// guide is written in Markdown in docs/owner/ and its Arabic translation in docs/owner/ar/. This generator turns it, at
// build time, into one escaped HTML fragment per language, written to generated/help-guide.json; server/help-routes.ts
// places the fragments in the /help page it sends a signed-in member, and sends nobody else the guide. Nothing parses
// Markdown at run time, and the fragments hold only headings, paragraphs, lists, tables, emphasis and links, with no
// script, style or event attribute, so the website's strict Content-Security-Policy is unchanged; they take the
// website's existing document and table styles (.document, .review-table), so every page's stylesheet is unchanged
// too. Every character of the guide is escaped here. A link opens another part of the guide (a section of the page) or a page of the website;
// any other link, and any Markdown the page cannot show (code, quotes, raw HTML, images, nested lists), is refused.
//
//   node tools/help-pages.mjs           write generated/help-guide.json
//   node tools/help-pages.mjs --check   fail when it differs from what the guide produces now
//
// npm run docs:index writes it and npm run docs:index:check compares it (tools/docs-index.mjs), so the fragments
// cannot drift from the guide.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadRouteRegistry} from './check-routes.mjs';
import {headingSlug, markdownLinks, parseTarget, resolveLink} from './docs-links.mjs';
import {stripFrontMatter} from './docs-front-matter.mjs';

export const helpFile = 'generated/help-guide.json';
export const helpLanguages = Object.freeze({
  en: {folder: 'docs/owner', direction: 'ltr'},
  ar: {folder: 'docs/owner/ar', direction: 'rtl'},
});
/** The website's own pages a guide link may open besides the workspace pages: the public policy pages. */
export const staticPages = Object.freeze(['/about', '/privacy', '/terms', '/data-deletion']);
const siteOrigin = 'https://amcp.shop';

const escapeHtml = value =>
  String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const sha = text => 'sha256:' + createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
const pageId = file => (path.posix.basename(file, '.md') === 'README' ? 'start' : path.posix.basename(file, '.md'));
const fail = (file, line, message) => {
  throw Error(file + (line ? ':' + line : '') + ': ' + message);
};

/** The English guide's pages in reading order: its README, then every page in the order the README links it. */
export function guideOrder(root = process.cwd()) {
  const folder = helpLanguages.en.folder,
    pages = fs
      .readdirSync(path.join(root, folder))
      .filter(file => file.endsWith('.md'))
      .sort(),
    readme = folder + '/README.md',
    order = [readme];
  for (const link of markdownLinks(fs.readFileSync(path.join(root, readme), 'utf8'))) {
    const target = parseTarget(link.target);
    if (target.kind !== 'file') continue;
    const page = resolveLink(readme, target.file);
    if (page && pages.includes(path.posix.basename(page)) && page.startsWith(folder + '/') && !order.includes(page))
      order.push(page);
  }
  for (const page of pages)
    if (!order.includes(folder + '/' + page)) fail(readme, 0, 'does not link ' + folder + '/' + page);
  return order.map(page => path.posix.basename(page));
}

/** A page's blocks: headings, paragraphs, lists and tables, each with the line it starts on. */
export function guideBlocks(markdown, file = 'page.md') {
  const text = markdown.replaceAll('\r\n', '\n'),
    body = stripFrontMatter(text),
    offset = text.slice(0, text.length - body.length).split('\n').length - 1,
    lines = body.split('\n'),
    blocks = [],
    item = /^([-*]|\d+\.) (.*)$/,
    starts = /^(?:#{1,6} |\||[-*] |\d+\. |```|~~~|>|<)/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i],
      at = offset + i + 1;
    let m;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^(?:```|~~~|>|<|!\[| {4}|\t)/.test(line) || /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) || /^#{4,} /.test(line))
      fail(file, at, 'the Help page shows headings, paragraphs, lists, tables, emphasis and links only');
    if ((m = /^(#{1,3}) (.+?)\s*$/.exec(line))) {
      blocks.push({type: 'heading', level: m[1].length, text: m[2], line: at});
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push({text: lines[i], line: offset + ++i});
      if (rows.length < 2 || !/^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(rows[1].text))
        fail(file, at, 'a table needs a header row and a separator row');
      const cells = row =>
          row.text
            .replace(/^\|/, '')
            .replace(/\|\s*$/, '')
            .split('|')
            .map(cell => cell.trim()),
        head = cells(rows[0]);
      const body = rows.slice(2).map(row => {
        const values = cells(row);
        if (values.length !== head.length) fail(file, row.line, 'a table row has ' + values.length + ' cells');
        return values;
      });
      blocks.push({type: 'table', head, rows: body, line: at});
      continue;
    }
    if ((m = item.exec(line))) {
      const ordered = /\d/.test(m[1]),
        items = [];
      while (i < lines.length && (m = item.exec(lines[i])) && /\d/.test(m[1]) === ordered) {
        if (ordered && Number.parseInt(m[1], 10) !== items.length + 1)
          fail(file, offset + i + 1, 'an ordered list counts 1, 2, 3');
        let content = m[2];
        i++;
        while (i < lines.length && /^ {2,}\S/.test(lines[i])) {
          if (/^\s+(?:[-*]|\d+\.) /.test(lines[i])) fail(file, offset + i + 1, 'the Help page shows no nested lists');
          content += ' ' + lines[i].trim();
          i++;
        }
        items.push(content);
      }
      blocks.push({type: ordered ? 'ol' : 'ul', items, line: at});
      continue;
    }
    let content = line.trim();
    i++;
    while (i < lines.length && lines[i].trim() && !starts.test(lines[i])) content += ' ' + lines[i++].trim();
    blocks.push({type: 'p', text: content, line: at});
  }
  if (blocks[0]?.type !== 'heading' || blocks[0].level !== 1) fail(file, 0, 'a page starts with its "# " title');
  if (blocks.slice(1).some(block => block.type === 'heading' && block.level === 1))
    fail(file, 0, 'a page has one "# " title');
  return blocks;
}

/** The site address a guide link to amcp.shop opens on this website, or undefined when it names no website page. */
export function sitePath(target, routes) {
  if (!target.startsWith(siteOrigin + '/')) return undefined;
  let url;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  if (url.origin !== siteOrigin || url.hash || url.username || url.password) return undefined;
  if (url.search && url.search !== '?lang=ar') return undefined;
  return routes.includes(url.pathname) ? url.pathname + url.search : undefined;
}

/** Inline Markdown as escaped HTML: links, code, strong and emphasis; everything else is text. */
function inline(text, link) {
  const token = /\[([^\]]+)\]\(([^()\s]+)\)|`([^`]+)`|\*\*(.+?)\*\*|(?<![\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/u;
  let out = '',
    rest = text;
  for (let m = token.exec(rest); m; m = token.exec(rest)) {
    out += escapeHtml(rest.slice(0, m.index));
    if (m[1] !== undefined) out += '<a href="' + escapeHtml(link(m[2])) + '">' + inline(m[1], link) + '</a>';
    else if (m[3] !== undefined) out += '<code>' + escapeHtml(m[3]) + '</code>';
    else if (m[4] !== undefined) out += '<strong>' + inline(m[4], link) + '</strong>';
    else out += '<em>' + inline(m[5], link) + '</em>';
    rest = rest.slice(m.index + m[0].length);
  }
  return out + escapeHtml(rest);
}

/** One language's fragment: a section per page, in the guide's order, each heading with its own id. */
function languageFragment(root, language, order, routes) {
  const {folder, direction} = helpLanguages[language],
    id = (page, n) => 'help-' + language + '-' + pageId(page) + (n ? '-' + n : ''),
    pages = order.map(page => {
      const file = folder + '/' + page,
        source = path.join(root, file);
      if (!fs.existsSync(source)) fail(file, 0, 'is missing: every page of the guide has its translation');
      const text = fs.readFileSync(source, 'utf8'),
        blocks = guideBlocks(text, file),
        // A section's anchor, as a Markdown link names it (its GitHub slug), to the id it has on the Help page.
        anchors = new Map();
      let n = 0;
      for (const block of blocks)
        if (block.type === 'heading') {
          block.id = block.level === 1 ? id(page) : id(page, ++n);
          anchors.set(headingSlug(block.text), block.id);
        }
      return {page, file, text, blocks, anchors};
    });
  const sections = pages.map(({page, file, blocks}) => {
    const link = target => {
      const parsed = parseTarget(target);
      if (parsed.kind === 'external') {
        const site = sitePath(target, routes);
        if (!site) fail(file, 0, 'links ' + target + ': a guide link opens the guide or a page of this website');
        return site;
      }
      const resolved = parsed.kind === 'section' ? file : resolveLink(file, parsed.file),
        to = pages.find(p => p.file === resolved);
      if (!to) fail(file, 0, 'links ' + target + ', which is no page of this guide in this language');
      if (!parsed.fragment) return '#' + id(to.page);
      let fragment = parsed.fragment;
      try {
        fragment = decodeURIComponent(fragment);
      } catch {}
      const anchor = to.anchors.get(fragment.toLowerCase());
      if (!anchor) fail(file, 0, 'links ' + target + ', which names no heading of ' + to.file);
      return '#' + anchor;
    };
    const render = block => {
      if (block.type === 'heading') {
        const tag = 'h' + (block.level + 1);
        return '<' + tag + ' id="' + block.id + '">' + inline(block.text, link) + '</' + tag + '>';
      }
      if (block.type === 'p') return '<p>' + inline(block.text, link) + '</p>';
      if (block.type === 'ul' || block.type === 'ol')
        return (
          '<' +
          block.type +
          '>' +
          block.items.map(item => '<li>' + inline(item, link) + '</li>').join('') +
          '</' +
          block.type +
          '>'
        );
      return (
        '<table class="review-table"><thead><tr>' +
        block.head.map(cell => '<th scope="col">' + inline(cell, link) + '</th>').join('') +
        '</tr></thead><tbody>' +
        block.rows
          .map(
            row =>
              '<tr>' +
              row
                .map((cell, index) =>
                  index ? '<td>' + inline(cell, link) + '</td>' : '<th scope="row">' + inline(cell, link) + '</th>',
                )
                .join('') +
              '</tr>',
          )
          .join('') +
        '</tbody></table>'
      );
    };
    return (
      '<section class="panel help-page document" aria-labelledby="' +
      blocks[0].id +
      '">' +
      blocks.map(render).join('') +
      '</section>'
    );
  });
  return {
    title: pages[0].blocks[0].text,
    sources: Object.fromEntries(pages.map(p => [p.file, sha(p.text)])),
    html:
      '<div class="help-guide-language" lang="' +
      language +
      '" dir="' +
      direction +
      '" data-help-language="' +
      language +
      '">' +
      sections.join('\n') +
      '</div>',
  };
}

/** The generated file's text: both languages' fragments and the digest of every page they were built from. */
export function helpGuideText(root = process.cwd()) {
  const order = guideOrder(root),
    routes = [...loadRouteRegistry(root).map(entry => entry.path), ...staticPages],
    languages = {},
    sources = {};
  for (const language of Object.keys(helpLanguages)) {
    const fragment = languageFragment(root, language, order, routes);
    Object.assign(sources, fragment.sources);
    languages[language] = {title: fragment.title, html: fragment.html};
  }
  return (
    JSON.stringify(
      {
        meaning:
          'DOC-03: the owner guide (docs/owner/, docs/owner/ar/) as escaped HTML fragments for the members-only /help page (server/help-routes.ts). Generated by node tools/help-pages.mjs, run by npm run docs:index; npm run docs:index:check fails when it differs from the guide.',
        generator: 'tools/help-pages.mjs',
        sources,
        languages,
      },
      null,
      2,
    ) + '\n'
  );
}

/** Writes or (check) compares generated/help-guide.json; returns the problems (an empty list passes). */
export function helpGuideProblems(root = process.cwd(), {write = false} = {}) {
  let text;
  try {
    text = helpGuideText(root);
  } catch (error) {
    return ['Help page: ' + error.message];
  }
  const target = path.join(root, helpFile),
    current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') : undefined;
  if (current === text) return [];
  if (write) {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, text);
    return [];
  }
  return [helpFile + ' is out of date with docs/owner/. Run npm run docs:index.'];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url)),
    check = process.argv.includes('--check'),
    problems = helpGuideProblems(root, {write: !check});
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else console.log(check ? helpFile + ' matches the owner guide.' : 'Wrote ' + helpFile + '.');
}
