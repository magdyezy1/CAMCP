// MED-04 (review 2026-10-08), the open acceptance item: "a 180 s 1080p video variant completes within its bound
// (measure first)". Measured with `npm run benchmark:media-variants` (FFmpeg n9.0, i7-12700H, the production two-thread
// libx264 settings) on a synthetic 180-second 1080p H.264/AAC source:
// - 2026-10-11, a lightly loaded host: 42–64 s per variant, the landscape variant 53% of the earlier 120-second
//   VIDEO_CONVERSION_TIMEOUT_MS, so the limit was raised to 180 s;
// - 2026-10-12, the same host shared with parallel builds: 98–167 s, the vertical crop 93% of 180 s and two variants
//   beyond the earlier 120 s.
// The second run motivated cutting the work instead of raising the limit past the five-minute reservation: a crop
// scales only the region it keeps, and a variant already at the preset's size as H.264/AAC copies its streams (a third
// run, same load: landscape 2.9 s copied, others 41–148 s). These tests guard the limit against the recorded runs, the
// cheaper filters and the stream copy, and run the benchmark itself on a short clip with real FFmpeg.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VIDEO_CONVERSION_TIMEOUT_MS,
  createMediaVariant,
  runMediaProcess,
  ffmpegPath,
  ffprobePath,
  variantCopiesStreams,
  variantFilter,
} from '../dist/src/media-variants.js';
import {mediaType} from '../dist/src/drive-media.js';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {
  mediaVariantBounds,
  mediaVariantProblems,
  runMediaVariantBenchmark,
  syntheticVideo,
} from '../tools/benchmark-media-variants.mjs';

/** The 2026-10-11 run of the 180-second 1080p benchmark (docs/OPERATIONS.md records it). */
const recorded = {
  seconds: 180,
  runs: [
    {preset: 'landscape', fit: 'contain', duration_ms: 63675},
    {preset: 'vertical', fit: 'crop', duration_ms: 46490},
    {preset: 'vertical', fit: 'contain', duration_ms: 42608},
    {preset: 'portrait', fit: 'contain', duration_ms: 45851},
    {preset: 'square', fit: 'crop', duration_ms: 42406},
  ],
  fit: {converted: false, duration_ms: 220},
};
/** The 2026-10-12 run on the same host under parallel load, before the crop and copy changes. */
const loaded = {
  seconds: 180,
  runs: [
    {preset: 'landscape', fit: 'contain', duration_ms: 135582},
    {preset: 'vertical', fit: 'crop', duration_ms: 167187},
    {preset: 'vertical', fit: 'contain', duration_ms: 97637},
    {preset: 'portrait', fit: 'contain', duration_ms: 110822},
    {preset: 'square', fit: 'crop', duration_ms: 105524},
  ],
  fit: {converted: false, duration_ms: 779},
};
/** The 2026-10-12 run after the changes: the landscape variant of the H.264/AAC source copies its streams. */
const optimized = {
  seconds: 180,
  runs: [
    {preset: 'landscape', fit: 'contain', duration_ms: 2946},
    {preset: 'vertical', fit: 'crop', duration_ms: 147635},
    {preset: 'vertical', fit: 'contain', duration_ms: 103208},
    {preset: 'portrait', fit: 'contain', duration_ms: 44924},
    {preset: 'square', fit: 'crop', duration_ms: 41146},
  ],
  fit: {converted: false, duration_ms: 351},
};
const within = (result, timeout_ms) => result.runs.filter(run => run.duration_ms >= timeout_ms).map(run => run.preset);

async function ffmpegOrSkip(t) {
  try {
    await runMediaProcess(ffmpegPath(), ['-version']);
    await runMediaProcess(ffprobePath(), ['-version']);
    return true;
  } catch (e) {
    if (process.env.AMCP_REQUIRE_FFMPEG === 'true') throw e;
    t.skip('FFmpeg is required in release CI and Docker; this local host has no configured FFmpeg.');
    return false;
  }
}

test('the video conversion limit keeps twice the measured 180-second 1080p variant time (failed at 120 s)', () => {
  assert.equal(mediaVariantBounds.timeout_ms, VIDEO_CONVERSION_TIMEOUT_MS);
  assert.equal(mediaVariantBounds.headroom, 2);
  // Under the earlier 120-second limit the recorded landscape variant used more than half of it.
  assert.deepEqual(mediaVariantProblems(recorded, {timeout_ms: 120000, headroom: 2}), [
    '180-second landscape contain variant took 63675 ms, more than 1/2 of the 120000 ms limit',
  ]);
  assert.deepEqual(mediaVariantProblems(recorded), []);
  // The limit stays inside the five-minute reservation that a variant or a review holds while it is prepared, so a
  // conversion that uses all of it still ends before that reservation expires.
  assert.ok(VIDEO_CONVERSION_TIMEOUT_MS < 300000);
  // A converted fit counts against the same limit.
  assert.deepEqual(
    mediaVariantProblems(
      {seconds: 60, runs: [], fit: {converted: true, duration_ms: 95000}},
      {timeout_ms: 180000, headroom: 2},
    ),
    ['60-second fit took 95000 ms, more than 1/2 of the 180000 ms limit'],
  );
  assert.deepEqual(
    mediaVariantProblems(
      {seconds: 60, runs: [], fit: {converted: false, duration_ms: 95000}},
      {timeout_ms: 180000, headroom: 2},
    ),
    [],
  );
});

