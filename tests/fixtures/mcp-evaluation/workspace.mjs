// The synthetic workspace behind the MCP evaluation set (QA-04; tests/fixtures/mcp-evaluation/evaluation.xml). An
// agency serves two clients: an outdoor-gear brand (Northwind Outdoors: two Meta ad accounts, a Google Ads customer and
// a Tag Manager container) and a bakery (Bluebell Bakery: one Meta ad account). Their saved report snapshots, captured
// reports, campaign plans and media library are seeded through AMCP's own tools or as the documents those tools keep,
// with fixed values and times, so every question has one stable answer. Every provider is a synthetic in-process fake;
// any other host, and any provider write, is refused and counted, so a run has zero egress and changes nothing.
//
// The workspace serves a reader: the person who seeded it, in the reader role, on a deployment with reviewed writes.
// Tool descriptions and help are the full writes deployment's, but no call can change a provider or save a plan.
import {Store} from '../../../dist/src/store.js';
import {Registry} from '../../../dist/src/catalog.js';
import {MirrorService} from '../../../dist/src/service.js';
import {NativeTransport} from '../../../dist/src/transport.js';
import {WebStore} from '../../../dist/server/web-store.js';
import {insertRegisteredClient} from '../../../dist/src/mcp-client-repository.js';

export const evaluationTenant = 'mcp-evaluation';
export const connections = Object.freeze({
  northwindMeta: 'eeeeeeee-1111-4111-8111-000000000001',
  bluebellMeta: 'eeeeeeee-1111-4111-8111-000000000002',
  northwindGoogle: 'eeeeeeee-1111-4111-8111-000000000003',
  northwindTags: 'eeeeeeee-1111-4111-8111-000000000004',
});
const person = {tenantId: evaluationTenant, userId: 'agency-analyst'};
/** The person who seeded the workspace, as the operator who did it and as the reader the evaluation serves. */
export const operatorActor = Object.freeze({...person, role: 'operator'});
export const readerActor = Object.freeze({...person, role: 'reader'});
/** Every seeded record carries a time in September 2026; nothing depends on when a run happens. */
const seededAt = Date.parse('2026-09-08T09:00:00Z');

