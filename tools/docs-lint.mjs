// The documentation freeze and its size budget (DOC-03). Every documentation page says what it is in its front matter
// (tools/docs-front-matter.mjs). The maintained pages are the hand-written current and reference pages: the repository
// README and every page in docs/ whose status is current or reference, without the generated ones (a page that names
// its generator), the dated records, proposals and archived pages, and the redirect stubs of docs/moved.json. A page
// without front matter (only in a partial tree; the index refuses one in the repository) is maintained unless its folder
// (docs/records/, docs/archive/, docs/implementation/) or its first lines ("Generated ...") say otherwise.
//
// On a maintained page, a heading may not name a batch ("Batch 149 — ..."), a line may not cite a commit or type a
// package count ("13/14/1": docs/review/PACKAGE-STATUS.md is generated from the package status, so a page links it),
// and a line of 70 or more characters (outside code and tables) may not repeat verbatim on another maintained page. The
// decision record (docs/DECISIONS.md) is the one maintained page whose commit references are not counted: each of its
// rows is dated and names the commits the decision governs, as a record does (commitRecordPages); its other rules
// apply. Any other page that needs a revision links a dated record in docs/records/ instead, such as a deployment
// record. The pages that already break a rule are recorded in tools/docs-lint-baseline.json with their counts, which
// may only fall; any other page must have none.
//
// The review's targets (2026-10-08 engineering review, DOC-03): about 25,000 words of current documentation and a
// duplicate-line share under 5%. The word budget counts the current pages of the owner and operator tiers, the pages
// their readers read to do their work. Every other maintained page is a reference page: the engineering tier's guides
// and references, and the owner and operator references consulted on demand (the workflow and task detail). They are
// reported as a second total, in those two parts, and the total is recorded in the baseline: it may only fall unless
// an increase is recorded with its reason, so a page cannot leave the budget for the reference set, and the reference
// set cannot grow, without a recorded reason. That split is an engineering approach recorded in docs/DECISIONS.md
// (2026-10-24), not an owner decision, so the owner can revisit it. budgetProblems() enforces the budget, the
// duplicate-line share and the recorded reference total.
// Usage: node tools/docs-lint.mjs [--write [--allow-increase=<reason>]]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readMoves} from './docs-links.mjs';
import {frontMatter} from './docs-front-matter.mjs';

export const baselineFile = 'tools/docs-lint-baseline.json';
/** The budget of the owner and operator tiers' current pages, and the duplicate-line share of all maintained pages. */
export const targets = {words: 25000, duplicate_share: 0.05};
/**
 * Maintained pages whose commit references are their record, so the freeze does not count them: the decision record
 * (DOC-02) dates each decision and names the commits it governs. Batch headings, typed package counts and repeated
 * long lines are still refused there.
 */
export const commitRecordPages = Object.freeze(['docs/DECISIONS.md']);
const posix = file => file.split(path.sep).join('/');
const recordFolder = /^docs\/(?:records|archive|implementation)\//;