test('under parallel load the earlier 120 s limit timed two variants out; 180 s held every recorded run', () => {
  // The old limit would have refused the landscape and the vertical crop variants with MEDIA_CONVERSION_TIMEOUT.
  assert.deepEqual(within(loaded, 120000), ['landscape', 'vertical']);
  assert.deepEqual(within(loaded, VIDEO_CONVERSION_TIMEOUT_MS), []);
  assert.deepEqual(within(recorded, VIDEO_CONVERSION_TIMEOUT_MS), []);
  // The loaded run kept less than twice its time: the reason those two conversions were made cheaper.
  assert.equal(mediaVariantProblems(loaded).length, 5);
  // Afterwards every run still finishes within the limit and the copied landscape variant takes seconds; the two
  // vertical variants remain the slowest case under heavy load (docs/OPERATIONS.md, what remains).
  assert.deepEqual(within(optimized, VIDEO_CONVERSION_TIMEOUT_MS), []);
  assert.ok(optimized.runs[0].duration_ms * 20 < VIDEO_CONVERSION_TIMEOUT_MS);
  assert.deepEqual(
    mediaVariantProblems(optimized).map(problem => problem.split(' took')[0]),
    ['180-second vertical crop variant', '180-second vertical contain variant'],
  );
});

test('a crop cuts the preset-shaped center first and scales only that region; contain is unchanged', () => {
  const landscape = {width: 1920, height: 1080, filter: undefined},
    upright = {width: 1080, height: 1920, filter: undefined};
  // The slowest loaded variant scaled 1920 × 1080 up to 3413 × 1920 before cropping; now 608 × 1080 is scaled.
  assert.equal(variantFilter(landscape, 'vertical', 'crop'), 'crop=608:1080,scale=1080:1920,setsar=1');
  assert.equal(variantFilter(landscape, 'square', 'crop'), 'crop=1080:1080,scale=1080:1080,setsar=1');
  assert.equal(variantFilter(landscape, 'portrait', 'crop'), 'crop=864:1080,scale=1080:1350,setsar=1');
  assert.equal(variantFilter(upright, 'landscape', 'crop'), 'crop=1080:608,scale=1920:1080,setsar=1');
  assert.equal(variantFilter(upright, 'portrait', 'crop'), 'crop=1080:1350,scale=1080:1350,setsar=1');
  // Odd sizes crop to even dimensions within the picture.
  assert.equal(variantFilter({width: 1081, height: 1081}, 'square', 'crop'), 'crop=1080:1080,scale=1080:1080,setsar=1');
  // A JPEG's EXIF orientation is applied before the crop, which is measured on the turned picture.
  assert.equal(
    variantFilter({width: 2160, height: 2700, filter: 'transpose=1'}, 'portrait', 'crop'),
    'transpose=1,crop=2160:2700,scale=1080:1350,setsar=1',
  );
  assert.equal(
    variantFilter(landscape, 'vertical', 'contain'),
    'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1',
  );
});

