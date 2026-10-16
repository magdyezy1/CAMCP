import {variantPresets} from './media-variants.js';

/**
 * Provider creative specifications per placement (MED-06): a versioned table that `amcp_media plan` checks each
 * destination's file against before anything is sent, so a shape, size, duration or file size a placement does not
 * take is seen at plan time instead of as a provider processing failure after a provider object exists.
 *
 * The check is advisory only (warning-only, the ticket's default until the owner decides to block): providers enforce
 * their own rules and remain the source of truth, and nothing here refuses a plan, a review or an upload. Every entry
 * names the provider page it summarizes and the day it was recorded. The figures were recorded on MEDIA_SPEC_VERSION
 * without a fetch of those pages (this build makes no provider or web calls); until an owner-run read-only comparison
 * against each page sets `verified_on`, every result says `verified_against_source: false`. A table older than
 * MEDIA_SPEC_REVIEW_DAYS reports `stale: true` so outdated figures are labelled rather than trusted.
 */
export const MEDIA_SPEC_VERSION = '2026-10-11';
/** After this many days without a review of the table, every result is labelled stale. */
export const MEDIA_SPEC_REVIEW_DAYS = 180;

/** One accepted shape: an exact ratio (width / height) or an inclusive range, with an optional minimum size. */
export interface SpecShape {
  /** How the provider names the shape, kept literal ("1.91:1", "4:5 to 1.91:1"). */
  name: string;
  ratio: number | [number, number];
  /** Minimum width and height in pixels; 0 means no stated bound on that side. */
  min?: [number, number];
}
export interface PlacementSpec {
  platform: string;
  /** The provider's own placement or format name, kept literal. */
  placement: string;
  kind: 'image' | 'video';
  /** DV360 only: the entry applies to this upload target (Demand Gen ad assets). */
  target?: 'ad_asset';
  shapes: SpecShape[];
  /** Video length in seconds, inclusive; either side may be absent. */
  duration?: {min?: number; max?: number};
  /** The provider's stated maximum file size for this placement, in bytes. */
  max_bytes?: number;
  source_url: string;
  recorded_on: string;
  /** The day an owner-run comparison confirmed the entry against `source_url`; null until then. */
  verified_on: string | null;
}

const MB = 1000 * 1000,
  MiB = 1024 * 1024,
  KB = 1024;
