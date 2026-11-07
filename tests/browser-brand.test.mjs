// Package brand: the rendered lockup checks (tools/browser-brand.mjs) fail for every way a logo can be wrong, and pass for
// the ones the guidelines allow. The in-page collector needs a browser (tools/browser-workflow-qa.mjs runs it); here the
// findings are computed from reported geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  brandProblems,
  clearSpace,
  collectBrandLockups,
  contrastRatio,
  lockupAspect,
  lockupFiles,
  visibleVariants,
} from '../tools/browser-brand.mjs';

const box = (left, top, width, height) => ({left, top, right: left + width, bottom: top + height});
/** The surfaces the page reports behind the start, the middle and the end of a lockup. */
const on = (...colours) => colours.map(colour => ({colour, images: []}));
/** A lockup as the page reports it: Ink, 174 x 36, on warm paper, named AMCP, with nothing close by. */
const lockup = (over = {}) => ({
  container: 'public-nav',
  images: 2,
  visible: 1,
  name: 'AMCP',
  file: 'logo-ink.svg',
  alt: 'AMCP',
  loaded: true,
  box: box(64, 28, 174, 36),
  width: 174,
  height: 36,
  surfaces: on([250, 249, 246], [250, 249, 246], [250, 249, 246]),
  mirrored: false,
  viewport: 1280,
  near: [],
  ...over,
});
const problems = sample => brandProblems(sample, 'case');

test('the guidelines’ numbers: the lockup’s ratio, the clear space at its sizes and the wordmark colours', () => {
  assert.ok(Math.abs(lockupAspect - 4.8289) < 0.001);
  // Half the icon's height (the ribbon is 79.5% of the file) less the file's own padding: 11px at 36px tall.
  assert.equal(clearSpace(36), 11);
  assert.equal(clearSpace(33), 10);
  assert.ok(contrastRatio(lockupFiles['logo-ink.svg'].wordmark, [250, 249, 246]) > 12);
  assert.ok(contrastRatio(lockupFiles['logo-white.svg'].wordmark, [32, 29, 48]) > 14);
  // The wrong variant: ink on the dark panel is nearly invisible.
  assert.ok(contrastRatio(lockupFiles['logo-ink.svg'].wordmark, [32, 29, 48]) < 1.5);
});

test('a lockup that follows the guidelines has no findings', () => {
  assert.deepEqual(problems([lockup()]), []);
  // White on the inverse sidebar, and on the dark theme's paper.
  assert.deepEqual(
    problems([
      lockup({file: 'logo-white.svg', surfaces: on([32, 29, 48], [32, 29, 48], [32, 29, 48]), images: 1}),
      lockup({file: 'logo-white.svg', surfaces: on([24, 21, 34], [24, 21, 34], [24, 21, 34])}),
    ]),
    [],
  );
  // The footer's minimum, 160 x 33.
  assert.deepEqual(problems([lockup({width: 160, height: 33, box: box(64, 2680, 160, 33)})]), []);
  // The icon alone, where the lockup cannot fit: 24px or more, square, named AMCP.
  assert.deepEqual(problems([lockup({file: 'mark.svg', width: 24, height: 24, box: box(64, 28, 24, 24)})]), []);
  // Content beyond the clear space is no neighbour.
  assert.deepEqual(problems([lockup({near: [{kind: 'select', ...box(300, 28, 120, 36)}]})]), []);
  assert.deepEqual(problems([]), []);
});

test('the wrong variant for a surface is a finding, in both directions', () => {
  const dark = problems([lockup({surfaces: on([24, 21, 34], [24, 21, 34], [24, 21, 34])})]);
  assert.equal(dark.length, 1);
  assert.match(dark[0], /logo-ink\.svg on rgb\(24,21,34\).*ink on light, white on dark/);
  const light = problems([lockup({file: 'logo-white.svg'})]);
  assert.equal(light.length, 1);
  assert.match(light[0], /logo-white\.svg on rgb\(250,249,246\)/);
});

test('the worst surface behind the lockup decides: one end over a dark panel fails the ink variant', () => {
  // A lockup laid over two panels (the sign-in header sits over the story column at 768px) is read at its start,
  // middle and end; ink over a dark panel at any of them is a finding.
  const found = problems([lockup({surfaces: on([250, 249, 246], [250, 249, 246], [32, 29, 48])})]);
  assert.equal(found.length, 1);
  assert.match(found[0], /logo-ink\.svg on rgb\(32,29,48\)/);
  // The same panels under White: the light one is the finding.
  assert.match(
    problems([lockup({file: 'logo-white.svg', surfaces: on([32, 29, 48], [32, 29, 48], [250, 249, 246])})])[0],
    /logo-white\.svg on rgb\(250,249,246\)/,
  );
  // A report with no surface at all is read as white paper, so White fails it.
  assert.match(problems([lockup({file: 'logo-white.svg', surfaces: []})])[0], /logo-white\.svg on rgb\(255,255,255\)/);
});

