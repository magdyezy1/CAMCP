// MED-06 (review 2026-10-08, owner-accepted 2026-10-11): an advisory provider creative-spec preflight. Before this,
// `amcp_media plan` checked only access and AMCP's own limits, so a shape, size, duration or file size a placement
// does not take surfaced only as a provider processing failure after a provider object existed. The plan now checks
// each destination's file against a versioned, cited table and says which recorded placements take it; it never
// refuses a destination because of that table.
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MEDIA_SPEC_REVIEW_DAYS,
  MEDIA_SPEC_VERSION,
  checkPlacement,
  mediaSpecsStale,
  placementPreflight,
  placementSpecs,
  placementsFor,
  type PlannedFile,
} from '../src/media-specs.js';
import {mediaPlatforms} from '../src/media-routing.js';
import {variantPresets, ffmpegPath, runMediaProcess} from '../src/media-variants.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {SOURCE_CHUNK_BYTES} from '../src/media-sources.js';
import type {Actor, JsonObject} from '../src/types.js';
import {removeTestDirectoryAsync} from './temp.js';

const image = (width: number, height: number, size = 100_000): PlannedFile => ({
    kind: 'image',
    width,
    height,
    duration: null,
    size,
  }),
  video = (width: number, height: number, duration: number | null, size = 1_000_000): PlannedFile => ({
    kind: 'video',
    width,
    height,
    duration,
    size,
  });

