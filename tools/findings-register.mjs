// The findings register (DOC-03): docs/review/findings.json is the machine-readable register of every review finding,
// and this writes its two views, so nobody keeps a finding's status in prose: the open view (docs/review/FINDINGS.md:
// the counts, every open finding listed and then in full with its record and what remains, the sections of the
// hand-written page it replaced, each by an anchor of its old name beside the closed view's heading that holds it now,
// and the controls verified correct) and the closed view (docs/review/FINDINGS-CLOSED.md: every closed finding with
// the text it was recorded with, grouped as it was found). Every finding is in exactly one view. Before, the register
// was a hand-written page whose later findings were prose paragraphs with no open-items view.
// `npm run docs:index` writes both views and `npm run docs:index:check` fails when one differs from the register.
// Usage on its own: node tools/findings-register.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {frontMatterBlock} from './docs-front-matter.mjs';
import {headingSlug} from './docs-links.mjs';

export const registerFile = 'docs/review/findings.json',
  openView = 'docs/review/FINDINGS.md',
  closedView = 'docs/review/FINDINGS-CLOSED.md';
export const severities = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);
const cell = v =>
  String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ');

/** Every problem with the register (an empty list passes). */
export function registerProblems(register) {
  const problems = [];
  if (register?.schema_version !== 1) return ['schema_version must be 1'];
  const open = register.states?.open ?? [],
    closed = register.states?.closed ?? [];
  if (!open.length || !closed.length || open.some(s => closed.includes(s)))
    problems.push('states lists the open and the closed statuses, each once');
  const paragraphs = list => Array.isArray(list) && list.every(p => typeof p === 'string' && p.trim());
  if (!paragraphs(register.intro)) problems.push('intro is a list of paragraphs');
  if (!Array.isArray(register.groups) || !register.groups.length) return [...problems, 'groups lists the groups'];
  if (!Array.isArray(register.findings) || !register.findings.length)
    return [...problems, 'findings lists the findings'];
  for (const g of register.groups)
    if (!g || typeof g.id !== 'string' || typeof g.title !== 'string' || !paragraphs(g.intro ?? [null]))
      return [...problems, 'each group has its id, title and intro paragraphs (an empty list for none)'];
    else if (g.notes !== undefined && !Array.isArray(g.notes)) problems.push(g.id + ': notes is a list');
  const groups = new Set(register.groups.map(g => g.id)),
    ids = new Set();
  for (const f of register.findings) {
    if (!f || typeof f !== 'object') {
      problems.push('a finding is an object');
      continue;
    }
    const at = message => problems.push((f.id ?? '?') + ': ' + message);
    if (!/^F-\d+$/.test(String(f?.id))) at('an ID is F- and a number');
    if (ids.has(f.id)) at('is listed twice');
    ids.add(f.id);
    if (!severities.includes(f.severity)) at('severity is one of ' + severities.join(', '));
    if (!groups.has(f.group)) at('names no group of the register');
    if (!(typeof f.area === 'string' && f.area.trim())) at('names the area it was found in');
    if (![...open, ...closed].includes(f.status)) at('status ' + JSON.stringify(f.status) + ' is in neither state');
    if (!(typeof f.text === 'string' && f.text.trim()) && !(typeof f.finding === 'string' && f.finding.trim()))
      at('has its text or its finding');
    if (f.remaining !== undefined && !(typeof f.remaining === 'string' && f.remaining.trim()))
      at('remaining names what remains');
  }
  for (const g of register.groups ?? [])
    for (const note of g.notes ?? []) {
      const after = (register.findings ?? []).find(f => f?.id === note.after);
      if (!after) problems.push(g.id + ': a note follows ' + note.after + ', which is no finding');
      // A note is a paragraph between paragraphs: the views print it after its finding's text.
      else if (after.group !== g.id || !after.text)
        problems.push(g.id + ': a note follows ' + note.after + ', which is no paragraph finding of this group');
      if (!(typeof note.text === 'string' && note.text.trim())) problems.push(g.id + ': a note has its text');
    }
  if (!(typeof register.controls_verified === 'string' && register.controls_verified.trim()))
    problems.push('controls_verified holds the controls verified correct');
  // The hand-written page's sections, each with the closed view's heading that holds its findings now (optional).
  if (register.former_sections !== undefined) {
    const text = v => typeof v === 'string' && v.trim();
    if (
      !Array.isArray(register.former_sections) ||
      !register.former_sections.every(s => s && text(s.title) && text(s.now))
    )
      problems.push('former_sections lists each former section with its title and the heading that holds it now');
    else if (new Set(register.former_sections.map(s => headingSlug(s.title))).size !== register.former_sections.length)
      problems.push('former_sections names each former section once');
  }
  return problems;
}
/**
 * The former sections whose heading the closed view no longer has: each names a heading of the closed view, where a
 * link to the section's old address is sent on.
 */
