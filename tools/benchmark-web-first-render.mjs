// WEB-07: time to the first content render per page and language on the synthetic fixture, under a throttled profile,
// with the bytes each page transferred. Opt-in, like the rendered browser checks (docs/LOCAL-BROWSER-QA.md):
//   npm run build && node tools/benchmark-web-first-render.mjs --output-dir .runtime/<fresh-directory>
//     [--runs 3] [--routes /,/about,/login,/dashboard] [--web <directory holding a web/ tree to serve instead>]
// It needs AMCP_QA_PLAYWRIGHT_MODULE and AMCP_QA_BROWSER_PATH (absolute paths). The website is the owned in-memory
// fixture (tests/fixtures/browser-workflow-sites.mjs, the empty workspace); every request to another origin is refused.
// "First render" is the first moment the page shows its own heading in the chosen language with no loading placeholder.
// Profile: 150 ms round trips, 1.6 Mbit/s down, 750 kbit/s up, a 4x slower CPU. A timing describes this machine and
// profile only; compare a change with a baseline measured in the same session (--web serves an exported tree).
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url))),
  argument = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : fallback;
  },
  output = path.resolve(root, argument('--output-dir', '')),
  runs = Number(argument('--runs', '3')),
  routes = argument('--routes', '/,/about,/login,/dashboard,/connections,/portfolio,/reporting-overview,/settings')
    .split(',')
    .filter(Boolean),
  web = argument('--web', null),
  runtime = path.resolve(root, '.runtime');
if (!output.startsWith(runtime + path.sep) || fs.existsSync(output))
  throw Error('The benchmark output must be a fresh child of this checkout’s ignored .runtime directory.');
if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw Error('--runs takes 1 to 20.');
if (routes.some(route => !/^\/[a-z0-9/-]*$/.test(route))) throw Error('--routes takes registered page paths.');
const playwright = process.env.AMCP_QA_PLAYWRIGHT_MODULE,
  executablePath = process.env.AMCP_QA_BROWSER_PATH;
if (!playwright || !path.isAbsolute(playwright) || !executablePath || !path.isAbsolute(executablePath))
  throw Error('Set AMCP_QA_PLAYWRIGHT_MODULE and AMCP_QA_BROWSER_PATH to an installed Playwright and browser.');

const {browserWorkflowSite} = await import(
  pathToFileURL(path.join(root, 'tests/fixtures/browser-workflow-sites.mjs')).href
);
const {chromium} = createRequire(import.meta.url)(playwright);
// The fixture serves web/ from the working directory; --web measures another tree with the same server build.
const served = web ? path.resolve(web) : root;
if (!fs.existsSync(path.join(served, 'web/index.html'))) throw Error('No web/ tree to serve in ' + served);
const previous = process.cwd();
process.chdir(served);
const site = await browserWorkflowSite('empty');
process.chdir(previous);
const browser = await chromium.launch({executablePath, headless: true, args: ['--no-proxy-server']});
const publicRoutes = new Set(['/', '/about', '/login', '/signup', '/forgot-password']);
const results = {};
try {
  for (const locale of ['ar', 'en'])
    for (const route of routes) {
      const samples = [];
      for (let run = 0; run < runs; run++) {
        const context = await browser.newContext({
          viewport: {width: 1280, height: 900},
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
        });
        await context.route('**/*', request =>
          new URL(request.request().url()).origin === site.origin
            ? request.continue()
            : request.abort('blockedbyclient'),
        );
        if (!publicRoutes.has(route)) await context.addCookies([site.cookie]);
        await context.addInitScript(locale => {
          localStorage.setItem('amcp.locale', locale);
          const done = () => {
            const heading = document.querySelector('#content h1, main h1');
            if (
              heading &&
              document.documentElement.lang === locale &&
              (locale === 'en' || /[؀-ۿ]/.test(heading.textContent)) &&
              !document.querySelector('#route-loading') &&
              !window.__firstRender
            )
              window.__firstRender = performance.now();
          };
          new MutationObserver(done).observe(document, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
        }, locale);
        const page = await context.newPage(),
          cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 150,
          downloadThroughput: (1.6 * 1024 * 1024) / 8,
          uploadThroughput: (750 * 1024) / 8,
        });
        await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
        const types = new Map(),
          transferred = {};
        cdp.on('Network.responseReceived', event =>
          types.set(event.requestId, /\/locales\//.test(event.response.url) ? 'locale' : event.type),
        );
        cdp.on('Network.loadingFinished', event => {
          const type = types.get(event.requestId) ?? 'other';
          transferred[type] = (transferred[type] ?? 0) + event.encodedDataLength;
        });
        await page.goto(site.origin + route, {waitUntil: 'load', timeout: 120000});
        await page.waitForFunction(() => window.__firstRender, null, {timeout: 120000, polling: 50}).catch(() => {});
        await page.waitForLoadState('networkidle', {timeout: 120000}).catch(() => {});
        const firstRender = await page.evaluate(() => window.__firstRender ?? null);
        samples.push({first_render_ms: firstRender === null ? null : Math.round(firstRender), transferred});
        await context.close();
      }
      const times = samples
        .map(sample => sample.first_render_ms)
        .filter(value => value !== null)
        .sort((a, b) => a - b);
      results[locale + ' ' + route] = {median_first_render_ms: times[Math.floor(times.length / 2)] ?? null, samples};
      console.log(
        (locale + ' ' + route).padEnd(26),
        String(results[locale + ' ' + route].median_first_render_ms) + ' ms',
      );
    }
} finally {
  await browser.close();
  await site.close();
}
fs.mkdirSync(output, {recursive: true});
fs.writeFileSync(
  path.join(output, 'results.json'),
  JSON.stringify(
    {
      record_kind: 'local_synthetic_first_render_benchmark',
      started_with: {runs, routes, served_tree: web ? path.relative(root, served) || '.' : 'checkout'},
      profile: {latency_ms: 150, download_kbit: 1638, upload_kbit: 750, cpu_slowdown: 4, viewport: '1280x900'},
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log('Wrote ' + path.relative(root, path.join(output, 'results.json')));
process.exit(0);
