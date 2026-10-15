import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {applyExecutionRisk, bodyDeletion, bodyDeletionValues} from '../dist/src/execution-risk.js';
import {deliveryEditFields} from '../dist/src/spend-effects.js';
import {pinnedGoogleAdsVersion} from '../tools/google-bid-fields.mjs';

/**
 * WRT-02 stage D, the recurrence guard of the owner's deletion switch. A provider can delete through a body value on a
 * route that is not a DELETE (TikTok operation_status DELETE was the bypass the review found), so applyExecutionRisk
 * classifies those values from bodyDeletionValues (src/execution-risk.ts). This file holds that table against:
 *
 *   1. every pinned provider document: each writable enum field reachable from a request body whose values include a
 *      deletion value (DELETE, DELETED, REMOVE, REMOVED, *_DELETION, Delete, Deleted, Remove) must be classified in the
 *      table or exempted below with a reason, so a newly pinned version or document fails here until someone decides;
 *   2. the action ledger: every reviewed write route of a gateway in the table classifies each of its deletion values
 *      as destructive, and none of its other values;
 *   3. the Meta hypothesis the review left open (src/spend-effects.ts treats a Meta status DELETED update as spend
 *      neutral): it is spend neutral, and it is a deletion.
 *
 * CI metric: reviewed routes able to carry a deletion value that are not classified destructive. Target 0.
 */
const vendor = name => JSON.parse(fs.readFileSync('.mirror/VENDOR/' + name + '.json', 'utf8')).document;
const deletion = v =>
  typeof v === 'string' &&
  /^(?:[A-Z0-9]+_)*(?:DELETE|DELETED|DELETION|REMOVE|REMOVED)$|^(?:Delete|Deleted|Remove|Removed)$/.test(v);
const snake = k => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Writable enum fields of request bodies in a Discovery document (Google APIs). */
function discoveryFields(doc) {
  const refs = [],
    seen = new Set(),
    out = new Map();
  const methods = r => {
    for (const m of Object.values(r.methods ?? {})) if (m.request?.$ref) refs.push(m.request.$ref);
    for (const x of Object.values(r.resources ?? {})) methods(x);
  };
  methods(doc);
  const walk = name => {
    if (seen.has(name) || !doc.schemas?.[name]) return;
    seen.add(name);
    for (const [field, p] of Object.entries(doc.schemas[name].properties ?? {})) {
      if (p.readOnly === true || /^\s*Output only\./.test(p.description ?? '')) continue;
      for (const r of [p.$ref, p.items?.$ref, p.additionalProperties?.$ref]) if (r) walk(r);
      for (const v of p.enum ?? p.items?.enum ?? []) if (deletion(v)) note(out, field, v, name);
    }
  };
  for (const r of refs) walk(r);
  return out;
}
/** Writable enum fields of request bodies in an OpenAPI 3 document (Reddit, Criteo). */
function openApiFields(doc) {
  const seen = new Set(),
    out = new Map(),
    schema = ref => doc.components?.schemas?.[ref.split('/').at(-1)];
  const enums = (p, depth = 0) =>
    !p || typeof p !== 'object' || depth > 8
      ? []
      : p.$ref
        ? enums(schema(p.$ref), depth + 1)
        : [
            ...(p.enum ?? []),
            ...enums(p.items, depth + 1),
            ...['allOf', 'oneOf', 'anyOf'].flatMap(k => (p[k] ?? []).flatMap(x => enums(x, depth + 1))),
          ];
  const visit = (s, owner) => {
    if (!s || typeof s !== 'object') return;
    if (s.$ref) {
      if (seen.has(s.$ref)) return;
      seen.add(s.$ref);
      return visit(schema(s.$ref), s.$ref.split('/').at(-1));
    }
    for (const k of ['allOf', 'oneOf', 'anyOf']) for (const x of s[k] ?? []) visit(x, owner);
    visit(s.items, owner);
    if (typeof s.additionalProperties === 'object') visit(s.additionalProperties, owner);
    for (const [field, p] of Object.entries(s.properties ?? {})) {
      if (p.readOnly === true) continue;
      for (const v of enums(p)) if (deletion(v)) note(out, field, v, owner);
      visit(p, owner);
    }
  };
  for (const path of Object.values(doc.paths ?? {}))
    for (const [method, op] of Object.entries(path))
      if (['post', 'put', 'patch', 'delete'].includes(method))
        for (const c of Object.values(op?.requestBody?.content ?? {})) visit(c.schema, 'request body');
  return out;
}
/**
 * Elements of an XSD-as-JSON document (Microsoft Advertising SOAP services) typed by a simple type with a deletion
 * value. Its complex types inherit through xsi:type, so every complex type counts as reachable.
 */
