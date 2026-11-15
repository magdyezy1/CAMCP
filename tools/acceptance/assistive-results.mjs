// ACC-07: the finite manual assistive-technology acceptance of the website. Seven journeys, each run with two screen
// readers (NVDA with Chrome on Windows by keyboard, VoiceOver with Safari on iOS by touch) in English and in Arabic:
// 28 sessions, each recorded as pass, fail or not run against twelve checkpoints, with every issue found. This tool
// prints the blank record, validates a filled one (references only: no person, account ID, URL, token or production
// host) and summarizes it per journey. `serve` starts one journey's synthetic fixture host on this computer with a
// one-time sign-in link, for the NVDA sessions; every provider request is answered or refused by the fixture.
// docs/acceptance/ASSISTIVE-TECHNOLOGY.md is the protocol.
// Usage (after `npm run build`):
//   node tools/acceptance/assistive-results.mjs template               the blank 28-session record
//   node tools/acceptance/assistive-results.mjs check <record.json>    validate a filled record and state its outcome
//   node tools/acceptance/assistive-results.mjs summary <record.json>  sessions and issues per journey
//   node tools/acceptance/assistive-results.mjs serve <journey>        the synthetic fixture host of one journey
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The seven journeys: the page each starts on (its canonical name in web/routes.js), the controls the tester listens
 * for, where it stops and the synthetic fixture kind `serve` starts for it. Control names are the literal interface
 * strings; the Arabic session hears their translations (web/locales/ar.json).
 */
export const assistiveJourneys = [
  {
    id: 'connect-account',
    title: 'Connect and select an account',
    route: '/connections',
    page: 'Connections',
    controls: ['Manage', 'Save selection'],
    boundary: 'Save selection changes AMCP access only; a connect flow stops at the provider sign-in page.',
    fixture: 'granular-reporting',
  },
  {
    id: 'recipe-draft',
    title: 'Recipe, brief check and paused draft',
    route: '/campaigns',
    page: 'Campaigns',
    controls: ['Check this brief', 'Create paused campaign plan'],
    boundary: 'The saved paused plan (a local save); it is not approved or run.',
    fixture: 'write-journey',
  },
  {
    id: 'creative-review',
    title: 'Creative push review',
    route: '/media',
    page: 'Creative',
    controls: ['Push creatives', 'Review the push'],
    boundary: 'The push review; its authorization stays unchecked and nothing is pushed.',
    fixture: 'write-journey',
  },
  {
    id: 'report-export',
    title: 'Report build, snapshot and owned-tab Sheets export',
    route: '/reporting-overview',
    page: 'Report builder',
    controls: ['Export this snapshot now'],
    boundary:
      'One export to the owned tab of the fixture spreadsheet, or of the ACC-03 disposable spreadsheet under its authorization.',
    fixture: 'granular-reporting',
  },
  {
    id: 'schedule-pause',
    title: 'Schedule pause and resume',
    route: '/schedules',
    page: 'Schedules',
    controls: ['Pause', 'Resume'],
    boundary: 'Pause and resume of one schedule.',
    fixture: 'granular-reporting',
    // One daily delivery of a synthetic report to a local file destination, saved through the fixture's own website.
    seed: 'schedule',
  },
  {
    id: 'operations-recovery',
    title: 'An Operations recovery item',
    route: '/operations',
    page: 'Operations',
    // A plan step's read-back, or a standalone reviewed change's provider check: both are read-only.
    controls: ['Review next step', 'Read back submitted step', 'Check the provider (read-only)'],
    boundary: 'The read-only check of one recovery item; nothing is accepted as applied or sent again.',
    fixture: 'write-journey',
    // The fixture's next synthetic create loses its response, so running the seeded plan leaves its step uncertain and
    // the plan in Operations as needing attention.
    seed: 'uncertain',
  },
  {
    id: 'ga4-events',
    title: 'GA4 recent events',
    route: '/measurement',
    page: 'Measurement',
    controls: ['Recent GA4 events', 'Read recent event counts'],
    boundary: 'One recent-events read; no event is sent.',
    fixture: 'measurement-events',
  },
];
export const assistiveTechnologies = [
  {id: 'nvda-chrome-windows', screen_reader: 'NVDA', browser: 'Google Chrome', platform: 'Windows', input: 'keyboard'},
  {id: 'voiceover-safari-ios', screen_reader: 'VoiceOver', browser: 'Safari', platform: 'iOS', input: 'touch'},
];
export const assistiveLanguages = ['en', 'ar'];
/**
 * What every session checks. `always` checkpoints apply to every journey; `only` names the one technology a checkpoint
 * applies to (it is not_applicable for the other); the rest are not_applicable when the journey has no such element.
 */
