import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {checkApplication} from './smoke-api.mjs';
const suffix = randomBytes(6).toString('hex'),
  container = 'amcp-ci-' + suffix,
  volume = container + '-data';
const password = randomBytes(24).toString('base64url'),
  base = 'http://127.0.0.1:14317',
  origin = 'https://amcp.shop';
const writes = process.argv.includes('--writes');
const env = {
  ...process.env,
  MIRROR_MASTER_KEY: randomBytes(32).toString('base64'),
  AMCP_ADMIN_PASSWORD: password,
  AMCP_PUBLIC_ORIGIN: origin,
  MIRROR_ALLOW_WRITES: String(writes),
};
function docker(...args) {
  const result = spawnSync('docker', args, {encoding: 'utf8', env});
  if (result.status !== 0) throw Error('Docker ' + args[0] + ' failed: ' + result.stderr);
  return result.stdout.trim();
}
async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/healthz', {signal: AbortSignal.timeout(1000)});
      if (r.ok) {
        assert.equal((await r.json()).status, 'up');
        return;
      }
    } catch {}
    await delay(250);
  }
  throw Error('AMCP container did not become healthy');
}
let created = false,
  volumeCreated = false;
try {
  docker('volume', 'create', volume);
  volumeCreated = true;
  docker(
    'run',
    '-d',
    '--name',
    container,
    '-p',
    '127.0.0.1:14317:4317',
    '-v',
    volume + ':/data',
    '-e',
    'MIRROR_MASTER_KEY',
    '-e',
    'AMCP_ADMIN_PASSWORD',
    '-e',
    'AMCP_PUBLIC_ORIGIN',
    '-e',
    'MIRROR_ALLOW_WRITES',
    'amcp:check',
  );
  created = true;
  await ready();
  assert.equal(docker('exec', container, 'stat', '-c', '%u', '/data'), '1000');
  await checkApplication({
    base,
    origin,
    password,
    writes,
    restart: async () => {
      docker('restart', container);
      await ready();
    },
  });
  console.log(
    'AMCP container checks passed: Reporting Overview, Sheets setup, sign-in, packaged MCP guides, non-root volume access, restart persistence and token revocation.',
  );
} finally {
  if (created) docker('rm', '-f', container);
  if (volumeCreated) docker('volume', 'rm', volume);
}
