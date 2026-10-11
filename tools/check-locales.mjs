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
// The workspace shell and the pages every person sees first (WEB-05): their messages are whole and slotted.
export const shellScripts = new Set([
  'app.js',
  'identity.js',
  'localization.js',
  'routes.js',
  'workspace.js',
  'account-security.js',
  'account-scope.js',
  'route-assets.js',
  'capability-center.js',
]);
export function inspectLocaleSource(source, file = 'script.js') {
  const ast = parsers.babel.parse(source, {filepath: file}),
    required = new Set(),
    problems = [];
  const collectMessage = node => {
    if (node?.type === 'StringLiteral') required.add(node.value);
    if (node?.type === 'ConditionalExpression') {
      collectMessage(node.consequent);
      collectMessage(node.alternate);
    }
  };
  const maps = new Set([
    'authErrors',
    'legalMessages',
    'pageTitle',
    'pageErrorCauses',
    'recipeLabels',
    'recipeDependencyLabels',
    'recipeEligibilityLabels',
    'recipePrerequisiteLabels',
    'reviewConsentLabels',
    'operationLabels',
    'reportLabels',
    'reportAnalysisLabels',
    'gtmFindingLabels',
    'gtmEntityLabels',
    'allocationReviewLabels',
    'reportMetricLabels',
    'measurementIdentityLabels',
    'measurementLedgerLayers',
    'measurementLedgerStates',
    'measurementLedgerReasons',
    'capabilityLabels',
    'capabilityEvidenceHeaders',
    'capabilityContractMessages',
    'themeLabels',
    'statusLabels',
    'capabilityFeatureLabels',
  ]);
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
    // WEB-06: the route registry's display names are interface copy; paths, flags and page keys are not.
    // WEB-08: the palette's owner commands (identity.js) carry the same display fields.
    if (node.type === 'VariableDeclarator' && ['routeRegistry', 'ownerCommands'].includes(node.id?.name))
      for (const entry of node.init?.elements ?? [])
        for (const property of entry.properties ?? [])
          if (['label', 'group', 'aliases', 'description'].includes(property.key?.name)) collectValues(property.value);
    if (
      node.type === 'VariableDeclarator' &&
      ['app.js', 'capability-center.js', 'workbook-schedules.js'].some(name => file.endsWith(name)) &&
      node.id?.name === 'labels'
    )
      collectValues(node.init);
    if (node.type === 'VariableDeclarator' && node.id?.name === 'previewFormats')
      for (const option of node.init?.elements ?? []) collectValues(option.elements?.[1]);
    if (node.type === 'VariableDeclarator' && file.endsWith('creative-push.js') && node.id?.name === 'state')
      collectValues(node.init);
    if (node.type === 'VariableDeclarator' && node.id?.name === 'approvalState')
      for (const property of node.init?.properties ?? []) collectValues(property.value?.elements?.[1]);
    if (node.type === 'CallExpression' && ['uiText', 'uiMarkup'].includes(node.callee?.name)) {
      collectMessage(node.arguments[0]);
      if (/^_?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(node.arguments[0]?.value ?? ''))
        problems.push(file + ':' + node.loc.start.line + ': technical identifiers must not be translated');
      // WEB-05: the shell builds each sentence from one slotted message; a space-padded fragment glued to a value
      // cannot be reordered in Arabic and mixes directions.
      if (
        shellScripts.has(path.basename(file)) &&
        [node.arguments[0], node.arguments[0]?.consequent, node.arguments[0]?.alternate].some(
          argument => argument?.type === 'StringLiteral' && /^\s|\s$/.test(argument.value),
        )
      )
        problems.push(
          file +
            ':' +
            node.loc.start.line +
            ': build the sentence from one slotted message, not a space-padded fragment',
        );
      if (
        ancestors.some(
          ancestor =>
            ancestor.type === 'CallExpression' &&
            ancestor.callee?.name === 'controls' &&
            ancestor.arguments.slice(1).some(argument => argument === node || ancestors.includes(argument)),
        )
      )
        problems.push(
          file + ':' + node.loc.start.line + ': form types, defaults and native field names must not be translated',
        );
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
// Selected first-party explanatory fields only. Never collect diagnostics, native protocol fields or user context.
export function inspectReportExplanations(source, file) {
  const ast = parsers['babel-ts'].parse(source),
    messages = new Set();
  const collect = node => {
    if (node?.type === 'StringLiteral') messages.add(node.value);
    else if (node?.type === 'ArrayExpression') node.elements.forEach(collect);
    // Conditional limitations such as ...(expired ? ['…'] : []) are authored copy too.
    else if (node?.type === 'SpreadElement') collect(node.argument);
    else if (node?.type === 'ConditionalExpression') {
      collect(node.consequent);
      collect(node.alternate);
    }
  };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'ObjectProperty' &&
      [
        'reason',
        'limitations',
        ...(['allocation-plan.ts', 'allocation-calibration.ts'].some(name => file.endsWith(name)) ? ['meaning'] : []),
      ].includes(node.key?.name)
    )
      collect(node.value);
    // Shared limitation copy (for example provider-decimal.ts metricRoundingLimitation) is authored text too.
    if (node.type === 'VariableDeclarator' && /Limitation$/.test(node.id?.name ?? '')) collect(node.init);
    if (node.type === 'CallExpression' && file.endsWith('report-metrics.ts') && node.callee?.name === 'result')
      collect(node.arguments[1]);
    if (node.type === 'CallExpression' && file.endsWith('decision-reporting.ts') && node.callee?.name === 'add')
      collect(node.arguments[2]);
    // Selected allocation workflow refusals are authored copy. Dynamic provider diagnostics and error codes stay exact.
    if (
      node.type === 'CallExpression' &&
      ['bad', 'invalid'].includes(node.callee?.name) &&
      [
        'report-allocation.ts',
        'allocation-plan.ts',
        'google-allocation-budgets.ts',
        'linkedin-allocation-budgets.ts',
        'allocation-calibration.ts',
      ].some(name => file.endsWith(name))
    )
      collect(node.arguments[0]);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) walk(child);
  };
  walk(ast);
  return messages;
}
/** Only AMCP-authored contract explanations. Dynamic/native reasons never become translation templates. */
export function inspectContractExplanations(source) {
  const ast = parsers['babel-ts'].parse(source),
    messages = new Set();
  const collect = value => {
    if (value?.type === 'StringLiteral' && /[a-zA-Z]{2}/.test(value.value)) messages.add(value.value.trim());
    if (value?.type === 'ConditionalExpression') {
      collect(value.consequent);
      collect(value.alternate);
    }
  };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ObjectProperty' && ['reason', 'meaning'].includes(node.key?.name)) collect(node.value);
    if (
      node.type === 'AssignmentExpression' &&
      node.left?.type === 'MemberExpression' &&
      node.left.property?.name === 'reason'
    )
      collect(node.right);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) walk(child);
  };
  walk(ast);
  return messages;
}
// Account explanations are authored display fields; dynamic native fragments are never inferred from text.
export function inspectAccountExplanations(source, file) {
  const ast = parsers['babel-ts'].parse(source),
    messages = new Set();
  const collect = node => {
    if (node?.type === 'StringLiteral') messages.add(node.value);
    else if (node?.type === 'ArrayExpression') node.elements.forEach(collect);
    else if (node?.type === 'ConditionalExpression') {
      collect(node.consequent);
      collect(node.alternate);
    }
  };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'ObjectProperty' &&
      [
        'meaning',
        ...(file.endsWith('gtm-diagnostics.ts') ? ['limitations'] : []),
        ...(file.endsWith('catalog-ingestion.ts') ? ['destination_limitations'] : []),
      ].includes(node.key?.name)
    )
      collect(node.value);
    if (file.endsWith('gtm-diagnostics.ts') && node.type === 'CallExpression' && node.callee?.name === 'finding')
      collect(node.arguments[3]);
    // Product read-back failures are authored AMCP sentences. Retain native fields/values in separate details.
    if (file.endsWith('meta-catalog-products.ts') && node.type === 'CallExpression') {
      if (node.callee?.name === 'unverified') collect(node.arguments[0]);
      if (node.callee?.name === 'fail' && node.arguments[0]?.value === 'VERIFICATION_UNSUPPORTED')
        collect(node.arguments[1]);
    }
    if (
      [
        'google-pmax-image-links.ts',
        'google-pmax-brand-image-links.ts',
        'woocommerce-source.ts',
        'woocommerce-inventory.ts',
      ].some(name => file.endsWith(name)) &&
      node.type === 'VariableDeclarator' &&
      [
        'pmaxImageMeaning',
        'pmaxBrandImageMeaning',
        'wooCommerceSourceMeaning',
        'wooCommerceVariationMeaning',
        'wooCommerceInventoryMeaning',
      ].includes(node.id?.name)
    )
      collect(node.init);
    // This selected workflow's first argument is authored refusal copy. Never collect error codes or
    // fallback native diagnostics, and do not broaden other source files to every throw/message.
    if (
      [
        'gtm-consent-plans.ts',
        'meta-asset-usage.ts',
        'google-image-usage.ts',
        'snapchat-asset-usage.ts',
        'google-pmax-image-links.ts',
        'google-pmax-brand-image-links.ts',
        'x-catalog-removal.ts',
        'x-catalog-selection-inventory.ts',
        'woocommerce-source.ts',
        'woocommerce-inventory.ts',
      ].some(name => file.endsWith(name)) &&
      node.type === 'CallExpression' &&
      ['bad', 'invalid', ...(file.endsWith('x-catalog-removal.ts') ? ['changed'] : [])].includes(node.callee?.name)
    )
      collect(node.arguments[0]);
    if (
      ['woocommerce-source.ts', 'woocommerce-inventory.ts'].some(name => file.endsWith(name)) &&
      node.type === 'NewExpression' &&
      node.callee?.name === 'MirrorError'
    )
      collect(node.arguments[1]);
    if (
      file.endsWith('woocommerce-source.ts') &&
      node.type === 'CallExpression' &&
      node.callee?.type === 'MemberExpression' &&
      (node.callee.object?.name === 'blockers' || node.callee.object?.property?.name === 'blockers') &&
      node.callee.property?.name === 'push'
    )
      collect(node.arguments[0]);
    if (
      file.endsWith('x-catalog-removal.ts') &&
      node.type === 'CallExpression' &&
      node.callee?.name === 'bad' &&
      node.arguments[0]?.type === 'LogicalExpression'
    )
      collect(node.arguments[0].right);
    if (
      file.endsWith('catalog-ingestion.ts') &&
      node.type === 'CallExpression' &&
      node.callee?.name === 'bad' &&
      node.arguments[1]?.value === 'INVALID_X_CATALOG_IMPORT'
    )
      collect(node.arguments[0]);
    if (
      file.endsWith('workspace.ts') &&
      node.type === 'CallExpression' &&
      node.callee?.name === 'bad' &&
      node.arguments[1]?.value === 'INVALID_CATALOG_INVENTORY' &&
      node.arguments[0]?.type === 'StringLiteral'
    )
      collect(node.arguments[0]);
    if (file.endsWith('x-catalog-comparison.ts')) {
      if (
        node.type === 'CallExpression' &&
        node.callee?.name === 'fail' &&
        ['CATALOG_SCAN_LIMIT', 'CATALOG_COMPARISON_CHANGED'].includes(node.arguments[0]?.value)
      )
        collect(node.arguments[1]);
      if (
        node.type === 'NewExpression' &&
        node.callee?.name === 'MirrorError' &&
        node.arguments[0]?.value === 'CATALOG_COMPARISON_LIMIT'
      )
        collect(node.arguments[1]);
    }
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) walk(child);
  };
  walk(ast);
  return messages;
}
// The guidance AMCP attaches to a failed report source or sync (diagnostic.next_action) is authored copy; the website
// translates it next to the provider's literal message (WEB-05). Codes and provider text are never collected.
export function inspectSourceNextActions(source) {
  const messages = new Set();
  const collect = node => {
    if (node?.type === 'StringLiteral') messages.add(node.value);
    if (node?.type === 'ConditionalExpression') {
      collect(node.consequent);
      collect(node.alternate);
    }
  };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'AssignmentExpression' &&
      node.left?.type === 'MemberExpression' &&
      node.left.object?.name === 'diagnostic' &&
      node.left.property?.name === 'next_action'
    )
      collect(node.right);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) walk(child);
  };
  walk(parsers['babel-ts'].parse(source));
  return messages;
}
// This exact collector owns direct refusal sentences. Dynamic diagnostics and fallback expressions stay native.
export function inspectReportingFailures(source, file) {
  const messages = new Set();
  const ownedCalls = {
    'src/google-reporting.ts': ['bad', 'incomplete'],
    'src/decision-reporting.ts': [
      'nativeDeviceMappingFailure',
      'nativeHourMappingFailure',
      'nativeCountryMappingFailure',
    ],
    'src/meta-evidence.ts': ['bad', 'incomplete'],
    'src/linkedin-evidence.ts': ['bad', 'incomplete'],
    'src/tiktok-reporting.ts': ['bad', 'incomplete'],
    'src/snapchat-evidence.ts': ['bad', 'incomplete', 'shape'],
  }[file.replaceAll('\\', '/')];
  if (!ownedCalls) return messages;
  const ast = parsers['babel-ts'].parse(source);
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'CallExpression' &&
      ownedCalls.includes(node.callee?.name) &&
      node.arguments[0]?.type === 'StringLiteral'
    )
      messages.add(node.arguments[0].value);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) walk(child);
  };
  walk(ast);
  return messages;
}
// Exact imported website diagnostic sentences; native fallbacks, protocol values and lexical shadows remain excluded.
function importedMirrorErrorSentences(source, errorModule) {
  const messages = new Set();
  const program = parsers['babel-ts'].parse(source).program,
    constructors = new Set();
  for (const statement of program.body)
    if (
      statement.type === 'ImportDeclaration' &&
      statement.source.value === errorModule &&
      statement.importKind !== 'type'
    )
      for (const specifier of statement.specifiers)
        if (
          specifier.type === 'ImportSpecifier' &&
          specifier.imported.name === 'MirrorError' &&
          specifier.importKind !== 'type'
        )
          constructors.add(specifier.local.name);
  const bindingNames = node => {
    if (!node) return [];
    if (node.type === 'Identifier') return [node.name];
    if (node.type === 'RestElement') return bindingNames(node.argument);
    if (node.type === 'AssignmentPattern') return bindingNames(node.left);
    if (node.type === 'TSParameterProperty') return bindingNames(node.parameter);
    if (node.type === 'ObjectPattern')
      return node.properties.flatMap(property =>
        bindingNames(property.type === 'RestElement' ? property.argument : property.value),
      );
    if (node.type === 'ArrayPattern') return node.elements.flatMap(bindingNames);
    return [];
  };
  const isFunction = node =>
      [
        'FunctionDeclaration',
        'FunctionExpression',
        'ArrowFunctionExpression',
        'ObjectMethod',
        'ClassMethod',
        'ClassPrivateMethod',
      ].includes(node.type),
    visit = (node, callback, ancestors = []) => {
      if (!node || typeof node !== 'object') return;
      callback(node, ancestors);
      for (const [key, value] of Object.entries(node))
        if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
          for (const child of Array.isArray(value) ? value : [value]) visit(child, callback, [...ancestors, node]);
    },
    shadowed = [];
  const shadow = (node, names) => {
    const affected = names.filter(name => constructors.has(name));
    if (affected.length) shadowed.push({start: node.start, end: node.end, names: new Set(affected)});
  };
  visit(program, (node, ancestors) => {
    if (isFunction(node)) shadow(node, [...node.params.flatMap(bindingNames), ...bindingNames(node.id)]);
    if (node.type === 'CatchClause') shadow(node, bindingNames(node.param));
    if (node.type === 'ClassExpression') shadow(node, bindingNames(node.id));
    if (node.type === 'VariableDeclarator' || node.type === 'ClassDeclaration' || node.type === 'FunctionDeclaration') {
      const names = bindingNames(node.id);
      if (!names.some(name => constructors.has(name))) return;
      const declaration = ancestors.at(-1),
        scopes = [...ancestors].reverse(),
        scope =
          node.type === 'VariableDeclarator' && declaration?.kind === 'var'
            ? (scopes.find(isFunction) ?? program)
            : (scopes.find(parent =>
                [
                  'BlockStatement',
                  'StaticBlock',
                  'ForStatement',
                  'ForInStatement',
                  'ForOfStatement',
                  'SwitchStatement',
                  'Program',
                ].includes(parent.type),
              ) ?? program);
      shadow(scope, names);
    }
  });
  visit(program, node => {
    if (
      node.type === 'NewExpression' &&
      node.callee?.type === 'Identifier' &&
      constructors.has(node.callee.name) &&
      node.arguments[1]?.type === 'StringLiteral' &&
      !shadowed.some(scope => scope.names.has(node.callee.name) && node.start >= scope.start && node.end <= scope.end)
    )
      messages.add(node.arguments[1].value);
  });
  return messages;
}
export function inspectWebsiteFailures(source, file) {
  const selected = new Set([
    'server/account-routes.ts',
    'server/account-security.ts',
    'server/asset-discovery.ts',
    'server/google-account-discovery.ts',
    'server/google-reauthorization.ts',
    'server/http-app.ts',
    'server/media-source-routes.ts',
    'server/password-hashes.ts',
    'server/platform-oauth.ts',
    'server/social-signin.ts',
    'server/user-accounts.ts',
    'server/web-store.ts',
    'server/website.ts',
  ]);
  if (!selected.has(file.replaceAll('\\', '/'))) return new Set();
  return importedMirrorErrorSentences(source, '../src/errors.js');
}

