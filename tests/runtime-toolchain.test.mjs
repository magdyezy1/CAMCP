// QA-01: /versionz reports a fixed-format runtime toolchain and owner health a cached media-processor probe. Every value
// passes a strict pattern or is reported as `unavailable`; no path, stderr or free text can pass through.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ffmpegVersionLine,
  mediaProcessorStatus,
  nodeVersion,
  osRelease,
  probeMediaProcessor,
  resetMediaProcessorProbe,
  runtimeToolchain,
  startMediaProcessorProbe,
} from '../dist/src/runtime-toolchain.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const line = 'ffmpeg version 9.0 Copyright (c) 2000-2026 the FFmpeg developers';
const printing = text => ({
  command: process.execPath,
  args: ['-e', 'process.stdout.write(' + JSON.stringify(text) + ')'],
});

test('valid toolchain values pass and malformed ones report unavailable', () => {
  assert.equal(nodeVersion('v24.19.0'), 'v24.19.0');
  for (const value of ['24.19.0', 'v24', 'v24.19.0-pre', 'v24.19.0 C:\\node', null, 24])
    assert.equal(nodeVersion(value), 'unavailable');
  assert.equal(ffmpegVersionLine(line + '\nbuilt with gcc 14\nconfiguration: --prefix=/usr'), line);
  assert.equal(
    ffmpegVersionLine('ffmpeg version 5.1.6-0+deb12u1 Copyright (c) 2000-2024 the FFmpeg developers'),
    'ffmpeg version 5.1.6-0+deb12u1 Copyright (c) 2000-2024 the FFmpeg developers',
  );
  for (const value of [
    'ffmpeg version 9.0 /opt/private/ffmpeg',
    'ffmpeg version C:\\Users\\owner\\ffmpeg.exe',
    'error: /usr/bin/ffmpeg not found',
    'ffmpeg version ' + 'x'.repeat(200),
    '',
    undefined,
    'x'.repeat(70000),
  ])
    assert.equal(ffmpegVersionLine(value), 'unavailable', String(value).slice(0, 40));
  assert.deepEqual(osRelease('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\n'), {
    id: 'debian',
    version_id: '12',
  });
  for (const text of ['ID=debian\n', 'ID="/etc/private"\nVERSION_ID="12"\n', 'ID=Debian Linux\nVERSION_ID=12\n', null])
    assert.equal(osRelease(text), 'unavailable');
});

test('the media-processor probe reports only the validated first line, and unavailable for a missing or hanging binary', async () => {
  assert.deepEqual(await probeMediaProcessor(printing(line + '\nconfiguration: --secret-path=/x\n')), {
    status: 'available',
    version: line,
  });
  assert.deepEqual(await probeMediaProcessor({command: path.join(os.tmpdir(), 'amcp-missing-ffmpeg-binary')}), {
    status: 'unavailable',
    version: 'unavailable',
  });
  assert.deepEqual(await probeMediaProcessor(printing('not ffmpeg at C:\\Users\\owner')), {
    status: 'unavailable',
    version: 'unavailable',
  });
  const started = Date.now();
  const hung = await probeMediaProcessor({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60000)'],
    timeoutMs: 300,
  });
  assert.deepEqual(hung, {status: 'unavailable', version: 'unavailable'});
  assert.ok(Date.now() - started < 10000, 'the deadline bounds the probe');
});

test('ffprobe is matched by its own version line, so an installed ffprobe probes as available', async () => {
  const probeLine = 'ffprobe version n9.0.2-22-g46d8f462ee-20261003 Copyright (c) 2007-2026 the FFmpeg developers';
  assert.equal(ffmpegVersionLine(probeLine + '\nbuilt with gcc 15.2.0', 'ffprobe'), probeLine);
  // Regression: matched as ffmpeg's line, an installed ffprobe was reported unavailable to full qualification.
  assert.deepEqual(await probeMediaProcessor({...printing(probeLine + '\n'), program: 'ffprobe'}), {
    status: 'available',
    version: probeLine,
  });
  // Each program accepts only its own name, and the strict pattern still applies to ffprobe's line.
  assert.equal(ffmpegVersionLine(probeLine), 'unavailable');
  assert.equal(ffmpegVersionLine(line, 'ffprobe'), 'unavailable');
  for (const program of ['ffplay', '__proto__', 'toString'])
    assert.equal(ffmpegVersionLine(line, program), 'unavailable', program);
  for (const value of ['ffprobe version C:\\Users\\owner\\ffprobe.exe', 'ffprobe version ' + 'x'.repeat(200)])
    assert.equal(ffmpegVersionLine(value, 'ffprobe'), 'unavailable');
  assert.deepEqual(await probeMediaProcessor(printing(probeLine)), {status: 'unavailable', version: 'unavailable'});
});

test('the startup probe is cached for health: not_checked until it finishes, then its status', async () => {
  resetMediaProcessorProbe();
  try {
    assert.equal(mediaProcessorStatus(), 'not_checked');
    const pending = startMediaProcessorProbe(printing(line));
    assert.equal(startMediaProcessorProbe(printing('ignored')), pending, 'one probe per process');
    await pending;
    assert.equal(mediaProcessorStatus(), 'available');
    const toolchain = await runtimeToolchain({osReleaseFile: path.join(os.tmpdir(), 'amcp-missing-os-release')});
    assert.equal(toolchain.ffmpeg, line);
    assert.equal(toolchain.os, 'unavailable');
    assert.match(toolchain.node, /^v\d+\.\d+\.\d+$/);
  } finally {
    resetMediaProcessorProbe();
  }
  const file = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-os-release-'));
  try {
    fs.writeFileSync(path.join(file, 'os-release'), 'ID=debian\nVERSION_ID="12"\n');
    const toolchain = await runtimeToolchain({
      osReleaseFile: path.join(file, 'os-release'),
      probe: async () => ({status: 'unavailable', version: '/private/ffmpeg'}),
    });
    assert.deepEqual(toolchain.os, {id: 'debian', version_id: '12'});
    assert.equal(toolchain.ffmpeg, 'unavailable');
  } finally {
    removeTestDirectory(file, 'amcp-os-release-');
  }
});

test('owner health shows the cached media-processor state: not_checked, available, or unavailable without FFmpeg', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 101).toString('base64')),
    service = new MirrorService(new Registry(), store),
    owner = {tenantId: 'synthetic-media-health', userId: 'owner', role: 'admin'};
  const health = async () => {
    const out = await service.call('amcp_workspace', {action: 'health'}, owner);
    assert.equal(out.success, true, JSON.stringify(out));
    return out.data.media_processor;
  };
  resetMediaProcessorProbe();
  try {
    assert.equal(await health(), 'not_checked');
    // The health call above started the host's own probe: owner health reads the configured FFmpeg through
    // startMediaProcessorProbe, which is one probe per process. The stub below was then ignored and the test read the host's
    // FFmpeg, so it passed where one is configured and failed where none is (package docs, item 10). Let that probe finish, then
    // forget it, so the stub is the only probe the rest of the test sees. The test runs and asserts on every host.
    await startMediaProcessorProbe();
    resetMediaProcessorProbe();
    await startMediaProcessorProbe(printing(line));
    assert.equal(await health(), 'available');
    resetMediaProcessorProbe();
    await startMediaProcessorProbe({command: path.join(os.tmpdir(), 'amcp-missing-ffmpeg-binary')});
    assert.equal(await health(), 'unavailable');
  } finally {
    resetMediaProcessorProbe();
    store.close();
  }
});
