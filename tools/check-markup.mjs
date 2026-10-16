import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parsers} from 'prettier/plugins/babel';

// WEB-07: escape-by-default markup. web/localization.js defines html`…` (every ${} value is escaped unless it is already
// safe markup), raw() for a fragment AMCP built and escaped itself, and the sinks setHtml and insertHtml, which accept
// only that markup. The website grew without them: its pages build HTML in untagged template literals and string
// concatenations and escape each value by hand. This check counts, per shipped script, what still depends on that
// discipline and fails when a count rises, so new markup is written escape-by-default and the counts only go down:
//   sinks      innerHTML/outerHTML writes and insertAdjacentHTML calls that bypass setHtml and insertHtml;
//   unescaped  values inserted into markup without escaping: interpolations of HTML template literals and operands of
//              HTML string concatenations that are not provably escaped, plus raw() fragments.
// A value counts as escaped when it is a literal, a template whose own values are escaped, a call of an escaping helper,
// a choice between such values, or a list of escaped templates joined together. Anything else is counted, even when
// the author escaped it inside a helper: the count measures what a reader has to verify by hand.
// It also refuses the mistakes a conversion to html`…` can make: escaping a value twice, interpolating a markup string
// or a joined list (which html`…` would escape and show as text), and giving a sink a plain string.

export const baselinePath = 'tools/web-markup-baseline.json';
/** Helpers whose result is fully escaped markup or text: inserting it unescaped is safe. */
export const escapingCalls = new Set(['esc', 'uiEscape', 'uiBidi', 'uiDecimalMarkup', 'encodeURIComponent']);
/** Helpers that return markup strings: inside html`…` they would be escaped and shown as text. */
const markupStringCalls = new Set(['uiBidi', 'uiDecimalMarkup', 'uiMarkup']),
  rawCall = new Set(['raw']),
  sinkHelpers = new Set(['setHtml', 'insertHtml']);
const htmlTag = /<\/?[a-zA-Z][\w:-]*(?=[\s/>]|$)|<!--/;
const skipKeys = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments']);

const isHtmlTemplate = node =>
  node?.type === 'TemplateLiteral' && node.quasis.some(quasi => htmlTag.test(quasi.value.cooked ?? quasi.value.raw));
const isHtmlString = node => node?.type === 'StringLiteral' && htmlTag.test(node.value);
const isTagged = (node, name) =>
  node?.type === 'TaggedTemplateExpression' && node.tag?.type === 'Identifier' && node.tag.name === name;
const calls = (node, names) =>
  node?.type === 'CallExpression' && node.callee?.type === 'Identifier' && names.has(node.callee.name);
const memberCall = (node, name) =>
  node?.type === 'CallExpression' &&
  node.callee?.type === 'MemberExpression' &&
  !node.callee.computed &&
  node.callee.property?.name === name;

/** The operands of a chain of `+`. */
function concatenation(node, out = []) {
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    concatenation(node.left, out);
    concatenation(node.right, out);
  } else out.push(node);
  return out;
}
/** The expressions a function returns (its expression body, or each return statement outside nested functions). */
function returned(fn) {
  if (!fn || !/Function/.test(fn.type)) return null;
  if (fn.body?.type !== 'BlockStatement') return [fn.body];
  const out = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node !== fn.body && /Function/.test(node.type ?? '')) return;
    if (node.type === 'ReturnStatement') {
      if (node.argument) out.push(node.argument);
      return;
    }
    for (const [key, value] of Object.entries(node))
      if (!skipKeys.has(key)) for (const child of Array.isArray(value) ? value : [value]) visit(child);
  };
  visit(fn.body);
  return out;
}

