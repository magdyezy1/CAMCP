// Rendered checks of the AMCP lockup (package brand; docs/records/BRAND-KIT-V1-2026-11-07.md). The brand guidelines
// ask for: the full lockup at 160px wide or more (the icon alone, 24px or more, where it cannot fit); white on dark
// surfaces and ink on light ones; free space on every side of at least half the icon's height; no stretching,
// rotating or mirroring. tests/brand-lockup.test.mjs reads the markup and stylesheets; this module is what a real
// browser measures. The page reports geometry and the visible image of each lockup; the findings are computed here,
// so they are testable without a browser (tests/browser-brand.test.mjs).

/** The lockup files' own viewBox is 1270 x 263. */
export const lockupAspect = 1270 / 263;
export const minimumLockupWidth = 160;
export const minimumIconWidth = 24;
/**
 * The wordmark colour of each variant (AMCP_Brand_Guidelines.md: ink #222137 on light backgrounds, white on dark
 * ones); the icon alone is a dark tile that suits any surface.
 */
export const lockupFiles = Object.freeze({
  'logo-ink.svg': {tone: 'ink', wordmark: [0x22, 0x21, 0x37]},
  'logo-white.svg': {tone: 'white', wordmark: [0xff, 0xff, 0xff]},
  'mark.svg': {tone: 'icon', wordmark: null},
});
/** WCAG contrast the wordmark needs against the surface behind it, so dark ink on a dark panel fails by a wide margin. */
export const wordmarkContrast = 4.5;
/**
 * The clear space the guidelines ask for outside the image box, in CSS pixels: half the icon's height (the ribbon is
 * 79.5% of the file's height) less the file's own padding (at least 9.9% of its height at the thinnest side).
 * At 36px tall: 14.3 - 3.6 = 10.7, so 11px.
 */
export const clearSpace = height => Math.ceil(height * (0.795 / 2 - 0.099));

const luminance = ([r, g, b]) => {
  const channel = c => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
export const contrastRatio = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

/**
 * Runs in the page: every visible lockup (an image inside a .brand or .about-brand element) with its box, file, size,
 * the surface colour behind it, the content close to it and whether it is mirrored. The closed phone drawer is
 * off-screen by design and is not measured. `limit` is how far from the image (in pixels) other content is reported.
 */
export function collectBrandLockups(limit = 48) {
  const width = document.documentElement.clientWidth,
    drawerClosed = !document.body.classList.contains('menu-open'),
    shown = element =>
      typeof element.checkVisibility === 'function'
        ? element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
        : element.getClientRects().length > 0,
    rect = box => ({left: box.left, top: box.top, right: box.right, bottom: box.bottom}),
    parse = value =>
      (/rgba?\(([^)]+)\)/.exec(value)?.[1] ?? '')
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number),
    surfaceAt = (element, x, y) => {
      // What is painted behind the image at one point: the elements stacked there, topmost first (a lockup can overlay a
      // panel that is not its ancestor), or its ancestors when the point is off the screen. The nearest opaque
      // background ends the search and a partly transparent one is mixed with what is behind it.
      const onScreen = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
        stack = onScreen ? document.elementsFromPoint(x, y) : [];
      if (!stack.length) for (let node = element; node; node = node.parentElement) stack.push(node);
      const layers = [];
      for (const node of stack) {
        const style = getComputedStyle(node),
          [r, g, b, a = 1] = parse(style.backgroundColor);
        if (style.backgroundImage !== 'none') layers.push({image: style.backgroundImage.slice(0, 60)});
        if (a > 0) layers.push({r, g, b, a});
        if (a >= 1) break;
      }
      let colour = [255, 255, 255];
      for (const layer of layers.filter(l => l.a !== undefined).reverse())
        colour = [layer.r, layer.g, layer.b].map((channel, i) => channel * layer.a + colour[i] * (1 - layer.a));
      return {colour: colour.map(Math.round), images: layers.filter(l => l.image).map(l => l.image)};
    },
    // A fixed or sticky ancestor keeps its place on the screen; anything else moves with the page when it is scrolled.
    pinned = element => {
      for (let node = element; node && node !== document.documentElement; node = node.parentElement)
        if (/^(?:fixed|sticky)$/.test(getComputedStyle(node).position)) return true;
      return false;
    },
    mirrored = element => {
      for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
        const transform = getComputedStyle(node).transform,
          matrix = /^matrix\(([^)]+)\)$/.exec(transform)?.[1].split(',').map(Number);
        if (matrix && matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0) return true;
      }
      return false;
    };
  // What counts as content near a lockup: words, images and controls (not their padding or empty containers).
  const contents = [];
  const skip = '[hidden], [inert], dialog:not([open]), .skip, .skip-link, #navigation-scrim, script, style, noscript';
  for (const element of document.querySelectorAll('body *')) {
    if (element.closest(skip) || !shown(element)) continue;
    if (element.matches('img, svg, canvas, video, input, select, textarea, button, [role=img]')) {
      if (element.closest('svg') !== element && element.closest('svg')) continue;
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0)
        contents.push({element, box: rect(box), kind: element.tagName.toLowerCase()});
    }
    for (const node of element.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const box of range.getClientRects())
        if (box.width > 0 && box.height > 0)
          contents.push({element, box: rect(box), kind: 'text', text: node.textContent.trim().slice(0, 30)});
    }
  }
  const lockups = [];
  for (const brand of document.querySelectorAll('.brand, .about-brand')) {
    if (brand.closest('[hidden], [inert]')) continue;
    if (
      drawerClosed &&
      brand.closest('#workspace-sidebar') &&
      getComputedStyle(brand.closest('.sidebar')).transform !== 'none'
    )
      continue;
    const images = [...brand.querySelectorAll('img')],
      visible = images.filter(shown);
    if (!images.length || !shown(brand)) continue;
    const link = brand.closest('a') ?? brand;
    const sample = {
      container: brand.parentElement?.className || brand.parentElement?.tagName.toLowerCase(),
      images: images.length,
      visible: visible.length,
      name: (brand.getAttribute('aria-label') ?? visible.map(image => image.alt).join(' ')).trim(),
      direction: getComputedStyle(brand).direction,
      link: link.matches('a[href]') ? link.getAttribute('href') : null,
    };
    for (const image of visible) {
      const box = image.getBoundingClientRect(),
        file = (/([\w-]+\.svg)(?:$|\?)/.exec(image.currentSrc || image.src) ?? [])[1] ?? null;
      const near = contents
        .filter(
          item =>
            !brand.contains(item.element) &&
            !item.element.contains(image) &&
            item.box.left < box.right + limit &&
            item.box.right > box.left - limit &&
            item.box.top < box.bottom + limit &&
            item.box.bottom > box.top - limit,
        )
        .map(item => ({kind: item.kind, text: item.text, ...item.box}));
      lockups.push({
        ...sample,
        file,
        alt: image.alt,
        loaded: image.complete && image.naturalWidth > 0,
        box: rect(box),
        // Distance from the top of the page, whatever the scroll position (the sidebar is fixed on the screen).
        pageTop: box.top + (pinned(image) ? 0 : window.scrollY),
        width: box.width,
        height: box.height,
        // Behind the start, the middle and the end of the lockup, at its mid-height.
        surfaces: [0.1, 0.5, 0.9].map(at => surfaceAt(image, box.left + box.width * at, box.top + box.height / 2)),
        mirrored: mirrored(image),
        viewport: width,
        near,
      });
    }
    if (!visible.length) lockups.push({...sample, file: null, box: null});
  }
  return lockups;
}

