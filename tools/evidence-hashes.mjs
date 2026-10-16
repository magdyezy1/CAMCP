// The captured catalog's evidence digests (ARC-03). `.mirror/REPORTS/evidence-hashes.json` names every file of the
// original capture with its SHA-256 (tools/catalog/normalize.mjs wrote it from the complete capture). This repository
// ships part of that capture only, so the list splits in two:
//   shipped   files in the tree whose bytes match their digest, verified here;
//   withheld  files the tree does not ship, declared in .mirror/RAW/WITHHELD.json with the label
//             historical_capture_not_shipped, their count and the digest of the withheld set. Their digests are
//             historical: nobody can check them from this repository, and none ships without a privacy review (D17).
//
//   node tools/evidence-hashes.mjs           print the summary as JSON
//   node tools/evidence-hashes.mjs --check   fail on a digest the shipped bytes do not match, an absent file nobody
//                                            declared withheld, or a declaration that no longer matches the list
//   node tools/evidence-hashes.mjs --write   rewrite the declaration's file lists, counts and digest from the list;
//                                            every withheld file must match one group, and a new group needs a reason
//
// codegen/generate.mjs embeds the result in generated/registry.json (provenance format 2) and refuses to generate
// while the check fails, so `npm run generate:check` runs it too. It reads committed files only and contacts nothing.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const evidenceFile = '.mirror/REPORTS/evidence-hashes.json';
export const withheldFile = '.mirror/RAW/WITHHELD.json';
export const withheldLabel = 'historical_capture_not_shipped';
/** The sanitized preview fixtures, each naming the withheld capture file it was derived from and that file's digest. */
export const observedRoutingFile = 'tests/fixtures/observed-routing.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

/** The SHA-256 of a file's bytes, or of the same bytes with CRLF line ends read as LF (a checkout's line endings). */
function matchesDigest(bytes, digest) {
  if (sha256(bytes) === digest) return true;
  const text = bytes.toString('utf8');
  return text.includes('\r\n') && sha256(Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8')) === digest;
}
/** The digest of a withheld set: SHA-256 over one "<path> <sha256>\n" line per file, sorted by path. */
export function withheldDigest(entries) {
  const lines = [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, digest]) => file + ' ' + digest + '\n')
    .join('');
  return 'sha256:' + sha256(Buffer.from(lines, 'utf8'));
}
/** A group pattern as a regular expression: `*` matches within one path segment, `{a,b}` one of its alternatives. */
export function patternExpression(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') source += '[^/]*';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) throw Error('Unclosed alternative in pattern ' + pattern);
      source +=
        '(?:' +
        pattern
          .slice(i + 1, end)
          .split(',')
          .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|') +
        ')';
      i = end;
    } else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$');
}

/**
 * The evidence list split into its shipped and withheld parts, with every problem the check reports. A problem is a
 * shipped file whose bytes differ from its digest, an absent file the declaration does not name ("unexplained"), a
 * declared file that is shipped or not in the list, a group whose files do not match its pattern, or a count, label or
 * digest the list no longer produces.
 */
