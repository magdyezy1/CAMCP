// Package brand (docs/records/BRAND-KIT-V1-2026-11-07.md). The brand guidelines say "Do not replace the custom outlined
// logo letters with plain type", so the mark never sits beside plain AMCP text: every .brand and .about-brand element
// of the website is the lockup, keeps AMCP as its accessible name, and is never squeezed or mirrored. This test reads
// the shipped markup and stylesheets; the rendered checks (variant per surface, size, clear space, overflow) are in
// tools/browser-brand.mjs and run through tools/browser-workflow-qa.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cssDeclarations} from '../tools/check-colours.mjs';

const read = file => fs.readFileSync('web/' + file, 'utf8'),
  pages = fs
    .readdirSync('web')
    .filter(file => file.endsWith('.html'))
    .sort(),
  sources = fs
    .readdirSync('web')
    .filter(file => /\.(?:html|js)$/.test(file))
    .sort(),
  sheets = fs
    .readdirSync('web')
    .filter(file => file.endsWith('.css'))
    .sort(),
  // The lockup files' own viewBox is 1270 x 263.
  aspect = 1270 / 263;

const attributesOf = tag =>
  Object.fromEntries([...tag.matchAll(/([a-z][\w-]*)=(["'])(.*?)\2/gi)].map(match => [match[1], match[3]]));

/** Every element whose class list holds `brand` or `about-brand`: its attributes, its inner markup and its images. */
function brandElements(file) {
  const source = read(file),
    open = /<([a-z][a-z0-9]*)\b([^>]*\bclass=(["'])(?:[^"']*\s)?(?:brand|about-brand)(?:\s[^"']*)?\3[^>]*)>/gi,
    found = [];
  for (const match of source.matchAll(open)) {
    const tag = match[1],
      from = match.index + match[0].length,
      close = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
    close.lastIndex = from;
    let depth = 1,
      end = -1;
    for (let next = close.exec(source); next; next = close.exec(source)) {
      depth += next[1] ? -1 : 1;
      if (!depth) {
        end = next.index;
        break;
      }
    }
    assert.notEqual(end, -1, file + ': a <' + tag + ' class="brand"> is never closed');
    const inner = source.slice(from, end);
    found.push({
      file,
      tag,
      attributes: attributesOf(match[0]),
      inner,
      images: [...inner.matchAll(/<img\b[^>]*>/gi)].map(image => attributesOf(image[0])),
    });
  }
  return found;
}
const all = sources.flatMap(brandElements);
const imageFile = image => /(logo-ink|logo-white|mark)\.svg/.exec(image.src ?? '')?.[1];

test('the website holds exactly the brand placements this test knows; a new one needs its own review', () => {
  const counts = {};
  for (const element of all) counts[element.file] = (counts[element.file] ?? 0) + 1;
  assert.deepEqual(counts, {
    '404-ar.html': 1,
    '404.html': 1,
    'about.html': 2,
    'app.js': 2,
    'data-deletion-ar.html': 1,
    'data-deletion.html': 1,
    'identity.js': 1,
    'index.html': 1,
    'privacy-ar.html': 1,
    'privacy.html': 1,
    'terms-ar.html': 1,
    'terms.html': 1,
  });
});

test('no .brand or .about-brand element pairs the mark with plain AMCP text', () => {
  for (const element of all) {
    const text = element.inner.replace(/<[^>]*>/g, '').trim();
    assert.equal(text, '', element.file + ': a brand element holds text; the outlined logo letters are the artwork');
    assert.ok(!element.images.some(image => imageFile(image) === 'mark'), element.file + ': the mark beside no lockup');
  }
});

test('every brand element has an accessible name that contains AMCP, in Latin letters', () => {
  for (const element of all) {
    const name = (element.attributes['aria-label'] ?? element.images.map(image => image.alt ?? '').join(' ')).trim();
    assert.match(name, /\bAMCP\b/, element.file);
    // About keeps its localized home label.
    if (element.file === 'about.html' && element.attributes['aria-label'])
      assert.deepEqual(
        [element.attributes['aria-label'], element.attributes['data-ui-label']],
        ['AMCP home', 'AMCP home'],
      );
  }
});

test('each brand element is the lockup in both variants, or White only on the surfaces dark in both themes', () => {
  for (const element of all) {
    const used = element.images.map(imageFile),
      // The sidebar and the connection result header sit on --surface-inverse, which neither theme changes.
      dark = ['index.html', 'app.js'].includes(element.file);
    assert.deepEqual(used, dark ? ['logo-white'] : ['logo-ink', 'logo-white'], element.file);
    for (const image of element.images) {
      assert.equal(image.class, imageFile(image), element.file + ': the class names the variant CSS shows or hides');
      assert.equal(image.alt, 'AMCP', element.file);
      const width = Number(image.width),
        height = Number(image.height);
      assert.ok(width >= 160, element.file + ': the lockup is at least 160px wide, found ' + width);
      assert.ok(
        Math.abs(width / height - aspect) < 0.03,
        element.file + ': never squeezed, found ' + width + 'x' + height,
      );
    }
  }
});

test('every page links the kit’s favicon.ico as its icon and no longer the SVG mark', () => {
  for (const page of pages) {
    const links = [...read(page).matchAll(/<link\b[^>]*\brel="(?:shortcut )?icon"[^>]*>/g)].map(match => match[0]);
    assert.deepEqual(links, ['<link rel="icon" href="/assets/favicon.ico">'], page);
  }
});

test('no stylesheet squeezes, shrinks below the minimum, recolours or mirrors a logo image', () => {
  const logo = /\.(?:brand|about-brand)\b[^,]*\bimg\b|\.logo-(?:ink|white)\b/;
  for (const sheet of sheets) {
    const rules = new Map();
    for (const declaration of cssDeclarations(read(sheet))) {
      if (!logo.test(declaration.selector)) continue;
      const key = declaration.atRules.join(' ') + ' | ' + declaration.selector,
        rule = rules.get(key) ?? {};
      rule[declaration.property] = declaration.value;
      rules.set(key, rule);
      assert.ok(
        !/^(?:transform|filter|rotate|scale|mask|mask-image|opacity|mix-blend-mode)$/.test(declaration.property),
        sheet + ': ' + declaration.selector + ' { ' + declaration.property + ' } changes the logo artwork',
      );
    }
    for (const [key, rule] of rules) {
      if (rule.width) {
        const width = Number.parseFloat(rule.width);
        assert.match(rule.width, /^\d+(?:\.\d+)?px$/, sheet + ': ' + key);
        assert.ok(width >= 160, sheet + ': ' + key + ' sets a lockup narrower than 160px');
        assert.equal(rule.height, 'auto', sheet + ': ' + key + ' sets a width without height: auto');
      }
      // The markup's width and height attributes are the other side of the ratio: a fixed height here would squeeze it.
      if (rule.height) assert.equal(rule.height, 'auto', sheet + ': ' + key + ' sets a fixed height');
    }
  }
});

// The variant rules: Ink on light and White on dark from first paint (theme.js sets data-theme before the styles load),
// White on a dark system when there is no JavaScript, White only where a surface stays dark in both themes, and Ink in
// print because the theme rules sit in @media screen (print falls back to the base rule, with no print rule to get
// wrong). The page families load different stylesheets, so the one set lives in two: the workspace and About load
// accessibility.css, the policy pages load privacy.css instead. Each page loads exactly one copy and they must not drift.
test('the variant rules are one set, in the stylesheet each page family loads, and nowhere else', () => {
  const rules = sheet =>
      cssDeclarations(read(sheet))
        .filter(d => /\.logo-(?:ink|white)\b/.test(d.selector))
        .map(d => [d.atRules.join(' '), d.selector, d.property, d.value].join(' | ')),
    core = [
      ' | .logo-white | display | none',
      "@media screen | [data-theme='dark'] .logo-ink | display | none",
      "@media screen | [data-theme='dark'] .logo-white | display | block",
      '@media screen and (prefers-color-scheme: dark) | :root:not([data-theme]) .logo-ink | display | none',
      '@media screen and (prefers-color-scheme: dark) | :root:not([data-theme]) .logo-white | display | block',
    ];
  assert.deepEqual(rules('privacy.css'), core);
  // accessibility.css adds the two surfaces that are dark in both themes (--surface-inverse is the same in each).
  assert.deepEqual(
    rules('accessibility.css'),
    core.map(rule =>
      rule.replace(
        "[data-theme='dark'] .logo-white |",
        "[data-theme='dark'] .logo-white, :is(.sidebar, .callback-top) .logo-white |",
      ),
    ),
  );
  for (const sheet of sheets.filter(name => !['privacy.css', 'accessibility.css'].includes(name)))
    assert.deepEqual(rules(sheet), [], sheet + ' holds lockup variant rules');
  // About takes no data-theme rule of its own (tests/web-route-bytes.test.mjs) and loads no theme.css.
  assert.doesNotMatch(read('about.css'), /data-theme/);
  for (const page of pages) {
    const loaded = [
      ...read(page)
        .replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
        .matchAll(/<link rel="stylesheet" href="\/assets\/([^"]+)">/g),
    ].map(match => match[1]);
    assert.equal(
      loaded.filter(sheet => ['privacy.css', 'accessibility.css'].includes(sheet)).length,
      1,
      page + ' loads exactly one copy of the variant rules: ' + loaded.join(', '),
    );
  }
});
