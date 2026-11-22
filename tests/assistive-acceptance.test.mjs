// ACC-07: the finite manual assistive-technology acceptance (tools/acceptance/assistive-results.mjs). Before it, the
// accessibility acceptance was open-ended ("full accessibility certification") and no screen-reader session could be
// recorded or closed. The protocol is now 7 journeys x 2 screen readers x 2 languages = 28 sessions on registered pages;
// a record is accepted only with all 28 passed and no blocking issue open, and it holds references only. The fixture
// host serves one journey's synthetic workspace on loopback with a one-time sign-in and reaches no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  assistiveCheckpoints,
  assistiveJourneys,
  assistiveLanguages,
  assistiveOutcome,
  assistiveSessions,
  assistiveSummary,
  assistiveTechnologies,
  assistiveTemplate,
  journeyLabels,
  protocolDigest,
  serveJourney,
  validateAssistiveRecord,
} from '../tools/acceptance/assistive-results.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const today = '2026-10-15',
  release = {revision: 'abcdef1', package_sha256: 'a'.repeat(64)},
  ios = 'voiceover-safari-ios',
  nvda = 'nvda-chrome-windows';

/** A record of 28 passed sessions; `mutate` changes it before it is returned. */
function filled(mutate) {
  const record = assistiveTemplate();
  record.release = {...release};
  record.sessions = record.sessions.map(s => ({
    ...s,
    result: 'pass',
    environment: s.assistive_technology === ios ? 'staging' : 'fixture',
    date: '2026-10-14',
    tester: 'tester-a',
    versions:
      s.assistive_technology === ios
        ? {screen_reader: 'VoiceOver', browser: 'Safari 26', os: 'iOS 26.0'}
        : {screen_reader: 'NVDA 2026.2', browser: 'Chrome 141', os: 'Windows 11'},
    minutes: s.language === 'ar' ? 14 : 10,
    checkpoints: Object.fromEntries(
      assistiveCheckpoints.map(c => [c.id, c.only && c.only !== s.assistive_technology ? 'not_applicable' : 'pass']),
    ),
    issues: [],
  }));
  mutate?.(record);
  return record;
}
const sessionOf = (record, journey, technology, language) =>
  record.sessions.find(s => s.journey === journey && s.assistive_technology === technology && s.language === language);
/** Adds an issue to the session it was found in. */
function addIssue(record, issue) {
  record.issues.push(issue);
  sessionOf(record, issue.journey, issue.assistive_technology, issue.language).issues.push(issue.id);
}
const blocking = {
  id: 'AT-001',
  journey: 'report-export',
  assistive_technology: ios,
  language: 'ar',
  checkpoint: 'C6',
  severity: 'blocking',
  summary: 'The export confirmation dialog on /reporting-overview does not take VoiceOver focus.',
  status: 'open',
};

