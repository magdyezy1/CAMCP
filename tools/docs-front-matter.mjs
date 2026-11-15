// The front matter of the documentation pages (DOC-03). Every Markdown page under docs/ opens with two lines that say
// what the page is and who reads it:
//
//   ---
//   status: current
//   tier: operator
//   ---
//
// status:  current   what is true now, kept short and current (the word budget of tools/docs-lint.mjs counts it)
//          reference deep detail consulted on demand: the engineering guides, references and runbooks (a separate size
//                    report, which may only fall)
//          record    dated: what was delivered, decided, measured or found on a day, kept as written
//          proposal  a plan or proposal that is not the product
//          archived  superseded and kept for its history, or the redirect stub a moved page leaves
// tier:    owner       workspace owners at agencies and in-house teams (the owner guide, English and Arabic)
//          operator    whoever deploys, configures, accepts and runs AMCP
//          engineering whoever changes AMCP
//
// A generated page also names its generator (`generated: tools/docs-index.mjs`). The block holds only these keys,
// one `key: value` per line, so a Markdown renderer shows it as a small table and every tool reads it the same way.
// The repository README is the one page outside docs/: it is GitHub's landing page, so it carries no block and its
// meta data is declared here (pageMeta). docs/REPORTING-OVERVIEW.md is also an MCP guide resource: src/guidance.ts
// serves it without its front matter, so AI clients read the same text as before.
//
// The index (tools/docs-index.mjs) places every page from its front matter, and the documentation lint
// (tools/docs-lint.mjs) counts the owner and operator tiers' current pages against their word budget. A page's folder
// must agree with what it says it is (folderRules): a dated record never passes for a current page, and outside the
// record folders a current page never passes for a record, a proposal or an archived page (reviewedOutsideRecords).
import fs from 'node:fs';
import path from 'node:path';

export const statuses = Object.freeze(['current', 'reference', 'record', 'proposal', 'archived']);
export const tiers = Object.freeze(['owner', 'operator', 'engineering']);
const keys = Object.freeze(['status', 'tier', 'generated']);
/** The pages outside docs/ the documentation counts, with the meta data their front matter would hold. */
export const declaredMeta = Object.freeze({'README.md': Object.freeze({status: 'current', tier: 'operator'})});
/**
 * What a page in these folders may say it is: the dated records and the implementation records are records (the one
 * generated report among the implementation records is a reference), the archive is archived, and the owner guide is
 * the owner tier's current pages. No other folder holds the owner tier.
 */
export const folderRules = Object.freeze([
  {folder: 'docs/records/', statuses: ['record']},
  {folder: 'docs/implementation/', statuses: ['record', 'reference']},
  {folder: 'docs/archive/', statuses: ['archived']},
  {folder: 'docs/owner/', statuses: ['current'], tiers: ['owner']},
]);
/** The folders whose pages may say they are a record or archived (their folder rule says which). */
const recordFolders = Object.freeze(['docs/records/', 'docs/implementation/', 'docs/archive/']);
/**
 * The other way round: outside those folders a page is current or reference, since a record, proposal or archived page
 * counts in neither the word budget nor the reference total of tools/docs-lint.mjs, nor in its freeze, so the label
 * alone would take a hand-written page out of all three. The exceptions are the redirect stubs of docs/moved.json and
 * these pages, each reviewed to be what it says where links expect it (DOC-03, 2026-10-24): dated pages and proposals
 * of the review folder, and the plan of Round 2.5, which the owner approved on 2026-11-15 and whose own section 12 puts
 * in docs/plan/ (Round 2.5 M0, merge task 4). Another needs its entry here, or moves to docs/records/ or docs/archive/.
 */
export const reviewedOutsideRecords = Object.freeze({
  'docs/plan/workflow-seamlessness.md': 'record',
  'docs/review/ACCESSIBILITY.md': 'record',
  'docs/review/IMPLEMENTATION-2026-10-01.md': 'record',
  'docs/review/PRODUCT-BLUEPRINT-2026-10-01.md': 'proposal',
  'docs/review/ROADMAP.md': 'proposal',
});

