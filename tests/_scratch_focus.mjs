import {createRequire} from 'node:module';
import {browserWorkflowSite} from './fixtures/browser-workflow-sites.mjs';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.AMCP_QA_PLAYWRIGHT_MODULE);
const browser = await chromium.launch({executablePath: process.env.AMCP_QA_BROWSER_PATH, headless: true});
const site = await browserWorkflowSite('empty');
const route = process.argv[2] ?? '/reporting-overview';
const scheme = process.argv[3] ?? 'dark';
const locale = process.argv[4] ?? 'en';
const context = await browser.newContext({viewport: {width: 1280, height: 900}, colorScheme: scheme});
await context.route('**/*', r => (new URL(r.request().url()).origin === site.origin ? r.continue() : r.abort()));
await context.addCookies([site.cookie]);
await context.addInitScript(locale => localStorage.setItem('amcp.locale', locale), locale);
const page = await context.newPage();
await page.goto(site.origin + route, {waitUntil: 'networkidle'});
await page.keyboard.press('Shift');
const out = await page.evaluate(selectors => {
  return selectors.map(selector => {
    const el = document.querySelector(selector);
    if (!el) return {selector, missing: true};
    el.focus();
    const s = getComputedStyle(el);
    const chain = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      chain.push((n.id ? '#' + n.id : n.tagName.toLowerCase() + '.' + [...n.classList].join('.')) + ' bg=' + cs.backgroundColor + ' img=' + cs.backgroundImage.slice(0, 80));
      if (chain.length > 6) break;
    }
    return {selector, outline: s.outlineColor, style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, fv: el.matches(':focus-visible'), chain};
  });
}, process.argv.slice(5).length ? process.argv.slice(5) : ['#overview-new', '#overview-saved']);
console.log(JSON.stringify(out, null, 1));
const leaks = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(e => e.children.length === 0 && /[a-z]{2,} [a-z]{2,}/i.test(e.textContent)).map(e => e.tagName + '.' + e.className + ': ' + e.textContent.trim().slice(0, 200)).slice(0, 40));
if (locale === 'ar') console.log(leaks.join('\n'));
await browser.close();
await site.close();
