import fs from 'node:fs/promises';
import path from 'node:path';
import {MirrorError} from './errors.js';
import {MAX_MEDIA_BYTES, mediaType} from './drive-media.js';
import {jpegOrientation, orientationFilter, pngHasAlpha} from './image-header.js';
import {
  convertibleStream,
  convertMedia,
  ffprobeJson,
  videoEncoding,
  withMediaFile,
  type MediaFileType,
} from './media-variants.js';

/**
 * The delivery size AMCP fits media to when asked (`fit_to_platform`), chosen by the owner on 2026-09-28: at most 1080
 * pixels on the short side and 1920 on the long side, so 4500 × 4500 becomes 1080 × 1080 and 4500 × 8000 becomes
 * 1080 × 1920. It is AMCP's size, not a limit any platform states; each platform's own byte limit applies as well.
 */
export const deliverySize = {short: 1080, long: 1920} as const;

/** The fit depends only on these, so platforms with the same limits share one conversion. */
export interface FitLimits {
  /** The platform's image byte limit (amcp_media prepare's own table). */
  imageBytes: number;
  /** The platform takes video only as MP4 (X and LinkedIn). */
  mp4Only: boolean;
}
/** One change the fit made; `describeFit` words it for a platform's review. */
export type FitStep =
  | {step: 'scaled'; from: [number, number]; to: [number, number]}
  | {step: 'oriented'; orientation: number}
  | {step: 'mp4'}
  | {step: 'jpeg'; limit: number}
  | {step: 're-encoded'; limit: number}
  | {step: 'quality'; quality: number; limit: number};
export interface MediaTransform {
  from: {width: number; height: number; bytes: number; mime: string};
  to: {width: number; height: number; bytes: number; mime: string};
  steps: FitStep[];
}
export interface FittedMedia extends MediaFileType {
  bytes: Buffer;
  width: number;
  height: number;
  /** What changed and why; null when the source already fits and is passed on byte for byte. */
  transform: MediaTransform | null;
}

const mib = (bytes: number) => +(bytes / 1048576).toFixed(1) + ' MiB';
/** The changes of a fit, in words, for the review of one platform. */
export function describeFit(steps: FitStep[], platform: string): string[] {
  return steps.map(s => {
    switch (s.step) {
      case 'scaled':
        return `Scaled down from ${s.from.join(' × ')} to ${s.to.join(' × ')}, within AMCP's ${deliverySize.short} × ${deliverySize.long} delivery size.`;
      case 'oriented':
        return `Turned the way its EXIF orientation (${s.orientation}) states.`;
      case 'mp4':
        return `Converted from MOV to MP4, the only video format ${platform} takes.`;
      case 'jpeg':
        return `Converted from PNG to JPEG to fit the ${mib(s.limit)} image limit of ${platform}.`;
      case 're-encoded':
        return `Re-encoded to fit the ${mib(s.limit)} image limit of ${platform}.`;
      case 'quality':
        return `Saved at JPEG quality ${s.quality} (FFmpeg's scale: 2 best, 31 lowest) to fit the ${mib(s.limit)} image limit of ${platform}.`;
    }
  });
}
const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
/** The largest size within the delivery size with the source's shape, never larger than the source; even for video. */
export function deliveryDimensions(width: number, height: number, kind: 'image' | 'video') {
  const scale = Math.min(1, deliverySize.short / Math.min(width, height), deliverySize.long / Math.max(width, height));
  return kind === 'video'
    ? {width: even(width * scale), height: even(height * scale), scaled: scale < 1}
    : {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        scaled: scale < 1,
      };
}

/**
 * Fits media to a platform the way the owner asked: scale down anything larger than the delivery size, never crop,
 * pad or enlarge; re-encode an image over the platform's byte limit; convert MOV to MP4 for a platform that takes
 * only MP4. Media that already fits comes back unchanged. The caller shows `transform` for review before any upload.
 */
