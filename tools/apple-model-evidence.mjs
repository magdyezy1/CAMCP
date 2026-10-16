// Apple Ads Platform API v1 model and method facts (generated/apple-platform-v1-models.json) from Apple's public Node
// SDK at a pinned revision (ARC-03, like the pinned vendor documents of tools/fetch-vendor-specs.mjs):
//
//   node tools/apple-model-evidence.mjs <SDK model directory> <SDK API source> [output]   generate from a checkout
//   node tools/apple-model-evidence.mjs --check                 offline: the committed file has its recorded digest,
//                                                                names the pinned revision and is well formed
//   node tools/apple-model-evidence.mjs --check --sdk <dir>     also re-derive it from an SDK checkout of the pinned
//                                                                revision (<dir>/src/model, <dir>/src/api) and compare
//   node tools/apple-model-evidence.mjs --fetch --sdk <dir> --check
//                                                                first download the files the committed evidence names
//                                                                at the pinned revision from raw.githubusercontent.com
//
// --fetch is the only network step: an owner-run release task, never part of a build, a test or `npm run check`.
// AMCP_APPLE_SDK_DIR may stand in for --sdk.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const appleSdkRevision = 'f90ac18b616e0ba2bbf2d17d73f54deeb2dd7af1';
export const appleModelsFile = 'generated/apple-platform-v1-models.json';
/**
 * The SHA-256 of the committed models file, generated from the pinned revision. It changes only with a new revision:
 * regenerate from a checkout of it, then record the digest the check prints here together with appleSdkRevision.
 */
export const appleModelsDigest = 'sha256:47933c604b2a34950effbdab18b2ac709046b390a42153adb8d9171590edd65c';
const repository = 'https://github.com/apple/apple-ads-platform-api-node',
  rawOrigin = 'https://raw.githubusercontent.com',
  normalization = 'LF line endings and one final newline before SHA-256';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value.replace(/\r\n/g, '\n').trimEnd() + '\n';
const blob = file => `${repository}/blob/${appleSdkRevision}/${file}`;
/** Extract type facts from the pinned public SDK, not executable vendor code.
 * Fail on unfamiliar syntax rather than silently broadening a write schema. */
