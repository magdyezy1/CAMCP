import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/**
 * Another program on a developer machine (antivirus, search indexer, backup tool) can hold a handle on a file or folder a
 * test made, or add a file of its own to a folder the test owns. The release gate's container step failed on both: an
 * EPERM removing a temporary junction and a foreign MIRROR.SQLITE-SHM.tmp found beside a database. So no test removes a path
 * with a bare fs call or asserts a listing it does not own (tests/temp-hygiene.test.mjs holds that, and proves each helper
 * with the held handle or the planted file):
 *  - removeTestDirectory, removeTestDirectoryAsync and removeTestPath clean up after the assertions: retried, and a path
 *    that stays is logged, never thrown, because the operating system reclaims a temporary folder either way;
 *  - removeFixture is a removal that is a step of what a test checks: retried the same way, and thrown if it stays;
 *  - ownEntries cuts a listing down to the names AMCP wrote, for an exact assertion about them.
 * The synchronous removals retry themselves instead of leaning on fs.rmSync's maxRetries: Node 24.19 ignores it in the
 * synchronous call on Windows (24.22 honours it), so a held folder was left behind after no retry at all.
 */
export interface Retry {
  /** Retries after the first try, each waiting longer than the one before: ten retries at 100 ms wait 5.5 s in all. */
  maxRetries?: number;
  retryDelay?: number;
  /** For tests/temp-hygiene.test.mjs: how long a wait lasts, the removal itself, and where a leftover is reported. */
  sleep?: (milliseconds: number) => void;
  remove?: (entry: string) => void;
  warn?: (message: string) => void;
}
export const patience = {maxRetries: 10, retryDelay: 100};
/** The errors a file operation returns while another program holds a handle: the codes fs.rm itself retries. */
const transient = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const waiting = new Int32Array(new SharedArrayBuffer(4));
const sleepFor = (milliseconds: number) => void Atomics.wait(waiting, 0, 0, milliseconds);
const present = (entry: string) => fs.lstatSync(entry, {throwIfNoEntry: false}) !== undefined;
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? '';

/** Runs `attempt` until it succeeds, the retries are used up or it fails with an error another try cannot help. */
export function retried(attempt: () => void, retry: Retry = {}) {
  const maxRetries = retry.maxRetries ?? patience.maxRetries,
    retryDelay = retry.retryDelay ?? patience.retryDelay;
  for (let tries = 0; ; tries++)
    try {
      return attempt();
    } catch (error) {
      if (tries >= maxRetries || !transient.has(codeOf(error))) throw error;
      (retry.sleep ?? sleepFor)(retryDelay * (tries + 1));
    }
}
const leftBehind = (kind: string, entry: string, error: unknown, retry: Pick<Retry, 'warn'>) =>
  (retry.warn ?? ((message: string) => process.emitWarning(message)))(
    'Left temporary test ' + kind + ' ' + entry + ' in place: ' + (error as Error).message,
  );
function cleanUp(entry: string, kind: string, retry: Retry) {
  try {
    retried(
      () => (retry.remove ?? ((target: string) => fs.rmSync(target, {recursive: true, force: true})))(entry),
      retry,
    );
  } catch (error) {
    if (present(entry)) leftBehind(kind, entry, error, retry);
  }
}
/** The directory itself when it is a direct child of the temporary folder named with `prefix`; undefined when it is gone. */
function namedDirectory(directory: string, prefix: string) {
  const root = fs.realpathSync(os.tmpdir());
  let resolved: string;
  try {
    resolved = fs.realpathSync(directory);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(prefix) || !prefix.startsWith('amcp-'))
    throw Error('Refusing to remove a path outside the named temporary test directory.');
  return resolved;
}
/** The entry itself, named through the real path of its folder so a link is removed and never followed; it must lie inside `parent`. */
function entryInside(target: string, parent: string) {
  const root = fs.realpathSync(parent);
  let folder: string;
  try {
    folder = fs.realpathSync(path.dirname(path.resolve(target)));
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined;
    throw error;
  }
  const entry = path.join(folder, path.basename(target));
  if (!entry.startsWith(root + path.sep)) throw Error('Refusing to remove a path outside the folder it was made in.');
  return entry;
}

/** Cleanup of a temporary folder a test made directly in the OS temporary folder, named with `prefix` (which starts with amcp-). */
export function removeTestDirectory(directory: string, prefix: string, retry: Retry = {}) {
  const resolved = namedDirectory(directory, prefix);
  if (resolved !== undefined) cleanUp(resolved, 'directory', retry);
}
/** The same for a test that waits: the retries wait on timers, so the event loop stays free. */
export async function removeTestDirectoryAsync(
  directory: string,
  prefix: string,
  retry: Pick<Retry, 'warn'> & {remove?: (entry: string) => Promise<void>} = {},
) {
  const resolved = namedDirectory(directory, prefix);
  if (resolved === undefined) return;
  try {
    await (retry.remove ?? ((entry: string) => fs.promises.rm(entry, {recursive: true, force: true, ...patience})))(
      resolved,
    );
  } catch (error) {
    if (present(resolved)) leftBehind('directory', resolved, error, retry);
  }
}
/**
 * Cleanup of any file, folder or link inside `inside` (the OS temporary folder unless the test made its folder elsewhere,
 * as some do under .runtime). A link is removed and never followed.
 */
export function removeTestPath(target: string, retry: Retry & {inside?: string} = {}) {
  const entry = entryInside(target, retry.inside ?? os.tmpdir());
  if (entry !== undefined) cleanUp(entry, 'path', retry);
}
/** A removal that is a step of what the test checks: retried like a cleanup, but a failure that stays is the test's own. */
export function removeFixture(target: string, retry: Retry & {recursive?: boolean} = {}) {
  retried(
    () => (retry.remove ?? ((entry: string) => fs.rmSync(entry, {recursive: retry.recursive ?? false})))(target),
    retry,
  );
}
/** The entries of `directory` that `isOwn` accepts, sorted: AMCP's own names, whatever another program has added beside them. */
export function ownEntries(directory: string, isOwn: RegExp | ((name: string) => boolean)) {
  const own = typeof isOwn === 'function' ? isOwn : (name: string) => isOwn.test(name);
  return fs.readdirSync(directory).filter(own).sort();
}