/** Counts, problems and the nodes already counted for one script's source. */
export function inspectMarkup(source, file = 'script.js') {
  const ast = parsers.babel.parse(source, {filepath: file}),
    counted = new WeakSet(),
    problems = [],
    where = node => file + ':' + (node.loc?.start?.line ?? '?');
  let sinks = 0,
    unescaped = 0;
  const values = [],
    leaf = node => {
      values.push({line: node.loc?.start?.line ?? 0, code: source.slice(node.start, node.end).slice(0, 80)});
      return 1;
    },
    literal = node => ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(node?.type);
  /** How many values of a markup expression are inserted without escaping. */
  const unsafe = node => {
    if (!node || literal(node)) return 0;
    switch (node.type) {
      case 'Identifier':
        return node.name === 'undefined' ? 0 : leaf(node);
      case 'TemplateLiteral':
        counted.add(node);
        return node.expressions.reduce((sum, expression) => sum + unsafe(expression), 0);
      case 'TaggedTemplateExpression':
        return isTagged(node, 'html') ? 0 : leaf(node);
      case 'ConditionalExpression':
        return unsafe(node.consequent) + unsafe(node.alternate);
      case 'LogicalExpression':
        return (node.operator === '&&' ? 0 : unsafe(node.left)) + unsafe(node.right);
      case 'BinaryExpression':
        if (node.operator !== '+') return leaf(node);
        counted.add(node);
        return unsafe(node.left) + unsafe(node.right);
      case 'ParenthesizedExpression':
        return unsafe(node.expression);
      case 'CallExpression': {
        // raw() is counted where it is called, once.
        if (calls(node, escapingCalls) || calls(node, rawCall)) return 0;
        // list.map(item => `…`).join('') is as escaped as the template it maps to.
        if (memberCall(node, 'join') && node.arguments.every(literal)) {
          const mapped = node.callee.object;
          if (memberCall(mapped, 'map') || memberCall(mapped, 'flatMap')) {
            const results = returned(mapped.arguments[0]);
            if (results) return results.reduce((sum, result) => sum + unsafe(result), 0);
          }
        }
        return leaf(node);
      }
      default:
        return leaf(node);
    }
  };
  /** Refuses what html`…` would show wrongly: values escaped twice, markup strings and joined lists. */
  const lintTagged = (node, value) => {
    if (!value) return;
    if (value.type === 'ConditionalExpression') {
      lintTagged(node, value.consequent);
      lintTagged(node, value.alternate);
    } else if (value.type === 'LogicalExpression') {
      lintTagged(node, value.left);
      lintTagged(node, value.right);
    } else if (calls(value, new Set(['esc', 'uiEscape'])))
      problems.push(
        where(value) + ': html`…` escapes ' + value.callee.name + '() a second time; interpolate the value',
      );
    else if (calls(value, markupStringCalls))
      problems.push(
        where(value) + ': html`…` would show the markup of ' + value.callee.name + '() as text; use raw() or html`…`',
      );
    else if (
      memberCall(value, 'join') &&
      (memberCall(value.callee.object, 'map') || memberCall(value.callee.object, 'flatMap')) &&
      (returned(value.callee.object.arguments[0]) ?? []).some(
        result => isTagged(result, 'html') || isHtmlTemplate(result) || calls(result, rawCall),
      )
    )
      // A list of text joined with a separator is text and is escaped correctly; a joined list of markup is not.
      problems.push(where(value) + ': html`…` would escape a joined list; interpolate the list of html`…` itself');
    else if (isHtmlTemplate(value))
      problems.push(where(value) + ': an untagged HTML template inside html`…` is escaped; tag it with html');
  };
  const walk = (node, parent, sanctioned = false) => {
    if (!node || typeof node !== 'object') return;
    // The two sinks themselves (web/localization.js) are where escape-by-default markup is written.
    if (node.type === 'ObjectMethod' && sinkHelpers.has(node.key?.name) && /(?:^|\/)localization\.js$/.test(file))
      sanctioned = true;
    if (node.type === 'AssignmentExpression' && ['=', '+='].includes(node.operator)) {
      const property = node.left?.type === 'MemberExpression' && !node.left.computed ? node.left.property?.name : '';
      if (
        (property === 'innerHTML' || property === 'outerHTML') &&
        !(node.right?.type === 'StringLiteral' && node.right.value === '')
      )
        sinks += sanctioned ? 0 : 1;
    }
    if (memberCall(node, 'insertAdjacentHTML') && !sanctioned) sinks++;
    if (calls(node, sinkHelpers)) {
      const markup = node.arguments[node.callee.name === 'setHtml' ? 1 : 2];
      if (['StringLiteral', 'TemplateLiteral', 'BinaryExpression'].includes(markup?.type))
        problems.push(where(node) + ': ' + node.callee.name + '() takes html`…` markup, not a string');
    }
    if (calls(node, rawCall)) {
      const fragment = node.arguments[0];
      if (!(
        fragment?.type === 'StringLiteral' ||
        (fragment?.type === 'TemplateLiteral' && !fragment.expressions.length) ||
        calls(fragment, escapingCalls)
      ))
        unescaped += leaf(node);
    }
    if (isTagged(node, 'html')) for (const value of node.quasi.expressions) lintTagged(node, value);
    if (node.type === 'TemplateLiteral' && !counted.has(node) && !(parent?.type === 'TaggedTemplateExpression')) {
      if (isHtmlTemplate(node)) unescaped += unsafe(node);
    }
    if (
      node.type === 'BinaryExpression' &&
      node.operator === '+' &&
      !counted.has(node) &&
      !(parent?.type === 'BinaryExpression' && parent.operator === '+')
    ) {
      const operands = concatenation(node);
      if (operands.some(operand => isHtmlString(operand) || (isHtmlTemplate(operand) && !counted.has(operand))))
        unescaped += unsafe(node);
    }
    for (const [key, value] of Object.entries(node))
      if (!skipKeys.has(key)) for (const child of Array.isArray(value) ? value : [value]) walk(child, node, sanctioned);
  };
  walk(ast.program, null);
  return {sinks, unescaped, problems, values};
}

