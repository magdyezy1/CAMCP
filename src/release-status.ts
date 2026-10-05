import fs from 'node:fs';
import path from 'node:path';
import {identityRecord, type ReleaseIdentity} from './release-identity.js';
import {Worker} from 'node:worker_threads';

export interface ReleaseStatus {
  schema_version: 1;
  status: 'matches_build' | 'payload_mismatch' | 'unavailable';
  observed_at: string | null;
  build: ReleaseIdentity | null;
  runtime: ReleaseIdentity | null;
  code?: 'RELEASE_IDENTITY_UNAVAILABLE';
}

const maxRecordBytes = 8192;
export function readBuildRecord(root: string): ReleaseIdentity | null {
  let fd: number | undefined;
  try {
    root = path.resolve(root);
    for (const location of [root, path.join(root, 'dist')]) {
      const info = fs.lstatSync(location);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
    }
    const file = path.join(root, 'dist', 'release-identity.json'),
      before = fs.lstatSync(file);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxRecordBytes) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs
    )
      return null;
    const buffer = Buffer.allocUnsafe(maxRecordBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (!count) break;
      total += count;
    }
    const after = fs.fstatSync(fd);
    if (
      total > maxRecordBytes ||
      total !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      return null;
    return identityRecord(JSON.parse(buffer.subarray(0, total).toString('utf8')));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function verifyPackagedRuntime(
  root: string,
  {
    timeoutMs = 10000,
    workerUrl = new URL('./release-identity-worker.js', import.meta.url),
  }: {timeoutMs?: number; workerUrl?: URL} = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw Error('INVALID_IDENTITY_DEADLINE');
  return new Promise<ReleaseIdentity | null>(resolve => {
    let worker: Worker | undefined,
      finished = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: ReleaseIdentity | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (worker)
        void worker.terminate().then(
          () => resolve(value),
          () => resolve(null),
        );
      else resolve(null);
    };
    try {
      worker = new Worker(workerUrl, {
        workerData: {root},
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: {maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4},
      });
      worker.stdout.resume();
      worker.stderr.resume();
      worker.once('message', value => {
        const record = identityRecord(value);
        finish(record?.source_revision === null ? record : null);
      });
      worker.once('error', () => finish(null));
      worker.once('exit', () => finish(null));
      timer = setTimeout(() => finish(null), timeoutMs);
    } catch {
      finish(null);
    }
  });
}
export function createReleaseStatus({
  root = process.cwd(),
  clock = Date.now,
  intervalMs = 10000,
}: {root?: string; clock?: () => number; intervalMs?: number} = {}): () => Promise<ReleaseStatus> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 300000)
    throw Error('INVALID_IDENTITY_INTERVAL');
  let last: {at: number; body: ReleaseStatus} | undefined, pending: Promise<ReleaseStatus> | undefined;
  const unavailable = (at: string | null): ReleaseStatus => ({
    schema_version: 1,
    status: 'unavailable',
    observed_at: at,
    build: null,
    runtime: null,
    code: 'RELEASE_IDENTITY_UNAVAILABLE',
  });
  return async () => {
    let now: number, at: string;
    try {
      now = clock();
      if (!Number.isFinite(now)) throw Error();
      at = new Date(now).toISOString();
    } catch {
      return unavailable(null);
    }
    if (last && now >= last.at && now - last.at < intervalMs) return structuredClone(last.body);
    if (pending) return structuredClone(await pending);
    const refresh = async (): Promise<ReleaseStatus> => {
      try {
        const build = readBuildRecord(root);
        if (!build) return unavailable(at);
        const runtime = await verifyPackagedRuntime(root);
        if (!runtime) return unavailable(at);
        const same =
          build.sha256 === runtime.sha256 &&
          build.files === runtime.files &&
          build.bytes === runtime.bytes &&
          build.components.every((component, index) => {
            const observed = runtime.components[index];
            return (
              component.name === observed?.name &&
              component.files === observed.files &&
              component.bytes === observed.bytes &&
              component.sha256 === observed.sha256
            );
          });
        return {
          schema_version: 1,
          status: same ? 'matches_build' : 'payload_mismatch',
          observed_at: at,
          build,
          runtime,
        };
      } catch {
        return unavailable(at);
      }
    };
    const current = (pending = refresh());
    try {
      const body = await current;
      last = {at: now, body};
      return structuredClone(body);
    } finally {
      if (pending === current) pending = undefined;
    }
  };
}
