import fs from 'node:fs';
import {createHash} from 'node:crypto';

/**
 * Microsoft Advertising v13 REST evidence (F-50). AMCP sends v13's REST (JSON) requests; Microsoft retires the SOAP
 * endpoints on 2027-01-31, and the pinned WSDLs describe SOAP. Microsoft Learn documents each operation's REST
 * request: the page's REST section gives the HTTP method (as the language of the URL's code block), the production
 * and sandbox URLs, and JSON request and response templates. This pins those four facts for every operation AMCP
 * sends (`microsoftActions`); `src/microsoft-evidence.ts` holds each compiled request to them.
 *
 * It also pins, by page and content digest, the data-object pages whose rules the location-criterion family relies on
 * (`referencePages`, CMP-03): what a positive location criterion is, which fields an add leaves read-only, the default
 * bid multiplier and location intent, and the criterion types used to add (Targets) and to read (Location). Two guides
 * are pinned the same way: the targeting guide, which states the premise of owner decision P7 (a campaign created
 * through the API has no criteria and effectively targets every location), and the geographical location codes guide
 * (where location IDs come from, and what a deprecated location still does).
 *
 * Provenance: every pinned page records when it was read (`read_at`), and a page AMCP takes rules from records them,
 * in AMCP's words (`relies_on`, from `reliesOn` below; src/microsoft-campaign-criteria.ts applies them). A page whose
 * rules change here is read again. After --refresh, every page whose template or digest changed is printed with the
 * rules it carries: read it again and check them before changing src/microsoft-campaign-criteria.ts.
 *
 *   node tools/microsoft-rest.mjs            fetch the pages not pinned yet, or whose rules changed
 *   node tools/microsoft-rest.mjs --refresh  fetch every page again
 *   node tools/microsoft-rest.mjs --check    offline: the pin is sealed and covers exactly AMCP's operations and the
 *                                            reference pages, each with its read time and rules
 */
// --check may name another copy of the pin to check (--file=path), as the tests do; fetching always writes the pin.
const file =
    (process.argv.includes('--check') && process.argv.find(a => a.startsWith('--file='))?.slice('--file='.length)) ||
    '.mirror/VENDOR/microsoft-rest-v13.json',
  source = 'https://learn.microsoft.com/en-us/advertising/',
  hash = value => createHash('sha256').update(value).digest('hex');
const {microsoftActions} = await import('../dist/src/microsoft-native.js');
const pages = Object.fromEntries(microsoftActions.map(a => [a.name, a.raw.source]));
for (const [name, page] of Object.entries(pages))
  if (!page.startsWith(source) || !page.endsWith('?view=bingads-13')) throw Error('Unexpected page for ' + name);
/**
 * The rules AMCP takes from a page beyond its REST templates (CMP-03, owner decision P7), paraphrased. The
 * location-criterion family (src/microsoft-campaign-criteria.ts) and the activation guard (microsoft-native.ts) apply
 * them; docs/MICROSOFT-ADS.md explains them.
 */
export const reliesOn = {
  AddCampaignCriterions: [
    'Location criteria are added with CriterionType Targets, at most 100 criteria per request.',
    'CampaignCriterionIds follows the request rows, null where a row was not added; NestedPartialErrors lists the failures, not aligned with the rows, and can be empty when none failed.',
  ],
  GetCampaignCriterionsByIds: [
    'Targets is not allowed on this read: location criteria are read with CriterionType Location.',
    'CampaignCriterionIds null returns every criterion of that type of the campaign; listed IDs return their criteria in order, null where one was not returned.',
  ],
  DeleteCampaignCriterions: [
    'Location criteria are deleted with CriterionType Targets, by CampaignId and at most 100 CampaignCriterionIds.',
  ],
  BiddableCampaignCriterion: [
    'A targeted (positive) criterion is a BiddableCampaignCriterion; CampaignId and Criterion are required on add, Id and Status are read-only, and Active is its only status.',
    'CriterionBid is optional on add for a location criterion: without it the bid multiplier is 0, no adjustment.',
  ],
  NegativeCampaignCriterion: [
    'An excluded criterion is a NegativeCampaignCriterion: excluding a location targets no location.',
  ],
  LocationCriterion: [
    'LocationId, required on add, is a Location Id of the geographical locations file (GetGeoLocationsFileUrl); DisplayName, EnclosedLocationIds and LocationType are read-only.',
    'A location the file marks PendingDeprecation no longer targets or excludes; a deprecated location cannot be added.',
    'Read back, the criterion type is Location.',
    'An ad group with any location, negative location or radius criterion of its own does not inherit the campaign’s.',
  ],
  LocationIntentCriterion: [
    'The first criterion of a campaign adds a location intent of PeopleInOrSearchingForOrViewingPages (people in, searching for or viewing pages about the locations); PeopleIn targets people in them only.',
    'A location intent criterion cannot be deleted and takes no bid.',
  ],
  BidMultiplier: ['Multiplier is a percentage adjustment of the bid, -90 through 900 for most criterion types.'],
  CampaignCriterionType: [
    'Targets adds, updates and deletes location criteria; reads name the specific type, Location.',
    'A location may be targeted (BiddableCampaignCriterion) or excluded (NegativeCampaignCriterion).',
  ],
  ShowAdsToYourTargetAudience: [
    'A campaign or ad group created through the API has no criteria, and effectively targets all locations (and all ages, days, hours, devices and genders) until criteria are added; Microsoft advises at least a campaign location criterion for the customer’s market.',
    'Location, negative location and radius criteria are one set of geo criteria: an ad group with any of its own inherits none of the campaign’s, and one with none inherits all of them.',
  ],
  GeographicalLocationCodes: [
    'A location criterion takes the Location Id column of the geographical locations file (GetGeoLocationsFileUrl); the Bing Display Name is for presentation only, and several IDs can share one.',
    'This guide says a Pending Deprecation location still targets until it is deprecated within 30 days, while the LocationCriterion page says PendingDeprecation already stops targeting; both say a deprecated location criterion can still be read but no longer targets or excludes.',
  ],
};
export const referencePages = {
  ...Object.fromEntries(
    [
      'BiddableCampaignCriterion',
      'NegativeCampaignCriterion',
      'LocationCriterion',
      'LocationIntentCriterion',
      'BidMultiplier',
      'CampaignCriterionType',
    ].map(name => [name, source + 'campaign-management-service/' + name.toLowerCase() + '?view=bingads-13']),
  ),
  ShowAdsToYourTargetAudience: source + 'guides/show-ads-target-audience?view=bingads-13',
  GeographicalLocationCodes: source + 'guides/geographical-location-codes?view=bingads-13',
};
for (const [name, page] of Object.entries(referencePages))
  if (!page.startsWith(source) || !page.endsWith('?view=bingads-13')) throw Error('Unexpected page for ' + name);