const exact = (name: string, w: number, h: number, min?: [number, number]): SpecShape => ({
  name,
  ratio: w / h,
  ...(min ? {min} : {}),
});
const recorded = {recorded_on: MEDIA_SPEC_VERSION, verified_on: null};
const sources = {
  meta: 'https://www.facebook.com/business/ads-guide',
  tiktokVideo: 'https://ads.tiktok.com/help/article/video-ads-specifications',
  tiktokImage: 'https://ads.tiktok.com/help/article/image-ads-specifications',
  snapchat: 'https://businesshelp.snapchat.com/s/article/creative-specs',
  googleDisplay: 'https://support.google.com/google-ads/answer/9823397',
  googleDemandGen: 'https://support.google.com/google-ads/answer/13547298',
  googleVideo: 'https://support.google.com/google-ads/answer/2375464',
  linkedinImage: 'https://www.linkedin.com/help/lms/answer/a426534',
  linkedinVideo: 'https://www.linkedin.com/help/lms/answer/a424737',
  x: 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications',
};
/** The table. Placement names and shape names are the providers' own words and stay literal in every language. */
export const placementSpecs: readonly PlacementSpec[] = Object.freeze([
  {
    platform: 'meta',
    placement: 'Feed',
    kind: 'image',
    shapes: [{name: '4:5 to 1.91:1', ratio: [4 / 5, 1.91], min: [600, 0]}],
    max_bytes: 30 * MiB,
    source_url: sources.meta,
    ...recorded,
  },
  {
    platform: 'meta',
    placement: 'Stories and Reels',
    kind: 'image',
    shapes: [exact('9:16', 9, 16, [500, 0])],
    max_bytes: 30 * MiB,
    source_url: sources.meta,
    ...recorded,
  },
  {
    platform: 'meta',
    placement: 'Feed',
    kind: 'video',
    shapes: [{name: '4:5 to 16:9', ratio: [4 / 5, 16 / 9]}],
    duration: {min: 1, max: 241 * 60},
    max_bytes: 4 * 1024 * MiB,
    source_url: sources.meta,
    ...recorded,
  },
  {
    platform: 'meta',
    placement: 'Stories',
    kind: 'video',
    shapes: [exact('9:16', 9, 16, [500, 0])],
    duration: {min: 1, max: 60},
    max_bytes: 4 * 1024 * MiB,
    source_url: sources.meta,
    ...recorded,
  },
  {
    platform: 'meta',
    placement: 'Reels',
    kind: 'video',
    shapes: [exact('9:16', 9, 16, [500, 0])],
    max_bytes: 4 * 1024 * MiB,
    source_url: sources.meta,
    ...recorded,
  },
  {
    platform: 'tiktok',
    placement: 'In-feed video',
    kind: 'video',
    shapes: [exact('9:16', 9, 16, [540, 960]), exact('1:1', 1, 1, [640, 640]), exact('16:9', 16, 9, [960, 540])],
    duration: {min: 5, max: 600},
    max_bytes: 500 * MB,
    source_url: sources.tiktokVideo,
    ...recorded,
  },
  {
    platform: 'tiktok',
    placement: 'Image ads (Pangle and app placements)',
    kind: 'image',
    shapes: [exact('1.91:1', 1.91, 1, [1200, 628]), exact('9:16', 9, 16, [720, 1280]), exact('1:1', 1, 1, [640, 640])],
    source_url: sources.tiktokImage,
    ...recorded,
  },
  {
    platform: 'snapchat',
    placement: 'Single Image',
    kind: 'image',
    shapes: [exact('9:16', 9, 16, [1080, 1920])],
    max_bytes: 5 * MB,
    source_url: sources.snapchat,
    ...recorded,
  },
  {
    platform: 'snapchat',
    placement: 'Single Video',
    kind: 'video',
    shapes: [exact('9:16', 9, 16, [1080, 1920])],
    duration: {min: 3, max: 180},
    max_bytes: 1000 * MB,
    source_url: sources.snapchat,
    ...recorded,
  },
  {
    platform: 'google_ads',
    placement: 'Responsive display ads',
    kind: 'image',
    shapes: [exact('1.91:1', 1.91, 1, [600, 314]), exact('1:1', 1, 1, [300, 300])],
    max_bytes: 5120 * KB,
    source_url: sources.googleDisplay,
    ...recorded,
  },
  {
    platform: 'google_ads',
    placement: 'Demand Gen',
    kind: 'image',
    shapes: [exact('1.91:1', 1.91, 1, [600, 314]), exact('1:1', 1, 1, [300, 300]), exact('4:5', 4, 5, [480, 600])],
    max_bytes: 5120 * KB,
    source_url: sources.googleDemandGen,
    ...recorded,
  },
  {
    platform: 'google_ads',
    placement: 'YouTube video ads',
    kind: 'video',
    shapes: [exact('16:9', 16, 9), exact('1:1', 1, 1), exact('4:5', 4, 5), exact('9:16', 9, 16)],
    source_url: sources.googleVideo,
    ...recorded,
  },
  {
    platform: 'linkedin',
    placement: 'Single image ads',
    kind: 'image',
    shapes: [
      exact('1.91:1', 1.91, 1, [640, 0]),
      exact('1:1', 1, 1, [360, 360]),
      exact('4:5', 4, 5),
      exact('1:1.91', 1, 1.91, [360, 640]),
    ],
    max_bytes: 5 * MB,
    source_url: sources.linkedinImage,
    ...recorded,
  },
  {
    platform: 'linkedin',
    placement: 'Video ads',
    kind: 'video',
    shapes: [exact('16:9', 16, 9), exact('1:1', 1, 1), exact('4:5', 4, 5), exact('9:16', 9, 16)],
    duration: {min: 3, max: 30 * 60},
    max_bytes: 500 * MB,
    source_url: sources.linkedinVideo,
    ...recorded,
  },
  {
    platform: 'x_ads',
    placement: 'Image ads',
    kind: 'image',
    shapes: [exact('1:1', 1, 1, [800, 800]), exact('1.91:1', 1.91, 1, [800, 418])],
    max_bytes: 5 * MB,
    source_url: sources.x,
    ...recorded,
  },
  {
    platform: 'x_ads',
    placement: 'Video ads',
    kind: 'video',
    shapes: [exact('16:9', 16, 9), exact('1:1', 1, 1), exact('9:16', 9, 16)],
    duration: {max: 140},
    max_bytes: 1000 * MB,
    source_url: sources.x,
    ...recorded,
  },
  {
    platform: 'dv360',
    target: 'ad_asset',
    placement: 'Demand Gen image asset',
    kind: 'image',
    shapes: [exact('1.91:1', 1.91, 1, [600, 314]), exact('1:1', 1, 1, [300, 300]), exact('4:5', 4, 5, [480, 600])],
    max_bytes: 5120 * KB,
    source_url: sources.googleDemandGen,
    ...recorded,
  },
] satisfies PlacementSpec[]);

