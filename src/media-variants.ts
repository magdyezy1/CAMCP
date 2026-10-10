import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {MirrorError} from './errors.js';
import {expiredWebsiteUpload, mediaProcessingDeadline} from './media-retention.js';
import {mediaType, MAX_MEDIA_BYTES} from './drive-media.js';
import {jpegOrientation, orientationFilter} from './image-header.js';
export const variantPresets: Record<string, [number, number]> = {
  square: [1080, 1080],
  portrait: [1080, 1350],
  vertical: [1080, 1920],
  landscape: [1920, 1080],
};
let active = 0;
/**
 * The command that runs FFmpeg or ffprobe (MED-02): directly by default; on Linux, when AMCP_MEDIA_PROCESS_MEMORY_MB
 * (64–16384) is set, under `prlimit --as` (util-linux; AMCP_PRLIMIT_PATH overrides the name), so a media child process
 * cannot grow its address space past that limit and fails like any conversion instead of exhausting the container. Not
 * set, set to another value, or on another platform, the binary runs directly as before.
 */
export function mediaProcessCommand(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): [string, string[]] {
  const raw = env.AMCP_MEDIA_PROCESS_MEMORY_MB,
    mb = Number(raw);
  if (raw === undefined || platform !== 'linux' || !Number.isSafeInteger(mb) || mb < 64 || mb > 16384)
    return [binary, args];
  return [env.AMCP_PRLIMIT_PATH || 'prlimit', ['--as=' + mb * 1048576, '--', binary, ...args]];
}
export async function runMediaProcess(binary: string, args: string[], timeout = 45000): Promise<string> {
  const deadline = mediaProcessingDeadline(),
    remaining = deadline === undefined ? undefined : deadline - Date.now(),
    expiresFirst = remaining !== undefined && remaining <= timeout;
  if (remaining !== undefined && remaining <= 0) throw expiredWebsiteUpload();
  return new Promise((resolve, reject) => {
    let output = '',
      finished = false,
      terminalError: Error | undefined;
    const [command, argv] = mediaProcessCommand(binary, args),
      child = spawn(command, argv, {shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    const done = (e?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (e) reject(e);
      else resolve(output);
    };
    const stop = (error: Error) => {
      if (terminalError || finished) return;
      terminalError = error;
      child.kill('SIGKILL');
      // Settle only after close: temporary files must outlive the processor's open handles.
    };
    const timer = setTimeout(
      () =>
        stop(
          expiresFirst
            ? expiredWebsiteUpload()
            : new MirrorError('MEDIA_CONVERSION_TIMEOUT', 'Media conversion exceeded its time limit.'),
        ),
      remaining === undefined ? timeout : Math.min(timeout, remaining),
    );
    child.stdout.on('data', b => {
      if (terminalError) return;
      output += b.toString();
      if (output.length > 1024 * 1024) {
        stop(new MirrorError('MEDIA_CONVERSION_FAILED', 'Media metadata exceeded its limit.'));
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      terminalError ??= new MirrorError(
        'MEDIA_PROCESSOR_UNAVAILABLE',
        'Install FFmpeg and ffprobe, or configure AMCP_FFMPEG_PATH and AMCP_FFPROBE_PATH.',
      );
    });
    child.on('close', code =>
      done(
        terminalError ??
          (code === 0
            ? undefined
            : new MirrorError('MEDIA_CONVERSION_FAILED', 'The media could not be decoded or converted.')),
      ),
    );
  });
}
export type MediaFileType = ReturnType<typeof mediaType>;
/** How long one video conversion (fit or variant) may run, always within a website upload's deadline (MED-04). */
export const VIDEO_CONVERSION_TIMEOUT_MS = 120000;
/** How a picture is seen, and how to decode it that way. */
export interface SeenGeometry {
  /** A JPEG's EXIF orientation (1 to 8), read from its own header; 1 for anything else. */
  orientation: number;
  /** A video's rotation in degrees (stream side data or tag); 0 for an image. */
  rotation: number;
  /** The size as the picture is seen: the stored size turned by the orientation or rotation. */
  width: number;
  height: number;
  /** The filter that turns an image's pixels the way its EXIF orientation states (undefined when upright). */
  filter: string | undefined;
  /** Input options: an image is decoded with automatic rotation off, so `filter` turns it exactly once. */
  inputOptions: string[];
}
/**
 * How a picture is seen (MED-04): its stored size turned by a JPEG's EXIF orientation, which AMCP reads from the file's
 * own header because FFmpeg 5.1 (the production image) ignores it while later builds apply it, or by a video's
 * rotation, which every FFmpeg version applies. Upload inspection, eligibility, fit and variants all use this one
 * helper, so a phone photo stored 2700 × 2160 with orientation 6 is 2160 × 2700 everywhere and every output is turned
 * the same way on every FFmpeg version. `head` is the start of the file (the EXIF segment precedes the image data).
 */
export function seenGeometry(
  head: Buffer,
  type: MediaFileType,
  video: {width: number; height: number; side_data_list?: {rotation?: unknown}[]; tags?: {rotate?: unknown}},
): SeenGeometry {
  const orientation = type.mime === 'image/jpeg' ? jpegOrientation(head) : 1,
    rotation =
      type.kind === 'video'
        ? Number(video.side_data_list?.find(s => s?.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0)
        : 0,
    swapped = orientation >= 5 || Math.abs(rotation) % 180 === 90;
  return {
    orientation,
    rotation,
    width: swapped ? video.height : video.width,
    height: swapped ? video.width : video.height,
    filter: orientationFilter(orientation),
    inputOptions: type.kind === 'image' ? ['-noautorotate'] : [],
  };
}
/** Refuses a video turned by anything but a multiple of 90 degrees, which a bounded conversion does not straighten. */
export function assertRightAngle(seen: SeenGeometry) {
  if (seen.rotation % 90)
    throw new MirrorError('MEDIA_ROTATION_UNSUPPORTED', 'Normalize this media’s rotation before upload.');
}
export const ffmpegPath = () => process.env.AMCP_FFMPEG_PATH ?? 'ffmpeg';
export const ffprobePath = () => process.env.AMCP_FFPROBE_PATH ?? 'ffprobe';
/**
 * Input options that confine FFmpeg and ffprobe to the one local file: a fixed demuxer, local protocols only, no
 * external references from a QuickTime file, and bounded allocations.
 */
export function inputGuard(type: MediaFileType): string[] {
  const demuxer = type.kind === 'video' ? 'mov' : type.extension === 'png' ? 'png_pipe' : 'jpeg_pipe';
  return [
    '-max_alloc',
    '134217728',
    '-protocol_whitelist',
    'file,pipe',
    '-f',
    demuxer,
    ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
  ];
}
/** ffprobe's streams and format for a local media file, read with the input guard. */
export async function ffprobeJson(file: string, type: MediaFileType): Promise<any> {
  return JSON.parse(
    await runMediaProcess(
      ffprobePath(),
      ['-v', 'error', ...inputGuard(type), '-show_streams', '-show_format', '-of', 'json', file],
      15000,
    ),
  );
}
/**
 * Runs `fn` in a private temporary directory within the two media processes AMCP runs at once, and removes the
 * directory afterwards.
 */
export async function withMediaDirectory<T>(busy: string, fn: (directory: string) => Promise<T>): Promise<T> {
  // Transient contention, before any claim: retryable, so a queued upload and the push loop try again (MED-02).
  if (active >= 2) throw new MirrorError('MEDIA_PROCESSOR_BUSY', busy, {retry_after_ms: 2000}, 429, true);
  active++;
  let directory: string | undefined;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-variant-'));
    return await fn(directory);
  } finally {
    active--;
    if (directory) {
      const root = path.resolve(os.tmpdir());
      if (path.dirname(path.resolve(directory)) !== root || !path.basename(directory).startsWith('amcp-variant-'))
        throw Error('Invalid media temporary directory');
      await fs.rm(directory, {recursive: true, force: true});
    }
  }
}
/** withMediaDirectory with the media written to `input.<extension>` in it. */
export async function withMediaFile<T>(
  bytes: Buffer,
  busy: string,
  fn: (input: string, directory: string, type: MediaFileType) => Promise<T>,
): Promise<T> {
  if (bytes.length > MAX_MEDIA_BYTES) throw new MirrorError('MEDIA_PROCESSOR_BUSY', busy);
  return withMediaDirectory(busy, async directory => {
    const type = mediaType(bytes),
      input = path.join(directory, 'input.' + type.extension);
    await fs.writeFile(input, bytes, {mode: 0o600});
    return fn(input, directory, type);
  });
}
/** Geometry checks against the user's chosen preset; this is not provider policy approval. */
export async function inspectMediaPlacement(bytes: Buffer, preset: string) {
  if (!Object.hasOwn(variantPresets, preset))
    throw new MirrorError('INVALID_VARIANT', 'Choose square, portrait, vertical or landscape.');
  return withMediaFile(bytes, 'Media inspection is currently at capacity.', async (input, _directory, type) => {
    const data = await ffprobeJson(input, type);
    const streams = data.streams?.filter((s: any) => s.codec_type === 'video'),
      video = streams?.[0];
    if (streams?.length !== 1 || !video.width || !video.height || video.width * video.height > 40000000)
      throw new MirrorError(
        'MEDIA_DIMENSIONS_UNSUPPORTED',
        'Use one decodable image/video stream of at most 40 megapixels.',
      );
    // Judged as the media is seen: a JPEG's EXIF orientation counts here as in upload, fit and variants (MED-04).
    const seen = seenGeometry(bytes, type, video);
    assertRightAngle(seen);
    const {width, height} = seen,
      duration = type.kind === 'video' ? Number(data.format?.duration ?? video.duration) : null;
    if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > 180))
      throw new MirrorError(
        'MEDIA_DIMENSIONS_UNSUPPORTED',
        'This bounded inspection supports videos up to 180 seconds.',
      );
    const [targetWidth, targetHeight] = variantPresets[preset]!,
      checks = [
        {
          name: 'aspect_ratio',
          passed: Math.abs(width / height - targetWidth / targetHeight) < 0.005,
          actual: width + ':' + height,
          target: targetWidth + ':' + targetHeight,
        },
        {
          name: 'minimum_resolution',
          passed: width >= targetWidth && height >= targetHeight,
          actual: width + '×' + height,
          target: targetWidth + '×' + targetHeight,
        },
        ...(type.kind === 'video'
          ? [
              {
                name: 'widely_supported_video_codec',
                passed: video.codec_name === 'h264',
                actual: video.codec_name,
                target: 'h264',
              },
            ]
          : []),
      ];
    return {
      width,
      height,
      duration,
      codec: video.codec_name,
      preset,
      checks,
      eligible_for_preset: checks.every(c => c.passed),
      provider_approved: false,
      meaning:
        'AMCP geometry and codec checks only. Provider placement, policy and account acceptance are verified separately.',
      ...(!checks.every(c => c.passed)
        ? {next_step: 'Create a reviewed variant for this preset or supply a higher-resolution source.'}
        : {}),
    };
  });
}
/** The source's single video stream and duration, refusing what a bounded conversion does not take. */
export function convertibleStream(metadata: any, type: MediaFileType) {
  const videos = metadata.streams?.filter((s: any) => s.codec_type === 'video'),
    video = videos?.[0],
    duration = Number(metadata.format?.duration ?? video?.duration);
  // ffprobe versions differ on malformed images: some exit nonzero, others return a zero-sized stream.
  if (
    !videos?.length ||
    !Number.isInteger(video.width) ||
    !Number.isInteger(video.height) ||
    video.width < 1 ||
    video.height < 1
  )
    throw new MirrorError('MEDIA_CONVERSION_FAILED', 'The media could not be decoded or converted.');
  if (
    videos.length !== 1 ||
    video.width * video.height > 40000000 ||
    (type.kind === 'video' && (!Number.isFinite(duration) || duration <= 0 || duration > 180))
  )
    throw new MirrorError(
      'MEDIA_DIMENSIONS_UNSUPPORTED',
      'Use one video/image stream, at most 40 megapixels and 180 seconds.',
    );
  return {video, duration};
}
/** H.264 with AAC audio in an MP4 that starts playing before it has fully downloaded. */
export const videoEncoding = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '23',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-movflags',
  '+faststart',
  '-t',
  '180',
];
/**
 * Runs one bounded FFmpeg conversion of `input` (its first video stream and, for video, its first audio stream), with
 * a filter unless the streams are copied.
 */
