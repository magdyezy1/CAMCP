// The documentation freeze (DOC-03): current pages stop collecting delivery history. A current page is a hand-written
// Markdown page of the repository README or docs/, outside the dated records (docs/records/, docs/archive/,
// docs/implementation/), the redirect stubs of docs/moved.json, the generated index and the generated references (a
// page whose text starts "Generated"). On a current page, a heading may not name a batch ("Batch 149 — ..."), a line
// may not cite a commit, and a line of 70 or more characters (outside code and tables) may not repeat verbatim on
// another current page. The pages that already do are recorded in tools/docs-lint-baseline.json with their counts,
// which may only fall; any other page must have none. Totals are reported against the review's targets (about 25,000
// words in current pages and a duplicate-line share under 5%), which consolidating the long guides still has to reach.
// Usage: node tools/docs-lint.mjs [--write [--allow-increase=<reason>]]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readMoves} from './docs-links.mjs';

export const baselineFile = 'tools/docs-lint-baseline.json';
export const targets = {words: 25000, duplicate_share: 0.05};
const posix = file => file.split(path.sep).join('/');

/** The current pages, repository-relative, sorted. */
export function currentPages(root = process.cwd()) {
  const {moves} = readMoves(root),
    out = [];
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const file = posix(path.join(relative, entry.name));
      if (entry.isDirectory()) {
        if (!/^docs\/(?:records|archive|implementation)$/.test(file)) visit(file);
      } else if (file.endsWith('.md') && file !== 'docs/README.md' && !moves.has(file)) out.push(file);
    }
  };
  visit('docs');
  return ['README.md', ...out]
    .filter(file => !/^# .+\n+\**Generated/.test(fs.readFileSync(path.join(root, file), 'utf8')))
    .sort();
}
/** A page's lines outside fenced code. */
const prose = text => {
  let fence = null;
  return text.split('\n').filter(line => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open && (!fence || open[1][0] === fence[0])) {
      fence = fence ? null : open[1];
      return false;
    }
    return !fence;
  });
};
const longLines = text => [
  ...new Set(
    prose(text)
      .map(line => line.trim())
      .filter(line => line.length >= 70 && !line.startsWith('|')),
  ),
];
const batchHeading = /^#{1,6} .*\bbatch(?:es)?\s+\d+/i,
  // A commit: 7 to 12 hexadecimal characters with at least one letter and one digit, as a word of its own.
  commit = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}\b/g;

/** Per-page counts and the totals. */
export function measure(root = process.cwd()) {
  const pages = currentPages(root),
    texts = new Map(pages.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')])),
    owners = new Map();
  for (const [file, text] of texts)
    for (const line of longLines(text)) owners.set(line, [...(owners.get(line) ?? []), file]);
  const counts = {};
  let words = 0,
    lines = 0,
    duplicates = 0;
  for (const [file, text] of texts) {
    const long = longLines(text),
      repeated = long.filter(line => owners.get(line).length > 1);
    counts[file] = {
      batch_headings: prose(text).filter(line => batchHeading.test(line)).length,
      commit_refs: (text.match(commit) ?? []).length,
      duplicate_lines: repeated.length,
    };
    words += text.split(/\s+/).filter(Boolean).length;
    lines += long.length;
    duplicates += repeated.length;
  }
  return {
    counts,
    owners,
    totals: {pages: pages.length, words, long_lines: lines, duplicate_lines: duplicates},
  };
}

/** Every page above its recorded counts (a page with no record must have none). An empty list passes. */
export function lintProblems(root = process.cwd(), baseline = readBaseline(root)) {
  const {counts, owners} = measure(root),
    problems = [];
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline.pages?.[file] ?? {batch_headings: 0, commit_refs: 0, duplicate_lines: 0};
    for (const [metric, value] of Object.entries(count))
      if (value > (allowed[metric] ?? 0)) {
        const what = {
          batch_headings: 'headings naming a batch (move the delivery history to docs/records/)',
          commit_refs: 'commit references (a current page says what is true now; cite a record instead)',
          duplicate_lines: 'long lines repeated on another current page (keep each fact in one place and link to it)',
        }[metric];
        let example = '';
        if (metric === 'duplicate_lines') {
          const text = fs.readFileSync(path.join(root, file), 'utf8'),
            line = longLines(text).find(l => owners.get(l).length > 1);
          if (line)
            example =
              ': "' +
              line.slice(0, 90) +
              '…" is also in ' +
              owners
                .get(line)
                .filter(f => f !== file)
                .join(', ');
        }
        problems.push(file + ': ' + value + ' ' + what + ', above ' + (allowed[metric] ?? 0) + example);
      }
  }
  return problems;
}
export function readBaseline(root = process.cwd()) {
  const file = path.join(root, baselineFile);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {pages: {}};
}
/** The totals as the review measures them, with its targets. */
export function summary(root = process.cwd()) {
  const {totals} = measure(root);
  return {
    ...totals,
    duplicate_share: totals.long_lines ? Number((totals.duplicate_lines / totals.long_lines).toFixed(4)) : 0,
    targets,
  };
}

/**
 * Records the current counts. A count above its record is refused unless `reason` says why, and the reason is kept
 * with the counts it raised; the first record of a tree needs none. Returns the counts that rose.
 */
export function writeBaseline(root = process.cwd(), reason) {
  const previous = readBaseline(root),
    {counts} = measure(root),
    raised = Object.entries(counts).flatMap(([file, count]) =>
      Object.entries(count)
        .filter(([metric, value]) => value > (previous.pages?.[file]?.[metric] ?? 0))
        .map(([metric, value]) => file + ' ' + metric + ' ' + (previous.pages?.[file]?.[metric] ?? 0) + ' → ' + value),
    ),
    first = !fs.existsSync(path.join(root, baselineFile));
  if (raised.length && !reason && !first)
    throw Error('These counts would rise:\n' + raised.join('\n') + '\nPass --allow-increase=<reason> to record why.');
  const data = {
    meaning:
      'DOC-03 documentation freeze: per current page, the headings naming a batch, the commit references and the long lines repeated on another current page that it already held; each count may only fall, and a page not listed must have none (node tools/docs-lint.mjs, run by npm run docs:index:check).',
    increases: [...(previous.increases ?? []), ...(raised.length && !first ? [{reason, raised}] : [])],
    pages: Object.fromEntries(
      Object.entries(counts).filter(([, count]) => Object.values(count).some(value => value > 0)),
    ),
  };
  fs.mkdirSync(path.dirname(path.join(root, baselineFile)), {recursive: true});
  fs.writeFileSync(path.join(root, baselineFile), JSON.stringify(data, null, 2) + '\n');
  return raised;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url)),
    increase = process.argv.find(arg => arg.startsWith('--allow-increase='))?.slice('--allow-increase='.length);
  if (process.argv.includes('--write'))
    try {
      writeBaseline(root, increase);
      console.log('Wrote ' + baselineFile + '.');
    } catch (error) {
      console.error('Refused. ' + error.message);
      process.exit(1);
    }
  const problems = lintProblems(root),
    s = summary(root);
  console.log(
    'Current pages: ' +
      s.pages +
      ', ' +
      s.words +
      ' words (target about ' +
      targets.words +
      '); duplicate-line share ' +
      (s.duplicate_share * 100).toFixed(1) +
      '% (target under ' +
      targets.duplicate_share * 100 +
      '%).',
  );
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}
