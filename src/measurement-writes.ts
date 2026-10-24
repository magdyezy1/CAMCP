import type {ReviewedFamily} from './reviewed-family.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
import {familyCodeError, type OneCodeRefusal, readOf, stateReadOf} from './family-kit.js';
import {
  appleEntityKind,
  assertAppleEntityWrite,
  appleEntitySnapshots,
  validateAppleEntityState,
  appleEntityOutcome,
  appleEntityVerification,
} from './apple-entity-writes.js';
import {gtmWorkflowKind, gtmWorkflowContracts} from './gtm-workflow-writes.js';
import {analyticsScopes, appleScope, gtmWriteScopes, searchConsoleWriteScope} from './provider-grants.js';
import {gtmWorkspaceKind, gtmWorkspaceContracts} from './gtm-workspace-writes.js';

export const measurementWriteGateways = new Set([
  'ga4_native_action',
  'gtm_native_action',
  'google_search_console_native_action',
  'apple_ads_native_action',
]);
const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
const fail: OneCodeRefusal = familyCodeError('WRITE_CONTRACT_UNAVAILABLE');
const mismatch = (): never => {
  throw new MirrorError(
    'ACCOUNT_SCOPE_MISMATCH',
    'Mutation resource references must remain inside the selected resource.',
    {},
    403,
  );
};
const gtmEntities = [
  'CONTAINER',
  'WORKSPACE',
  'TAG',
  'TRIGGER',
  'VARIABLE',
  'GTAG_CONFIG',
  'TEMPLATE',
  'FOLDER',
  'ZONE',
  'CLIENT',
  'TRANSFORMATION',
  'ENVIRONMENT',
];
export const gtmWriteActions = new Set([
  ...gtmEntities.flatMap(e => ['CREATE', 'UPDATE', 'DELETE'].map(v => v + '_' + e)),
  'UPDATE_CONTAINER_VERSION',
  'DELETE_CONTAINER_VERSION',
  'CREATE_CONTAINER_VERSION',
  'PUBLISH_CONTAINER_VERSION',
]);
/** Apple Ads campaign creation, update and deletion at their exact API v1 routes. */
export function appleCampaignKind(p: CompiledRequest): boolean {
  const action = p.action.split('/').at(-1)!;
  return (
    p.gateway === 'apple_ads_native_action' &&
    p.origin === 'https://api.ads.apple.com' &&
    ['apple_ads_v1_campaign_create', 'apple_ads_v1_campaign_update', 'apple_ads_v1_campaign_delete'].includes(action) &&
    ((p.method === 'POST' && p.path === '/v1/campaigns') ||
      (['PUT', 'DELETE'].includes(p.method) && /^\/v1\/campaigns\/\d+$/.test(p.path)))
  );
}
/** GA4 audience export and report task creation. */
export function ga4ExportKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'ga4_native_action' &&
    p.origin === 'https://analyticsdata.googleapis.com' &&
    p.method === 'POST' &&
    ['ga4_create_audience_export', 'ga4_create_report_task'].includes(p.action) &&
    /^\/v1(?:alpha|beta)\/properties\/\d+\/(audienceExports|reportTasks)$/.test(p.path)
  );
}
/** Tag Manager entity writes, version creation and publishing. */
export function gtmEntityKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'gtm_native_action' &&
    p.origin === 'https://tagmanager.googleapis.com' &&
    gtmWriteActions.has(p.action.split('/').at(-1)!) &&
    /^\/tagmanager\/v2\/accounts\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?::create_version|:publish)?$/.test(p.path)
  );
}
/** Search Console sites and sitemaps: add, delete, submit and delete. */
export function searchConsoleSiteKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_search_console_native_action' &&
    ['https://www.googleapis.com', 'https://searchconsole.googleapis.com'].includes(p.origin!) &&
    ['ADD_SITE', 'DELETE_SITE', 'SUBMIT_SITEMAP', 'DELETE_SITEMAP'].includes(p.action.split('/').at(-1)!) &&
    ['PUT', 'DELETE'].includes(p.method) &&
    /^\/webmasters\/v3\/sites\/[^/]+(?:\/sitemaps\/[^/]+)?$/.test(p.path)
  );
}
// Scope strings come from the one grant registry (src/provider-grants.ts, CON-03).
export {gtmWriteScopes};
const action = (p: CompiledRequest) => p.action.split('/').at(-1)!;
const gtmResource = (p: CompiledRequest) =>
  p.path.replace(/^\/tagmanager\/v2\//, '').replace(/:(create_version|publish)$/, '');
const empty = (v: unknown) =>
  v === null || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
function referenceScope(p: CompiledRequest) {
  const resource = gtmResource(p),
    segments = resource.split('/');
  const bindings: Record<string, string> = {accountId: p.accountId!};
  for (const [collection, key] of [
    ['containers', 'containerId'],
    ['workspaces', 'workspaceId'],
  ] as const) {
    const i = segments.indexOf(collection);
    if (i >= 0 && segments[i + 1]) bindings[key] = segments[i + 1]!;
  }
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, value] of Object.entries(v)) {
      if (bindings[k] !== undefined && String(value) !== bindings[k]) mismatch();
      if (['path', 'parent'].includes(k) && typeof value === 'string' && value.startsWith('accounts/')) {
        const parts = value.split('/');
        if (parts[1] !== p.accountId) mismatch();
        for (const [collection, key] of [
          ['containers', 'containerId'],
          ['workspaces', 'workspaceId'],
        ] as const) {
          const i = parts.indexOf(collection);
          if (bindings[key] && i >= 0 && parts[i + 1] !== bindings[key]) mismatch();
        }
      }
      walk(value);
    }
  };
  walk(p.body);
  if (p.method === 'PUT' && obj(p.body).path !== undefined && obj(p.body).path !== resource) mismatch();
  const last = segments.at(-1)!,
    idFields: Record<string, string> = {
      containers: 'containerId',
      workspaces: 'workspaceId',
      tags: 'tagId',
      triggers: 'triggerId',
      variables: 'variableId',
      gtag_config: 'gtagConfigId',
      templates: 'templateId',
      folders: 'folderId',
      zones: 'zoneId',
      clients: 'clientId',
      transformations: 'transformationId',
      environments: 'environmentId',
      versions: 'containerVersionId',
    };
  const idField = idFields[segments.at(-2)!];
  if (p.method === 'PUT' && idField && obj(p.body)[idField] !== undefined && String(obj(p.body)[idField]) !== last)
    mismatch();
}

