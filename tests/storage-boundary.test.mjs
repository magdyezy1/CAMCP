// ARC-02 storage boundary ratchet (owner decision D26: an architecture ratchet that blocks only regressions): raw SQL,
// json_extract uses, database handle uses and the document kinds named by SQL outside the store layer may only fall,
// a module that had none may not gain any, and every document kind the application names is declared.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  allowanceFile,
  compareAllowance,
  inStoreLayer,
  isDdl,
  isSql,
  lex,
  scanModule,
  scanTree,
  storeRepositories,
  summaryOf,
  updatedAllowance,
} from '../tools/check-storage-boundary.mjs';
import {Store} from '../dist/src/store.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const tables = /\b(?:FROM|INTO|JOIN|UPDATE|TABLE(?: IF NOT EXISTS)?|ON)\s*\(?\s*(documents|jobs|tenants)\b/;

test('the lexer reads strings and templates, skips comments and regular expressions, and blanks literals in code', () => {
  const source = [
    '// a comment naming store.db and "SELECT 1 FROM documents"',
    "const a = 'it\\'s', b = \"two\";",
    'const t = `outer ${f(`inner ${"deep"}`)} end`;',
    'const r = /FROM documents/g, q = x / 2 / y;',
    'return /a\\/b[/]c/.test(s); /* block store.db */',
    "store.db.prepare('SELECT 1').get(); const notDb = store.dbName;",
  ].join('\n');
  const {literals, code} = lex(source);
  assert.deepEqual(
    literals.map(l => [l.text, l.line]),
    [
      ["it's", 2],
      ['two', 2],
      ['deep', 3],
      ['inner ?', 3],
      ['outer ? end', 3],
      ['SELECT 1', 6],
    ],
  );
  assert.equal([...code.matchAll(/\.db(?![\w$])/g)].length, 1);
  assert.ok(!code.includes('FROM documents'));
});

test('only SQL against the AMCP database counts: HTTP methods and provider query languages do not', () => {
  for (const text of ['DELETE', 'UPDATE', 'CREATE', 'SELECT campaign.id FROM campaign WHERE campaign.status = "x"'])
    assert.equal(isSql(text, tables), false, text);
  for (const text of [
    'SELECT data FROM documents WHERE tenant_id=?',
    " AND json_extract(data,'$.state')='x'",
    'PRAGMA busy_timeout=0',
    'BEGIN IMMEDIATE',
    'DELETE FROM jobs WHERE id=?',
  ])
    assert.equal(isSql(text, tables), true, text);
  const found = scanModule(
    "store.db.prepare(\"DELETE FROM documents WHERE tenant_id=? AND kind IN ('a_kind','b_kind') AND json_extract(data,'$.x')<?\");\nfetch(url, {method: 'DELETE'});",
    {tables, kinds: new Set(['a_kind'])},
  );
  assert.deepEqual(
    {...found, kinds: [...found.kinds]},
    {sql: 1, json_extract: 1, db: 1, kinds: ['a_kind'], lines: [1], ddl: []},
  );
});

test('the allowance refuses new raw storage access and only ever lowers', () => {
  const found = {
    'src/kept.ts': {sql: 2, json_extract: 1, db: 2, kinds: ['a_kind'], lines: [3, 9]},
    'src/new.ts': {sql: 1, json_extract: 0, db: 1, kinds: [], lines: [7]},
    'src/more.ts': {sql: 3, json_extract: 0, db: 0, kinds: ['b_kind', 'c_kind'], lines: [1, 2, 3]},
  };
  const allowance = {
    'src/kept.ts': {sql: 3, json_extract: 1, db: 2, kinds: ['a_kind', 'z_kind']},
    'src/more.ts': {sql: 2, json_extract: 0, db: 0, kinds: ['b_kind']},
    'src/gone.ts': {sql: 1, json_extract: 0, db: 1, kinds: []},
  };
  const {over, under} = compareAllowance(found, allowance, {sql: 6, db: 3}, {sql: 6, db: 4});
  assert.deepEqual(
    over.map(o => o.file + ' ' + o.metric),
    ['src/new.ts sql', 'src/new.ts db', 'src/more.ts sql', 'src/more.ts kinds'],
  );
  assert.deepEqual(over.find(o => o.metric === 'kinds').found, ['c_kind']);
  assert.deepEqual(
    under.map(u => u.file + ' ' + u.metric),
    ['src/kept.ts sql', 'src/kept.ts kinds', 'src/gone.ts sql', 'src/gone.ts db', 'total db'],
  );
  // --update lowers what fell and never raises a value or admits a module without an allowance.
  assert.deepEqual(updatedAllowance(found, allowance), {
    'src/kept.ts': {sql: 2, json_extract: 1, db: 2, kinds: ['a_kind']},
    'src/more.ts': {sql: 2, json_extract: 0, db: 0, kinds: ['b_kind']},
  });
  assert.deepEqual(Object.keys(updatedAllowance(found, allowance, true)), ['src/kept.ts', 'src/new.ts', 'src/more.ts']);
});