/** The shipped first-party scripts (vendor code is reviewed separately and never edited). */
export function markupScripts(root = process.cwd()) {
  return fs
    .readdirSync(path.join(root, 'web'), {recursive: true})
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => file.endsWith('.js') && !file.startsWith('vendor/'))
    .sort();
}
export function markupCounts(root = process.cwd()) {
  const counts = {},
    problems = [];
  for (const file of markupScripts(root)) {
    const result = inspectMarkup(fs.readFileSync(path.join(root, 'web', file), 'utf8'), 'web/' + file);
    counts[file] = {sinks: result.sinks, unescaped: result.unescaped};
    problems.push(...result.problems);
  }
  return {counts, problems};
}
export function readMarkupBaseline(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, baselinePath), 'utf8'));
}
/** Every count above its committed limit (a script missing from the baseline has a limit of zero). */
export function markupRatchet(counts, baseline) {
  const problems = [];
  for (const [file, value] of Object.entries(counts))
    for (const kind of ['sinks', 'unescaped']) {
      const limit = baseline.files?.[file]?.[kind] ?? 0;
      if (value[kind] > limit)
        problems.push(
          'web/' +
            file +
            ': ' +
            value[kind] +
            ' ' +
            (kind === 'sinks' ? 'HTML writes outside setHtml/insertHtml' : 'unescaped markup values') +
            ' (limit ' +
            limit +
            '); build new markup with html`…` and setHtml (WEB-07)',
        );
    }
  return problems;
}
export function checkMarkup(root = process.cwd(), baseline = readMarkupBaseline(root)) {
  const {counts, problems} = markupCounts(root);
  return {counts, problems: [...problems, ...markupRatchet(counts, baseline)]};
}
const totals = counts =>
  Object.values(counts).reduce(
    (sum, value) => ({sinks: sum.sinks + value.sinks, unescaped: sum.unescaped + value.unescaped}),
    {
      sinks: 0,
      unescaped: 0,
    },
  );
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The first recording has no limits to respect; every later one may only lower them.
  const {counts, problems} = checkMarkup(
    process.cwd(),
    fs.existsSync(baselinePath)
      ? readMarkupBaseline()
      : {files: new Proxy({}, {get: () => ({sinks: Infinity, unescaped: Infinity})})},
  );
  const explain = process.argv.indexOf('--explain');
  if (explain > 0) {
    // Lists what a script's count is made of: node tools/check-markup.mjs --explain web/app.js
    const file = process.argv[explain + 1] ?? '';
    for (const value of inspectMarkup(fs.readFileSync(file, 'utf8'), file).values)
      console.log(file + ':' + value.line + ': ' + value.code);
  } else if (process.argv.includes('--write')) {
    // The baseline only moves down: a count above its limit must be fixed, never recorded.
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    const files = Object.fromEntries(Object.entries(counts).filter(([, value]) => value.sinks || value.unescaped));
    fs.writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          meaning:
            'WEB-07 ratchet: per shipped script, HTML writes that bypass setHtml/insertHtml and markup values inserted without escaping. Counts may only go down (node tools/check-markup.mjs --write).',
          totals: totals(files),
          files,
        },
        null,
        2,
      ) + '\n',
    );
    console.log('Markup baseline written: ' + JSON.stringify(totals(files)));
  } else if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else console.log('Escape-by-default markup: ' + JSON.stringify(totals(counts)) + ' (none above the baseline).');
}
