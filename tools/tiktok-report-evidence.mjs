import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const directory = process.argv[process.argv.indexOf('--source-dir') + 1];
if (!process.argv.includes('--source-dir') || !directory)
  throw Error('Supply --source-dir containing the public TikTok SDK ReportTaskCreateBody.md and TaskCancelBody.md.');
const models = {};
for (const name of ['ReportTaskCreateBody', 'TaskCancelBody']) {
  const bytes = fs.readFileSync(path.join(directory, name + '.md')),
    text = bytes.toString('utf8');
  const fields = [...text.matchAll(/^\*\*([a-z_]+)\*\* \| (.+)$/gm)].map(m => ({
    name: m[1],
    required: m[2].includes('[required]'),
  }));
  if (!fields.length) throw Error('SDK model properties disappeared: ' + name);
  models[name] = {
    url: 'https://raw.githubusercontent.com/tiktok/tiktok-business-api-sdk/main/python_sdk/docs/' + name + '.md',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    fields,
  };
}
const fixture = {
  version: 'v1.3',
  checked_at: '2026-09-24',
  models,
  manual_browser_evidence: {
    meaning:
      'Native response/lifecycle fields read from the rendered official portal, not generated from the captured action catalog. No live API calls.',
    sources: [
      'create-an-asynchronous-report-task',
      'get-the-status-of-an-async-report-task',
      'download-the-output-of-an-async-report-task',
      'cancel-an-asynchronous-report-task',
      'get-ad-account-details',
    ].map(slug => 'https://business-api.tiktok.com/portal/docs/' + slug + '/v1.3'),
    origin: 'https://business-api.tiktok.com',
    prefix: '/open_api/v1.3/report/task/',
    response_envelope: ['code', 'message', 'request_id', 'data'],
    create_data: ['task_id'],
    check_data: ['status', 'message'],
    cancel_data: ['status'],
    statuses: ['QUEUING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELED'],
    cancel_status: 'CANCELED',
    stream_format: 'CSV_STRING',
    signed_formats: ['CSV_DOWNLOAD', 'XLSX_DOWNLOAD'],
    task_validity_days: 30,
    signed_url_validity_seconds: 3600,
    same_access_token_required: true,
    pagination_supported: false,
    create_app_qps: 1,
    create_account_hourly_limit: 500,
    known_dimension_alias: {country_code: 'country_name'},
    account_fields: ['advertiser_id', 'currency', 'timezone'],
  },
};
const file = 'tests/fixtures/tiktok-report-v13.json',
  text = JSON.stringify(fixture, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(file, 'utf8') !== text)
    throw Error('TikTok report evidence drifted; review native changes before regenerating.');
} else fs.writeFileSync(file, text);
console.log(
  'Verified two official SDK model field sets and hashes; portal lifecycle/response observations remain explicitly manual.',
);
