import fs from 'node:fs';
import {Script, createContext} from 'node:vm';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
export const arabic = catalog;
export const locales = ['en', 'ar'];
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character],
  );
export const plainText = html =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The report page's own scripts (web/*.js) in a VM, in one language, with the given bootstrap: what the website draws for
 * a snapshot the server stored. `view.call(expression, values)` runs an expression of the page and returns text.
 */
export function reportPage(locale, bootstrap) {
  const context = createContext({
    Intl,
    Date,
    URLSearchParams,
    structuredClone,
    esc,
    catalog,
    bootstrap,
    $: () => null,
    CSS: {escape: String},
    location: {pathname: '/reporting-overview', search: ''},
    document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
  });
  const run = code => new Script(code).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  // The shell's own date helper (web/app.js).
  run("var date = value => (value ? uiDate(value) : uiText('Not synced'));");
  // The shell helpers the report scripts share: pretty() and the source diagnostic.
  const workspace = fs.readFileSync('web/workspace.js', 'utf8');
  run(
    workspace.slice(
      workspace.indexOf('const overviewCall = async input => {'),
      workspace.indexOf('const capabilityFeatureLabels'),
    ),
  );
  for (const file of ['report-library', 'report-source-settings', 'report-quality', 'reporting-overview'])
    run(fs.readFileSync('web/' + file + '.js', 'utf8'));
  run(
    `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});overviewState.bootstrap=bootstrap;`,
  );
  const raw = (expression, values = {}) => {
    Object.assign(context, values);
    return run('(' + expression + ')');
  };
  return {
    run,
    raw,
    call: (expression, values = {}) => String(raw(expression, values)),
    /** The message as the language shows it: the catalog's Arabic, or the English key itself. */
    text: key => (locale === 'ar' ? catalog[key] : key),
  };
}