export const assistiveCheckpoints = [
  {id: 'C1', always: true, text: 'On arrival the page title and main heading name the page in the session language.'},
  {
    id: 'C2',
    always: true,
    text: 'The skip link and the banner, navigation and main landmarks are reachable (NVDA landmarks list, VoiceOver rotor).',
  },
  {id: 'C3', text: 'The headings list matches the sections the journey uses.'},
  {
    id: 'C4',
    always: true,
    text: 'Every control the journey uses announces a name in the session language, its role and its state (expanded, selected, checked, disabled).',
  },
  {
    id: 'C5',
    always: true,
    text: 'Reading and focus order follow the visual order (right to left in Arabic); nothing the journey needs is skipped or unreachable.',
  },
  {
    id: 'C6',
    text: 'A dialog takes focus, keeps it until it closes, closes with Escape or its close control, and returns focus to the control that opened it.',
  },
  {
    id: 'C7',
    text: 'Progress, success, refusal and validation messages are announced when they appear without losing the place, and none is conveyed by colour alone.',
  },
  {id: 'C8', text: 'Table cells announce their column headers; a long list announces its count or page.'},
  {
    id: 'C9',
    always: true,
    text: 'The page is read in the voice of the session language; provider values, IDs and field names are read as written; digits are Latin.',
  },
  {
    id: 'C10',
    only: 'voiceover-safari-ios',
    text: 'Touch: every control is reached by swiping and activated by double-tap; nothing needs a path gesture, hover or long press without an alternative; with VoiceOver off each control is tappable (at least 24 by 24 CSS pixels, or spaced); at 200% zoom the journey works without sideways scrolling.',
  },
  {
    id: 'C11',
    only: 'nvda-chrome-windows',
    text: 'Keyboard: the journey completes without a mouse, NVDA enters focus mode in form fields by itself, and the focus indicator stays visible.',
  },
  {
    id: 'C12',
    always: true,
    text: 'The journey stops at its boundary: nothing beyond it is sent, approved or changed.',
  },
];
const results = ['pass', 'fail', 'not_run'],
  marks = ['pass', 'fail', 'not_applicable'],
  severities = ['blocking', 'non_blocking'],
  statuses = ['open', 'fixed', 'declined'],
  environments = ['fixture', 'staging'];
const testerLabel = /^[a-z][a-z0-9-]{1,39}$/,
  day = /^\d{4}-\d{2}-\d{2}$/,
  hex64 = /^[0-9a-f]{64}$/,
  revision = /^[0-9a-f]{7,40}$/,
  issueId = /^AT-\d{3}$/;
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sessionKey = s => [s?.journey, s?.assistive_technology, s?.language].join(' / ');

/** The 28 sessions in a fixed order: each journey with each technology in each language. */
export function assistiveSessions() {
  return assistiveJourneys.flatMap(j =>
    assistiveTechnologies.flatMap(t =>
      assistiveLanguages.map(language => ({journey: j.id, assistive_technology: t.id, language})),
    ),
  );
}
/**
 * The digest of the protocol's structure (journeys and their pages, technologies, languages, checkpoints and their
 * applicability). A record made under another structure is refused; rewording a checkpoint does not change it.
 */
export function protocolDigest() {
  return sha256(
    JSON.stringify({
      journeys: assistiveJourneys.map(j => [j.id, j.route]),
      technologies: assistiveTechnologies.map(t => t.id),
      languages: assistiveLanguages,
      checkpoints: assistiveCheckpoints.map(c => [c.id, !!c.always, c.only ?? null]),
    }),
  );
}
/** Whether a checkpoint applies to a technology: not_applicable is required where it does not. */
const appliesTo = (checkpoint, technology) => !checkpoint.only || checkpoint.only === technology;