function xsdFields(doc) {
  const out = new Map(),
    types = new Map();
  for (const [k, s] of Object.entries(doc.schemas ?? {}))
    if (k.startsWith('simpleType:'))
      types.set(
        k.slice('simpleType:'.length),
        [...JSON.stringify(s).matchAll(/"value":"([^"]+)"/g)].map(m => m[1]).filter(deletion),
      );
  const walk = (node, owner) => {
    if (!node || typeof node !== 'object') return;
    const t = node.attributes?.type;
    if (node.kind?.endsWith('}element') && types.get(t)?.length)
      for (const v of types.get(t)) note(out, node.attributes.name, v, owner);
    for (const c of node.children ?? []) walk(c, owner);
  };
  for (const [k, s] of Object.entries(doc.schemas ?? {})) if (k.startsWith('complexType:')) walk(s, k.split('}')[1]);
  return out;
}
function note(out, field, value, owner) {
  const key = snake(field) + '=' + value;
  if (!out.has(key)) out.set(key, new Set());
  out.get(key).add(owner);
}

const google = 'google-ads-' + pinnedGoogleAdsVersion();
/** Every pinned document: how it is read, and the gateway whose writes it describes. */
const documents = {
  [google]: ['discovery', 'google_ads_native_action'],
  'dv360-v4': ['discovery', 'dv360_native_action'],
  'ga4-admin-v1beta': ['discovery', 'ga4_native_action'],
  'ga4-data-v1alpha': ['discovery', 'ga4_native_action'],
  'ga4-data-v1beta': ['discovery', 'ga4_native_action'],
  'gtm-v2': ['discovery', 'gtm_native_action'],
  'search-console-v1': ['discovery', 'google_search_console_native_action'],
  'business-accounts-v1': ['discovery', 'google_business_native_action'],
  'business-info-v1': ['discovery', 'google_business_native_action'],
  'business-lodging-v1': ['discovery', 'google_business_native_action'],
  'business-notifications-v1': ['discovery', 'google_business_native_action'],
  'business-performance-v1': ['discovery', 'google_business_native_action'],
  'business-place-actions-v1': ['discovery', 'google_business_native_action'],
  'business-verifications-v1': ['discovery', 'google_business_native_action'],
  'reddit-v3': ['openapi', 'reddit_native_action'],
  'criteo-retail-2026-07': ['openapi', 'criteo_native_action'],
  'microsoft-campaign-management-v13': ['xsd', 'microsoft_ads_native_action'],
  'microsoft-customer-management-v13': ['xsd', 'microsoft_ads_native_action'],
  'microsoft-customer-billing-v13': ['xsd', 'microsoft_ads_native_action'],
  'microsoft-ad-insight-v13': ['xsd', 'microsoft_ads_native_action'],
  'microsoft-bulk-v13': ['xsd', 'microsoft_ads_native_action'],
};
/** Pinned files that describe no request body able to delete, and why. */
const notRequestDocuments = {
  'microsoft-reporting-v13':
    'Report requests are reads: its Deleted values are report filters (CampaignStatus, AdStatus, HowChanged ...) that select deleted entities to report on.',
  'microsoft-rest-v13':
    'An index of REST operation URLs and pages, with no schemas: the SOAP documents above carry them.',
  'lifecycle-pages': 'Hashes of provider release-note pages, not an API document.',
  'meta-currencies': 'Meta’s currency offsets (a table of money units, WRT-07), not an API document.',
};
/** Deletion values of pinned documents that are not deletions AMCP sends, each with its reason. */
const exempt = {
  ga4_native_action: {
    'action=DELETED':
      'A filter of properties.searchChangeHistoryEvents, a read: it selects change-history entries of deleted resources.',
  },
  criteo_native_action: {
    'type=Delete':
      'The JSON:API record type of POST .../catalog/merchants/{merchantId}/store-inventory/delete, a route the ledger does not map; its path, not this value, makes it a deletion.',
  },
  reddit_native_action: {
    'action_type=REMOVE':
      'Removes people from a customer-list audience: a membership change, governed like Google and Meta customer lists by the personal-data switch, not a resource deletion.',
  },
  microsoft_ads_native_action: {
    'action_type=Remove':
      'CustomerListUserData ActionType Remove takes people out of a customer list: a membership change, as for Reddit above.',
  },
};
const classified = (gateway, key) => {
  const [field, value] = key.split('=');
  return !!bodyDeletionValues[gateway]?.fields[field]?.includes(value);
};