/** Each maintained page with its tier ('owner', 'operator', 'engineering', or null without front matter) and status. */
export function maintainedPages(root = process.cwd()) {
  const {moves} = readMoves(root),
    out = [];
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const file = posix(path.join(relative, entry.name));
      if (entry.isDirectory()) visit(file);
      else if (file.endsWith('.md') && file !== 'docs/README.md' && !moves.has(file)) out.push(file);
    }
  };
  if (fs.existsSync(path.join(root, 'docs'))) visit('docs');
  const pages = [];
  for (const file of ['README.md', ...out].filter(f => fs.existsSync(path.join(root, f)))) {
    const text = fs.readFileSync(path.join(root, file), 'utf8'),
      {data} = file === 'README.md' ? {data: {status: 'current', tier: 'operator'}} : frontMatter(text);
    if (data && data.invalid === undefined) {
      if (!['current', 'reference'].includes(data.status) || data.generated) continue;
      pages.push({file, status: data.status, tier: data.tier ?? null});
    } else if (!recordFolder.test(file) && !/^# .+\n+\**Generated/.test(text))
      pages.push({file, status: 'current', tier: null});
  }
  return pages.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
/** The maintained pages, repository-relative, sorted (the pages the freeze reads). */
export function currentPages(root = process.cwd()) {
  return maintainedPages(root).map(page => page.file);
}
/** Whether a maintained page counts against the owner and operator tiers' word budget. */
export const budgeted = page => page.status === 'current' && (page.tier === 'owner' || page.tier === 'operator');
/** Whether a maintained page counts in the reference total: a classified page outside the budget. */
export const referenced = page => page.tier !== null && !budgeted(page);
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
/** A page's words, without its front matter. */
const wordsOf = text => frontMatter(text).body.split(/\s+/).filter(Boolean).length;
/**
 * The literal package counts in a text: the 28 blueprint packages typed as implemented/partial/open, either three
 * numbers that add up to 28 ("13/14/1", "13 / 15 / 0") or the words ("13 implemented / 14 partial / one open").
 */
export function packageCounts(text) {
  const number = '(?:\\d{1,2}|zero|one|two|three)';
  let found = 0;
  for (const m of text.matchAll(/(?<![\w./-])(\d{1,2}) ?\/ ?(\d{1,2}) ?\/ ?(\d{1,2})(?![\w/-])/g))
    if (Number(m[1]) + Number(m[2]) + Number(m[3]) === 28) found++;
  const words = new RegExp(
    `\\b${number}\\s+implemented\\s*/\\s*${number}\\s+partial\\s*/\\s*${number}\\s+open\\b`,
    'gi',
  );
  return found + (text.match(words) ?? []).length;
}

/** Per-page counts and the totals, with the words of each tier. */
export function measure(root = process.cwd()) {
  const pages = maintainedPages(root),
    texts = new Map(pages.map(({file}) => [file, fs.readFileSync(path.join(root, file), 'utf8')])),
    owners = new Map();
  for (const [file, text] of texts)
    for (const line of longLines(text)) owners.set(line, [...(owners.get(line) ?? []), file]);
  const counts = {},
    tiers = {
      budget_words: 0,
      reference_words: 0,
      operator_reference_words: 0,
      engineering_words: 0,
      unclassified_words: 0,
    };
  let words = 0,
    lines = 0,
    duplicates = 0;
  for (const page of pages) {
    const text = texts.get(page.file),
      long = longLines(text),
      repeated = long.filter(line => owners.get(line).length > 1),
      n = wordsOf(text);
    counts[page.file] = {
      batch_headings: prose(text).filter(line => batchHeading.test(line)).length,
      commit_refs: commitRecordPages.includes(page.file) ? 0 : (text.match(commit) ?? []).length,
      duplicate_lines: repeated.length,
      package_counts: packageCounts(text),
    };
    words += n;
    lines += long.length;
    duplicates += repeated.length;
    tiers[budgeted(page) ? 'budget_words' : referenced(page) ? 'reference_words' : 'unclassified_words'] += n;
    // The reference total in two parts: the engineering tier (its guides, references and current pages) and the
    // reference pages of the owner and operator tiers, consulted on demand.
    if (referenced(page)) tiers[page.tier === 'engineering' ? 'engineering_words' : 'operator_reference_words'] += n;
  }
  return {
    counts,
    owners,
    pages,
    totals: {pages: pages.length, words, long_lines: lines, duplicate_lines: duplicates, ...tiers},
  };
}

/** Every page above its recorded counts (a page with no record must have none). An empty list passes. */
export function lintProblems(root = process.cwd(), baseline = readBaseline(root)) {
  const {counts, owners} = measure(root),
    problems = [];
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline.pages?.[file] ?? {};
    for (const [metric, value] of Object.entries(count))
      if (value > (allowed[metric] ?? 0)) {
        const what = {
          batch_headings: 'headings naming a batch (move the delivery history to docs/records/)',
          commit_refs: 'commit references (a current page says what is true now; cite a record instead)',
          duplicate_lines: 'long lines repeated on another current page (keep each fact in one place and link to it)',
          package_counts:
            'literal package counts (link docs/review/PACKAGE-STATUS.md, generated from the package status, instead)',
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
/**
 * The size targets: the owner and operator tiers' current pages within their word budget, the duplicate-line share of
 * the maintained pages under its target, and the reference total no larger than recorded. An empty list passes.
 */
export function budgetProblems(root = process.cwd(), baseline = readBaseline(root)) {
  const s = summary(root),
    problems = [];
  if (s.budget_words > targets.words)
    problems.push(
      'the owner and operator current pages hold ' +
        s.budget_words +
        ' words, above their budget of ' +
        targets.words +
        ': move detail to a reference page or a record, or shorten them',
    );
  if (s.long_lines && s.duplicate_share >= targets.duplicate_share)
    problems.push(
      'the duplicate-line share is ' +
        (s.duplicate_share * 100).toFixed(1) +
        '%, not under ' +
        targets.duplicate_share * 100 +
        '%: keep each fact in one place and link to it',
    );
  const recorded = baseline.totals?.reference_words;
  if (recorded !== undefined && s.reference_words > recorded)
    problems.push(
      'the reference pages (engineering, and the owner and operator references) hold ' +
        s.reference_words +
        ' words, above the ' +
        recorded +
        ' recorded in ' +
        baselineFile +
        ': shorten them, or record why with node tools/docs-lint.mjs --write --allow-increase=<reason>',
    );
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
 * Records the current counts and the reference total. A count or total above its record is refused unless `reason`
 * says why, and the reason is kept with what it raised; the first record of a tree needs none. Returns the page counts
 * that rose.
 */
export function writeBaseline(root = process.cwd(), reason) {
  const previous = readBaseline(root),
    {counts, totals} = measure(root),
    raised = Object.entries(counts).flatMap(([file, count]) =>
      Object.entries(count)
        .filter(([metric, value]) => value > (previous.pages?.[file]?.[metric] ?? 0))
        .map(([metric, value]) => file + ' ' + metric + ' ' + (previous.pages?.[file]?.[metric] ?? 0) + ' → ' + value),
    ),
    before = previous.totals?.reference_words,
    totalRaised =
      before !== undefined && totals.reference_words > before
        ? ['reference_words ' + before + ' → ' + totals.reference_words]
        : [],
    first = !fs.existsSync(path.join(root, baselineFile));
  if ((raised.length || totalRaised.length) && !reason && !first)
    throw Error(
      'These counts would rise:\n' +
        [...raised, ...totalRaised].join('\n') +
        '\nPass --allow-increase=<reason> to record why.',
    );
  const increase = [...raised, ...totalRaised];
  const data = {
    meaning:
      'DOC-03 documentation freeze: per maintained page, the headings naming a batch, the commit references, the long lines repeated on another maintained page and the literal package counts that it already held; each count may only fall, and a page not listed must have none. totals.reference_words is the size of the reference pages (the engineering tier, and the owner and operator references), outside the word budget of the owner and operator current pages; it may only fall unless an increase is recorded with its reason (node tools/docs-lint.mjs, run by npm run docs:index:check).',
    increases: [...(previous.increases ?? []), ...(increase.length && !first ? [{reason, raised: increase}] : [])],
    totals: {reference_words: totals.reference_words},
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
  const problems = [...lintProblems(root), ...budgetProblems(root)],
    s = summary(root);
  console.log(
    'Maintained pages: ' +
      s.pages +
      '. Owner and operator current pages: ' +
      s.budget_words +
      ' words (budget ' +
      targets.words +
      '). Reference pages: ' +
      s.reference_words +
      ' words, of which engineering ' +
      s.engineering_words +
      ' and the owner and operator references ' +
      s.operator_reference_words +
      ' (recorded ' +
      (readBaseline(root).totals?.reference_words ?? 'not yet') +
      ', may only fall). Duplicate-line share ' +
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