/** The page and control names of each journey in both languages, from the Arabic catalog; null where none exists. */
export function journeyLabels(catalog = readCatalog()) {
  return Object.fromEntries(
    assistiveJourneys.map(j => [
      j.id,
      [j.page, ...j.controls].map(en => ({en, ar: typeof catalog[en] === 'string' ? catalog[en] : null})),
    ]),
  );
}
function readCatalog() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'web/locales/ar.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** The blank record: every session not run, every value the tester supplies REPLACE. */
export function assistiveTemplate() {
  const labels = journeyLabels();
  return {
    record_kind: 'assistive_acceptance',
    schema_version: 1,
    ticket: 'ACC-07',
    protocol_sha256: protocolDigest(),
    release: {revision: 'REPLACE: the /versionz revision', package_sha256: 'REPLACE: the /versionz package SHA-256'},
    journeys: assistiveJourneys.map(j => ({
      id: j.id,
      title: j.title,
      route: j.route,
      stop: j.boundary,
      listen_for: labels[j.id],
    })),
    checkpoints: Object.fromEntries(assistiveCheckpoints.map(c => [c.id, c.text])),
    sessions: assistiveSessions().map(s => ({
      ...s,
      result: 'not_run',
      environment: 'REPLACE: fixture or staging',
      date: 'REPLACE: YYYY-MM-DD',
      tester: 'REPLACE: a tester label such as tester-a',
      versions: {screen_reader: 'REPLACE', browser: 'REPLACE', os: 'REPLACE'},
      minutes: null,
      checkpoints: Object.fromEntries(
        assistiveCheckpoints.map(c => [
          c.id,
          appliesTo(c, s.assistive_technology) ? 'REPLACE: pass, fail or not_applicable' : 'not_applicable',
        ]),
      ),
      issues: [],
    })),
    issues: [],
  };
}

/** Text that must never be in a record: a bearer token, a Google access token, a JWT or an OAuth secret name. */
const secretText = text =>
  /bearer\s|ya29\.|eyJ[A-Za-z0-9_-]{10,}\.|access_token|refresh_token|client_secret/i.test(text);
/** Problems with free text the tester writes: bounded, and no person, URL, account ID or token. */
function textProblems(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /REPLACE/.test(value))
    return [name + ' is text of 1 to ' + max + ' characters'];
  const problems = [];
  if (/\d{6,}/.test(value)) problems.push(name + ' holds a long number such as an account ID; leave IDs out');
  if (/[\r\n<>]/.test(value)) problems.push(name + ' is one line of plain text');
  return problems;
}
const realDay = text =>
  typeof text === 'string' &&
  day.test(text) &&
  Number.isFinite(Date.parse(text + 'T00:00:00Z')) &&
  new Date(Date.parse(text + 'T00:00:00Z')).toISOString().slice(0, 10) === text;

/**
 * Every problem with a record; an empty list means it is valid. `today` (UTC, YYYY-MM-DD) bounds session dates.
 * A valid record may still be incomplete or blocked: assistiveOutcome says which.
 */