export function inspectCoreContractFailures(source, file) {
  const selected = new Set([
    'src/catalog.ts',
    'src/service.ts',
    'src/store.ts',
    'src/transport.ts',
    'src/delegated-native.ts',
    'src/workflows.ts',
  ]);
  if (!selected.has(file.replaceAll('\\', '/'))) return new Set();
  return importedMirrorErrorSentences(source, './errors.js');
}

export function inspectBackendContractFailures(source, file) {
  const messages = new Set();
  if (typeof file !== 'string') return messages;
  file = file.replaceAll('\\', '/');
  if (!/^(src|server)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ts$/.test(file) || path.posix.normalize(file) !== file)
    return messages;
  const program = parsers['babel-ts'].parse(source).program,
    modules = new Set();
  for (const statement of program.body)
    if (
      statement.type === 'ImportDeclaration' &&
      statement.source.value.startsWith('.') &&
      path.posix
        .normalize(path.posix.join(path.posix.dirname(file), statement.source.value))
        .replace(/\.js$/, '.ts') === 'src/errors.ts'
    )
      modules.add(statement.source.value);
  for (const module of modules)
    for (const message of importedMirrorErrorSentences(source, module)) messages.add(message);
  return messages;
}
// Qualify only unchanged message parameters of sole-throw local runtime helpers and their sole-call forwarders.
export function inspectBackendWrapperFailures(source, file) {
  const bindingNames = node =>
    !node
      ? []
      : node.type === 'Identifier'
        ? [node.name]
        : node.type === 'RestElement'
          ? bindingNames(node.argument)
          : node.type === 'AssignmentPattern'
            ? bindingNames(node.left)
            : node.type === 'TSParameterProperty'
              ? bindingNames(node.parameter)
              : node.type === 'ObjectPattern'
                ? node.properties.flatMap(property =>
                    bindingNames(property.type === 'RestElement' ? property.argument : property.value),
                  )
                : node.type === 'ArrayPattern'
                  ? node.elements.flatMap(bindingNames)
                  : [];
  const isFunction = node =>
    [
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
      'ObjectMethod',
      'ClassMethod',
      'ClassPrivateMethod',
    ].includes(node.type);
  const visit = (node, callback, ancestors = []) => {
    if (!node || typeof node !== 'object') return;
    callback(node, ancestors);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) visit(child, callback, [...ancestors, node]);
  };

  const messages = new Set();
  if (typeof file !== 'string') return messages;
  file = file.replaceAll('\\', '/');
  if (!/^(src|server)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ts$/.test(file) || path.posix.normalize(file) !== file)
    return messages;
  const program = parsers['babel-ts'].parse(source, {filepath: file}).program,
    functions = program.body
      .map(node => (node.type === 'ExportNamedDeclaration' ? node.declaration : node))
      .filter(node => node?.type === 'FunctionDeclaration' && node.id && node.body.body.length === 1);
  const candidates = new Map();
  const duplicateNames = new Set();
  for (const fn of functions) {
    if (candidates.has(fn.id.name)) duplicateNames.add(fn.id.name);
    else candidates.set(fn.id.name, fn);
  }
  for (const name of duplicateNames) candidates.delete(name);
  const shadows = [];
  const shadow = (node, names) => {
    const affected = names.filter(name => candidates.has(name));
    if (affected.length) shadows.push({start: node.start, end: node.end, names: new Set(affected)});
  };
  visit(program, (node, ancestors) => {
    if (isFunction(node))
      shadow(node, [
        ...node.params.flatMap(bindingNames),
        ...bindingNames(node.id).filter(name => candidates.get(name) !== node),
      ]);
    if (node.type === 'CatchClause') shadow(node, bindingNames(node.param));
    if (node.type === 'ClassExpression') shadow(node, bindingNames(node.id));
    if (['VariableDeclarator', 'ClassDeclaration', 'FunctionDeclaration'].includes(node.type)) {
      const names = bindingNames(node.id).filter(name => candidates.has(name) && candidates.get(name) !== node);
      if (!names.length) return;
      const declaration = ancestors.at(-1),
        scopes = [...ancestors].reverse(),
        scope =
          node.type === 'VariableDeclarator' && declaration?.kind === 'var'
            ? (scopes.find(isFunction) ?? program)
            : (scopes.find(parent =>
                [
                  'BlockStatement',
                  'StaticBlock',
                  'ForStatement',
                  'ForInStatement',
                  'ForOfStatement',
                  'SwitchStatement',
                  'Program',
                ].includes(parent.type),
              ) ?? program);
      shadow(scope, names);
    }
  });
  const shadowed = (node, name) =>
    shadows.some(scope => scope.names.has(name) && node.start >= scope.start && node.end <= scope.end);
  const assigned = new Set(),
    literals = new Set();
  visit(program, node => {
    if (node.type === 'StringLiteral') literals.add(node.value);
    const target =
      node.type === 'AssignmentExpression'
        ? node.left
        : node.type === 'UpdateExpression'
          ? node.argument
          : ['ForInStatement', 'ForOfStatement'].includes(node.type) && node.left.type !== 'VariableDeclaration'
            ? node.left
            : null;
    for (const name of bindingNames(target)) if (candidates.has(name) && !shadowed(node, name)) assigned.add(name);
  });
  const signature = (fn, identifier) =>
      fn.params.findIndex(parameter => parameter.type === 'Identifier' && parameter.name === identifier),
    direct = [];
  for (const [name, fn] of candidates) {
    if (assigned.has(name)) continue;
    const statement = fn.body.body[0],
      expression = statement.argument;
    if (
      statement.type !== 'ThrowStatement' ||
      expression?.type !== 'NewExpression' ||
      expression.callee.type !== 'Identifier' ||
      expression.arguments[1]?.type !== 'Identifier'
    )
      continue;
    const node = expression.arguments[1],
      index = signature(fn, node.name);
    if (index < 0) continue;
    let sentinel = '__AMCP_LOCAL_WRAPPER_' + fn.start + '__';
    while (literals.has(sentinel)) sentinel += '_';
    literals.add(sentinel);
    direct.push({fn, node, index, sentinel});
  }
  let probe = source;
  for (const row of [...direct].sort((a, b) => b.node.start - a.node.start))
    probe = probe.slice(0, row.node.start) + JSON.stringify(row.sentinel) + probe.slice(row.node.end);
  const qualified = inspectBackendContractFailures(probe, file),
    wrappers = new Map(
      direct.filter(row => qualified.has(row.sentinel)).map(row => [row.fn.id.name, {fn: row.fn, index: row.index}]),
    );
  let progress = true;
  while (progress) {
    progress = false;
    for (const [name, fn] of candidates) {
      if (wrappers.has(name) || assigned.has(name)) continue;
      const statement = fn.body.body[0],
        call =
          statement.type === 'ReturnStatement'
            ? statement.argument
            : statement.type === 'ExpressionStatement'
              ? statement.expression
              : null;
      if (
        call?.type !== 'CallExpression' ||
        call.arguments.some(argument => argument.type === 'SpreadElement') ||
        call.callee.type !== 'Identifier' ||
        !wrappers.has(call.callee.name) ||
        shadowed(call, call.callee.name)
      )
        continue;
      const parameter = call.arguments[wrappers.get(call.callee.name).index];
      if (parameter?.type !== 'Identifier') continue;
      const index = signature(fn, parameter.name);
      if (index >= 0) {
        wrappers.set(name, {fn, index});
        progress = true;
      }
    }
  }
  visit(program, node => {
    if (
      node.type !== 'CallExpression' ||
      node.arguments.some(argument => argument.type === 'SpreadElement') ||
      node.callee?.type !== 'Identifier' ||
      !wrappers.has(node.callee.name) ||
      shadowed(node, node.callee.name)
    )
      return;
    const message = node.arguments[wrappers.get(node.callee.name).index];
    if (message?.type === 'StringLiteral') messages.add(message.value);
  });
  return messages;
}