export function formerSectionProblems(register, closedText = closedViewText(register)) {
  const headings = new Set(
    closedText
      .split('\n')
      .map(line => /^#{2,3} (.+)$/.exec(line)?.[1])
      .filter(Boolean),
  );
  return (register.former_sections ?? [])
    .filter(s => !headings.has(s.now))
    .map(s => 'former section "' + s.title + '" names "' + s.now + '", which is no heading of the closed view');
}
/** Whether a finding is open: an open status, or a closed one that still names what remains. */
export const isOpen = (register, f) => register.states.open.includes(f.status) || f.remaining !== undefined;
/**
 * A finding's one-line summary: its finding, or for a finding recorded as a paragraph, the paragraph's first sentence
 * without its bold "F-245 (medium, O, partial):" label.
 */
export function summaryOf(f) {
  if (f.finding) return f.finding.replace(/\s*\n\s*/g, ' ');
  const text = f.text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/^\*\*[^*]*\*\*:?\s*/, '')
    .replace(/^\*\*[^*]*:\*\*\s*/, '');
  return /^.*?[.;](?=\s|$)/.exec(text)?.[0] ?? text;
}
/** The fields of a finding recorded as a table row, in the order the register's tables gave them. */
const recordFields = [
  ['evidence', 'Evidence'],
  ['failure_scenario', 'Failure scenario'],
  ['recommendation', 'Recommendation'],
  ['effort', 'Effort'],
  ['resolution', 'Status'],
];
/** An open finding in full: its record as written (the text of a paragraph finding), what remains, and its notes. */
function openDetail(register, f) {
  const group = register.groups.find(g => g.id === f.group),
    lines = ['### ' + f.id + ' (' + f.severity + ')', ''];
  lines.push(
    '- Found in: ' +
      group.title +
      (f.area ? ': ' + f.area : '') +
      (f.found_against ? ', against `' + f.found_against + '`' : ''),
  );
  if (f.text) lines.push('', f.text);
  else {
    lines.push('- Finding: ' + f.finding.replace(/\s*\n\s*/g, ' '));
    for (const [key, label] of recordFields)
      if (f[key] !== undefined) lines.push('- ' + label + ': ' + String(f[key]).replace(/\s*\n\s*/g, ' '));
    if (f.resolution === undefined) lines.push('- Status: ' + f.status);
  }
  if (f.remaining !== undefined) lines.push(...(f.text ? [''] : []), '- What remains: ' + f.remaining);
  for (const note of (group.notes ?? []).filter(n => n.after === f.id)) lines.push('', note.text);
  return [...lines, ''];
}

/** The open view's text. */
export function openViewText(register) {
  const open = register.findings.filter(f => isOpen(register, f)),
    closed = register.findings.filter(f => !isOpen(register, f)),
    groupTitle = new Map(register.groups.map(g => [g.id, g.title])),
    row = (label, list) =>
      '| ' +
      label +
      ' | ' +
      severities.map(s => list.filter(f => f.severity === s).length).join(' | ') +
      ' | ' +
      list.length +
      ' |';
  const lines = [
    frontMatterBlock({status: 'reference', tier: 'engineering', generated: 'tools/findings-register.mjs'}).trimEnd(),
    '',
    '# Findings register',
    '',
    'Generated by `npm run docs:index` from [findings.json](findings.json), the machine-readable register: to add, change',
    'or close a finding, edit the register and run `npm run docs:index`; `npm run docs:index:check` fails when this page',
    'or the [closed findings](FINDINGS-CLOSED.md) differ from it. This page is the open view; the closed view keeps',
    'every closed finding with the text it was recorded with.',
    '',
    ...register.intro.flatMap(p => [p, '']),
    '## Counts',
    '',
    '| State | ' + severities.map(s => s[0].toUpperCase() + s.slice(1)).join(' | ') + ' | Total |',
    '|---|' + severities.map(() => '---:').join('|') + '|---:|',
    row('Open', open),
    row('Closed', closed),
    '',
    '## Open findings',
    '',
  ];
  if (open.length) {
    lines.push(
      'Each open finding is listed here, then in full below with its record as written and what remains.',
      '',
      '| ID | Severity | Found in | Finding | Status |',
      '|---|---|---|---|---|',
    );
    for (const f of open)
      lines.push(
        '| ' +
          [
            '[' + f.id + '](#' + f.id.toLowerCase() + '-' + f.severity + ')',
            f.severity,
            cell(groupTitle.get(f.group) + (f.area ? ': ' + f.area : '')),
            cell(summaryOf(f)),
            f.status,
          ].join(' | ') +
          ' |',
      );
    lines.push('');
    for (const f of open) lines.push(...openDetail(register, f));
    lines.pop();
  } else lines.push('None.');
  // A link to a section of the hand-written page this one replaced still lands here, beside where it went.
  if (register.former_sections?.length) {
    lines.push(
      '',
      '## Sections of the hand-written register',
      '',
      'Until 2026-10-24 this page was the hand-written register, in the sections below. Their open findings are listed',
      'above and their closed findings are in the [closed findings](FINDINGS-CLOSED.md); a link to one of those sections',
      'still opens here.',
      '',
      '| Section | Now in |',
      '|---|---|',
    );
    for (const s of register.former_sections)
      lines.push(
        '| <a id="' +
          headingSlug(s.title) +
          '"></a>' +
          cell(s.title) +
          ' | [' +
          cell(s.now) +
          '](FINDINGS-CLOSED.md#' +
          headingSlug(s.now) +
          ') |',
      );
  }
  lines.push('', '## Controls verified correct (not re-audit targets)', '', register.controls_verified);
  return lines.join('\n') + '\n';
}