test('only an upright H.264/AAC video already at the preset size is copied without re-encoding', () => {
  const video = {width: 1920, height: 1080, codec_name: 'h264', pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1'},
    metadata = {
      streams: [
        {codec_type: 'video', ...video},
        {codec_type: 'audio', codec_name: 'aac'},
      ],
    },
    mp4 = {kind: 'video', mime: 'video/mp4', extension: 'mp4'},
    copies = (overrides = {}, preset = 'landscape', streams = metadata.streams, rotation = 0, type = mp4) =>
      variantCopiesStreams(type, {streams}, {...video, ...overrides}, {rotation}, preset);
  assert.equal(copies(), true);
  assert.equal(copies({sample_aspect_ratio: undefined}), true);
  assert.equal(copies({}, 'landscape', [{codec_type: 'video', ...video}]), true);
  assert.equal(copies({}, 'square'), false);
  assert.equal(copies({codec_name: 'hevc'}), false);
  assert.equal(copies({pix_fmt: 'yuv420p10le'}), false);
  assert.equal(copies({sample_aspect_ratio: '4:3'}), false);
  assert.equal(
    copies({}, 'landscape', [
      {codec_type: 'video', ...video},
      {codec_type: 'audio', codec_name: 'mp3'},
    ]),
    false,
  );
  assert.equal(copies({width: 1080, height: 1920}, 'landscape', metadata.streams, 90), false);
  assert.equal(
    copies({}, 'landscape', metadata.streams, 0, {kind: 'image', mime: 'image/png', extension: 'png'}),
    false,
  );
});

test('the benchmark refuses workloads outside its bounds before running FFmpeg', async () => {
  await assert.rejects(syntheticVideo(0, '.'), {message: 'Invalid bounded synthetic workload'});
  await assert.rejects(syntheticVideo(181, '.'), {message: 'Invalid bounded synthetic workload'});
  await assert.rejects(syntheticVideo(5, '.', '4320p'), {message: 'Invalid bounded synthetic workload'});
});

test('the crop-first filter makes the same picture as scaling up and cropping afterwards (real FFmpeg)', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-variant-crop-'));
  try {
    const source = path.join(directory, 'source.png'),
      before = path.join(directory, 'before.png'),
      after = path.join(directory, 'after.png');
    await runMediaProcess(ffmpegPath(), [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=1',
      '-frames:v',
      '1',
      source,
    ]);
    await runMediaProcess(ffmpegPath(), [
      '-v',
      'error',
      '-i',
      source,
      '-vf',
      'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1',
      before,
    ]);
    const variant = await createMediaVariant(fs.readFileSync(source), 'vertical', 'crop');
    assert.deepEqual([variant.width, variant.height, variant.mime], [1080, 1920, 'image/png']);
    fs.writeFileSync(after, variant.bytes);
    // FFmpeg's own comparison of the two pictures: the same content at the same place differs only in resampling.
    const report = await new Promise((resolve, reject) =>
      execFile(
        ffmpegPath(),
        ['-v', 'info', '-i', before, '-i', after, '-lavfi', 'psnr', '-f', 'null', '-'],
        {timeout: 30000},
        (error, _stdout, stderr) => (error ? reject(error) : resolve(stderr)),
      ),
    );
    const psnr = Number(/average:([\d.]+|inf)/.exec(report)?.[1].replace('inf', 'Infinity'));
    assert.ok(psnr >= 30, 'PSNR ' + psnr + ' dB between the two crops');
  } finally {
    removeTestDirectory(directory, 'amcp-variant-crop-');
  }
});

test('a 1920 × 1080 H.264/AAC clip becomes a landscape variant without re-encoding; 720p is encoded', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-variant-copy-'));
  try {
    const clip = async (size, name) => {
      const file = path.join(directory, name);
      await runMediaProcess(ffmpegPath(), [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=30:duration=2`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=2',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        file,
      ]);
      return file;
    };
    const packets = async file =>
      (
        await runMediaProcess(ffmpegPath(), [
          '-v',
          'error',
          '-i',
          file,
          '-map',
          '0:v:0',
          '-c',
          'copy',
          '-f',
          'hash',
          '-hash',
          'sha256',
          '-',
        ])
      ).trim();
    const full = await clip('1920x1080', 'full.mp4'),
      copied = await createMediaVariant(fs.readFileSync(full), 'landscape', 'contain'),
      copiedFile = path.join(directory, 'copied.mp4');
    fs.writeFileSync(copiedFile, copied.bytes);
    assert.equal(mediaType(copied.bytes).mime, 'video/mp4');
    assert.deepEqual([copied.width, copied.height], [1920, 1080]);
    // The same encoded video packets: nothing was decoded or encoded again.
    assert.equal(await packets(copiedFile), await packets(full));
    const small = await clip('1280x720', 'small.mp4'),
      encoded = await createMediaVariant(fs.readFileSync(small), 'landscape', 'contain'),
      encodedFile = path.join(directory, 'encoded.mp4');
    fs.writeFileSync(encodedFile, encoded.bytes);
    assert.deepEqual([encoded.width, encoded.height], [1920, 1080]);
    assert.notEqual(await packets(encodedFile), await packets(small));
  } finally {
    removeTestDirectory(directory, 'amcp-variant-copy-');
  }
});

test('the variant benchmark converts a short synthetic 1080p clip with the configured FFmpeg', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const result = await runMediaVariantBenchmark({
    seconds: 3,
    variants: [
      ['landscape', 'contain'],
      ['vertical', 'crop'],
    ],
  });
  assert.equal(result.seconds, 3);
  assert.deepEqual([result.source.width, result.source.height], [1920, 1080]);
  assert.ok(result.source.bytes > 0);
  assert.equal(result.runs.length, 2);
  assert.deepEqual(
    result.runs.map(run => [run.output, run.copied]),
    [
      ['1920×1080', true],
      ['1080×1920', false],
    ],
  );
  for (const run of result.runs) {
    assert.ok(run.output_bytes > 0);
    assert.ok(run.duration_ms > 0);
    assert.equal(run.share_of_timeout, +(run.duration_ms / VIDEO_CONVERSION_TIMEOUT_MS).toFixed(3));
  }
  // A 1080p MP4 is already within the delivery size: fit passes it on without converting.
  assert.equal(result.fit.converted, false);
  assert.equal(result.fit.output, '1920×1080');
});
