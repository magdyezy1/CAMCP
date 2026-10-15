// MED-04 A (review 2026-10-08): one picture, one displayed size. Upload inspection and fit read a JPEG's EXIF
// orientation themselves (FFmpeg 5.1, the production build, ignores it; later builds apply it), but eligibility took
// rotation only from stream side data and variants built their scale/pad filter without the orientation filter or
// -noautorotate. A phone photo stored 2700 × 2160 with orientation 6 was recorded and fitted as 2160 × 2700, judged
// 2700 × 2160 by eligibility, and its portrait variant came out sideways (on 5.1) as a PNG many times its size. These
// tests guard the shared `seenGeometry` helper and each step that uses it, with real FFmpeg and EXIF fixtures 1/3/6/8.
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {SOURCE_CHUNK_BYTES, type MediaSources} from '../src/media-sources.js';
import {
  createMediaVariant,
  ffmpegPath,
  runMediaProcess,
  seenGeometry,
  VIDEO_CONVERSION_TIMEOUT_MS,
} from '../src/media-variants.js';
import {fitMediaToPlatform} from '../src/media-fit.js';
import {mediaType} from '../src/drive-media.js';
import {jpegOrientation} from '../src/image-header.js';
import type {Actor, JsonObject} from '../src/types.js';

const key = Buffer.alloc(32, 41).toString('base64'),
  operator: Actor = {tenantId: 't', userId: 'u', role: 'operator'};

/** Every FFmpeg command this process starts (spawn capture). */
const spawned: string[][] = [];
{
  const cp = childProcess as unknown as {spawn: (...args: unknown[]) => unknown},
    original = cp.spawn;
  cp.spawn = (command: unknown, args: unknown, ...rest: unknown[]) => {
    spawned.push([String(command), ...((args as string[]) ?? [])]);
    return original(command, args, ...rest);
  };
  syncBuiltinESMExports();
}
const conversions = () => spawned.filter(([command, ...args]) => command === ffmpegPath() && args.includes('-i'));

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

/**
 * The EXIF fixture: a JPEG with one APP1 segment right after SOI whose big-endian ("MM") TIFF IFD0 holds only
 * Orientation (tag 0x0112, one SHORT), as a phone camera states it.
 */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.concat([
      Buffer.from('4d4d002a00000008' + '0001' + '011200030000000100', 'hex'),
      Buffer.from([orientation]),
      Buffer.from('000000000000', 'hex'),
    ]),
    payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]),
    length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, payload, jpeg.subarray(2)]);
}
/**
 * A photo stored 1800 × 1200 whose left half is red and right half blue, so its turn can be read from its pixels:
 * orientation 6 shows red on top, 8 blue on top, 3 blue on the left, 1 red on the left.
 */
async function storedPhoto() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-orientation-')),
    file = path.join(dir, 'stored.jpg');
  try {
    await runMediaProcess(
      ffmpegPath(),
      [
        ...['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=900x1200'],
        ...['-f', 'lavfi', '-i', 'color=c=blue:size=900x1200'],
        ...['-filter_complex', 'hstack', '-frames:v', '1', '-q:v', '5', file],
      ],
      60000,
    );
    return await fs.readFile(file);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}