test('ACC-07 protocol: 28 sessions on registered pages, with Arabic for every page and control the tester hears', () => {
  assert.equal(assistiveJourneys.length, 7);
  assert.equal(assistiveTechnologies.length, 2);
  assert.deepEqual(assistiveLanguages, ['en', 'ar']);
  const sessions = assistiveSessions();
  assert.equal(sessions.length, 28);
  assert.equal(new Set(sessions.map(s => JSON.stringify(s))).size, 28);
  // Every journey starts on a page of the route registry, under its canonical name (owner decision D27).
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('web/routes.js', 'utf8') + ';this.registry = routeRegistry;', context);
  const routes = new Map(context.registry.map(r => [r.path, r]));
  for (const journey of assistiveJourneys) {
    assert.equal(routes.get(journey.route)?.label, journey.page, journey.id);
    assert.ok(routes.get(journey.route).nav, journey.id + ' starts on a navigation page');
  }
  // The page and controls the tester listens for are literal interface strings with an Arabic translation.
  const web = fs
    .readdirSync('web')
    .filter(f => f.endsWith('.js') || f.endsWith('.html'))
    .map(f => fs.readFileSync(path.join('web', f), 'utf8'))
    .join('\n');
  for (const [id, labels] of Object.entries(journeyLabels())) {
    assert.ok(labels.length >= 2, id);
    for (const {en, ar} of labels) {
      assert.ok(
        web.includes("'" + en + "'") || web.includes('"' + en + '"'),
        id + ': ' + en + ' is not interface text',
      );
      assert.ok(ar && ar !== en, id + ': ' + en + ' has no Arabic');
    }
  }
  // Each journey's fixture kind is one the browser fixture serves.
  const sites = fs.readFileSync('tests/fixtures/browser-workflow-sites.mjs', 'utf8');
  for (const journey of assistiveJourneys) assert.ok(sites.includes("'" + journey.fixture + "'"), journey.fixture);
  // Checkpoint applicability: six always apply, one per technology, four only where the element exists.
  assert.deepEqual(
    assistiveCheckpoints.filter(c => c.always).map(c => c.id),
    ['C1', 'C2', 'C4', 'C5', 'C9', 'C12'],
  );
  assert.deepEqual(
    assistiveCheckpoints.filter(c => c.only).map(c => [c.id, c.only]),
    [
      ['C10', ios],
      ['C11', nvda],
    ],
  );
  // The runbook states every journey with its exact boundary and every checkpoint with its exact text.
  const doc = fs.readFileSync('docs/acceptance/ASSISTIVE-TECHNOLOGY.md', 'utf8');
  for (const journey of assistiveJourneys) {
    assert.ok(
      doc.includes(
        '| `' + journey.id + '` | ' + journey.title + ' | ' + journey.page + ' | ' + journey.boundary + ' |',
      ),
      journey.id,
    );
    assert.ok(doc.includes('**`' + journey.id + '`.**'), journey.id + ' has its steps');
    for (const control of journey.controls) assert.ok(doc.includes('**' + control + '**'), journey.id + ': ' + control);
  }
  for (const checkpoint of assistiveCheckpoints)
    assert.ok(doc.includes('| ' + checkpoint.id + ' | ' + checkpoint.text + ' |'), checkpoint.id);
  // The digest follows the structure: another checkpoint changes it.
  const before = protocolDigest();
  assistiveCheckpoints.push({id: 'C13', text: 'Synthetic extra checkpoint.'});
  try {
    assert.notEqual(protocolDigest(), before);
  } finally {
    assistiveCheckpoints.pop();
  }
  assert.equal(protocolDigest(), before);
  assert.equal(assistiveTemplate().protocol_sha256, before);
});

test('ACC-07 template: refused until its release is filled, then valid and incomplete with nothing run', () => {
  const template = assistiveTemplate();
  assert.equal(template.sessions.length, 28);
  assert.ok(template.sessions.every(s => s.result === 'not_run'));
  // The checkpoint of the other technology is pre-marked not_applicable.
  assert.equal(sessionOf(template, 'ga4-events', nvda, 'ar').checkpoints.C10, 'not_applicable');
  assert.equal(sessionOf(template, 'ga4-events', ios, 'ar').checkpoints.C11, 'not_applicable');
  assert.ok(validateAssistiveRecord(template, today).some(p => /release is/.test(p)));
  template.release = {...release};
  assert.deepEqual(validateAssistiveRecord(template, today), []);
  assert.equal(assistiveOutcome(template), 'incomplete');
  assert.deepEqual(assistiveSummary(template).total.sessions, {pass: 0, fail: 0, not_run: 28});
});

test('ACC-07 record: all 28 passed with only non-blocking issues is accepted, and the summary counts per journey', () => {
  const record = filled(r => {
    addIssue(r, {
      id: 'AT-002',
      journey: 'connect-account',
      assistive_technology: nvda,
      language: 'ar',
      checkpoint: 'C4',
      severity: 'non_blocking',
      summary: 'The asset search field on /connections repeats its label twice.',
      status: 'open',
    });
    addIssue(r, {
      id: 'AT-003',
      journey: 'connect-account',
      assistive_technology: ios,
      language: 'en',
      checkpoint: 'C3',
      severity: 'non_blocking',
      summary: 'The platform grid has no heading of its own.',
      status: 'declined',
    });
  });
  assert.deepEqual(validateAssistiveRecord(record, today), []);
  assert.equal(assistiveOutcome(record), 'accepted');
  const summary = assistiveSummary(record);
  assert.equal(summary.outcome, 'accepted');
  assert.deepEqual(summary.total.sessions, {pass: 28, fail: 0, not_run: 0});
  assert.deepEqual(summary.total.non_blocking, {open: 1, fixed: 0, declined: 1});
  const connect = summary.journeys.find(j => j.journey === 'connect-account');
  assert.deepEqual(connect.sessions, {pass: 4, fail: 0, not_run: 0});
  assert.deepEqual(connect.non_blocking, {open: 1, fixed: 0, declined: 1});
  assert.equal(connect.median_minutes, 12);
  assert.equal(summary.journeys.length, 7);
});

