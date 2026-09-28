import {MirrorError} from './errors.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {googleAdsCustomers} from './google-version.js';

/**
 * Brand guidelines of existing Performance Max campaigns, Google Ads API v23 (pinned Discovery document:
 * CampaignService.EnablePMaxBrandGuidelines, EnableOperation, BrandCampaignAssets, EnablementResult, Campaign
 * brand_guidelines_enabled and brand_guidelines, CampaignAsset; "Asset requirements" of the Performance Max guide; checked
 * 2026-09-27). Enabling links the business name and logos to the campaign instead of its asset groups. It cannot be turned
 * off again, campaigns with travel goals do not support it, and a request enables at most 10 campaigns. A campaign then has
 * one business name (at most 25 characters) and one to five logos: at least one square LOGO (1:1, at least 128 x 128) and
 * optional LANDSCAPE_LOGO images (4:1, at least 512 x 128).
 */
type Context = {campaigns: string[]; assets: string[]};
type Read = CompiledRequest & {googleBrandGuidelinesState?: Context};
type Send = (p: CompiledRequest) => Promise<TransportResult>;
export const googleBrandGuidelineFonts = [
  'Open Sans',
  'Roboto',
  'Roboto Slab',
  'Montserrat',
  'Poppins',
  'Lato',
  'Oswald',
  'Playfair Display',
];
const color = /^#[0-9A-Fa-f]{6}$/,
  domain = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const roles = ['BUSINESS_NAME', 'LOGO', 'LANDSCAPE_LOGO'],
  maxLogos = 5;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_BRAND_GUIDELINES', message);
}
function unverified(message: string): never {
  return fail('BRAND_GUIDELINES_STATE_UNVERIFIED', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.');
  return id!;
};
function rn(p: CompiledRequest, v: unknown, collection: string, label: string): string {
  if (typeof v !== 'string' || !new RegExp('^customers/' + account(p) + '/' + collection + '/[1-9][0-9]*$').test(v))
    invalid(label + ' is an exact ' + collection + ' resource name of the selected customer.');
  return v as string;
}
/** Asset keys survive the key folding of verification: the numeric asset ID with a prefix. */
const assetKey = (name: string) => 'a' + name.split('/').at(-1);
export function googleBrandGuidelinesKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v\d+\/customers\/\d+\/campaigns:enablePMaxBrandGuidelines$/.test(p.path)
  );
}
const operations = (p: CompiledRequest) => googleJson(p.body).operations as JsonObject[];
export function assertGoogleBrandGuidelines(p: CompiledRequest): void {
  if (!googleBrandGuidelinesKind(p)) return;
  if (p.path.split('/')[3] !== account(p))
    fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected customer.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Brand guideline reviews take no query or header overrides.');
  const b = googleJson(p.body);
  if (
    !object(b) ||
    Object.keys(b).some(k => k !== 'operations') ||
    !Array.isArray(b.operations) ||
    !b.operations.length ||
    b.operations.length > 10
  )
    invalid('Send 1–10 enable operations in operations.');
  const seen = new Set<string>();
  (b.operations as unknown[]).forEach((op, i) => {
    const at = 'operations[' + i + ']';
    if (!object(op)) invalid(at + ' is an object.');
    const extra = Object.keys(op).filter(
      k =>
        ![
          'campaign',
          'autoPopulateBrandAssets',
          'brandAssets',
          'finalUriDomain',
          'mainColor',
          'accentColor',
          'fontFamily',
        ].includes(k),
    );
    if (extra.length) invalid(at + ': unqualified fields ' + extra.join(', ') + '.');
    const c = rn(p, op.campaign, 'campaigns', at + '.campaign');
    if (seen.has(c)) invalid('Each campaign appears once.');
    seen.add(c);
    if (typeof op.autoPopulateBrandAssets !== 'boolean')
      invalid(at + '.autoPopulateBrandAssets is true or false; it is required.');
    if (op.autoPopulateBrandAssets) {
      if (op.brandAssets !== undefined)
        invalid(
          at +
            ': with autoPopulateBrandAssets true Google chooses the brand assets; omit brandAssets, or set autoPopulateBrandAssets to false.',
        );
    } else {
      const a = op.brandAssets;
      if (!object(a)) invalid(at + '.brandAssets is required when autoPopulateBrandAssets is false.');
      const x = Object.keys(a).filter(k => !['businessNameAsset', 'logoAsset', 'landscapeLogoAsset'].includes(k));
      if (x.length) invalid(at + '.brandAssets: unqualified fields ' + x.join(', ') + '.');
      rn(p, a.businessNameAsset, 'assets', at + '.brandAssets.businessNameAsset');
      if (!Array.isArray(a.logoAsset) || !a.logoAsset.length)
        invalid(at + '.brandAssets.logoAsset lists at least one square logo asset.');
      if (a.landscapeLogoAsset !== undefined && !Array.isArray(a.landscapeLogoAsset))
        invalid(at + '.brandAssets.landscapeLogoAsset lists landscape logo assets.');
      const logos = [...a.logoAsset, ...(a.landscapeLogoAsset ?? [])];
      logos.forEach((v, j) => rn(p, v, 'assets', at + '.brandAssets logo ' + j));
      if (logos.length > maxLogos)
        invalid(
          at +
            ': a campaign takes at most ' +
            maxLogos +
            ' logos (one square logo and up to four more square or landscape logos).',
        );
      if (new Set(logos).size !== logos.length || logos.includes(a.businessNameAsset))
        invalid(at + ': an asset appears twice.');
    }
    if ((op.mainColor === undefined) !== (op.accentColor === undefined))
      invalid(at + ': mainColor and accentColor are set together.');
    for (const k of ['mainColor', 'accentColor'])
      if (op[k] !== undefined && (typeof op[k] !== 'string' || !color.test(op[k])))
        invalid(at + '.' + k + ' is a hex color such as #00ff00.');
    if (op.fontFamily !== undefined && !googleBrandGuidelineFonts.includes(op.fontFamily))
      invalid(at + '.fontFamily is one of ' + googleBrandGuidelineFonts.join(', ') + '.');
    if (op.finalUriDomain !== undefined && (typeof op.finalUriDomain !== 'string' || !domain.test(op.finalUriDomain)))
      invalid(at + '.finalUriDomain is a domain such as example.com, without scheme or path.');
  });
}
const quote = (names: string[]) => names.map(n => "'" + n + "'").join(', ');
function read(p: CompiledRequest, query: string): Read {
  return {
    ...p,
    action: 'AMCP_BRAND_GUIDELINES_READ',
    method: 'POST',
    path: googleAdsCustomers + account(p) + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    googleBrandGuidelinesState: undefined,
  };
}
export function googleBrandGuidelinesSnapshots(p: CompiledRequest): Read[] {
  const ops = operations(p),
    campaigns = [...new Set(ops.map(o => String(o.campaign)))].sort();
  const assets = [
    ...new Set(
      ops
        .flatMap(o =>
          object(o.brandAssets)
            ? [
                o.brandAssets.businessNameAsset,
                ...(o.brandAssets.logoAsset ?? []),
                ...(o.brandAssets.landscapeLogoAsset ?? []),
              ]
            : [],
        )
        .map(String),
    ),
  ].sort();
  return [
    {
      ...read(p, 'SELECT customer.id, customer.manager FROM customer LIMIT 1'),
      googleBrandGuidelinesState: {campaigns, assets},
    },
  ];
}
export function isGoogleBrandGuidelinesRead(p: CompiledRequest): p is Read {
  return !!(p as Read).googleBrandGuidelinesState;
}
export async function readGoogleBrandGuidelines(p: CompiledRequest, send: Send): Promise<TransportResult> {
  const c = (p as Read).googleBrandGuidelinesState;
  if (!c) return send(p);
  let requests = 0,
    rows = 0;
  const search = async (query: string): Promise<JsonObject[]> => {
    const out: JsonObject[] = [],
      tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 10 || ++requests > 40) unverified('Brand guideline state exceeded its page or request bound.');
      const plan = read(p, query);
      if (token) (plan.body as JsonObject).pageToken = token;
      const r = await send(plan),
        d = r.data;
      if (
        r.status !== 200 ||
        !object(d) ||
        (d.results !== undefined && !Array.isArray(d.results)) ||
        (d.nextPageToken !== undefined && typeof d.nextPageToken !== 'string')
      )
        unverified('Google returned a failed or unrecognized search response.');
      const values = (d.results ?? []) as unknown[];
      rows += values.length;
      if (rows > 2000) unverified('Brand guideline state exceeded 2000 rows.');
      for (const v of values) {
        if (!object(v)) unverified('A search row is malformed.');
        out.push(v);
      }
      if (!d.nextPageToken) return out;
      if (tokens.has(d.nextPageToken) || !values.length) unverified('Search pagination is repeated or incomplete.');
      tokens.add(d.nextPageToken);
      token = d.nextPageToken;
    }
  };
  const customer = await search('SELECT customer.id, customer.manager FROM customer LIMIT 1');
  if (
    customer.length !== 1 ||
    !object(customer[0]!.customer) ||
    String(customer[0]!.customer.id) !== account(p) ||
    customer[0]!.customer.manager === true
  )
    unverified('Verify the selected client customer.');
  const campaigns: JsonObject = {};
  for (const row of await search(
    'SELECT campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.brand_guidelines_enabled, campaign.brand_guidelines.main_color, campaign.brand_guidelines.accent_color, campaign.brand_guidelines.predefined_font_family, campaign.travel_campaign_settings.travel_account_id FROM campaign WHERE campaign.resource_name IN (' +
      quote(c.campaigns) +
      ')',
  )) {
    const v = object(row.campaign) ? row.campaign : {};
    const name = String(v.resourceName);
    if (!c.campaigns.includes(name) || Object.hasOwn(campaigns, name))
      unverified('A campaign was foreign or repeated.');
    campaigns[name] = {
      name: v.name ?? null,
      status: v.status ?? null,
      channel: v.advertisingChannelType ?? null,
      enabled: v.brandGuidelinesEnabled === true,
      mainColor: v.brandGuidelines?.mainColor ?? null,
      accentColor: v.brandGuidelines?.accentColor ?? null,
      font: v.brandGuidelines?.predefinedFontFamily ?? null,
      travel: v.travelCampaignSettings?.travelAccountId !== undefined,
    };
  }
  const assets: JsonObject = {};
  if (c.assets.length)
    for (const row of await search(
      'SELECT asset.resource_name, asset.type, asset.text_asset.text, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels FROM asset WHERE asset.resource_name IN (' +
        quote(c.assets) +
        ')',
    )) {
      const v = object(row.asset) ? row.asset : {};
      const name = String(v.resourceName);
      if (!c.assets.includes(name) || Object.hasOwn(assets, name)) unverified('An asset was foreign or repeated.');
      assets[name] = {
        type: v.type ?? null,
        text: v.textAsset?.text ?? null,
        width: v.imageAsset?.fullSize?.widthPixels !== undefined ? Number(v.imageAsset.fullSize.widthPixels) : null,
        height: v.imageAsset?.fullSize?.heightPixels !== undefined ? Number(v.imageAsset.fullSize.heightPixels) : null,
      };
    }
  // Enabled links of the brand roles, per campaign and role, keyed by asset ID.
  const links: JsonObject = Object.fromEntries(c.campaigns.map(n => [n, Object.fromEntries(roles.map(r => [r, {}]))]));
  for (const row of await search(
    'SELECT campaign_asset.resource_name, campaign_asset.campaign, campaign_asset.asset, campaign_asset.field_type, campaign_asset.status FROM campaign_asset WHERE campaign_asset.campaign IN (' +
      quote(c.campaigns) +
      ") AND campaign_asset.field_type IN ('BUSINESS_NAME', 'LOGO', 'LANDSCAPE_LOGO') AND campaign_asset.status = 'ENABLED'",
  )) {
    const v = object(row.campaignAsset) ? row.campaignAsset : {};
    const campaign = String(v.campaign),
      role = String(v.fieldType),
      asset = String(v.asset);
    if (
      !c.campaigns.includes(campaign) ||
      !roles.includes(role) ||
      !new RegExp('^customers/' + account(p) + '/assets/[1-9][0-9]*$').test(asset)
    )
      unverified('A campaign asset link is foreign or malformed.');
    links[campaign][role][assetKey(asset)] = true;
  }
  return {status: 200, headers: {}, data: {customer: {id: account(p)}, campaigns, assets, links}};
}
export function validateGoogleBrandGuidelinesState(p: CompiledRequest, r: TransportResult): void {
  const c = (p as Read).googleBrandGuidelinesState,
    d = r.data;
  if (
    !c ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.customer) ||
    d.customer.id !== account(p) ||
    !object(d.campaigns) ||
    !object(d.assets) ||
    !object(d.links)
  )
    unverified('Complete brand guideline state is missing.');
}
export function googleBrandGuidelinesPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!googleBrandGuidelinesKind(p)) return;
  const s = states[0];
  if (!object(s) || !object(s.campaigns) || !object(s.assets)) unverified('Complete brand guideline state is missing.');
  for (const op of operations(p)) {
    const name = String(op.campaign),
      campaign = s.campaigns[name];
    if (!object(campaign))
      fail(
        'STATE_TARGET_MISMATCH',
        'Campaign ' + name + ' is not a campaign of the selected customer.',
        {campaign: name},
        409,
      );
    if (campaign.channel !== 'PERFORMANCE_MAX')
      invalid(
        'Campaign ' +
          name +
          ' is ' +
          String(campaign.channel) +
          '; brand guidelines apply to Performance Max campaigns.',
      );
    if (campaign.status === 'REMOVED') invalid('Campaign ' + name + ' is removed.');
    if (campaign.travel) invalid('Campaign ' + name + ' has travel goals, which brand guidelines do not support.');
    if (campaign.enabled)
      fail(
        'CONFIGURATION_EXISTS',
        'Campaign ' + name + ' already has brand guidelines; they cannot be enabled twice or turned off.',
        {campaign: name},
      );
    if (!object(op.brandAssets)) continue;
    const asset = (id: unknown, role: string) => {
      const a = s.assets[String(id)];
      if (!object(a))
        fail(
          'STATE_TARGET_MISMATCH',
          'Asset ' + String(id) + ' is not an asset of the selected customer.',
          {asset: String(id)},
          409,
        );
      return a;
    };
    const business = asset(op.brandAssets.businessNameAsset, 'BUSINESS_NAME');
    if (
      business.type !== 'TEXT' ||
      typeof business.text !== 'string' ||
      !business.text.trim() ||
      [...business.text].length > 25
    )
      invalid('The business name asset is a text asset of 1–25 characters.');
    for (const id of op.brandAssets.logoAsset as unknown[]) {
      const a = asset(id, 'LOGO');
      if (a.type !== 'IMAGE' || a.width !== a.height || Number(a.width) < 128)
        invalid('Logo asset ' + String(id) + ' must be a square image of at least 128 x 128 pixels.');
    }
    for (const id of (op.brandAssets.landscapeLogoAsset ?? []) as unknown[]) {
      const a = asset(id, 'LANDSCAPE_LOGO');
      if (
        a.type !== 'IMAGE' ||
        typeof a.width !== 'number' ||
        typeof a.height !== 'number' ||
        Math.abs(a.width - 4 * a.height) > a.height * 0.04 ||
        a.width < 512 ||
        a.height < 128
      )
        invalid('Landscape logo asset ' + String(id) + ' must be a 4:1 image of at least 512 x 128 pixels.');
    }
  }
}
export function googleBrandGuidelinesImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!googleBrandGuidelinesKind(p)) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    campaigns = object(s.campaigns) ? s.campaigns : {};
  const rows = operations(p).map(op => {
    const c = object(campaigns[String(op.campaign)]) ? campaigns[String(op.campaign)] : {};
    return {
      campaign: op.campaign,
      name: c.name ?? null,
      status: c.status ?? null,
      serving: c.status === 'ENABLED',
      brand_assets: op.autoPopulateBrandAssets ? 'chosen by Google from top-performing assets' : op.brandAssets,
      ...(op.mainColor ? {main_color: op.mainColor, accent_color: op.accentColor} : {}),
      ...(op.fontFamily ? {font_family: op.fontFamily} : {}),
    };
  });
  return {
    provider: 'google',
    scope: 'pmax_brand_guidelines',
    campaigns: rows,
    irreversible: true,
    may_affect_serving: rows.some(r => r.serving),
    effect:
      'Links the business name and logos to each campaign instead of its asset groups, and applies the brand colors and font to automatically generated assets. Brand guidelines cannot be turned off again. Enabled campaigns serve with the new brand assets at once.',
    verification:
      'Reads each campaign again: brand guidelines enabled, the colors and font sent, and enabled campaign links of every brand asset sent (or at least one business name and logo when Google chooses them).',
    source: 'https://developers.google.com/google-ads/api/reference/rpc/v25/CampaignService/EnablePMaxBrandGuidelines',
  };
}
export function googleBrandGuidelinesOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const ops = operations(p),
    d = r.data;
  if (r.status !== 200 || !object(d) || !Array.isArray(d.results) || d.results.length !== ops.length) return false;
  return d.results.every(
    (v: unknown, i: number) =>
      object(v) &&
      v.campaign === ops[i]!.campaign &&
      (v.enablementError === undefined ||
        v.enablementError === null ||
        (object(v.enablementError) && !v.enablementError.code && !v.enablementError.message)),
  );
}
export function googleBrandGuidelinesVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const campaigns: JsonObject = {},
    links: JsonObject = {};
  for (const op of operations(p)) {
    const name = String(op.campaign);
    campaigns[name] = {
      enabled: true,
      ...(op.mainColor
        ? {mainColor: String(op.mainColor).toLowerCase(), accentColor: String(op.accentColor).toLowerCase()}
        : {}),
      ...(op.fontFamily ? {font: op.fontFamily} : {}),
    };
    if (object(op.brandAssets))
      links[name] = {
        BUSINESS_NAME: {[assetKey(String(op.brandAssets.businessNameAsset))]: true},
        LOGO: Object.fromEntries((op.brandAssets.logoAsset as string[]).map(a => [assetKey(a), true])),
        LANDSCAPE_LOGO: Object.fromEntries(
          ((op.brandAssets.landscapeLogoAsset ?? []) as string[]).map(a => [assetKey(a), true]),
        ),
      };
  }
  const read = googleBrandGuidelinesSnapshots(p)[0]!;
  return [
    {
      read,
      expected: {
        campaigns,
        links,
        autopopulated: Object.fromEntries(
          operations(p)
            .filter(o => o.autoPopulateBrandAssets)
            .map(o => [String(o.campaign), {business_name: true, logo: true}]),
        ),
      },
      id: read.googleBrandGuidelinesState!.campaigns.join(','),
    },
  ];
}
/** Colors compare without case; Google-chosen assets are checked for presence only. */
export function googleBrandGuidelinesObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const campaigns: JsonObject = {},
    autopopulated: JsonObject = {};
  for (const [name, c] of Object.entries(object(data.campaigns) ? data.campaigns : {})) {
    if (!object(c)) continue;
    campaigns[name] = {
      enabled: c.enabled,
      mainColor: typeof c.mainColor === 'string' ? c.mainColor.toLowerCase() : c.mainColor,
      accentColor: typeof c.accentColor === 'string' ? c.accentColor.toLowerCase() : c.accentColor,
      font: c.font,
    };
    const l = object(data.links) && object(data.links[name]) ? data.links[name] : {};
    autopopulated[name] = {
      business_name: Object.keys(l.BUSINESS_NAME ?? {}).length > 0,
      logo: Object.keys(l.LOGO ?? {}).length > 0,
    };
  }
  return {campaigns, links: object(data.links) ? data.links : {}, autopopulated};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleBrandGuidelinesFamily: ReviewedFamily = {
  name: 'google_pmax_brand_guidelines',
  files: ['src/google-pmax-brand-guidelines.ts', ['tests/google-pmax-brand-guidelines.test.mjs']],
  kind: googleBrandGuidelinesKind,
  assert: assertGoogleBrandGuidelines,
  scope: assertGoogleAdsScope,
  snapshots: googleBrandGuidelinesSnapshots,
  isRead: isGoogleBrandGuidelinesRead,
  reader: readGoogleBrandGuidelines,
  validateState: validateGoogleBrandGuidelinesState,
  prerequisites: googleBrandGuidelinesPrerequisites,
  impact: googleBrandGuidelinesImpact,
  outcome: googleBrandGuidelinesOutcome,
  verification: googleBrandGuidelinesVerification,
  observed: googleBrandGuidelinesObserved,
  spendConfirmation: {
    needed: googleBrandGuidelinesKind,
    message:
      'Brand guidelines change the brand assets of each campaign at once and cannot be turned off again. Review the campaigns and assets and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
};
