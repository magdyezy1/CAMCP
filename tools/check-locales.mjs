import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parsers} from 'prettier/plugins/babel';

const slots = value =>
  [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)]
    .map(m => m[1])
    .sort()
    .join(',');
export function localeProblems(catalog, required) {
  const problems = [];
  for (const key of required) if (!Object.hasOwn(catalog, key)) problems.push('Missing Arabic message: ' + key);
  for (const [key, value] of Object.entries(catalog))
    if (typeof value !== 'string' || !value.trim() || /[<>]/.test(value) || slots(key) !== slots(value))
      problems.push('Invalid Arabic message or interpolation: ' + key);
  return problems;
}
export function inspectLocaleSource(source, file = 'script.js') {
  const ast = parsers.babel.parse(source, {filepath: file}),
    required = new Set(),
    problems = [];
  const maps = new Set(['authErrors', 'commandPages', 'workspaceTitles', 'pageTitle', 'pageErrorCauses']);
  const collectValues = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'StringLiteral' && !node.value.startsWith('/') && /[a-zA-Z]{2}/.test(node.value))
      required.add(node.value);
    if (node.type === 'ObjectProperty') collectValues(node.value);
    else
      for (const [key, value] of Object.entries(node))
        if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
          for (const child of Array.isArray(value) ? value : [value]) collectValues(child);
  };
  const walk = (node, ancestors = []) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && maps.has(node.id?.name)) collectValues(node.init);
    if (node.type === 'VariableDeclarator' && file.endsWith('app.js') && node.id?.name === 'labels')
      collectValues(node.init);
    if (node.type === 'VariableDeclarator' && node.id?.name === 'approvalState')
      for (const property of node.init?.properties ?? []) collectValues(property.value?.elements?.[1]);
    if (node.type === 'CallExpression' && node.callee?.name === 'uiText') {
      if (node.arguments[0]?.type === 'StringLiteral') required.add(node.arguments[0].value);
      if (/^_?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(node.arguments[0]?.value ?? ''))
        problems.push(file + ':' + node.loc.start.line + ': technical identifiers must not be translated');
      const parent = ancestors.at(-1);
      if (
        (parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator)) ||
        (parent?.type === 'SwitchCase' && parent.test === node) ||
        (parent?.type === 'ObjectProperty' &&
          parent.value === node &&
          [
            'action',
            'method',
            'operation',
            'role',
            'account_id',
            'connection_id',
            'id',
            'gateway',
            'platform',
            'grant_type',
            'type',
          ].includes(parent.key.name ?? parent.key.value))
      )
        problems.push(
          file +
            ':' +
            node.loc.start.line +
            ': interface translation cannot change a protocol value or control comparison',
        );
    }
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value])
          if (child && typeof child === 'object') walk(child, [...ancestors, node]);
  };
  walk(ast);
  return {required, problems};
}
export function checkWebLocales(root = process.cwd()) {
  const directory = path.join(root, 'web'),
    required = new Set(),
    problems = [];
  const json = fs.readFileSync(path.join(directory, 'locales/ar.json'), 'utf8');
  const catalog = JSON.parse(json);
  const object = parsers.babel.parse('(' + json + ')', {filepath: 'catalog.js'}).program.body[0].expression;
  const seen = new Set();
  for (const property of object.properties) {
    const key = property.key.value;
    if (seen.has(key)) problems.push('Duplicate Arabic message: ' + key);
    seen.add(key);
  }
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.js'))) {
    const result = inspectLocaleSource(fs.readFileSync(path.join(directory, file), 'utf8'), file);
    result.required.forEach(key => required.add(key));
    problems.push(...result.problems);
  }
  // These two fields are first-party display copy; never translate provider names, scopes or request fields.
  const platforms = parsers['babel-ts'].parse(fs.readFileSync(path.join(root, 'server/platform-oauth.ts'), 'utf8'));
  for (const statement of platforms.program.body) {
    if (statement.type !== 'ExportNamedDeclaration') continue;
    const declaration = statement.declaration?.declarations?.find(value => value.id?.name === 'platforms');
    for (const platform of declaration?.init?.elements ?? [])
      for (const property of platform.properties ?? [])
        if (['kind', 'description'].includes(property.key?.name) && property.value?.type === 'StringLiteral')
          required.add(property.value.value);
  }
  const index = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  for (const match of index.matchAll(/data-ui-(?:text|label|placeholder|title)="([^"]+)"/g))
    required.add(
      match[1]
        .replaceAll('&quot;', '"')
        .replaceAll('&#x27;', "'")
        .replaceAll('&#39;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&'),
    );
  problems.push(...localeProblems(catalog, required));
  const scripts = [...index.matchAll(/<script src="([^\"]+)" defer>/g)].map(m => m[1]);
  if (scripts[0] !== '/assets/localization.js') problems.push('Localization must load before application scripts.');
  return {problems, required_messages: required.size, catalog_messages: Object.keys(catalog).length};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkWebLocales();
  if (result.problems.length) {
    console.error(result.problems.join('\n'));
    process.exitCode = 1;
  } else console.log(JSON.stringify(result));
}
