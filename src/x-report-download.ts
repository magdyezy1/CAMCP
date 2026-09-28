import {request} from 'node:https';
import {Readable} from 'node:stream';
import {gunzipSync} from 'node:zlib';
import {MirrorError} from './errors.js';
import {sha256} from './security.js';
import {publicReportAddress, reportDns} from './microsoft-report-download.js';
import {validateXReportData} from './x-report-jobs.js';
import type {JsonObject} from './types.js';

const compressedLimit = 8 * 1024 * 1024,
  expandedLimit = 32 * 1024 * 1024;
function fail(message: string): never {
  throw new MirrorError('X_REPORT_DOWNLOAD_INVALID', message, {}, 502);
}
/** Only a freshly polled, bound SUCCESS job can supply this URL. The caller
 * never accepts a client-provided URL, and no advertising credential is sent. */
export function xReportUrl(value: unknown, id: string) {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    fail('X did not return a usable report location.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'ton.twimg.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.length > 8192 ||
    !url.pathname.startsWith('/advertiser-api-async-analytics/') ||
    url.pathname !== '/advertiser-api-async-analytics/stats_job_' + id + '.json.gz'
  )
    fail('X result location is outside the documented HTTPS report host or original job path.');
  return url;
}
async function get(url: URL, signal: AbortSignal, access: () => void): Promise<Response> {
  access();
  const records = await reportDns(url.hostname, signal);
  access();
  if (!records.length || records.some(r => !publicReportAddress(r.address)))
    fail('Report DNS did not resolve exclusively to public addresses.');
  const chosen = records[0]!;
  return new Promise((resolve, reject) => {
    access();
    const req = request(
      url,
      {
        method: 'GET',
        signal,
        agent: false,
        headers: {Accept: 'application/gzip, application/octet-stream'},
        lookup: ((_host: any, options: any, callback: any) =>
          options?.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family)) as any,
      },
      res =>
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream, {
            status: res.statusCode!,
            headers: Object.fromEntries(
              Object.entries(res.headers)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
            ),
          }),
        ),
    );
    req.once('error', reject);
    req.end();
  });
}
export function parseXReportArchive(bytes: Buffer, binding: JsonObject) {
  if (bytes.length < 18 || bytes.length > compressedLimit || bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8)
    fail('Expected a bounded native gzip report.');
  let expanded: Buffer;
  try {
    expanded = gunzipSync(bytes, {maxOutputLength: expandedLimit});
  } catch {
    fail('The gzip stream failed integrity checks or exceeds 32 MiB.');
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(expanded));
  } catch {
    fail('Downloaded report must contain complete, valid UTF-8 JSON.');
  }
  const result = validateXReportData(data, binding);
  return {
    ...result,
    report: {
      ...result.report,
      compressed_sha256: sha256(bytes),
      output_sha256: sha256(expanded),
      compressed_bytes: bytes.length,
      expanded_bytes: expanded.length,
      compression_integrity_verified: true,
      checksum_source: 'gzip CRC32 and local SHA-256; no independent provider checksum is published',
    },
  };
}
export async function downloadXReport(
  row: JsonObject,
  binding: JsonObject,
  access: () => void,
  fetcher?: typeof fetch,
  deadline = performance.now() + 60000,
) {
  const url = xReportUrl(row.url, binding.job_id),
    expiry = Date.parse(row.expires_at);
  const check = () => {
    access();
    if (!Number.isFinite(expiry) || Date.now() >= expiry)
      fail('The native report URL expired. Poll the original job for a current result; do not resubmit it.');
    if (performance.now() >= deadline) fail('Report retrieval exceeded its deadline. Retry only the original read.');
  };
  check();
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(30000, deadline - performance.now()))));
  let response: Response;
  try {
    response = fetcher
      ? await fetcher(url, {
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          headers: {Accept: 'application/gzip, application/octet-stream'},
          signal,
        })
      : await get(url, signal, check);
  } catch (e) {
    if (e instanceof MirrorError) throw e;
    fail('The report download failed or timed out. Poll the original job; no replacement was submitted.');
  }
  const length = response.headers.get('content-length');
  try {
    check();
    if (response.status !== 200 || (length !== null && (!/^\d+$/.test(length) || Number(length) > compressedLimit)))
      fail('Report response is unsuccessful or exceeds the compressed byte bound.');
  } catch (e) {
    await response.body?.cancel();
    throw e;
  }
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (!reader) fail('The report response has no body.');
    while (true) {
      check();
      const {done, value} = await reader.read();
      check();
      if (done) break;
      size += value.length;
      if (size > compressedLimit) fail('Report exceeds 8 MiB compressed.');
      chunks.push(value);
    }
    if (length !== null && Number(length) !== size) fail('Report body length differs from Content-Length.');
  } catch (e) {
    await reader?.cancel().catch(() => {});
    if (e instanceof MirrorError) throw e;
    fail('Report transfer was interrupted or truncated.');
  } finally {
    reader?.releaseLock();
  }
  check();
  const result = parseXReportArchive(Buffer.concat(chunks), binding);
  check();
  return result;
}
export function xReportPage(rows: JsonObject[], offset: number, limit: number) {
  const page: JsonObject[] = [];
  let bytes = 2;
  for (const row of rows.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (size > 512 * 1024)
      fail('One native entity/segment row exceeds 512 KiB. Narrow the report interval or metric groups.');
    if (bytes + size > 512 * 1024) break;
    page.push(row);
    bytes += size;
  }
  return page;
}
