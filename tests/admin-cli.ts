import {execFile, spawnSync, type ExecFileOptions, type SpawnSyncOptions} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

/**
 * The admin CLI as tests run it (dist/tools/admin.js, what `npm run admin` runs). Railway's Docker build runs
 * `npm run check` as root, and in production the CLI refuses root unless --allow-root is given (OPS-03), so a test that
 * spawned it bare could only reach that refusal there (cb338f68 fixed one such test). Every test spawns it through these
 * helpers, which always pass --allow-root: the test reaches the behaviour it checks whoever runs it. The script path is
 * not exported, so a test cannot spawn it bare either; tests/root-independent-cli.test.mjs fails when a test names the
 * CLI any other way.
 */
const adminCli = fileURLToPath(new URL('../tools/admin.js', import.meta.url));
/** The node arguments that run the CLI with `args`; node options (an --import hook) go before the script. */
export function adminArgs(args: string[], nodeOptions: string[] = []): string[] {
  return [...nodeOptions, adminCli, '--allow-root', ...args];
}
/** Runs the CLI synchronously with text output; `nodeOptions` go to node itself. */
export function runAdmin(args: string[], options: SpawnSyncOptions = {}, nodeOptions: string[] = []) {
  return spawnSync(process.execPath, adminArgs(args, nodeOptions), {...options, encoding: 'utf8'});
}
const execFileText = promisify(execFile);
/** Runs the CLI asynchronously; resolves with its output and rejects on a non-zero exit (the error carries stderr). */
export function execAdmin(args: string[], options: ExecFileOptions = {}) {
  return execFileText(process.execPath, adminArgs(args), {...options, encoding: 'utf8'});
}
