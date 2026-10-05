import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const directories = ['dist', 'generated', '.mirror/VENDOR', 'web', 'Skills/amcp-campaign-builder'];
const singleFiles = ['package.json', 'docs/REPORTING-OVERVIEW.md'];
const ignoredRecord = 'dist/release-identity.json';
const maxFiles = 10000,
  maxFileBytes = 256 * 1024 * 1024,
  maxPayloadBytes = 1024 * 1024 * 1024;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const refusal = (): never => {
  throw new Error('RELEASE_IDENTITY_UNAVAILABLE');
};

export interface ReleaseComponent {
  name: string;
  files: number;
  bytes: number;
  sha256: string;
}
export interface ReleaseIdentity {
  schema_version: 1;
  kind: 'amcp_packaged_runtime';
  sha256: string;
  files: number;
  bytes: number;
  components: ReleaseComponent[];
  /** Build-supplied Git claim, separate from the measured artifact digest. */ source_revision: string | null;
}

export function sourceRevision(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}
/** Hash only the fixed packaged application scope, excluding private state, dependencies and OS/image identity. */
export function packagedIdentity(root: string, revision: unknown = null): ReleaseIdentity {
  root = path.resolve(root);
  const rootInfo = fs.lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) refusal();
  const location = (relative: string, directory: boolean): fs.Stats => {
    if (path.posix.normalize(relative) !== relative || /[\x00-\x1f\x7f]/.test(relative)) refusal();
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(root + path.sep)) refusal();
    let target = root,
      last = rootInfo;
    const parts = relative.split('/');
    for (const [i, part] of parts.entries()) {
      target = path.join(target, part);
      last = fs.lstatSync(target);
      if (last.isSymbolicLink() || ((i < parts.length - 1 || directory) && !last.isDirectory())) refusal();
    }
    return last;
  };
  const files: {relative: string; absolute: string; before: fs.Stats; component: string}[] = [];
  let totalBytes = 0;
  const file = (relative: string, entry: ReleaseComponent) => {
    if (relative === ignoredRecord) return;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(root + path.sep)) refusal();
    const before = location(relative, false);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxFileBytes || /[\x00-\x1f\x7f]/.test(relative))
      refusal();
    if (++entry.files > maxFiles || files.length >= maxFiles || (totalBytes += before.size) > maxPayloadBytes)
      refusal();
    files.push({relative, absolute, before, component: entry.name});
  };
  const components: ReleaseComponent[] = [];
  for (const directory of directories) {
    const entry = {name: directory, files: 0, bytes: 0, sha256: ''};
    components.push(entry);
    const visit = (relative: string) => {
      const absolute = path.resolve(root, relative);
      location(relative, true);
      for (const child of fs.readdirSync(absolute, {withFileTypes: true})) {
        const location = path.posix.join(relative, child.name);
        if (location === ignoredRecord) continue;
        if (child.isSymbolicLink()) refusal();
        if (child.isDirectory()) visit(location);
        else if (child.isFile()) file(location, entry);
        else refusal();
      }
    };
    visit(directory);
    if (!entry.files) refusal();
  }
  for (const relative of singleFiles) {
    const entry = {name: relative, files: 0, bytes: 0, sha256: ''};
    components.push(entry);
    file(relative, entry);
  }
  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  const buffer = Buffer.allocUnsafe(1024 * 1024),
    records: {relative: string; sha256: string; bytes: number; component: string}[] = [];
  for (const record of files) {
    const fd = fs.openSync(record.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      const opened = fs.fstatSync(fd);
      if (
        opened.dev !== record.before.dev ||
        opened.ino !== record.before.ino ||
        opened.size !== record.before.size ||
        opened.mtimeMs !== record.before.mtimeMs
      )
        refusal();
      for (;;) {
        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!count) break;
        bytes += count;
        if (bytes > maxFileBytes || bytes > record.before.size) refusal();
        hash.update(buffer.subarray(0, count));
      }
      const after = fs.fstatSync(fd);
      if (
        bytes !== record.before.size ||
        after.size !== record.before.size ||
        after.mtimeMs !== record.before.mtimeMs ||
        after.ctimeMs !== record.before.ctimeMs
      )
        refusal();
    } finally {
      fs.closeSync(fd);
    }
    records.push({relative: record.relative, sha256: hash.digest('hex'), bytes, component: record.component});
  }
  for (const entry of components) {
    const members = records.filter(record => record.component === entry.name);
    entry.bytes = members.reduce((n, record) => n + record.bytes, 0);
    entry.sha256 = sha(
      'AMCP_COMPONENT_V1\0' + members.map(record => record.relative + '\0' + record.sha256).join('\n'),
    );
  }
  return {
    schema_version: 1,
    kind: 'amcp_packaged_runtime',
    sha256: sha('AMCP_PAYLOAD_V1\0' + records.map(record => record.relative + '\0' + record.sha256).join('\n')),
    files: files.length,
    bytes: totalBytes,
    components,
    source_revision: sourceRevision(revision),
  };
}

/** Accept only the bounded public summary, never arbitrary metadata or per-file contents. */
export function identityRecord(value: unknown): ReleaseIdentity | null {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
    object(v) && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
  const hash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
  const integer = (v: unknown, max: number): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
  if (
    !exact(value, ['schema_version', 'kind', 'sha256', 'files', 'bytes', 'components', 'source_revision']) ||
    value.schema_version !== 1 ||
    value.kind !== 'amcp_packaged_runtime' ||
    !hash(value.sha256) ||
    !integer(value.files, maxFiles) ||
    value.files < singleFiles.length + directories.length ||
    !integer(value.bytes, maxPayloadBytes) ||
    !(value.source_revision === null || sourceRevision(value.source_revision) === value.source_revision) ||
    !Array.isArray(value.components) ||
    value.components.length !== directories.length + singleFiles.length
  )
    return null;
  const names = [...directories, ...singleFiles];
  let files = 0,
    bytes = 0;
  for (let i = 0; i < value.components.length; i++) {
    const component: unknown = value.components[i];
    if (
      !exact(component, ['name', 'files', 'bytes', 'sha256']) ||
      component.name !== names[i] ||
      !integer(component.files, maxFiles) ||
      component.files < 1 ||
      !integer(component.bytes, maxPayloadBytes) ||
      !hash(component.sha256)
    )
      return null;
    files += component.files;
    bytes += component.bytes;
  }
  if (files !== value.files || bytes !== value.bytes) return null;
  return structuredClone(value) as unknown as ReleaseIdentity;
}