test('schema changes run only in the store layer’s ledger: the /mcp request buckets are created at start-up (regression: the limiter created its table on the first admitted request)', () => {
  for (const text of [
    'CREATE TABLE IF NOT EXISTS amcp_mcp_rate_limits(key TEXT PRIMARY KEY)',
    'create index if not exists x on documents(kind)',
    'DROP TRIGGER IF EXISTS audit_no_update',
    'ALTER TABLE jobs ADD COLUMN lease_boot TEXT',
    'CREATE UNIQUE INDEX u ON t(a)',
  ])
    assert.equal(isDdl(text), true, text);
  for (const text of ['Create a campaign', 'DELETE FROM documents WHERE id=?', 'TABLE', 'createIndex'])
    assert.equal(isDdl(text), false, text);
  assert.deepEqual(scanTree().ddl, {}, 'no module outside the store layer changes the schema');
  const store = new Store(':memory:');
  try {
    assert.ok(store.bootstrap.migrations_applied.includes('store-0016-mcp-rate-limits'));
    assert.ok(
      store.sql().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amcp_mcp_rate_limits'").get(),
      'the bucket table exists before any request',
    );
  } finally {
    store.close();
  }
});

test('the committed allowance holds for the tree: no new raw storage access and no undeclared kind', () => {
  const result = scanTree(),
    recorded = JSON.parse(fs.readFileSync(allowanceFile, 'utf8'));
  assert.deepEqual(result.unregistered, {});
  const comparison = compareAllowance(result.modules, recorded.allowance, summaryOf(result.totals), recorded.totals);
  assert.deepEqual(comparison.over, []);
  // The store layer is the store, the schema ledger, the registry, the repositories and the website store.
  for (const file of [
    'src/store.ts',
    'src/schema-migrations.ts',
    'src/document-kinds.ts',
    'src/document-repository.ts',
    'server/web-store.ts',
    'server/mcp-grant-repository.ts',
  ])
    assert.ok(inStoreLayer(file), file);
  for (const file of [
    'src/service.ts',
    'server/website.ts',
    'src/repository.ts',
    'server/repository.ts',
    'tools/x-repository.ts',
    // Regression: any src/*-repository.ts counted as store layer, so naming a module so added raw SQL unratcheted.
    'src/foo-repository.ts',
    'server/foo-repository.ts',
  ])
    assert.equal(inStoreLayer(file), false, file);
  // Every repository of the store layer is listed by name, and every module named like one is listed.
  assert.deepEqual(result.unlisted_repositories, []);
  for (const file of storeRepositories) {
    assert.ok(fs.existsSync(file), file);
    assert.ok(inStoreLayer(file), file);
  }
});

test('a module named like a repository but not listed is counted and fails the check', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-storage-boundary-'));
  try {
    for (const directory of ['src', 'server']) fs.mkdirSync(path.join(base, directory));
    fs.writeFileSync(
      path.join(base, 'src', 'store.ts'),
      "const schema = 'CREATE TABLE IF NOT EXISTS documents(tenant_id TEXT, kind TEXT, id TEXT, data TEXT)';\n",
    );
    fs.writeFileSync(
      path.join(base, 'src', 'shadow-repository.ts'),
      "export const all = store => store.db.prepare('SELECT data FROM documents').all();\n",
    );
    const result = scanTree(base);
    assert.deepEqual(result.unlisted_repositories, ['src/shadow-repository.ts']);
    assert.equal(result.modules['src/shadow-repository.ts']?.sql, 1, 'its SQL counts against the allowance');
    assert.deepEqual(
      compareAllowance(result.modules, {}).over.map(o => [o.file, o.metric]),
      [
        ['src/shadow-repository.ts', 'sql'],
        ['src/shadow-repository.ts', 'db'],
      ],
    );
  } finally {
    removeTestDirectory(base, 'amcp-storage-boundary-');
  }
});

test('the ARC-02 targets hold: at most 15 modules outside the store layer hold SQL and their SQL names at most 10 document kinds', () => {
  // Baselines when the ratchet was introduced: 88 modules and 58 kinds (review: 59 modules, 45 kinds). An integration
  // that records new raw SQL with --accept-increase still may not cross the ticket's targets.
  const {totals} = scanTree(),
    recorded = JSON.parse(fs.readFileSync(allowanceFile, 'utf8')).totals;
  for (const [metric, target] of [
    ['modules_with_sql', 15],
    ['kinds_via_raw_sql', 10],
  ]) {
    assert.ok(totals[metric] <= target, metric + ' ' + totals[metric] + ' > ' + target);
    assert.ok(recorded[metric] <= target, 'recorded ' + metric + ' ' + recorded[metric] + ' > ' + target);
  }
});
