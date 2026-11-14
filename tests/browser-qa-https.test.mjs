// F-L8-08: the rendered browser runner can be run over loopback TLS (`--https`). Security software on a developer
// machine injects a script into plain-HTTP pages, which the runner counts as external egress; a TLS page is not
// rewritten. The certificate is made at run time, trusted by nothing, and certificate errors are ignored only here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {X509Certificate, createPrivateKey} from 'node:crypto';
import {browserContextOptions, browserQaArguments} from '../tools/browser-qualification.mjs';
import {loopbackCertificate, loopbackHttpsListener, opensslCommand} from '../tools/browser-qa-tls.mjs';

const kinds = ['empty', 'granular-reporting'];
// The tool's refusal where it has no openssl and no certificate pair to reuse: it names both ways out.
const noOpenssl = /--https needs openssl .*AMCP_QA_TLS_CERT and AMCP_QA_TLS_KEY naming absolute paths/;

test('--https is a flag of its own: off by default, combinable with a subset or a qualification, never twice', () => {
  assert.equal(browserQaArguments(['--output-dir', '.runtime/x'], {}, kinds).https, false);
  assert.deepEqual(browserQaArguments(['--output-dir', '.runtime/x', '--https'], {}, kinds), {
    output: '.runtime/x',
    qualification: false,
    kinds: null,
    https: true,
  });
  assert.deepEqual(
    browserQaArguments(['--https', '--kinds', 'granular-reporting', '--output-dir', '.runtime/x'], {}, kinds),
    {output: '.runtime/x', qualification: false, kinds: ['granular-reporting'], https: true},
  );
  const qualification = browserQaArguments(
    ['--qualification', '--https', '--output-dir', '.runtime/x'],
    {AMCP_QA_AXE_PATH: 'C:/axe.min.js'},
    kinds,
  );
  assert.equal(qualification.qualification && qualification.https, true);
  for (const argv of [['--https'], ['--output-dir', 'a', '--https', '--https'], ['--output-dir', 'a', '--https=1']])
    assert.throws(() => browserQaArguments(argv, {}, kinds), /Use --output-dir/, JSON.stringify(argv));
  // The usage text a mistyped command prints names the flag, so the way out of the injected-script failure is visible.
  assert.throws(() => browserQaArguments([], {}, kinds), /--https/);
});