export function validateAssistiveRecord(record, today = new Date().toISOString().slice(0, 10)) {
  if (!plain(record) || record.record_kind !== 'assistive_acceptance' || record.ticket !== 'ACC-07')
    return ['the record is an ACC-07 assistive_acceptance record'];
  const problems = [],
    text = JSON.stringify(record);
  for (const key of Object.keys(record))
    if (
      ![
        'record_kind',
        'schema_version',
        'ticket',
        'protocol_sha256',
        'release',
        'journeys',
        'checkpoints',
        'sessions',
        'issues',
      ].includes(key)
    )
      problems.push('unknown field ' + key);
  if (record.schema_version !== 1) problems.push('schema_version is 1');
  if (record.protocol_sha256 !== protocolDigest())
    problems.push('protocol_sha256 is not the current protocol: record the sessions again from a new template');
  if (
    !plain(record.release) ||
    !revision.test(String(record.release.revision)) ||
    !hex64.test(String(record.release.package_sha256))
  )
    problems.push('release is the /versionz revision and package_sha256 of the build the sessions ran on');
  // References only (ACC rules): nothing in a record names a person, a page address, the production site or a secret.
  if (/[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i.test(text))
    problems.push('the record holds an e-mail address; name testers by label');
  if (/\b(?:https?|wss?):\/\/|\bwww\./i.test(text))
    problems.push('the record holds a URL; name pages by route, such as /reports');
  if (/amcp\.shop/i.test(text))
    problems.push('the record names the production site; sessions run on the fixture host or staging');
  if (secretText(text)) problems.push('the record holds a token-like value; keep references only');
  const issues = Array.isArray(record.issues) ? record.issues : null;
  if (!issues) problems.push('issues is a list');
  const byId = new Map();
  for (const [index, issue] of (issues ?? []).entries()) {
    const at = message => problems.push('issues[' + index + ']: ' + message);
    if (!plain(issue)) {
      at('an issue is an object');
      continue;
    }
    for (const key of Object.keys(issue))
      if (
        ![
          'id',
          'journey',
          'assistive_technology',
          'language',
          'checkpoint',
          'severity',
          'summary',
          'status',
          'fix_ref',
          'retested',
        ].includes(key)
      )
        at('unknown field ' + key);
    if (typeof issue.id !== 'string' || !issueId.test(issue.id)) at('id is AT- and three digits');
    else if (byId.has(issue.id)) at(issue.id + ' is listed once');
    else byId.set(issue.id, issue);
    if (!assistiveSessions().some(s => sessionKey(s) === sessionKey(issue)))
      at('journey, assistive_technology and language name one of the 28 sessions');
    if (!assistiveCheckpoints.some(c => c.id === issue.checkpoint)) at('checkpoint is one of C1 to C12');
    if (!severities.includes(issue.severity)) at('severity is blocking or non_blocking');
    if (!statuses.includes(issue.status)) at('status is open, fixed or declined');
    textProblems(issue.summary, 'summary', 300).forEach(at);
    // A blocking issue is fixed or stays open: zero blocking issues outstanding is the acceptance criterion.
    if (issue.severity === 'blocking' && issue.status === 'declined')
      at('a blocking issue is fixed or stays open, never declined');
    if (issue.status === 'fixed') {
      if (typeof issue.fix_ref !== 'string' || !revision.test(issue.fix_ref))
        at('a fixed issue names its fix commit in fix_ref');
      if (issue.retested !== true) at('a fixed issue is retested in a new session (retested: true)');
    } else if (issue.fix_ref !== undefined || issue.retested !== undefined)
      at('only a fixed issue has fix_ref and retested');
  }
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  if (!Array.isArray(record.sessions)) problems.push('sessions is a list');
  for (const expected of assistiveSessions()) {
    const found = sessions.filter(s => sessionKey(s) === sessionKey(expected)).length;
    if (found !== 1) problems.push(sessionKey(expected) + (found ? ' is recorded ' + found + ' times' : ' is missing'));
  }
  const linked = new Map();
  for (const [index, session] of sessions.entries()) {
    const name = plain(session) ? sessionKey(session) : 'sessions[' + index + ']',
      at = message => problems.push(name + ': ' + message);
    if (!plain(session)) {
      at('a session is an object');
      continue;
    }
    if (!assistiveSessions().some(s => sessionKey(s) === name)) {
      at('not one of the 28 sessions');
      continue;
    }
    for (const key of Object.keys(session))
      if (
        ![
          'journey',
          'assistive_technology',
          'language',
          'result',
          'environment',
          'date',
          'tester',
          'versions',
          'minutes',
          'checkpoints',
          'issues',
        ].includes(key)
      )
        at('unknown field ' + key);
    if (!results.includes(session.result)) {
      at('result is pass, fail or not_run');
      continue;
    }
    const ids = Array.isArray(session.issues) ? session.issues : null;
    if (!ids) at('issues lists the IDs of the issues found in this session');
    for (const id of ids ?? []) {
      const issue = byId.get(id);
      if (!issue) at(id + ' is not in issues');
      else if (sessionKey(issue) !== name) at(id + ' belongs to another session');
      else if (linked.has(id)) at(id + ' is listed by one session only');
      else linked.set(id, issue);
    }
    if (session.result === 'not_run') {
      if (ids?.length) at('a session not run lists no issues');
      continue;
    }
    if (!environments.includes(session.environment))
      at('environment is fixture or staging; never production or real client data');
    if (!realDay(session.date) || session.date > today)
      at('date is the day of the session, YYYY-MM-DD, not in the future');
    if (typeof session.tester !== 'string' || !testerLabel.test(session.tester))
      at('tester is a label such as tester-a, never a name or address');
    if (!plain(session.versions) || Object.keys(session.versions).sort().join() !== 'browser,os,screen_reader')
      at('versions is {screen_reader, browser, os}');
    else
      for (const key of ['screen_reader', 'browser', 'os'])
        textProblems(session.versions[key], 'versions.' + key, 60).forEach(at);
    if (
      session.minutes !== null &&
      session.minutes !== undefined &&
      !(Number.isSafeInteger(session.minutes) && session.minutes >= 1 && session.minutes <= 600)
    )
      at('minutes is the whole minutes the journey took (1 to 600), or null');
    const checks = session.checkpoints,
      technology = session.assistive_technology;
    if (
      !plain(checks) ||
      Object.keys(checks).sort().join() !==
        assistiveCheckpoints
          .map(c => c.id)
          .sort()
          .join()
    ) {
      at('checkpoints marks each of C1 to C12');
      continue;
    }
    for (const checkpoint of assistiveCheckpoints) {
      const mark = checks[checkpoint.id];
      if (!marks.includes(mark)) at(checkpoint.id + ' is pass, fail or not_applicable');
      else if (!appliesTo(checkpoint, technology) && mark !== 'not_applicable')
        at(checkpoint.id + ' applies to ' + checkpoint.only + ' only: mark it not_applicable');
      else if (appliesTo(checkpoint, technology) && (checkpoint.always || checkpoint.only) && mark === 'not_applicable')
        at(checkpoint.id + ' applies to every journey with this technology');
    }
    const failed = assistiveCheckpoints.filter(c => checks[c.id] === 'fail').map(c => c.id),
      sessionIssues = (ids ?? []).map(id => byId.get(id)).filter(Boolean),
      openBlocking = sessionIssues.filter(i => i.severity === 'blocking' && i.status === 'open');
    for (const issue of sessionIssues)
      if (issue.status === 'open' && checks[issue.checkpoint] === 'not_applicable')
        at(issue.id + ' names ' + issue.checkpoint + ', which this session marks not_applicable');
    // A checkpoint fails exactly when an open blocking issue names it; a non-blocking issue leaves it passed.
    for (const id of failed)
      if (!openBlocking.some(i => i.checkpoint === id)) at(id + ' failed: list the open blocking issue that names it');
    for (const issue of openBlocking)
      if (checks[issue.checkpoint] !== 'fail')
        at(issue.id + ' is blocking and open: mark ' + issue.checkpoint + ' fail');
    if (session.result === 'pass' && failed.length)
      at('a passed session has no failed checkpoint (' + failed.join(', ') + ')');
    if (session.result === 'fail' && !failed.length) at('a failed session marks the checkpoint that failed');
  }
  for (const id of byId.keys())
    if (!linked.has(id)) problems.push(id + ' is not listed by the session it was found in');
  return problems;
}

/**
 * accepted when all 28 sessions passed and no blocking issue is open, blocked while one is, incomplete otherwise.
 * Call it on a valid record only.
 */
export function assistiveOutcome(record) {
  const open = (record.issues ?? []).filter(i => i.severity === 'blocking' && i.status === 'open').length;
  if (open || record.sessions.some(s => s.result === 'fail')) return 'blocked';
  if (record.sessions.some(s => s.result === 'not_run')) return 'incomplete';
  return 'accepted';
}

/** Sessions and issues per journey and overall: the measurable outcome, with the median minutes of a journey. */
export function assistiveSummary(record) {
  const count = (list, predicate) => list.filter(predicate).length;
  const median = values => {
    const sorted = values.filter(v => Number.isSafeInteger(v)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const tally = (sessions, issues) => ({
    sessions: {
      pass: count(sessions, s => s.result === 'pass'),
      fail: count(sessions, s => s.result === 'fail'),
      not_run: count(sessions, s => s.result === 'not_run'),
    },
    blocking: {
      open: count(issues, i => i.severity === 'blocking' && i.status === 'open'),
      fixed: count(issues, i => i.severity === 'blocking' && i.status === 'fixed'),
    },
    non_blocking: {
      open: count(issues, i => i.severity === 'non_blocking' && i.status === 'open'),
      fixed: count(issues, i => i.severity === 'non_blocking' && i.status === 'fixed'),
      declined: count(issues, i => i.severity === 'non_blocking' && i.status === 'declined'),
    },
  });
  return {
    outcome: assistiveOutcome(record),
    journeys: assistiveJourneys.map(j => {
      const sessions = record.sessions.filter(s => s.journey === j.id),
        issues = record.issues.filter(i => i.journey === j.id);
      return {
        journey: j.id,
        ...tally(sessions, issues),
        median_minutes: median(sessions.filter(s => s.result !== 'not_run').map(s => s.minutes)),
      };
    }),
    total: tally(record.sessions, record.issues),
  };
}

/** The release identity of this checkout's build, for the record: the Git revision and the packaged runtime digest. */
export function localRelease() {
  let revisionText = null,
    package_sha256 = null;
  try {
    revisionText = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    revisionText = null;
  }
  try {
    package_sha256 = JSON.parse(fs.readFileSync(path.join(root, 'dist/release-identity.json'), 'utf8')).sha256 ?? null;
  } catch {
    package_sha256 = null;
  }
  return {revision: revisionText && revision.test(revisionText) ? revisionText : null, package_sha256};
}

/**
 * Saves the schedule-pause journey's schedule as the signed-in owner, through the fixture's own website API exactly as
 * the report builder would: a local file destination (no Sheets login) and one daily delivery of a synthetic Meta
 * report. Its ID is returned; nothing leaves the fixture.
 */
async function seedSchedule(site) {
  const call = async body => {
    const response = await fetch(site.origin + '/api/workspace/overview', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: site.origin,
        'x-amcp-csrf': site.csrf,
        cookie: site.cookie.name + '=' + site.cookie.value,
      },
      body: JSON.stringify(body),
    });
    const out = await response.json().catch(() => ({}));
    if (!out.success)
      throw Error('The synthetic schedule could not be saved: ' + (out.error?.code ?? 'HTTP ' + response.status));
    return out.data;
  };
  const {granularConfig} = await import(
    pathToFileURL(path.join(root, 'tests/fixtures/overview-granularity-data.mjs')).href
  );
  const destination = await call({
    action: 'bind_file_destination',
    idempotency_key: 'acc07-file-destination',
    confirmed: true,
    file_destination: {name: 'Synthetic client pack', formats: ['xlsx']},
  });
  const scheduled = await call({
    action: 'schedule',
    idempotency_key: 'acc07-daily-schedule',
    config: {
      ...granularConfig(),
      name: 'Synthetic weekly report',
      date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'},
      partial_delivery: 'allow_marked',
    },
    schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destination.id},
    confirmed: true,
  });
  return scheduled.id;
}

