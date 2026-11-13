// The computable checks of a categorical chart palette, as the data visualisation skill's validator runs them, copied here so
// that a test needs neither the skill nor its path (V2-EXP-01 asks for the validation as a test that runs the checks).
//
//   lightness band     OKLCH L inside the mode's band
//   chroma floor       OKLCH C at or above the floor (below it a hue reads as grey)
//   CVD separation     OKLab delta E x 100 between adjacent slots under simulated protan and deutan vision
//                      (Machado, Oliveira and Fernandes 2009, severity 1.0), 8 or more to pass, 6 to 8 only with
//                      a second encoding (direct labels, gaps, texture), tritan reported
//   normal-vision floor  the worst adjacent pair under unsimulated vision is at least 15
//   contrast           WCAG ratio of each mark against the surface, 3:1 or more, else relief (labels, a table view)
//
// Euclidean distance in OKLab; thresholds as the validator has them. Text contrast (WCAG 4.5:1) is `contrast` below.
const BAND = {light: [0.43, 0.77], dark: [0.48, 0.67]};
const CHROMA_FLOOR = 0.1;
const CVD_TARGET = 8.0;
const CVD_FLOOR = 6.0;
const NORMAL_FLOOR = 15.0;
const CONTRAST_MIN = 3.0;

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const toSrgb = hex => [0, 2, 4].map(at => parseInt(hex.replace(/^#/, '').slice(at, at + 2), 16) / 255);
const toLinear = channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const linear = hex => toSrgb(hex).map(toLinear);
const luminance = hex => {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** The WCAG contrast ratio of two colours, 1 to 21. */
export const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};
function oklabFromLinear([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const oklch = hex => {
  const [L, a, b] = oklabFromLinear(linear(hex));
  return [L, Math.hypot(a, b)];
};
const simulate = (hex, kind) => {
  const [r, g, b] = linear(hex),
    matrix = MACHADO[kind],
    clamp = value => Math.max(0, Math.min(1, value));
  return matrix.map(row => clamp(row[0] * r + row[1] * g + row[2] * b));
};
/** The distance of two colours in OKLab x 100, under a kind of colour-vision deficiency or (no kind) normal vision. */
export const deltaE = (a, b, kind) => {
  const x = oklabFromLinear(kind ? simulate(a, kind) : linear(a)),
    y = oklabFromLinear(kind ? simulate(b, kind) : linear(b));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

/**
 * The six checks of a set of hues in one mode against one surface. Each entry of `checks` has a `state`: 'pass', 'floor'
 * (legal with a second encoding), 'relief' (legal with labels or a table view) or 'fail'; `ok` is false when any fails.
 */
export function validatePalette(palette, {mode, surface}) {
  const [low, high] = BAND[mode],
    checks = {};
  const offBand = palette.filter(hex => oklch(hex)[0] < low || oklch(hex)[0] > high);
  checks.lightness = {state: offBand.length ? 'fail' : 'pass', detail: offBand};
  const grey = palette.filter(hex => oklch(hex)[1] < CHROMA_FLOOR);
  checks.chroma = {state: grey.length ? 'fail' : 'pass', detail: grey};
  const pairs = palette.slice(1).map((hex, index) => [palette[index], hex]);
  let worst = {value: Infinity, kind: '', pair: []};
  for (const kind of ['protan', 'deutan'])
    for (const pair of pairs) {
      const value = deltaE(pair[0], pair[1], kind);
      if (value < worst.value) worst = {value, kind, pair};
    }
  checks.cvd = {
    state: worst.value >= CVD_TARGET ? 'pass' : worst.value >= CVD_FLOOR ? 'floor' : 'fail',
    detail: worst,
    tritan: Math.min(...pairs.map(pair => deltaE(pair[0], pair[1], 'tritan'))),
  };
  const normal = Math.min(...pairs.map(pair => deltaE(pair[0], pair[1])));
  checks.normal = {state: normal >= NORMAL_FLOOR ? 'pass' : 'fail', detail: normal};
  const dim = palette.filter(hex => contrast(hex, surface) < CONTRAST_MIN);
  checks.contrast = {state: dim.length ? 'relief' : 'pass', detail: dim.map(hex => [hex, contrast(hex, surface)])};
  return {checks, ok: Object.values(checks).every(check => check.state !== 'fail')};
}

/** The thresholds, for a test that states them. */
export const thresholds = {BAND, CHROMA_FLOOR, CVD_TARGET, CVD_FLOOR, NORMAL_FLOOR, CONTRAST_MIN, TEXT_CONTRAST: 4.5};
