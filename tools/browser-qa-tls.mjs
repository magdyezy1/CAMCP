// Loopback HTTPS for the rendered browser runner (`--https`, F-L8-08). Security software on a developer machine can
// inject a script into plain-HTTP pages, and the runner counts that request as external egress. A TLS page is not
// rewritten, so `--https` serves the same synthetic fixture sites over TLS with a throwaway self-signed certificate that
// is made inside the run's own output folder. The certificate is trusted by nothing: the browser contexts of this mode
// (and only this mode) ignore certificate errors, and every request to another origin still fails the run.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import {X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {listenForFetch} from '../dist/tests/http-listener.js';

const loopbackAddress = '127.0.0.1';
const missing =
  '--https needs openssl (Git for Windows ships one) to make a loopback certificate, or AMCP_QA_TLS_CERT and ' +
  'AMCP_QA_TLS_KEY naming absolute paths of an existing PEM certificate and its key.';

/**
 * The openssl to run: the one on PATH, else the one Git for Windows installs beside the git this checkout uses
 * (`<git>/usr/bin/openssl.exe`, found from `git --exec-path`). Null when neither exists.
 */
export function opensslCommand({run = execFileSync, exists = fs.existsSync} = {}) {
  try {
    run('openssl', ['version'], {stdio: 'pipe'});
    return 'openssl';
  } catch {
    /* Not on PATH; look beside git. */
  }
  let installation;
  try {
    installation = path.resolve(String(run('git', ['--exec-path'], {stdio: 'pipe'})).trim(), '..', '..', '..');
  } catch {
    return null;
  }
  return (
    ['usr/bin/openssl.exe', 'mingw64/bin/openssl.exe']
      .map(relative => path.join(installation, relative))
      .find(candidate => exists(candidate)) ?? null
  );
}

/**
 * A certificate and key for the loopback address, valid for one day. It is made with openssl inside `directory`;
 * without openssl the pair named by AMCP_QA_TLS_CERT and AMCP_QA_TLS_KEY is used as it is. Returns the PEM texts,
 * where the pair came from and the certificate's SHA-256 fingerprint for the run record.
 */
export function loopbackCertificate(directory, {env = process.env, run = execFileSync, exists = fs.existsSync} = {}) {
  const openssl = opensslCommand({run, exists});
  let source = 'openssl',
    certFile = path.join(directory, 'loopback.crt'),
    keyFile = path.join(directory, 'loopback.key');
  if (openssl) {
    fs.mkdirSync(directory, {recursive: true});
    run(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '1',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-subj',
        '/CN=' + loopbackAddress,
        '-addext',
        'subjectAltName=IP:' + loopbackAddress + ',DNS:localhost',
        // A server leaf only: it signs nothing and serves TLS to this address.
        '-addext',
        'basicConstraints=critical,CA:FALSE',
        '-addext',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        '-addext',
        'extendedKeyUsage=serverAuth',
      ],
      {stdio: 'pipe'},
    );
  } else {
    const {AMCP_QA_TLS_CERT: cert, AMCP_QA_TLS_KEY: key} = env;
    if (!cert || !key || !path.isAbsolute(cert) || !path.isAbsolute(key) || !exists(cert) || !exists(key))
      throw Error(missing);
    source = 'environment';
    certFile = cert;
    keyFile = key;
  }
  const cert = fs.readFileSync(certFile),
    key = fs.readFileSync(keyFile);
  return {cert, key, source, certFile, keyFile, sha256: new X509Certificate(cert).fingerprint256};
}

/** A `listen` hook for `browserWorkflowSite(kind, {listen, protocol: 'https'})`: the fixture's handler over TLS. */
export const loopbackHttpsListener =
  ({cert, key}) =>
  handler =>
    listenForFetch(handler, {create: handler => https.createServer({cert, key}, handler)});