/** The closed view's text: each group with its introduction, its tables by area and its prose findings. */
export function closedViewText(register) {
  const lines = [
    frontMatterBlock({status: 'reference', tier: 'engineering', generated: 'tools/findings-register.mjs'}).trimEnd(),
    '',
    '# Closed findings',
    '',
    'Generated by `npm run docs:index` from [findings.json](findings.json); the open findings are in the',
    '[findings register](FINDINGS.md). Each closed finding keeps the text it was recorded with, grouped as it was found.',
    '',
  ];
  for (const group of register.groups) {
    const members = register.findings.filter(f => f.group === group.id && !isOpen(register, f));
    if (!members.length) continue;
    lines.push('## ' + group.title, '', ...group.intro.flatMap(p => [p, '']));
    // Consecutive findings of one area form one table (or, for prose findings, one run of paragraphs).
    const runs = [];
    for (const f of members) {
      const last = runs.at(-1);
      if (last && last.area === f.area && last.table === !f.text) last.findings.push(f);
      else runs.push({area: f.area, table: !f.text, findings: [f]});
    }
    for (const run of runs) {
      lines.push('### ' + run.area, '');
      const against = [...new Set(run.findings.map(f => f.found_against).filter(Boolean))];
      if (run.table) {
        if (against.length === 1) lines.push('Found against `' + against[0] + '`.', '');
        const scenario = run.findings.some(f => f.failure_scenario);
        lines.push(
          '| ID | Sev | Finding | Evidence |' +
            (scenario ? ' Failure scenario |' : '') +
            ' Recommendation | Effort | Status |',
          '|---|---|---|---|' + (scenario ? '---|' : '') + '---|---|---|',
        );
        for (const f of run.findings)
          lines.push(
            '| ' +
              [
                f.id,
                f.severity,
                cell(f.finding),
                cell(f.evidence),
                ...(scenario ? [cell(f.failure_scenario)] : []),
                cell(f.recommendation),
                cell(f.effort),
                cell(f.resolution ?? f.status),
              ].join(' | ') +
              ' |',
          );
        lines.push('');
      } else
        for (const f of run.findings) {
          lines.push(f.text, '');
          for (const note of (group.notes ?? []).filter(n => n.after === f.id)) lines.push(note.text, '');
        }
    }
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/** Validates the register and writes or (check) compares both views; returns the problems (an empty list passes). */
export function findingsProblems(root, {write = false} = {}) {
  let register;
  try {
    register = JSON.parse(fs.readFileSync(path.join(root, registerFile), 'utf8'));
  } catch (error) {
    return [registerFile + ': ' + error.message];
  }
  const problems = registerProblems(register).map(p => registerFile + ': ' + p);
  if (problems.length) return problems;
  const closedText = closedViewText(register),
    former = formerSectionProblems(register, closedText).map(p => registerFile + ': ' + p);
  if (former.length) return former;
  for (const [file, text] of [
    [openView, openViewText(register)],
    [closedView, closedText],
  ]) {
    const target = path.join(root, file),
      current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') : undefined;
    if (current === text) continue;
    if (write) fs.writeFileSync(target, text);
    else problems.push(file + ' is out of date with ' + registerFile + '. Run npm run docs:index.');
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url)),
    problems = findingsProblems(root, {write: !process.argv.includes('--check')});
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else console.log('The findings register and its two views agree.');
}