test('certificate errors are ignored only in --https mode, and the input options are kept', () => {
  const options = {viewport: {width: 320, height: 900}, reducedMotion: 'reduce', serviceWorkers: 'block'};
  const plain = browserContextOptions(options, false),
    secure = browserContextOptions(options, true);
  assert.deepEqual(plain, options);
  assert.equal(Object.hasOwn(plain, 'ignoreHTTPSErrors'), false);
  assert.deepEqual(secure, {...options, ignoreHTTPSErrors: true});
  assert.equal(Object.hasOwn(browserContextOptions(options), 'ignoreHTTPSErrors'), false, 'plain HTTP is the default');
  assert.equal(Object.hasOwn(options, 'ignoreHTTPSErrors'), false, 'the caller’s options are not changed');
  // Every browser context the runner opens goes through the helper, so no case can skip or leak the option.
  const runner = fs.readFileSync('tools/browser-workflow-qa.mjs', 'utf8');
  assert.equal(
    /browser\.newContext\((?!\s*browserContextOptions\()/.test(runner),
    false,
    'the runner builds its contexts with browserContextOptions',
  );
  assert.match(runner, /newContext = contextOptions =>\s*browser\.newContext\(browserContextOptions\(/);
  assert.equal(runner.includes('ignoreHTTPSErrors'), false, 'the option lives in one place');
});

// Package sqlite354: the Linux build image installs ffmpeg, python3 and git and no openssl, so this test made no
// certificate there and failed. Where openssl is on PATH or beside git (a developer's machine) it makes one and checks it;
// where it is not, it checks the tool's own refusal instead, and the next test checks that refusal on every host.
test('the loopback certificate is made at run time for 127.0.0.1, lasts a day, and is trusted by nothing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-qa-tls-'));
  try {
    if (!opensslCommand()) {
      t.diagnostic('openssl is not on this host: the tool’s refusal is checked in place of a certificate');
      assert.throws(() => loopbackCertificate(directory, {env: {}}), noOpenssl);
      assert.deepEqual(fs.readdirSync(directory), [], 'nothing is generated');
      return;
    }
    const made = loopbackCertificate(directory);
    assert.equal(made.source, 'openssl', 'openssl is on PATH or ships with Git for Windows');
    assert.equal(path.dirname(made.certFile), directory, 'the pair is written inside the folder it was given');
    assert.equal(path.dirname(made.keyFile), directory);
    const certificate = new X509Certificate(made.cert);
    assert.match(certificate.subjectAltName, /IP Address:127\.0\.0\.1/);
    assert.match(certificate.subjectAltName, /DNS:localhost/);
    assert.equal(certificate.ca, false, 'a leaf, not an authority');
    assert.equal(made.sha256, certificate.fingerprint256);
    const lifetime = Date.parse(certificate.validTo) - Date.parse(certificate.validFrom);
    assert.ok(lifetime > 0 && lifetime <= 2 * 86400000, 'a day or so: ' + lifetime);
    assert.ok(Date.parse(certificate.validTo) > Date.now(), 'not yet expired');
    assert.ok(certificate.checkPrivateKey(createPrivateKey(made.key)), 'the key belongs to the certificate');

    // The fixture site's handler over TLS: reachable when this exact certificate is trusted, refused otherwise.
    const server = await loopbackHttpsListener(made)((request, response) => response.end('synthetic ' + request.url));
    try {
      const port = server.address().port,
        get = options =>
          new Promise((resolve, reject) =>
            https
              .get({host: '127.0.0.1', port, path: '/page', ...options}, response => {
                let body = '';
                response.on('data', chunk => (body += chunk));
                response.on('end', () => resolve({status: response.statusCode, body}));
              })
              .on('error', reject),
          );
      assert.deepEqual(await get({ca: made.cert}), {status: 200, body: 'synthetic /page'});
      await assert.rejects(
        get({}),
        error => /SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code),
        'without the exact certificate the page is not trusted',
      );
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }

    // Without openssl, the pair named by the environment is used as it is and nothing is written.
    const absent = () => {
      throw Error('not installed');
    };
    const before = fs.readdirSync(directory).sort();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-qa-tls-fallback-'));
    try {
      const reused = loopbackCertificate(other, {
        run: absent,
        env: {AMCP_QA_TLS_CERT: made.certFile, AMCP_QA_TLS_KEY: made.keyFile},
      });
      assert.equal(reused.source, 'environment');
      assert.equal(reused.sha256, made.sha256);
      assert.deepEqual(fs.readdirSync(other), [], 'nothing is generated');
      assert.deepEqual(fs.readdirSync(directory).sort(), before);
      for (const env of [
        {},
        {AMCP_QA_TLS_CERT: made.certFile},
        {AMCP_QA_TLS_KEY: made.keyFile},
        {AMCP_QA_TLS_CERT: 'loopback.crt', AMCP_QA_TLS_KEY: 'loopback.key'},
        {AMCP_QA_TLS_CERT: path.join(directory, 'missing.crt'), AMCP_QA_TLS_KEY: made.keyFile},
      ])
        assert.throws(
          () => loopbackCertificate(other, {run: absent, env}),
          /AMCP_QA_TLS_CERT and AMCP_QA_TLS_KEY/,
          JSON.stringify(env),
        );
    } finally {
      fs.rmSync(other, {recursive: true, force: true});
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('without openssl the tool refuses in its own words on every host, naming both ways out, and writes nothing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-qa-tls-refusal-')),
    cert = path.join(directory, 'loopback.crt'),
    key = path.join(directory, 'loopback.key');
  try {
    // Two hosts without openssl: one with no git either, and the Linux build image, where `git --exec-path` answers and
    // no openssl is beside it. The runner and the file check are the tool's own parameters, so this host does not matter.
    const neither = () => {
        throw Error('not installed');
      },
      gitOnly = command => {
        if (command === 'git') return Buffer.from('/usr/lib/git-core\n');
        throw Error('openssl: not found');
      };
    for (const [host, run] of [
      ['no openssl and no git', neither],
      ['git without an openssl beside it', gitOnly],
    ])
      for (const [name, env, existing] of [
        ['no variables', {}, []],
        ['only the certificate', {AMCP_QA_TLS_CERT: cert}, [cert, key]],
        ['only the key', {AMCP_QA_TLS_KEY: key}, [cert, key]],
        [
          'relative paths',
          {AMCP_QA_TLS_CERT: 'loopback.crt', AMCP_QA_TLS_KEY: 'loopback.key'},
          ['loopback.crt', 'loopback.key'],
        ],
        ['files that do not exist', {AMCP_QA_TLS_CERT: cert, AMCP_QA_TLS_KEY: key}, []],
        ['a certificate without its key', {AMCP_QA_TLS_CERT: cert, AMCP_QA_TLS_KEY: key}, [cert]],
        ['a key without its certificate', {AMCP_QA_TLS_CERT: cert, AMCP_QA_TLS_KEY: key}, [key]],
      ])
        assert.throws(
          () => loopbackCertificate(directory, {run, exists: file => existing.includes(file), env}),
          noOpenssl,
          `${host}: ${name}`,
        );
    assert.deepEqual(fs.readdirSync(directory), [], 'nothing is generated');
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('openssl is found on PATH, else beside the git this checkout uses, else not at all', () => {
  const git = path.join(os.tmpdir(), 'git-for-windows'),
    execPath = path.join(git, 'mingw64', 'libexec', 'git-core'),
    bundled = path.join(git, 'usr', 'bin', 'openssl.exe');
  const calls = [];
  const run = (command, args) => {
    calls.push(command + ' ' + args.join(' '));
    if (command === 'git') return Buffer.from(execPath + '\n');
    throw Error('openssl is not on PATH');
  };
  assert.equal(opensslCommand({run, exists: candidate => candidate === bundled}), bundled);
  assert.deepEqual(calls, ['openssl version', 'git --exec-path']);
  assert.equal(opensslCommand({run: () => Buffer.from('OpenSSL 3'), exists: () => false}), 'openssl');
  assert.equal(opensslCommand({run, exists: () => false}), null, 'no openssl beside git either');
  assert.equal(
    opensslCommand({
      run: () => {
        throw Error('neither is installed');
      },
    }),
    null,
  );
});
