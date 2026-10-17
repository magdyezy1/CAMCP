// Records the pin the TikTok measurement ledger needs before it sends "Get Pixel Event statistics" (MSR-03 slice D):
// TikTok's official Business API SDK specification of the request, yml_files/pixel_event_stats.yml of
// tiktok/tiktok-business-api-sdk at one full commit, with its SHA-256 and the request fields it documents. No
// credentials or network: the operator downloads that file at a commit and runs
//   node tools/tiktok-event-stats-pin.mjs --source-file <file> --commit <40-hex commit>          (writes the pin)
//   node tools/tiktok-event-stats-pin.mjs --source-file <file> --commit <40-hex commit> --check  (fails when the
//                                                                                                 committed pin differs)
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
const queryFields = ['advertiser_id', 'date_range', 'pixel_ids'],
  dateRangeFields = ['end_date', 'start_date'];
const escape = value => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The pin for one copy of the specification (its bytes), or an Error naming what the file does not document. */
export function tiktokEventStatsPinFrom(bytes, {commit, checkedAt, dateFormat = null}) {
  const file = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8'),
    text = file.toString('utf8');
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))
    throw Error('Name the full 40-character commit of ' + repository + ' the file was downloaded from.');
  if (typeof checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) throw Error('checked_at is a date.');
  if (dateFormat !== null && dateFormat !== 'YYYY-MM-DD')
    throw Error('AMCP sends YYYY-MM-DD dates; a specification stating another format needs a code change first.');
  const missing = [];
  if (!new RegExp('^\\s*[\'"]?' + escape(routePath) + '[\'"]?\\s*:\\s*$', 'm').test(text)) missing.push(routePath);
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
      url: 'https://raw.githubusercontent.com/' + repository + '/' + commit + '/' + specificationPath,
      sha256: createHash('sha256').update(file).digest('hex'),
      checked_at: checkedAt,
    },
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
    const pin = tiktokEventStatsPinFrom(fs.readFileSync(file), {
        commit: option(args, '--commit'),
        checkedAt: option(args, '--checked-at') ?? new Date().toISOString().slice(0, 10),
        dateFormat: option(args, '--date-format') ?? null,
      }),
      text = JSON.stringify(pin, null, 2) + '\n';
    if (args.includes('--check')) {
      const committed = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : undefined;
      const same =
        committed &&
        JSON.stringify({...committed.source, checked_at: null}) === JSON.stringify({...pin.source, checked_at: null}) &&
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
