import type {CompiledRequest, JsonObject} from './types.js';
import {reviewedWriteFamily} from './reviewed-routes.js';

/**
 * Structural spending and delivery effects of reviewed edits, decided from the request shape rather than its text.
 *
 * The generic check in preflight.ts matches field names containing "budget", "bid" or "spend" and string ACTIVE
 * statuses in the serialized request. Bid targets (Google Ads targetCpaMicros and targetRoas, LinkedIn unitCost),
 * pacing (DV360 pacing.dailyMaxMicros), schedules (end dates), targeting and optimization goals change what an existing
 * entity buys and spends without matching that text. ProtoJSON also lets the Google Ads API accept an enum number,
 * so `status: 2` (ENABLED) never read as activation.
 *
 * The delivery rule covers the entities that hold budgets, bids, schedules, targeting and optimization: campaigns,
 * campaign groups, insertion orders, ad sets, ad groups, ad squads and line items. Ads, creatives and assets are content;
 * their activation is still read by the status checks, and creative edits carry their own impact disclosure.
 *
 * Both checks here only ever add a confirmation; neither removes one that another rule requires.
 */

type Json = JsonObject;
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const maxDepth = 64;

/** Every activation field of activationFields in spend-policy.ts, compared in snake_case. */
const statusFields = new Set(['status', 'entity_status', 'intended_status', 'operation_status', 'configured_status']);

/**
 * Paths of status fields that carry a number instead of an enum name. A number cannot be shown to leave an entity
 * paused (Google Ads CampaignStatus 2 is ENABLED), so a caller must name the status or confirm the spending effect.
 */
export function numericStatusPaths(plan: CompiledRequest): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > maxDepth) {
      out.push(path || '/');
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, path + '/' + i, depth + 1));
      return;
    }
    if (!object(v)) return;
    // JSON Patch: {op, path: '/status', value: 2}, in any key order.
    if (typeof v.path === 'string' && Object.hasOwn(v, 'value')) {
      const leaf = snake(v.path.split('/').at(-1) ?? '');
      if (statusFields.has(leaf) && typeof v.value === 'number') out.push(path + '/value');
    }
    for (const [k, x] of Object.entries(v)) {
      if (statusFields.has(snake(k)) && typeof x === 'number') out.push(path + '/' + k);
      else walk(x, path + '/' + k, depth + 1);
    }
  };
  walk({query: plan.query, body: plan.body}, '', 0);
  return out;
}

/**
 * A generic entity family and how its update requests name the fields they change. `neutral` lists the fields that
 * cannot start, widen or price delivery: `true` for any value (names and identifiers), or the exact enum names that
 * pause, archive or remove. Anything else, including an unknown field, counts as a delivery edit (fail closed).
 */
interface GenericFamily {
  entity: string;
  neutral: Record<string, true | readonly string[]>;
  /** The changed records (field → value) of an update of existing entities, or undefined for creates and deletes. */
  edits(plan: CompiledRequest): Json[] | undefined;
}

const keysOf = (v: unknown): Json => (object(v) ? v : {});
/** Top-level field of each comma-separated update-mask path, in snake_case. */
const maskFields = (mask: unknown): string[] =>
  typeof mask === 'string' && mask ? mask.split(',').map(m => snake(m.trim().split('.')[0] ?? '')) : [];
/** A record with each masked field present, so a masked field without a value still counts as changed. */
const withMask = (record: Json, mask: unknown): Json => {
  const out: Json = {...record};
  for (const field of maskFields(mask)) if (!Object.keys(out).some(k => snake(k) === field)) out[field] = undefined;
  return out;
};

