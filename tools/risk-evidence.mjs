// QA-02 step 6: the risk-class by evidence matrix of a qualification record (QA-01). For each risk class of the
// qualification plan (tests/fixtures/risk-classes.json) it reports, instead of headline totals, which evidence covers
// the class in the tested tree and how that evidence fared in this run:
//   fixture      the synthetic test files named for the class, as the record's test stages ran them;
//   conformance  the reviewed-family descriptors of the class's descriptor risks (tests/family-descriptors);
//   mutants      the catalogued mutants whose guard serves the class, as the mutant stage killed them;
//   live         the owner-run acceptance that confirms the class outside the synthetic suite (never run here).
// A class with no evidence of a kind is listed under `gaps`. Nothing here runs a test or touches a provider: it reads
// the definitions and descriptors of the tested tree and the stage results qualify already holds.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const definitionFile = 'tests/fixtures/risk-classes.json';
export const catalogueFile = 'tests/fixtures/mutant-catalogue.json';
export const conformanceTest = 'tests/reviewed-family-conformance.test.mjs';
export const descriptorRisks = ['activation', 'budget', 'destructive', 'settings'];
const descriptorDirectory = 'tests/family-descriptors',
  pendingFile = 'tests/fixtures/family-conformance-pending.json';

/**
 * A test location as the source file it names: forward slashes, relative to `root`, compiled tests mapped back. A run
 * of backslashes is one separator: the TAP reporter prints a Windows location as a quoted string with each backslash
 * doubled (`location: 'C:\\Users\\...'`).
 */