test('ACC-07 record: an open blocking issue blocks acceptance until it is fixed and the session is run again', () => {
  const blocked = filled(r => {
    const s = sessionOf(r, blocking.journey, blocking.assistive_technology, blocking.language);
    s.result = 'fail';
    s.checkpoints.C6 = 'fail';
    addIssue(r, {...blocking});
  });
  assert.deepEqual(validateAssistiveRecord(blocked, today), []);
  assert.equal(assistiveOutcome(blocked), 'blocked');
  const summary = assistiveSummary(blocked);
  assert.deepEqual(summary.total.blocking, {open: 1, fixed: 0});
  assert.deepEqual(summary.journeys.find(j => j.journey === 'report-export').sessions, {pass: 3, fail: 1, not_run: 0});
  // An unrun session keeps the record incomplete, never accepted.
  const partial = filled(r => (sessionOf(r, 'ga4-events', ios, 'en').result = 'not_run'));
  assert.deepEqual(validateAssistiveRecord(partial, today), []);
  assert.equal(assistiveOutcome(partial), 'incomplete');
  // Fixed in a named commit and retested: the session passes again and the record is accepted.
  const fixed = filled(r => addIssue(r, {...blocking, status: 'fixed', fix_ref: '0123abcd', retested: true}));
  assert.deepEqual(validateAssistiveRecord(fixed, today), []);
  assert.equal(assistiveOutcome(fixed), 'accepted');
  assert.deepEqual(assistiveSummary(fixed).total.blocking, {open: 0, fixed: 1});
});