/** A file as a destination would receive it. Unknown facts are null and are reported as not checked. */
export interface PlannedFile {
  kind: 'image' | 'video';
  width: number | null;
  height: number | null;
  duration: number | null;
  size: number | null;
}
export type PlacementIssueCheck = 'aspect_ratio' | 'min_resolution' | 'min_duration' | 'max_duration' | 'max_bytes';
export interface PlacementIssue {
  check: PlacementIssueCheck;
  actual: string | number;
  expected: string | number;
}
export interface PlacementResult {
  placement: string;
  fits: boolean;
  issues: PlacementIssue[];
  /** Facts the check could not judge because the file's record lacks them. */
  unchecked: ('geometry' | 'duration' | 'size')[];
  source_url: string;
}
export interface PlacementCheck {
  spec_version: string;
  advisory: true;
  verified_against_source: boolean;
  stale: boolean;
  placements: PlacementResult[];
  fits_any: boolean;
  /** A variant preset whose shape and size the placements take, when none takes the file as it is. */
  suggested_preset?: string;
  meaning: string;
}

/** Ratios within one percent count as the same shape (1200 × 627 is 1.91:1). */
const RATIO_TOLERANCE = 0.01;
const shapeFits = (ratio: number, shape: SpecShape) =>
  Array.isArray(shape.ratio)
    ? ratio >= shape.ratio[0] * (1 - RATIO_TOLERANCE) && ratio <= shape.ratio[1] * (1 + RATIO_TOLERANCE)
    : Math.abs(ratio / shape.ratio - 1) <= RATIO_TOLERANCE;
const ratioText = (width: number, height: number) => {
  const divisor = (a: number, b: number): number => (b ? divisor(b, a % b) : a),
    d = divisor(width, height);
  return width / d <= 50 && height / d <= 50
    ? width / d + ':' + height / d
    : width / height >= 1
      ? (width / height).toFixed(2) + ':1'
      : '1:' + (height / width).toFixed(2);
};

