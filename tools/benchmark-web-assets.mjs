// Public source-byte measurement only: this is not a browser timing or deployed load test.
import fs from 'node:fs';
import {createContext, Script} from 'node:vm';
import {gzipSync, brotliCompressSync, constants} from 'node:zlib';
import {createHash} from 'node:crypto';

const index = fs.readFileSync('web/index.html', 'utf8'),
  initial = [...index.matchAll(/<script src="\/assets\/([^"]+)" defer><\/script>/g)].map(m => m[1]);
const context = createContext({});
new Script(fs.readFileSync('web/route-assets.js', 'utf8')).runInContext(context);
const authored = JSON.parse(new Script('JSON.stringify(pageAssetRoutes)').runInContext(context));
const files = new Map();
for (const file of [...initial, ...new Script('pageAssetOrder').runInContext(context)]) {
  if (files.has(file)) continue;
  const bytes = fs.readFileSync('web/' + file);
  files.set(file, {
    path: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    raw: bytes.length,
    gzip: gzipSync(bytes).length,
    brotli: brotliCompressSync(bytes, {params: {[constants.BROTLI_PARAM_QUALITY]: 11}}).length,
  });
}
const measure = list =>
  Object.fromEntries([
    ['scripts', list.length],
    ...['raw', 'gzip', 'brotli'].map(key => [key, list.reduce((total, file) => total + files.get(file)[key], 0)]),
  ]);
const routes = {};
for (const route of ['/', '/connections', '/login', ...Object.keys(authored)]) {
  const requested = [...initial, ...new Script(`pageAssetsFor(${JSON.stringify(route)})`).runInContext(context)];
  routes[route] = {...measure(requested), additional_scripts: requested.length - initial.length};
}
console.log(
  JSON.stringify(
    {
      meaning:
        'Sum of independently encoded JavaScript asset bytes; excludes HTML, CSS, fonts, locale JSON, headers, cache hits and browser timings.',
      encoding: {gzip: 'Node default', brotli_quality: 11},
      eager_equivalent: measure([...files.keys()]),
      initial: measure(initial),
      routes,
      files: [...files.values()],
    },
    null,
    2,
  ),
);
