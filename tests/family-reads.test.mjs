import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parsers} from 'prettier/plugins/babel';
import {Registry} from '../dist/src/catalog.js';
import {reviewedFamilies} from '../dist/src/reviewed-families.js';
import {readOf, stateReadOf} from '../dist/src/family-kit.js';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';

// ARC-04 stage C (the review's readsFor): every reviewed family builds its state reads with the family kit. Each
// builder the family modules had copied is transcribed below as it was written, by layout (what it cleared, what it
// set before its own members, the order it wrote them in), with the families that had it. Loading the catalog first
// evaluates the registry, as entry points do.
new Registry();
// The state keys of the X catalog families, which their shared read clears (src/x-catalogs.ts).
const catalogStates = ['xCatalogState', 'xProductSetState', 'xScheduledFeedState', 'xCatalogProductState'];

/**
 * A family's builder, as its modules had written it, and the kit call that replaced it. `copied` and `kit` take the
 * request and the values the builder varied (`v`: action, path, query, body, headers, before and family fields).
 */
const layouts = {
  // The kit's own layout: TikTok, Snapchat, Meta, X, DV360, Business Profile edits, measurement verification reads.
  'GET, both cleared': {
    families: ['tiktok_audience_edits', 'snapchat_custom_conversions', 'meta_pixels', 'x_entity_batches'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'GET',
      path: v.path,
      query: v.query,
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
      ...v.fields,
    }),
    kit: (p, v) => stateReadOf(p, v.action, v.path, v.query, v.fields),
  },
  // The path before the action (DV360 targeting and lists, X creatives, GTM workflow reads); the action before the
  // method (X targeting, Reddit creatives, with the headers before the body).
  'GET, both cleared, path first': {
    families: ['dv360_line_item_targeting', 'dv360_lists', 'x_creatives'],
    copied: (p, v) => ({
      ...p,
      path: v.path,
      action: v.action,
      method: 'GET',
      query: v.query,
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
      ...v.fields,
    }),
    kit: (p, v) => stateReadOf(p, v.action, v.path, v.query, v.fields),
  },
  'GET, both cleared, headers before the body': {
    families: ['reddit_creatives'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      path: v.path,
      method: 'GET',
      query: v.query,
      headers: {},
      body: undefined,
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
      ...v.fields,
    }),
    kit: (p, v) => stateReadOf(p, v.action, v.path, v.query, v.fields),
  },
  // Google Ads searches: the query posted to googleAds:search; most kept the request's special transport.
  'POST search, response controls cleared': {
    families: ['google_bid_modifiers', 'google_experiments', 'google_user_access', 'google_customer_labels'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'POST',
      path: v.path,
      body: v.body,
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      ...v.fields,
    }),
    kit: (p, v) =>
      readOf(
        p,
        {action: v.action, method: 'POST', path: v.path, body: v.body, query: {}, clears: ['responseControls']},
        v.fields,
      ),
  },
  'POST search, both cleared': {
    families: ['google_asset_links', 'google_listing_groups', 'google_configuration', 'google_atomic_builds'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'POST',
      path: v.path,
      query: {},
      body: v.body,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
      ...v.fields,
    }),
    kit: (p, v) => readOf(p, {action: v.action, method: 'POST', path: v.path, query: {}, body: v.body}, v.fields),
  },
  // The customer currency read of a create, which cleared neither (Google targeting wrote the headers last).
  'POST search, nothing cleared': {
    families: ['google_asset_links', 'google_configuration', 'google_targeting'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'POST',
      path: v.path,
      query: {},
      body: v.body,
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      headers: {},
    }),
    kit: (p, v) => readOf(p, {action: v.action, method: 'POST', path: v.path, query: {}, body: v.body, clears: []}),
  },
  // Data Manager: a Google Ads search that never carries the request's people or its upload host.
  'POST search, origin and people cleared first': {
    families: ['google_customer_match', 'google_offline_conversions'],
    copied: (p, v) => ({
      ...p,
      origin: undefined,
      personalData: undefined,
      action: v.action,
      method: 'POST',
      path: v.path,
      body: v.body,
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
    }),
    kit: (p, v) =>
      readOf(p, {
        before: {origin: undefined, personalData: undefined},
        action: v.action,
        method: 'POST',
        path: v.path,
        body: v.body,
        query: {},
        clears: ['responseControls'],
      }),
  },
  'GET, its host, no people and a marker first': {
    families: ['google_customer_match', 'google_offline_conversions'],
    copied: (p, v) => ({
      ...p,
      origin: v.origin,
      personalData: undefined,
      dataManagerRead: 'status',
      action: v.action,
      method: 'GET',
      path: v.path,
      query: v.query,
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
    }),
    kit: (p, v) =>
      readOf(p, {
        before: {origin: v.origin, personalData: undefined, dataManagerRead: 'status'},
        action: v.action,
        path: v.path,
        query: v.query,
        clears: ['responseControls'],
      }),
  },
  // Criteo searches post a body when they have one; the reads keep the repeated query encoding.
  'GET or POST, both cleared': {
    families: ['criteo_audience_segments', 'criteo_creatives'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: v.body ? 'POST' : 'GET',
      path: v.path,
      query: v.query,
      body: v.body,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
      ...v.fields,
    }),
    kit: (p, v) =>
      readOf(
        p,
        {action: v.action, method: v.body ? 'POST' : 'GET', path: v.path, query: v.query, body: v.body},
        v.fields,
      ),
  },
  // Reads that kept the special transport: Snapchat media and targeting specs, X and TikTok report jobs, Meta insights,
  // Criteo campaigns and reports (no confirmation before not destructive).
  'GET, response controls cleared': {
    families: ['snapchat_claim_media', 'snapchat_nested_updates', 'x_report_jobs', 'tiktok_report_jobs'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'GET',
      path: v.path,
      query: v.query,
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      ...v.fields,
    }),
    kit: (p, v) => readOf(p, {action: v.action, path: v.path, query: v.query, clears: ['responseControls']}, v.fields),
  },
  'GET, response controls cleared, the method after the body': {
    families: ['meta_insights_jobs', 'criteo_campaigns', 'criteo_report_jobs', 'tiktok_report_jobs'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      path: v.path,
      query: v.query,
      body: undefined,
      method: 'GET',
      headers: {},
      readOnly: true,
      requiresConfirmation: false,
      destructive: false,
      responseControls: undefined,
      ...v.fields,
    }),
    kit: (p, v) => readOf(p, {action: v.action, path: v.path, query: v.query, clears: ['responseControls']}, v.fields),
  },
  // LinkedIn reads send the request's version headers; some kept the special transport.
  'GET with headers, both cleared': {
    families: ['linkedin_ab_tests', 'linkedin_insight_tags', 'linkedin_lead_forms', 'linkedin_dsc_edits'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'GET',
      path: v.path,
      query: v.query,
      body: undefined,
      headers: v.headers,
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
      ...v.fields,
    }),
    kit: (p, v) => readOf(p, {action: v.action, path: v.path, query: v.query, headers: v.headers}, v.fields),
  },
  'GET with headers, response controls cleared': {
    families: ['linkedin_conversion_links', 'linkedin_message_ads', 'linkedin_tracking_parameters'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'GET',
      path: v.path,
      query: v.query,
      body: undefined,
      headers: v.headers,
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      ...v.fields,
    }),
    kit: (p, v) =>
      readOf(
        p,
        {action: v.action, path: v.path, query: v.query, headers: v.headers, clears: ['responseControls']},
        v.fields,
      ),
  },
  'GET with headers last, response controls cleared': {
    families: ['linkedin_audience_templates'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'GET',
      path: v.path,
      query: v.query,
      body: undefined,
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      headers: v.headers,
      responseControls: undefined,
      ...v.fields,
    }),
    kit: (p, v) =>
      readOf(
        p,
        {action: v.action, path: v.path, query: v.query, headers: v.headers, clears: ['responseControls']},
        v.fields,
      ),
  },
  'GET with headers, nothing cleared': {
    families: ['linkedin_dsc'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      path: v.path,
      method: 'GET',
      body: undefined,
      query: v.query,
      headers: v.headers,
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
    }),
    kit: (p, v) => readOf(p, {action: v.action, path: v.path, query: v.query, headers: v.headers, clears: []}),
  },
  // Meta graph reads set the family's state and page first.
  'GET, family fields first, both cleared': {
    families: [
      'meta_ad_rules',
      'meta_catalog_products',
      'meta_product_catalogs',
      'meta_product_feeds',
      'meta_product_sets',
    ],
    copied: (p, v) => ({
      ...p,
      ...v.before,
      action: v.action,
      method: 'GET',
      path: v.path,
      query: v.query,
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
    }),
    kit: (p, v) => readOf(p, {before: v.before, action: v.action, path: v.path, query: v.query}),
  },
  'GET, no people and the state first, both cleared': {
    families: ['meta_customer_lists', 'meta_offline_conversions'],
    copied: (p, v) => ({
      ...p,
      personalData: undefined,
      metaListState: v.state,
      action: v.action,
      method: 'GET',
      path: v.path,
      query: v.query,
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
    }),
    kit: (p, v) =>
      readOf(p, {
        before: {personalData: undefined, metaListState: v.state},
        action: v.action,
        path: v.path,
        query: v.query,
      }),
  },
  // Apple reads the account a shared budget names; the special transport cleared first.
  'GET, its account first, special transport cleared first': {
    families: ['apple_entities'],
    copied: (p, v) => ({
      ...p,
      accountId: v.account,
      action: v.action,
      method: 'GET',
      path: v.path,
      query: {},
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      specialTransport: undefined,
      responseControls: undefined,
    }),
    kit: (p, v) =>
      readOf(p, {
        before: {accountId: v.account},
        action: v.action,
        path: v.path,
        query: {},
        clears: ['specialTransport', 'responseControls'],
      }),
  },
  'GET, its account first, response controls cleared': {
    families: ['snapchat_media_copy'],
    copied: (p, v) => ({
      ...p,
      accountId: v.account,
      action: v.action,
      method: 'GET',
      path: v.path,
      query: {},
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      ...v.fields,
    }),
    kit: (p, v) =>
      readOf(
        p,
        {before: {accountId: v.account}, action: v.action, path: v.path, query: {}, clears: ['responseControls']},
        v.fields,
      ),
  },
  // GTM reads and the Reddit post verification cleared the special transport first.
  'GET, special transport cleared first': {
    families: ['gtm_workflows', 'gtm_workspace', 'reddit_creatives'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      path: v.path,
      method: 'GET',
      query: v.query,
      body: undefined,
      headers: {},
      readOnly: true,
      requiresConfirmation: false,
      destructive: false,
      specialTransport: undefined,
      responseControls: undefined,
      ...v.fields,
    }),
    kit: (p, v) =>
      readOf(
        p,
        {action: v.action, path: v.path, query: v.query, clears: ['specialTransport', 'responseControls']},
        v.fields,
      ),
  },
  // Business Profile reads go to another host; the access read binds the grant's account.
  'GET, its host, response controls cleared': {
    families: ['google_business_notifications', 'google_place_actions'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      origin: v.origin,
      method: 'GET',
      path: v.path,
      query: v.query,
      body: undefined,
      headers: {},
      readOnly: true,
      requiresConfirmation: false,
      destructive: false,
      responseControls: undefined,
    }),
    kit: (p, v) =>
      readOf(p, {
        before: {origin: v.origin},
        action: v.action,
        path: v.path,
        query: v.query,
        clears: ['responseControls'],
      }),
  },
  'GET, its host, the grant account after the headers': {
    families: ['google_business_access'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'GET',
      origin: v.origin,
      path: v.path,
      query: v.query,
      body: undefined,
      headers: {},
      accountId: v.account,
      readOnly: true,
      requiresConfirmation: false,
      destructive: false,
      responseControls: undefined,
    }),
    kit: (p, v) =>
      readOf(
        p,
        {before: {origin: v.origin}, action: v.action, path: v.path, query: v.query, clears: []},
        {accountId: v.account, responseControls: undefined},
      ),
  },
  // The lodging reads spread a shared base, then set the action, their host, the path and the query.
  'GET from a shared base, the host after the cleared fields': {
    families: ['google_business_lodging'],
    copied: (p, v) => {
      const base = {
        ...p,
        method: 'GET',
        body: undefined,
        headers: {},
        readOnly: true,
        destructive: false,
        requiresConfirmation: false,
        responseControls: undefined,
        specialTransport: undefined,
      };
      return {
        ...base,
        action: v.action,
        origin: v.origin,
        path: v.path,
        query: v.query,
        businessLodgingRead: 'lodging',
      };
    },
    kit: (p, v) => stateReadOf(p, v.action, v.path, v.query, {origin: v.origin, businessLodgingRead: 'lodging'}),
  },
  'GET, its host after the path, both cleared': {
    families: ['ga4_export_jobs', 'gtm_entities', 'search_console_sites'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'GET',
      path: v.path,
      origin: v.origin,
      query: {},
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
    }),
    kit: (p, v) => readOf(p, {before: {origin: v.origin}, action: v.action, path: v.path, query: {}}),
  },
  // Reddit's own reads cleared neither write-only field.
  'GET, nothing cleared': {
    families: ['reddit_classic'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      path: v.path,
      method: 'GET',
      body: undefined,
      query: v.query,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      ...v.fields,
    }),
    kit: (p, v) => readOf(p, {action: v.action, path: v.path, query: v.query, clears: []}, v.fields),
  },
  // The builders of the provider modules family modules import (familyHelpers below). google_configuration's feed
  // searches (src/google-asset-set-writes.ts) wrote the headers before the query and the body, and reset the family's
  // state before clearing both write-only fields: the kit's `after`.
  'POST search, the family state reset before both cleared': {
    families: ['google_configuration'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      method: 'POST',
      path: v.path,
      headers: {},
      query: {},
      body: v.body,
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      ...v.fields,
      responseControls: undefined,
      specialTransport: undefined,
    }),
    kit: (p, v) =>
      readOf(p, {action: v.action, method: 'POST', path: v.path, query: {}, body: v.body, after: v.fields}),
  },
  // Its keyword plan searches (src/google-keyword-plan-writes.ts): the path before the method, the body before the query.
  'POST search, the path before the method, both cleared': {
    families: ['google_configuration'],
    copied: (p, v) => ({
      ...p,
      action: v.action,
      path: v.path,
      method: 'POST',
      body: v.body,
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
      ...v.fields,
    }),
    kit: (p, v) => readOf(p, {action: v.action, method: 'POST', path: v.path, query: {}, body: v.body}, v.fields),
  },
  // The X catalog families' shared read (src/x-catalogs.ts xCatalogRead): the tags of the account or catalog just read,
  // then every catalog family's state key, set one by one after the literal.
  'GET, both cleared, the catalog tags and every catalog state': {
    families: ['x_catalog_products', 'x_product_catalogs', 'x_product_sets', 'x_scheduled_feeds'],
    copied: (p, v) => {
      const r = {
        ...p,
        action: v.action,
        method: 'GET',
        path: v.path,
        query: v.query,
        body: undefined,
        headers: {},
        readOnly: true,
        destructive: false,
        requiresConfirmation: false,
        responseControls: undefined,
        specialTransport: undefined,
        xCatalogUser: v.tag.xCatalogUser,
        xCatalogId: v.tag.xCatalogId,
      };
      for (const k of catalogStates) r[k] = undefined;
      return r;
    },
    kit: (p, v) =>
      stateReadOf(p, v.action, v.path, v.query, {
        xCatalogUser: v.tag.xCatalogUser,
        xCatalogId: v.tag.xCatalogId,
        ...Object.fromEntries(catalogStates.map(k => [k, undefined])),
      }),
  },
};