test('ACC-07 record: missing, repeated or inconsistent sessions, unsupported claims and private values are refused', () => {
  const ga4 = r => sessionOf(r, 'ga4-events', nvda, 'en');
  const withIssue = (extra, sessionChange) => r => {
    if (sessionChange) sessionChange(sessionOf(r, blocking.journey, blocking.assistive_technology, blocking.language));
    addIssue(r, {...blocking, ...extra});
  };
  const cases = [
    ['a missing session', r => r.sessions.pop(), /is missing/],
    ['a repeated session', r => r.sessions.push(structuredClone(r.sessions[0])), /recorded 2 times/],
    ['an unknown journey', r => (r.sessions[0].journey = 'checkout'), /not one of the 28 sessions/],
    ['a pass with a failed checkpoint', r => (ga4(r).checkpoints.C7 = 'fail'), /no failed checkpoint/],
    ['a failed checkpoint without its blocking issue', r => (ga4(r).checkpoints.C7 = 'fail'), /C7 failed: list/],
    ['a fail with nothing failed', r => (ga4(r).result = 'fail'), /marks the checkpoint that failed/],
    ['VoiceOver touch marked on an NVDA session', r => (ga4(r).checkpoints.C10 = 'pass'), /applies to voiceover/],
    ['an always checkpoint marked not applicable', r => (ga4(r).checkpoints.C1 = 'not_applicable'), /every journey/],
    ['a checkpoint missing', r => delete ga4(r).checkpoints.C12, /marks each of C1 to C12/],
    ['an open blocking issue on a passed checkpoint', withIssue({}), /mark C6 fail/],
    ['a declined blocking issue', withIssue({status: 'declined'}), /never declined/],
    ['a fix without its commit', withIssue({status: 'fixed', retested: true}), /fix_ref/],
    ['a fix not retested', withIssue({status: 'fixed', fix_ref: '0123abcd'}), /retested/],
    ['a fix reference on an open issue', withIssue({fix_ref: '0123abcd'}, s => (s.result = 'fail')), /only a fixed/],
    [
      'an issue of another session',
      r => (
        r.issues.push({...blocking, status: 'fixed', fix_ref: '0123abcd', retested: true}),
        ga4(r).issues.push('AT-001')
      ),
      /belongs to another session/,
    ],
    [
      'an issue no session lists',
      r => r.issues.push({...blocking, severity: 'non_blocking'}),
      /not listed by the session/,
    ],
    [
      'an issue in an unrun session',
      r => {
        sessionOf(r, blocking.journey, blocking.assistive_technology, blocking.language).result = 'not_run';
        addIssue(r, {...blocking, severity: 'non_blocking'});
      },
      /not run lists no issues/,
    ],
    ['a production environment', r => (ga4(r).environment = 'production'), /fixture or staging/],
    ['a future date', r => (ga4(r).date = '2026-10-16'), /not in the future/],
    ['an impossible date', r => (ga4(r).date = '2026-02-30'), /date is the day/],
    ['a tester named in full', r => (ga4(r).tester = 'Jane Doe'), /tester is a label/],
    ['an e-mail address', r => (ga4(r).tester = 'jane@example.com'), /e-mail address/],
    [
      'a URL',
      withIssue({severity: 'non_blocking', summary: 'See https://staging.example.com/reports for it.'}),
      /holds a URL/,
    ],
    ['the production site', r => (ga4(r).versions.browser = 'Chrome on amcp.shop'), /production site/],
    ['a token', withIssue({severity: 'non_blocking', summary: 'The header showed Bearer abc.def'}), /token-like/],
    [
      'an account ID',
      withIssue({severity: 'non_blocking', summary: 'Account 1234567890 is read as digits.'}),
      /long number/,
    ],
    ['an unknown session field', r => (ga4(r).screenshot = 'shot.png'), /unknown field screenshot/],
    ['an unknown record field', r => (r.notes = 'x'), /unknown field notes/],
    ['another protocol', r => (r.protocol_sha256 = 'b'.repeat(64)), /current protocol/],
    ['no release', r => delete r.release, /release is/],
    ['minutes out of range', r => (ga4(r).minutes = 0), /minutes is/],
    ['a malformed issue ID', withIssue({id: 'BUG-1', severity: 'non_blocking'}), /AT- and three digits/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const problems = validateAssistiveRecord(filled(mutate), today);
    assert.ok(
      problems.some(p => pattern.test(p)),
      label + ': ' + problems.join('; '),
    );
  }
  assert.deepEqual(validateAssistiveRecord({record_kind: 'other'}, today), [
    'the record is an ACC-07 assistive_acceptance record',
  ]);
});

test('ACC-07 CLI: template prints 28 sessions; check states the outcome and the record digest, and fails an invalid record', () => {
  const template = spawnSync(process.execPath, ['tools/acceptance/assistive-results.mjs', 'template'], {
    encoding: 'utf8',
  });
  assert.equal(template.status, 0, template.stderr);
  assert.equal(JSON.parse(template.stdout).sessions.length, 28);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-acc07-'));
  try {
    const file = path.join(dir, 'assistive.json'),
      bytes = JSON.stringify(filled(), null, 2);
    fs.writeFileSync(file, bytes);
    const check = spawnSync(process.execPath, ['tools/acceptance/assistive-results.mjs', 'check', file], {
      encoding: 'utf8',
    });
    assert.equal(check.status, 0, check.stderr);
    const out = JSON.parse(check.stdout);
    assert.equal(out.valid, true);
    assert.equal(out.outcome, 'accepted');
    assert.equal(out.record_sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(out.total.sessions, {pass: 28, fail: 0, not_run: 0});
    const summary = spawnSync(process.execPath, ['tools/acceptance/assistive-results.mjs', 'summary', file], {
      encoding: 'utf8',
    });
    assert.equal(summary.status, 0, summary.stderr);
    assert.equal(JSON.parse(summary.stdout).journeys.length, 7);
    fs.writeFileSync(file, JSON.stringify(filled(r => r.sessions.pop())));
    const invalid = spawnSync(process.execPath, ['tools/acceptance/assistive-results.mjs', 'check', file], {
      encoding: 'utf8',
    });
    assert.equal(invalid.status, 1);
    const refused = JSON.parse(invalid.stdout);
    assert.equal(refused.valid, false);
    assert.equal(refused.outcome, null);
    assert.ok(refused.problems.some(p => /is missing/.test(p)));
  } finally {
    removeTestDirectory(dir, 'amcp-acc07-');
  }
});

test('ACC-07 fixture host: a one-time loopback link signs in to the journey page, and nothing reaches a provider', async () => {
  const host = await serveJourney('report-export', {workIntervalMs: 100});
  try {
    assert.equal(host.helperAddress, '127.0.0.1');
    assert.match(host.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const helper = new URL(host.link);
    assert.equal(helper.hostname, '127.0.0.1');
    // Only GET of the exact link answers; anything else is not found.
    assert.equal((await fetch(helper.origin + '/sign-in/guess', {redirect: 'manual'})).status, 404);
    assert.equal((await fetch(host.link, {method: 'POST', redirect: 'manual'})).status, 404);
    const first = await fetch(host.link, {redirect: 'manual'});
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('location'), host.origin + '/reporting-overview');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const cookie = first.headers.get('set-cookie');
    assert.match(cookie, /^amcp_local_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax$/);
    // The link works once.
    const again = await fetch(host.link, {redirect: 'manual'});
    assert.equal(again.status, 410);
    assert.equal(again.headers.get('set-cookie'), null);
    const jar = {cookie: cookie.split(';')[0]};
    const session = await fetch(host.origin + '/api/session', {headers: jar}).then(r => r.json());
    assert.equal(session.authenticated, true);
    assert.equal((await fetch(host.origin + '/reporting-overview', {headers: jar})).status, 200);
    // Without the cookie the workspace is not signed in.
    assert.equal((await fetch(host.origin + '/api/session').then(r => r.json())).authenticated, false);
    // The report worker runs, and no provider request was sent or attempted.
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(host.counts(), {nativeReads: 0, refused: 0, writes: 0, syntheticWrites: 0});
  } finally {
    await host.close();
  }
  // The recovery journey starts with its synthetic plan saved, ready to end uncertain when run.
  const recovery = await serveJourney('operations-recovery');
  try {
    assert.match(recovery.seeded, /^[0-9a-f-]{36}$/);
    assert.equal(recovery.counts().writes, 0);
  } finally {
    await recovery.close();
  }
  // The schedule journey starts with one active daily schedule that the signed-in owner can pause and resume.
  const scheduled = await serveJourney('schedule-pause');
  try {
    const first = await fetch(scheduled.link, {redirect: 'manual'}),
      cookie = first.headers.get('set-cookie').split(';')[0],
      {csrf} = await fetch(scheduled.origin + '/api/session', {headers: {cookie}}).then(r => r.json());
    const overview = body =>
      fetch(scheduled.origin + '/api/workspace/overview', {
        method: 'POST',
        headers: {cookie, origin: scheduled.origin, 'x-amcp-csrf': csrf, 'content-type': 'application/json'},
        body: JSON.stringify(body),
      }).then(r => r.json());
    const listed = async () =>
      (await overview({action: 'bootstrap'})).data.schedules.find(s => s.id === scheduled.seeded);
    const before = await listed();
    assert.equal(before.is_active, true);
    const paused = await overview({
      action: 'pause_schedule',
      id: before.id,
      expected_revision: before.revision,
      confirmed: true,
    });
    assert.equal(paused.success, true, JSON.stringify(paused.error));
    const between = await listed();
    assert.equal(between.is_active, false);
    const resumed = await overview({
      action: 'resume_schedule',
      id: between.id,
      expected_revision: between.revision,
      confirmed: true,
    });
    assert.equal(resumed.success, true, JSON.stringify(resumed.error));
    assert.equal((await listed()).is_active, true);
    assert.deepEqual(scheduled.counts(), {nativeReads: 0, refused: 0, writes: 0, syntheticWrites: 0});
  } finally {
    await scheduled.close();
  }
  await assert.rejects(() => serveJourney('checkout'), /Name a journey/);
});

// The fixture host imports the browser fixtures from tests/fixtures (a dev-only harness): every journey's host is started
// here, so a fixture change that breaks one of the seven fails a test instead of the owner's session.
test('ACC-07 fixture host: every journey starts, signs in once to its own page and sends nothing to a provider', async () => {
  for (const journey of assistiveJourneys) {
    const host = await serveJourney(journey.id, {workIntervalMs: 100});
    try {
      assert.equal(host.kind, journey.fixture, journey.id);
      const first = await fetch(host.link, {redirect: 'manual'});
      assert.equal(first.status, 302, journey.id);
      assert.equal(first.headers.get('location'), host.origin + journey.route, journey.id);
      const cookie = first.headers.get('set-cookie').split(';')[0];
      const session = await fetch(host.origin + '/api/session', {headers: {cookie}}).then(r => r.json());
      assert.equal(session.authenticated, true, journey.id);
      assert.equal((await fetch(host.origin + journey.route, {headers: {cookie}})).status, 200, journey.id);
      if (journey.seed) assert.ok(host.seeded, journey.id + ' starts with its seeded record');
      assert.deepEqual(host.counts(), {nativeReads: 0, refused: 0, writes: 0, syntheticWrites: 0}, journey.id);
    } finally {
      await host.close();
    }
  }
});
