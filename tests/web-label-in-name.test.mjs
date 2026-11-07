// WCAG 2.5.3 Label in Name (closing-fixes, item 1). The full browser qualification found Preview your ads, in Arabic, naming
// each preview link "فتح معاينة …" while the link shows "فتح المعاينة": a person who speaks the words they see could not
// activate it, and the same hole stood in other Arabic names that were translated apart from the words on their control.
//   1. the preview links, rendered by the page's own script in both languages, with one link and with several;
//   2. every control in web/*.js whose aria-label and visible words are both written as catalog messages, in both languages
//      (a scan of the scripts' own template literals, so a control added tomorrow is held to the same rule).
// The comparison is helpers/label-in-name.mjs: the browser qualification's own rule, without case, punctuation or spacing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {parsers} from 'prettier/plugins/babel';
import {curate, decodeMarkup, nameContainsLabel} from './helpers/label-in-name.mjs';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));

/** The page's script in a VM, in the given interface language, returning a function from an answer to its markup. */
function previewMarkup(locale) {
  const context = createContext({document: {addEventListener() {}}, date: String});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  if (locale === 'ar') {
    context.messages = new Map(Object.entries(catalog));
    new Script("uiUseMessages('ar', messages, ['shell', 'ad-previews'])").runInContext(context);
  }
  new Script(readFileSync('web/ad-previews.js', 'utf8')).runInContext(context);
  return answer => {
    context.answer = answer;
    return new Script('previewResults(answer)').runInContext(context);
  };
}
/** The links of some markup: their accessible name (aria-label) and the text they show. */
const links = markup =>
  [...markup.matchAll(/<a\b[^>]*\baria-label="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(match => ({
    name: decodeMarkup(match[1]),
    shown: decodeMarkup(match[2].replace(/<[^>]*>/g, '')),
  }));
const answer = count => ({
  previews: [
    {
      ad_id: '9001',
      name: 'Synthetic1',
      links: Array.from({length: count}, (_, i) => 'https://www.facebook.com/ads/preview/' + (9001 + i)),
    },
  ],
  meaning: 'Synthetic',
});

for (const locale of ['en', 'ar'])
  test(`${locale}: a preview link's accessible name holds the words it shows, with one link and with several`, () => {
    const render = previewMarkup(locale);
    for (const count of [1, 3]) {
      const found = links(render(answer(count)));
      assert.equal(found.length, count);
      found.forEach(({name, shown}, index) => {
        const context = `${count} link(s), link ${index + 1}: "${name}" shows "${shown}"`;
        assert.ok(curate(shown).length > 0, 'the link shows words: ' + context);
        assert.ok(nameContainsLabel(name, shown), 'the name holds the shown words: ' + context);
        // A missing number must not leave a gap in the sentence, and the ad is named.
        assert.doesNotMatch(name, /\s{2,}|^\s|\s$/, 'the name has no stray space: ' + context);
        assert.ok(name.includes('Synthetic1'), 'the name says which ad: ' + context);
        // The number is shown, and so named, only when there are several links to tell apart.
        assert.equal(/\d/.test(shown.replace('9001', '')), count > 1, 'numbered only when several: ' + context);
        assert.equal(/\d/.test(name.replace('Synthetic1', '')), count > 1, 'numbered only when several: ' + context);
      });
    }
  });

// Every template literal of a script, as its text with each ${} replaced by a numbered marker, and those expressions.
const MARK = '\uE000';
const skipKeys = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments']);
function templates(source, file) {
  const found = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'TemplateLiteral')
      found.push({
        line: node.loc.start.line,
        expressions: node.expressions,
        text: node.quasis
          .map(
            (quasi, i) =>
              (quasi.value.cooked ?? quasi.value.raw) + (i < node.expressions.length ? MARK + i + MARK : ''),
          )
          .join(''),
      });
    for (const [key, value] of Object.entries(node))
      if (!skipKeys.has(key)) for (const child of Array.isArray(value) ? value : [value]) visit(child);
  };
  visit(parsers.babel.parse(source, {filepath: file}).program);
  return found;
}
/** The messages a string-valued expression shows: uiText('…') alone, in esc(), or a choice between such calls. */
function messages(node) {
  if (node?.type === 'StringLiteral') return [node.value];
  if (node?.type === 'ConditionalExpression') {
    const [yes, no] = [messages(node.consequent), messages(node.alternate)];
    return yes && no ? [...yes, ...no] : null;
  }
  if (node?.type !== 'CallExpression' || node.callee.type !== 'Identifier') return null;
  if (['esc', 'uiEscape'].includes(node.callee.name) && node.arguments.length === 1) return messages(node.arguments[0]);
  return node.callee.name === 'uiText' ? messages(node.arguments[0]) : null;
}
/** Markup split at its markers: plain text, or the messages of the expression there (null when it is not a message). */
const parts = (markup, expressions) =>
  markup
    .split(new RegExp(MARK + '(\\d+)' + MARK))
    .map((part, i) => (i % 2 ? {messages: messages(expressions[Number(part)])} : {text: part}));
