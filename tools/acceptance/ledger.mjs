// The provider acceptance ledger (ACC-05): src/acceptance-ledger.json, read by src/acceptance-ledger.ts.
// Usage (after npm run build):
//   node tools/acceptance/ledger.mjs --check                 validate the committed ledger
//   node tools/acceptance/ledger.mjs add <record.json>       append the ledger rows of a harness record
//   node tools/acceptance/ledger.mjs status                  counts per status for the current contracts
// A harness record is the JSON a tools/acceptance harness writes after an owner-authorized live run; its ledger_rows
// hold references only. This tool never contacts a provider and never edits a row: a new run adds a new row.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url)),
  ledgerFile = path.join(root, 'src/acceptance-ledger.json');
const load = async () => import(pathToFileURL(path.join(root, 'dist/src/acceptance-ledger.js')).href);

/** The ledger with `rows` appended, or the problems that refuse them; nothing is written here. */
export async function appendRows(ledger, rows) {
  const {validateAcceptanceLedger} = await load();
  if (!Array.isArray(rows) || !rows.length) return {problems: ['the record has no ledger_rows']};
  const next = {...ledger, rows: [...ledger.rows, ...rows]},
    problems = validateAcceptanceLedger(next);
  return problems.length ? {problems} : {ledger: next, problems: []};
}

async function main(argv) {
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const {validateAcceptanceLedger, contractAcceptance, acceptanceRows} = await load();
  if (argv[0] === '--check') {
    const problems = validateAcceptanceLedger(ledger);
    if (problems.length) throw Error('Acceptance ledger: ' + problems.join('; '));
    console.log(JSON.stringify({rows: ledger.rows.length, valid: true}));
    return;
  }
  if (argv[0] === 'add') {
    if (!argv[1]) throw Error('Name the harness record: node tools/acceptance/ledger.mjs add <record.json>');
    const record = JSON.parse(fs.readFileSync(argv[1], 'utf8')),
      {ledger: next, problems} = await appendRows(ledger, record.ledger_rows);
    if (problems.length) throw Error('Refused; nothing was written: ' + problems.join('; '));
    fs.writeFileSync(ledgerFile, JSON.stringify(next, null, 2) + '\n');
    console.log(JSON.stringify({added: record.ledger_rows.length, rows: next.rows.length}));
    return;
  }
  if (argv[0] === 'status') {
    const counts = {};
    for (const row of acceptanceRows) {
      const status = contractAcceptance(row).status;
      counts[status] = (counts[status] ?? 0) + 1;
    }
    console.log(JSON.stringify({rows: acceptanceRows.length, by_current_status: counts}));
    return;
  }
  throw Error('Usage: node tools/acceptance/ledger.mjs --check | add <record.json> | status');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(e => {
    console.error(e.message);
    process.exitCode = 1;
  });
