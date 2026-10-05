// Writes docs/README.md, the map of AMCP's documentation (F-68), from the documents themselves: each is listed with
// its own title. A guide or review must be placed in a section below, so a new one cannot go unlisted; implementation
// records are grouped by the platform their file name starts with, and paired with their verification evidence.
// Usage: node tools/docs-index.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const docs = fileURLToPath(new URL('../docs/', import.meta.url)),
  target = path.join(docs, 'README.md');
const sections = [
  ['Start here', ['CURRENT-READINESS.md', 'review/SUMMARY.md', 'review/ARCHITECTURE.md', 'CONTRACTS.md']],
  [
    'October 2026 review',
    [
      'review/IMPLEMENTATION-2026-10-01.md',
      'review/DELIVERY-2026-10-01-OPERATIONS.md',
      'review/DELIVERY-2026-10-01-CREATIVE-REPORTS.md',
      'review/DELIVERY-2026-10-01-LAUNCH-MEASUREMENT.md',
      'review/DELIVERY-2026-10-01-PROFILE-BRANDING.md',
      'review/DELIVERY-2026-10-01-ALLOCATION.md',
      'review/DELIVERY-2026-10-01-META-PORTFOLIO.md',
      'review/DELIVERY-2026-10-01-WORKBOOK-OPERATIONS.md',
      'review/DELIVERY-2026-10-01-WORKBOOK-SCHEDULES.md',
      'review/DELIVERY-2026-10-01-REPORT-FILES.md',
      'review/DELIVERY-2026-10-01-ALLOCATION-PLANS.md',
      'review/DELIVERY-2026-10-01-MONITOR-DELIVERY.md',
      'review/DELIVERY-2026-10-01-REPORTING-MANAGEMENT.md',
      'review/DELIVERY-2026-10-01-ARABIC-FOUNDATION.md',
      'review/DELIVERY-2026-10-01-ARABIC-CONNECTIONS.md',
      'review/DELIVERY-2026-10-01-ARABIC-CAMPAIGNS.md',
      'review/DELIVERY-2026-10-01-ARABIC-OPERATIONS.md',
      'review/DELIVERY-2026-10-01-ARABIC-REPORTING.md',
      'review/DELIVERY-2026-10-01-ARABIC-ACCOUNT-WORKFLOWS.md',
      'review/DELIVERY-2026-10-01-ARABIC-CLIENT-PLAYBOOKS.md',
      'review/DELIVERY-2026-10-01-ARABIC-EVIDENCE-ALLOCATION.md',
      'review/DELIVERY-2026-10-01-ARABIC-ANALYSIS.md',
      'review/DELIVERY-2026-10-01-LINKEDIN-EVIDENCE.md',
      'review/DELIVERY-2026-10-01-LINKEDIN-OVERVIEW.md',
      'review/DELIVERY-2026-10-01-REPORT-RECONCILIATION.md',
      'review/DELIVERY-2026-10-01-REFERENCE-IMPORT.md',
      'review/DELIVERY-2026-10-01-ARTIFACT-LOCALIZATION.md',
      'review/DELIVERY-2026-10-02-WORKBOOK-BINDINGS.md',
      'review/DELIVERY-2026-10-02-QUERY-SCALING.md',
      'review/DELIVERY-2026-10-02-WORKBOOK-REBINDING.md',
      'review/DELIVERY-2026-10-02-WORKBOOK-RETIREMENT.md',
      'review/DELIVERY-2026-10-02-LINKEDIN-PORTFOLIO.md',
      'review/DELIVERY-2026-10-02-AUDIT-HISTORY.md',
      'review/DELIVERY-2026-10-02-MEASUREMENT-EVENTS.md',
      'review/DELIVERY-2026-10-02-CATALOG-MAPPING.md',
      'review/DELIVERY-2026-10-02-SNAPCHAT-PORTFOLIO.md',
      'review/DELIVERY-2026-10-02-GOOGLE-PORTFOLIO.md',
      'review/DELIVERY-2026-10-02-TIKTOK-PORTFOLIO.md',
      'review/DELIVERY-2026-10-02-ACCOUNT-EXPLANATIONS.md',
      'review/DELIVERY-2026-10-02-X-PORTFOLIO.md',
      'review/DELIVERY-2026-10-02-TIKTOK-EVIDENCE.md',
      'review/DELIVERY-2026-10-02-TIKTOK-REPORT-COMPLETION.md',
      'review/DELIVERY-2026-10-02-EVIDENCE-ROWS.md',
      'review/DELIVERY-2026-10-02-EVIDENCE-ARTIFACTS.md',
      'review/DELIVERY-2026-10-02-GTM-CONSENT.md',
      'review/DELIVERY-2026-10-02-GOOGLE-EVIDENCE-INTEGRITY.md',
      'review/DELIVERY-2026-10-02-META-EVIDENCE-INTEGRITY.md',
      'review/DELIVERY-2026-10-02-EVIDENCE-ROW-TOOLS.md',
      'review/DELIVERY-2026-10-02-LINKEDIN-EVIDENCE-INTEGRITY.md',
      'review/DELIVERY-2026-10-02-LINKEDIN-CONVERSION-EVIDENCE.md',
      'review/DELIVERY-2026-10-02-SEARCH-EXCLUSION-PLANS.md',
      'review/DELIVERY-2026-10-02-ROUTE-ASSETS.md',
      'review/DELIVERY-2026-10-02-GOOGLE-CLICKS-RECIPE.md',
      'review/DELIVERY-2026-10-02-SNAPCHAT-EVIDENCE.md',
      'review/DELIVERY-2026-10-03-CATALOG-EVIDENCE.md',
      'review/DELIVERY-2026-10-03-RECIPE-ELIGIBILITY.md',
      'review/DELIVERY-2026-10-03-SNAPCHAT-SQUAD-EVIDENCE.md',
      'review/DELIVERY-2026-10-03-SNAPCHAT-ALLOCATION.md',
      'review/DELIVERY-2026-10-03-BROWSER-ALLOCATION.md',
      'review/DELIVERY-2026-10-03-ALLOCATION-REVIEW.md',
      'review/DELIVERY-2026-10-03-MEASUREMENT-IDENTITY.md',
      'review/DELIVERY-2026-10-03-CONVERSION-REFERENCES.md',
      'review/DELIVERY-2026-10-03-RETAINED-ORIGINALS.md',
      'review/DELIVERY-2026-10-03-LINKED-AD-PERFORMANCE.md',
      'review/DELIVERY-2026-10-03-TOOL-TIMINGS.md',
      'review/DELIVERY-2026-10-03-REPORT-BODY-SCOPE.md',
      'review/DELIVERY-2026-10-03-CATALOG-COMPARISON.md',
      'review/DELIVERY-2026-10-03-GOOGLE-CONVERSION-RECIPES.md',
      'review/DELIVERY-2026-10-03-GOOGLE-GOAL-INSPECTION.md',
      'review/DELIVERY-2026-10-03-REPORT-RESOURCE-SCOPE.md',
      'review/DELIVERY-2026-10-03-RAILWAY-REPORT.md',
      'review/DELIVERY-2026-10-03-REPORT-PARENT-SCOPE.md',
      'review/DELIVERY-2026-10-03-SNAPCHAT-TRAFFIC.md',
      'review/DELIVERY-2026-10-03-TEST-WORKERS.md',
      'review/DELIVERY-2026-10-04-ABOUT.md',
      'review/DELIVERY-2026-10-04-SNAPCHAT-LEADS.md',
      'review/DELIVERY-2026-10-04-SNAPCHAT-NATIVE-LEADS.md',
      'review/DELIVERY-2026-10-04-EVIDENCE-INDEX.md',
      'review/DELIVERY-2026-10-04-GTM-CONSENT-PLANS.md',
      'review/DELIVERY-2026-10-04-LINKEDIN-ALLOCATION.md',
      'review/DELIVERY-2026-10-04-LINKEDIN-BUDGET-CONTEXT.md',
      'review/DELIVERY-2026-10-04-NATIVE-ASSET-REFERENCES.md',
      'review/DELIVERY-2026-10-04-ALLOCATION-CALIBRATION.md',
      'review/DELIVERY-2026-10-04-SCHEDULER-WORKERS.md',
      'review/DELIVERY-2026-10-04-X-CATALOG-PRICES.md',
      'review/DELIVERY-2026-10-04-X-CATALOG-IMPORT.md',
      'review/DELIVERY-2026-10-04-X-CATALOG-COMPARISON.md',
      'review/DELIVERY-2026-10-04-X-CATALOG-IDENTITIES.md',
      'review/DELIVERY-2026-10-04-X-CATALOG-REMOVAL.md',
      'review/DELIVERY-2026-10-04-RELEASE-SOURCE.md',
      'review/DELIVERY-2026-10-04-GOOGLE-VALUE-RECIPES.md',
      'review/DELIVERY-2026-10-04-GOOGLE-VALUE-INSPECTION.md',
      'review/DELIVERY-2026-10-04-GOOGLE-CONVERSION-ACTIVITY.md',
      'review/DELIVERY-2026-10-04-GOOGLE-IMAGE-REFERENCES.md',
      'review/DELIVERY-2026-10-04-GOOGLE-PMAX-IMAGE-REFERENCES.md',
      'review/DELIVERY-2026-10-04-GOOGLE-PMAX-CAMPAIGN-LOGOS.md',
      'review/DELIVERY-2026-10-04-WOOCOMMERCE-SOURCE.md',
      'review/DELIVERY-2026-10-04-SNAPCHAT-TOP-SNAP-REFERENCES.md',
      'review/DELIVERY-2026-10-04-META-CATALOG-FIELD-PROOF.md',
      'review/DELIVERY-2026-10-04-RENDERED-WORKFLOWS.md',
      'review/DELIVERY-2026-10-04-COMMERCE-READABILITY.md',
      'review/DELIVERY-2026-10-04-ARABIC-PRIVACY.md',
      'review/DELIVERY-2026-10-04-WOOCOMMERCE-VARIATIONS.md',
      'review/DELIVERY-2026-10-04-META-GROUP-CSV.md',
      'review/DELIVERY-2026-10-04-GA4-EVENT-LAYOUT.md',
      'review/DELIVERY-2026-10-04-RETAINED-ROW-BROWSING.md',
      'review/DELIVERY-2026-10-05-GOOGLE-KEYWORD-EVIDENCE.md',
      'review/DELIVERY-2026-10-05-EVIDENCE-CONTROL-LAYOUT.md',
      'review/DELIVERY-2026-10-05-GOOGLE-CAPTURE-RECOVERY.md',
      'review/DELIVERY-2026-10-05-GOOGLE-DEVICE-EVIDENCE.md',
      'review/DELIVERY-2026-10-05-PERSISTENT-CAPTURE-FEEDBACK.md',
      'review/DELIVERY-2026-10-05-PROVIDER-CAPTURE-LOCALIZATION.md',
      'review/DELIVERY-2026-10-05-WORKER-LOOP-RECOVERY.md',
      'review/DELIVERY-2026-10-05-MEASUREMENT-READ-FEEDBACK.md',
      'review/DELIVERY-2026-10-05-SHARED-RECOVERY-GUIDANCE.md',
      'review/DELIVERY-2026-10-05-WORKSPACE-FORM-FEEDBACK.md',
      'review/DELIVERY-2026-10-05-LINKEDIN-CONVERSION-METADATA.md',
      'review/DELIVERY-2026-10-05-MEASUREMENT-NAVIGATION.md',
      'review/DELIVERY-2026-10-05-PORTFOLIO-DIAGNOSTICS.md',
      'review/PRODUCT-BLUEPRINT-2026-10-01.md',
      'review/REVIEW-2026-10-01.md',
      'review/product/CONTRACTS-2026-10-01.md',
      'review/product/UX-2026-10-01.md',
      'review/product/WORKFLOWS-2026-10-01.md',
    ],
  ],
  [
    'Deploy and operate',
    [
      'DEPLOY-RAILWAY.md',
      'OPERATIONS.md',
      'LOCAL-BROWSER-QA.md',
      'USER-ACCOUNTS.md',
      'TEST-ACCOUNTS.md',
      'OAUTH-HARDENING.md',
      'GOOGLE-VERIFICATION.md',
      'SANDBOX-VERIFICATION.md',
    ],
  ],
  [
    'Writes, media and reporting',
    [
      'WRITE-OPERATIONS.md',
      'ADDING-A-REVIEWED-FAMILY.md',
      'MEDIA-UPLOADS.md',
      'AD-PREVIEWS.md',
      'REPORTING-OVERVIEW.md',
      'WORKSPACE-OPERATIONS.md',
      'PRODUCT-WORKFLOWS.md',
    ],
  ],
  ['Platforms', ['review/PLATFORMS.md', 'MEASUREMENT-AND-APPLE.md', 'MICROSOFT-ADS.md', 'REDDIT.md']],
  [
    'The September 2026 review',
    [
      'review/FINDINGS.md',
      'review/COVERAGE.md',
      'review/PERSONAL-DATA-POLICY.md',
      'review/THREAT-MODEL.md',
      'review/MCP-SECURITY-CALIBRATION.md',
      'review/ACCESSIBILITY.md',
      'review/ROADMAP.md',
      'review/PROGRESS.md',
    ],
  ],
  [
    'Earlier reviews',
    ['HARDENING-REVIEW.md', 'CAPABILITY-REVIEW-2026-09-08.md', 'RECOMMENDATIONS-IMPLEMENTED.md', 'AMCP-IDENTITY.md'],
  ],
];
const platforms = [
  ['GOOGLE', 'Google'],
  ['META', 'Meta'],
  ['TIKTOK', 'TikTok'],
  ['SNAPCHAT', 'Snapchat'],
  ['LINKEDIN', 'LinkedIn'],
  ['X', 'X'],
  ['DV360', 'Display & Video 360'],
  ['CRITEO', 'Criteo'],
];