export function backendContractSourceFiles(root = process.cwd()) {
  const files = [];
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(file);
    }
  };
  for (const directory of ['src', 'server']) visit(directory);
  return files.sort();
}

// Exact owned portfolio sentences; dynamic/native fallbacks and all protocol values remain outside this inventory.
export function inspectPortfolioFailures(source, file) {
  const owned = {
      'src/portfolio.ts': ['bad'],
      'src/google-portfolio.ts': ['bad', 'invalid'],
      'src/meta-portfolio.ts': ['bad', 'invalid'],
      'src/linkedin-portfolio.ts': ['bad', 'invalid'],
      'src/snapchat-portfolio.ts': ['bad', 'invalid'],
      'src/tiktok-portfolio.ts': ['bad', 'invalid'],
      'src/x-portfolio.ts': ['bad', 'invalid'],
    }[file.replaceAll('\\', '/')],
    messages = new Set();
  if (!owned) return messages;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      owned.includes(node.callee.name) &&
      node.arguments[0]?.type === 'StringLiteral'
    )
      messages.add(node.arguments[0].value);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) walk(child);
  };
  walk(parsers['babel-ts'].parse(source));
  return messages;
}

// Exact authored measurement refusals. Native diagnostics, dynamic fallbacks and protocol fields stay outside translation.
export function inspectMeasurementFailures(source, file) {
  const owned = {
      'src/measurement-events.ts': ['bad', 'invalid'],
      'src/measurement-event-identity.ts': ['bad', 'invalid'],
      'src/linkedin-conversion-evidence.ts': ['bad', 'invalid'],
      'src/measurement-ledger.ts': ['bad'],
      'src/gtm-consent-evidence.ts': [],
    }[file.replaceAll('\\', '/')],
    messages = new Set();
  if (!owned) return messages;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'CallExpression' &&
      owned.includes(node.callee?.name) &&
      node.arguments[0]?.type === 'StringLiteral'
    )
      messages.add(node.arguments[0].value);
    if (
      file.replaceAll('\\', '/') === 'src/gtm-consent-evidence.ts' &&
      node.type === 'NewExpression' &&
      node.callee?.name === 'MirrorError' &&
      node.arguments[1]?.type === 'StringLiteral'
    )
      messages.add(node.arguments[1].value);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) walk(child);
  };
  walk(parsers['babel-ts'].parse(source));
  return messages;
}

