import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createPublicAssets} from '../dist/server/public-assets.js';

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

/** Compare public liveness, the exact locally rendered versioned About HTML and the catalog bytes. */
export async function comparePublicWebsite({origin, root = process.cwd(), timeoutMs = 15000, fetcher = fetch}) {
  const exactOrigin = publicWebsiteOrigin(origin);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw refused('INVALID_PUBLIC_READ_TIMEOUT');
  const observations = [],
    publicAssets = createPublicAssets(path.join(root, 'web'));
  for (const resource of resources) {
    const local =
      resource.name === 'about'
        ? Buffer.from(publicAssets.html('about.html'))
        : resource.file
          ? await fs.readFile(path.join(root, resource.file))
          : undefined;
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
      'Public HTTP liveness, exact locally rendered About HTML and static catalog byte comparisons only; not deployed backend Git/image, provider permissions or full production acceptance.',
    credentials_sent: false,
    redirects_followed: false,
  };
}

async function boundedGet(fetcher, url, {timeoutMs, accept, maxBytes}) {
  const response = await fetcher(url, {
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {Accept: accept},
  });
  return {status: response.status, bytes: await boundedResponse(response, maxBytes)};
}
const sameComponents = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every(
    (c, i) => c?.name === b[i]?.name && c.files === b[i].files && c.bytes === b[i].bytes && c.sha256 === b[i].sha256,
  );

/**
 * Compares the deployed /versionz and the landing page's asset version with a local qualification record (QA-01).
 * GET-only, credential-free, no redirects; returns fixed comparison fields and never response bodies.
 */
export async function compareDeployedRecord({origin, record, timeoutMs = 15000, fetcher = fetch}) {
  const exactOrigin = publicWebsiteOrigin(origin);
  if (!record?.package?.sha256 || !Array.isArray(record.package.components))
    throw refused('QUALIFICATION_RECORD_INVALID');
  const checks = {
    versionz_status: null,
    package_sha256_equal: false,
    runtime_matches_build: false,
    components_equal: false,
    lockfile_component_equal: false,
    source_revision_equal: null,
    public_asset_version_equal: false,
    landing_asset_version_equal: false,
    node_major_24: false,
    ffmpeg_reported: false,
  };
  const observation = {
    record_kind: 'deployed_identity_observation',
    origin: exactOrigin,
    checked_at: new Date().toISOString(),
    record_source_tree_hash: record.source?.source_tree_hash ?? null,
    checks,
    passed: false,
    credentials_sent: false,
    redirects_followed: false,
  };
  try {
    const versionz = await boundedGet(fetcher, exactOrigin + '/versionz', {
      timeoutMs,
      accept: 'application/json',
      maxBytes: 65536,
    });
    checks.versionz_status = versionz.status;
    const body = JSON.parse(versionz.bytes.toString('utf8'));
    const lock = list => list?.find?.(c => c?.name === 'package-lock.json');
    checks.runtime_matches_build = body?.status === 'matches_build';
    checks.package_sha256_equal =
      body?.build?.sha256 === record.package.sha256 && body?.runtime?.sha256 === record.package.sha256;
    checks.components_equal =
      sameComponents(body?.build?.components, record.package.components) &&
      sameComponents(body?.runtime?.components, record.package.components);
    checks.lockfile_component_equal =
      !!lock(record.package.components) &&
      lock(body?.runtime?.components)?.sha256 === lock(record.package.components).sha256;
    if (body?.build?.source_revision)
      checks.source_revision_equal = body.build.source_revision === record.source?.revision;
    checks.public_asset_version_equal =
      typeof body?.public_asset_version === 'string' && body.public_asset_version === record.public_asset_version;
    checks.node_major_24 = /^v24\.\d+\.\d+$/.test(body?.toolchain?.node ?? '');
    checks.ffmpeg_reported = /^ffmpeg version /.test(body?.toolchain?.ffmpeg ?? '');
    const landing = await boundedGet(fetcher, exactOrigin + '/', {timeoutMs, accept: 'text/html', maxBytes: 262144});
    const versions = new Set(
      [...landing.bytes.toString('utf8').matchAll(/\/assets\/v\/([0-9a-f]{64})\//g)].map(match => match[1]),
    );
    checks.landing_asset_version_equal =
      landing.status === 200 && versions.size === 1 && versions.has(record.public_asset_version);
    observation.passed =
      checks.versionz_status === 200 &&
      checks.runtime_matches_build &&
      checks.package_sha256_equal &&
      checks.components_equal &&
      checks.lockfile_component_equal &&
      checks.source_revision_equal !== false &&
      checks.public_asset_version_equal &&
      checks.landing_asset_version_equal;
  } catch (error) {
    observation.error_code =
      error?.diagnosticCode ?? (error?.name === 'TimeoutError' ? 'PUBLIC_READ_TIMEOUT' : 'PUBLIC_READ_FAILED');
  }
  return observation;
}

/** Appends a deployed observation to a local qualification record file atomically. */
export async function appendDeployedObservation(file, observation) {
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.deployed_observations = [...(record.deployed_observations ?? []), observation].slice(-50);
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', {flag: 'wx'});
  await fs.rename(temporary, file);
}

async function cli(args) {
  const recordIndex = args.indexOf('--expect-record');
  if (args[0] !== '--origin' || !(args.length === 2 || (args.length === 4 && recordIndex === 2))) {
    process.stderr.write(
      'Usage: node tools/check-public-website.mjs --origin https://your-amcp-site [--expect-record <record.json>]\n',
    );
    process.exitCode = 2;
    return;
  }
  try {
    if (recordIndex === 2) {
      const file = path.resolve(args[3]);
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      const observation = await compareDeployedRecord({origin: args[1], record});
      await appendDeployedObservation(file, observation);
      process.stdout.write(JSON.stringify(observation, null, 2) + '\n');
      if (!observation.passed) process.exitCode = 1;
      return;
    }
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