/** One slot of a message such as "Open preview {number}": a value the page fills in, whose words are not known. */
const slot = /\{[a-zA-Z][a-zA-Z0-9_]*\}/g;
const say = (message, locale) => (locale === 'ar' ? (catalog[message] ?? message) : message);

/**
 * The controls of a template that are named by an aria-label of catalog messages and show catalog messages or plain
 * words: each with the names it may have (a choice of messages is a choice of names) and the runs of words it shows.
 * A control whose name or words are computed in ways the scan cannot read is left to the browser qualification.
 */
function controls({line, text, expressions}) {
  const found = [];
  for (const start of text.matchAll(/<([a-z][a-z0-9-]*)\b([^<>]*)>/g)) {
    const [opening, tag, attributes] = start;
    const label = /\baria-label="([^"]*)"/.exec(attributes)?.[1];
    const interactive =
      ['a', 'button', 'summary'].includes(tag) ||
      /\brole="(?:button|link|tab|menuitem|option|checkbox|radio|switch)"/.test(attributes);
    const end = text.indexOf('</' + tag + '>', start.index + opening.length);
    if (label === undefined || !interactive || end < 0) continue;
    const named = parts(label, expressions);
    if (named.some(part => part.messages === null)) continue;
    // The alternatives of the name: every choice of message (at most two choices, so at most four names).
    const names = named.reduce(
      (alternatives, part) =>
        part.text !== undefined
          ? alternatives.map(name => [...name, {text: part.text}])
          : alternatives.flatMap(name => part.messages.map(message => [...name, {message}])),
      [[]],
    );
    // The words shown: text and single messages join into runs; anything else (a value, an icon) ends a run.
    const runs = [[]];
    for (const part of parts(text.slice(start.index + opening.length, end).replace(/<[^<>]*>/g, ''), expressions))
      if (part.text !== undefined) runs.at(-1).push({text: part.text});
      else if (part.messages?.length === 1) runs.at(-1).push({message: part.messages[0]});
      else runs.push([]);
    found.push({line: line + text.slice(0, start.index).split('\n').length - 1, tag, names, runs});
  }
  return found;
}
const render = (piece, locale) =>
  piece.map(part => (part.message === undefined ? part.text : say(part.message, locale))).join('');

test('every control named by an aria-label of catalog messages shows its words in that name, in English and Arabic', () => {
  const judged = [],
    mismatches = [];
  for (const file of readdirSync('web').filter(name => name.endsWith('.js')))
    for (const template of templates(readFileSync('web/' + file, 'utf8'), file))
      for (const control of controls(template)) {
        const shown = locale => control.runs.flatMap(run => render(run, locale).split(slot)).filter(run => curate(run));
        if (!shown('en').length) continue;
        judged.push(file + ':' + control.line);
        for (const locale of ['en', 'ar'])
          for (const name of control.names.map(piece => render(piece, locale).replaceAll(slot, ' ')))
            for (const words of shown(locale))
              if (!nameContainsLabel(name, words))
                mismatches.push(
                  `${file}:${control.line} <${control.tag}> ${locale}: "${words.trim()}" is not in "${name}"`,
                );
      }
  // The scan must keep seeing controls: it is the rule's reach, and a scan that sees none proves nothing.
  assert.ok(judged.length >= 8, 'the scan judged ' + judged.length + ' controls');
  assert.deepEqual(mismatches, []);
});