const metaAccounts = {
  1101: {name: 'Northwind Outdoors EU', currency: 'EUR', timezone_name: 'Europe/Berlin'},
  2201: {name: 'Bluebell Bakery US', currency: 'USD', timezone_name: 'America/New_York'},
};
const metaCampaigns = {
  1101: [
    {id: '120001', name: 'Trail Running Prospecting', status: 'ACTIVE', objective: 'OUTCOME_SALES'},
    {id: '120002', name: 'Winter Jackets Retargeting', status: 'PAUSED', objective: 'OUTCOME_SALES'},
    {id: '120003', name: 'Brand Awareness Q3', status: 'ACTIVE', objective: 'OUTCOME_AWARENESS'},
    {id: '120004', name: 'Spring Hiking Catalog', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC'},
  ],
  2201: [
    {id: '220001', name: 'Sourdough Launch', status: 'ACTIVE', objective: 'OUTCOME_TRAFFIC'},
    {id: '220002', name: 'Holiday Cookies', status: 'PAUSED', objective: 'OUTCOME_LEADS'},
  ],
};
// Tag Manager account 44, container 55, workspace 66: one tag fires without a consent setting, one waits for
// analytics_storage, one for ad_storage, all on the All pages trigger. Account 45 is selected but refused.
const gtmContainer = 'accounts/44/containers/55',
  gtmWorkspace = gtmContainer + '/workspaces/66',
  gtmWorkspaceRow = {
    path: gtmWorkspace,
    accountId: '44',
    containerId: '55',
    workspaceId: '66',
    name: 'Northwind storefront workspace',
    fingerprint: 'workspace-66',
  },
  gtmTrigger = {
    path: gtmWorkspace + '/triggers/7',
    accountId: '44',
    containerId: '55',
    workspaceId: '66',
    triggerId: '7',
    name: 'All pages',
    type: 'pageview',
    fingerprint: 'trigger-7',
  };
const gtmTags = [
  ['001', 'Pageview base tag', undefined],
  ['002', 'Checkout analytics tag', 'analytics_storage'],
  ['003', 'Remarketing pixel', 'ad_storage'],
].map(([id, name, consent]) => ({
  path: gtmWorkspace + '/tags/' + id,
  accountId: '44',
  containerId: '55',
  workspaceId: '66',
  tagId: id,
  name,
  type: 'html',
  fingerprint: 'tag-' + id,
  firingTriggerId: ['7'],
  parameter: [{type: 'template', key: 'html', value: 'SYNTHETIC-SCRIPT'}],
  ...(consent
    ? {
        consentSettings: {
          consentStatus: 'needed',
          consentType: {type: 'list', list: [{type: 'template', value: consent}]},
        },
      }
    : {}),
}));

/**
 * The synthetic providers: Meta Graph (accounts 1101 and 2201 and their campaigns; 1102 is refused with a permissions
 * error), Tag Manager (the workspace above) and nothing else. Writes and other hosts are refused and counted.
 */
export function evaluationProviders() {
  const state = {requests: [], writes_refused: 0, egress_refused: 0};
  const json = (body, status = 200) => Response.json(body, {status});
  const meta = (url, method) => {
    if (method !== 'GET') {
      state.writes_refused++;
      return json({error: {message: 'The evaluation fixture accepts no Meta write', code: 100}}, 400);
    }
    const [, , object, edge] = url.pathname.split('/');
    const account = /^act_(\d+)$/.exec(object ?? '')?.[1];
    if (account === '1102')
      return json(
        {error: {message: '(#200) Synthetic permissions error', type: 'OAuthException', code: 200, fbtrace_id: 'SYN'}},
        403,
      );
    if (account && metaAccounts[account] && !edge)
      return json({id: object, account_id: account, ...metaAccounts[account], account_status: 1});
    if (account && metaCampaigns[account] && edge === 'campaigns') return json({data: metaCampaigns[account]});
    return json({data: []});
  };
  const tagManager = (url, method) => {
    if (method !== 'GET') {
      state.writes_refused++;
      return json({error: {code: 400, status: 'FAILED_PRECONDITION', message: 'No Tag Manager write'}}, 400);
    }
    const resource = url.pathname.replace('/tagmanager/v2/', '');
    if (resource.startsWith('accounts/45'))
      return json({error: {code: 403, status: 'PERMISSION_DENIED', message: 'Synthetic tag account denial'}}, 403);
    if (resource === 'accounts/44') return json({path: resource, accountId: '44', name: 'Northwind Outdoors'});
    if (resource === 'accounts/44/containers')
      return json({
        container: [{path: gtmContainer, accountId: '44', containerId: '55', name: 'Northwind storefront'}],
      });
    if (resource === gtmContainer)
      return json({
        path: resource,
        accountId: '44',
        containerId: '55',
        name: 'Northwind storefront',
        publicId: 'GTM-NW55',
      });
    if (resource === gtmContainer + '/workspaces') return json({workspace: [gtmWorkspaceRow]});
    if (resource === gtmContainer + '/version_headers') return json({containerVersionHeader: []});
    if (resource === gtmWorkspace) return json(gtmWorkspaceRow);
    if (resource === gtmWorkspace + '/status') return json({workspaceChange: [], mergeConflict: []});
    if (resource === gtmWorkspace + '/tags') return json({tag: gtmTags});
    if (resource === gtmWorkspace + '/triggers') return json({trigger: [gtmTrigger]});
    const row = [...gtmTags, gtmTrigger].find(t => t.path === resource);
    if (row) return json(row);
    const list = {
      variables: 'variable',
      built_in_variables: 'builtInVariable',
      folders: 'folder',
      templates: 'template',
      zones: 'zone',
      clients: 'client',
      transformations: 'transformation',
      gtag_config: 'gtagConfig',
    }[resource.slice(gtmWorkspace.length + 1)];
    if (resource.startsWith(gtmWorkspace + '/') && list) return json({[list]: []});
    // No version was published (version_headers:latest, versions:live): a scoped 404, as Tag Manager answers.
    return json({error: {code: 404, status: 'NOT_FOUND', message: 'Synthetic missing resource'}}, 404);
  };
  const fetcher = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      method = String(init.method ?? 'GET').toUpperCase();
    if (url.hostname === 'graph.facebook.com') {
      state.requests.push({method, host: url.hostname});
      return meta(url, method);
    }
    if (url.hostname === 'tagmanager.googleapis.com') {
      state.requests.push({method, host: url.hostname});
      return tagManager(url, method);
    }
    state.egress_refused++;
    throw new TypeError('The MCP evaluation fixture refuses egress');
  };
  return {state, fetcher};
}