export function extractAppleModels(directory, apiFile) {
  const models = {},
    sources = {};
  for (const file of fs
    .readdirSync(directory)
    .filter(f => f.endsWith('.ts'))
    .sort()) {
    const source = canonical(fs.readFileSync(path.join(directory, file), 'utf8'));
    const declaration = /export (interface|enum) (\w+) \{([\s\S]*?)\n\}/.exec(source);
    if (!declaration) throw Error('No model declaration: ' + file);
    const [, kind, name, body] = declaration;
    if (kind === 'enum') {
      const values = [...body.matchAll(/^\s*\w+ = '([^']+)'[,]?\s*$/gm)].map(m => m[1]);
      if (!values.length) throw Error('Empty enum ' + name);
      models[name] = {enum: values};
    } else {
      const fields = {};
      for (const [, key, optional, type] of body.matchAll(/^\s*'([^']+)'(\?)?: ([^;\n]+);/gm)) {
        if (!/^(?:Array<\w+>|\w+)(?: \| null)?$/.test(type))
          throw Error('Unqualified type ' + name + '.' + key + ': ' + type);
        fields[key] = {type, required: optional !== '?'};
      }
      if (!Object.keys(fields).length) throw Error('Empty interface ' + name);
      models[name] = {fields};
    }
    sources[name] = {
      source: blob('src/model/' + file),
      canonical_sha256: hash(source),
    };
  }
  for (const [name, model] of Object.entries(models))
    for (const f of Object.values(model.fields ?? {})) {
      const type = f.type.replace(' | null', '').replace(/^Array<(.+)>$/, '$1');
      if (!['string', 'number', 'boolean', 'object'].includes(type) && !models[type])
        throw Error('Missing dependency ' + name + ': ' + type);
    }
  const api = canonical(fs.readFileSync(apiFile, 'utf8')),
    methods = {};
  for (const match of api.matchAll(
    /^        (\w+): async \(([^\n]+?)\): Promise<RequestArgs> => \{([\s\S]*?)^        \},/gm,
  )) {
    const [, name, args, body] = match,
      route = /const localVarPath = `([^`]+)`/.exec(body)?.[1],
      method = /method: '([A-Z]+)'/.exec(body)?.[1];
    if (!route || !method) throw Error('Incomplete method ' + name);
    methods[name] = {
      method,
      path: '/v1' + route,
      account_context: args.includes('xApContext:') ? 'required' : args.includes('xApContext?') ? 'optional' : 'none',
    };
  }
  if (!methods.adgroupsPost || !methods.sharedBudgetsPost) throw Error('SDK request methods not found');
  return {
    format_version: 1,
    revision: appleSdkRevision,
    normalization,
    api_source: blob('src/api/apple-ads-api.ts'),
    api_canonical_sha256: hash(api),
    sources,
    models,
    methods,
  };
}
export const serializeAppleModels = data => JSON.stringify(data, null, 2) + '\n';

/** The SDK files the committed evidence was derived from, as paths inside the SDK repository. */
export function appleSdkFiles(data) {
  const prefix = `${repository}/blob/${appleSdkRevision}/`;
  return [data.api_source, ...Object.values(data.sources ?? {}).map(s => s.source)].map(url => {
    if (typeof url !== 'string' || !url.startsWith(prefix)) throw Error('Not a pinned SDK source: ' + url);
    const file = url.slice(prefix.length);
    if (!/^src\/(?:model\/[a-z0-9-]+\.ts|api\/apple-ads-api\.ts)$/.test(file))
      throw Error('Unexpected SDK file ' + file);
    return file;
  });
}

/**
 * What is wrong with the committed text without an SDK checkout: its digest, the pinned revision in every source, the
 * shape of every model and method, and type references that resolve. An empty list passes.
 */
export function appleModelProblems(text) {
  const problems = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [appleModelsFile + ' is not JSON.'];
  }
  const digest = 'sha256:' + hash(text.replaceAll('\r\n', '\n'));
  if (digest !== appleModelsDigest)
    problems.push(
      appleModelsFile +
        ' does not have its recorded digest ' +
        appleModelsDigest +
        ' (now ' +
        digest +
        '): it was edited by hand or regenerated without recording the digest in tools/apple-model-evidence.mjs.',
    );
  if (serializeAppleModels(data) !== text.replaceAll('\r\n', '\n'))
    problems.push(appleModelsFile + ' is not in the generator output format.');
  if (data.format_version !== 1) problems.push('format_version must be 1.');
  if (data.revision !== appleSdkRevision) problems.push('revision must be the pinned ' + appleSdkRevision + '.');
  if (data.normalization !== normalization) problems.push('normalization changed.');
  if (data.api_source !== blob('src/api/apple-ads-api.ts')) problems.push('api_source is not the pinned API source.');
  if (!/^[a-f0-9]{64}$/.test(String(data.api_canonical_sha256)))
    problems.push('api_canonical_sha256 is not a SHA-256.');
  const models = data.models ?? {},
    sources = data.sources ?? {};
  if (JSON.stringify(Object.keys(models).sort()) !== JSON.stringify(Object.keys(sources).sort()))
    problems.push('Every model needs exactly one source, and every source one model.');
  try {
    appleSdkFiles(data);
  } catch (error) {
    problems.push(error.message);
  }
  for (const [name, source] of Object.entries(sources))
    if (!/^[a-f0-9]{64}$/.test(String(source?.canonical_sha256)))
      problems.push(name + ': canonical_sha256 is not a SHA-256.');
  for (const [name, model] of Object.entries(models)) {
    if (Array.isArray(model.enum)) {
      if (!model.enum.length || model.enum.some(v => typeof v !== 'string'))
        problems.push(name + ': empty or bad enum.');
      continue;
    }
    const fields = Object.entries(model.fields ?? {});
    if (!fields.length) problems.push(name + ': neither an enum nor an interface with fields.');
    for (const [key, field] of fields) {
      if (!/^(?:Array<\w+>|\w+)(?: \| null)?$/.test(String(field.type)) || typeof field.required !== 'boolean')
        problems.push(name + '.' + key + ': unqualified field.');
      const type = String(field.type)
        .replace(' | null', '')
        .replace(/^Array<(.+)>$/, '$1');
      if (!['string', 'number', 'boolean', 'object'].includes(type) && !models[type])
        problems.push(name + '.' + key + ': type ' + type + ' is not a model.');
    }
  }
  const methods = Object.entries(data.methods ?? {});
  if (!data.methods?.adgroupsPost || !data.methods?.sharedBudgetsPost) problems.push('SDK request methods missing.');
  for (const [name, m] of methods)
    if (
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m.method) ||
      !/^\/v1\//.test(String(m.path)) ||
      !['required', 'optional', 'none'].includes(m.account_context)
    )
      problems.push(name + ': unqualified method.');
  return problems;
}

/** Re-derives the evidence from an SDK checkout and names what differs from the committed text. */
export function appleRederivationProblems(sdk, text) {
  const committed = JSON.parse(text),
    derived = extractAppleModels(path.join(sdk, 'src/model'), path.join(sdk, 'src/api/apple-ads-api.ts')),
    problems = [];
  if (derived.api_canonical_sha256 !== committed.api_canonical_sha256)
    problems.push('src/api/apple-ads-api.ts is not the file of the pinned revision.');
  for (const name of new Set([...Object.keys(derived.sources), ...Object.keys(committed.sources ?? {})]))
    if (derived.sources[name]?.canonical_sha256 !== committed.sources?.[name]?.canonical_sha256)
      problems.push(name + ': the SDK source differs from the one of the pinned revision.');
  if (!problems.length && serializeAppleModels(derived) !== text.replaceAll('\r\n', '\n'))
    problems.push(appleModelsFile + ' is not what the pinned revision produces; regenerate it.');
  return problems;
}

/**
 * Downloads the files the committed evidence names at the pinned revision into `sdk` (owner-run; the only network
 * step). Each file must answer 200 from raw.githubusercontent.com without a redirect and stay under 1 MiB.
 */
export async function fetchPinnedAppleSdk(text, sdk, fetchImpl = fetch) {
  const files = appleSdkFiles(JSON.parse(text));
  for (const file of files) {
    const url = new URL(`/apple/apple-ads-platform-api-node/${appleSdkRevision}/${file}`, rawOrigin);
    if (url.origin !== rawOrigin) throw Error('Unexpected SDK origin ' + url.origin);
    const response = await fetchImpl(url.href, {redirect: 'error', signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw Error('SDK file ' + file + ' answered HTTP ' + response.status);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 1024 * 1024) throw Error('SDK file ' + file + ' exceeds 1 MiB');
    fs.mkdirSync(path.join(sdk, path.dirname(file)), {recursive: true});
    fs.writeFileSync(path.join(sdk, file), body);
  }
  return files.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    flags = new Set(args.filter(a => a.startsWith('--')));
  if (flags.has('--check') || flags.has('--fetch')) {
    const sdkIndex = args.indexOf('--sdk'),
      sdk = sdkIndex >= 0 ? args[sdkIndex + 1] : process.env.AMCP_APPLE_SDK_DIR || undefined;
    if ([...flags].some(f => !['--check', '--fetch', '--sdk'].includes(f)) || (sdkIndex >= 0 && !sdk))
      throw Error('Usage: node tools/apple-model-evidence.mjs [--fetch] --check [--sdk <SDK checkout>]');
    if (flags.has('--fetch') && !sdk) throw Error('--fetch needs --sdk <directory> to download into.');
    const text = fs.readFileSync(appleModelsFile, 'utf8');
    if (flags.has('--fetch')) console.log(JSON.stringify({fetched: await fetchPinnedAppleSdk(text, sdk), into: sdk}));
    const problems = appleModelProblems(text);
    if (sdk) problems.push(...appleRederivationProblems(sdk, text));
    for (const problem of problems) console.error(problem);
    const summary = {
      file: appleModelsFile,
      revision: appleSdkRevision,
      digest: 'sha256:' + hash(text.replaceAll('\r\n', '\n')),
      rederived: Boolean(sdk),
      problems: problems.length,
    };
    if (problems.length) {
      console.error(JSON.stringify(summary));
      process.exitCode = 1;
    } else console.log(JSON.stringify(summary));
  } else {
    const [directory, apiFile, output = appleModelsFile] = args;
    if (!directory || !apiFile)
      throw Error(
        'Usage: node tools/apple-model-evidence.mjs <public SDK model directory> <public SDK API source> [output]',
      );
    const data = extractAppleModels(directory, apiFile);
    fs.writeFileSync(output, serializeAppleModels(data));
    console.log(
      JSON.stringify({
        models: Object.keys(data.models).length,
        methods: Object.keys(data.methods).length,
        revision: data.revision,
        output,
        digest: 'sha256:' + hash(serializeAppleModels(data)),
      }),
    );
  }
}
