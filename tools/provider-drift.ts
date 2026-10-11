import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {fingerprint} from '../src/report-quality.js';
import type {JsonObject} from '../src/types.js';
const allowedHosts = new Set([
  'www.googleapis.com',
  'googleads.googleapis.com',
  'datamanager.googleapis.com',
  'analyticsdata.googleapis.com',
  'analyticsadmin.googleapis.com',
  'displayvideo.googleapis.com',
  'mybusinessaccountmanagement.googleapis.com',
  'mybusinessbusinessinformation.googleapis.com',
  'businessprofileperformance.googleapis.com',
  'mybusinessverifications.googleapis.com',
  'mybusinessnotifications.googleapis.com',
  'mybusinesslodging.googleapis.com',
  'mybusinessplaceactions.googleapis.com',
  'ads-api.reddit.com',
  'api.criteo.com',
  'campaign.api.bingads.microsoft.com',
  'bulk.api.bingads.microsoft.com',
  'reporting.api.bingads.microsoft.com',
  'adinsight.api.bingads.microsoft.com',
  'clientcenter.api.bingads.microsoft.com',
]);
export function contractShape(d: JsonObject): JsonObject {
  const methods: JsonObject[] = [];
  const visit = (node: JsonObject) => {
    for (const [key, m] of Object.entries(node.methods ?? {}) as [string, JsonObject][])
      methods.push({
        id: m.id ?? key,
        method: m.httpMethod,
        path: m.path,
        request: m.request,
        response: m.response,
        parameters: m.parameters,
        ...(m.soapActions ? {soapActions: m.soapActions} : {}),
        deprecated: m.deprecated === true,
      });
    for (const value of Object.values(node.resources ?? {})) visit(value as JsonObject);
  };
  visit(d);
  for (const [path, item] of Object.entries(d.paths ?? {}) as [string, JsonObject][])
    for (const [method, op] of Object.entries(item) as [string, JsonObject][])
      if (['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method))
        methods.push({
          path,
          method,
          id: op.operationId,
          parameters: op.parameters,
          request: op.requestBody,
          response: op.responses,
          deprecated: op.deprecated === true,
        });
  return {
    version: d.version ?? d.info?.version ?? null,
    methods: methods.sort((a, b) => String(a.id ?? a.path).localeCompare(String(b.id ?? b.path))),
    schemas: d.schemas ?? d.components?.schemas ?? {},
    ...(d.messages ? {messages: d.messages} : {}),
    ...(d.namespace ? {namespace: d.namespace} : {}),
  };
}
export async function checkProviderSpec(envelope: JsonObject, fetcher?: typeof fetch): Promise<JsonObject> {
  if (
    envelope.document_sha256 &&
    envelope.document_sha256 !== createHash('sha256').update(JSON.stringify(envelope.document)).digest('hex')
  )
    throw Error('Pinned vendor document integrity mismatch.');
  const before = contractShape(envelope.document),
    base = {
      source: envelope.source,
      captured_at: envelope.captured_at ?? null,
      version: before.version,
      method_count: before.methods.length,
      fingerprint: fingerprint(before),
    };
  if (!before.methods.length) throw Error('Vendor evidence has no executable method definitions.');
  if (!fetcher) return {...base, status: 'local_integrity_only', live_verified: false};
  const url = new URL(envelope.source);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHosts.has(url.hostname))
    return {...base, status: 'manual_documentation_review', live_verified: false};
  try {
    const response = await fetcher(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {Accept: 'application/json'},
    });
    if (!response.ok) throw Error('HTTP ' + response.status);
    const reader = response.body?.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 16 * 1024 * 1024) {
            await reader.cancel();
            throw Error('Schema exceeds 16 MiB limit');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    const raw = Buffer.concat(chunks).toString('utf8'),
      d = envelope.xml
        ? (await import(new URL('../../tools/microsoft-specs.mjs', import.meta.url).href)).parseWsdl(raw)
        : JSON.parse(raw),
      after = contractShape(d);
    if (!after.methods.length) throw Error('Response has no recognized API contracts');
    const previous = new Set(before.methods.map((m: JsonObject) => m.id ?? m.method + ' ' + m.path)),
      current = new Set(after.methods.map((m: JsonObject) => m.id ?? m.method + ' ' + m.path));
    return {
      ...base,
      status: fingerprint(after) === base.fingerprint ? 'unchanged' : 'drift',
      current_version: after.version,
      current_fingerprint: fingerprint(after),
      removed: [...previous].filter(id => !current.has(id)),
      added: [...current].filter(id => !previous.has(id)),
      deprecated: after.methods
        .filter((m: JsonObject) => m.deprecated)
        .map((m: JsonObject) => m.id ?? m.method + ' ' + m.path),
      checked_at: new Date().toISOString(),
      live_verified: false,
      qualification: 'Public schema comparison only; no account or mutation qualification.',
    };
  } catch (e) {
    return {
      ...base,
      status: 'fetch_failed',
      error: e instanceof Error ? e.message : 'Public schema unavailable',
      live_verified: false,
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const live = process.argv.includes('--live'),
    results: JsonObject[] = [];
  for (const file of fs
    .readdirSync('.mirror/VENDOR')
    .filter(f => f.endsWith('.json'))
    .sort()) {
    const e = JSON.parse(fs.readFileSync('.mirror/VENDOR/' + file, 'utf8'));
    if (e.document && (e.document.resources || e.document.paths || e.document.methods))
      results.push({file, ...(await checkProviderSpec(e, live ? fetch : undefined))});
  }
  console.log(JSON.stringify({version: 1, mode: live ? 'public-schema-drift' : 'local', results}, null, 2));
  if (results.some(r => ['drift', 'fetch_failed'].includes(r.status))) process.exitCode = 1;
}