test('every recorded placement names its provider page, its recording date and an unverified status', () => {
  assert.ok(placementSpecs.length >= 15);
  for (const spec of placementSpecs) {
    assert.ok(mediaPlatforms.includes(spec.platform), spec.platform);
    assert.match(spec.source_url, /^https:\/\/[a-z0-9.-]+\//, spec.placement);
    assert.equal(spec.recorded_on, MEDIA_SPEC_VERSION);
    // No entry claims a comparison against its page that this build did not make (the Native acceptance step).
    assert.equal(spec.verified_on, null);
    assert.ok(spec.shapes.length > 0);
    for (const shape of spec.shapes)
      assert.ok(
        Array.isArray(shape.ratio) ? shape.ratio[0] > 0 && shape.ratio[0] < shape.ratio[1] : shape.ratio > 0,
        spec.placement + ' ' + shape.name,
      );
  }
  // Every platform amcp_media uploads to has at least one image placement, except DV360's creative assets.
  for (const platform of mediaPlatforms.filter(p => p !== 'dv360'))
    assert.ok(placementsFor(platform, 'image').length > 0, platform);
  assert.equal(placementsFor('dv360', 'image').length, 0, 'a DV360 creative asset has no recorded placement');
  assert.equal(placementsFor('dv360', 'image', 'ad_asset').length, 1);
});

// Table-driven: [platform, file, target?] → the placements that fit, the issues of the others, the suggested preset.
const cases: {
  name: string;
  platform: string;
  file: PlannedFile;
  target?: string;
  fits: string[];
  issues: Record<string, string[]>;
  preset?: string;
}[] = [
  {
    name: 'a 1080 × 1080 image fits Meta feed but not Stories and Reels',
    platform: 'meta',
    file: image(1080, 1080),
    fits: ['Feed'],
    issues: {'Stories and Reels': ['aspect_ratio']},
  },
  {
    name: 'a 1080 × 1920 image fits Snapchat Single Image',
    platform: 'snapchat',
    file: image(1080, 1920),
    fits: ['Single Image'],
    issues: {},
  },
  {
    name: 'a 3:2 image fits no Snapchat placement and the vertical preset is suggested',
    platform: 'snapchat',
    file: image(2400, 1600),
    fits: [],
    issues: {'Single Image': ['aspect_ratio']},
    preset: 'vertical',
  },
  {
    name: 'a small 9:16 image has the right shape but too few pixels for Snapchat',
    platform: 'snapchat',
    file: image(540, 960),
    fits: [],
    issues: {'Single Image': ['min_resolution']},
    preset: 'vertical',
  },
  {
    name: 'a 6 MB image is over Snapchat’s stated image size',
    platform: 'snapchat',
    file: image(1080, 1920, 6_000_000),
    fits: [],
    issues: {'Single Image': ['max_bytes']},
  },
  {
    name: 'a 2-second 9:16 video is shorter than Snapchat’s minimum; no preset can fix a duration',
    platform: 'snapchat',
    file: video(1080, 1920, 2),
    fits: [],
    issues: {'Single Video': ['min_duration']},
  },
  {
    name: 'a 200-second video is longer than Snapchat takes',
    platform: 'snapchat',
    file: video(1080, 1920, 200),
    fits: [],
    issues: {'Single Video': ['max_duration']},
  },
  {
    name: 'a 1200 × 627 image counts as 1.91:1 within the shape tolerance',
    platform: 'google_ads',
    file: image(1200, 627),
    fits: ['Responsive display ads', 'Demand Gen'],
    issues: {},
  },
  {
    name: 'a 4:5 image fits Demand Gen but not responsive display',
    platform: 'google_ads',
    file: image(1080, 1350),
    fits: ['Demand Gen'],
    issues: {'Responsive display ads': ['aspect_ratio']},
  },
  {
    name: 'a 16:9 X video longer than 140 seconds',
    platform: 'x_ads',
    file: video(1920, 1080, 150),
    fits: [],
    issues: {'Video ads': ['max_duration']},
  },
  {
    name: 'a 90-second 9:16 Meta video is narrower than the feed range and longer than Stories; Reels takes it',
    platform: 'meta',
    file: video(1080, 1920, 90),
    fits: ['Reels'],
    issues: {Feed: ['aspect_ratio'], Stories: ['max_duration']},
  },
  {
    name: 'a TikTok 16:9 video at 1280 × 720 fits in-feed',
    platform: 'tiktok',
    file: video(1280, 720, 30),
    fits: ['In-feed video'],
    issues: {},
  },
  {
    name: 'a LinkedIn image over 5 MB',
    platform: 'linkedin',
    file: image(1200, 1200, 6_000_000),
    fits: [],
    issues: {'Single image ads': ['max_bytes']},
  },
  {
    name: 'a 3:1 DV360 Demand Gen ad asset fits nothing; of the presets that fit, square is nearest its shape',
    platform: 'dv360',
    target: 'ad_asset',
    file: image(1500, 500),
    fits: [],
    issues: {'Demand Gen image asset': ['aspect_ratio']},
    preset: 'square',
  },
];
for (const c of cases)
  test('placement preflight: ' + c.name, () => {
    const check = placementPreflight(c.platform, c.file, c.target ? {target: c.target} : {});
    assert.ok(check, 'a recorded platform returns a check');
    assert.equal(check.advisory, true);
    assert.equal(check.spec_version, MEDIA_SPEC_VERSION);
    assert.equal(check.verified_against_source, false);
    assert.deepEqual(
      check.placements.filter(p => p.fits).map(p => p.placement),
      c.fits,
    );
    assert.deepEqual(
      Object.fromEntries(check.placements.filter(p => !p.fits).map(p => [p.placement, p.issues.map(i => i.check)])),
      c.issues,
    );
    assert.equal(check.fits_any, c.fits.length > 0);
    assert.equal(check.suggested_preset, c.preset);
    if (c.preset) assert.ok(Object.hasOwn(variantPresets, c.preset));
  });

test('unknown facts are reported as not checked, never as a fit failure', () => {
  const [spec] = placementsFor('snapchat', 'video');
  const result = checkPlacement(spec!, {kind: 'video', width: null, height: null, duration: null, size: null});
  assert.equal(result.fits, true);
  assert.deepEqual(result.unchecked, ['geometry', 'duration', 'size']);
});

test('issues carry the actual and expected values the website words', () => {
  const check = placementPreflight('snapchat', image(2400, 1600, 6_000_000))!,
    [single] = check.placements;
  assert.deepEqual(single!.issues, [
    {check: 'aspect_ratio', actual: '3:2', expected: '9:16'},
    {check: 'max_bytes', actual: 6_000_000, expected: 5_000_000},
  ]);
  assert.match(check.meaning, /Advisory/);
  assert.equal(placementPreflight('dv360', image(1000, 1000)), undefined, 'no recorded placement, no check');
});

test('the table is labelled stale once its review interval passes', () => {
  const recorded = Date.parse(MEDIA_SPEC_VERSION + 'T00:00:00Z');
  assert.equal(mediaSpecsStale(recorded + 86400000), false);
  assert.equal(mediaSpecsStale(recorded + (MEDIA_SPEC_REVIEW_DAYS + 1) * 86400000), true);
  assert.equal(
    placementPreflight('meta', image(1080, 1080), {now: recorded + 400 * 86400000})!.stale,
    true,
    'stale figures are labelled, not trusted',
  );
});

// The plan itself: every ready destination carries its check, and a file that fits no recorded placement is still
// ready (advisory only). Runs where FFmpeg is configured, as the other media plan tests do.
const key = Buffer.alloc(32, 61).toString('base64'),
  operator: Actor = {tenantId: 't', userId: 'u', role: 'operator'},
  admin: Actor = {...operator, role: 'admin'};
async function ffmpegOrSkip(t: TestContext) {
  try {
    await runMediaProcess(ffmpegPath(), ['-version']);
    await runMediaProcess(process.env.AMCP_FFPROBE_PATH ?? 'ffprobe', ['-version']);
    return true;
  } catch (e) {
    if (process.env.AMCP_REQUIRE_FFMPEG === 'true') throw e;
    t.skip('FFmpeg is required in release CI and Docker; this local host has no configured FFmpeg.');
    return false;
  }
}
async function syntheticPng(width: number, height: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-spec-test-')),
    file = path.join(dir, 'out.png');
  try {
    await runMediaProcess(
      ffmpegPath(),
      ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:duration=1`, '-frames:v', '1', file],
      60000,
    );
    return await fs.readFile(file);
  } finally {
    await removeTestDirectoryAsync(dir, 'amcp-spec-test-');
  }
}
test('amcp_media plan attaches the advisory placement check and keeps every destination ready', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const store = new Store(':memory:', key),
    calls: string[] = [];
  try {
    for (const [platform, gateway] of [
      ['meta', 'meta_native_action'],
      ['snapchat', 'snapchat_native_action'],
      ['dv360', 'dv360_native_action'],
    ] as const)
      store.putConnection(
        admin,
        {
          id: platform,
          tenantId: 't',
          gateway,
          accounts: ['101'],
          writeAccounts: ['101'],
          label: 'Synthetic',
          enabled: true,
          scopes: [],
        },
        {accessToken: 'synthetic'},
      );
    const transport = new NativeTransport((async (input: string | URL | Request) => {
      calls.push(String(input));
      throw Error('plan must not call a provider');
    }) as typeof fetch);
    const service = new MirrorService(new Registry(), store, transport, undefined, {
        allowWrites: true,
        requireBeforeState: true,
        maxBudgetChange: 0,
      }),
      sources = service.mediaSources(),
      bytes = await syntheticPng(1200, 800),
      started = sources.begin(operator, {filename: 'wide.png', size: bytes.length, type: ''});
    for (let index = 0; index < started.chunks; index++)
      sources.put(
        operator,
        started.source_id,
        index,
        bytes.subarray(index * SOURCE_CHUNK_BYTES, (index + 1) * SOURCE_CHUNK_BYTES),
      );
    const source = await sources.complete(operator, started.source_id);
    const plan = await service.call(
      'amcp_media',
      {
        action: 'plan',
        source_id: source.source_id,
        destinations: [
          {platform: 'meta', account_id: '101', connection_id: 'meta'},
          {platform: 'snapchat', account_id: '101', connection_id: 'snapchat'},
          {platform: 'dv360', account_id: '101', connection_id: 'dv360'},
        ],
      },
      operator,
    );
    assert.equal(plan.success, true, JSON.stringify(plan));
    const [meta, snapchat, dv360] = plan.data.destinations as JsonObject[];
    // A 3:2 image: Meta's feed range takes it, Stories and Reels do not; Snapchat takes 9:16 only.
    assert.equal(meta!.ready, true);
    assert.deepEqual(
      meta!.placement_check.placements.map((p: JsonObject) => [p.placement, p.fits]),
      [
        ['Feed', true],
        ['Stories and Reels', false],
      ],
    );
    assert.equal(snapchat!.ready, true, 'advisory only: a file no recorded placement takes is still ready');
    assert.equal(snapchat!.placement_check.fits_any, false);
    assert.equal(snapchat!.placement_check.suggested_preset, 'vertical');
    assert.equal(snapchat!.placement_check.placements[0].issues[0].check, 'aspect_ratio');
    // A DV360 creative asset has no recorded placement: no check rather than an invented one.
    assert.equal(dv360!.ready, true);
    assert.equal(dv360!.placement_check, undefined);
    assert.deepEqual(calls, [], 'the preflight reads no provider');
  } finally {
    store.close();
  }
});