// The members CompiledRequest requires; a compiled request carries all of them (src/compiler.ts sets each).
const required = {
  gateway: 'x_ads_native_action',
  action: 'x_write',
  method: 'PUT',
  path: '/12/accounts/a1/x',
  query: {q: 'write'},
  headers: {'X-Synthetic': '1', 'LinkedIn-Version': '202609'},
  readOnly: false,
  destructive: true,
  requiresConfirmation: true,
  evidence: 'INDEPENDENT_DESIGN',
  warnings: [],
};
// What a request may carry, and a family's own field: every subset of them is a request a read may be built from.
const optional = {
  body: {name: 'Renamed'},
  origin: 'https://write.example.test',
  accountId: 'a1',
  responseControls: {fields: ['id']},
  specialTransport: 'upload',
  queryArrayEncoding: 'json',
  personalData: {count: 2},
  scopeContext: {campaignId: '9'},
  metaListState: {kind: 'write'},
  // A state key a family read clears, which the request carries already (an X catalog family's own).
  xCatalogState: {kind: 'write'},
};
function* requests() {
  const keys = Object.keys(optional);
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const p = {...required};
    keys.forEach((key, bit) => {
      if (mask & (1 << bit)) p[key] = optional[key];
    });
    yield p;
  }
}
// The values a builder varied: two sets, so a member taken from the wrong value would show.
const values = [
  {
    action: 'AMCP_FAMILY_READ',
    path: '/v1/read',
    query: {fields: 'id'},
    body: {query: 'SELECT a FROM b'},
    headers: {'LinkedIn-Version': '202609', 'X-Restli-Protocol-Version': '2.0.0'},
    before: {metaRuleState: undefined, metaRulePage: {object: 'rule'}},
    fields: {familyState: undefined, familyPage: true},
    origin: 'https://read.example.test',
    account: 'shared-7',
    state: {pixel: '3'},
    tag: {xCatalogUser: '1200', xCatalogId: '77'},
  },
  {
    action: 'AMCP_STATE_OPTIONAL',
    path: '/v2/other',
    query: {},
    body: undefined,
    headers: {},
    before: {metaCatalogState: {kind: 'read'}, metaCatalogPage: undefined},
    fields: {queryArrayEncoding: 'repeat', scopeContext: undefined, familyState: {ids: ['1']}},
    origin: undefined,
    account: undefined,
    state: undefined,
    tag: {},
  },
];

