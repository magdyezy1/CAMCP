import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const cache = new Map<string, unknown>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
/**
 * A generated artifact or pinned vendor document (a path from the repository root), read and parsed once per process
 * and frozen (F-64). Every module, registry and compiler shares that one copy, and none can change what the others read.
 */
export function pinnedJson<T = any>(path: string): T {
  if (!cache.has(path))
    cache.set(
      path,
      freeze(JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../' + path, import.meta.url)), 'utf8'))),
    );
  return cache.get(path) as T;
}