const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/** A page's front matter and the text after it: {data, body}; data is null when the page opens without a block. */
export function frontMatter(text) {
  const match = block.exec(text);
  if (!match) return {data: null, body: text};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([a-z_]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!pair) return {data: {invalid: line}, body: text.slice(match[0].length).replace(/^(?:\r?\n)+/, '')};
    data[pair[1]] = pair[2];
  }
  return {data, body: text.slice(match[0].length).replace(/^(?:\r?\n)+/, '')};
}
/** The text without its front matter (unchanged when it has none). */
export const stripFrontMatter = text => frontMatter(text).body;
/** The block for a page's meta data, in key order, followed by one blank line. */
export function frontMatterBlock(data) {
  return (
    '---\n' +
    keys
      .filter(key => data[key] !== undefined)
      .map(key => key + ': ' + data[key])
      .join('\n') +
    '\n---\n\n'
  );
}
/** The text with this front matter in place of any it had. */
export const withFrontMatter = (data, text) => frontMatterBlock(data) + stripFrontMatter(text);
/** What is wrong with a page's front matter (an empty list passes). */
export function frontMatterProblems(file, text) {
  const {data} = frontMatter(text);
  if (!data) return [file + ': no front matter (---, status: …, tier: …, ---) at the top of the page'];
  if (data.invalid !== undefined) return [file + ': a front matter line is not `key: value`: ' + data.invalid];
  const problems = [];
  for (const key of Object.keys(data))
    if (!keys.includes(key)) problems.push(file + ': unknown front matter key ' + key + ' (' + keys.join(', ') + ')');
  if (!statuses.includes(data.status))
    problems.push(file + ': status is one of ' + statuses.join(', ') + ', not ' + JSON.stringify(data.status ?? ''));
  if (!tiers.includes(data.tier))
    problems.push(file + ': tier is one of ' + tiers.join(', ') + ', not ' + JSON.stringify(data.tier ?? ''));
  if (data.generated !== undefined && !/^tools\/[\w./-]+\.(?:mjs|ts)$/.test(data.generated))
    problems.push(file + ': generated names the tool that writes the page (tools/….mjs)');
  return problems;
}
/** A page's meta data: its front matter, or the declaration of a page outside docs/ (null when it has neither). */
export function pageMeta(root, file) {
  if (Object.hasOwn(declaredMeta, file)) return {...declaredMeta[file]};
  const {data} = frontMatter(fs.readFileSync(path.join(root, file), 'utf8'));
  return data && data.invalid === undefined ? data : null;
}
/** Every documentation page, repository-relative and sorted: the repository README and each Markdown page in docs/. */
export function documentationPages(root = process.cwd()) {
  const out = [];
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const file = relative + '/' + entry.name;
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.md')) out.push(file);
    }
  };
  if (fs.existsSync(path.join(root, 'docs'))) visit('docs');
  return [...(fs.existsSync(path.join(root, 'README.md')) ? ['README.md'] : []), ...out.sort()];
}
/**
 * Every documentation page's front matter problem (an empty list passes): a page without a valid block, a page whose
 * folder holds another kind of page, a redirect stub (`stubs`, the old addresses of docs/moved.json) that is not
 * archived, a generator that does not exist, and a record, proposal or archived page outside the record folders that
 * is neither a stub nor reviewed to be one.
 */
export function documentationProblems(root = process.cwd(), stubs = new Set()) {
  const problems = [];
  for (const file of documentationPages(root)) {
    if (Object.hasOwn(declaredMeta, file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8'),
      found = frontMatterProblems(file, text);
    problems.push(...found);
    if (found.length) continue;
    const {data} = frontMatter(text),
      rule = folderRules.find(r => file.startsWith(r.folder));
    if (rule && !rule.statuses.includes(data.status))
      problems.push(file + ': a page in ' + rule.folder + ' is ' + rule.statuses.join(' or ') + ', not ' + data.status);
    if (rule?.tiers && !rule.tiers.includes(data.tier))
      problems.push(file + ': a page in ' + rule.folder + ' is for the ' + rule.tiers.join(' or ') + ' tier');
    if (data.tier === 'owner' && !file.startsWith('docs/owner/'))
      problems.push(file + ': the owner tier is the owner guide, in docs/owner/');
    if (stubs.has(file) && data.status !== 'archived') problems.push(file + ': a redirect stub is archived');
    if (data.generated && !fs.existsSync(path.join(root, data.generated)))
      problems.push(file + ': its generator ' + data.generated + ' does not exist');
    if (
      ['record', 'proposal', 'archived'].includes(data.status) &&
      !recordFolders.some(folder => file.startsWith(folder)) &&
      !stubs.has(file) &&
      reviewedOutsideRecords[file] !== data.status
    )
      problems.push(
        file +
          ': outside ' +
          recordFolders.join(', ') +
          ' a page is current or reference, not ' +
          data.status +
          ' (move it there, or review it into reviewedOutsideRecords in tools/docs-front-matter.mjs)',
      );
  }
  return problems;
}