test('the kit builds the read each family builder had written: the same keys, values and order for every request', () => {
  let compared = 0;
  for (const [name, layout] of Object.entries(layouts))
    for (const p of requests())
      for (const v of values) {
        // Object.entries compares the keys, their values and their order (deepEqual alone ignores the order).
        assert.deepEqual(Object.entries(layout.kit(p, v)), Object.entries(layout.copied(p, v)), name);
        compared++;
      }
  assert.equal(compared, Object.keys(layouts).length * (1 << Object.keys(optional).length) * values.length);
  // Every layout names families that are registered.
  const registered = new Set(reviewedFamilies().map(f => f.name));
  for (const [name, layout] of Object.entries(layouts))
    for (const family of layout.families) assert.ok(registered.has(family), name + ': ' + family);
});

test('readOf leaves the request untouched and builds a new read each time', () => {
  const p = {...required, body: {a: 1}, specialTransport: 'upload'},
    copy = structuredClone(p);
  const first = readOf(p, {action: 'AMCP_R', path: '/r', query: {}}),
    second = readOf(p, {action: 'AMCP_R', path: '/r', query: {}});
  assert.deepEqual(p, copy);
  assert.notEqual(first, second);
  assert.notEqual(first.headers, second.headers);
  assert.deepEqual(
    [first.readOnly, first.destructive, first.requiresConfirmation, first.method, first.body, first.specialTransport],
    [true, false, false, 'GET', undefined, undefined],
  );
  // A family field overrides what the kit set, as the builders' own members did when they came last.
  assert.equal(readOf(p, {action: 'AMCP_R', path: '/r', query: {}}, {headers: {'X-A': '1'}}).headers['X-A'], '1');
  // `after` comes after the read's own members and before the fields it clears; `fields` still come last.
  const lacking = {...required},
    keys = Object.keys(readOf(lacking, {action: 'AMCP_R', path: '/r', query: {}, after: {googleState: undefined}}));
  assert.deepEqual(keys.slice(-4), ['body', 'googleState', 'responseControls', 'specialTransport']);
});

