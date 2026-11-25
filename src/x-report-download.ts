import {randomUUID} from 'node:crypto';
import {request} from 'node:https';
import {Readable} from 'node:stream';
import {gunzipSync} from 'node:zlib';
import {MirrorError} from './errors.js';
import {familyCodeError, type OneCodeRefusal} from './family-kit.js';
import {bridgeResponse} from './media-link.js';
import {collectionRequestTimeout, collectionResponseBytes} from './report-collection-budget.js';
import type {NativeReportJob, ReportJobPage} from './report-job.js';
import {sha256, stable} from './security.js';
import {holdsLock} from './service-lock-repository.js';
import {publicReportAddress, reportDns} from './microsoft-report-download.js';
import {
  observeXReport,
  validateXReportData,
  xReportIdentity,
  xReportPlan,
  xReportRoute,
  xReportStatus,
  xReportStatusData,
} from './x-report-jobs.js';
import type {CompiledRequest, JsonObject} from './types.js';

const compressedLimit = 8 * 1024 * 1024,
  expandedLimit = 32 * 1024 * 1024;
const fail: OneCodeRefusal = familyCodeError('X_REPORT_DOWNLOAD_INVALID', 502);
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
      bridgeResponse(
        resolve,
        reject,
        res =>
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
  const signal = AbortSignal.timeout(
    collectionRequestTimeout(Math.max(1, Math.ceil(Math.min(30000, deadline - performance.now())))),
  );
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
      collectionResponseBytes(value.length);
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
/**
 * The validated result of one original X job, one page at a time (download_report): the first read downloads it under
 * the job's lock and one of two memory slots, checks the job once more and retains it encrypted for at most six hours;
 * every read checks the actor, the connection, the scope and the login first. It moved here from MirrorService
 * (ARC-04 stage F); the read path's checks arrive as the hooks of `page`.
 */
export async function retrieveXReport(plan: CompiledRequest, row: JsonObject, page: ReportJobPage) {
  const {store, actor, credentials} = page,
    connectionId = page.connection.id;
  const access = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, plan.gateway, plan.accountId, connectionId);
    page.authorize(plan, c);
    if (xReportIdentity(store.credentials(actor.tenantId, c.id)) !== xReportIdentity(credentials))
      throw new MirrorError('X_REPORT_LOGIN_CHANGED', 'The X login changed during retrieval.', {}, 403);
  };
  access();
  const b = plan.xReportRead![0]!,
    {offset, limit} = plan.reportDownload!,
    next = (at: number) => ({
      tool: plan.gateway,
      arguments: {
        action: 'x_stats_jobs_accounts_account_id_get',
        account_id: plan.accountId,
        connection_id: connectionId,
        params: {job_ids: b.job_id},
        download_report: true,
        offset: at,
        limit,
        dry_run: false,
      },
    });
  if (row.status === 'PROCESSING')
    return {
      data: [],
      report: {
        job_id: b.job_id,
        account_id: b.account_id,
        status: 'PROCESSING',
        complete: false,
        report_rows_downloaded: false,
        next_call: next(offset),
      },
    };
  if (row.status !== 'SUCCESS')
    throw new MirrorError(
      row.status === 'FAILED' ? 'X_REPORT_FAILED' : 'X_REPORT_CANCELLED',
      'The original X report did not complete. Inspect the retained definition before explicitly preparing a new job.',
      {job_id: b.job_id, provider_status: row.status},
      502,
    );
  if (Date.parse(row.expires_at) <= Date.now())
    throw new MirrorError(
      'X_REPORT_EXPIRED',
      'The native X result expired. This does not authorize another submission.',
      {job_id: b.job_id},
      410,
    );
  const key = sha256(connectionId + ':' + b.job_id),
    lock = 'x-report-result:' + actor.tenantId + ':' + key,
    owner = randomUUID();
  if (!store.acquireLock(lock, owner, 120000))
    throw new MirrorError(
      'X_REPORT_DOWNLOAD_BUSY',
      'This original report is already being retrieved. Retry the same read shortly.',
      {retry_after_ms: 1000},
      409,
      true,
    );
  let slot: string | undefined;
  try {
    slot = [0, 1].map(i => 'x-report-memory:' + i).find(k => store.acquireLock(k, owner, 120000));
    if (!slot)
      throw new MirrorError(
        'X_REPORT_DOWNLOAD_BUSY',
        'Two report results are already being read in this deployment. Retry this same read shortly.',
        {retry_after_ms: 1000},
        429,
        true,
      );
    let parsed = store.xReportResult(actor.tenantId, key);
    if (!parsed) {
      parsed = await downloadXReport(row, b, access, page.fetcher, plan.xReportDeadline);
      access();
      // A final native check catches cancellation/replacement/expiry during transfer.
      const check = {...plan, reportDownload: undefined},
        current = store.resolveConnection(actor, plan.gateway, plan.accountId, connectionId),
        guard = page.authority(check, current, access);
      const response = await page.request(check, guard);
      access();
      const final = xReportStatus(check, response)[0]!;
      if (final.status !== 'SUCCESS' || Date.parse(final.expires_at) <= Date.now())
        throw new MirrorError(
          'X_REPORT_STATE_UNVERIFIED',
          'The report stopped being available while its result was downloaded.',
          {},
          502,
        );
      if ([lock, slot].some(k => !holdsLock(store, k, owner, Date.now())))
        throw new MirrorError(
          'X_REPORT_DOWNLOAD_BUSY',
          'Result retrieval lost its lease. Retry the original read.',
          {},
          409,
          true,
        );
      parsed = {
        ...parsed,
        binding_sha256: sha256(
          stable({definition: b.definition, login: b.login_fingerprint, account: b.account_id, job: b.job_id}),
        ),
      };
      store.saveXReportResult(
        actor.tenantId,
        key,
        parsed,
        Math.min(Date.parse(final.expires_at), Date.now() + 6 * 3600000),
      );
    }
    access();
    if (
      parsed.binding_sha256 !==
      sha256(stable({definition: b.definition, login: b.login_fingerprint, account: b.account_id, job: b.job_id}))
    )
      throw new MirrorError(
        'X_REPORT_STATE_UNVERIFIED',
        'The retained report no longer matches the original definition.',
        {},
        502,
      );
    const rows = xReportPage(parsed.data, offset, limit),
      more = offset + rows.length < parsed.data.length;
    return {
      data: rows,
      report: {
        ...parsed.report,
        status: 'SUCCESS',
        source_complete: parsed.report.complete,
        complete: parsed.report.complete && !more && offset === 0,
        download_complete: true,
        source_rows: parsed.data.length,
        returned_rows: rows.length,
        offset,
        limit,
        has_more: more,
        ...(more ? {next_call: next(offset + rows.length)} : {}),
      },
    };
  } finally {
    if (slot) store.releaseLock(slot, owner);
    store.releaseLock(lock, owner);
  }
}
/**
 * X's asynchronous analytics jobs on the native read path (ARC-04 stage F, src/report-job.ts): explicit job_ids only and
 * never aggregated; a status read keeps a 60-second deadline and its login; a page is the jobs' status, or with
 * download_report the validated result of one original job (retrieveXReport).
 */
export const xReportJob: NativeReportJob = {
  gateway: 'x_ads_native_action',
  plan: (request, input) => xReportPlan(request, input),
  admit(p, input) {
    if (xReportRoute(p) && (input.aggregate_pages || input.paginate || input.allPages))
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'Poll explicit job_ids. Download one original job with offset/limit; do not aggregate job discovery.',
      );
    if (xReportRoute(p) === 'status') p = {...p, xReportDeadline: performance.now() + 60000};
    return p;
  },
  sameLogin: p => !!p.xReportRead,
  page(p, page) {
    if (!p.xReportRead) return undefined;
    const rows = xReportStatus(p, page.result);
    observeXReport(p, page.connection, page.store, rows);
    if (p.reportDownload) return retrieveXReport(p, rows[0]!, page);
    return xReportStatusData(p, page.result);
  },
};