test('a lockup under 160px, an icon under 24px, or a stretched image is a finding', () => {
  assert.match(
    problems([lockup({width: 150, height: 31, box: box(64, 28, 150, 31)})])[0],
    /150px wide, under the 160px minimum/,
  );
  assert.match(
    problems([lockup({file: 'mark.svg', width: 20, height: 20, box: box(64, 28, 20, 20)})])[0],
    /20px wide, under the 24px minimum/,
  );
  // The 33px square the old mark had, given to the lockup: 160 x 33 is fine, 174 x 33 is not.
  assert.match(problems([lockup({height: 33, box: box(64, 28, 174, 33)})])[0], /stretched: 174\.0 x 33\.0/);
  assert.match(problems([lockup({file: 'mark.svg', width: 38, height: 30, box: box(64, 28, 38, 30)})])[0], /stretched/);
});

test('both images showing, none showing, a missing file or a mirrored image is a finding', () => {
  assert.match(problems([lockup({visible: 2})])[0], /shows 2 of its 2 images; exactly one/);
  assert.match(
    problems([{container: 'public-nav', images: 2, visible: 0, name: 'AMCP', file: null, box: null}])[0],
    /shows no image/,
  );
  assert.match(problems([lockup({file: 'logo.png'})])[0], /logo\.png, which is not a brand file/);
  assert.match(problems([lockup({loaded: false})])[0], /did not load/);
  assert.match(problems([lockup({mirrored: true, container: 'about-header'})])[0], /\.about-header lockup is mirrored/);
});

test('a lockup is named AMCP in Latin letters, or the home label that contains it', () => {
  assert.match(problems([lockup({name: 'الصفحة الرئيسية'})])[0], /named "الصفحة الرئيسية", not AMCP/);
  assert.match(problems([lockup({name: ''})])[0], /named "", not AMCP/);
  assert.deepEqual(problems([lockup({name: 'AMCP home'})]), []);
});

test('content inside the clear space, or a page edge closer than it, is a finding', () => {
  // 10px under the lockup: the sign-in header's wrapped row at 320 px was exactly this before the row gap became 12px.
  const close = problems([lockup({near: [{kind: 'select', ...box(19, 70, 90, 36)}], box: box(19, 24, 174, 36)})]);
  assert.equal(close.length, 1);
  assert.match(close[0], /select 10px away, under the 11px clear space/);
  // Words beside it, 8px away.
  assert.match(
    problems([lockup({near: [{kind: 'text', text: 'About us', ...box(246, 36, 60, 18)}]})])[0],
    /text "About us" 8px away/,
  );
  // Overlapping is the extreme case.
  assert.match(problems([lockup({near: [{kind: 'button', ...box(200, 30, 40, 30)}]})])[0], /button 0px away/);
  // A different axis far enough away is not a neighbour: below by 12px.
  assert.deepEqual(problems([lockup({near: [{kind: 'select', ...box(64, 76, 90, 36)}]})]), []);
  // The page edge: 8px from the start edge, and 8px from the end edge, and 5px from the top.
  assert.match(problems([lockup({box: box(8, 28, 174, 36)})])[0], /8px from the page edge/);
  assert.match(problems([lockup({box: box(1098, 28, 174, 36)})])[0], /8px from the page edge/);
  assert.match(problems([lockup({box: box(64, 5, 174, 36)})])[0], /5px from the top of the page/);
  // Scrolled down 168px, its top is -168 on the screen but still 28px down the page.
  assert.deepEqual(problems([lockup({box: box(22, -140, 174, 36), pageTop: 28})]), []);
  assert.match(problems([lockup({box: box(22, -160, 174, 36), pageTop: 8})])[0], /8px from the top of the page/);
});

test('each finding names the page, so a failing case says where', () => {
  const [finding] = brandProblems(
    [lockup({container: 'public-footer', width: 150, height: 31, box: box(64, 2680, 150, 31)})],
    'landing en 320 dark',
  );
  assert.match(finding, /^landing en 320 dark: \.public-footer lockup is 150px wide/);
});

test('the visible variant of each lockup is reported, for the print and no-script comparisons', () => {
  assert.deepEqual(visibleVariants([lockup(), lockup({file: 'logo-white.svg'}), lockup({file: 'mark.svg'})]), [
    'ink',
    'white',
    'icon',
  ]);
  assert.deepEqual(visibleVariants(undefined), []);
});

test('the in-page collector is self-contained: a browser receives only its source text', () => {
  // Playwright sends collectBrandLockups as source, so it may read nothing from this module. Run it in a context that
  // has only a page with no lockups.
  const context = vm.createContext({
    document: {
      documentElement: {clientWidth: 320},
      body: {classList: {contains: () => true}},
      querySelectorAll: () => [],
      createRange: () => ({}),
    },
    getComputedStyle: () => ({}),
  });
  const found = vm.runInContext('JSON.stringify((' + collectBrandLockups.toString() + ')())', context);
  assert.equal(found, '[]');
});