/** The colour at fractions (fx, fy) of a decoded picture, read with FFmpeg as raw RGB at 100 × 100 (nearest pixel). */
async function colours(bytes: Buffer, points: [number, number][]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-orientation-')),
    file = path.join(dir, 'in.' + mediaType(bytes).extension);
  try {
    await fs.writeFile(file, bytes);
    const raw = childProcess.execFileSync(
      ffmpegPath(),
      [
        ...['-v', 'error', '-noautorotate', '-i', file, '-vf', 'scale=100:100:flags=neighbor'],
        ...['-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      ],
      {maxBuffer: 1 << 20},
    );
    return points.map(([fx, fy]) => {
      const i = (Math.round(fy * 99) * 100 + Math.round(fx * 99)) * 3,
        [r, g, b] = [raw[i]!, raw[i + 1]!, raw[i + 2]!];
      if (r < 50 && g < 50 && b < 50) return 'black';
      if (r > 150 && b < 100) return 'red';
      if (b > 150 && r < 100) return 'blue';
      return `rgb(${r},${g},${b})`;
    });
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}
async function upload(sources: MediaSources, bytes: Buffer, filename: string) {
  const started = sources.begin(operator, {filename, size: bytes.length, type: ''});
  for (let index = 0; index < started.chunks; index++)
    sources.put(
      operator,
      started.source_id,
      index,
      bytes.subarray(index * SOURCE_CHUNK_BYTES, (index + 1) * SOURCE_CHUNK_BYTES),
    );
  return sources.complete(operator, started.source_id);
}
function service() {
  const store = new Store(':memory:', key),
    transport = new NativeTransport((async () => {
      throw Error('No provider request is expected.');
    }) as typeof fetch),
    svc = new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  return {store, svc, sources: svc.mediaSources()};
}
/** How each orientation is seen: its displayed size and which colour shows where. */
const expected: Record<number, {width: number; height: number; first: string; second: string}> = {
  1: {width: 1800, height: 1200, first: 'red', second: 'blue'},
  3: {width: 1800, height: 1200, first: 'blue', second: 'red'},
  6: {width: 1200, height: 1800, first: 'red', second: 'blue'},
  8: {width: 1200, height: 1800, first: 'blue', second: 'red'},
};

test('seenGeometry turns a JPEG by its EXIF orientation and a video by its rotation, for every step alike', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    type = (mime: string) =>
      ({
        mime,
        kind: mime.startsWith('video/') ? 'video' : 'image',
        extension: mime === 'video/mp4' ? 'mp4' : mime === 'image/png' ? 'png' : 'jpg',
      }) as ReturnType<typeof mediaType>;
  for (const [orientation, filter] of [
    [1, undefined],
    [3, 'hflip,vflip'],
    [6, 'transpose=1'],
    [8, 'transpose=2'],
  ] as const) {
    const head = withExifOrientation(jpeg, orientation);
    assert.equal(jpegOrientation(head), orientation);
    const seen = seenGeometry(head, type('image/jpeg'), {width: 2700, height: 2160});
    assert.deepEqual(
      [seen.width, seen.height],
      orientation >= 5 ? [2160, 2700] : [2700, 2160],
      'orientation ' + orientation,
    );
    assert.equal(seen.filter, filter);
    // An image is decoded with automatic rotation off, so the filter turns it exactly once on every FFmpeg version.
    assert.deepEqual(seen.inputOptions, ['-noautorotate']);
  }
  // A PNG has no EXIF orientation here; side data on an image never turns it (a newer ffprobe may report some).
  const png = seenGeometry(Buffer.alloc(8), type('image/png'), {
    width: 300,
    height: 200,
    side_data_list: [{rotation: -90}],
  });
  assert.deepEqual([png.width, png.height, png.filter], [300, 200, undefined]);
  // A video is turned by its rotation, which FFmpeg applies itself (no -noautorotate, no extra filter).
  const video = seenGeometry(Buffer.alloc(8), type('video/mp4'), {
    width: 1920,
    height: 1080,
    side_data_list: [{rotation: -90}],
  });
  assert.deepEqual([video.width, video.height, video.filter, video.inputOptions], [1080, 1920, undefined, []]);
  assert.equal(
    seenGeometry(Buffer.alloc(8), type('video/mp4'), {width: 1920, height: 1080, tags: {rotate: '45'}}).rotation,
    45,
  );
  // 180 s since the 2026-10-11 measurement (tests/media-variant-timing.test.mjs): 120 s left under twice the time a
  // 180-second 1080p landscape variant took.
  assert.equal(VIDEO_CONVERSION_TIMEOUT_MS, 180000);
});

test('orientation 1/3/6/8 photos have one displayed size in record, eligibility, fit and variant, turned alike', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const stored = await storedPhoto(),
    {svc, sources} = service();
  for (const orientation of [1, 3, 6, 8]) {
    const bytes = withExifOrientation(stored, orientation),
      want = expected[orientation]!,
      portrait = want.height > want.width,
      // The two halves: left/right of a landscape picture, top/bottom of a portrait one.
      halves: [number, number][] = portrait
        ? [
            [0.5, 0.3],
            [0.5, 0.7],
          ]
        : [
            [0.3, 0.5],
            [0.7, 0.5],
          ],
      label = 'orientation ' + orientation;
    // Record: the upload's inspection and its preview frame.
    const record = (await upload(sources, bytes, 'phone-' + orientation + '.jpg')) as JsonObject;
    assert.deepEqual([record.width, record.height], [want.width, want.height], label + ' record');
    assert.deepEqual(
      await colours(sources.thumbnail(operator, record.source_id), halves),
      [want.first, want.second],
      label + ' preview frame',
    );
    // Eligibility: judged as seen.
    const eligibility = await svc.call(
      'amcp_media',
      {action: 'inspect_eligibility', source_id: record.source_id, preset: 'portrait'},
      operator,
    );
    assert.equal(eligibility.success, true, JSON.stringify(eligibility.error));
    assert.deepEqual(
      [eligibility.data.width, eligibility.data.height],
      [want.width, want.height],
      label + ' eligibility',
    );
    // Fit: scaled within 1080 × 1920 as seen, its pixels turned once.
    const fitted = await fitMediaToPlatform(bytes, {imageBytes: 30 * 1048576, mp4Only: false});
    assert.deepEqual(
      [fitted.transform?.from.width, fitted.transform?.from.height],
      [want.width, want.height],
      label + ' fit source',
    );
    assert.deepEqual([fitted.width, fitted.height], portrait ? [1080, 1620] : [1620, 1080], label + ' fit output');
    assert.deepEqual(await colours(fitted.bytes, halves), [want.first, want.second], label + ' fit pixels');
    // Variant: the same source size, the same turn, then contained with black padding; a JPEG stays JPEG.
    spawned.length = 0;
    const variant = await createMediaVariant(bytes, 'square', 'contain');
    assert.deepEqual([variant.source_width, variant.source_height], [want.width, want.height], label + ' variant');
    assert.equal(variant.mime, 'image/jpeg', label + ' variant stays JPEG');
    assert.deepEqual([variant.width, variant.height], [1080, 1080]);
    const command = conversions().at(-1)!;
    assert.ok(command.includes('-noautorotate'), label + ': automatic rotation is off, on every FFmpeg version');
    const filter = command[command.indexOf('-vf') + 1]!;
    assert.equal(filter.startsWith('transpose=1,'), orientation === 6, label + ' ' + filter);
    assert.equal(filter.startsWith('transpose=2,'), orientation === 8, label + ' ' + filter);
    assert.equal(filter.startsWith('hflip,vflip,'), orientation === 3, label + ' ' + filter);
    const padding: [number, number][] = portrait
      ? [
          [0.03, 0.5],
          [0.97, 0.5],
        ]
      : [
          [0.5, 0.03],
          [0.5, 0.97],
        ];
    assert.deepEqual(
      await colours(variant.bytes, [...halves, ...padding]),
      [want.first, want.second, 'black', 'black'],
      label + ' variant pixels',
    );
  }
});

test('a PNG variant stays PNG and a video variant is turned by FFmpeg itself', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-orientation-'));
  try {
    const png = path.join(dir, 'in.png'),
      mp4 = path.join(dir, 'in.mp4');
    await runMediaProcess(ffmpegPath(), [
      ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:duration=1'],
      ...['-frames:v', '1', png],
    ]);
    await runMediaProcess(
      ffmpegPath(),
      [
        ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=1'],
        ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', mp4],
      ],
      60000,
    );
    const image = await createMediaVariant(await fs.readFile(png), 'portrait', 'crop');
    assert.equal(image.mime, 'image/png');
    assert.deepEqual([image.width, image.height, image.source_width, image.source_height], [1080, 1350, 640, 360]);
    spawned.length = 0;
    const video = await createMediaVariant(await fs.readFile(mp4), 'vertical', 'contain');
    assert.equal(video.mime, 'video/mp4');
    assert.deepEqual([video.width, video.height], [1080, 1920]);
    // A video is turned by FFmpeg's own rotation handling: no -noautorotate and no orientation filter.
    const command = conversions().at(-1)!;
    assert.equal(command.includes('-noautorotate'), false);
    assert.match(command[command.indexOf('-vf') + 1]!, /^scale=1080:1920:/);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});
