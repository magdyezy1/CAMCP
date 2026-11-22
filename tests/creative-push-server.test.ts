// MED-03 (review 2026-10-08): fitted outputs are cached across calls, plans list receipts that already hold the exact
// file, and a push runs on the server. Before this, a website push planned each file and then prepared every row, so a
// video sent to N accounts was converted about N+1 times (plus once more per saved-plan preflight), `plan` reported no
// existing receipts, and the rows ran only while the page stayed open.
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
import {ffmpegPath, runMediaProcess} from '../src/media-variants.js';
import {fitMediaToPlatform, effectiveFitLimits} from '../src/media-fit.js';
import {cacheFit, cachedFit, fitCacheId, FIT_PIPELINE_VERSION} from '../src/media-fit-cache.js';
import {sha256} from '../src/security.js';
import type {Actor, JsonObject} from '../src/types.js';
import {removeTestDirectoryAsync} from './temp.js';

const key = Buffer.alloc(32, 53).toString('base64'),
  operator: Actor = {tenantId: 't', userId: 'u', role: 'operator'},
  admin: Actor = {...operator, role: 'admin'};

/** Every FFmpeg conversion this process starts (spawn capture): the ffmpeg binary with an input file. */
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
/** A synthetic picture or one-second video made by FFmpeg. */
async function synthetic(kind: 'png' | 'mp4', width: number, height: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amcp-push-test-')),
    file = path.join(dir, 'out.' + kind);
  try {
    await runMediaProcess(
      ffmpegPath(),
      kind === 'png'
        ? ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:duration=1`, '-frames:v', '1', file]
        : [
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            `testsrc2=size=${width}x${height}:rate=25:duration=1`,
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-pix_fmt',
            'yuv420p',
            file,
          ],
      60000,
    );
    return await fs.readFile(file);
  } finally {
    await removeTestDirectoryAsync(dir, 'amcp-push-test-');
  }
}
async function upload(sources: MediaSources, actor: Actor, bytes: Buffer, filename: string) {
  const started = sources.begin(actor, {filename, size: bytes.length, type: ''});
  for (let index = 0; index < started.chunks; index++)
    sources.put(
      actor,
      started.source_id,
      index,
      bytes.subarray(index * SOURCE_CHUNK_BYTES, (index + 1) * SOURCE_CHUNK_BYTES),
    );
  return sources.complete(actor, started.source_id);
}
const platforms: Record<string, [string, string[]]> = {
  meta: ['meta_native_action', ['101', '102', '103', '104']],
  tiktok: ['tiktok_native_action', ['201', '202']],
  snapchat: ['snapchat_native_action', ['301', '302']],
  x_ads: ['x_ads_native_action', ['401', '402']],
};
/** A service with write access to the accounts above; Meta answers account reads, image uploads and image lookups. */
function fixture() {
  const store = new Store(':memory:', key),
    calls: {method: string; path: string}[] = [];
  for (const [platform, [gateway, accounts]] of Object.entries(platforms))
    store.putConnection(
      admin,
      {
        id: platform,
        tenantId: 't',
        gateway,
        accounts,
        writeAccounts: accounts,
        label: 'Synthetic',
        enabled: true,
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
  const available = new Set<string>();
  let uploads = 0;
  const transport = new NativeTransport((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    calls.push({method, path: url.pathname});
    if (method === 'GET' && url.pathname.endsWith('/adimages'))
      return Response.json({
        data: [...available]
          .filter(h => String(url.searchParams.get('hashes') ?? '').includes(h))
          .map(hash => ({hash})),
      });
    if (method === 'GET' && /\/act_\d+$/.test(url.pathname))
      return Response.json({id: url.pathname.split('/').pop(), account_status: 1, currency: 'USD'});
    if (method === 'POST' && url.pathname.endsWith('/adimages')) {
      const hash = 'synthetic_hash_' + ++uploads;
      available.add(hash);
      return Response.json({images: {one: {hash}}});
    }
    throw Error('Unexpected provider request ' + method + ' ' + url.pathname);
  }) as typeof fetch);
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const media = async (input: JsonObject, actor = operator) => service.call('amcp_media', input, actor);
  return {store, service, calls, available, uploads: () => uploads, media, sources: service.mediaSources()};
}
const destinations = () =>
  Object.entries(platforms).flatMap(([platform, [, accounts]]) =>
    accounts.map(account_id => ({platform, account_id, connection_id: platform})),
  );
const fitRows = (store: Store) =>
  store.db.prepare("SELECT id, expires_at FROM media_staging WHERE id LIKE 'fit-%'").all() as {
    id: string;
    expires_at: number;
  }[];

test('a 10-destination video push converts once per limit group and its reviews reuse the planned copy', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const f = fixture();
  try {
    const video = await synthetic('mp4', 2560, 1440),
      source = await upload(f.sources, operator, video, 'launch.mp4');
    spawned.length = 0;
    const plan = await f.media({
      action: 'plan',
      source_id: source.source_id,
      fit_to_platform: true,
      stage_fits: true,
      destinations: destinations(),
    });
    assert.equal(plan.success, true, JSON.stringify(plan));
    const rows = plan.data.destinations as JsonObject[];
    assert.equal(rows.length, 10);
    assert.ok(rows.every(r => r.ready === true && r.fit_staged === true));
    // Meta, TikTok, Snapchat and X differ only in image limits and MP4-only (an MP4 source needs no container
    // change), so this MP4 is one limit group: one conversion where there were eleven (ten rows and the plan).
    assert.equal(new Set(rows.map(r => r.file.sha256)).size, 1);
    assert.equal(rows[0]!.file.width, 1920);
    assert.equal(rows[0]!.file.height, 1080);
    assert.equal(conversions().length, 1, 'FFmpeg converted the video once for the whole push');
    assert.equal(fitRows(f.store).length, 1, 'one encrypted fitted copy is staged');
    assert.equal(f.calls.length, 0, 'plan calls no provider');
    // Every review of the push uses the planned copy, bound by expected_sha256: no further conversion.
    for (const account_id of platforms.meta![1]) {
      const prepared = await f.media({
        action: 'prepare',
        platform: 'meta',
        account_id,
        connection_id: 'meta',
        source_id: source.source_id,
        fit_to_platform: true,
        expected_sha256: rows[0]!.file.sha256,
      });
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      assert.equal(prepared.data.request.sha256, rows[0]!.file.sha256);
      assert.match(prepared.data.request.transform.reasons.join(' '), /Scaled down from 2560 × 1440 to 1920 × 1080/);
      assert.equal((await f.media({action: 'cancel', review_id: prepared.data.review_id})).success, true);
    }
    assert.equal(conversions().length, 1, 'the reviews converted nothing again');
    // The copy is bound to this FFmpeg build and pipeline version, and lapses no later than its original.
    const [row] = fitRows(f.store);
    assert.ok(row!.expires_at <= Date.parse(String(source.expires_at)));
    assert.match(row!.id, new RegExp('^fit-' + source.source_id + '-[0-9a-f]{16}$'));
  } finally {
    f.store.close();
  }
});

test('images convert once per image-limit group; MCP plans stage nothing unless asked', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const f = fixture();
  try {
    const source = await upload(f.sources, operator, await synthetic('png', 2400, 1600), 'banner.png');
    spawned.length = 0;
    const unstaged = await f.media({
      action: 'plan',
      source_id: source.source_id,
      fit_to_platform: true,
      destinations: destinations(),
    });
    assert.equal(unstaged.success, true, JSON.stringify(unstaged));
    assert.equal(fitRows(f.store).length, 0, 'a plan without stage_fits keeps nothing');
    assert.ok((unstaged.data.destinations as JsonObject[]).every(r => r.fit_staged === undefined));
    // Meta takes 30 MiB images, TikTok, Snapchat and X 5 MiB: two limit groups, two PNG encodes.
    assert.equal(conversions().length, 2);
    spawned.length = 0;
    const staged = await f.media({
      action: 'plan',
      source_id: source.source_id,
      fit_to_platform: true,
      stage_fits: true,
      destinations: destinations(),
    });
    assert.equal(conversions().length, 2);
    assert.equal(fitRows(f.store).length, 2);
    spawned.length = 0;
    const again = await f.media({
      action: 'plan',
      source_id: source.source_id,
      fit_to_platform: true,
      destinations: destinations(),
    });
    assert.equal(conversions().length, 0, 'a later plan of the same original uses the cached copies');
    assert.deepEqual(
      (again.data.destinations as JsonObject[]).map(r => r.file.sha256),
      (staged.data.destinations as JsonObject[]).map(r => r.file.sha256),
    );
    // stage_fits belongs to plan; prepare refuses it rather than ignoring it.
    const refused = await f.media({
      action: 'prepare',
      platform: 'meta',
      account_id: '101',
      source_id: source.source_id,
      stage_fits: true,
    });
    assert.equal(refused.error.code, 'INVALID_ARGUMENT');
    assert.equal(refused.error.details.parameter, 'stage_fits');
    const wrongType = await f.media({action: 'plan', source_id: source.source_id, stage_fits: 'yes'});
    assert.equal(wrongType.error.code, 'INVALID_ARGUMENT');
  } finally {
    f.store.close();
  }
});

test('cached copies vanish with their original: at its deadline, on removal, and when an upload needs the room', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const f = fixture();
  try {
    const bytes = await synthetic('png', 2400, 1600),
      first = await upload(f.sources, operator, bytes, 'first.png'),
      second = await upload(f.sources, operator, bytes, 'second.png'),
      plan = (source: JsonObject) =>
        f.media({
          action: 'plan',
          source_id: source.source_id,
          fit_to_platform: true,
          stage_fits: true,
          destinations: [{platform: 'meta', account_id: '101', connection_id: 'meta'}],
        });
    await plan(first);
    await plan(second);
    assert.equal(fitRows(f.store).length, 2);
    // The original's deadline passes: its copy is unusable at once and erased by the next cleanup.
    f.store.db.prepare('UPDATE media_staging SET expires_at=? WHERE id=?').run(Date.now() - 1, first.source_id);
    const limits = effectiveFitLimits({kind: 'image', mime: 'image/png'}, {imageBytes: 30 * 1048576, mp4Only: false});
    f.store.cleanupTransient();
    assert.deepEqual(
      fitRows(f.store).map(r => r.id.slice(4, 44)),
      [second.source_id],
    );
    assert.equal(
      await cachedFit(f.store, 't', {id: String(first.source_id), sha256: String(first.sha256)}, limits),
      undefined,
    );
    // Removing an original removes the copies made from it.
    assert.equal((await f.media({action: 'remove_source', source_id: second.source_id})).success, true);
    assert.equal(fitRows(f.store).length, 0);
    // A copy gives way to an original that needs the room: copies count against the original-file quota (25 files
    // per workspace), and the copy, which can always be computed again, goes first.
    const third = await upload(f.sources, operator, bytes, 'third.png');
    await plan(third);
    assert.equal(fitRows(f.store).length, 1);
    const small = () => {
      const id = 'src-' + crypto.randomUUID();
      f.store.reserveMediaSource('t', id, Date.now() + 60000);
      f.store.stageMedia('t', id, Buffer.alloc(1024, 7));
    };
    for (let i = 0; i < 23; i++) small();
    assert.equal(fitRows(f.store).length, 1, 'the quota is full only with the copy counted');
    small();
    assert.equal(fitRows(f.store).length, 0, 'the copy was evicted instead of refusing the upload');
    assert.throws(small, {code: 'MEDIA_STAGING_FULL'});
    // A plan with a full quota still works; it only keeps no copy.
    const full = await f.media({
      action: 'plan',
      source_id: third.source_id,
      fit_to_platform: true,
      stage_fits: true,
      destinations: [{platform: 'meta', account_id: '101', connection_id: 'meta'}],
    });
    assert.equal(full.success, true, JSON.stringify(full));
    assert.equal(full.data.destinations[0].ready, true);
    assert.equal(full.data.destinations[0].fit_staged, undefined);
    assert.equal(fitRows(f.store).length, 0);
  } finally {
    f.store.close();
  }
});

test('a cached copy is bound to its exact original, limits and encoder, and is checked byte for byte', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const f = fixture();
  try {
    const bytes = await synthetic('png', 2400, 1600),
      source = await upload(f.sources, operator, bytes, 'bound.png'),
      original = {id: String(source.source_id), sha256: String(source.sha256)},
      limits = {imageBytes: 30 * 1048576, mp4Only: false},
      fitted = await fitMediaToPlatform(bytes, limits);
    assert.ok(fitted.transform);
    assert.equal(await cacheFit(f.store, 't', original, limits, fitted, Date.now() + 600000), true);
    assert.equal(sha256((await cachedFit(f.store, 't', original, limits))!.bytes), sha256(fitted.bytes));
    // Another original hash, other limits or another encoder version name another copy.
    assert.equal(await cachedFit(f.store, 't', {...original, sha256: 'f'.repeat(64)}, limits), undefined);
    assert.equal(await cachedFit(f.store, 't', original, {...limits, imageBytes: 5 * 1048576}), undefined);
    assert.notEqual(
      fitCacheId(original, limits, FIT_PIPELINE_VERSION + '|ffmpeg version a'),
      fitCacheId(original, limits, FIT_PIPELINE_VERSION + '|ffmpeg version b'),
    );
    // A copy whose bytes no longer match its record is never used.
    const [row] = fitRows(f.store);
    f.store.stageMedia('t', row!.id, Buffer.concat([fitted.bytes, Buffer.from([0])]));
    assert.equal(await cachedFit(f.store, 't', original, limits), undefined);
    // An unchanged output (nothing to fit) and a copy that would outlive nothing are not cached.
    assert.equal(
      await cacheFit(f.store, 't', original, limits, {...fitted, transform: null}, Date.now() + 600000),
      false,
    );
    assert.equal(await cacheFit(f.store, 't', original, limits, fitted, Date.now() + 500), false);
  } finally {
    f.store.close();
  }
});

test('real FFmpeg fits the same video and image to identical bytes, which expected_sha256 relies on', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const video = await synthetic('mp4', 2560, 1440),
    image = await synthetic('png', 2400, 1600),
    limits = {imageBytes: 5 * 1048576, mp4Only: true};
  const [a, b] = [await fitMediaToPlatform(video, limits), await fitMediaToPlatform(video, limits)];
  assert.ok(a.transform);
  assert.equal(sha256(a.bytes), sha256(b.bytes), 'libx264 output is deterministic for one build');
  const [c, d] = [await fitMediaToPlatform(image, limits), await fitMediaToPlatform(image, limits)];
  assert.equal(sha256(c.bytes), sha256(d.bytes));
});

test('plan lists receipts holding the exact file; reuse uploads nothing after a fresh check, and a failed check refuses', async t => {
  if (!(await ffmpegOrSkip(t))) return;
  const f = fixture();
  try {
    const source = await upload(f.sources, operator, await synthetic('png', 640, 480), 'logo.png'),
      target = {platform: 'meta', account_id: '101', connection_id: 'meta'},
      planned = async () =>
        (
          await f.media({
            action: 'plan',
            source_id: source.source_id,
            fit_to_platform: true,
            destinations: [target, {...target, account_id: '102'}],
          })
        ).data.destinations as JsonObject[];
    const before = await planned();
    assert.deepEqual(
      before.map(r => r.existing_receipts),
      [[], []],
    );
    const prepared = await f.media({
      action: 'prepare',
      ...target,
      source_id: source.source_id,
      fit_to_platform: true,
      expected_sha256: before[0]!.file.sha256,
    });
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    const executed = await f.service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: prepared.data.review_id,
        idempotency_key: prepared.data.review_id,
        confirmed: true,
      },
      operator,
    );
    assert.equal(executed.success, true, JSON.stringify(executed));
    assert.equal(f.uploads(), 1);
    // The receipt is listed for the account that holds the file, and only there.
    const after = await planned();
    assert.equal(after[0]!.existing_receipts.length, 1);
    assert.equal(after[0]!.existing_receipts[0].media_id, 'synthetic_hash_1');
    assert.equal(after[0]!.existing_receipts[0].sha256, before[0]!.file.sha256);
    assert.deepEqual(after[1]!.existing_receipts, []);
    const reuse = () =>
      f.media({
        action: 'prepare',
        ...target,
        source_id: source.source_id,
        fit_to_platform: true,
        expected_sha256: before[0]!.file.sha256,
        reuse_existing: true,
      });
    const reused = await reuse();
    assert.equal(reused.success, true, JSON.stringify(reused));
    assert.equal(reused.data.reused, true);
    assert.equal(reused.data.executed, false);
    assert.equal(reused.data.availability_source, 'provider');
    assert.equal(f.uploads(), 1, 'reuse uploads nothing');
    assert.ok(
      f.calls.some(c => c.method === 'GET' && c.path.endsWith('/adimages')),
      'after a fresh provider check',
    );
    // The image is gone at Meta: the fresh check fails and nothing is reused or uploaded.
    f.available.clear();
    const refused = await reuse();
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'MEDIA_NOT_AVAILABLE');
    assert.equal(f.uploads(), 1);
  } finally {
    f.store.close();
  }
});