export function evidenceProvenance(root = '.') {
  const problems = [],
    evidenceBytes = fs.readFileSync(path.join(root, evidenceFile)),
    evidence = JSON.parse(evidenceBytes.toString('utf8')),
    declarationBytes = fs.existsSync(path.join(root, withheldFile))
      ? fs.readFileSync(path.join(root, withheldFile))
      : undefined,
    declaration = declarationBytes ? JSON.parse(declarationBytes.toString('utf8')) : undefined,
    shipped = {},
    absent = [];
  if (!declaration) problems.push(withheldFile + ' is missing: the absent capture files are not declared withheld.');
  for (const [file, digest] of Object.entries(evidence).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!file.startsWith('.mirror/RAW/') || file.includes('..') || file.includes('\\'))
      problems.push(file + ': an evidence entry must name a file under .mirror/RAW/.');
    else if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
      problems.push(file + ': the evidence digest is not a SHA-256.');
    else if (fs.existsSync(path.join(root, file))) {
      if (matchesDigest(fs.readFileSync(path.join(root, file)), digest)) shipped[file] = digest;
      else problems.push(file + ': the shipped bytes do not match the captured digest.');
    } else absent.push(file);
  }
  const groups = Array.isArray(declaration?.groups) ? declaration.groups : [],
    declared = new Map();
  if (declaration && declaration.label !== withheldLabel)
    problems.push(withheldFile + ': label must be ' + withheldLabel + '.');
  if (declaration && declaration.evidence !== evidenceFile)
    problems.push(withheldFile + ': evidence must name ' + evidenceFile + '.');
  for (const group of groups) {
    const files = Array.isArray(group.files) ? group.files : [];
    if (typeof group.reason !== 'string' || group.reason.trim().length < 20)
      problems.push(withheldFile + ': group ' + group.pattern + ' needs a reason.');
    let expression;
    try {
      expression = patternExpression(String(group.pattern ?? ''));
    } catch (error) {
      problems.push(withheldFile + ': ' + error.message);
    }
    for (const file of files) {
      if (declared.has(file)) problems.push(file + ': declared withheld twice.');
      declared.set(file, group.pattern);
      if (expression && !expression.test(file))
        problems.push(file + ': does not match its group ' + group.pattern + '.');
    }
    if (group.count !== files.length)
      problems.push(
        withheldFile + ': group ' + group.pattern + ' counts ' + group.count + ', lists ' + files.length + '.',
      );
  }
  for (const file of absent)
    if (!declared.has(file))
      problems.push(file + ': absent from the tree and not declared withheld (unexplained missing evidence).');
  for (const file of declared.keys()) {
    if (!Object.hasOwn(evidence, file)) problems.push(file + ': declared withheld but not in ' + evidenceFile + '.');
    else if (Object.hasOwn(shipped, file) || fs.existsSync(path.join(root, file)))
      problems.push(file + ': declared withheld but shipped; remove it from ' + withheldFile + '.');
  }
  const withheldEntries = absent.map(file => [file, evidence[file]]),
    digest = withheldDigest(withheldEntries);
  if (declaration && declaration.count !== absent.length)
    problems.push(
      withheldFile + ': count ' + declaration.count + ' differs from the ' + absent.length + ' absent files.',
    );
  if (declaration && declaration.digest !== digest)
    problems.push(withheldFile + ': digest no longer matches the withheld entries of ' + evidenceFile + '.');
  // The sanitized preview fixtures name the capture file each came from; that digest must be the captured one.
  if (fs.existsSync(path.join(root, observedRoutingFile)))
    for (const fixture of readJson(root, observedRoutingFile)) {
      const file = '.mirror/RAW/' + fixture.source?.file;
      if (evidence[file] !== fixture.source?.sha256)
        problems.push(observedRoutingFile + ': ' + file + ' is not the captured file of its digest.');
    }
  return {
    evidence: {file: evidenceFile, sha256: sha256(evidenceBytes), entries: Object.keys(evidence).length},
    shipped,
    withheld: {
      label: withheldLabel,
      count: absent.length,
      digest,
      declaration: {file: withheldFile, sha256: declarationBytes ? sha256(declarationBytes) : null},
      groups: groups.map(g => ({pattern: g.pattern, count: Array.isArray(g.files) ? g.files.length : 0})),
    },
    problems,
  };
}

/** The declaration with its file lists, counts and digest recomputed; refuses a withheld file no group matches. */
export function declaredWithheld(root = '.') {
  const evidence = readJson(root, evidenceFile),
    declaration = readJson(root, withheldFile),
    absent = Object.keys(evidence)
      .filter(file => !fs.existsSync(path.join(root, file)))
      .sort(),
    groups = declaration.groups.map(g => ({...g, files: []}));
  for (const file of absent) {
    const group = groups.find(g => patternExpression(g.pattern).test(file));
    if (!group)
      throw Error(file + ' is withheld but no group of ' + withheldFile + ' matches it; add one with a reason.');
    group.files.push(file);
  }
  return {
    ...declaration,
    label: withheldLabel,
    evidence: evidenceFile,
    count: absent.length,
    digest: withheldDigest(absent.map(file => [file, evidence[file]])),
    groups: groups.map(({files, ...g}) => ({...g, count: files.length, files})),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(a => !['--check', '--write'].includes(a)) || args.length > 1)
    throw Error('Usage: node tools/evidence-hashes.mjs [--check | --write]');
  if (args[0] === '--write') fs.writeFileSync(withheldFile, JSON.stringify(declaredWithheld('.'), null, 2) + '\n');
  const result = evidenceProvenance('.');
  const summary = {
    entries: result.evidence.entries,
    shipped: Object.keys(result.shipped).length,
    withheld: result.withheld.count,
    withheld_digest: result.withheld.digest,
    groups: result.withheld.groups,
    problems: result.problems.length,
  };
  if (result.problems.length) {
    for (const problem of result.problems) console.error(problem);
    console.error(JSON.stringify(summary));
    process.exitCode = 1;
  } else console.log(JSON.stringify(summary));
}
