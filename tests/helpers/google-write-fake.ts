import {Registry} from '../../src/catalog.js';
import {Store} from '../../src/store.js';
import {MirrorService} from '../../src/service.js';
import {NativeTransport} from '../../src/transport.js';
import type {Actor, JsonObject} from '../../src/types.js';

/**
 * A synthetic Google Ads for the tests of R2.5 M3 (targeting, child activation, the default provider check): a customer `123`
 * with campaigns, ad groups and asset groups whose statuses and channels a test sets, a search that returns only the fields a
 * state query SELECTs (so a query that does not ask for a field reads it as unread, which is what the review sees), a mutate that
 * applies what it is sent and a validate-only that a test can make pass, refuse or fail. Every ID and name is synthetic.
 */
export const google = 'google_ads_native_action';
export const actor: Actor = {tenantId: 'google-world', userId: 'operator', role: 'operator'};
export const admin: Actor = {...actor, role: 'admin'};
/** What a campaign, ad group or asset group of the customer is. A field left out is a field the search does not return. */
export interface Resource {
  status?: string;
  /** An ad group's or asset group's campaign (a resource name). */
  campaign?: string;
  /** A campaign's advertising channel type. */
  channel?: string;
  /**
   * A Demand Gen campaign's `demand_gen_campaign_settings.upgraded_targeting`, as the search returns it: a boolean, or left out
   * (a campaign whose row has no such value). Any other value is one the review cannot read as true or false.
   */
  upgradedTargeting?: unknown;
  /** An ad group's type. */
  type?: string;
}
/** An existing ad of the customer: its status and ad group, as a search of ad_group_ad returns them (r25-field-pausedspend's enable edits). */
export interface AdGroupAd {
  status?: string;
  adGroup?: string;
}
/** An existing asset of the customer (an image the ads of a build link): what a search of assets returns of it. */
export interface Asset {
  name?: string;
  type?: string;
  width?: number;
  height?: number;
}
/** An existing campaign budget of the customer (the one a campaign create names), as r25-field-pausedspend's campaign creates read it. */
export interface Budget {
  amountMicros?: string;
}
export interface World {
  campaigns: Record<string, Resource>;
  adGroups: Record<string, Resource>;
  assetGroups: Record<string, Resource>;
  assets?: Record<string, Asset>;
  campaignBudgets?: Record<string, Budget>;
  adGroupAds?: Record<string, AdGroupAd>;
}
/**
 * How the provider answers a validate-only request: it passes, refuses with a field path, or cannot answer (an outage, a rate limit, or a
 * refusal of the login or the route: permission denied, credentials not accepted, route not found). `custom` is a refusal whose body a
 * test writes (`hooks.validationReply`, r25-field3-errors: the GoogleAdsFailure of a policy finding, with the policy, the trigger and the
 * provider's own sentences), answered with HTTP 400.
 */
export type Validation =
  'pass' | 'reject' | 'outage' | 'rate_limit' | 'forbidden' | 'unauthorized' | 'not_found' | 'custom';
export const campaign = (id: number | string) => 'customers/123/campaigns/' + id;
export const adGroup = (id: number | string) => 'customers/123/adGroups/' + id;
export const assetGroup = (id: number | string) => 'customers/123/assetGroups/' + id;
const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const snake = (k: string) => k.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const deep = (v: unknown, key: (k: string) => string): any =>
  Array.isArray(v)
    ? v.map(x => deep(x, key))
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [key(k), deep(x, key)]))
      : v;
const results: Record<string, string> = {
  campaign_budget_operation: 'campaignBudgetResult',
  campaign_operation: 'campaignResult',
  campaign_criterion_operation: 'campaignCriterionResult',
  ad_group_operation: 'adGroupResult',
  ad_group_criterion_operation: 'adGroupCriterionResult',
  ad_group_ad_operation: 'adGroupAdResult',
};
const collections: Record<string, string> = {
  campaign_budget_operation: 'campaignBudgets',
  campaign_operation: 'campaigns',
  campaign_criterion_operation: 'campaignCriteria',
  ad_group_operation: 'adGroups',
  ad_group_criterion_operation: 'adGroupCriteria',
  ad_group_ad_operation: 'adGroupAds',
};
export interface GoogleWorldOptions {
  world?: Partial<World>;
  /** The deployment's execution policy beyond writes being on (providerCheckByDefault, for the default provider check). */
  policy?: JsonObject;
  /** The validate-only answer; a test changes it between calls through `fake.validation`. */
  validation?: Validation;
}
/**
 * The synthetic Google as a `fetch` (a fake that answers the reads, the validate-only requests and the mutates of customer 123) and
 * the state it keeps, for a service of a test or the evaluation journeys: no store, no service, no network.
 */
