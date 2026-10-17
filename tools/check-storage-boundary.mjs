// Storage boundary ratchet (ARC-02): SQL against AMCP's tables belongs to the store layer (src/store.ts,
// src/schema-migrations.ts, server/web-store.ts, src/document-kinds.ts and the repository modules storeRepositories
// lists by name; a module named *-repository.ts that it does not list fails the check). Every other application module
// (src/, server/) is counted for:
//   sql           string or template literals holding SQL (a statement, or a fragment naming an AMCP table or using
//                 json_extract);
//   json_extract  json_extract( uses inside those literals;
//   db            direct uses of a store's database handle (`store.db`, `this.store.db`, `store.sql()`) in code;
//   kinds         registered document kinds that its SQL names in a kind predicate (kind='x', kind IN ('x',...)).
// tests/fixtures/storage-boundary-allowance.json records what each module may still have. The check fails when a
// module has more than its allowance (new raw SQL, a new json_extract, a new database handle use or a newly named kind,
// including any module that had none) and lists modules below it, whose allowance should be lowered with --update.
// Values may only fall: move SQL into a repository module (docs/ADDING-A-DOCUMENT-KIND.md) instead of raising one.
// Schema changes (CREATE, ALTER or DROP of a table, index, trigger or view) outside the store layer always fail.
//   node tools/check-storage-boundary.mjs [--update] [--json]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const allowanceFile = 'tests/fixtures/storage-boundary-allowance.json';
export const registryFile = 'src/document-kinds.ts';
/**
 * The repository modules of the store layer, listed by name: adding one is a reviewed change to this list, never a
 * matter of naming a file *-repository.ts (a module so named but not listed is counted like any other, and the check
 * fails on it until it is listed).
 */
export const storeRepositories = [
  'src/audit-repository.ts',
  'src/backup-repository.ts',
  'src/campaign-repository.ts',
  'src/connection-repository.ts',
  'src/document-repository.ts',
  'src/erasure-repository.ts',
  'src/job-repository.ts',
  'src/mcp-client-repository.ts',
  'src/mcp-rate-limit-repository.ts',
  'src/media-library-repository.ts',
  'src/monitor-repository.ts',
  'src/operations-feed-repository.ts',
  'src/owner-health-repository.ts',
  'src/provider-usage-repository.ts',
  'src/rekey-repository.ts',
  'src/report-repository.ts',
  'src/retained-media-repository.ts',
  'src/retention-repository.ts',
  'src/schedule-repository.ts',
  'src/service-lock-repository.ts',
  'src/workbook-repository.ts',
  'src/worker-health-repository.ts',
  'src/write-record-repository.ts',
  // The website's repositories for its own tables (sessions, sign-in limits, AI-client grants).
  'server/login-limit-repository.ts',
  'server/mcp-grant-repository.ts',
  'server/web-session-repository.ts',
];
/** The store layer: the only modules whose SQL and database handle uses are not counted. */
export const storeLayer = [
  /^src\/store\.ts$/,
  /^src\/schema-migrations\.ts$/,
  /^src\/document-kinds\.ts$/,
  /^server\/web-store\.ts$/,
  ...storeRepositories.map(file => new RegExp('^' + file.replace(/[.]/g, '\\.') + '$')),
];
/** A module named like a repository: it is store layer only when storeRepositories lists it. */
const repositoryName = /^(?:src|server)\/[a-z0-9-]+-repository\.ts$/;
export const scanRoots = ['src', 'server'];
const metrics = ['sql', 'json_extract', 'db'];
// SQLite-only statements. A bare SELECT, DELETE or CREATE is not enough: HTTP methods, provider operation names and
// Google Ads query language strings use the same words, so a statement counts once it names an AMCP table (below).
const sqliteStatement =
  /^\s*(?:PRAGMA\b|VACUUM\b|(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)(?:\s+(?:IMMEDIATE|DEFERRED|EXCLUSIVE|TRANSACTION|TO|SAVEPOINT|[a-z_]+))*\s*;?\s*$)/;
const sqliteJson =
  /\bjson_(?:extract|set|insert|replace|remove|each|tree|type|valid|array_length|group_array|group_object|patch|quote|object|array)\(/;
const regexKeywords = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
  'instanceof',
]);

/**
 * Splits TypeScript or JavaScript source into its string and template literals (each with its first line; a template's
 * interpolations become `?`, and literals inside them are listed too) and its code with literals and comments blanked.
 */
