import fs from 'node:fs';
import {createHash} from 'node:crypto';
const pos = process.argv.indexOf('--source'),
  source = process.argv[pos + 1];
if (pos < 0 || !source) throw Error('Supply the public X campaign-management/reference.md source.');
const bytes = fs.readFileSync(source),
  doc = bytes.toString('utf8');
const start = doc.indexOf('#### POST batch/accounts/:account\\_id/targeting\\_criteria['),
  end = doc.indexOf('#### DELETE accounts/', start);
if (start < 0 || end < start) throw Error('The native batch reference changed.');
const section = doc.slice(start, end);
for (const phrase of [
  'maximum batch size is 500',
  'application/json',
  'fail or succeed together',
  'preserve the item order',
  'operation_errors',
  '`Create`, `Delete`',
])
  if (!section.includes(phrase)) throw Error('Native batch evidence changed: ' + phrase);
const examples = [...section.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)].map(m => JSON.parse(m[1]));
if (
  examples.length !== 2 ||
  examples[0].length !== 2 ||
  examples[1].data.length !== 2 ||
  examples[0][1].operation_type !== 'Delete'
)
  throw Error('Native examples changed.');
const data =
    JSON.stringify(
      {
        checked_at: '2026-09-25',
        source: {
          url: 'https://docs.x.com/x-ads-api/campaign-management/reference.md',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        api_version: '12',
        route: '/12/batch/accounts/{account_id}/targeting_criteria',
        method: 'POST',
        content_type: 'application/json',
        documented_maximum: 500,
        operations: ['Create', 'Delete'],
        documented_atomicity: 'Whole batch succeeds or fails together; response order follows request order.',
        request_example: examples[0],
        response_example: examples[1],
        amcp_limits: {
          operations: 100,
          line_items: 20,
          private_references: 25,
          collection_rows: 10000,
          requests: 320,
          bytes: 8388608,
          deadline_ms: 60000,
        },
        unqualified_variants: [
          'TV_SHOW locale prerequisites',
          'APP_LIST/TAP exclusions',
          'preroll-only content targeting',
          'GTE/LT comparison operators',
          'active line items',
          'batches above AMCP capacity bounds',
        ],
        qualification: 'Public documentation and synthetic tests; no live provider calls or approval evidence.',
      },
      null,
      2,
    ) + '\n',
  file = 'tests/fixtures/x-targeting-batch-evidence.json';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(file, 'utf8') !== data) throw Error('Evidence drift requires manual review.');
} else fs.writeFileSync(file, data);
console.log('Verified X targeting batch route, atomicity, ordered examples and explicit AMCP bounds.');