for (const name of Object.keys(reliesOn))
  if (!pages[name] && !referencePages[name]) throw Error('Rules for a page that is not pinned: ' + name);
const sameRules = (pinned, name) =>
  JSON.stringify(pinned?.relies_on ?? null) === JSON.stringify(reliesOn[name] ?? null);
/** When and why a page was read: its read time and, when AMCP takes rules from it, those rules. */
const provenance = name => ({
  read_at: new Date().toISOString(),
  ...(reliesOn[name] ? {relies_on: reliesOn[name]} : {}),
});
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
/** The article of a Learn page as plain text (its main element, tags removed, whitespace collapsed), and its digest. */
export function articleSection(html, name) {
  const start = html.indexOf('<main'),
    end = html.lastIndexOf('</main>'),
    title = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1];
  if (start < 0 || end < start || !title) throw Error(name + ': the page has no article');
  const text = decode(
    html
      .slice(start, end)
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
  return {title: decode(title.replace(/<[^>]+>/g, '')).trim(), characters: text.length, content_sha256: hash(text)};
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
  const provenanceOf = (name, entry) => {
    if (typeof entry.read_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(entry.read_at))
      throw Error(name + ': no read time');
    if (!sameRules(entry, name)) throw Error(name + ': the pinned rules differ from reliesOn; read the page again');
  };
  for (const [name, op] of Object.entries(envelope.document.operations)) {
    if (op.page !== pages[name]) throw Error(name + ': pinned from another page');
    templateFields(op.request_json);
    templateFields(op.response_json);
    provenanceOf(name, op);
  }
  const references = envelope.document.references ?? {};
  if (JSON.stringify(Object.keys(references).sort()) !== JSON.stringify(Object.keys(referencePages).sort()))
    throw Error('Microsoft REST evidence pins the reference pages ' + Object.keys(references).join(','));
  for (const [name, ref] of Object.entries(references)) {
    if (ref.page !== referencePages[name] || !/^[0-9a-f]{64}$/.test(ref.content_sha256) || !ref.title)
      throw Error(name + ': reference page not pinned');
    provenanceOf(name, ref);
  }
}
if (process.argv.includes('--check')) verify(read());
else {
  const previous = read(),
    refresh = process.argv.includes('--refresh'),
    operations = {},
    changed = [];
  /** The page as pinned, or read again (when asked, when new, or when its rules changed), with its provenance. */
  const pin = async (name, page, pinned, section) => {
    if (pinned && !refresh && pinned.page === page && sameRules(pinned, name)) return pinned;
    const response = await fetch(page, {redirect: 'follow', signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw Error(name + ' HTTP ' + response.status);
    const facts = section(await response.text(), name),
      {read_at: _read, relies_on: _rules, ...before} = pinned ?? {};
    if (pinned && JSON.stringify({...before}) !== JSON.stringify({page, ...facts}))
      changed.push({page: name, relies_on: reliesOn[name] ?? []});
    return {page, ...provenance(name), ...facts};
  };
  for (const [name, page] of Object.entries(pages))
    operations[name] = await pin(name, page, previous?.document.operations[name], restSection);
  const references = {};
  for (const [name, page] of Object.entries(referencePages))
    references[name] = await pin(name, page, previous?.document.references?.[name], articleSection);
  const document = {
    version: 'v13',
    operations: Object.fromEntries(Object.entries(operations).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    references: Object.fromEntries(Object.entries(references).sort(([a], [b]) => a.localeCompare(b, 'en'))),
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
  console.log({operations: Object.keys(operations).length, references: Object.keys(references).length});
  // A page whose template or text changed since it was pinned: check its rules against it before relying on them.
  for (const c of changed) console.log(JSON.stringify({changed_since_pinned: c.page, check_rules: c.relies_on}));
}