/** Explicit contracts: new vendor catalog entries do not automatically gain write permission. */
export function assertMeasurementWrite(p: CompiledRequest): void {
  if (appleEntityKind(p)) {
    assertAppleEntityWrite(p);
    return;
  }
  const a = action(p),
    b = obj(p.body);
  if (p.gateway === 'apple_ads_native_action') {
    if (
      p.origin !== 'https://api.ads.apple.com' ||
      !['apple_ads_v1_campaign_create', 'apple_ads_v1_campaign_update', 'apple_ads_v1_campaign_delete'].includes(a) ||
      !(
        (p.method === 'POST' && p.path === '/v1/campaigns') ||
        (['PUT', 'DELETE'].includes(p.method) && /^\/v1\/campaigns\/\d+$/.test(p.path))
      )
    )
      fail('Only Apple Platform API v1 campaign mutations are supported.');
    if (p.method === 'POST' && b.status !== 'PAUSED')
      throw new MirrorError('PAUSED_CREATION_REQUIRED', 'New Apple campaigns require status PAUSED.');
    if (b.status !== undefined && !['PAUSED', 'ENABLED'].includes(b.status))
      fail('Apple campaign status must be PAUSED or ENABLED.');
  } else if (p.gateway === 'ga4_native_action') {
    if (
      p.origin !== 'https://analyticsdata.googleapis.com' ||
      p.method !== 'POST' ||
      !['ga4_create_audience_export', 'ga4_create_report_task'].includes(p.action) ||
      !/^\/v1(?:alpha|beta)\/properties\/\d+\/(audienceExports|reportTasks)$/.test(p.path)
    )
      fail('GA4 supports reviewed audience-export and report-task creation.');
    if (
      a === 'ga4_create_audience_export' &&
      (typeof b.audience !== 'string' ||
        !new RegExp('^properties/' + p.accountId + '/audiences/[A-Za-z0-9_-]+$').test(b.audience))
    )
      mismatch();
    if (!Object.keys(b).length) fail('Provide the native GA4 request body.');
  } else if (p.gateway === 'gtm_native_action') {
    if (
      p.origin !== 'https://tagmanager.googleapis.com' ||
      !gtmWriteActions.has(a) ||
      !/^\/tagmanager\/v2\/accounts\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?::create_version|:publish)?$/.test(p.path)
    )
      fail('This Tag Manager workflow has no reviewed write contract.');
    if (Object.keys(p.query).some(k => k !== 'fingerprint'))
      fail('Only the native fingerprint query parameter is accepted for reviewed Tag Manager mutations.');
    referenceScope(p);
  } else if (p.gateway === 'google_search_console_native_action') {
    if (
      !['https://www.googleapis.com', 'https://searchconsole.googleapis.com'].includes(p.origin!) ||
      !['ADD_SITE', 'DELETE_SITE', 'SUBMIT_SITEMAP', 'DELETE_SITEMAP'].includes(a) ||
      !['PUT', 'DELETE'].includes(p.method) ||
      !/^\/webmasters\/v3\/sites\/[^/]+(?:\/sitemaps\/[^/]+)?$/.test(p.path)
    )
      fail('This Search Console operation has no reviewed write contract.');
    if (p.path.includes('/sitemaps/')) {
      let url: URL;
      try {
        url = new URL(decodeURIComponent(p.path.split('/').at(-1)!));
      } catch {
        fail('Sitemap must be an absolute HTTP(S) URL.');
      }
      if (!['http:', 'https:'].includes(url!.protocol) || url!.username || url!.password || url!.hash)
        fail('Sitemap must be an absolute HTTP(S) URL without credentials or fragment.');
    }
  }
  if (p.gateway !== 'gtm_native_action' && Object.keys(p.query).length)
    fail('Query overrides are unavailable for these reviewed mutations.');
}
export function assertMeasurementScopes(p: CompiledRequest, c: Connection): void {
  let scopes: string[] = [];
  if (p.gateway === 'google_search_console_native_action') scopes = [searchConsoleWriteScope];
  if (p.gateway === 'ga4_native_action') scopes = [...analyticsScopes];
  if (p.gateway === 'apple_ads_native_action') scopes = [appleScope];
  if (p.gateway === 'gtm_native_action') {
    const a = action(p),
      scope =
        a === 'PUBLISH_CONTAINER_VERSION'
          ? 'tagmanager.publish'
          : ['CREATE_CONTAINER_VERSION', 'UPDATE_CONTAINER_VERSION', 'DELETE_CONTAINER_VERSION'].includes(a)
            ? 'tagmanager.edit.containerversions'
            : ['DELETE_CONTAINER', 'DELETE_WORKSPACE'].includes(a)
              ? 'tagmanager.delete.containers'
              : 'tagmanager.edit.containers';
    scopes = ['https://www.googleapis.com/auth/' + scope];
  }
  const gtm = gtmWorkflowKind(p);
  if (gtm) scopes = [gtmWorkflowContracts[gtm]!.scope];
  const workspace = gtmWorkspaceKind(p);
  if (workspace) scopes = ['https://www.googleapis.com/auth/tagmanager.' + gtmWorkspaceContracts[workspace].scope];
  if (scopes.length && !scopes.some(s => c.scopes.includes(s)))
    throw new MirrorError(
      'PROVIDER_WRITE_SCOPE_REQUIRED',
      'Reconnect this provider with the required permission before preparing a mutation.',
      {required_any: scopes},
      403,
    );
}

