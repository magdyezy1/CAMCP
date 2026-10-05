import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {packagedIdentity} from '../dist/src/release-identity.js';
/** Atomically write the public build summary after compiling the packaged artifacts. */
export function buildReleaseIdentity(root, claimedRevision = null) {
  let temporary;
  try {
    root = path.resolve(root);
    const record = packagedIdentity(root, claimedRevision),
      directory = path.join(root, 'dist'),
      target = path.join(directory, 'release-identity.json');
    try {
      const before = fs.lstatSync(target);
      if (before.isSymbolicLink() || !before.isFile()) throw Error();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    temporary = path.join(directory, '.release-identity-' + randomUUID() + '.tmp');
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', {flag: 'wx', mode: 0o644});
    fs.renameSync(temporary, target);
    temporary = undefined;
    return record;
  } catch {
    throw Error('RELEASE_IDENTITY_BUILD_FAILED');
  } finally {
    if (temporary) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const record = buildReleaseIdentity(process.cwd(), process.env.RAILWAY_GIT_COMMIT_SHA);
    console.log(
      JSON.stringify({
        event: 'release_identity_written',
        schema_version: record.schema_version,
        sha256: record.sha256,
        files: record.files,
        bytes: record.bytes,
        source_revision: record.source_revision,
      }),
    );
  } catch {
    console.error('RELEASE_IDENTITY_BUILD_FAILED');
    process.exitCode = 1;
  }
}