// Exact shared recovery hints reached by the selected native capture collectors.
function inspectCaptureRemedies(source, file, otherProviders, measurement = false) {
  const messages = new Set();
  if (file.replaceAll('\\', '/') !== 'src/errors.ts') return messages;
  const visit = (node, callback) => {
    if (!node || typeof node !== 'object') return;
    callback(node);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) visit(child, callback);
  };
  for (const statement of parsers['babel-ts'].parse(source).program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'FunctionDeclaration') continue;
    visit(declaration.body, node => {
      if (node.type === 'IfStatement') {
        let selected = false;
        visit(node.test, condition => {
          if (
            declaration.id.name === 'familyRemedy' &&
            condition.type === 'RegExpLiteral' &&
            [
              '_LIMIT$',
              '_MISMATCH$',
              'REPORT',
              ...(otherProviders ? ['_REQUIRED$'] : []),
              ...(measurement ? ['_INVALID$'] : []),
            ].includes(condition.pattern)
          )
            selected = true;
          if (
            declaration.id.name === 'errorRemedy' &&
            ((condition.type === 'StringLiteral' && condition.value === 'REPORT_SHAPE_CHANGED') ||
              (otherProviders &&
                condition.type === 'RegExpLiteral' &&
                condition.pattern === '^(INVALID|MISSING|CONFLICTING|UNSUPPORTED|UNKNOWN)_'))
          )
            selected = true;
        });
        if (selected)
          visit(node.consequent, value => {
            if (
              declaration.id.name === 'familyRemedy' &&
              value.type === 'CallExpression' &&
              value.callee?.name === 'r' &&
              value.arguments[1]?.type === 'StringLiteral'
            )
              messages.add(value.arguments[1].value);
            if (
              declaration.id.name === 'errorRemedy' &&
              value.type === 'ObjectProperty' &&
              value.key?.name === 'action' &&
              value.value?.type === 'StringLiteral'
            )
              messages.add(value.value.value);
          });
      }
      if (
        declaration.id.name === 'errorResult' &&
        node.type === 'VariableDeclarator' &&
        node.id?.name === 'remediation' &&
        node.init?.type === 'ObjectExpression'
      )
        for (const property of node.init.properties)
          if (
            // Provider and measurement reads report a replaced login as CONNECTION_AUTHORITY_CHANGED (CON-01).
            (otherProviders
              ? ['CONNECTION_AUTHORITY_CHANGED', 'INSUFFICIENT_SCOPE']
              : ['REAUTHORIZATION_REQUIRED']
            ).includes(property.key?.name) &&
            property.value?.type === 'StringLiteral'
          )
            messages.add(property.value.value);
    });
    if (measurement && declaration.id.name === 'errorRemedy') {
      // Only the two selected metadata refusals and the final authored fallback reached by measurement reads.
      for (const node of declaration.body.body) {
        if (node.type === 'VariableDeclaration')
          for (const value of node.declarations)
            if (value.id?.name === 'stateRead' && value.init?.type === 'ObjectExpression')
              for (const property of value.init.properties)
                if (
                  ['STATE_TOO_LARGE', 'STATE_TARGET_MISMATCH'].includes(property.key?.name) &&
                  property.value?.type === 'StringLiteral'
                )
                  messages.add(property.value.value);
      }
      const last = declaration.body.body.at(-1);
      if (last?.type === 'ReturnStatement' && last.argument?.type === 'ObjectExpression')
        for (const property of last.argument.properties) {
          const value = property.value;
          if (
            property.key?.name === 'action' &&
            value?.type === 'ConditionalExpression' &&
            value.test?.type === 'BinaryExpression' &&
            value.test.operator === '===' &&
            value.test.left?.type === 'MemberExpression' &&
            value.test.left.object?.name === 'e' &&
            value.test.left.property?.name === 'code' &&
            value.test.right?.type === 'StringLiteral' &&
            value.test.right.value === 'INTERNAL_ERROR' &&
            value.alternate?.type === 'StringLiteral'
          )
            messages.add(value.alternate.value);
        }
    }
  }
  return messages;
}
export const inspectGoogleCaptureRemedies = (source, file) => inspectCaptureRemedies(source, file, false);
export const inspectProviderCaptureRemedies = (source, file) => inspectCaptureRemedies(source, file, true);
export const inspectMeasurementRemedies = (source, file) => inspectCaptureRemedies(source, file, true, true);
export function inspectSharedRecoveryHints(source, file) {
  const messages = new Set();
  if (file.replaceAll('\\', '/') !== 'src/errors.ts') return messages;
  const visit = (node, callback) => {
    if (!node || typeof node !== 'object') return;
    callback(node);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) visit(child, callback);
  };
  const literalBranches = node => {
    if (node?.type === 'StringLiteral') messages.add(node.value);
    else if (node?.type === 'ConditionalExpression') {
      literalBranches(node.consequent);
      literalBranches(node.alternate);
    }
  };
  for (const statement of parsers['babel-ts'].parse(source).program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (
      declaration?.type !== 'FunctionDeclaration' ||
      !['familyRemedy', 'errorRemedy', 'errorResult'].includes(declaration.id.name)
    )
      continue;
    visit(declaration.body, node => {
      if (
        declaration.id.name === 'familyRemedy' &&
        node.type === 'CallExpression' &&
        node.callee?.name === 'r' &&
        node.arguments[1]?.type === 'StringLiteral'
      )
        messages.add(node.arguments[1].value);
      if (declaration.id.name === 'errorRemedy' && node.type === 'ObjectProperty' && node.key?.name === 'action')
        literalBranches(node.value);
      if (
        node.type === 'VariableDeclarator' &&
        node.init?.type === 'ObjectExpression' &&
        ((declaration.id.name === 'errorRemedy' && node.id?.name === 'stateRead') ||
          (declaration.id.name === 'errorResult' && node.id?.name === 'remediation'))
      )
        for (const property of node.init.properties)
          if (/^[A-Z][A-Z_]*$/.test(property.key?.name ?? '') && property.value?.type === 'StringLiteral')
            messages.add(property.value.value);
    });
  }
  return messages;
}
export function checkWebLocales(root = process.cwd()) {
  const directory = path.join(root, 'web'),
    required = new Set(),
    problems = [];
  const json = fs.readFileSync(path.join(directory, 'locales/ar.json'), 'utf8');
  if (Buffer.byteLength(json, 'utf8') > 2097152) problems.push('Arabic catalog exceeds the 2 MiB UTF-8 byte limit.');
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
  // Authored discovery and lifecycle sentences are display copy. Request fields and enum values are excluded.
  for (const file of [
    'src/campaign-recipes.ts',
    'src/snapchat-traffic-recipe.ts',
    'src/capability-eligibility.ts',
    'src/capability-graph.ts',
    'src/conditional-programs.ts',
    'src/recipe-eligibility.ts',
  ]) {
    const discovery = parsers['babel-ts'].parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const addAuthored = value => {
      if (value?.type === 'StringLiteral' && /\s/.test(value.value)) required.add(value.value);
      if (value?.type === 'ConditionalExpression') {
        addAuthored(value.consequent);
        addAuthored(value.alternate);
      }
    };
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (
        node.type === 'ObjectProperty' &&
        [
          'name',
          'description',
          'meaning',
          'effects',
          ...(file.endsWith('conditional-programs.ts')
            ? ['effect_details', 'access', 'limitations', 'resolution', 'text']
            : []),
        ].includes(node.key?.name)
      )
        addAuthored(node.value);
      for (const [key, value] of Object.entries(node))
        if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
          for (const child of Array.isArray(value) ? value : [value]) visit(child);
    };
    visit(discovery);
  }
  // Only authored display labels are translated. Formula expressions, aggregation and native source fields remain exact.
  const reportMetrics = parsers['babel-ts'].parse(fs.readFileSync(path.join(root, 'src/report-metrics.ts'), 'utf8'));
  for (const statement of reportMetrics.program.body) {
    const declaration = statement.declaration?.declarations?.find(value => value.id?.name === 'metricDefinitions');
    for (const metric of declaration?.init?.properties ?? [])
      for (const property of metric.value?.properties ?? [])
        if (property.key?.name === 'label' && property.value?.type === 'StringLiteral')
          required.add(property.value.value);
  }
  // The provider hierarchy labels are AMCP display copy; preset IDs and native types remain exact.
  const levels = parsers['babel-ts'].parse(fs.readFileSync(path.join(root, 'src/overview-granularity.ts'), 'utf8'));
  const visitLevels = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ObjectProperty' && node.key?.name === 'label' && node.value?.type === 'StringLiteral')
      required.add(node.value.value);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
        for (const child of Array.isArray(value) ? value : [value]) visitLevels(child);
  };
  visitLevels(levels);
  const index = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const explanations = new Set();
  for (const file of [
    'src/report-metrics.ts',
    'src/recommendation-context.ts',
    'src/decision-reporting.ts',
    'src/report-scenarios.ts',
    'src/report-allocation.ts',
    'src/allocation-calibration.ts',
    'src/report-packs.ts',
    'src/allocation-plan.ts',
    'src/google-allocation-budgets.ts',
    'src/linkedin-allocation-budgets.ts',
    'src/provider-decimal.ts',
  ])
    for (const message of inspectReportExplanations(fs.readFileSync(path.join(root, file), 'utf8'), file)) {
      explanations.add(message);
      required.add(message);
    }
  const quality = parsers.babel.parse(fs.readFileSync(path.join(directory, 'report-quality.js'), 'utf8'));
  const declaration = quality.program.body
    .flatMap(node => node.declarations ?? [])
    .find(node => node.id?.name === 'reportExplanationMessages');
  const displayed = new Set((declaration?.init?.arguments?.[0]?.elements ?? []).map(node => node.value));
  for (const message of explanations)
    if (!displayed.has(message)) problems.push('Missing authored report explanation: ' + message);
  for (const message of displayed)
    if (!explanations.has(message)) problems.push('Unrecognized report explanation: ' + message);
  const accountExplanations = new Set();
  const contractExplanations = inspectContractExplanations(
    fs.readFileSync(path.join(root, 'src/action-contracts.ts'), 'utf8'),
  );
  const capabilityCopy = parsers.babel.parse(fs.readFileSync(path.join(directory, 'capability-center.js'), 'utf8'));
  const contractDeclaration = capabilityCopy.program.body
    .flatMap(node => node.declarations ?? [])
    .find(node => node.id?.name === 'capabilityContractMessages');
  const contractDisplayed = new Set(
    (contractDeclaration?.init?.arguments?.[0]?.elements ?? []).map(node => node.value),
  );
  for (const message of contractExplanations) {
    required.add(message);
    if (!contractDisplayed.has(message)) problems.push('Missing authored contract explanation: ' + message);
  }
  for (const message of contractDisplayed)
    if (!contractExplanations.has(message)) problems.push('Unrecognized contract explanation: ' + message);
  for (const file of [
    'src/google-portfolio.ts',
    'src/meta-portfolio.ts',
    'src/linkedin-portfolio.ts',
    'src/snapchat-portfolio.ts',
    'src/tiktok-portfolio.ts',
    'src/x-portfolio.ts',
    'src/workspace.ts',
    'src/catalog-ingestion.ts',
    'src/woocommerce-source.ts',
    'src/woocommerce-inventory.ts',
    'src/x-catalog-removal.ts',
    'src/x-catalog-comparison.ts',
    'src/x-catalog-selection-inventory.ts',
    'src/gtm-diagnostics.ts',
    'src/gtm-consent-plans.ts',
    'src/measurement-google-goals.ts',
    'src/ga4-admin-config.ts',
    'src/measurement-ledger.ts',
  ])
    for (const message of inspectAccountExplanations(fs.readFileSync(path.join(root, file), 'utf8'), file)) {
      accountExplanations.add(message);
      required.add(message);
    }
  const accounts = parsers.babel.parse(fs.readFileSync(path.join(directory, 'account-workflows.js'), 'utf8'));
  const accountDeclaration = accounts.program.body
    .flatMap(node => node.declarations ?? [])
    .find(node => node.id?.name === 'accountExplanationMessages');
  const accountDisplayed = new Set((accountDeclaration?.init?.arguments?.[0]?.elements ?? []).map(node => node.value));
  for (const message of accountExplanations)
    if (!accountDisplayed.has(message)) problems.push('Missing authored account explanation: ' + message);
  for (const message of accountDisplayed)
    if (!accountExplanations.has(message)) problems.push('Unrecognized account explanation: ' + message);
  const creativeExplanations = new Set(
    [
      'src/meta-asset-usage.ts',
      'src/google-image-usage.ts',
      'src/snapchat-asset-usage.ts',
      'src/google-pmax-image-links.ts',
      'src/google-pmax-brand-image-links.ts',
    ].flatMap(file => [...inspectAccountExplanations(fs.readFileSync(path.join(root, file), 'utf8'), file)]),
  );
  const creative = parsers.babel.parse(fs.readFileSync(path.join(directory, 'creative-library.js'), 'utf8'));
  const creativeDeclaration = creative.program.body
    .flatMap(node => node.declarations ?? [])
    .find(node => node.id?.name === 'creativeNativeReferenceMessages');
  const creativeDisplayed = new Set(
    (creativeDeclaration?.init?.arguments?.[0]?.elements ?? []).map(node => node.value),
  );
  for (const message of creativeExplanations) {
    required.add(message);
    if (!creativeDisplayed.has(message)) problems.push('Missing authored creative explanation: ' + message);
  }
  for (const message of creativeDisplayed)
    if (!creativeExplanations.has(message)) problems.push('Unrecognized creative explanation: ' + message);
  for (const message of inspectAccountExplanations(
    fs.readFileSync(path.join(root, 'src/meta-catalog-products.ts'), 'utf8'),
    'src/meta-catalog-products.ts',
  ))
    required.add(message);
  for (const file of [
    'src/google-reporting.ts',
    'src/decision-reporting.ts',
    'src/meta-evidence.ts',
    'src/linkedin-evidence.ts',
    'src/tiktok-reporting.ts',
    'src/snapchat-evidence.ts',
  ])
    for (const message of inspectReportingFailures(fs.readFileSync(path.join(root, file), 'utf8'), file))
      required.add(message);
  for (const message of inspectSourceNextActions(fs.readFileSync(path.join(root, 'src/report-errors.ts'), 'utf8')))
    required.add(message);
  for (const file of [
    'src/portfolio.ts',
    'src/google-portfolio.ts',
    'src/meta-portfolio.ts',
    'src/linkedin-portfolio.ts',
    'src/snapchat-portfolio.ts',
    'src/tiktok-portfolio.ts',
    'src/x-portfolio.ts',
  ])
    for (const message of inspectPortfolioFailures(fs.readFileSync(path.join(root, file), 'utf8'), file))
      required.add(message);
  for (const file of [
    'src/measurement-events.ts',
    'src/measurement-event-identity.ts',
    'src/gtm-consent-evidence.ts',
    'src/linkedin-conversion-evidence.ts',
    'src/measurement-ledger.ts',
  ])
    for (const message of inspectMeasurementFailures(fs.readFileSync(path.join(root, file), 'utf8'), file))
      required.add(message);
  for (const message of inspectSharedRecoveryHints(
    fs.readFileSync(path.join(root, 'src/errors.ts'), 'utf8'),
    'src/errors.ts',
  ))
    required.add(message);
  for (const message of inspectMeasurementRemedies(
    fs.readFileSync(path.join(root, 'src/errors.ts'), 'utf8'),
    'src/errors.ts',
  ))
    required.add(message);
  const publicMarkup = fs
    .readdirSync(directory)
    .filter(file => file.endsWith('.html'))
    .map(file => fs.readFileSync(path.join(directory, file), 'utf8'))
    .join('\n');
  for (const match of publicMarkup.matchAll(/data-ui-(?:text|label|placeholder|title)="([^"]+)"/g))
    required.add(
      match[1]
        .replaceAll('&quot;', '"')
        .replaceAll('&#x27;', "'")
        .replaceAll('&#39;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&'),
    );
  for (const file of [
    'server/account-routes.ts',
    'server/account-security.ts',
    'server/asset-discovery.ts',
    'server/google-account-discovery.ts',
    'server/google-reauthorization.ts',
    'server/http-app.ts',
    'server/media-source-routes.ts',
    'server/password-hashes.ts',
    'server/platform-oauth.ts',
    'server/social-signin.ts',
    'server/user-accounts.ts',
    'server/web-store.ts',
    'server/website.ts',
  ])
    for (const message of inspectWebsiteFailures(fs.readFileSync(path.join(root, file), 'utf8'), file))
      required.add(message);
  for (const file of [
    'src/catalog.ts',
    'src/service.ts',
    'src/store.ts',
    'src/transport.ts',
    'src/delegated-native.ts',
    'src/workflows.ts',
  ])
    for (const message of inspectCoreContractFailures(fs.readFileSync(path.join(root, file), 'utf8'), file))
      required.add(message);
  for (const file of backendContractSourceFiles(root)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const message of inspectBackendContractFailures(source, file)) required.add(message);
    for (const message of inspectBackendWrapperFailures(source, file)) required.add(message);
  }
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
