// Instrumentation for tools/oracle-burndown.mjs (QA-02). The tool rewrites a weak oracle to pass its value through
// these functions for one run, records what each site actually saw in ORACLE_CAPTURE_LOG, then restores the file and
// writes the typed oracle. Committed tests never import this module (tests/test-oracles.test.mjs checks that).
import fs from 'node:fs';

const write = entry =>
  process.env.ORACLE_CAPTURE_LOG && fs.appendFileSync(process.env.ORACLE_CAPTURE_LOG, JSON.stringify(entry) + '\n');
/** A code-less `success, false` site: records the refusal code and returns the value unchanged. */
export function __oracleRefusal(site, value) {
  write({site, kind: 'refusal', code: value?.error?.code ?? null, success: value?.success ?? null});
  return value;
}
/** A bare throws/rejects site: the matcher records the error and accepts it, as the bare form did. */
export function __oracleThrown(site) {
  return error => {
    write({
      site,
      kind: 'thrown',
      code: typeof error?.code === 'string' ? error.code : null,
      name: error?.name ?? null,
      message: String(error?.message ?? error).slice(0, 200),
    });
    return true;
  };
}