const familyModules = () => [...new Set(reviewedFamilies().flatMap(f => f.files[0].split(' / ')))].sort();
/**
 * The provider modules family modules import, directly or through one another (a family's helpers: the searches of
 * google_configuration in src/google-asset-set-writes.ts and src/google-keyword-plan-writes.ts, the X catalog
 * families' shared read in src/x-catalogs.ts), from the compiled import graph.
 */
function familyHelpers() {
  const graph = runtimeGraph('.'),
    modules = new Set(familyModules()),
    helpers = new Set(),
    queue = [...modules];
  while (queue.length)
    for (const to of graph.get(queue.shift()) ?? [])
      if (!modules.has(to) && !helpers.has(to) && isProviderModule(to) && !providerRegistries.includes(to)) {
        helpers.add(to);
        queue.push(to);
      }
  return [...helpers].sort();
}
// A helper whose literals are no family's reads: X's audience estimate read tool, whose plan keeps the request it
// classifies and whose reference reads are its own (x_targeting_batch imports only its criteria types).
const notFamilyReads = new Set(['src/x-audience-estimate.ts']);
/** The modules that build families' reads: the family modules and their helpers. */
const readModules = () => [...familyModules(), ...familyHelpers().filter(file => !notFamilyReads.has(file))];
const programOf = file => parsers['babel-ts'].parse(fs.readFileSync(file, 'utf8'), {filepath: file}).program;
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'comments'].includes(key)) continue;
    if (Array.isArray(child)) child.forEach(c => walk(c, visit));
    else if (child && typeof child === 'object') walk(child, visit);
  }
}
const keyOf = p => (p.type === 'ObjectProperty' && !p.computed ? (p.key.name ?? p.key.value) : undefined);

