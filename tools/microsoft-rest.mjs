import fs from 'node:fs';
import {createHash} from 'node:crypto';

/**
 * Microsoft Advertising v13 REST evidence (F-50). AMCP sends v13's REST (JSON) requests; Microsoft retires the SOAP
 * endpoints on 2027-01-31, and the pinned WSDLs describe SOAP. Microsoft Learn documents each operation's REST
 * request: the page's REST section gives the HTTP method (as the language of the URL's code block), the production
 * and sandbox URLs, and JSON request and response templates. This pins those four facts for every operation AMCP
 * sends (`microsoftActions`); `src/microsoft-evidence.ts` holds each compiled request to them.
 *
 *   node tools/microsoft-rest.mjs            fetch the pages of operations not pinned yet
 *   node tools/microsoft-rest.mjs --refresh  fetch every page again
 *   node tools/microsoft-rest.mjs --check    offline: the pin is sealed and covers exactly AMCP's operations
 */
const file = '.mirror/VENDOR/microsoft-rest-v13.json',
  source = 'https://learn.microsoft.com/en-us/advertising/',
  hash = value => createHash('sha256').update(value).digest('hex');
const {microsoftActions} = await import('../dist/src/microsoft-native.js');
const pages = Object.fromEntries(microsoftActions.map(a => [a.name, a.raw.source]));
for (const [name, page] of Object.entries(pages))
  if (!page.startsWith(source) || !page.endsWith('?view=bingads-13')) throw Error('Unexpected page for ' + name);
const decode = text =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
/** The REST facts of one Learn page, from its REST section only (the SOAP section documents the same operation). */
export function restSection(html, name) {
  const start = html.indexOf('data-pivot="rest"');
  if (start < 0) throw Error(name + ': the page has no REST section');
  const rest = html.slice(start),
    blocks = (id, count) => {
      const at = rest.indexOf('id="' + id + '"');
      if (at < 0) throw Error(name + ': no ' + id);
      const found = [...rest.slice(at).matchAll(/<code class="lang-([^"]*)">([\s\S]*?)<\/code>/g)].slice(0, count);
      if (found.length < count) throw Error(name + ': no code block after ' + id);
      return found.map(code => ({language: code[1], text: decode(code[2]).trim()}));
    };
  // The Request Url heading is followed by the production URL, then the sandbox URL.
  const [production, sandbox] = blocks('url', 2),
    [request] = blocks('request-json', 1),
    [response] = blocks('response-json', 1);
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(production.language) || sandbox.language !== production.language)
    throw Error(name + ': no HTTP method on the REST URL');
  if (!/^https:\/\/[a-z.]+\.bingads\.microsoft\.com\/\S+$/.test(production.text))
    throw Error(name + ': unexpected production URL');
  if (request.language !== 'json' || response.language !== 'json') throw Error(name + ': templates are not JSON');
  return {
    method: production.language,
    url: production.text,
    sandbox_url: sandbox.text,
    request_json: request.text,
    response_json: response.text,
  };
}
/** The top-level fields of a JSON template (its placeholders, such as IntValueHere, are not JSON values). */
export function templateFields(template) {
  return Object.keys(JSON.parse(template.replace(/:\s*[A-Za-z]+ValueHere\b/g, ': null')));
}
const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined);
function verify(envelope) {
  if (!envelope) throw Error('Missing Microsoft REST evidence: ' + file);
  if (envelope.source !== source || envelope.document_sha256 !== hash(JSON.stringify(envelope.document)))
    throw Error('Microsoft REST evidence is unsealed or does not match its digest');
  const pinned = Object.keys(envelope.document.operations).sort(),
    wanted = Object.keys(pages).sort();
  if (JSON.stringify(pinned) !== JSON.stringify(wanted))
    throw Error('Microsoft REST evidence covers ' + pinned.join(',') + ' but AMCP sends ' + wanted.join(','));
  for (const [name, op] of Object.entries(envelope.document.operations)) {
    if (op.page !== pages[name]) throw Error(name + ': pinned from another page');
    templateFields(op.request_json);
    templateFields(op.response_json);
  }
}
if (process.argv.includes('--check')) verify(read());
else {
  const previous = read(),
    refresh = process.argv.includes('--refresh'),
    operations = {};
  for (const [name, page] of Object.entries(pages)) {
    const pinned = previous?.document.operations[name];
    if (pinned && !refresh && pinned.page === page) {
      operations[name] = pinned;
      continue;
    }
    const response = await fetch(page, {redirect: 'follow', signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw Error(name + ' HTTP ' + response.status);
    operations[name] = {page, ...restSection(await response.text(), name)};
  }
  const document = {
    version: 'v13',
    operations: Object.fromEntries(Object.entries(operations).sort(([a], [b]) => a.localeCompare(b, 'en'))),
  };
  const envelope = {
    source,
    captured_at:
      previous && JSON.stringify(previous.document) === JSON.stringify(document)
        ? previous.captured_at
        : new Date().toISOString(),
    evidence: 'VENDOR_DOCUMENTED_NOT_AMCP_OBSERVED',
    document_sha256: hash(JSON.stringify(document)),
    document,
  };
  verify(envelope);
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2) + '\n');
  console.log({operations: Object.keys(operations).length});
}
