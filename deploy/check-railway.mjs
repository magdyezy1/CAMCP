import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Railway configuration checks (OPS-05). A successful Docker build alone does not check Railway's builder
// restrictions, and `railway.json` (Config as Code, supported for existing services until 2026-12-01) is the only
// repository record of the deploy gate, so the dashboard record in docs/DEPLOY-RAILWAY.md must say the same.

/** The deploy gate the repository records; the owner mirrors it in the Railway dashboard (D1). */
export const deploySettings = Object.freeze({
  healthcheckPath: '/healthz',
  healthcheckTimeout: 120,
  restartPolicyType: 'ON_FAILURE',
  restartPolicyMaxRetries: 5,
  numReplicas: 1,
});
/** Paths whose change must deploy, and documentation whose change must not (a docs-only push causes downtime). */
export const mustDeploy = [
  'src/store.ts',
  'server/http.ts',
  'web/app.js',
  'generated/cloudflare-ranges.json',
  'tools/build-release-identity.mjs',
  'tests/store.test.ts',
  'codegen/generate.mjs',
  'deploy/entrypoint.sh',
  'Skills/amcp-campaign-builder/SKILL.md',
  '.mirror/VENDOR/meta/graph.json',
  '.mirror/REPORTS/implementation-status.json',
  'Dockerfile',
  '.dockerignore',
  'railway.json',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'docs/REPORTING-OVERVIEW.md',
];
export const mustNotDeploy = [
  'docs/OPERATIONS.md',
  'docs/review/DELIVERY-2026-10-04-SCHEDULER-WORKERS.md',
  // DOC-03: the records, the archive and the owner guide in both languages are documentation too.
  'docs/records/DELIVERY-2026-10-04-SCHEDULER-WORKERS.md',
  'docs/archive/REVIEW-2026-10-01.md',
  'docs/owner/ar/README.md',
  'docs/a/b.md',
];

/** One gitignore-style watch pattern as a regular expression over a repository-relative path. */
function patternRegex(pattern) {
  const anchored = pattern.startsWith('/') || pattern.replace(/\/$/, '').includes('/');
  const body = pattern.replace(/^\//, '').replace(/\/$/, '');
  let source = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*' && body[i + 1] === '*') {
      source += body[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += body[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
  }
  // A pattern that names a directory also covers everything below it.
  return new RegExp('^' + (anchored ? '' : '(?:.*/)?') + source + '(?:/.*)?$');
}
/**
 * Whether a change to `file` starts a deploy under Railway's watch patterns: each pattern is checked in order, a
 * match selects the file and a `!` match deselects it, so the last matching pattern decides (no patterns: always).
 */
export function watchTriggers(patterns, file) {
  if (!patterns?.length) return true;
  let selected = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    if (patternRegex(negated ? raw.slice(1) : raw).test(file)) selected = !negated;
  }
  return selected;
}
export function checkDockerfile(dockerfile) {
  const problems = [];
  if (/^\s*VOLUME\s/im.test(dockerfile))
    problems.push('Railway rejects Dockerfile VOLUME instructions. Attach /data as a Railway service volume.');
  return problems;
}
/** Problems with railway.json: the builder, the deploy gate, and watch patterns that could skip shipped files. */
export function checkRailwayConfig(config, dockerfile = '') {
  const problems = [];
  if (config?.build?.builder !== 'DOCKERFILE' || config?.build?.dockerfilePath !== 'Dockerfile')
    problems.push('railway.json must build the repository Dockerfile.');
  for (const [key, value] of Object.entries(deploySettings))
    if (config?.deploy?.[key] !== value) problems.push(`railway.json deploy.${key} must be ${JSON.stringify(value)}.`);
  const patterns = config?.build?.watchPatterns;
  if (!Array.isArray(patterns) || patterns.some(p => typeof p !== 'string' || !p.trim()))
    problems.push('railway.json build.watchPatterns must be a list of patterns.');
  else {
    // Everything the runtime image copies from the build context must deploy when it changes.
    const copied = [...dockerfile.matchAll(/^COPY\s+(?!--from)(.+)$/gm)].flatMap(m =>
      m[1].trim().split(/\s+/).slice(0, -1),
    );
    const shipped = [...dockerfile.matchAll(/^COPY --from=build \/app\/(\S+) /gm)].map(m => m[1]);
    for (const source of [...copied, ...shipped].filter(s => s !== '.')) {
      const file = /\.[a-z]+$/i.test(source) ? source : source.replace(/\/$/, '') + '/any.file';
      if (!watchTriggers(patterns, file)) problems.push('A change to ' + source + ' would not deploy.');
    }
    for (const file of mustDeploy)
      if (!watchTriggers(patterns, file)) problems.push('A change to ' + file + ' would not deploy.');
    for (const file of mustNotDeploy)
      if (watchTriggers(patterns, file)) problems.push('A documentation-only change to ' + file + ' would deploy.');
  }
  return problems;
}
/**
 * The "Railway service settings" table of docs/DEPLOY-RAILWAY.md: setting -> the repository value (second column,
 * code spans only). Rows whose repository value is "dashboard only" are owner records without a repository copy.
 */
export function settingsTable(markdown) {
  const start = markdown.indexOf('## Railway service settings');
  if (start < 0) return null;
  const rows = new Map();
  for (const line of markdown.slice(start).split(/\r?\n/).slice(1)) {
    if (line.startsWith('## ')) break;
    const cells = line.split('|').map(cell => cell.trim());
    if (cells.length < 4 || !cells[1] || /^-+$/.test(cells[1]) || cells[1] === 'Setting') continue;
    rows.set(
      cells[1].replace(/`/g, ''),
      [...cells[2].matchAll(/`([^`]+)`/g)].map(m => m[1]),
    );
  }
  return rows;
}
const tableKeys = {
  Builder: config => [config?.build?.builder, config?.build?.dockerfilePath],
  'Healthcheck path': config => [config?.deploy?.healthcheckPath],
  'Healthcheck timeout (seconds)': config => [String(config?.deploy?.healthcheckTimeout)],
  'Restart policy': config => [config?.deploy?.restartPolicyType],
  'Restart policy retries': config => [String(config?.deploy?.restartPolicyMaxRetries)],
  Replicas: config => [String(config?.deploy?.numReplicas)],
  'Watch paths': config => config?.build?.watchPatterns ?? [],
};
/** Problems when the documented settings table and railway.json disagree. */
export function checkSettingsTable(markdown, config) {
  const rows = settingsTable(markdown);
  if (!rows) return ['docs/DEPLOY-RAILWAY.md has no "Railway service settings" table.'];
  const problems = [];
  for (const [name, expected] of Object.entries(tableKeys)) {
    const documented = rows.get(name);
    if (!documented) problems.push('The settings table has no "' + name + '" row.');
    else if (JSON.stringify(documented) !== JSON.stringify(expected(config)))
      problems.push(`The settings table's "${name}" (${documented.join(', ')}) differs from railway.json.`);
  }
  return problems;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8'),
    config = JSON.parse(fs.readFileSync('railway.json', 'utf8')),
    problems = [
      ...checkDockerfile(dockerfile),
      ...checkRailwayConfig(config, dockerfile),
      ...checkSettingsTable(fs.readFileSync('docs/DEPLOY-RAILWAY.md', 'utf8'), config),
    ];
  if (problems.length) throw Error(problems.join('\n'));
  console.log('Railway Dockerfile and configuration checks passed.');
}