export function lex(text) {
  const literals = [],
    code = [];
  let i = 0,
    line = 1;
  const newlines = (from, to) => {
    for (let k = from; k < to; k++) if (text[k] === '\n') line++;
  };
  function quoted(quote) {
    const start = line;
    let value = '';
    for (i++; i < text.length && text[i] !== quote; i++) {
      if (text[i] === '\\') {
        value += text[i + 1] === '\n' ? '' : text[i + 1];
        if (text[i + 1] === '\n') line++;
        i++;
      } else {
        if (text[i] === '\n') line++;
        value += text[i];
      }
    }
    i++;
    literals.push({text: value, line: start});
  }
  function template() {
    const start = line;
    let value = '';
    for (i++; i < text.length && text[i] !== '`';) {
      if (text[i] === '\\') {
        value += text[i + 1];
        newlines(i, i + 2);
        i += 2;
      } else if (text[i] === '$' && text[i + 1] === '{') {
        value += '?';
        i += 2;
        scan(true);
      } else {
        if (text[i] === '\n') line++;
        value += text[i++];
      }
    }
    i++;
    literals.push({text: value, line: start});
  }
  function regex() {
    for (i++; i < text.length && text[i] !== '/' && text[i] !== '\n'; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '[')
        for (i++; i < text.length && text[i] !== ']' && text[i] !== '\n'; i++) if (text[i] === '\\') i++;
    }
    for (i++; i < text.length && /[a-z]/.test(text[i]); i++);
  }
  // Scans code until the end of the text, or (inside a template interpolation) past its closing brace.
  function scan(interpolation) {
    let depth = 0,
      last = '',
      word = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2),
          stop = end < 0 ? text.length : end + 2;
        for (let k = i; k < stop; k++) if (text[k] === '\n') code.push('\n');
        newlines(i, stop);
        i = stop;
        continue;
      }
      if (c === "'" || c === '"') {
        quoted(c);
        code.push('""');
        last = 'a';
        word = '';
        continue;
      }
      if (c === '`') {
        template();
        code.push('""');
        last = 'a';
        word = '';
        continue;
      }
      if (c === '/' && (!last || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || regexKeywords.has(word))) {
        regex();
        code.push('/r/');
        last = 'a';
        word = '';
        continue;
      }
      if (interpolation) {
        if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) {
            i++;
            return;
          }
          depth--;
        }
      }
      if (c === '\n') line++;
      if (/[\w$]/.test(c)) {
        word = /[\w$]/.test(last) ? word + c : c;
        last = c;
      } else if (!/\s/.test(c)) {
        last = c;
        word = '';
      }
      code.push(c);
      i++;
    }
  }
  scan(false);
  return {literals, code: code.join('')};
}

/**
 * Whether a literal is SQL against the AMCP database: it names an AMCP table (or the SQLite catalog) where SQL names a
 * table, uses a SQLite JSON function, or is a SQLite-only statement such as PRAGMA or BEGIN.
 */
export function isSql(literal, tables) {
  return tables.test(literal) || sqliteJson.test(literal) || sqliteStatement.test(literal);
}
/** Schema changes (tables, indexes, triggers, views): only the store layer's schema ledger runs them. */
const ddlStatement =
  /\b(?:CREATE|ALTER|DROP)\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|UNIQUE\s+INDEX|INDEX|TRIGGER|VIEW|VIRTUAL\s+TABLE)\b/i;
export const isDdl = literal => ddlStatement.test(literal);
const tablePattern = names =>
  new RegExp(
    '\\b(?:FROM|INTO|JOIN|UPDATE|TABLE(?: IF NOT EXISTS)?|ON|EXISTS)\\s*\\(?\\s*(' +
      [...names, 'sqlite_master', 'sqlite_schema', 'pragma_table_info', 'pragma_index_list'].join('|') +
      ')\\b',
  );
/** The kinds a SQL literal names in a kind predicate: kind='x', kind<>'x' and kind IN ('x','y'). */
export function kindPredicates(literal) {
  const out = new Set();
  for (const m of literal.matchAll(/\bkind\s*(?:=|<>|!=)\s*'([a-z0-9_:.-]+)'/g)) out.add(m[1]);
  for (const m of literal.matchAll(/\bkind\s+(?:NOT\s+)?IN\s*\(\s*((?:'[a-z0-9_:.-]+'\s*,?\s*)+)\)/g))
    for (const k of m[1].matchAll(/'([a-z0-9_:.-]+)'/g)) out.add(k[1]);
  return out;
}

/** Tables other than `documents` that have a `kind` column: their kinds are not document kinds. */
const otherKindTables =
  /\b(?:FROM|INTO|JOIN|UPDATE)\s+(?:jobs|amcp_mcp_grants|amcp_account_challenges|amcp_email_outbox)\b/;