const title = file => {
  const heading = fs.readFileSync(path.join(docs, file), 'utf8').match(/^# (.+)$/m);
  if (!heading) throw Error('docs/' + file + ' has no title (a "# " heading).');
  return heading[1].trim();
};
const markdown = directory =>
  fs
    .readdirSync(path.join(docs, directory))
    .filter(f => f.endsWith('.md') && !(directory === '' && f === 'README.md'))
    .map(f => (directory ? directory + '/' : '') + f);
const problems = [];
const placed = sections.flatMap(([, files]) => files);
for (const file of [...markdown(''), ...markdown('review')])
  if (!placed.includes(file)) problems.push('place docs/' + file + ' in a section of tools/docs-index.mjs');
for (const file of placed) if (!fs.existsSync(path.join(docs, file))) problems.push('docs/' + file + ' does not exist');
if (new Set(placed).size !== placed.length) problems.push('a document is placed twice');

const lines = [
  '# AMCP documentation',
  '',
  'Generated by `npm run docs:index` from the documents themselves; `npm run check` fails when it is out of date. Start',
  'with the [repository README](../README.md) for what AMCP is.',
  '',
];
for (const [name, files] of sections) {
  lines.push('## ' + name, '');
  for (const file of files)
    if (fs.existsSync(path.join(docs, file))) lines.push('- [' + title(file) + '](' + file + ')');
  lines.push('');
}

// Implementation records: a dated account of how one family or change was built and verified. A record's
// NAME-VERIFICATION-DATE.json holds its machine-checked evidence.
const implementation = fs.readdirSync(path.join(docs, 'implementation')).sort();
const evidenceOf = file => file.replace(/-(\d{4}-\d{2}-\d{2})\.md$/, '-VERIFICATION-$1.json');
const records = implementation
  .filter(f => f.endsWith('.md'))
  .map(file => {
    const evidence = evidenceOf(file),
      prefix = file.split('-')[0],
      platform = platforms.find(([p]) => p === prefix);
    return {
      file,
      date: file.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '',
      title: title('implementation/' + file)
        .replace(/\s+[—-]\s+\d{4}-\d{2}-\d{2}$/, '')
        .replace(/\s+\(\d{4}-\d{2}-\d{2}\)$/, ''),
      evidence: evidence !== file && implementation.includes(evidence) ? evidence : undefined,
      group: platform ? platform[1] : 'Across platforms',
    };
  });
const paired = new Set(records.map(r => r.evidence).filter(Boolean));
lines.push(
  '## Implementation records',
  '',
  'How each reviewed family or change was built and verified, newest first within each platform. A record’s',
  'verification file holds its machine-checked evidence.',
  '',
);
for (const group of [...platforms.map(([, name]) => name), 'Across platforms']) {
  const rows = records
    .filter(r => r.group === group)
    .sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file));
  if (!rows.length) continue;
  lines.push('### ' + group, '', '| Date | Record | Evidence |', '|---|---|---|');
  for (const r of rows)
    lines.push(
      '| ' +
        (r.date || '—') +
        ' | [' +
        r.title.replace(/\|/g, '\\|') +
        '](implementation/' +
        r.file +
        ') | ' +
        (r.evidence ? '[verification](implementation/' + r.evidence + ')' : '') +
        ' |',
    );
  lines.push('');
}
const data = implementation.filter(f => !f.endsWith('.md') && !paired.has(f));
lines.push('### Ledgers and data', '');
for (const file of data) lines.push('- [' + file + '](implementation/' + file + ')');
const text = lines.join('\n') + '\n';

if (problems.length) {
  console.error('Documentation index: ' + problems.join('; '));
  process.exit(1);
}
if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) {
    console.error('docs/README.md is out of date. Run npm run docs:index.');
    process.exit(1);
  }
  console.log('docs/README.md lists ' + (placed.length + records.length + data.length) + ' documents.');
} else {
  fs.writeFileSync(target, text);
  console.log('Wrote docs/README.md: ' + (placed.length + records.length + data.length) + ' documents.');
}