test('every family read builder is the kit: no family module or helper spreads a request into a read of its own', () => {
  assert.ok(familyModules().length >= 160);
  // The helpers whose builders moved onto the kit are among them, and the one exemption is a helper too.
  const helpers = familyHelpers();
  for (const file of ['src/google-asset-set-writes.ts', 'src/google-keyword-plan-writes.ts', 'src/x-catalogs.ts'])
    assert.ok(helpers.includes(file), file);
  for (const file of notFamilyReads) assert.ok(helpers.includes(file), file);
  const copies = [];
  for (const file of readModules())
    walk(programOf(file), node => {
      if (node.type !== 'ObjectExpression') return;
      const readOnly = node.properties.some(
        p => keyOf(p) === 'readOnly' && p.value?.type === 'BooleanLiteral' && p.value.value === true,
      );
      if (readOnly && node.properties.some(p => p.type === 'SpreadElement'))
        copies.push(file + ':' + fs.readFileSync(file, 'utf8').slice(0, node.start).split('\n').length);
    });
  assert.deepEqual(copies, [], 'build these reads with readOf or stateReadOf from src/family-kit.ts');
});

test('every write-only field order a family clears is one the layouts above cover', () => {
  const covered = new Set(['', 'responseControls', 'specialTransport,responseControls']);
  let calls = 0;
  for (const file of readModules())
    walk(programOf(file), node => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return;
      if (node.callee.name === 'stateReadOf') calls++;
      if (node.callee.name !== 'readOf') return;
      calls++;
      const [, read] = node.arguments;
      assert.equal(read?.type, 'ObjectExpression', file + ': readOf takes its read as an object literal');
      const clears = read.properties.find(p => keyOf(p) === 'clears');
      if (!clears) return;
      assert.equal(clears.value.type, 'ArrayExpression', file);
      const order = clears.value.elements.map(e => e.value).join(',');
      assert.ok(covered.has(order), file + ' clears ' + order);
    });
  assert.ok(calls >= 140, 'kit read calls: ' + calls);
});