const genericFamilies: Record<string, GenericFamily> = {
  // Google Ads API v23 campaigns, ad groups and campaign budgets :mutate. CampaignStatus / AdGroupStatus: ENABLED,
  // PAUSED, REMOVED (pinned google-ads-v23 Discovery).
  google_entities: {
    entity: 'Google Ads campaign, ad group or budget',
    neutral: {resource_name: true, name: true, status: ['PAUSED', 'REMOVED']},
    edits: p => {
      const operations = keysOf(p.body).operations;
      if (!/\/(campaigns|adGroups|campaignBudgets):mutate$/.test(p.path) || !Array.isArray(operations)) return;
      const updates = operations
        .filter(op => object(op) && op.update !== undefined)
        .map(op => withMask(keysOf(op.update), op.updateMask ?? op.update_mask));
      return updates.length ? updates : undefined;
    },
  },
  // Graph API POST /{campaign_id|ad_set_id} updates the fields it names. Status: ACTIVE, PAUSED, DELETED, ARCHIVED.
  meta_entities: {
    entity: 'Meta campaign or ad set',
    neutral: {name: true, status: ['PAUSED', 'ARCHIVED', 'DELETED']},
    edits: p => (/^meta_(campaign_id|ad_set_id)_update$/.test(p.action) ? [keysOf(p.body)] : undefined),
  },
  // TikTok v1.3 /campaign|adgroup/update/ carry the identifiers and the fields to change. Status changes use
  // /status/update/ with operation_status, which the generic check already reads.
  tiktok_entities: {
    entity: 'TikTok campaign or ad group',
    neutral: {
      advertiser_id: true,
      campaign_id: true,
      adgroup_id: true,
      campaign_name: true,
      adgroup_name: true,
    },
    edits: p => (/^\/v1\.3\/(campaign|adgroup)\/update\/$/.test(p.path) ? [keysOf(p.body)] : undefined),
  },
  // LinkedIn REST.li: PARTIAL_UPDATE POSTs a {patch:{$set, $delete}}; PUT and PATCH replace or patch the entity.
  // Campaign and campaign group status: ACTIVE, PAUSED, ARCHIVED, COMPLETED, CANCELED, DRAFT, ….
  linkedin_entities: {
    entity: 'LinkedIn campaign or campaign group',
    neutral: {name: true, status: ['PAUSED', 'ARCHIVED', 'DRAFT', 'CANCELED']},
    edits: p => {
      if (!/^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups)\/[^/]+$/.test(p.path)) return;
      if (!['POST', 'PUT', 'PATCH'].includes(p.method)) return;
      const body = keysOf(p.body);
      if (!object(body.patch)) return [body];
      const record: Json = {};
      const collect = (patch: Json) => {
        for (const [k, v] of Object.entries(patch)) {
          if (k === '$set') Object.assign(record, keysOf(v));
          else if (k === '$delete') for (const f of Array.isArray(v) ? v : [v]) record[String(f)] = undefined;
          else record[k] = v; // A nested patch of a field changes that field.
        }
      };
      collect(body.patch);
      return [record];
    },
  },
  // X Ads v12 PUT /accounts/{id}/campaigns|line_items/{id} update the body fields. entity_status: ACTIVE, DRAFT, PAUSED.
  x_entities: {
    entity: 'X campaign or line item',
    neutral: {name: true, entity_status: ['PAUSED', 'DRAFT']},
    edits: p =>
      p.method === 'PUT' && /^\/12\/accounts\/[^/]+\/(campaigns|line_items)\/[^/]+$/.test(p.path)
        ? [keysOf(p.body)]
        : undefined,
  },
  // DV360 v4 PATCH …/campaigns|insertionOrders|lineItems/{id}?updateMask=: EntityStatus (pinned dv360-v4 Discovery).
  dv360_entities: {
    entity: 'DV360 campaign, insertion order or line item',
    neutral: {
      display_name: true,
      entity_status: ['ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_ARCHIVED', 'ENTITY_STATUS_DRAFT'],
    },
    edits: p =>
      p.method === 'PATCH' && /\/(campaigns|insertionOrders|lineItems)\/[^/]+$/.test(p.path)
        ? [withMask(keysOf(p.body), p.query.updateMask)]
        : undefined,
  },
  // Snapchat PUT /adaccounts/{id}/campaigns|adsquads replaces whole records; PATCH …/{id} applies JSON Patch operations.
  // The nested /campaigns/{id}/adsquads and /adsquads/{id}/ads updates always need confirmation (preflight.ts).
  snapchat_entities: {
    entity: 'Snapchat campaign or ad squad',
    neutral: {id: true, ad_account_id: true, name: true, status: ['PAUSED']},
    edits: p => {
      if (!/^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads)(?:\/[^/]+)?$/.test(p.path)) return;
      if (p.method === 'PATCH' && Array.isArray(p.body))
        return p.body.map((op: unknown) => {
          const o = keysOf(op);
          return o.op === 'test' || typeof o.path !== 'string' ? {} : {[o.path.split('/').at(-1)!]: o.value};
        });
      if (p.method !== 'PUT') return;
      const kind = p.path.split('/').at(-1)!,
        rows = keysOf(p.body)[kind];
      return Array.isArray(rows) ? rows.map(keysOf) : [keysOf(p.body)];
    },
  },
};

/**
 * Fields of a generic entity update that may change what an existing entity serves, bids or spends, in snake_case.
 * Empty when every changed field is on the family's neutral list; undefined when the request is not such an update.
 */
export function deliveryEditFields(plan: CompiledRequest): {entity: string; fields: string[]} | undefined {
  if (plan.readOnly) return;
  const family = genericFamilies[reviewedWriteFamily(plan) ?? ''];
  const edits = family?.edits(plan);
  if (!family || !edits) return;
  const fields = new Set<string>();
  for (const record of edits)
    for (const [key, value] of Object.entries(record)) {
      const field = snake(key),
        neutral = family.neutral[field];
      if (neutral === true) continue;
      if (Array.isArray(neutral) && typeof value === 'string' && neutral.includes(value)) continue;
      fields.add(field);
    }
  return {entity: family.entity, fields: [...fields].sort()};
}
