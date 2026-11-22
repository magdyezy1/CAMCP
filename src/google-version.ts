import type {Action, JsonObject, ToolDefinition} from './types.js';

/**
 * The Google Ads API version AMCP sends requests to, v25 since 2026-09-28 (the owner's decision to upgrade before v23
 * sunsets). The captured catalog recorded its routes at v23: the registry moves them to this version, and the pinned
 * Discovery document of this version (.mirror/VENDOR/google-ads-v25.json) is the contract every Google Ads request is
 * checked against. Action names keep their recorded `google_ads_v23_…` spelling, since callers use them as names.
 * Family modules cite the v23 sources they were written against; docs/implementation/GOOGLE-ADS-V25-2026-09-28.md
 * records how each was rechecked at this version and what changed.
 */
export const googleAdsVersion = 'v25';
/**
 * Google sunset Google Ads developer tokens on 2026-09-09 and will reject the header in a future major version
 * (src/provider-deprecations.ts). AMCP no longer sends it; a configured AMCP_GOOGLE_DEVELOPER_TOKEN only earns this
 * warning, written at startup and listed in owner health.
 */
export function googleDeveloperTokenWarning(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.AMCP_GOOGLE_DEVELOPER_TOKEN
    ? 'AMCP_GOOGLE_DEVELOPER_TOKEN is set, but Google sunset developer tokens on 2026-09-09 and will reject them in a future Google Ads API version; AMCP no longer sends the header. Remove the variable from the deployment.'
    : undefined;
}
/** The pinned Discovery document of that version, as keyed in generated/vendor-routes.json. */
export const googleAdsContract = 'google-ads-' + googleAdsVersion;
/** A Google Ads REST path at the current version: googleAdsPath('/customers/1/googleAds:search'). */
export const googleAdsPath = (rest: string) => '/' + googleAdsVersion + rest;
/** A recorded Google Ads path or URL moved to the current version. */
export const currentGoogleAdsPath = (path: string) =>
  path.replace(
    /^((?:https:\/\/googleads\.googleapis\.com)?(?:\/resumable\/upload)?\/)v\d+(?=[/:])/,
    '$1' + googleAdsVersion,
  );
/** Captured (v23) actions whose request the current version changed: the required fields it renamed, and what to send
 * now, which the error rejecting the old shape carries. A test compares every recorded required field with the pinned
 * request schema, so another rename fails it rather than a caller's request. */
const changedRequests: Record<string, {required: Record<string, string>; change: string}> = {
  // v25 actions/generate_shareable_previews.proto
  google_ads_v23_shareable_preview_generate_shareable_previews: {
    required: {shareable_previews: 'operation'},
    change:
      'Since v25 the previews sit in an operation, an asset group is named by its resource, and each preview states its type: {"operation": {"shareablePreviews": [{"assetGroup": "customers/{customer_id}/assetGroups/{asset_group_id}", "previewType": "UI_PREVIEW"}, {"adGroupAd": "customers/{customer_id}/adGroupAds/{ad_group_id}~{ad_id}", "previewType": "YOUTUBE_LIVE_PREVIEW"}]}}.',
  },
};
/** How the current version changed this action's request, if it did. */
export const googleAdsRequestChange = (action: string): string | undefined => changedRequests[action]?.change;
/** What the current version has in place of a field it no longer has: the field, its format where Google documents one, and values where the field takes them. */
export interface GoogleFieldReplacement {
  replacement: string;
  format?: string;
  replacement_values?: JsonObject;
}
/**
 * Fields of a resource that the current version no longer has, with what it has instead (R2.5 r25-field3-refs, the owner's second Google report of
 * 2026-11-21, F6-1). A request that names one is refused as before, locally, by the check against the pinned Discovery document (INVALID_VENDOR_BODY, "Field
 * absent from the pinned vendor request schema"); the refusal now says what to send. Each row is verified against the pinned v25 document
 * (.mirror/VENDOR/google-ads-v25.json): Campaign has `startDateTime` and `endDateTime` ("yyyy-MM-dd HH:mm:ss" in the customer's time zone) and no
 * `startDate`, `endDate` or `urlExpansionOptOut`; its `assetAutomationSettings` hold {assetAutomationType, assetAutomationStatus}, with the type
 * FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION and the status OPTED_OUT. Google's release notes (developers.google.com/google-ads/api/docs/release-notes) say v22
 * replaced the URL expansion opt-out with that setting. Keyed by the resource's collection, its operation's name in a build and its JSON field names.
 */
const replacedFields: Record<
  string,
  {collection: string; operation: string; fields: Record<string, GoogleFieldReplacement>}
> = {
  campaign: {
    collection: 'campaigns',
    operation: 'campaignOperation',
    fields: {
      startDate: {replacement: 'start_date_time', format: 'yyyy-MM-dd HH:mm:ss'},
      endDate: {replacement: 'end_date_time', format: 'yyyy-MM-dd HH:mm:ss'},
      urlExpansionOptOut: {
        replacement: 'asset_automation_settings',
        replacement_values: {
          asset_automation_type: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION',
          asset_automation_status: 'OPTED_OUT',
        },
      },
    },
  },
};
/**
 * The replacement of the field an issue of the Discovery check names, or undefined: `path` is the request's path and `field` the issue's JSON pointer into
 * the body, `/operations/<i>/(create|update)/<name>` of a service request or `/mutateOperations/<i>/<operation>/(create|update)/<name>` of a build, in
 * Google's camelCase. Only a field of a resource the table names, in that resource's own operation, has one.
 */