export function googleResponder(options: Pick<GoogleWorldOptions, 'world' | 'validation'> = {}) {
  const world: World = {
    campaigns: {...options.world?.campaigns},
    adGroups: {...options.world?.adGroups},
    assetGroups: {...options.world?.assetGroups},
    assets: {...options.world?.assets},
    campaignBudgets: {...options.world?.campaignBudgets},
    adGroupAds: {...options.world?.adGroupAds},
  };
  const created = new Map<string, JsonObject>(),
    log: {kind: 'read' | 'write' | 'validation'; path: string; body: any}[] = [],
    state = {validation: options.validation ?? ('pass' as Validation), next: 500},
    // What a test does while the provider is answering a validate-only request (withdraws a grant, for one), and the body of the answer
    // when the validation is `custom` (the request as Google reads it, with its names in snake case).
    hooks: {
      beforeValidationReply?: () => void;
      validationReply?: (body: any) => unknown | undefined;
      /** The answer of a write the test refuses (r25-field3-errors: a policy finding at execute, after the check passed); the write is still logged. */
      writeReply?: (body: any) => {status: number; body: unknown} | undefined;
    } = {};
  const flat = (kind: string, name: string): JsonObject | undefined => {
    if (kind === 'campaign') {
      const c = world.campaigns[name];
      return (
        c && {
          resource_name: name,
          name: 'Existing',
          status: c.status,
          campaign_budget: 'customers/123/campaignBudgets/1',
          advertising_channel_type: c.channel,
          'demand_gen_campaign_settings.upgraded_targeting': c.upgradedTargeting,
        }
      );
    }
    if (kind === 'ad_group_ad') {
      const a = world.adGroupAds?.[name];
      return a && {resource_name: name, status: a.status, ad_group: a.adGroup};
    }
    if (kind === 'campaign_budget') {
      const b = world.campaignBudgets?.[name];
      return b && {resource_name: name, name: 'Existing budget', amount_micros: b.amountMicros ?? '40000000'};
    }
    if (kind === 'asset') {
      const a = world.assets?.[name];
      return (
        a && {
          resource_name: name,
          name: a.name ?? 'DNU image',
          type: a.type ?? 'IMAGE',
          'image_asset.full_size.width_pixels': a.width ?? 1200,
          'image_asset.full_size.height_pixels': a.height ?? 628,
        }
      );
    }
    const g = (kind === 'ad_group' ? world.adGroups : world.assetGroups)[name];
    return (
      g && {
        resource_name: name,
        name: 'Existing',
        status: g.status,
        campaign: g.campaign,
        type: g.type ?? 'SEARCH_STANDARD',
      }
    );
  };
  /**
   * The related entities a search selects of a resource an earlier create made (`campaign.status` of a new ad group), read from what that
   * create made or from the test world: Google returns them beside the row, and the review reads a parent's status from them. Added by
   * r25-field-pausedspend for the plan whose later steps create children under the campaign and ad groups its earlier steps made.
   */
  const relatedOf = (record: JsonObject, from: string, selected: string[]) => {
    const row: any = {};
    for (const field of selected) {
      const [entity, ...path] = field.split('.');
      if (!entity || entity === from || !path.length) continue;
      const parentName = record[camel(entity)];
      if (typeof parentName !== 'string') continue;
      const made = created.get(parentName);
      const value = made ? path.reduce((v: any, p) => v?.[camel(p)], made) : flat(entity, parentName)?.[path.join('.')];
      if (value === undefined) continue;
      let at = (row[camel(entity)] ??= {});
      path.slice(0, -1).forEach(p => (at = at[camel(p)] ??= {}));
      at[camel(path.at(-1)!)] = value;
    }
    return row;
  };
  const search = (query: string) => {
    const from = / FROM ([a-z_]+)/.exec(query)![1]!,
      selected = /^SELECT (.+) FROM /
        .exec(query)![1]!
        .split(',')
        .map(s => s.trim()),
      names = [...query.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]!);
    if (from === 'customer') return {results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]};
    // A search of assets that names none (the images of the account) lists the ones the test defined.
    if (from === 'asset' && !names.length) names.push(...Object.keys(world.assets ?? {}));
    return {
      results: names.flatMap(name => {
        const seen = created.get(name);
        if (seen) return [{[camel(from)]: seen, ...relatedOf(seen, from, selected)}];
        const record = flat(from, name);
        if (!record) {
          // Resources a test did not define: a criterion or list read for an update or removal.
          return /Criteri|sharedSets/.test(name)
            ? [{[camel(from)]: {resourceName: name, status: 'ENABLED', negative: false, type: 'KEYWORD'}}]
            : [];
        }
        const row: any = {};
        for (const field of selected) {
          const [entity, ...path] = field.split('.'),
            source = entity === from ? record : flat(entity!, String(record[entity!]));
          const value = source?.[path.join('.')];
          if (value === undefined) continue;
          let at = (row[camel(entity!)] ??= {});
          path.slice(0, -1).forEach(p => (at = at[camel(p)] ??= {}));
          at[camel(path.at(-1)!)] = value;
        }
        return [row];
      }),
    };
  };
  const mutate = (path: string, body: any) => {
    const collection = /\/([A-Za-z]+):mutate$/.exec(path)![1]!;
    if (collection === 'googleAds') {
      const names = new Map<string, string>(),
        real = (v: unknown): unknown =>
          typeof v === 'string' && names.has(v)
            ? names.get(v)
            : Array.isArray(v)
              ? v.map(real)
              : v && typeof v === 'object'
                ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, real(x)]))
                : v;
      return {
        mutateOperationResponses: body.mutate_operations.map((op: JsonObject) => {
          const key = Object.keys(op)[0]!,
            {resource_name: temp, ...record} = (op[key] as any).create,
            kind = collections[key]!,
            id = String(state.next++),
            parent = (record as any).ad_group ?? (record as any).campaign,
            name =
              'customers/123/' +
              kind +
              '/' +
              (/Criteria|Ads$/.test(kind) ? String(real(parent)).split('/').at(-1) + '~' + id : id);
          if (temp) names.set(temp as string, name);
          created.set(name, {resourceName: name, ...(deep(real(record), camel) as JsonObject)});
          return {[results[key]!]: {resourceName: name}};
        }),
      };
    }
    return {
      results: body.operations.map((op: JsonObject) => {
        if (op.remove) return {resourceName: op.remove};
        const record = (op.create ?? op.update) as any,
          name =
            op.update?.resource_name ??
            'customers/123/' + collection + '/' + (/Criteria$/.test(collection) ? '100~' : '') + String(state.next++);
        created.set(name, {resourceName: name, ...(deep(record, camel) as JsonObject)});
        // Google names the bidding strategy a campaign was created with (its read-back is how AMCP proves the choice, `bidding_strategy_type`).
        const scheme = {
          manual_cpc: 'MANUAL_CPC',
          target_spend: 'TARGET_SPEND',
          maximize_conversions: 'MAXIMIZE_CONVERSIONS',
          maximize_conversion_value: 'MAXIMIZE_CONVERSION_VALUE',
        } as Record<string, string>;
        const chosen = op.create && collection === 'campaigns' ? Object.keys(record).find(k => k in scheme) : undefined;
        if (chosen) created.get(name)!.biddingStrategyType = scheme[chosen];
        return {resourceName: name};
      }),
    };
  };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const body = deep(JSON.parse(String(init?.body ?? '{}')), snake),
      path = new URL(String(url)).pathname;
    if (path.endsWith('googleAds:search')) {
      log.push({kind: 'read', path, body});
      return Response.json(search(String(body.query)));
    }
    if (body.validate_only === true) {
      log.push({kind: 'validation', path, body});
      hooks.beforeValidationReply?.();
      switch (state.validation) {
        case 'outage':
          throw new TypeError('fetch failed');
        case 'rate_limit':
          return Response.json({error: {code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota.'}}, {status: 429});
        case 'forbidden':
          return Response.json({error: {code: 403, status: 'PERMISSION_DENIED', message: 'Denied.'}}, {status: 403});
        case 'unauthorized':
          return Response.json({error: {code: 401, status: 'UNAUTHENTICATED', message: 'Expired.'}}, {status: 401});
        case 'not_found':
          return Response.json({error: {code: 404, status: 'NOT_FOUND', message: 'No such route.'}}, {status: 404});
        case 'custom': {
          // A body is a refusal (HTTP 400); `undefined` lets this request pass, so a test can reject one part of a split request.
          const reply = hooks.validationReply!(body);
          return reply === undefined ? Response.json({}) : Response.json(reply, {status: 400});
        }
        case 'reject': {
          // Where Google puts the refused field: a one-service request names `operations[0].create.location`; a build (GoogleAdsService
          // mutate_operations) names the operation by its index and its kind, `mutate_operations[3].ad_group_criterion_operation.create.
          // location`, the first location criterion of the build (S4-8, round 2).
          const operations: JsonObject[] | undefined = body.mutate_operations,
            at = operations
              ? Math.max(
                  0,
                  operations.findIndex(o => (o as any).ad_group_criterion_operation?.create?.location),
                )
              : 0,
            fieldPathElements = operations
              ? [
                  {fieldName: 'mutate_operations', index: at},
                  {fieldName: 'ad_group_criterion_operation'},
                  {fieldName: 'create'},
                  {fieldName: 'location'},
                ]
              : [{fieldName: 'operations', index: 0}, {fieldName: 'create'}, {fieldName: 'location'}];
          return Response.json(
            {
              error: {
                code: 400,
                status: 'INVALID_ARGUMENT',
                message: 'Request contains an invalid argument.',
                details: [
                  {
                    errors: [
                      {
                        errorCode: {requestError: 'UNKNOWN'},
                        message: 'The error code is not in this version.',
                        location: {fieldPathElements},
                      },
                    ],
                  },
                ],
              },
            },
            {status: 400},
          );
        }
        default:
          return Response.json({});
      }
    }
    log.push({kind: 'write', path, body});
    const refused = hooks.writeReply?.(body);
    if (refused) return Response.json(refused.body, {status: refused.status});
    return Response.json(mutate(path, body));
  };
  return {world, created, log, state, hooks, fetcher};
}
/** The synthetic customer, its service and the log of what was sent to it. */
export function googleWorld(options: GoogleWorldOptions = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway: google,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const {world, created, log, state, hooks, fetcher} = googleResponder(options);
  // A large request burst: a test that walks many states sends more than the tenant's default 30 in a second.
  const transport = new NativeTransport(fetcher, async () => {}, 30000, 8 * 1024 * 1024, 100000);
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
    ...options.policy,
  });
  const call = (tool: string, input: JsonObject) => service.call(tool, input, actor) as Promise<any>;
  const count = (kind: 'read' | 'write' | 'validation') => log.filter(r => r.kind === kind).length;
  return {
    store,
    service,
    world,
    created,
    log,
    state,
    hooks,
    call,
    reads: () => count('read'),
    writes: () => count('write'),
    validations: () => count('validation'),
    /** The queries of the state reads, in order. */
    queries: () => log.filter(r => r.kind === 'read').map(r => String(r.body.query)),
    /** Prepares one one-service mutation of Google Ads (`ad_group_criterion_mutate_ad_group_criteria`, and so on). */
    prepare: (action: string, operations: JsonObject[], extra: JsonObject = {}) =>
      call('amcp_write', {
        action: 'prepare',
        gateway: google,
        arguments: {action: 'google_ads_v23_' + action, account_id: '123', payload: {operations}},
        ...extra,
      }),
    inspect: (action: string, operations: JsonObject[]) =>
      call('amcp_write', {
        action: 'inspect',
        gateway: google,
        arguments: {action: 'google_ads_v23_' + action, account_id: '123', payload: {operations}},
      }),
    /** Prepares one all-or-nothing build (`googleAds:mutate`). */
    prepareBuild: (mutateOperations: JsonObject[], extra: JsonObject = {}) =>
      call('amcp_write', {
        action: 'prepare',
        gateway: google,
        arguments: {
          action: 'google_ads_v23_google_ads_mutate',
          account_id: '123',
          payload: {mutate_operations: mutateOperations},
        },
        ...extra,
      }),
    execute: (review: JsonObject, extra: JsonObject = {spend_change_confirmed: true}) =>
      call('amcp_write', {action: 'execute', review_id: review.data.review_id, confirmed: true, ...extra}),
  };
}
