import fs from 'node:fs';
import path from 'node:path';
import {readBuildRecord} from './release-status.js';
import type {JsonObject} from './types.js';

let cached: {root: string; identity: JsonObject} | undefined;
/**
 * The build an MCP client is talking to (MCP-05): the package version plus a short build identifier from
 * dist/release-identity.json, the record /versionz also reads. The Git revision is used when the build recorded one,
 * otherwise the packaged-artifact digest. Without a readable record the version is the package version alone.
 */
export function serverIdentity(root = process.cwd()): JsonObject {
  if (cached?.root === root) return cached.identity;
  let version = '0.1.0';
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof parsed.version === 'string' && /^\d+\.\d+\.\d+$/.test(parsed.version)) version = parsed.version;
  } catch {}
  const record = readBuildRecord(root),
    build = record?.source_revision
      ? record.source_revision.slice(0, 12)
      : record
        ? 'sha256.' + record.sha256.slice(0, 12)
        : null;
  const identity = {
    version: build ? version + '+' + build : version,
    package_version: version,
    source_revision: record?.source_revision ?? null,
    artifact_sha256: record?.sha256 ?? null,
    status_url: '/versionz',
  };
  cached = {root, identity};
  return identity;
}