export function googleAdsFieldReplacement(path: string, field: string): GoogleFieldReplacement | undefined {
  const service = /^\/operations\/\d+\/(?:create|update)\/([A-Za-z]+)$/.exec(field),
    inBuild = /^\/mutateOperations\/\d+\/([A-Za-z]+)\/(?:create|update)\/([A-Za-z]+)$/.exec(field);
  for (const row of Object.values(replacedFields)) {
    const name = service
      ? path.endsWith('/' + row.collection + ':mutate')
        ? service[1]
        : undefined
      : inBuild?.[1] === row.operation
        ? inBuild[2]
        : undefined;
    const found = name === undefined ? undefined : row.fields[name];
    if (found) return structuredClone(found);
  }
  return undefined;
}
/** A captured Google Ads catalog record or description (as the catalog lists it) at the current version. */
export function currentGoogleAdsRecord(record: JsonObject): JsonObject {
  const renamed = changedRequests[String(record.action ?? record.name)]?.required;
  return {
    ...record,
    ...(record.api_version !== undefined ? {api_version: googleAdsVersion} : {}),
    ...(typeof record.path === 'string' ? {path: currentGoogleAdsPath(record.path)} : {}),
    ...(renamed && Array.isArray(record.required_fields)
      ? {required_fields: record.required_fields.map((f: string) => renamed[f] ?? f)}
      : {}),
  };
}
/** A captured Google Ads LIST_ACTIONS page or DESCRIBE_ACTION response, as AMCP answers it at the current version. */
export function currentGoogleAdsCapture(data: JsonObject): JsonObject {
  return Array.isArray(data.actions)
    ? {...data, api_version: googleAdsVersion, actions: data.actions.map((a: JsonObject) => currentGoogleAdsRecord(a))}
    : currentGoogleAdsRecord(data);
}
/** The version the captured action names carry (`google_ads_v23_…`), which they keep by decision (see above). */
const recordedActionPrefix = 'google_ads_v23_';
/**
 * The spellings of a recorded `google_ads_v23_<rpc>` action name beyond the generic ones (T7, L2-04 and L6-21): the
 * spelling at the version AMCP sends (`google_ads_v25_<rpc>`) and the one without a version (`google_ads_<rpc>`). Both
 * resolve with a deprecation warning that names the recorded name, which stays the canonical one: callers use the recorded
 * names, so no spelling is withdrawn. The generic rule already gives the name without its prefix (`google_ads_search`).
 */
export function googleAdsActionAliases(a: Action): readonly string[] {
  if (!a.name.startsWith(recordedActionPrefix)) return [];
  const rpc = a.name.slice(recordedActionPrefix.length);
  return ['google_ads_' + googleAdsVersion + '_' + rpc, 'google_ads_' + rpc];
}
/** The captured catalog's Google Ads action at the current version, listed as it is sent. */
export function googleAdsActionVersion(a: Action): Action {
  const renamed = changedRequests[a.name]?.required;
  return {
    ...a,
    ...(a.path ? {path: currentGoogleAdsPath(a.path)} : {}),
    ...(renamed ? {required: a.required.map(f => renamed[f] ?? f)} : {}),
    raw: currentGoogleAdsRecord(a.raw),
  };
}
/** The prefix of every customer-scoped Google Ads path at the current version: googleAdsCustomers + id + '/…'. */
export const googleAdsCustomers = '/' + googleAdsVersion + '/customers/';
/** The captured Google Ads tool definition (and its help copy), stating the version it sends. Its schema is unchanged. */
export function extendGoogleAdsTool(original: ToolDefinition): ToolDefinition {
  const tool = structuredClone(original),
    v = googleAdsVersion;
  const restate = (definition: JsonObject) => {
    definition.description = definition.description.replace(
      'Complete Google Ads API v23 native gateway: all 171 checked-in service RPCs',
      'Complete Google Ads API ' +
        v +
        ' native gateway: the captured service RPCs (named google_ads_v23_…, sent at ' +
        v +
        '; the two lifecycle goal methods ' +
        v +
        ' removed are refused)',
    );
    const properties = definition.inputSchema.properties,
      describe = (key: string, from: string, to: string) => {
        if (typeof properties[key]?.description === 'string')
          properties[key].description = properties[key].description.replace(from, to);
      };
    describe('action', 'Canonical v23 RPC action', 'Canonical RPC action (named google_ads_v23_…, sent at ' + v + ')');
    describe('params', 'from the v23 proto', 'from the ' + v + ' request');
    describe('payload', 'Native Google Ads v23 request body fields', 'Native Google Ads ' + v + ' request body fields');
    describe('dry_run', 'the exact v23 request', 'the exact ' + v + ' request');
  };
  restate(tool as unknown as JsonObject);
  if (tool.help?.inputSchema) {
    restate(tool.help);
    if (typeof tool.help.usage === 'string')
      tool.help.usage = tool.help.usage.replace('<canonical v23 action>', '<canonical action>');
  }
  return tool;
}