/** A completed report snapshot of one Meta account, bound to the seeding person (operator), as the overview keeps it. */
function snapshot(store, operator, id, {name, client, connection, account, currency, timezone, rows}) {
  const report = {
    state: 'complete',
    captured_at: seededAt,
    created_at: seededAt,
    completed_at: seededAt + 5000,
    config: {
      name,
      client_name: client,
      date_range: {since: '2026-09-01', until: '2026-09-07'},
      metrics: ['spend', 'clicks', 'conversions'],
      custom_metrics: [],
      targets: {},
      objectives: [],
      partial_delivery: 'allow_marked',
      sources: [{platform: 'meta', account_id: account, connection_id: connection}],
    },
    sources: [],
    actor_binding: store.bindJobActor(operator, id),
    row_count: rows.length,
    rows: rows.map(([campaign_id, campaign_name, spend, clicks, conversions]) => ({
      platform: 'meta',
      account_id: account,
      campaign_id,
      campaign_name,
      currency,
      timezone,
      date_from: '2026-09-01',
      date_to: '2026-09-07',
      metrics: {spend, clicks, conversions},
      complete: true,
      captured_at: seededAt,
    })),
  };
  report.job_id = store.enqueue(evaluationTenant, 'report_overview', {report_id: id});
  store.db.prepare("UPDATE jobs SET state='complete' WHERE id=?").run(report.job_id);
  store.putDocument(evaluationTenant, 'overview_report', id, report);
}
/** A captured Google Ads report, as amcp_reporting keeps one: complete, or an export that stopped part-way. */
function capture(store, id, {complete, source, rows}) {
  store.putDocument(evaluationTenant, 'decision_report', id, {
    gateway: 'google_ads_native_action',
    account_id: '4415550101',
    connection_id: connections.northwindGoogle,
    source: 'provider_read',
    captured_at: seededAt,
    source_hash: (complete ? 'c' : 'd').repeat(64),
    semantics: {
      currency: 'EUR',
      timezone: 'Europe/Berlin',
      date_from: '2026-09-01',
      date_to: '2026-09-07',
      attribution: 'Google Ads data-driven attribution',
      conversion_definition: 'metrics.conversions',
      source_name: source,
      complete,
    },
    mapping: {spend: '/metrics/costMicros', entity_name: '/campaign/name'},
    totals: {
      spend: rows.reduce((sum, [, , spend]) => sum + Number(spend), 0).toFixed(2),
      clicks: null,
      conversions: null,
      impressions: null,
      conversion_value: null,
    },
    rows: rows.map(([entity_id, entity_name, spend]) => ({entity_id, entity_name, date: '2026-09-01', spend})),
  });
}
/** A Meta campaign create step: the first step of each seeded plan. */
const campaignStep = (connection, account, name, objective) => ({
  id: 'campaign',
  kind: 'write',
  gateway: 'meta_native_action',
  connection_id: connection,
  account_id: account,
  description: 'Create the paused campaign',
  arguments: {
    action: 'meta_campaign_create',
    payload: {name, objective, status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false},
  },
});

/**
 * A fresh evaluation workspace on a new in-memory store: the four connections, two report snapshots, two captured
 * reports, three campaign plans and four media library assets. `service` serves `actor` (the reader); `providers`
 * counts provider requests, refused writes and refused egress. profile is the contract profile the person's client is served
 * (V2-MCP-06, D26): legacy is every client's today and the committed baseline's; for 2 the person is the OAuth client
 * gency-analyst, whose record opts it in, and every record of the workspace is made for that client (oauth/agency-analyst).
 */