export function sourceTestFile(location, root = '') {
  let file = String(location)
    .replace(/^file:\/\/\/?/, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/\\+/g, '/');
  const base = String(root).replace(/\\+/g, '/').replace(/\/+$/, '');
  if (base && file.toLowerCase().startsWith(base.toLowerCase() + '/')) file = file.slice(base.length + 1);
  const compiled = /^dist\/(tests\/.+)\.test\.js$/.exec(file);
  return compiled ? compiled[1] + '.test.ts' : file;
}
/** The test files a Node test run reports failing tests in (spec `test at <file>:l:c` or TAP `location: '<file>'`). */
export function failingFiles(output, root = '') {
  const files = new Set();
  for (const match of String(output).matchAll(/^\s*(?:test at (\S+?:\d+:\d+)|location: '([^']+)')\s*$/gm))
    files.add(sourceTestFile(match[1] ?? match[2], root));
  return [...files].sort();
}
/** Per-mutant outcomes from the mutant runner's progress lines (`<id>: killed|survived|timeout|invalid`). */
export function mutantStatuses(output) {
  const out = {};
  for (const match of String(output).matchAll(/^(M\d+[A-Za-z0-9-]*): (killed|survived|timeout|invalid)\b/gm))
    out[match[1]] = match[2];
  return out;
}
/** Problems of a definition against the tested tree: unknown test files, mutants, risks or duplicate classes. */
export function checkDefinition(definition, {root = process.cwd(), catalogue} = {}) {
  const problems = [],
    classes = Array.isArray(definition?.classes) ? definition.classes : [],
    known = new Set((catalogue?.mutants ?? []).map(m => m.id)),
    classified = new Set();
  if (!classes.length) problems.push('no risk classes are defined');
  const ids = classes.map(c => c?.id);
  if (new Set(ids).size !== ids.length) problems.push('risk class IDs repeat');
  for (const c of classes) {
    const where = String(c?.id ?? '?');
    if (!/^R\d+$/.test(where) || typeof c.name !== 'string' || !c.name || typeof c.consequence !== 'string')
      problems.push(where + ': needs an R-number ID, a name and a consequence');
    if (!Array.isArray(c.register) || !c.register.every(r => /^[A-Z]{2,4}-\d{2}$/.test(r)))
      problems.push(where + ': register lists register item IDs');
    if (!Array.isArray(c.fixture) || !c.fixture.length) problems.push(where + ': names no fixture test file');
    for (const file of c.fixture ?? [])
      if (!/^tests\/[\w./-]+\.test\.(?:ts|mjs)$/.test(file) || !fs.existsSync(path.join(root, file)))
        problems.push(where + ': fixture test file ' + file + ' does not exist');
    for (const risk of c.conformance ?? [])
      if (!descriptorRisks.includes(risk)) problems.push(where + ': unknown descriptor risk ' + risk);
    for (const id of c.mutants ?? []) {
      if (!known.has(id)) problems.push(where + ': mutant ' + id + ' is not in the catalogue');
      classified.add(id);
    }
    if (!Array.isArray(c.live) || !c.live.every(l => typeof l?.ref === 'string' && typeof l?.what === 'string'))
      problems.push(where + ': live lists {ref, what} acceptance items');
  }
  for (const id of known)
    if (!classified.has(id))
      problems.push('mutant ' + id + ' belongs to no risk class; classify it in ' + definitionFile);
  return problems;
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
/** The family descriptors of the tested tree by risk, and the families still pending one. */
export async function familyConformance(root) {
  const directory = path.join(root, descriptorDirectory),
    families = Object.fromEntries(descriptorRisks.map(risk => [risk, []]));
  for (const file of fs
    .readdirSync(directory)
    .filter(n => n.endsWith('.mjs') && !n.startsWith('_'))
    .sort()) {
    const d = (await import(pathToFileURL(path.join(directory, file)).href)).default;
    (families[d.risk] ??= []).push(d.family);
  }
  const pending = readJson(path.join(root, pendingFile));
  let spend = null;
  try {
    const {reviewedFamilies} = await import(pathToFileURL(path.join(root, 'dist/src/reviewed-families.js')).href);
    const affecting = new Set(
      reviewedFamilies()
        .filter(f => f.spendConfirmation)
        .map(f => f.name),
    );
    spend = pending.families.filter(name => affecting.has(name)).length;
  } catch {}
  return {
    descriptors: Object.values(families).reduce((n, list) => n + list.length, 0),
    by_risk: Object.fromEntries(Object.entries(families).map(([risk, list]) => [risk, list.length])),
    families,
    pending: pending.families.length,
    pending_spend_affecting: spend,
    parked: pending.parked?.families?.length ?? 0,
  };
}
const ran = stage => !!stage && stage.status !== 'not_run';
/** One test file's outcome in this run: the full suite (`test_suite`, every test file) ran and did not report it. */
function fileStatus(file, stages) {
  const suite = stages.find(s => s.name === 'test_suite');
  if (!ran(suite)) return 'not_run';
  if ((suite.failing_files ?? []).includes(file)) return 'failed';
  // A suite that failed without naming any failing file (a crash, a timeout) proves nothing about this file.
  if (suite.status !== 'passed' && !(suite.failing_files ?? []).length) return 'unknown';
  return 'passed';
}
/**
 * The matrix for `stages` (the record's stage results, with `failing_files` on test stages and `mutants` on the mutant
 * stage) of the tree at `root`; `browser` is the record's browser attachment, if any.
 */
export async function riskEvidence({root, stages = [], browser} = {}) {
  const definition = readJson(path.join(root, definitionFile)),
    catalogue = readJson(path.join(root, catalogueFile)),
    problems = checkDefinition(definition, {root, catalogue}),
    conformance = await familyConformance(root),
    mutantStage = stages.find(s => s.name === 'mutant_catalogue'),
    outcomes = mutantStage?.mutants ?? {},
    conformanceStatus = fileStatus(conformanceTest, stages);
  const classes = definition.classes.map(c => {
    const failing = c.fixture.filter(file => fileStatus(file, stages) === 'failed'),
      statuses = c.fixture.map(file => fileStatus(file, stages)),
      missing = c.fixture.filter(file => !fs.existsSync(path.join(root, file)));
    const fixture = {
      files: c.fixture.length,
      missing,
      failing,
      status: missing.length
        ? 'incomplete'
        : statuses.includes('failed')
          ? 'failed'
          : statuses.includes('not_run')
            ? 'not_run'
            : statuses.includes('unknown')
              ? 'unknown'
              : 'passed',
      ...(c.browser
        ? {
            browser_qualification: browser
              ? {attached: true, bound_to_package: browser.bound_to_package, failed: browser.failed}
              : {attached: false},
          }
        : {}),
    };
    const described = (c.conformance ?? []).flatMap(risk => conformance.families[risk] ?? []);
    const families = c.conformance?.length
      ? {
          risks: c.conformance,
          descriptors: described.length,
          status: described.length ? conformanceStatus : 'none',
        }
      : null;
    const count = status => (c.mutants ?? []).filter(id => outcomes[id] === status);
    const unreported = (c.mutants ?? []).filter(id => !outcomes[id]),
      survived = [...count('survived'), ...count('invalid')];
    const mutants = {
      catalogued: (c.mutants ?? []).length,
      killed: count('killed').length,
      timeout: count('timeout').length,
      survived,
      status: !(c.mutants ?? []).length
        ? 'none'
        : !ran(mutantStage)
          ? 'not_run'
          : survived.length
            ? 'failed'
            : unreported.length
              ? 'incomplete'
              : 'passed',
      ...(unreported.length && ran(mutantStage) ? {unreported} : {}),
    };
    return {
      id: c.id,
      name: c.name,
      consequence: c.consequence,
      register: c.register,
      fixture,
      conformance: families,
      mutants,
      // The record is local synthetic qualification: live acceptance is an owner step recorded outside it.
      live: {required: c.live.map(l => l.ref), items: c.live, recorded: [], status: 'owner_step'},
    };
  });
  const gaps = [];
  for (const c of classes) {
    if (!c.conformance) gaps.push(c.id + ': no reviewed-family conformance applies');
    if (!c.mutants.catalogued) gaps.push(c.id + ': no catalogued mutant');
    gaps.push(c.id + ': live acceptance (' + c.live.required.join(', ') + ') is an owner step');
  }
  return {
    schema_version: 1,
    definition: definitionFile,
    ...(problems.length ? {definition_problems: problems} : {}),
    classes,
    family_conformance: {
      descriptors: conformance.descriptors,
      by_risk: conformance.by_risk,
      pending: conformance.pending,
      pending_spend_affecting: conformance.pending_spend_affecting,
      parked: conformance.parked,
      status: conformanceStatus,
    },
    gaps,
  };
}