test('every pinned provider document is swept or explained, so a newly pinned document cannot skip the guard', () => {
  const files = fs
    .readdirSync('.mirror/VENDOR')
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .sort();
  const unexplained = files.filter(f => !documents[f] && !notRequestDocuments[f]);
  assert.deepEqual(unexplained, [], 'Add each new pinned document to documents or notRequestDocuments.');
  for (const f of [...Object.keys(documents), ...Object.keys(notRequestDocuments)]) assert.ok(files.includes(f), f);
});

test('every deletion value a pinned request body can carry is classified destructive or exempted with a reason', () => {
  const unclassified = [],
    used = new Set();
  let swept = 0;
  for (const [file, [kind, gateway]] of Object.entries(documents)) {
    const doc = vendor(file),
      found = kind === 'discovery' ? discoveryFields(doc) : kind === 'openapi' ? openApiFields(doc) : xsdFields(doc);
    for (const [key, owners] of found) {
      swept++;
      if (classified(gateway, key)) continue;
      if (exempt[gateway]?.[key]) {
        used.add(gateway + ' ' + key);
        continue;
      }
      unclassified.push(gateway + ' ' + key + ' (' + file + ': ' + [...owners].slice(0, 3).join(', ') + ')');
    }
  }
  assert.deepEqual(
    unclassified,
    [],
    'Classify each in bodyDeletionValues (src/execution-risk.ts) or exempt it here with a reason.',
  );
  // An exemption whose value is gone from every pinned document is stale.
  const stale = Object.entries(exempt)
    .flatMap(([g, keys]) => Object.keys(keys).map(k => g + ' ' + k))
    .filter(k => !used.has(k));
  assert.deepEqual(stale, []);
  assert.ok(swept >= 12, 'the sweep found ' + swept + ' deletion values; expected the known ones at least');
  // The values the review named are among them and classified.
  for (const [gateway, key] of [
    ['google_ads_native_action', 'status=REMOVED'],
    ['google_ads_native_action', 'proposal_type=REMOVE'],
    ['dv360_native_action', 'entity_status=ENTITY_STATUS_SCHEDULED_FOR_DELETION'],
    ['reddit_native_action', 'configured_status=DELETED'],
    ['microsoft_ads_native_action', 'status=Deleted'],
  ])
    assert.ok(classified(gateway, key), gateway + ' ' + key);
});

test('the sweep flags an injected request field whose new value deletes, and ignores output-only fields', () => {
  const doc = {
    resources: {things: {methods: {mutate: {request: {$ref: 'Request'}}}}},
    schemas: {
      Request: {properties: {operations: {type: 'array', items: {$ref: 'Thing'}}}},
      Thing: {
        properties: {
          lifecycle: {type: 'string', enum: ['ACTIVE', 'PURGE_DELETED']},
          servingStatus: {type: 'string', enum: ['SERVING', 'REMOVED'], readOnly: true},
          status: {type: 'string', enum: ['ENABLED', 'REMOVED']},
        },
      },
    },
  };
  const found = [...discoveryFields(doc).keys()].sort();
  assert.deepEqual(found, ['lifecycle=PURGE_DELETED', 'status=REMOVED']);
  assert.deepEqual(
    found.filter(k => !classified('google_ads_native_action', k)),
    ['lifecycle=PURGE_DELETED'],
  );
});

