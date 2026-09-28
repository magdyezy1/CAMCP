import fs from 'node:fs';
import {createHash} from 'node:crypto';
const args = process.argv.slice(2),
  at = args.indexOf('--source'),
  source = args[at + 1],
  target = 'tests/fixtures/linkedin-recovery-evidence.json';
if (at < 0 || !source)
  throw Error('Supply --source with the public LinkedIn Videos API Markdown file; never a live account response.');
const bytes = fs.readFileSync(source),
  text = bytes.toString('utf8');
for (const token of [
  'li-lms-2026-05',
  'initializeVideoUploadResponse.uploadInstructions',
  'initializeVideoUploadResponse.uploadUrlsExpireAt',
  'finalizeUploadRequest.uploadedPartIds',
  'WAITING_UPLOAD',
  '4194303',
  '4194304',
])
  if (!text.includes(token)) throw Error('Public source lacks required contract evidence: ' + token);
const evidence = {
  format_version: 1,
  checked_at: '2026-09-25',
  meaning:
    'Public protocol evidence only. Resume safety is an AMCP inference from retained receipts, not a provider idempotency guarantee.',
  source: {
    url: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-05&accept=text/markdown',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    requested_version: '202605',
    returned_default_moniker: text.match(/^defaultMoniker: (.+)$/m)?.[1],
    source_date: text.match(/^ms.date: (.+)$/m)?.[1],
  },
  provider: {
    initialize_method: 'POST',
    initialize_path: '/rest/videos?action=initializeUpload',
    part_method: 'PUT',
    part_ranges: 'inclusive, contiguous, ordered',
    part_receipt: 'ETag header',
    finalize_path: '/rest/videos?action=finalizeUpload',
    finalize_fields: ['video', 'uploadToken', 'uploadedPartIds'],
    part_ids_order: 'original upload instruction order',
    expiry_field: 'uploadUrlsExpireAt',
    resume_required_state: 'WAITING_UPLOAD',
  },
  amcp: {
    session_version: 1,
    review_ms: 300000,
    lease_ms: 45000,
    heartbeat_ms: 15000,
    maximum_parts: 32,
    unknown_part_replay: false,
    finalization_replay: false,
    legacy_session_upgrade: false,
    live_verified: false,
  },
};
const output = JSON.stringify(evidence, null, 2) + '\n';
if (args.includes('--check')) {
  if (fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== output)
    throw Error('LinkedIn recovery evidence drift');
} else fs.writeFileSync(target, output);
console.log(JSON.stringify({path: target, sha256: evidence.source.sha256, check: args.includes('--check')}));