/**
 * Starts the synthetic fixture host of one journey, as the automated browser matrix uses it (an in-memory workspace on
 * 127.0.0.1 whose provider answers are synthetic and which refuses every other request), and a second loopback server
 * whose one-time link signs a browser in to it. Kinds with a report worker have it run every few seconds, as the worker
 * process would. Nothing is saved after close(). options.workIntervalMs sets that period; options.listen(handler) binds
 * the second server in place of the default, which never keeps a port that Fetch forbids (tests/http-listener.ts).
 */
export async function serveJourney(id, options = {}) {
  const journey = assistiveJourneys.find(j => j.id === id);
  if (!journey) throw Error('Name a journey: ' + assistiveJourneys.map(j => j.id).join(', ') + '.');
  let browserWorkflowSite, listenForFetch;
  try {
    ({browserWorkflowSite} = await import(
      pathToFileURL(path.join(root, 'tests/fixtures/browser-workflow-sites.mjs')).href
    ));
    ({listenForFetch} = await import(pathToFileURL(path.join(root, 'dist/tests/http-listener.js')).href));
  } catch (error) {
    throw Error('The fixture host runs the built application: run npm run build first (' + error.message + ').');
  }
  const site = await browserWorkflowSite(journey.fixture);
  let seeded = null,
    helper,
    timer;
  try {
    if (journey.seed === 'schedule') seeded = await seedSchedule(site);
    else if (journey.seed) seeded = await site.writeJourney.seed(journey.seed);
    const token = randomBytes(24).toString('base64url'),
      signIn = '/sign-in/' + token;
    let used = false;
    const handler = (req, res) => {
      const headers = {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-type': 'text/plain; charset=utf-8',
      };
      if (req.method !== 'GET' || req.url !== signIn) return res.writeHead(404, headers).end('Not found.\n');
      if (used)
        return res
          .writeHead(410, headers)
          .end('This sign-in link was used already. Restart serve for a new session.\n');
      used = true;
      // Cookies are scoped to the host, not the port, so the fixture on another loopback port receives it.
      res
        .writeHead(302, {
          ...headers,
          'set-cookie': site.cookie.name + '=' + site.cookie.value + '; Path=/; HttpOnly; SameSite=Lax',
          location: site.origin + journey.route,
        })
        .end();
    };
    // The link is fetched by the tests and opened in a browser, and both refuse the ports Fetch forbids, which an OS-chosen
    // port can land on: the draw is released and asked again (tests/http-listener.ts). options.listen is the seam a test uses
    // to force such a draw, as browserWorkflowSite's is.
    helper = await (options.listen ?? listenForFetch)(handler);
    const work = site.granular?.workOnce ?? site.exportOutcomes?.workOnce;
    let running = false;
    if (work) {
      timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
          await work();
        } catch {
          // A failed job is the fixture's answer; the page shows it. The next tick tries again.
        } finally {
          running = false;
        }
      }, options.workIntervalMs ?? 3000);
      timer.unref?.();
    }
    const address = helper.address();
    return {
      journey,
      kind: journey.fixture,
      origin: site.origin,
      link: 'http://127.0.0.1:' + address.port + signIn,
      helperAddress: address.address,
      seeded,
      counts: () => site.counts(),
      async close() {
        if (timer) clearInterval(timer);
        helper.closeAllConnections?.();
        await new Promise(resolve => helper.close(() => resolve()));
        await site.close();
      },
    };
  } catch (error) {
    if (timer) clearInterval(timer);
    if (helper?.listening) await new Promise(resolve => helper.close(() => resolve()));
    await site.close();
    throw error;
  }
}