const documentsTable = /\b(?:FROM|INTO|JOIN|UPDATE)\s+documents\b/;
// The document API: the argument that names the kind (putDocument, document, documents and deleteDocument take the
// workspace first; the repositories take the kind first).
const documentCalls = /\.\s*(putDocument|deleteDocument|documents|document|repo|serviceRepo)\s*\(/g;
const kindArgument = {putDocument: 1, deleteDocument: 1, documents: 1, document: 1, repo: 0, serviceRepo: 0};
/** Splits the top-level arguments of the call whose opening parenthesis is at `open` (strings and nesting aware). */
function callArguments(text, open) {
  const args = [];
  let depth = 0,
    start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}
/**
 * The document kinds a module names: literal (or same-module constant) kind arguments of the document API, and kind
 * predicates of its SQL on `documents` (statements that also read another table with kinds count only `x.kind`
 * predicates qualified by an alias).
 */
export function namedKinds(text) {
  const out = new Set(),
    constants = new Map();
  for (const m of text.matchAll(/(?:\bconst\s+|,\s*)([A-Za-z_$][\w$]*)\s*(?::\s*[^=,;()]+)?=\s*'([a-z][a-z0-9_]*)'/g))
    constants.set(m[1], m[2]);
  for (const m of text.matchAll(documentCalls)) {
    const args = callArguments(text, m.index + m[0].length - 1),
      arg = args[kindArgument[m[1]]];
    if (!arg) continue;
    const literalKind = /^'([a-z][a-z0-9_]*)'$/.exec(arg);
    if (literalKind) out.add(literalKind[1]);
    else if (constants.has(arg)) out.add(constants.get(arg));
  }
  for (const literal of lex(text).literals) {
    if (!documentsTable.test(literal.text)) continue;
    if (!otherKindTables.test(literal.text)) {
      for (const kind of kindPredicates(literal.text)) out.add(kind);
      continue;
    }
    // Another table with kinds is read too: only predicates qualified by an alias of `documents` name document kinds.
    const aliases = [...literal.text.matchAll(/\b(?:FROM|JOIN)\s+documents\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/g)]
      .map(m => m[1])
      .filter(a => !/^(?:WHERE|ON|LEFT|INNER|JOIN|GROUP|ORDER|LIMIT|INDEXED|AS|USING|CROSS|SET)$/i.test(a));
    for (const alias of aliases)
      for (const kind of kindPredicates(
        literal.text
          .replace(new RegExp('\\b' + alias + '\\.kind\\b', 'g'), '§')
          .replace(/\bkind\b/g, '')
          .replace(/§/g, 'kind'),
      ))
        out.add(kind);
  }
  return out;
}

/** Repository-relative source files of the application (src/ and server/), sorted; tools/ also has modules. */
export function sourceFiles(base = root, directories = scanRoots) {
  const out = [];
  for (const directory of directories)
    for (const name of fs.readdirSync(path.join(base, directory)))
      if ((/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) || (directory === 'tools' && /\.mjs$/.test(name)))
        out.push(directory + '/' + name);
  return out.sort();
}
/** The tables AMCP creates (any CREATE TABLE in the application). */
export function amcpTables(files, read) {
  const names = new Set();
  for (const file of files)
    for (const m of read(file).matchAll(/CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/g))
      names.add(m[1]);
  return [...names].sort();
}
/** The kinds the registry declares (src/document-kinds.ts), parsed from its source so no build is needed. */
export function registeredKinds(text) {
  const body = text.slice(text.indexOf('documentKindSpecs'));
  return new Set([...body.matchAll(/^ {2}([a-z][a-z0-9_]*): \{/gm)].map(m => m[1]));
}
export const inStoreLayer = file => storeLayer.some(pattern => pattern.test(file));

/** One module's counts: SQL literals, json_extract uses, database handle uses and kinds named in SQL. */
export function scanModule(text, {tables, kinds}) {
  const {literals, code} = lex(text);
  const out = {sql: 0, json_extract: 0, db: 0, kinds: new Set(), lines: [], ddl: []};
  for (const literal of literals) {
    if (isDdl(literal.text)) out.ddl.push(literal.line);
    if (!isSql(literal.text, tables)) continue;
    out.sql++;
    out.lines.push(literal.line);
    out.json_extract += literal.text.split('json_extract(').length - 1;
    for (const kind of kindPredicates(literal.text)) if (!kinds || kinds.has(kind)) out.kinds.add(kind);
  }
  out.db = [...code.matchAll(/\.\s*db(?![\w$])/g)].length + [...code.matchAll(/\.\s*sql\s*\(/g)].length;
  return out;
}

/** Counts every application module outside the store layer, and the totals the ticket names. */
export function scanTree(base = root) {
  const read = file => fs.readFileSync(path.join(base, file), 'utf8');
  const files = sourceFiles(base),
    tables = tablePattern(amcpTables(files, read)),
    registry = fs.existsSync(path.join(base, registryFile)) ? registeredKinds(read(registryFile)) : undefined;
  const modules = {},
    totals = {modules_with_sql: 0, modules_with_db: 0, sql: 0, json_extract: 0, db: 0, kinds: new Set()},
    store = {sql: 0, json_extract: 0},
    unregistered = {},
    // Schema changes outside the store layer, by module and line: none are allowed (ARC-02, one ordered ledger).
    ddl = {},
    // Modules named like a repository that storeRepositories does not list: the check fails until one is reviewed in.
    unlisted_repositories = files.filter(file => repositoryName.test(file) && !inStoreLayer(file));
  // Every kind the application and its tools name must be declared (tests may use their own kinds).
  if (registry)
    for (const file of sourceFiles(base, [...scanRoots, 'tools'])) {
      const missing = [...namedKinds(read(file))].filter(kind => !registry.has(kind));
      if (missing.length) unregistered[file] = missing.sort();
    }
  for (const file of files) {
    const found = scanModule(read(file), {tables, kinds: registry});
    if (inStoreLayer(file)) {
      store.sql += found.sql;
      store.json_extract += found.json_extract;
      continue;
    }
    if (found.ddl.length) ddl[file] = found.ddl;
    if (!found.sql && !found.db && !found.json_extract) continue;
    modules[file] = {
      sql: found.sql,
      json_extract: found.json_extract,
      db: found.db,
      kinds: [...found.kinds].sort(),
      lines: found.lines,
    };
    if (found.sql) totals.modules_with_sql++;
    if (found.db) totals.modules_with_db++;
    totals.sql += found.sql;
    totals.json_extract += found.json_extract;
    totals.db += found.db;
    for (const kind of found.kinds) totals.kinds.add(kind);
  }
  return {
    modules,
    totals: {...totals, kinds_via_raw_sql: totals.kinds.size, kinds: [...totals.kinds].sort()},
    store_layer: {...store, json_extract_all: store.json_extract + totals.json_extract},
    registered_kinds: registry ? registry.size : null,
    unregistered,
    ddl,
    unlisted_repositories,
  };
}

const totalMetrics = ['modules_with_sql', 'modules_with_db', 'sql', 'json_extract', 'db', 'kinds_via_raw_sql'];
export const summaryOf = totals => Object.fromEntries(totalMetrics.map(m => [m, totals[m]]));
/**
 * Modules over their allowance (any metric, or a kind not allowed, including a module that has none), modules below
 * it, and totals over or below the recorded ones.
 */
export function compareAllowance(found, allowance, totals, recorded) {
  const over = [],
    under = [];
  for (const [file, counts] of Object.entries(found)) {
    const allowed = allowance[file] ?? {sql: 0, json_extract: 0, db: 0, kinds: []};
    for (const metric of metrics)
      if (counts[metric] > (allowed[metric] ?? 0))
        over.push({file, metric, found: counts[metric], allowed: allowed[metric] ?? 0, lines: counts.lines});
    const extra = counts.kinds.filter(kind => !(allowed.kinds ?? []).includes(kind));
    if (extra.length) over.push({file, metric: 'kinds', found: extra, allowed: allowed.kinds ?? []});
  }
  for (const [file, allowed] of Object.entries(allowance)) {
    for (const metric of metrics)
      if ((found[file]?.[metric] ?? 0) < (allowed[metric] ?? 0))
        under.push({file, metric, found: found[file]?.[metric] ?? 0, allowed: allowed[metric]});
    const gone = (allowed.kinds ?? []).filter(kind => !(found[file]?.kinds ?? []).includes(kind));
    if (gone.length) under.push({file, metric: 'kinds', found: gone, allowed: allowed.kinds});
  }
  if (totals && recorded)
    for (const metric of totalMetrics)
      if (totals[metric] > (recorded[metric] ?? 0))
        over.push({file: 'total', metric, found: totals[metric], allowed: recorded[metric] ?? 0});
      else if (totals[metric] < (recorded[metric] ?? 0))
        under.push({file: 'total', metric, found: totals[metric], allowed: recorded[metric]});
  return {over, under};
}
/**
 * The allowance after `--update`: each value lowered to what the module holds now, kinds no longer named dropped and
 * modules with nothing left removed. A value never rises and a module without an allowance gets none, unless
 * `acceptIncrease` (`--accept-increase`, for an integration that deliberately records new raw SQL) is set.
 */
export function updatedAllowance(modules, previous, acceptIncrease = false) {
  const out = {};
  for (const [file, c] of Object.entries(modules)) {
    const before = previous[file];
    if (!before && !acceptIncrease) continue;
    const value = acceptIncrease
      ? {sql: c.sql, json_extract: c.json_extract, db: c.db, kinds: c.kinds}
      : {
          sql: Math.min(c.sql, before.sql ?? 0),
          json_extract: Math.min(c.json_extract, before.json_extract ?? 0),
          db: Math.min(c.db, before.db ?? 0),
          kinds: c.kinds.filter(kind => (before.kinds ?? []).includes(kind)),
        };
    if (value.sql || value.json_extract || value.db || value.kinds.length) out[file] = value;
  }
  return out;
}
const allowanceDescription =
  'Raw SQL each application module outside the store layer may still hold (ARC-02, tools/check-storage-boundary.mjs): SQL literals, json_extract uses, database handle uses and the document kinds its SQL names. Values only fall: move SQL into a repository module (docs/ADDING-A-DOCUMENT-KIND.md) and lower them with --update; never raise one.';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = scanTree(root),
    file = path.join(root, allowanceFile),
    previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {allowance: {}, totals: {}};
  if (process.argv.includes('--update')) {
    const acceptIncrease = process.argv.includes('--accept-increase'),
      totals = summaryOf(result.totals);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          description: allowanceDescription,
          totals: acceptIncrease
            ? totals
            : Object.fromEntries(totalMetrics.map(m => [m, Math.min(totals[m], previous.totals?.[m] ?? totals[m])])),
          allowance: updatedAllowance(result.modules, previous.allowance ?? {}, acceptIncrease),
        },
        null,
        2,
      ) + '\n',
    );
  }
  const recorded = JSON.parse(fs.readFileSync(file, 'utf8')),
    comparison = compareAllowance(result.modules, recorded.allowance, summaryOf(result.totals), recorded.totals);
  const failed =
    comparison.over.length > 0 ||
    Object.keys(result.unregistered).length > 0 ||
    Object.keys(result.ddl).length > 0 ||
    result.unlisted_repositories.length > 0;
  if (process.argv.includes('--json')) console.log(JSON.stringify({...result, ...comparison}, null, 2));
  else {
    const t = result.totals;
    console.log(
      t.modules_with_sql +
        ' modules outside the store layer hold SQL (' +
        t.sql +
        ' literals, ' +
        t.json_extract +
        ' json_extract), ' +
        t.modules_with_db +
        ' use the database handle, ' +
        t.kinds_via_raw_sql +
        ' document kinds are named by their SQL; ' +
        (result.registered_kinds ?? 0) +
        ' kinds registered',
    );
    for (const [module, kinds] of Object.entries(result.unregistered))
      console.log(
        'UNDECLARED DOCUMENT KIND ' + module + ' ' + kinds.join(',') + ' (declare it in ' + registryFile + ')',
      );
    for (const module of result.unlisted_repositories)
      console.log(
        'UNLISTED REPOSITORY ' +
          module +
          ' (a repository module joins the store layer only by being added to storeRepositories in' +
          ' tools/check-storage-boundary.mjs, a reviewed change)',
      );
    for (const [module, lines] of Object.entries(result.ddl))
      console.log(
        'SCHEMA CHANGE OUTSIDE THE LEDGER ' +
          module +
          ' at lines ' +
          lines.join(', ') +
          ' (add a step to the schema ledger in src/store.ts or server/web-store.ts)',
      );
    for (const o of comparison.over)
      console.log(
        'NEW RAW STORAGE ACCESS ' +
          o.file +
          ' ' +
          o.metric +
          ' ' +
          (Array.isArray(o.found) ? o.found.join(',') : o.found + ' > ' + o.allowed) +
          (o.lines?.length ? ' (SQL at lines ' + o.lines.join(', ') + ')' : ''),
      );
    for (const u of comparison.under)
      console.log(
        'lower the allowance: ' +
          u.file +
          ' ' +
          u.metric +
          ' ' +
          (Array.isArray(u.found) ? 'no longer ' + u.found.join(',') : u.found + ' < ' + u.allowed),
      );
  }
  process.exitCode = failed ? 1 : 0;
}
