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
import fs from 'node:fs';
import path from 'node:path';

export const statuses = Object.freeze(['current', 'reference', 'record', 'proposal', 'archived']);
export const tiers = Object.freeze(['owner', 'operator', 'engineering']);
const keys = Object.freeze(['status', 'tier', 'generated']);
/** The pages outside docs/ the documentation counts, with the meta data their front matter would hold. */
export const declaredMeta = Object.freeze({'README.md': Object.freeze({status: 'current', tier: 'operator'})});

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