/** The distance between two boxes along each axis: zero when they overlap on that axis. */
const gap = (a, b) => ({
  x: Math.max(0, a.left - b.right, b.left - a.right),
  y: Math.max(0, a.top - b.bottom, b.top - a.bottom),
});

/**
 * Findings for a sample of lockups: the file and size, the variant against the surface, the clear space, the
 * aspect ratio and mirroring, and the name. `where` is a label for the page (route, language, width, theme).
 */
export function brandProblems(sample, where = '') {
  const problems = [],
    prefix = where ? where + ': ' : '';
  for (const lockup of Array.isArray(sample) ? sample : []) {
    const label = prefix + '.' + (lockup.container ?? 'brand') + ' lockup';
    if (!lockup.file) {
      problems.push(`${label} shows no image (a variant must be visible on every theme)`);
      continue;
    }
    const known = lockupFiles[lockup.file];
    if (!known) {
      problems.push(`${label} shows ${lockup.file}, which is not a brand file`);
      continue;
    }
    if (lockup.visible !== 1)
      problems.push(`${label} shows ${lockup.visible} of its ${lockup.images} images; exactly one`);
    if (!lockup.loaded) problems.push(`${label} (${lockup.file}) did not load`);
    if (!/\bAMCP\b/.test(lockup.name ?? '')) problems.push(`${label} is named "${lockup.name}", not AMCP`);
    if (lockup.mirrored) problems.push(`${label} is mirrored; the art is never flipped, in either language`);
    const icon = known.tone === 'icon',
      minimum = icon ? minimumIconWidth : minimumLockupWidth;
    if (lockup.width < minimum - 0.5)
      problems.push(`${label} is ${Math.round(lockup.width)}px wide, under the ${minimum}px minimum`);
    const aspect = icon ? 1 : lockupAspect;
    if (Math.abs(lockup.width / lockup.height / aspect - 1) > 0.01)
      problems.push(`${label} is stretched: ${lockup.width.toFixed(1)} x ${lockup.height.toFixed(1)}`);
    if (known.wordmark) {
      // The worst of the surfaces behind its start, middle and end.
      const surfaces = (lockup.surfaces?.length ? lockup.surfaces : [{colour: [255, 255, 255]}]).map(surface => ({
          colour: surface.colour,
          ratio: contrastRatio(known.wordmark, surface.colour),
        })),
        worst = surfaces.reduce((low, next) => (next.ratio < low.ratio ? next : low));
      if (worst.ratio < wordmarkContrast)
        problems.push(
          `${label} shows ${lockup.file} on rgb(${worst.colour.join(',')}): ${worst.ratio.toFixed(2)}:1, ` +
            `under ${wordmarkContrast}:1 (ink on light, white on dark)`,
        );
    }
    // Free space on every side: other words, images and controls, and the edges of the page.
    const needed = clearSpace(lockup.height),
      box = lockup.box;
    for (const other of lockup.near ?? []) {
      const distance = gap(box, other);
      if (distance.x < needed && distance.y < needed)
        problems.push(
          `${label} has ${other.kind}${other.text ? ' "' + other.text + '"' : ''} ` +
            `${Math.round(Math.max(distance.x, distance.y))}px away, under the ${needed}px clear space`,
        );
    }
    if (box.left < needed || lockup.viewport - box.right < needed)
      problems.push(
        `${label} is ${Math.round(Math.min(box.left, lockup.viewport - box.right))}px from the page edge, under ${needed}px`,
      );
    const top = lockup.pageTop ?? box.top;
    if (top < needed) problems.push(`${label} is ${Math.round(top)}px from the top of the page, under ${needed}px`);
  }
  return problems;
}

/** The visible variants of a sample, as {container: file}: what print and no-script pages are compared on. */
export const visibleVariants = sample =>
  (Array.isArray(sample) ? sample : []).map(lockup => lockupFiles[lockup.file]?.tone ?? null);