test('every reviewed write route of a classified gateway treats each deletion value as destructive, and nothing else', () => {
  const registry = new Registry(),
    rows = actionContracts(registry).filter(
      r =>
        r.status === 'reviewed_write_family' &&
        bodyDeletionValues[r.gateway] &&
        r.path &&
        ['POST', 'PUT', 'PATCH'].includes(String(r.method).toUpperCase()),
    );
  const missed = [];
  let routes = 0;
  for (const r of rows) {
    routes++;
    const plan = body => ({
      gateway: r.gateway,
      accountId: '123',
      action: r.action,
      method: String(r.method).toUpperCase(),
      path: r.path.replace(/\{\+?[^}]+\}/g, '123'),
      headers: {},
      query: {},
      body,
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
      evidence: 'synthetic',
      warnings: [],
    });
    for (const [field, values] of Object.entries(bodyDeletionValues[r.gateway].fields))
      for (const value of values) {
        // Nested as providers send them: a record list, a JSON Patch operation and a REST.li $set patch.
        for (const body of [
          {[field]: value},
          {records: [{id: '1', [field]: value}]},
          {patch: {$set: {[field]: value}}},
        ]) {
          const p = plan(body);
          if (bodyDeletion(p) === undefined) {
            missed.push(r.gateway + ' ' + r.action + ' ' + JSON.stringify(body));
            continue;
          }
          // A family hook that refuses the synthetic body refuses the real request too; any answer must be destructive.
          let risk;
          try {
            risk = applyExecutionRisk(p);
          } catch {
            continue;
          }
          if (!risk.readOnly && risk.destructive !== true) missed.push(r.gateway + ' ' + r.action + ' ' + field);
        }
      }
    // Controls: a pause or an activation value is not a deletion by body value.
    for (const body of [{status: 'PAUSED'}, {operation_status: 'DISABLE'}, {configured_status: 'ACTIVE'}])
      assert.equal(bodyDeletion(plan(body)), undefined, r.action + ' ' + JSON.stringify(body));
  }
  assert.ok(routes > 50, 'reviewed write routes swept: ' + routes);
  assert.deepEqual(missed, [], 'reviewed routes able to carry a deletion value that are not classified destructive');
});

test('JSON Patch values and camelCase fields are read like the snake_case body', () => {
  const plan = (gateway, body, method = 'PATCH') => ({
    gateway,
    accountId: '123',
    action: 'synthetic',
    method,
    path: '/synthetic',
    headers: {},
    query: {},
    body,
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    evidence: 'synthetic',
    warnings: [],
  });
  assert.equal(
    bodyDeletion(plan('meta_native_action', [{op: 'replace', path: '/status', value: 'DELETED'}])),
    '/body/0/value',
  );
  assert.equal(
    bodyDeletion(plan('dv360_native_action', {entityStatus: 'ENTITY_STATUS_SCHEDULED_FOR_DELETION'})),
    '/body/entityStatus',
  );
  assert.equal(
    bodyDeletion(
      plan('google_ads_native_action', {mutateOperations: [{campaignOperation: {remove: 'customers/1/campaigns/2'}}]}),
    ),
    '/body/mutateOperations/0/campaignOperation/remove',
  );
  assert.equal(bodyDeletion(plan('meta_native_action', {status: 'ARCHIVED'})), undefined);
  // A read never deletes, whatever its filters name.
  assert.equal(
    applyExecutionRisk({...plan('reddit_native_action', {configured_status: 'DELETED'}, 'GET'), readOnly: true})
      .destructive,
    false,
  );
});

test('the open Meta hypothesis: a status DELETED update is spend neutral and still a deletion', () => {
  const plan = {
    gateway: 'meta_native_action',
    accountId: '123',
    action: 'meta_campaign_id_update',
    method: 'POST',
    path: '/v26.0/120000000000001',
    headers: {},
    query: {},
    body: {status: 'DELETED'},
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    evidence: 'synthetic',
    warnings: [],
  };
  // Neutral for spending: no delivery field changes (src/spend-effects.ts meta_entities).
  assert.deepEqual(deliveryEditFields(plan)?.fields, []);
  // A deletion for the owner policy: allow_deletion:false refuses it.
  assert.equal(applyExecutionRisk(plan).destructive, true);
  assert.equal(bodyDeletion(plan), '/body/status');
  assert.equal(applyExecutionRisk({...plan, body: {status: 'PAUSED'}}).destructive, false);
});
