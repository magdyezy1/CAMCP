import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const resources = [
  {name: 'public_liveness', route: '/healthz', maxBytes: 32768, json: true},
  {name: 'about', route: '/about', maxBytes: 262144, file: 'web/about.html'},
  {
    name: 'arabic_catalog',
    route: '/assets/locales/ar.json',
    maxBytes: 1048576,
    file: 'web/locales/ar.json',
    json: true,
  },
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const refused = code => Object.assign(new Error(code), {diagnosticCode: code});

export function publicWebsiteOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw refused('INVALID_PUBLIC_ORIGIN');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (
    typeof value !== 'string' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback))
  )
    throw refused('INVALID_PUBLIC_ORIGIN');
  return origin.origin;
}

async function boundedResponse(response, maximumBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > maximumBytes) throw refused('PUBLIC_RESPONSE_TOO_LARGE');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Compare only public liveness and two static files. Never infer backend/image or provider acceptance. */
export async function comparePublicWebsite({origin, root = process.cwd(), timeoutMs = 15000, fetcher = fetch}) {
  const exactOrigin = publicWebsiteOrigin(origin);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw refused('INVALID_PUBLIC_READ_TIMEOUT');
  const observations = [];
  for (const resource of resources) {
    const local = resource.file ? await fs.readFile(path.join(root, resource.file)) : undefined;
    const result = {
      name: resource.name,
      route: resource.route,
      method: 'GET',
      checked_at: new Date().toISOString(),
      status: null,
      byte_length: null,
      observed_sha256: null,
      local_sha256: local ? sha(local) : null,
      matches_local_bytes: null,
      passed: false,
    };
    try {
      const response = await fetcher(exactOrigin + resource.route, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {Accept: resource.json ? 'application/json' : 'text/html'},
      });
      result.status = response.status;
      if (response.status !== 200) {
        await response.body?.cancel();
        throw refused(
          response.status >= 300 && response.status < 400 ? 'PUBLIC_REDIRECT_REFUSED' : 'PUBLIC_HTTP_STATUS',
        );
      }
      const bytes = await boundedResponse(response, resource.maxBytes);
      result.byte_length = bytes.length;
      result.observed_sha256 = sha(bytes);
      if (resource.json) {
        let value;
        try {
          value = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw refused('PUBLIC_JSON_INVALID');
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw refused('PUBLIC_JSON_INVALID');
      }
      if (local) {
        result.matches_local_bytes = bytes.equals(local);
        if (!result.matches_local_bytes) throw refused('PUBLIC_SOURCE_BYTES_DIFFER');
      }
      result.passed = true;
    } catch (error) {
      // Do not return response bodies, Location headers, network URLs or parser diagnostics.
      result.error_code =
        error?.diagnosticCode ?? (error?.name === 'TimeoutError' ? 'PUBLIC_READ_TIMEOUT' : 'PUBLIC_READ_FAILED');
    }
    observations.push(result);
  }
  return {
    record_kind: 'bounded_public_website_source_comparison',
    origin: exactOrigin,
    passed: observations.every(result => result.passed),
    observations,
    comparison_scope:
      'Public HTTP liveness and two static file byte comparisons only; not deployed backend Git/image, provider permissions or full production acceptance.',
    credentials_sent: false,
    redirects_followed: false,
  };
}

async function cli(args) {
  if (args.length !== 2 || args[0] !== '--origin') {
    process.stderr.write('Usage: node tools/check-public-website.mjs --origin https://your-amcp-site\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await comparePublicWebsite({origin: args[1]});
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write((error?.diagnosticCode ?? 'PUBLIC_CHECK_UNAVAILABLE') + '\n');
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await cli(process.argv.slice(2));
