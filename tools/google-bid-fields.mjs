import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

/**
 * The Google Ads money fields the owner's spending caps compare (WRT-01 stage B), generated from the pinned Discovery
 * document rather than maintained by hand: every writable `*Micros` field reachable from the resources whose writes
 * carry bids or budgets must have a class below, or generation fails. A newly pinned version that adds a bid field
 * therefore fails `npm run generate:bids:check` (and tests/spend-policy-money-coverage.test.mjs) until someone classifies
 * it.
 *
 *   bid          per-unit bids and bid limits (ceilings and floors included): compared with max_bid_native
 *   budget       daily budgets: measured by the budget walk and compared with max_budget_native
 *   total        lifetime or custom-period totals: compared with max_total_budget_native (else max_budget_native)
 *   unsupported  money that is neither a bid nor a measured budget: POLICY_AMOUNT_UNSUPPORTED under any numeric cap
 *   ratio        fractions expressed in micros, not money: never compared with a money cap
 *
 * Output-only fields (readOnly, or described "Output only.") are excluded: a request never sets them.
 */
export const roots = [
  'Resources__AdGroup',
  'Resources__AdGroupAd',
  'Resources__AdGroupBidModifier',
  'Resources__AdGroupCriterion',
  'Resources__AssetGroup',
  'Resources__BiddingStrategy',
  'Resources__Campaign',
  'Resources__CampaignBidModifier',
  'Resources__CampaignBudget',
  'Resources__CampaignCriterion',
  'Resources__CampaignGroup',
  'Resources__Customer',
  'Resources__ExperimentArm',
];
/** The checked-in class of each writable money field, keyed `Schema.field` without the version prefix. */
export const classification = {
  'Common__MaximizeConversionValue.cpcBidCeilingMicros': 'bid',
  'Common__MaximizeConversionValue.cpcBidFloorMicros': 'bid',
  'Common__MaximizeConversions.cpcBidCeilingMicros': 'bid',
  'Common__MaximizeConversions.cpcBidFloorMicros': 'bid',
  'Common__MaximizeConversions.targetCpaMicros': 'bid',
  'Common__PercentCpc.cpcBidCeilingMicros': 'bid',
  'Common__TargetCpa.cpcBidCeilingMicros': 'bid',
  'Common__TargetCpa.cpcBidFloorMicros': 'bid',
  'Common__TargetCpa.targetCpaMicros': 'bid',
  'Common__TargetCpc.targetCpcMicros': 'bid',
  'Common__TargetImpressionShare.cpcBidCeilingMicros': 'bid',
  'Common__TargetRoas.cpcBidCeilingMicros': 'bid',
  'Common__TargetRoas.cpcBidFloorMicros': 'bid',
  'Common__TargetSpend.cpcBidCeilingMicros': 'bid',
  'Resources_Campaign_CategoryBid.manualCpaBidMicros': 'bid',
  'Resources_Campaign_CategoryBid.targetCpaBidMicros': 'bid',
  'Resources__AdGroup.cpcBidMicros': 'bid',
  'Resources__AdGroup.cpmBidMicros': 'bid',
  'Resources__AdGroup.cpvBidMicros': 'bid',
  'Resources__AdGroup.fixedCpmMicros': 'bid',
  // A fraction of the advertised price, compared with the bid cap since the cap was introduced; kept rather than loosened.
  'Resources__AdGroup.percentCpcBidMicros': 'bid',
  'Resources__AdGroup.targetCpaMicros': 'bid',
  'Resources__AdGroup.targetCpcMicros': 'bid',
  'Resources__AdGroup.targetCpmMicros': 'bid',
  'Resources__AdGroup.targetCpvMicros': 'bid',
  'Resources__AdGroupCriterion.cpcBidMicros': 'bid',
  'Resources__AdGroupCriterion.cpmBidMicros': 'bid',
  'Resources__AdGroupCriterion.cpvBidMicros': 'bid',
  'Resources__AdGroupCriterion.percentCpcBidMicros': 'bid',
  'Resources_ExperimentArm_ExperimentalPerformanceMaxCampaignSettings.targetCpaMicros': 'bid',
  'Resources__CampaignBudget.amountMicros': 'budget',
  'Resources_ExperimentArm_ExperimentalPerformanceMaxCampaignSettings.budgetAmountMicros': 'budget',
  'Resources__CampaignBudget.totalAmountMicros': 'total',
  // Deprecated spend target of Maximize Clicks: money, but not a per-unit bid and not a budget the walk measures.
  'Common__TargetSpend.targetSpendMicros': 'unsupported',
  'Common__Commission.commissionRateMicros': 'ratio',
  'Common__TargetImpressionShare.locationFractionMicros': 'ratio',
};
export const classes = ['bid', 'budget', 'total', 'unsupported', 'ratio'];
const snake = name => name.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const outputOnly = property => property.readOnly === true || /^\s*Output only\./.test(property.description ?? '');

