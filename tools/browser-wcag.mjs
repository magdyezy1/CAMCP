import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const wcagEngineVersion = '4.14.0';
export const wcagEngineSha256 = '20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878';
export const wcagTags = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']);
const refuse = message => {
  throw new Error(message);
};
/** Optional local test asset only. No download, dependency or network request is added to the application. */
export function readPinnedWcagEngine(file) {
  if (file === undefined) return null;
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== 'axe.min.js')
    refuse('WCAG QA requires an explicit absolute path to the pinned local axe.min.js test asset.');
  let bytes;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2097152) refuse('Invalid WCAG test asset.');
    bytes = fs.readFileSync(file);
  } catch {
    refuse('WCAG test asset is unavailable or outside its received-byte bound.');
  }
  if (bytes.length > 2097152 || createHash('sha256').update(bytes).digest('hex') !== wcagEngineSha256)
    refuse('WCAG test asset does not match the qualified axe-core 4.14.0 bytes.');
  return {
    source: bytes.toString('utf8'),
    sha256: wcagEngineSha256,
    version: wcagEngineVersion,
    byte_length: bytes.length,
  };
}
export function summarizeWcagResult(result) {
  if (
    result?.testEngine?.name !== 'axe-core' ||
    result.testEngine.version !== wcagEngineVersion ||
    ['violations', 'incomplete', 'passes', 'inapplicable'].some(field => !Array.isArray(result[field]))
  )
    refuse('WCAG inspection returned incomplete or unexpected engine evidence.');
  const rows = list =>
    list.map(row => {
      if (!row || typeof row.id !== 'string' || !row.id || !Array.isArray(row.nodes))
        refuse('WCAG inspection returned malformed rule evidence.');
      return {
        id: row.id,
        impact: row.impact ?? null,
        tags: row.tags ?? [],
        help: row.help ?? '',
        help_url: row.helpUrl ?? '',
        nodes: row.nodes.map(node => {
          if (!node || !Array.isArray(node.target) || node.target.some(value => typeof value !== 'string'))
            refuse('WCAG inspection returned malformed node evidence.');
          return {
            target: node.target,
            html: node.html ?? '',
            summary: node.failureSummary ?? '',
            checks: ['any', 'all', 'none'].flatMap(kind =>
              (node[kind] ?? []).map(check => ({
                kind,
                id: check.id,
                data: check.data ?? null,
                message: check.message ?? '',
              })),
            ),
          };
        }),
      };
    });
  const violations = rows(result.violations),
    incomplete = rows(result.incomplete);
  return {
    engine: wcagEngineVersion,
    selected_tags: [...wcagTags],
    automated_passed: violations.length === 0,
    manual_review_required: incomplete.length > 0,
    violations,
    incomplete,
    passed_rules: result.passes.length,
    inapplicable_rules: result.inapplicable.length,
  };
}
/** Run selected automated A/AA checks in an owned browser page. Incomplete rules remain explicit manual work. */
export async function inspectBrowserWcag(page, engine, timeoutMs = 10000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    refuse('WCAG inspection requires a bounded local deadline.');
  if (
    !engine ||
    engine.version !== wcagEngineVersion ||
    engine.sha256 !== wcagEngineSha256 ||
    typeof engine.source !== 'string' ||
    Buffer.byteLength(engine.source, 'utf8') > 2097152 ||
    createHash('sha256').update(engine.source).digest('hex') !== wcagEngineSha256
  )
    refuse('WCAG inspection requires qualified engine bytes and a bounded local deadline.');
  let timer;
  const inspect = async () => {
    await page.evaluate(engine.source);
    const result = await page.evaluate(
      async tags => {
        const r = await globalThis.axe.run(document, {runOnly: {type: 'tag', values: tags}});
        return {
          testEngine: r.testEngine,
          violations: r.violations,
          incomplete: r.incomplete,
          passes: r.passes.map(row => ({id: row.id})),
          inapplicable: r.inapplicable.map(row => ({id: row.id})),
        };
      },
      [...wcagTags],
    );
    return summarizeWcagResult(result);
  };
  try {
    return await Promise.race([
      inspect(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WCAG inspection exceeded its local deadline.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