export async function convertMedia(
  input: string,
  type: MediaFileType,
  output: string,
  options: {filter?: string; encoding: string[]; inputOptions?: string[]; timeout?: number; videoOnly?: boolean},
) {
  await runMediaProcess(
    ffmpegPath(),
    [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-threads',
      '2',
      ...(options.inputOptions ?? []),
      ...inputGuard(type),
      '-i',
      input,
      '-map',
      '0:v:0',
      ...(type.kind === 'video' && !options.videoOnly ? ['-map', '0:a:0?'] : []),
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      ...(options.filter ? ['-filter_threads', '1', '-vf', options.filter] : []),
      ...options.encoding,
      '-threads',
      '2',
      '-fs',
      String(MAX_MEDIA_BYTES + 1),
      output,
    ],
    options.timeout,
  );
}
/** A still image saved as JPEG: FFmpeg's best quality step (2), the same encoder settings a fit starts with. */
const jpegEncoding = ['-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '2', '-pix_fmt', 'yuvj420p', '-f', 'image2'];
/**
 * A preset-sized copy of the media (MED-04): turned the way it is seen (a JPEG's EXIF orientation applied once, with
 * automatic rotation off, as fit and upload inspection do), then contained with black padding or center-cropped. A JPEG
 * stays JPEG, so a photo variant is not a PNG many times its size; a PNG stays PNG and a video becomes H.264 MP4 within
 * the fit's time limit, bounded by a website upload's deadline.
 */
export async function createMediaVariant(bytes: Buffer, preset: string, fit = 'contain') {
  if (!Object.hasOwn(variantPresets, preset) || !['contain', 'crop'].includes(fit))
    throw new MirrorError('INVALID_VARIANT', 'Choose square, portrait, vertical or landscape, with contain or crop.');
  const [width, height] = variantPresets[preset]!;
  return withMediaFile(
    bytes,
    'At most two bounded media conversions may run concurrently.',
    async (input, directory, type) => {
      const jpeg = type.mime === 'image/jpeg',
        output = path.join(directory, type.kind === 'image' ? (jpeg ? 'output.jpg' : 'output.png') : 'output.mp4');
      const {video, duration} = convertibleStream(await ffprobeJson(input, type), type),
        seen = seenGeometry(bytes, type, video);
      assertRightAngle(seen);
      const filter = [
        seen.filter,
        fit === 'crop'
          ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`
          : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
      ]
        .filter(Boolean)
        .join(',');
      await convertMedia(input, type, output, {
        filter,
        inputOptions: seen.inputOptions,
        encoding: type.kind === 'image' ? (jpeg ? jpegEncoding : ['-frames:v', '1', '-c:v', 'png']) : videoEncoding,
        ...(type.kind === 'video' ? {timeout: VIDEO_CONVERSION_TIMEOUT_MS} : {}),
      });
      const stat = await fs.stat(output);
      if (stat.size > MAX_MEDIA_BYTES || !stat.size)
        throw new MirrorError(
          'MEDIA_TOO_LARGE',
          'Converted media exceeds the configured media limit (128 MiB by default). Use a shorter or smaller source.',
        );
      const converted = await fs.readFile(output);
      const check = await ffprobeJson(output, mediaType(converted)),
        outVideo = check.streams?.find((s: any) => s.codec_type === 'video');
      if (
        outVideo?.width !== width ||
        outVideo?.height !== height ||
        (type.kind === 'video' &&
          (!Number.isFinite(Number(check.format?.duration)) ||
            Math.abs(Number(check.format?.duration) - duration) > 0.5))
      )
        throw new MirrorError(
          'MEDIA_CONVERSION_INCOMPLETE',
          'Converted output is incomplete or has unexpected dimensions.',
        );
      return {
        bytes: converted,
        ...mediaType(converted),
        width,
        height,
        preset,
        fit,
        // The source as it is seen, like the upload's record and its eligibility (MED-04).
        source_width: seen.width,
        source_height: seen.height,
        duration: type.kind === 'video' ? duration : null,
        review_note:
          fit === 'crop'
            ? 'Center crop may remove important content. Inspect the preview before upload.'
            : 'Contains the full frame with black padding. Check placement requirements before upload.',
      };
    },
  );
}