export async function fitMediaToPlatform(bytes: Buffer, limits: FitLimits): Promise<FittedMedia> {
  return withMediaFile(
    bytes,
    'At most two bounded media conversions may run concurrently.',
    async (input, directory, type): Promise<FittedMedia> => {
      const metadata = await ffprobeJson(input, type),
        {video, duration} = convertibleStream(metadata, type),
        orientation = type.mime === 'image/jpeg' ? jpegOrientation(bytes) : 1,
        rotation =
          type.kind === 'video'
            ? Number(
                video.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0,
              )
            : 0;
      if (rotation % 90)
        throw new MirrorError('MEDIA_ROTATION_UNSUPPORTED', 'Normalize this media’s rotation before upload.');
      // Sizes are as the media is seen: after its EXIF orientation or video rotation.
      const swapped = orientation >= 5 || Math.abs(rotation) % 180 === 90,
        width: number = swapped ? video.height : video.width,
        height: number = swapped ? video.width : video.height,
        target = deliveryDimensions(width, height, type.kind),
        overBytes = type.kind === 'image' && bytes.length > limits.imageBytes,
        needsMp4 = type.kind === 'video' && limits.mp4Only && type.mime === 'video/quicktime';
      if (!target.scaled && !overBytes && !needsMp4) return {bytes, ...type, width, height, transform: null};
      const steps: FitStep[] = [];
      if (target.scaled) steps.push({step: 'scaled', from: [width, height], to: [target.width, target.height]});
      const done = (out: Buffer, outWidth: number, outHeight: number): FittedMedia => {
        const outType = mediaType(out);
        return {
          bytes: out,
          ...outType,
          width: outWidth,
          height: outHeight,
          transform: {
            from: {width, height, bytes: bytes.length, mime: type.mime},
            to: {width: outWidth, height: outHeight, bytes: out.length, mime: outType.mime},
            steps,
          },
        };
      };
      if (type.kind === 'video') {
        if (needsMp4) steps.push({step: 'mp4'});
        // A MOV that only needs another container is copied as it is, when its streams are already H.264 and AAC.
        const copy =
            !target.scaled &&
            video.codec_name === 'h264' &&
            video.pix_fmt === 'yuv420p' &&
            video.width % 2 === 0 &&
            video.height % 2 === 0 &&
            metadata.streams.every((s: any) => s.codec_type !== 'audio' || s.codec_name === 'aac'),
          out = path.join(directory, 'fitted.mp4');
        await convertMedia(input, type, out, {
          ...(copy ? {} : {filter: `scale=${target.width}:${target.height}:flags=lanczos,setsar=1`}),
          encoding: copy ? ['-c', 'copy', '-movflags', '+faststart', '-f', 'mp4'] : [...videoEncoding, '-f', 'mp4'],
          timeout: 120000,
        });
        const converted = await readOutput(out),
          check = convertibleStream(await ffprobeJson(out, mediaType(converted)), mediaType(converted)),
          stored = copy ? {width: video.width, height: video.height} : target;
        if (
          check.video.width !== stored.width ||
          check.video.height !== stored.height ||
          Math.abs(check.duration - duration) > 0.5
        )
          throw new MirrorError(
            'MEDIA_CONVERSION_INCOMPLETE',
            'Converted output is incomplete or has unexpected dimensions.',
          );
        return copy ? done(converted, width, height) : done(converted, target.width, target.height);
      }
      // The output carries no metadata, so an EXIF orientation is applied to the pixels instead.
      if (orientation !== 1) steps.push({step: 'oriented', orientation});
      const filter = [
          orientationFilter(orientation),
          `scale=${target.width}:${target.height}:flags=lanczos`,
          'setsar=1',
        ]
          .filter(Boolean)
          .join(','),
        limit = limits.imageBytes,
        encode = async (format: 'png' | 'jpeg', quality = 2) => {
          const out = path.join(directory, format === 'png' ? 'fitted.png' : `fitted-q${quality}.jpg`);
          await convertMedia(input, type, out, {
            filter,
            // FFmpeg 5.1 ignores EXIF orientation and later versions apply it; AMCP applies it itself, once.
            inputOptions: ['-noautorotate'],
            encoding:
              format === 'png'
                ? ['-frames:v', '1', '-c:v', 'png', '-f', 'image2']
                : ['-frames:v', '1', '-c:v', 'mjpeg', '-q:v', String(quality), '-pix_fmt', 'yuvj420p', '-f', 'image2'],
          });
          const converted = await readOutput(out),
            check = convertibleStream(await ffprobeJson(out, mediaType(converted)), mediaType(converted));
          if (check.video.width !== target.width || check.video.height !== target.height)
            throw new MirrorError(
              'MEDIA_CONVERSION_INCOMPLETE',
              'Converted output is incomplete or has unexpected dimensions.',
            );
          return converted;
        };
      if (type.mime === 'image/png') {
        const png = await encode('png');
        if (png.length <= limit) {
          if (overBytes && !target.scaled) steps.push({step: 're-encoded', limit});
          return done(png, target.width, target.height);
        }
        if (pngHasAlpha(bytes))
          throw new MirrorError(
            'MEDIA_TOO_LARGE',
            `This PNG has transparency and is still ${mib(png.length)} after fitting, above the ${mib(limit)} image limit. Flatten it or export it as JPEG.`,
            {maximum_bytes: limit, fitted_bytes: png.length},
          );
      }
      for (const quality of [2, 5, 9]) {
        const jpeg = await encode('jpeg', quality);
        if (jpeg.length > limit) continue;
        if (type.mime === 'image/png') steps.push({step: 'jpeg', limit});
        if (quality > 2) steps.push({step: 'quality', quality, limit});
        else if (type.mime === 'image/jpeg' && overBytes && !target.scaled) steps.push({step: 're-encoded', limit});
        return done(jpeg, target.width, target.height);
      }
      throw new MirrorError(
        'MEDIA_TOO_LARGE',
        `This image stays above the ${mib(limit)} image limit even after fitting.`,
        {maximum_bytes: limit},
      );
    },
  );
}
async function readOutput(file: string) {
  const stat = await fs.stat(file);
  if (!stat.size || stat.size > MAX_MEDIA_BYTES)
    throw new MirrorError(
      'MEDIA_TOO_LARGE',
      'Converted media exceeds the configured media limit (128 MiB by default). Use a shorter or smaller source.',
    );
  return fs.readFile(file);
}