export function measurementSnapshots(p: CompiledRequest): CompiledRequest[] {
  if (appleEntityKind(p)) return appleEntitySnapshots(p);
  const read = (path: string, origin = p.origin, optional = false): CompiledRequest =>
    readOf(p, {before: {origin}, action: optional ? 'AMCP_STATE_OPTIONAL' : 'AMCP_STATE_READ', path, query: {}});
  if (p.gateway === 'apple_ads_native_action')
    return [read(p.method === 'POST' ? '/v1/ad-accounts/' + p.accountId : p.path)];
  if (p.gateway === 'ga4_native_action')
    return [read('/v1beta/properties/' + p.accountId, 'https://analyticsadmin.googleapis.com')];
  if (p.gateway === 'google_search_console_native_action') {
    const site = p.path.split('/sitemaps/')[0]!;
    return p.path === site ? [read(site)] : [read(site), read(p.path, p.origin, action(p) === 'SUBMIT_SITEMAP')];
  }
  const a = action(p),
    resource = gtmResource(p),
    prefix = '/tagmanager/v2/';
  if (a === 'PUBLISH_CONTAINER_VERSION')
    return [
      read(prefix + resource),
      read(prefix + resource.replace(/\/versions\/[^/]+$/, '/versions:live'), p.origin, true),
    ];
  if (a === 'CREATE_CONTAINER_VERSION') return [read(prefix + resource), read(prefix + resource + '/status')];
  return [read(prefix + (a.startsWith('CREATE_') ? resource.slice(0, resource.lastIndexOf('/')) : resource))];
}
/** 404 is evidence of absence only for a derived optional target, never for its parent or permission failures. */
export function optionalMissingState(read: CompiledRequest, e: unknown): TransportResult | undefined {
  if (
    read.action === 'AMCP_STATE_OPTIONAL' &&
    read.method === 'GET' &&
    e instanceof MirrorError &&
    e.code === 'UPSTREAM_ERROR' &&
    e.status === 404
  )
    return {data: {amcp_absent: true, path: read.path}, status: 404, headers: {}};
  return undefined;
}
export function validateMeasurementState(read: CompiledRequest, result: TransportResult): void {
  const d = obj(result.data),
    failState = (): never => {
      throw new MirrorError('STATE_TARGET_MISMATCH', 'Provider state did not identify the exact selected resource.');
    };
  if (result.status === 404) {
    if (read.action !== 'AMCP_STATE_OPTIONAL' || d.amcp_absent !== true || d.path !== read.path) failState();
    return;
  }
  if (
    read.gateway === 'apple_ads_native_action' &&
    (read.action === 'AMCP_APPLE_ENTITY_STATE' ||
      read.scopeContext?.appleSharedAccountIds ||
      /^\/v1\/(adgroups|ads|creatives|keywords|negative-keywords|shared-budgets)\//.test(read.path))
  ) {
    validateAppleEntityState(read, d);
    return;
  }
  if (read.gateway === 'apple_ads_native_action') {
    if (
      String(d.result?.id) !== read.path.split('/').at(-1) ||
      (d.result?.adAccountId !== undefined && String(d.result.adAccountId) !== read.accountId)
    )
      failState();
    return;
  }
  if (read.gateway === 'ga4_native_action') {
    const target = read.path.replace(/^\/v1(?:alpha|beta)\//, '');
    if (
      !new RegExp('^properties/' + read.accountId + '(?:/(audienceExports|reportTasks)/[A-Za-z0-9_-]+)?$').test(
        target,
      ) ||
      d.name !== target
    )
      failState();
    return;
  }
  if (read.gateway === 'google_search_console_native_action') {
    if (read.path.includes('/sitemaps/')) {
      if (d.path !== decodeURIComponent(read.path.split('/').at(-1)!)) failState();
    } else if (d.siteUrl !== read.accountId || !['siteOwner', 'siteFullUser'].includes(d.permissionLevel)) failState();
    return;
  }
  const resource = gtmResource(read);
  if (resource.endsWith('/status')) {
    if (
      !result.data ||
      typeof result.data !== 'object' ||
      Array.isArray(result.data) ||
      Object.keys(d).some(k => !['workspaceChange', 'mergeConflict'].includes(k)) ||
      ['workspaceChange', 'mergeConflict'].some(k => d[k] !== undefined && !Array.isArray(d[k]))
    )
      failState();
    if (d.mergeConflict?.length)
      throw new MirrorError('STATE_CONFLICT', 'Resolve Tag Manager workspace conflicts before creating a version.');
    return;
  }
  if (resource.endsWith('/versions:live')) {
    if (
      typeof d.path !== 'string' ||
      !d.path.startsWith(resource.replace(/\/versions:live$/, '/versions/')) ||
      !d.containerVersionId
    )
      failState();
    return;
  }
  if (d.path !== resource) failState();
}
export function measurementOutcome(p: CompiledRequest, r: TransportResult): boolean {
  if (appleEntityKind(p)) return appleEntityOutcome(p, r);
  const d = obj(r.data),
    a = action(p);
  if (p.gateway === 'google_search_console_native_action') return [200, 204].includes(r.status) && empty(r.data);
  if (p.gateway === 'apple_ads_native_action') {
    if (p.method === 'DELETE')
      return (
        r.status === 200 &&
        r.data !== null &&
        typeof r.data === 'object' &&
        !Array.isArray(r.data) &&
        Object.keys(d).every(k => ['result', 'error'].includes(k)) &&
        (d.result === undefined || d.result === null) &&
        !d.error
      );
    return (
      [200, 201].includes(r.status) &&
      /^\d+$/.test(String(d.result?.id ?? '')) &&
      String(d.result?.adAccountId) === p.accountId &&
      (p.method === 'POST' || String(d.result.id) === p.path.split('/').at(-1))
    );
  }
  if (p.gateway === 'ga4_native_action') {
    const kind = p.path.split('/').at(-1)!,
      name = d.response?.name ?? d.metadata?.name ?? d.name;
    return (
      r.status === 200 &&
      typeof name === 'string' &&
      new RegExp('^properties/' + p.accountId + '/' + kind + '/[A-Za-z0-9_-]+$').test(name) &&
      !d.error
    );
  }
  if (p.method === 'DELETE') return [200, 204].includes(r.status) && empty(r.data);
  const resource = gtmResource(p);
  if (a === 'CREATE_CONTAINER_VERSION' || a === 'PUBLISH_CONTAINER_VERSION') {
    const version = obj(d.containerVersion),
      base = resource.replace(/\/(workspaces|versions)\/[^/]+$/, '/versions/');
    return (
      r.status === 200 &&
      typeof version.path === 'string' &&
      version.path.startsWith(base) &&
      !!version.containerVersionId &&
      (a === 'CREATE_CONTAINER_VERSION' || version.path === resource) &&
      d.compilerError !== true &&
      !d.syncStatus?.syncError &&
      !d.syncStatus?.mergeConflict
    );
  }
  return (
    [200, 201].includes(r.status) &&
    typeof d.path === 'string' &&
    (a.startsWith('CREATE_')
      ? d.path.startsWith(resource + '/') &&
        d.path.slice(resource.length + 1).length > 0 &&
        !d.path.slice(resource.length + 1).includes('/')
      : d.path === resource)
  );
}

/** Result identities come only from an already validated mutation receipt. A
 * created export is not a completed export: the verifier preserves job state. */
export function measurementVerification(
  plan: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  if (appleEntityKind(plan)) return appleEntityVerification(plan, result);
  const d = obj(result.data),
    b = obj(plan.body),
    a = action(plan);
  const read = (path: string, optional = false): CompiledRequest =>
    stateReadOf(plan, optional ? 'AMCP_STATE_OPTIONAL' : 'AMCP_VERIFY_READ', path, {});
  if (plan.method === 'DELETE')
    return [{read: read(plan.path, true), expected: {amcp_absent: true, path: plan.path}, id: plan.path}];
  if (plan.gateway === 'apple_ads_native_action') {
    const id = String(d.result.id);
    return [{read: read('/v1/campaigns/' + id), expected: {...b, id}, id}];
  }
  if (plan.gateway === 'ga4_native_action') {
    const name = d.response?.name ?? d.metadata?.name ?? d.name,
      version = plan.path.split('/')[1]!;
    return [{read: read('/' + version + '/' + name), expected: {...b, name}, id: name}];
  }
  if (plan.gateway === 'google_search_console_native_action')
    return [
      {
        read: read(plan.path),
        expected: plan.path.includes('/sitemaps/')
          ? {path: decodeURIComponent(plan.path.split('/').at(-1)!)}
          : {siteUrl: plan.accountId},
        id: plan.path,
      },
    ];
  if (plan.gateway === 'gtm_native_action') {
    const version = d.containerVersion;
    if (a === 'CREATE_CONTAINER_VERSION' || a === 'PUBLISH_CONTAINER_VERSION') {
      // A publish must match the live version, not merely the immutable version we
      // intended to publish. Creation verifies the server's resulting fingerprint.
      const path =
        a === 'PUBLISH_CONTAINER_VERSION' ? version.path.replace(/\/versions\/[^/]+$/, '/versions:live') : version.path;
      const expected = {
        path: version.path,
        containerVersionId: version.containerVersionId,
        ...(version.fingerprint ? {fingerprint: version.fingerprint} : {}),
      };
      return [{read: read('/tagmanager/v2/' + path), expected, id: version.path}];
    }
    const expected = Object.fromEntries(Object.entries(b).filter(([key]) => key !== 'fingerprint'));
    return [{read: read('/tagmanager/v2/' + d.path), expected: {...expected, path: d.path}, id: d.path}];
  }
  return [];
}
export function measurementVerificationPhase(
  plan: CompiledRequest,
  state: JsonObject,
): 'verified' | 'pending' | 'failed' {
  if (plan.gateway !== 'ga4_native_action') return 'verified';
  const phase = plan.path.includes('/reportTasks/') ? state.report_metadata?.state : state.state;
  if (phase === 'FAILED' || state.error_message || state.report_metadata?.error_message) return 'failed';
  if (phase === 'ACTIVE') return 'verified';
  return 'pending';
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const appleCampaignFamily: ReviewedFamily = {
  name: 'apple_campaigns',
  files: ['src/measurement-writes.ts', ['tests/measurement-writes.test.ts']],
  kind: appleCampaignKind,
  snapshots: measurementSnapshots,
  outcome: measurementOutcome,
  verification: measurementVerification,
};

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
/** A report task is a provider job (RPT-06). An audience export lists audience members, so it stays a reviewed write. */
function ga4ExportEffect(plan: CompiledRequest): 'provider_job' | 'reviewed_write' {
  return plan.action === 'ga4_create_report_task' ? 'provider_job' : 'reviewed_write';
}
export const ga4ExportFamily: ReviewedFamily = {
  name: 'ga4_export_jobs',
  files: ['src/measurement-writes.ts', ['tests/measurement-writes.test.ts']],
  kind: ga4ExportKind,
  effect: ga4ExportEffect,
  snapshots: measurementSnapshots,
  outcome: measurementOutcome,
  verification: measurementVerification,
};

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const gtmEntityFamily: ReviewedFamily = {
  name: 'gtm_entities',
  files: ['src/measurement-writes.ts', ['tests/measurement-writes.test.ts']],
  kind: gtmEntityKind,
  snapshots: measurementSnapshots,
  outcome: measurementOutcome,
  verification: measurementVerification,
};

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const searchConsoleSiteFamily: ReviewedFamily = {
  name: 'search_console_sites',
  files: ['src/measurement-writes.ts', ['tests/measurement-writes.test.ts']],
  kind: searchConsoleSiteKind,
  snapshots: measurementSnapshots,
  outcome: measurementOutcome,
  verification: measurementVerification,
};
