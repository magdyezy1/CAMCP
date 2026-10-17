// Records the pin the TikTok measurement ledger needs before it sends "Get Pixel Event statistics" (MSR-03 slice D):
// TikTok's official Business API SDK specification of the request, yml_files/pixel_event_stats.yml of
// tiktok/tiktok-business-api-sdk at one full commit, with its SHA-256 and the request fields it documents. No
// credentials or network: the operator downloads that file at a commit and runs
//   node tools/tiktok-event-stats-pin.mjs --source-file <file> --commit <40-hex commit>          (writes the pin)
//   node tools/tiktok-event-stats-pin.mjs --source-file <file> --commit <40-hex commit> --check  (fails when the
//                                                                                                 committed pin differs)
// TikTok's yml_files state the path relative to the SDK base (/pixel/event/stats/), so also download
// java_sdk/docs/MeasurementApi.md at the same commit and pass it with --route-file <file>: it states the base URL and
// the full GET route, and its SHA-256 is pinned as route_source.
// Options: --out <path> (default .mirror/VENDOR/tiktok-pixel-event-stats.json), --checked-at YYYY-MM-DD (default
// today, UTC) and --date-format YYYY-MM-DD, only when the specification states that format (it did not on 2026-10-17;
// AMCP then sends YYYY-MM-DD as a guess and keeps the day basis unconfirmed).
// It refuses a file that does not document the route and every field AMCP sends (advertiser_id, pixel_ids, date_range
// with start_date and end_date). src/measurement-ledger-tiktok.ts reads the pin and sends nothing without it.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const pinPath = '.mirror/VENDOR/tiktok-pixel-event-stats.json';
export const repository = 'tiktok/tiktok-business-api-sdk';
export const specificationPath = 'yml_files/pixel_event_stats.yml';
export const routePath = '/open_api/v1.3/pixel/event/stats/';
// The SDK's yml_files document paths relative to the SDK's base (servers: business-api.tiktok.com), e.g.
// /pixel/event/stats/ (observed at commit f809c396 on 2026-10-17). The same commit's generated API reference documents
// the full route, so a relative specification is accepted only together with that reference.
export const relativeSpecificationPath = '/pixel/event/stats/';
export const routeReferencePath = 'java_sdk/docs/MeasurementApi.md';
export const routeBase = 'https://business-api.tiktok.com';
const queryFields = ['advertiser_id', 'date_range', 'pixel_ids'],
  dateRangeFields = ['end_date', 'start_date'];
const escape = value => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const asBuffer = bytes => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8'));
const documentsPath = (text, route) => new RegExp('^\\s*[\'"]?' + escape(route) + '[\'"]?\\s*:\\s*$', 'm').test(text);
const rawUrl = (commit, file) => 'https://raw.githubusercontent.com/' + repository + '/' + commit + '/' + file;

/**
 * The pin for one copy of the specification (its bytes), or an Error naming what the file does not document. A
 * specification that documents only the SDK-relative path also needs `routeBytes`: the same commit's generated API
 * reference, which must state the base URL and the full GET route; its digest is pinned as `route_source`.
 */
export function tiktokEventStatsPinFrom(bytes, {commit, checkedAt, dateFormat = null, routeBytes} = {}) {
  const file = asBuffer(bytes),
    text = file.toString('utf8');
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))
    throw Error('Name the full 40-character commit of ' + repository + ' the file was downloaded from.');
  if (typeof checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) throw Error('checked_at is a date.');
  if (dateFormat !== null && dateFormat !== 'YYYY-MM-DD')
    throw Error('AMCP sends YYYY-MM-DD dates; a specification stating another format needs a code change first.');
  const missing = [];
  let routeSource;
  if (!documentsPath(text, routePath)) {
    if (!documentsPath(text, relativeSpecificationPath)) missing.push(routePath);
    else if (routeBytes === undefined)
      missing.push(
        routePath +
          ' (the file documents ' +
          relativeSpecificationPath +
          '; add --route-file ' +
          routeReferencePath +
          ')',
      );
    else {
      const route = asBuffer(routeBytes),
        reference = route.toString('utf8');
      const base = new RegExp('relative to \\*' + escape(routeBase) + '\\*', 'i').test(reference),
        get = new RegExp('\\*\\*GET\\*\\*\\s+' + escape(routePath) + '(\\s|\\|)').test(reference);
      if (!base) missing.push(routeReferencePath + ': the base URL ' + routeBase);
      if (!get) missing.push(routeReferencePath + ': GET ' + routePath);
      routeSource = {
        repository,
        path: routeReferencePath,
        commit,
        url: rawUrl(commit, routeReferencePath),
        sha256: createHash('sha256').update(route).digest('hex'),
        base: routeBase,
      };
    }
  }
  if (!/^\s*get\s*:\s*$/im.test(text)) missing.push('a GET operation');
  for (const field of queryFields)
    if (!new RegExp('^\\s*-?\\s*name\\s*:\\s*[\'"]?' + field + '[\'"]?\\s*$', 'm').test(text)) missing.push(field);
  for (const field of dateRangeFields)
    if (!new RegExp('^\\s*[\'"]?' + field + '[\'"]?\\s*:', 'm').test(text)) missing.push('date_range.' + field);
  if (missing.length) throw Error('The specification does not document: ' + missing.join(', ') + '.');
  return {
    schema_version: 1,
    operation: 'Get Pixel Event statistics',
    source: {
      repository,
      path: specificationPath,
      commit,
      url: rawUrl(commit, specificationPath),
      sha256: createHash('sha256').update(file).digest('hex'),
      checked_at: checkedAt,
    },
    ...(routeSource ? {route_source: routeSource} : {}),
    request: {method: 'GET', path: routePath, query: queryFields, date_range: dateRangeFields, date_format: dateFormat},
  };
}

function option(args, name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    file = option(args, '--source-file'),
    out = option(args, '--out') ?? pinPath;
  try {
    if (!file) throw Error('Name the downloaded ' + specificationPath + ' with --source-file.');
    const routeFile = option(args, '--route-file');
    const pin = tiktokEventStatsPinFrom(fs.readFileSync(file), {
        commit: option(args, '--commit'),
        checkedAt: option(args, '--checked-at') ?? new Date().toISOString().slice(0, 10),
        dateFormat: option(args, '--date-format') ?? null,
        ...(routeFile ? {routeBytes: fs.readFileSync(routeFile)} : {}),
      }),
      text = JSON.stringify(pin, null, 2) + '\n';
    if (args.includes('--check')) {
      const committed = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : undefined;
      const same =
        committed &&
        JSON.stringify({...committed.source, checked_at: null}) === JSON.stringify({...pin.source, checked_at: null}) &&
        JSON.stringify(committed.route_source ?? null) === JSON.stringify(pin.route_source ?? null) &&
        JSON.stringify(committed.request) === JSON.stringify(pin.request);
      if (!same) throw Error(out + ' does not pin this file at this commit.');
      console.log(out + ' pins ' + pin.source.url + ' (sha256 ' + pin.source.sha256 + ').');
    } else {
      fs.mkdirSync(path.dirname(out), {recursive: true});
      fs.writeFileSync(out, text);
      console.log('Pinned ' + pin.source.url + ' (sha256 ' + pin.source.sha256 + ') in ' + out + '.');
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