export async function evaluationWorkspace({profile = 'legacy'} = {}) {
  if (!['legacy', 'v2'].includes(profile)) throw Error('MCP_EVAL_PROFILE: the profile is legacy or v2.');
  const userId = profile === 'v2' ? 'oauth/' + person.userId : person.userId,
    operator = {...person, userId, role: 'operator'},
    reader = {...person, userId, role: 'reader'},
    adminActor = {...person, userId, role: 'admin'};
  const store = new Store(':memory:', Buffer.alloc(32, 113).toString('base64'));
  if (profile === 'v2') {
    new WebStore(store, {origin: 'https://amcp.shop', masterKey: Buffer.alloc(32, 113).toString('base64')});
    insertRegisteredClient(
      store,
      person.userId,
      JSON.stringify({
        client_id: person.userId,
        client_name: 'AMCP evaluation-set reference solver',
        contract_profile: 'v2',
      }),
    );
  }
  store.ensureTenant(evaluationTenant);
  const bind = (id, gateway, label, accounts, scopes) =>
    store.putConnection(
      adminActor,
      {id, tenantId: evaluationTenant, gateway, accounts, writeAccounts: accounts, enabled: true, label, scopes},
      {accessToken: 'synthetic-' + id.slice(-1)},
    );
  bind(
    connections.northwindMeta,
    'meta_native_action',
    'Northwind Outdoors (Meta)',
    ['1101', '1102'],
    ['ads_read', 'ads_management'],
  );
  bind(
    connections.bluebellMeta,
    'meta_native_action',
    'Bluebell Bakery (Meta)',
    ['2201'],
    ['ads_read', 'ads_management'],
  );
  bind(
    connections.northwindGoogle,
    'google_ads_native_action',
    'Northwind Outdoors (Google Ads)',
    ['4415550101'],
    ['https://www.googleapis.com/auth/adwords'],
  );
  bind(
    connections.northwindTags,
    'gtm_native_action',
    'Northwind Outdoors (Tag Manager)',
    ['44', '45'],
    ['https://www.googleapis.com/auth/tagmanager.readonly'],
  );
  const providers = evaluationProviders(),
    service = new MirrorService(
      new Registry(),
      store,
      // Synthetic providers have no quota: an assistant's session of dozens of reads is never paced or refused.
      new NativeTransport(providers.fetcher, async () => {}, 30000, 8 * 1024 * 1024, 1e9, 1, 1e9),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
      async () => {
        providers.state.egress_refused++;
        throw new TypeError('The MCP evaluation fixture downloads no media');
      },
    );
  snapshot(store, operator, 'snapshot-northwind-2026-w36', {
    name: 'Northwind weekly performance',
    client: 'Northwind Outdoors',
    connection: connections.northwindMeta,
    account: '1101',
    currency: 'EUR',
    timezone: 'Europe/Berlin',
    rows: [
      ['120001', 'Trail Running Prospecting', 412.5, 830, 12],
      ['120002', 'Winter Jackets Retargeting', 298.1, 410, 19],
      ['120003', 'Brand Awareness Q3', 150, 120, 0],
    ],
  });
  snapshot(store, operator, 'snapshot-bluebell-2026-w36', {
    name: 'Bluebell weekly performance',
    client: 'Bluebell Bakery',
    connection: connections.bluebellMeta,
    account: '2201',
    currency: 'USD',
    timezone: 'America/New_York',
    rows: [
      ['220001', 'Sourdough Launch', 88.4, 240, 6],
      ['220002', 'Holiday Cookies', 61.25, 95, 4],
    ],
  });
  capture(store, 'capture-northwind-google-full', {
    complete: true,
    source: 'Northwind Google Ads campaigns, first September week',
    rows: [
      ['9001', 'Search Brand', '120.40'],
      ['9002', 'Search Generic Boots', '310.75'],
    ],
  });
  capture(store, 'capture-northwind-google-partial', {
    complete: false,
    source: 'Interrupted Google Ads export of 5 September',
    rows: [['9001', 'Search Brand', '61.10']],
  });
  for (const [name, connection, account, objective] of [
    ['Northwind autumn traffic test', connections.northwindMeta, '1101', 'OUTCOME_TRAFFIC'],
    ['Northwind winter retargeting draft', connections.northwindMeta, '1101', 'OUTCOME_SALES'],
    ['Bluebell holiday lead form', connections.bluebellMeta, '2201', 'OUTCOME_LEADS'],
  ]) {
    const created = await service.call(
      'amcp_campaign',
      {
        action: 'create',
        name,
        brief: 'A paused campaign drafted for the evaluation workspace.',
        steps: [campaignStep(connection, account, name, objective)],
      },
      operator,
    );
    if (!created.success) throw Error('Seeding a plan failed: ' + created.error?.code);
  }
  for (const [id, name, connection, account, original, media_type] of [
    ['asset-0001', 'Trail shoe hero image', connections.northwindMeta, '1101', 'a', 'image'],
    ['asset-0002', 'Trail shoe hero image', connections.northwindMeta, '1102', 'a', 'image'],
    ['asset-0003', 'Winter jacket lookbook', connections.northwindMeta, '1101', 'b', 'image'],
    ['asset-0004', 'Cookie box unboxing', connections.bluebellMeta, '2201', 'c', 'video'],
  ])
    store.putDocument(evaluationTenant, 'workspace_asset', id, {
      platform: 'meta',
      account_id: account,
      connection_id: connection,
      media_id: 'synthetic-media-' + id,
      name,
      sha256: original.repeat(64),
      original_sha256: original.repeat(64),
      media_type,
      mime_type: media_type === 'image' ? 'image/png' : 'video/mp4',
    });
  // The seeding left provider counters untouched: plans are drafts and nothing was read.
  providers.state.requests.length = 0;
  return {store, service, actor: reader, providers, close: () => store.close()};
}
