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
