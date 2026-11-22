// F-L8-04: two round-2 collector warnings were in the Arabic catalog but reached the Arabic interface in English,
// because uiSourceWarning translates only the sentences it lists (provider text is never translated), and the locale
// checker cannot see a sentence that never reaches uiText. This contract reads every static sentence the report
// sources author, from their source, and requires each to translate under uiSourceWarning in Arabic with the catalog
// chunks the report builder actually loads. A warning added to a collector without its Arabic and its entry in
// web/report-quality.js fails here, whichever package adds it.
// always-run: lists src/ for every report source and its warnings
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {parsers} from 'prettier/plugins/babel';
import {loadRouteRegistry} from '../tools/check-routes.mjs';
import {chunksWith, loaderFiles} from '../tools/locale-chunks.mjs';

const skip = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments']),
  nameOf = node => node?.name ?? node?.value ?? node?.property?.name;
const visit = (node, fn) => {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const [key, value] of Object.entries(node))
    if (!skip.has(key)) for (const child of Array.isArray(value) ? value : [value]) visit(child, fn);
};

/**
 * The static sentences a TypeScript source puts in a warning: the values of a `warnings` property or variable, the
 * arguments of a warnings.push/add/unshift and of any call named for a warning, and string constants of the same file
 * that reach one of those. A sentence built with `${}` or by concatenation is dynamic and is left to its template.
 */
export function authoredWarnings(source, file = 'module.ts') {
  const program = parsers['babel-ts'].parse(source, {filepath: file}).program,
    constants = new Map(),
    found = new Set();
  const text = node =>
    node?.type === 'StringLiteral'
      ? node.value
      : node?.type === 'TemplateLiteral' && !node.expressions.length
        ? node.quasis[0].value.cooked
        : undefined;
  visit(program, node => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && text(node.init) !== undefined)
      constants.set(node.id.name, text(node.init));
  });
  const collect = node => {
    if (!node) return;
    if (text(node) !== undefined) found.add(text(node));
    else if (node.type === 'Identifier' && constants.has(node.name)) found.add(constants.get(node.name));
    else if (node.type === 'ConditionalExpression') [node.consequent, node.alternate].forEach(collect);
    else if (node.type === 'ArrayExpression') node.elements.forEach(collect);
    else if (node.type === 'SpreadElement') collect(node.argument);
    else if (node.type === 'LogicalExpression') [node.left, node.right].forEach(collect);
    else if (
      ['ParenthesizedExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression'].includes(node.type)
    )
      collect(node.expression);
  };
  visit(program, node => {
    if (node.type === 'ObjectProperty' && nameOf(node.key) === 'warnings') collect(node.value);
    if (node.type === 'VariableDeclarator' && /warnings?$/i.test(String(nameOf(node.id)))) collect(node.init);
    if (node.type === 'AssignmentExpression' && /warnings?$/i.test(String(nameOf(node.left)))) collect(node.right);
    if (node.type === 'CallExpression') {
      if (/warn/i.test(String(nameOf(node.callee)))) node.arguments.forEach(collect);
      if (
        node.callee?.type === 'MemberExpression' &&
        /^(?:push|add|unshift)$/.test(nameOf(node.callee.property)) &&
        /warnings?$/i.test(String(nameOf(node.callee.object)))
      )
        node.arguments.forEach(collect);
    }
  });
  // A sentence has words; the codes and keys a source also keeps in these positions do not.
  return [...found].filter(value => /\s/.test(value) && value.length >= 12);
}

/**
 * The modules whose warnings become a snapshot source's `warnings`: the report-source adapters and the shared collectors
 * (any module named for a report, an overview or a reporting collector), and Microsoft's account-zone note.
 * decision-reporting.ts builds guided capture reports, whose notices the evidence pages show instead.
 */
export const reportSourceModule = file =>
  (file
    .replace(/\.ts$/, '')
    .split('-')
    .some(token => ['report', 'overview', 'reporting'].includes(token)) &&
    file !== 'decision-reporting.ts') ||
  file === 'microsoft-timezones.ts';

