// The TypeScript form of tests/helpers/oracle-capture.mjs: instrumentation for tools/oracle-burndown.mjs (QA-02).
// Committed tests never import this module.
import fs from 'node:fs';

const write = (entry: object) =>
  process.env.ORACLE_CAPTURE_LOG && fs.appendFileSync(process.env.ORACLE_CAPTURE_LOG, JSON.stringify(entry) + '\n');
export function __oracleRefusal<T>(site: string, value: T): T {
  const v = value as {error?: {code?: string}; success?: boolean} | undefined;
  write({site, kind: 'refusal', code: v?.error?.code ?? null, success: v?.success ?? null});
  return value;
}
export function __oracleThrown(site: string) {
  return (error: unknown) => {
    const e = error as {code?: unknown; name?: string; message?: string} | undefined;
    write({
      site,
      kind: 'thrown',
      code: typeof e?.code === 'string' ? e.code : null,
      name: e?.name ?? null,
      message: String(e?.message ?? error).slice(0, 200),
    });
    return true;
  };
}