/** The pinned Google Ads version, as src/google-version.ts declares it. */
export function pinnedGoogleAdsVersion(root = '.') {
  const source = fs.readFileSync(path.join(root, 'src/google-version.ts'), 'utf8'),
    version = /export const googleAdsVersion = '(v\d+)'/.exec(source)?.[1];
  if (!version) throw Error('src/google-version.ts declares no Google Ads version.');
  return version;
}

/**
 * Every writable `*Micros` field reachable from `roots` in a Discovery `document`, with its class. Throws, naming each
 * one, when a field has no class: the recurrence guard of WRT-01.
 */
export function classifyGoogleBidFields(document, version, table = classification) {
  const prefix = 'GoogleAdsGoogleads' + version.toUpperCase(),
    schemas = document?.schemas;
  if (!schemas || typeof schemas !== 'object') throw Error('The Discovery document has no schemas.');
  const seen = new Set(),
    found = new Map();
  const walk = name => {
    if (seen.has(name)) return;
    seen.add(name);
    const schema = schemas[name];
    if (!schema) throw Error('The Discovery document references a missing schema: ' + name);
    for (const [field, property] of Object.entries(schema.properties ?? {})) {
      const ref = property.$ref ?? property.items?.$ref;
      if (ref) walk(ref);
      if (!/Micros$/.test(field) || outputOnly(property)) continue;
      found.set(name.slice(prefix.length) + '.' + field, field);
    }
  };
  for (const root of roots) {
    if (!schemas[prefix + root]) throw Error('The Discovery document has no ' + root + ' schema.');
    walk(prefix + root);
  }
  const unclassified = [...found.keys()].filter(key => !classes.includes(table[key])).sort();
  if (unclassified.length)
    throw Object.assign(
      Error(
        'Unclassified writable Google Ads money fields (classify each in tools/google-bid-fields.mjs): ' +
          unclassified.join(', '),
      ),
      {unclassified},
    );
  const stale = Object.keys(table)
    .filter(key => !found.has(key))
    .sort();
  if (stale.length)
    throw Object.assign(Error('Classified fields absent from the pinned document: ' + stale.join(', ')), {stale});
  const fields = Object.fromEntries(classes.map(c => [c, []]));
  const locations = [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([location, field]) => ({location, field: snake(field), class: table[location]}));
  for (const l of locations) if (!fields[l.class].includes(l.field)) fields[l.class].push(l.field);
  for (const c of classes) fields[c].sort();
  // One snake-case name must mean one thing: the policy matches request keys by name.
  const names = new Map();
  for (const l of locations) {
    const other = names.get(l.field);
    if (other && other !== l.class) throw Error(l.field + ' is classified both ' + other + ' and ' + l.class + '.');
    names.set(l.field, l.class);
  }
  return {fields, locations};
}

export function googleBidFieldsArtifact(root = '.') {
  const version = pinnedGoogleAdsVersion(root),
    source = '.mirror/VENDOR/google-ads-' + version + '.json',
    raw = fs.readFileSync(path.join(root, source), 'utf8'),
    pinned = JSON.parse(raw),
    {fields, locations} = classifyGoogleBidFields(pinned.document, version);
  return (
    JSON.stringify(
      {
        generated_by: 'tools/google-bid-fields.mjs',
        api_version: version,
        source,
        source_sha256: createHash('sha256').update(raw).digest('hex'),
        roots,
        classes: {
          bid: 'per-unit bids and bid limits, compared with max_bid_native',
          budget: 'daily budgets, compared with max_budget_native',
          total: 'lifetime or custom-period totals, compared with max_total_budget_native (else max_budget_native)',
          unsupported: 'money neither a bid nor a measured budget: POLICY_AMOUNT_UNSUPPORTED under any numeric cap',
          ratio: 'fractions expressed in micros, never compared with a money cap',
        },
        fields,
        locations,
      },
      null,
      2,
    ) + '\n'
  );
}

export const output = 'generated/google-bid-fields.json';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = googleBidFieldsArtifact();
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== text)
      throw Error('Google bid fields are stale; run node tools/google-bid-fields.mjs.');
  } else fs.writeFileSync(output, text);
  const parsed = JSON.parse(text);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(parsed.fields).map(([k, v]) => [k, v.length]))));
}