/** The website's page scripts and Arabic catalog chunks for the report builder, in one language. */
function builder(locale) {
  const {dependencies} = loaderFiles(),
    route = [...loadRouteRegistry()].find(entry => entry.path === '/reporting-overview'),
    catalog = {};
  assert.ok(route?.assets?.length, 'the registry lists the report builder’s scripts');
  for (const chunk of new Set([...route.assets].flatMap(file => [...chunksWith(file, dependencies)])))
    Object.assign(catalog, JSON.parse(fs.readFileSync('web/locales/ar/' + chunk + '.json', 'utf8')));
  const context = createContext({document: {addEventListener() {}}, Intl, Date, catalog});
  const run = code => new Script(code).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  if (locale === 'ar') run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))');
  run(fs.readFileSync('web/report-quality.js', 'utf8'));
  return {warning: value => ((context.value = value), run('uiSourceWarning(value)'))};
}

test('the scanner reads every position a collector puts a static warning in, and nothing else', () => {
  const found = authoredWarnings(`
    const named = 'A named constant sentence reaches the card.';
    const warnings = ['A declared array sentence reaches the card.'];
    export const a = {
      warnings: [
        'A property array sentence reaches the card.',
        flag ? 'A conditional sentence one reaches the card.' : 'A conditional sentence two reaches the card.',
        ...(flag ? ['A spread sentence reaches the card.'] : []),
        named,
        \`A template without values reaches the card.\`,
        \`A template with \${value} is dynamic.\`,
        'a-code',
      ],
      message: 'A message that is not a warning stays out of it.',
    };
    warnings.push('A pushed sentence reaches the card.');
    result.warnings.add('An added sentence reaches the card.');
    addWarning('A helper call sentence reaches the card.');
    x.warnings = ['An assigned array sentence reaches the card.'];
    other.push('A push to something else stays out of it.');
  `);
  assert.deepEqual(found.sort(), [
    'A conditional sentence one reaches the card.',
    'A conditional sentence two reaches the card.',
    'A declared array sentence reaches the card.',
    'A helper call sentence reaches the card.',
    'A named constant sentence reaches the card.',
    'A property array sentence reaches the card.',
    'A pushed sentence reaches the card.',
    'A spread sentence reaches the card.',
    'A template without values reaches the card.',
    'An added sentence reaches the card.',
    'An assigned array sentence reaches the card.',
  ]);
  assert.equal(reportSourceModule('ga4-report-source.ts'), true);
  assert.equal(reportSourceModule('overview-native-detail.ts'), true);
  assert.equal(reportSourceModule('x-campaign-report.ts'), true);
  assert.equal(reportSourceModule('microsoft-timezones.ts'), true);
  assert.equal(reportSourceModule('workflows.ts'), false);
  assert.equal(reportSourceModule('decision-reporting.ts'), false);
});

test('every static warning a report source authors translates in Arabic with the chunks the report builder loads', () => {
  const sentences = new Map();
  for (const file of fs.readdirSync('src').filter(name => name.endsWith('.ts') && reportSourceModule(name)))
    for (const sentence of authoredWarnings(fs.readFileSync('src/' + file, 'utf8'), file))
      sentences.set(sentence, [...(sentences.get(sentence) ?? []), file]);
  // Guards the scan itself: it must see the collectors' sentences, including the two round 2 ones this contract was
  // written for, or "every sentence translates" would hold of nothing.
  assert.ok(sentences.size >= 40, 'the scan found ' + sentences.size + ' sentences');
  for (const known of [
    'The reporting window was not declared complete. Results remain partial and recommendations are withheld.',
    'Current native entity status could not be read. Status filters exclude unknown entities and keep the source partial.',
  ])
    assert.ok(sentences.has(known), 'the scan finds: ' + known);
  const english = builder('en'),
    arabic = builder('ar'),
    untranslated = [...sentences]
      .filter(([sentence]) => {
        const shown = arabic.warning(sentence);
        return shown === sentence || !/[؀-ۿ]/.test(shown);
      })
      .map(([sentence, files]) => files.join(', ') + ': ' + sentence);
  assert.deepEqual(untranslated, [], 'these collector warnings reach the Arabic interface in English');
  // English keeps every sentence exactly as the collector wrote it.
  for (const sentence of sentences.keys()) assert.equal(english.warning(sentence), sentence);
});

test('text that only resembles an authored warning is shown as it is, in Arabic too', () => {
  const arabic = builder('ar');
  for (const value of [
    'The reporting window was not declared complete.',
    'the reporting window was not declared complete. results remain partial and recommendations are withheld.',
    'Provider warning 0012.34 <img>',
    'Home',
  ])
    assert.equal(arabic.warning(value), value);
});