function readRecord(file) {
  if (!file) throw Error('Name the record: node tools/acceptance/assistive-results.mjs check <record.json>');
  const bytes = fs.readFileSync(file);
  return {bytes, record: JSON.parse(bytes.toString('utf8'))};
}

async function main(argv) {
  const [command, argument] = argv;
  if (command === 'template') {
    console.log(JSON.stringify(assistiveTemplate(), null, 2));
    return;
  }
  if (command === 'check' || command === 'summary') {
    const {bytes, record} = readRecord(argument),
      problems = validateAssistiveRecord(record),
      valid = !problems.length;
    const out = {
      valid,
      problems,
      outcome: valid ? assistiveOutcome(record) : null,
      // The digest to cite in the qualification record and package status; the record stays in the private store.
      record_sha256: sha256(bytes),
      ...(valid ? (command === 'summary' ? assistiveSummary(record) : {total: assistiveSummary(record).total}) : {}),
    };
    console.log(JSON.stringify(out, null, 2));
    if (!valid) process.exitCode = 1;
    return;
  }
  if (command === 'serve') {
    const host = await serveJourney(argument),
      release = localRelease();
    if (host.journey.id === 'creative-review' && (!process.env.AMCP_FFMPEG_PATH || !process.env.AMCP_FFPROBE_PATH))
      console.log(
        'Note: uploads are inspected with FFmpeg. Set AMCP_FFMPEG_PATH and AMCP_FFPROBE_PATH, as for the media tests.',
      );
    console.log(
      [
        'ACC-07 synthetic fixture host: ' + host.journey.id + ' (' + host.journey.title + '), fixture ' + host.kind,
        'Open this sign-in link once, in the browser of the session: ' + host.link,
        'It signs you in and opens ' + host.journey.route + '. Stop at: ' + host.journey.boundary,
        'Release for the record: revision ' +
          (release.revision ?? 'unknown') +
          ', package_sha256 ' +
          (release.package_sha256 ?? 'unknown'),
        'Every provider request is answered or refused by the fixture; nothing leaves this computer. Ctrl+C stops it.',
      ].join('\n'),
    );
    const stop = async () => {
      const counts = host.counts();
      await host.close();
      console.log(
        JSON.stringify({
          native_reads: counts.nativeReads,
          refused_requests: counts.refused,
          provider_writes: counts.writes,
          synthetic_writes: counts.syntheticWrites,
        }),
      );
      if (counts.writes) {
        console.error('A provider write was attempted and refused by the fixture: record it as an issue (C12).');
        process.exitCode = 1;
      }
    };
    process.once('SIGINT', () => stop().catch(error => console.error(error.message)));
    return;
  }
  throw Error(
    'Usage: node tools/acceptance/assistive-results.mjs template | check <record.json> | summary <record.json> | serve <journey>',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(e => {
    console.error(e.message);
    process.exitCode = 1;
  });
