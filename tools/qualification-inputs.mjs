// Binds a qualification run to the bytes it loaded (QA-01): the packaged release identity of the compiled backend and a
// computed map of every non-dist module the runner imports. Used by the browser runner and the qualify runner.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const refused = code => Object.assign(new Error(code), {diagnosticCode: code});
const specifiers =
  /(?:\bimport\s*(?:[\w*{}\s,]+?\s*from\s*)?|\bexport\s*[\w*{}\s,]*?\s*from\s*|\bimport\s*\(\s*)['"]([^'"\n]+)['"]/g;
const sourceRoots = ['src', 'server', 'tests', 'tools', 'generated'];

/** Relative module specifiers a source file names statically (`import`, `export ... from`, literal `import()`). */
export function importSpecifiers(text) {
  return [...String(text).matchAll(specifiers)].map(match => match[1]).filter(s => s.startsWith('.'));
}

/**
 * The transitive closure of non-dist, repository-relative modules reachable from the entry files, each with its
 * SHA-256. Compiled `dist/` modules are bound by the release identity instead; packages are bound by the lockfile.
 */
export function moduleClosure(entries, root) {
  root = fs.realpathSync(root);
  const inside = file => {
    const relative = path.relative(root, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const seen = new Map(),
    queue = entries.map(entry => path.resolve(root, entry));
  while (queue.length) {
    const file = queue.shift();
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (seen.has(relative) || !inside(file) || relative.split('/')[0] === 'dist' || relative.includes('node_modules'))
      continue;
    let bytes;
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile()) throw refused('QUALIFICATION_INPUT_UNAVAILABLE');
      bytes = fs.readFileSync(file);
    } catch (error) {
      // A specifier that names no file (for example inside a comment) cannot be loaded, so it binds nothing.
      if (error?.code === 'ENOENT' && !entries.some(entry => path.resolve(root, entry) === file)) continue;
      throw refused('QUALIFICATION_INPUT_UNAVAILABLE');
    }
    seen.set(relative, sha(bytes));
    if (!/\.(?:mjs|js|ts)$/.test(relative)) continue;
    for (const specifier of importSpecifiers(bytes.toString('utf8'))) {
      const target = path.resolve(path.dirname(file), specifier);
      if (!inside(target)) continue;
      const targetRelative = path.relative(root, target).replaceAll('\\', '/');
      if (targetRelative.split('/')[0] === 'dist') continue;
      // A TypeScript source imports its sibling as `./x.js`; the bytes that matter are `./x.ts`.
      const typescript = target.replace(/\.js$/, '.ts');
      queue.push(target.endsWith('.js') && !fs.existsSync(target) && fs.existsSync(typescript) ? typescript : target);
    }
  }
  return Object.fromEntries([...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A stable digest of an input map. */
export function inputMapDigest(map) {
  return sha(
    'AMCP_INPUT_MAP_V1\0' +
      Object.entries(map)
        .map(([file, hash]) => file + '\0' + hash)
        .join('\n'),
  );
}

function newestSourceMtime(root) {
  let newest = 0;
  const visit = directory => {
    let children;
    try {
      children = fs.readdirSync(directory, {withFileTypes: true});
    } catch {
      return;
    }
    for (const child of children) {
      const file = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (child.name !== 'node_modules' && !child.name.startsWith('.')) visit(file);
      } else if (child.isFile() && /\.ts$/.test(child.name) && !/\.d\.ts$/.test(child.name))
        newest = Math.max(newest, fs.statSync(file).mtimeMs);
    }
  };
  for (const directory of sourceRoots) visit(path.join(root, directory));
  return newest;
}

/**
 * The compiled backend a run loads: the validated `dist/release-identity.json` and its SHA-256. Refuses when the record
 * is missing or invalid, or when any TypeScript source is newer than it (a stale `dist`).
 */
export async function releaseIdentityBinding(root, {identityRecord} = {}) {
  root = fs.realpathSync(root);
  const file = path.join(root, 'dist', 'release-identity.json');
  let bytes, info;
  try {
    info = fs.lstatSync(file);
    if (!info.isFile() || info.size > 8192) throw Error();
    bytes = fs.readFileSync(file);
  } catch {
    throw refused('RELEASE_IDENTITY_MISSING');
  }
  identityRecord ??= (await import(new URL('../dist/src/release-identity.js', import.meta.url))).identityRecord;
  let record;
  try {
    record = identityRecord(JSON.parse(bytes.toString('utf8')));
  } catch {
    record = null;
  }
  if (!record) throw refused('RELEASE_IDENTITY_MISSING');
  if (newestSourceMtime(root) > info.mtimeMs) throw refused('RELEASE_IDENTITY_STALE');
  return {
    record_sha256: sha(bytes),
    schema_version: record.schema_version,
    sha256: record.sha256,
    files: record.files,
    bytes: record.bytes,
    components: record.components,
  };
}
