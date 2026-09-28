import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {argumentDirectory, metaSdkTag, metaVersion, pin, sdkClass} from './meta-sdk.mjs';

// What changed between two releases of Meta's official Python Business SDK, and what that means for the captured
// Meta catalog: every request (method and edge), parameter, readable field and enum value one release has and the
// next does not, and each catalog action's SDK request at the new release.
// Usage: node tools/meta-sdk-changes.mjs --from-dir <25.0.3 adobjects> --to-dir <26.0.2 adobjects> [--check]
const from = {api_version: 'v25.0', sdk_tag: '25.0.3'},
  to = {api_version: metaVersion, sdk_tag: metaSdkTag},
  fromDir = argumentDirectory('--from-dir', 'the adobjects files of SDK ' + from.sdk_tag),
  toDir = argumentDirectory('--to-dir', 'the adobjects files of SDK ' + to.sdk_tag);
const names = fs
    .readdirSync(toDir)
    .filter(f => f.endsWith('.py') && fs.statSync(path.join(toDir, f)).size && fs.existsSync(path.join(fromDir, f)))
    .map(f => f.slice(0, -3))
    .sort(),
  sources = {},
  before = {},
  after = {};
for (const name of names) {
  const a = fs.readFileSync(path.join(fromDir, name + '.py')),
    b = fs.readFileSync(path.join(toDir, name + '.py')),
    digest = bytes => createHash('sha256').update(bytes).digest('hex');
  sources[name] = {from: digest(a), to: digest(b)};
  before[name] = sdkClass(a.toString('utf8'));
  after[name] = sdkClass(b.toString('utf8'));
}
const key = c => c.method + ' ' + c.edge,
  removed = {calls: [], params: [], fields: [], enum_values: []},
  added = {calls: 0, params: 0, fields: 0, enum_values: 0};
for (const name of names) {
  const a = before[name],
    b = after[name],
    cls = b.class;
  for (const f of a.fields) if (!b.fields.includes(f)) removed.fields.push(cls + '.' + f);
  added.fields += b.fields.filter(f => !a.fields.includes(f)).length;
  for (const [e, values] of Object.entries(a.enums))
    for (const v of values) if (!b.enums[e]?.includes(v)) removed.enum_values.push(cls + '.' + e + '.' + v);
  for (const [e, values] of Object.entries(b.enums))
    added.enum_values += values.filter(v => !a.enums[e]?.includes(v)).length;
  const next = new Map(b.calls.map(c => [key(c), c])),
    previous = new Map(a.calls.map(c => [key(c), c]));
  for (const [k, c] of previous) {
    const n = next.get(k);
    if (!n) removed.calls.push(cls + ' ' + k);
    else for (const p of Object.keys(c.params)) if (!(p in n.params)) removed.params.push(cls + ' ' + k + ' ' + p);
  }
  for (const [k, c] of next) {
    const p = previous.get(k);
    if (!p) added.calls++;
    else added.params += Object.keys(c.params).filter(x => !(x in p.params)).length;
  }
}
// The SDK class behind each node the captured catalog addresses, by the path parameter that names it.
const nodes = {
  ad_account_id: 'adaccount',
  business_id: 'business',
  product_catalog_id: 'productcatalog',
  pixel_id: 'adspixel',
  ad_set_id: 'adset',
  campaign_id: 'campaign',
  custom_audience_id: 'customaudience',
  business_user_id: 'businessuser',
  page_id: 'page',
  ad_id: 'ad',
  product_feed_id: 'productfeed',
  system_user_id: 'systemuser',
  product_set_id: 'productset',
  creative_id: 'adcreative',
  ad_study_id: 'adstudy',
  ad_label_id: 'adlabel',
  user_id: 'user',
  business_role_request_id: 'businessrolerequest',
  request_set_id: 'adasyncrequestset',
  report_run_id: 'adreportrun',
  ig_media_id: 'igmedia',
  ig_user_id: 'iguser',
  app_id: 'application',
  canvas_id: 'canvas',
  comment_id: 'comment',
  form_id: 'leadgenform',
  lead_id: 'lead',
  high_demand_period_id: 'highdemandperiod',
  event_source_group_id: 'eventsourcegroup',
  page_post_id: 'pagepost',
};
const catalog = JSON.parse(fs.readFileSync('.mirror/CATALOG/meta_native_action.json', 'utf8')).actions,
  calls = {},
  gone = [];
for (const action of catalog) {
  const [node, ...rest] = action.path.replace(/^\/v\d+\.\d+\//, '').split('/'),
    module = nodes[/^(?:act_)?\{(\w+)\}$/.exec(node ?? '')?.[1]],
    edge = '/' + rest.join('/'),
    find = sdk => sdk[module]?.calls.find(c => c.method === action.method && c.edge === edge);
  if (!module) continue;
  const now = find(after);
  if (now) calls[action.name] = after[module].class + '.' + now.name;
  else if (find(before)) gone.push(action.name);
}
pin(
  'tests/fixtures/meta-sdk-changes-' + metaVersion.replace('.0', '') + '.json',
  {
    from,
    to,
    checked_at: '2026-09-28',
    meaning:
      "Differences between two releases of Meta's official SDK, generated from Meta's API specification: schema evidence, not behaviour, permissions or live acceptance.",
    source:
      'https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/<sdk_tag>/facebook_business/adobjects/<name>.py',
    sources,
    removed,
    added,
    catalog: {actions: catalog.length, with_sdk_request: Object.keys(calls).length, removed: gone},
    catalog_requests: calls,
  },
  'Meta SDK change evidence',
);
console.log(
  JSON.stringify({
    modules: names.length,
    removed: Object.fromEntries(Object.entries(removed).map(([k, v]) => [k, v.length])),
    added,
    catalog_with_sdk_request: Object.keys(calls).length,
    catalog_removed: gone.length,
  }),
);
