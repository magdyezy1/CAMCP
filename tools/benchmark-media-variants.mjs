import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createMediaVariant,
  ffmpegPath,
  ffprobeJson,
  runMediaProcess,
  seenGeometry,
  variantCopiesStreams,
  VIDEO_CONVERSION_TIMEOUT_MS,
} from '../dist/src/media-variants.js';
import {fitMediaToPlatform} from '../dist/src/media-fit.js';
import {MAX_MEDIA_BYTES, mediaType} from '../dist/src/drive-media.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

/**
 * Video variant timing (MED-04): how long the longest video AMCP converts (180 seconds) takes to become each preset
 * variant, with the configured FFmpeg (AMCP_FFMPEG_PATH and AMCP_FFPROBE_PATH) and the production conversion settings
 * (libx264 veryfast, CRF 23, two threads). The source is synthetic: FFmpeg's own moving test pattern with temporal
 * noise (so the encoder works about as hard as on camera footage) and a tone, 1920 × 1080 at 30 frames per second,
 * H.264 and AAC at about 4.6 Mbit/s, so a 180-second source fits the 128 MiB media limit like a real upload must.
 * No account, provider or deployed resource is involved, and the temporary directory is removed afterwards.
 *
 * The bound: every run finishes within half of VIDEO_CONVERSION_TIMEOUT_MS, so a deployed host about half as fast as
 * the measuring one still converts within the limit.
 */
export const mediaVariantBounds = {timeout_ms: VIDEO_CONVERSION_TIMEOUT_MS, headroom: 2};
/**
 * The variants timed: the largest outputs (landscape, vertical) and two crops. A landscape variant of an H.264/AAC
 * 1080p source copies its streams (no conversion); the other four re-encode.
 */
export const benchmarkVariants = [
  ['landscape', 'contain'],
  ['vertical', 'crop'],
  ['vertical', 'contain'],
  ['portrait', 'contain'],
  ['square', 'crop'],
];
/** The source sizes measured: 1080p (the acceptance case) and 2160p, which fit scales down to 1920 × 1080. */
export const benchmarkSources = {'1080p': [1920, 1080], '2160p': [3840, 2160]};
const sourceFile = (directory, seconds, source) => path.join(directory, 'source-' + source + '-' + seconds + 's.mp4');
/** A synthetic H.264/AAC MP4 of `seconds` seconds (1 to 180) at `source` size, made by the configured FFmpeg. */
export async function syntheticVideo(seconds, directory, source = '1080p') {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 180 || !Object.hasOwn(benchmarkSources, source))
    throw Error('Invalid bounded synthetic workload');
  const [width, height] = benchmarkSources[source],
    file = sourceFile(directory, seconds, source);
  await runMediaProcess(
    ffmpegPath(),
    [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:rate=30:duration=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-vf',
      'noise=alls=12:allf=t+u',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-b:v',
      '4500k',
      '-maxrate',
      '5500k',
      '-bufsize',
      '11000k',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-shortest',
      file,
    ],
    // Generating the source is not what is measured; give it room on a slow host.
    seconds * (width > 1920 ? 16000 : 4000) + 60000,
  );
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_MEDIA_BYTES) throw Error('The synthetic source exceeds the media limit');
  return bytes;
}
export async function runMediaVariantBenchmark({
  seconds = 180,
  variants = benchmarkVariants,
  source: size = '1080p',
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-media-variant-benchmark-'));
  try {
    const generated = performance.now(),
      source = await syntheticVideo(seconds, directory, size),
      generation_ms = Math.round(performance.now() - generated),
      [width, height] = benchmarkSources[size],
      type = mediaType(source),
      metadata = await ffprobeJson(sourceFile(directory, seconds, size), type),
      video = metadata.streams.find(s => s.codec_type === 'video'),
      seen = seenGeometry(source, type, video),
      runs = [];
    for (const [preset, fit] of variants) {
      const started = performance.now(),
        variant = await createMediaVariant(source, preset, fit),
        duration_ms = Math.round(performance.now() - started);
      runs.push({
        preset,
        fit,
        output: variant.width + '×' + variant.height,
        output_bytes: variant.bytes.length,
        // Streams copied without re-encoding: a source already at the preset's size as H.264 and AAC.
        copied: variantCopiesStreams(type, metadata, video, seen, preset),
        duration_ms,
        // The conversion's share of its limit: under 1 / headroom passes.
        share_of_timeout: +(duration_ms / VIDEO_CONVERSION_TIMEOUT_MS).toFixed(3),
      });
    }
    // A 1080p MP4 already within AMCP's 1080 × 1920 delivery size is passed on unchanged by fit (no conversion); a
    // 2160p one is scaled to 1920 × 1080 under the same time limit.
    const fitStarted = performance.now(),
      fitted = await fitMediaToPlatform(source, {imageBytes: 0, mp4Only: true}),
      fit_ms = Math.round(performance.now() - fitStarted);
    return {
      seconds,
      source: {width, height, bytes: source.length, generation_ms},
      runs,
      fit: {
        converted: fitted.transform !== null,
        output: fitted.width + '×' + fitted.height,
        duration_ms: fit_ms,
        share_of_timeout: +(fit_ms / VIDEO_CONVERSION_TIMEOUT_MS).toFixed(3),
      },
    };
  } finally {
    removeTestDirectory(directory, 'amcp-media-variant-benchmark-');
  }
}
/** Problems against the bound; empty when every conversion finishes within 1/headroom of its time limit. */
export function mediaVariantProblems(result, bounds = mediaVariantBounds) {
  const slow = ms => ms * bounds.headroom > bounds.timeout_ms,
    limit = `more than 1/${bounds.headroom} of the ${bounds.timeout_ms} ms limit`;
  return [
    ...result.runs
      .filter(run => slow(run.duration_ms))
      .map(run => `${result.seconds}-second ${run.preset} ${run.fit} variant took ${run.duration_ms} ms, ${limit}`),
    ...(result.fit?.converted && slow(result.fit.duration_ms)
      ? [`${result.seconds}-second fit took ${result.fit.duration_ms} ms, ${limit}`]
      : []),
  ];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    check = args.includes('--check'),
    secondsArg = args.find(a => a.startsWith('--seconds=')),
    sourceArg = args.find(a => a.startsWith('--source=')),
    seconds = secondsArg ? Number(secondsArg.slice('--seconds='.length)) : 180,
    source = sourceArg ? sourceArg.slice('--source='.length) : '1080p';
  if (args.some(a => a !== '--check' && a !== secondsArg && a !== sourceArg))
    throw Error('Usage: node tools/benchmark-media-variants.mjs [--check] [--seconds=1..180] [--source=1080p|2160p]');
  const ffmpegVersion = (await runMediaProcess(ffmpegPath(), ['-version'])).split('\n')[0].trim(),
    result = await runMediaVariantBenchmark({seconds, source}),
    problems = mediaVariantProblems(result);
  console.log(
    JSON.stringify(
      {
        benchmark: 'media-video-variants',
        created_at: new Date().toISOString(),
        synthetic: true,
        ffmpeg: ffmpegVersion,
        host: {platform: process.platform, cpus: os.cpus().length, cpu: os.cpus()[0]?.model},
        bounds: mediaVariantBounds,
        ...result,
        problems,
        qualification:
          'One synthetic 1080p H.264/AAC source converted with the production settings on this host only. No deployed container, provider or account; a deployed host must be measured with the same command before relying on its headroom.',
      },
      null,
      2,
    ),
  );
  if (check && problems.length) process.exitCode = 1;
}
