import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const resources = [
  {name: 'public_liveness', route: '/healthz', maxBytes: 32768, json: true, liveness: true},
  {name: 'about', route: '/about', maxBytes: 262144, file: 'web/about.html'},
  {
    name: 'arabic_catalog',
    route: '/assets/locales/ar.json',
    maxBytes: 2097152,
    file: 'web/locales/ar.json',
    json: true,
  },
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const refused = code => Object.assign(new Error(code), {diagnosticCode: code});

/** Explain one documented edge insertion without weakening the exact public-byte comparison. */
export function explainAboutInjection(original, received) {
  if (!Buffer.isBuffer(original) || !Buffer.isBuffer(received) || original.length > 262144 || received.length > 262144)
    return null;
  try {
    const decoder = new TextDecoder('utf-8', {fatal: true}),
      local = decoder.decode(original),
      remote = decoder.decode(received),
      boundary = local.indexOf('</body>');
    if (boundary < 0 || boundary !== local.lastIndexOf('</body>')) return null;
    let start = boundary;
    while (start > 0 && boundary - start < 64 && /[ \t\r\n]/u.test(local[start - 1])) start--;
    let insertion;
    for (let position = start; position <= boundary; position++) {
      const prefix = local.slice(0, position),
        suffix = local.slice(position);
      if (!remote.startsWith(prefix) || !remote.endsWith(suffix)) continue;
      const extra = remote.slice(prefix.length, remote.length - suffix.length);
      if (extra && extra.length <= 4096 && /^\s*<script\b/u.test(extra)) {
        insertion = extra;
        break;
      }
    }
    if (!insertion) return null;
    const script = /^\s*<script(\s+[^>]*)>\s*<\/script>\s*$/u.exec(insertion);
    if (!script) return null;
    const attributes = new Map(),
      input = script[1],
      allowed = new Set(['defer', 'src', 'integrity', 'data-cf-beacon', 'crossorigin', 'type']);
    let offset = 0;
    for (const match of input.matchAll(/\s+([a-z][a-z\d-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/gu)) {
      if (match.index !== offset || !allowed.has(match[1]) || attributes.has(match[1])) return null;
      attributes.set(match[1], match[2] ?? match[3] ?? null);
      offset += match[0].length;
    }
    if (input.slice(offset).trim()) return null;
    if (
      !(attributes.get('type') === 'module' || (attributes.has('defer') && attributes.get('defer') === null)) ||
      (attributes.has('defer') && attributes.get('defer') !== null) ||
      !/^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js(?:\/[a-z\d]{16,96})?$/u.test(
        attributes.get('src') ?? '',
      ) ||
      !/^sha(?:256|384|512)-[A-Za-z\d+/]+={0,2}$/u.test(attributes.get('integrity') ?? '') ||
      !attributes.has('data-cf-beacon') ||
      (attributes.has('crossorigin') && attributes.get('crossorigin') !== 'anonymous') ||
      (attributes.has('type') && attributes.get('type') !== 'module')
    )
      return null;
    const configuration = JSON.parse(attributes.get('data-cf-beacon'));
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return null;
    return {
      kind: 'cloudflare_web_analytics_insertion',
      inserted_script_count: 1,
      original_html_content_equal: true,
      exact_public_bytes_equal: false,
    };
  } catch {
    return null;
  }
}

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
        if (resource.liveness) {
          if (!['up', 'degraded'].includes(value.status)) throw refused('PUBLIC_LIVENESS_STATE_INVALID');
          result.reported_liveness = value.status;
        }
      }
      if (local) {
        result.matches_local_bytes = bytes.equals(local);
        if (!result.matches_local_bytes) {
          if (resource.name === 'about') {
            const explanation = explainAboutInjection(local, bytes);
            if (explanation) result.html_transformation = explanation;
          }
          throw refused('PUBLIC_SOURCE_BYTES_DIFFER');
        }
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