/** Checks one file against one placement's recorded specification. */
export function checkPlacement(spec: PlacementSpec, file: PlannedFile): PlacementResult {
  const issues: PlacementIssue[] = [],
    unchecked: PlacementResult['unchecked'] = [];
  const {width, height} = file;
  if (width && height && width > 0 && height > 0) {
    const ratio = width / height,
      shape = spec.shapes.find(s => shapeFits(ratio, s));
    if (!shape)
      issues.push({
        check: 'aspect_ratio',
        actual: ratioText(width, height),
        expected: spec.shapes.map(s => s.name).join(', '),
      });
    else if (shape.min && (width < shape.min[0] || height < shape.min[1]))
      issues.push({
        check: 'min_resolution',
        actual: width + '×' + height,
        expected: shape.min.map(n => n || '—').join('×'),
      });
  } else unchecked.push('geometry');
  if (file.kind === 'video' && spec.duration) {
    if (file.duration === null || !Number.isFinite(file.duration)) unchecked.push('duration');
    else if (spec.duration.min !== undefined && file.duration < spec.duration.min)
      issues.push({check: 'min_duration', actual: +file.duration.toFixed(1), expected: spec.duration.min});
    else if (spec.duration.max !== undefined && file.duration > spec.duration.max)
      issues.push({check: 'max_duration', actual: +file.duration.toFixed(1), expected: spec.duration.max});
  }
  if (spec.max_bytes !== undefined) {
    if (file.size === null) unchecked.push('size');
    else if (file.size > spec.max_bytes) issues.push({check: 'max_bytes', actual: file.size, expected: spec.max_bytes});
  }
  return {placement: spec.placement, fits: issues.length === 0, issues, unchecked, source_url: spec.source_url};
}

/** The recorded placements a destination's upload can be used in: by platform, kind and (DV360) upload target. */
export function placementsFor(platform: string, kind: 'image' | 'video', target?: string): PlacementSpec[] {
  return placementSpecs.filter(
    s => s.platform === platform && s.kind === kind && (s.target ?? undefined) === (target ?? undefined),
  );
}

/** Whether the table is past its review interval at `now`. */
export function mediaSpecsStale(now = Date.now()): boolean {
  return now - Date.parse(MEDIA_SPEC_VERSION + 'T00:00:00Z') > MEDIA_SPEC_REVIEW_DAYS * 86400000;
}

/**
 * The advisory placement check for one destination (MED-06): every recorded placement of the platform for this kind
 * of file, what does not fit and why, and, when no placement takes the file as it is, the variant preset that the
 * most placements would take (shape and size only: a variant cannot change a duration or a file size limit). Undefined
 * when the table records no placement for this destination (a DV360 creative asset, for instance).
 */
export function placementPreflight(
  platform: string,
  file: PlannedFile,
  options: {target?: string; now?: number} = {},
): PlacementCheck | undefined {
  const specs = placementsFor(platform, file.kind, options.target);
  if (!specs.length) return undefined;
  const placements = specs.map(s => checkPlacement(s, file)),
    fitsAny = placements.some(p => p.fits);
  let suggested: string | undefined;
  if (!fitsAny && placements.some(p => p.issues.some(i => ['aspect_ratio', 'min_resolution'].includes(i.check)))) {
    let best = 0,
      bestDistance = Infinity;
    const ratio = file.width && file.height ? file.width / file.height : 1;
    for (const [preset, [width, height]] of Object.entries(variantPresets)) {
      const fitting = specs.filter(
          s => !checkPlacement(s, {...file, width, height}).issues.some(i => i.check !== 'max_bytes'),
        ).length,
        distance = Math.abs(Math.log(width / height / ratio));
      if (fitting > best || (fitting === best && fitting > 0 && distance < bestDistance)) {
        best = fitting;
        bestDistance = distance;
        suggested = preset;
      }
    }
  }
  return {
    spec_version: MEDIA_SPEC_VERSION,
    advisory: true,
    verified_against_source: specs.every(s => s.verified_on !== null),
    stale: mediaSpecsStale(options.now),
    placements,
    fits_any: fitsAny,
    ...(suggested ? {suggested_preset: suggested} : {}),
    meaning:
      'Advisory: compared with AMCP’s recorded provider specifications, not a provider check. The platform’s own processing and review decide; nothing is refused because of this check.',
  };
}
