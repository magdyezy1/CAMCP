import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {ffmpegPath} from './media-variants.js';

/**
 * The runtime toolchain a deployment reports beside its packaged identity (QA-01): the Node version, the first FFmpeg
 * version line and the OS release. Every value is validated by a strict pattern and is otherwise reported as
 * `unavailable`; no free text, path or environment value can pass through.
 */
export interface RuntimeToolchain {
  node: string;
  ffmpeg: string;
  os: {id: string; version_id: string} | 'unavailable';
}
const nodePattern = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** The first `-version` line of each FFmpeg program, which prints its own name first. */
const versionPatterns = {
  ffmpeg: /^ffmpeg version [A-Za-z0-9][A-Za-z0-9._+~-]{0,79}(?: Copyright \(c\) \d{4}-\d{4} the FFmpeg developers)?$/,
  ffprobe: /^ffprobe version [A-Za-z0-9][A-Za-z0-9._+~-]{0,79}(?: Copyright \(c\) \d{4}-\d{4} the FFmpeg developers)?$/,
};
export type MediaProgram = keyof typeof versionPatterns;
const osValuePattern = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** The validated Node version, or `unavailable`. */
export function nodeVersion(value: unknown = process.version): string {
  return typeof value === 'string' && nodePattern.test(value) ? value : 'unavailable';
}
/**
 * The first line of `ffmpeg -version`, or of the named program's (`ffprobe -version`), when it matches that program's
 * strict pattern, or `unavailable`. Matched as ffmpeg's, every ffprobe line was unavailable, so full qualification
 * reported ffprobe missing wherever it was installed.
 */
export function ffmpegVersionLine(output: unknown, program: MediaProgram = 'ffmpeg'): string {
  if (typeof output !== 'string' || output.length > 64 * 1024) return 'unavailable';
  const line = output.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return Object.hasOwn(versionPatterns, program) && versionPatterns[program].test(line) ? line : 'unavailable';
}
/** ID and VERSION_ID from /etc/os-release text when both are bounded tokens, or `unavailable`. */
export function osRelease(text: unknown): RuntimeToolchain['os'] {
  if (typeof text !== 'string' || text.length > 16 * 1024) return 'unavailable';
  const field = (name: string) => {
    const match = new RegExp('^' + name + '=(?:"([^"\\n]*)"|([^\\s"]*))$', 'm').exec(text);
    const value = match?.[1] ?? match?.[2];
    return value !== undefined && osValuePattern.test(value) ? value : undefined;
  };
  const id = field('ID'),
    version = field('VERSION_ID');
  return id && version ? {id, version_id: version} : 'unavailable';
}
function readOsRelease(file = '/etc/os-release'): RuntimeToolchain['os'] {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > 16 * 1024) return 'unavailable';
    return osRelease(fs.readFileSync(file, 'utf8'));
  } catch {
    return 'unavailable';
  }
}

export interface MediaProcessorProbe {
  status: 'available' | 'unavailable';
  version: string;
}
/**
 * Runs `ffmpeg -version` (or `program`'s, such as ffprobe's) once, asynchronously, with a deadline. The result never
 * includes the binary path, stderr or any other output than the validated first version line.
 */
export function probeMediaProcessor({
  command = ffmpegPath(),
  args = ['-version'],
  timeoutMs = 5000,
  program = 'ffmpeg',
}: {command?: string; args?: string[]; timeoutMs?: number; program?: MediaProgram} = {}): Promise<MediaProcessorProbe> {
  return new Promise(resolve => {
    let output = '',
      settled = false,
      child: ReturnType<typeof spawn> | undefined;
    const done = (version: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({status: version === 'unavailable' ? 'unavailable' : 'available', version});
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {}
      done('unavailable');
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawn(command, args, {shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (output.length < 64 * 1024) output += chunk;
      });
      child.once('error', () => done('unavailable'));
      child.once('close', code => done(code === 0 ? ffmpegVersionLine(output, program) : 'unavailable'));
    } catch {
      done('unavailable');
    }
  });
}

let mediaProbe: Promise<MediaProcessorProbe> | undefined, mediaResult: MediaProcessorProbe | undefined;
/** Starts the cached startup probe (idempotent). The HTTP server calls it once at startup without awaiting it. */
export function startMediaProcessorProbe(
  options?: Parameters<typeof probeMediaProcessor>[0],
): Promise<MediaProcessorProbe> {
  mediaProbe ??= probeMediaProcessor(options).then(result => (mediaResult = result));
  return mediaProbe;
}
/** The cached media-processor state for health: `not_checked` until the startup probe has finished. */
export function mediaProcessorStatus(): 'available' | 'unavailable' | 'not_checked' {
  return mediaResult?.status ?? 'not_checked';
}
/** Test hook: forget the cached probe. */
export function resetMediaProcessorProbe(): void {
  mediaProbe = undefined;
  mediaResult = undefined;
}
/** The validated runtime toolchain; the FFmpeg line comes from the cached startup probe. */
export async function runtimeToolchain({
  osReleaseFile,
  probe = startMediaProcessorProbe,
}: {osReleaseFile?: string; probe?: () => Promise<MediaProcessorProbe>} = {}): Promise<RuntimeToolchain> {
  let ffmpeg = 'unavailable';
  try {
    ffmpeg = ffmpegVersionLine((await probe()).version);
  } catch {}
  return {node: nodeVersion(), ffmpeg, os: readOsRelease(osReleaseFile)};
}
