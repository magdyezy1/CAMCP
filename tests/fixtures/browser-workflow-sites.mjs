import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {createWebsite} from '../../dist/server/website.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
import {snapchatAssetUsageFixture} from './snapchat-asset-usage-data.mjs';
import {wooSourceFixture} from './woocommerce-source-data.mjs';
import {wooVariationsFixture} from './woocommerce-variations-data.mjs';
import {wooInventoryBrowserFixture} from './woocommerce-inventory-data.mjs';
import {wooConnectionFixture, wooConnectionInput} from './woocommerce-connection-data.mjs';
import {catalogComparisonData, catalogComparisonInput} from './catalog-comparison-data.mjs';
import {measurementEventReport, measurementEventFixtureConnection} from './measurement-events-data.mjs';
import {retainedEvidence, evidenceId, evidenceConnection} from './retained-evidence-data.mjs';
import {googleKeywordFixture} from './google-keyword-evidence-data.mjs';
import {googleDeviceFixture} from './google-device-evidence-data.mjs';
import {xCatalogInventoryFixture} from './x-catalog-selection-inventory-data.mjs';
import {googleHourFixture} from './google-hour-evidence-data.mjs';
import {googleCountryFixture} from './google-country-evidence-data.mjs';
import {providerCaptureRefusalFixture, providerRefusalMessages} from './provider-capture-refusal-data.mjs';
import {measurementReadRefusalFixture} from './measurement-read-refusal-data.mjs';
import {workspaceFormRefusalFixture} from './workspace-form-refusal-data.mjs';
import {conversionMetadataFixture, conversionMetadataRows} from './linkedin-conversion-metadata-data.mjs';
import {portfolioRefusalFixture} from './portfolio-refusal-data.mjs';
import {workerHealthBrowserFixture} from './worker-health-browser.mjs';
import {reconciliationFixture, reconciliationRows, reconciliationRow} from './portfolio-reconciliation-data.mjs';
import {conditionalProgramFixture} from './conditional-program-data.mjs';
import {overviewGranularityFixture} from './overview-granularity-data.mjs';
import {syntheticWriteJourneyFixture, spendPolicyEditFixture, exportOutcomesFixture} from './synthetic-writes-data.mjs';

/** Fixture kinds whose own fake provider accepts its declared synthetic mutations (QA-03, owner decision D26). */
export const syntheticWriteKinds = Object.freeze(['write-journey', 'spend-policy-edit', 'export-outcomes']);

/** Owned in-memory website. Every provider response is synthetic; all other egress is refused. */
export async function browserWorkflowSite(kind) {
  assert.ok(
    [
      'empty',
      ...syntheticWriteKinds,
      'granular-reporting',
      'conditional-programs',
      'conditional-programs-denied',
      'conditional-programs-stale',
      'worker-health',
      'portfolio-comparison',
      'portfolio-comparison-error',
      'portfolio-comparison-stale',
      'portfolio-diagnostic-google',
      'portfolio-diagnostic-meta',
      'portfolio-diagnostic-linkedin',
      'portfolio-diagnostic-snapchat',
      'portfolio-diagnostic-tiktok',
      'portfolio-diagnostic-x',
      'measurement-navigation',
      'measurement-navigation-linked',
      'measurement-trace',
      'conversion-metadata-owned',
      'conversion-metadata-unknown',
      'conversion-metadata-invalid',
      'conversion-metadata-stale',
      'workspace-form-gtm-error',
      'workspace-form-gtm-stale',
      'workspace-form-conversions-error',
      'workspace-form-conversions-stale',
      'snapchat',
      'woocommerce',
      'woocommerce-variations',
      'woocommerce-inventory',
      'woocommerce-inventory-error',
      'woocommerce-inventory-stale',
      'woocommerce-connection',
      'woocommerce-connection-error',
      'woocommerce-connection-stale',
      'catalog',
      'catalog-groups',
      'measurement-events',
      'measurement-events-error',
      'measurement-events-stale',
      'measurement-identity-error',
      'measurement-identity-stale',
      'measurement-events-permission',
      'measurement-identity-permission',
      'retained-evidence',
      'google-keyword',
      'google-keyword-error',
      'google-keyword-stale',
      'google-device',
      'google-hour',
      'google-hour-error',
      'google-hour-stale',
      'google-country',
      'google-country-error',
      'google-country-stale',
      'x-catalog-inventory',
      'x-catalog-inventory-error',
      'x-catalog-inventory-stale',
      'provider-refusal-meta',
      'provider-refusal-linkedin',
      'provider-refusal-tiktok',
      'provider-refusal-snapchat',
    ].includes(kind),
    'Select a fixed synthetic browser fixture',
  );
  const cleanup = [],
    native = [];
  let refused = 0,
    writes = 0,
    fixture,
    keyByte = 149;
  const blocked = async () => {
    refused++;
    throw Error('Synthetic browser fixture refuses external requests');
  };
  if (kind === 'granular-reporting') {
    fixture = overviewGranularityFixture();
    keyByte = fixture.keyByte;
    cleanup.push(fixture.close);
  } else if (syntheticWriteKinds.includes(kind)) {
    fixture =
      kind === 'write-journey'
        ? syntheticWriteJourneyFixture()
        : kind === 'spend-policy-edit'
          ? spendPolicyEditFixture()
          : exportOutcomesFixture();
    keyByte = fixture.keyByte;
    cleanup.push(fixture.close);
  } else if (kind.startsWith('conditional-programs')) {
    fixture = conditionalProgramFixture();
    keyByte = fixture.keyByte;
    cleanup.push(fixture.close);
    if (kind.endsWith('-denied'))
      fixture.reply(() =>
        Response.json(
          {status: 403, code: 'ACCESS_DENIED', message: 'Synthetic private product refusal'},
          {status: 403, headers: {'x-li-uuid': 'li-uuid-browser-1'}},
        ),
      );
    let held, entered;
    fixture.programGate = {
      hold() {
        return new Promise(resolve => {
          entered = resolve;
          fixture.hook(
            () =>
              new Promise(release => {
                held = release;
                entered();
              }),
          );
        });
      },
      release() {
        fixture.hook(() => {});
        held();
      },
      input: fixture.input(),
    };
  } else if (kind === 'snapchat') {
    keyByte = 147;
    fixture = snapchatAssetUsageFixture(
      {after: callback => cleanup.push(callback)},
      {asset: {uploaded_sha256: 'e'.repeat(64)}},
    );
  } else if (kind.startsWith('woocommerce-connection')) {
    fixture = wooConnectionFixture();
    keyByte = fixture.keyByte;
    cleanup.push(fixture.close);
    let fault = false;
    fixture.respond((url, options, n, native) =>
      fault
        ? new Response(JSON.stringify({message: 'PRIVATE-SETUP-NATIVE', consumer_secret: 'cs_setupSyntheticSecret'}), {
            status: 403,
            headers: {'content-type': 'application/json'},
          })
        : native(url),
    );
    fixture.setFault = value => {
      fault = value;
    };
  } else if (kind.startsWith('woocommerce-inventory')) {
    keyByte = 41;
    fixture = wooInventoryBrowserFixture();
    cleanup.push(fixture.close);
  } else if (kind === 'woocommerce' || kind === 'woocommerce-variations') {
    keyByte = 41;
    fixture = kind === 'woocommerce' ? wooSourceFixture() : wooVariationsFixture();
    cleanup.push(fixture.close);
    if (kind === 'woocommerce-variations')
      fixture.store.putConnection(
        {...fixture.actor, role: 'admin'},
        {
          id: 'meta-login',
          tenantId: fixture.actor.tenantId,
          gateway: 'meta_native_action',
          accounts: ['123'],
          enabled: true,
          label: 'Synthetic Meta destination',
          scopes: [],
        },
        {accessToken: 'synthetic-browser-meta'},
      );
  } else if (kind.startsWith('portfolio-comparison')) {
    keyByte = 187;
    fixture = reconciliationFixture();
    const reset = () => {
      const start = fixture.requests.length;
      fixture.rows(count => {
        const phase = count - start;
        if (kind !== 'portfolio-comparison' && phase === 2) {
          const rows = reconciliationRows();
          rows[1].customer.currencyCode = 'SAR';
          return rows;
        }
        if (phase !== 3) return reconciliationRows();
        const changed = reconciliationRow();
        changed.campaign.name = 'Changed original العربية <img>';
        changed.campaignBudget.amountMicros = '9007199254740995';
        return [changed, reconciliationRow('9007199254740997'), reconciliationRow('9007199254740999')];
      });
    };
    const recover = () => {
      const start = fixture.requests.length;
      fixture.rows(count => {
        if (count - start !== 2) return reconciliationRows();
        const changed = reconciliationRow();
        changed.campaign.name = 'Changed original العربية <img>';
        changed.campaignBudget.amountMicros = '9007199254740995';
        return [changed, reconciliationRow('9007199254740997'), reconciliationRow('9007199254740999')];
      });
    };
    fixture.comparison = {reset, recover};
    cleanup.push(fixture.close);
  } else if (kind.startsWith('portfolio-diagnostic-')) {
    fixture = portfolioRefusalFixture(kind.slice('portfolio-diagnostic-'.length));
    keyByte = fixture.keyByte;
    cleanup.push(fixture.close);
  } else if (kind.startsWith('provider-refusal-')) {
    fixture = providerCaptureRefusalFixture(kind.slice('provider-refusal-'.length));
    keyByte = fixture.keyByte;
    cleanup.push(fixture.close);
  } else if (
    ['measurement-navigation', 'measurement-navigation-linked'].includes(kind) ||
    kind.startsWith('conversion-metadata-')
  ) {
    fixture = conversionMetadataFixture(
      kind.endsWith('-unknown') ? 'unknown' : kind.endsWith('-invalid') ? 'invalid' : 'owned',
    );
    keyByte = fixture.keyByte;
    cleanup.push(fixture.close);
  } else if (kind.startsWith('workspace-form-')) {
    fixture = workspaceFormRefusalFixture(kind.includes('-gtm-') ? 'gtm' : 'conversions', {
      recovery: kind.endsWith('-error'),
    });
    keyByte = fixture.keyByte;
    cleanup.push(fixture.close);
  } else if (kind.startsWith('measurement-') && !['measurement-events', 'measurement-trace'].includes(kind)) {
    fixture = measurementReadRefusalFixture(kind.startsWith('measurement-identity-') ? 'identity' : 'events', {
      recovery: kind.endsWith('-error') || kind.endsWith('-permission'),
      permissionDenied: kind.endsWith('-permission'),
    });
    keyByte = fixture.keyByte;
    cleanup.push(fixture.close);
  } else if (['google-country', 'google-country-error', 'google-country-stale'].includes(kind)) {
    keyByte = 186;
    fixture = googleCountryFixture();
    if (kind !== 'google-country')
      fixture.edit((body, data, count) => {
        const phase = ((count - 1) % 7) + 1;
        assert.equal(/ FROM customer(?: |$)/.test(body.query), [1, 4, 7].includes(phase));
        if (phase === 2) {
          const invalid = structuredClone(data);
          delete invalid.results[0].geographicView.locationType;
          return invalid;
        }
        return data;
      });
    cleanup.push(fixture.close);
  } else if (['google-hour', 'google-hour-error', 'google-hour-stale'].includes(kind)) {
    keyByte = 165;
    fixture = googleHourFixture();
    if (kind !== 'google-hour')
      fixture.edit((body, data, count) => {
        const phase = ((count - 1) % 7) + 1;
        assert.equal(/ FROM customer(?: |$)/.test(body.query), [1, 4, 7].includes(phase));
        if (phase === 2) {
          const invalid = structuredClone(data);
          delete invalid.results[0].segments.hour;
          return invalid;
        }
        return data;
      });
    cleanup.push(fixture.close);
  } else if (kind.startsWith('x-catalog-inventory')) {
    keyByte = 88;
    fixture = xCatalogInventoryFixture();
    cleanup.push(() => fixture.store.close());
  } else if (kind === 'google-device') {
    keyByte = 165;
    fixture = googleDeviceFixture();
    cleanup.push(fixture.close);
  } else if (['google-keyword', 'google-keyword-error', 'google-keyword-stale'].includes(kind)) {
    keyByte = 163;
    fixture = googleKeywordFixture();
    if (kind !== 'google-keyword')
      fixture.edit((body, data, count) => {
        const phase = ((count - 1) % 7) + 1;
        assert.equal(/ FROM customer(?: |$)/.test(body.query), [1, 4, 7].includes(phase));
        if (phase === 2) {
          const invalid = structuredClone(data);
          invalid.results[0].adGroupCriterion.keyword.matchType = 'UNKNOWN';
          return invalid;
        }
        return data;
      });
    cleanup.push(fixture.close);
  } else {
    const actor = {tenantId: 'synthetic-browser-' + kind, userId: 'fixture', role: 'admin'},
      store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
      data = catalogComparisonData(
        kind === 'catalog-groups'
          ? {
              ...catalogComparisonInput,
              products: catalogComparisonInput.products.map((product, i) => ({
                ...product,
                ...(i === 0 ? {price: '0012.34'} : {}),
                retailer_product_group_id: 'GROUP-' + String(i + 1).padStart(3, '0'),
              })),
            }
          : undefined,
      );
    if (kind === 'catalog-groups') {
      data.products.get('002').retailer_product_group_id = 'OLD-GROUP';
      delete data.products.get('004').retailer_product_group_id;
    }
    cleanup.push(() => store.close());
    const transport =
      kind === 'measurement-events'
        ? async (raw, init) => {
            const url = new URL(String(raw));
            // The exact GA4 report POST is a read. All event senders and other paths are refused.
            if (
              url.origin !== 'https://analyticsdata.googleapis.com' ||
              url.pathname !== '/v1beta/properties/123:runRealtimeReport' ||
              init.method !== 'POST'
            ) {
              writes++;
              throw Error('Synthetic event fixture refuses provider effects and unqualified reads');
            }
            const body = JSON.parse(String(init.body));
            assert.equal(body.metrics[0].name, 'eventCount');
            assert.equal(body.limit, '1000');
            native.push({method: init.method, path: url.pathname});
            return Response.json(measurementEventReport());
          }
        : kind === 'catalog' || kind === 'catalog-groups'
          ? async (raw, init) => {
              const url = new URL(String(raw));
              if (init.method !== 'GET') writes++;
              assert.equal(init.method, 'GET', 'Browser fixture refuses provider writes');
              assert.equal(url.origin, 'https://graph.facebook.com');
              native.push({method: init.method, path: url.pathname});
              return Response.json(data.response(url));
            }
          : blocked;
    fixture = {
      store,
      actor,
      service: new MirrorService(new Registry(), store, new NativeTransport(transport), undefined, {
        allowWrites: false,
      }),
    };
    if (kind === 'catalog' || kind === 'catalog-groups')
      store.putConnection(
        actor,
        {
          id: catalogComparisonInput.connection_id,
          tenantId: actor.tenantId,
          gateway: catalogComparisonInput.gateway,
          accounts: [catalogComparisonInput.account_id],
          writeAccounts: [],
          enabled: true,
          label: 'Synthetic catalog destination',
          scopes: ['ads_read'],
        },
        {accessToken: 'synthetic-browser-catalog'},
      );
    if (['measurement-events', 'measurement-trace'].includes(kind))
      store.putConnection(
        actor,
        {
          id: measurementEventFixtureConnection,
          tenantId: actor.tenantId,
          gateway: 'ga4_native_action',
          accounts: ['123'],
          writeAccounts: [],
          enabled: true,
          label: 'Synthetic GA4 aggregate reader',
          scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
        },
        {accessToken: 'synthetic-browser-event-read'},
      );
    if (kind === 'retained-evidence') {
      store.putConnection(
        actor,
        {
          id: evidenceConnection,
          tenantId: actor.tenantId,
          gateway: 'google_ads_native_action',
          accounts: ['123'],
          writeAccounts: [],
          enabled: true,
          label: 'Synthetic retained source',
          scopes: ['https://www.googleapis.com/auth/adwords'],
        },
        {accessToken: 'synthetic-browser-retained-read'},
      );
      store.putDocument(actor.tenantId, 'decision_report', evidenceId, retainedEvidence());
    }
  }
  let app;
  const listener = await listenForFetch((req, res) => {
    if (app) app(req, res);
    else res.writeHead(503).end();
  });
  const origin = 'http://127.0.0.1:' + listener.address().port,
    options = {
      origin,
      masterKey: Buffer.alloc(32, keyByte).toString('base64'),
      tenantId: fixture.actor.tenantId,
      authEnv: {},
      fetcher: kind === 'granular-reporting' ? fixture.fetcher : blocked,
    },
    {web, accounts} = createWebsite(fixture.store, options, false, fixture.service),
    user = accounts.newUser('Synthetic browser reader', null, null, true),
    role =
      ['empty', 'worker-health', 'granular-reporting', ...syntheticWriteKinds].includes(kind) ||
      kind.startsWith('woocommerce-connection')
        ? 'owner'
        : 'viewer';
  fixture.store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(fixture.actor.tenantId, user.id, role, Date.now());
  // SEC-05: report files are for operators unless the workspace owner allows viewer downloads. The retained-evidence
  // and Google evidence journeys download the evidence workbook as this viewer, so their synthetic owner has allowed
  // it (the account_settings/exports record that saveExportPolicy writes).
  if (kind === 'retained-evidence' || kind.startsWith('google-'))
    fixture.store.putDocument(fixture.actor.tenantId, 'account_settings', 'exports', {
      viewer_downloads: true,
      updated_at: Date.now(),
      updated_by: 'synthetic-owner',
    });
  const session = accounts.session(user, fixture.actor.tenantId);
  const workerHealth =
    kind === 'worker-health' ? workerHealthBrowserFixture(fixture.store, fixture.actor.tenantId) : undefined;
  app = createHttpApp(fixture.service, fixture.store, {website: options});
  const csv =
    'retailer_id,name,price,currency,image_url' +
    (kind === 'catalog-groups' ? ',retailer_product_group_id' : '') +
    '\n' +
    catalogComparisonInput.products
      .map((product, i) =>
        [
          product.retailer_id,
          product.name,
          kind === 'catalog-groups' && i === 0 ? '0012.34' : product.price,
          product.currency,
          product.image_url,
          ...(kind === 'catalog-groups' ? ['GROUP-' + String(i + 1).padStart(3, '0')] : []),
        ].join(','),
      )
      .join('\n') +
    '\n';
  // The person the browser signs in as: synthetic journeys seed their plans, policies and snapshots for this actor.
  const webActor = session.actor;
  return {
    origin,
    tenantId: fixture.actor.tenantId,
    cookie: {name: web.cookieName, value: session.id, url: origin},
    // For Playwright-free HTTP checks of the same journeys (tests/browser-synthetic-writes.test.mjs).
    csrf: session.csrf,
    syntheticWrites: syntheticWriteKinds.includes(kind),
    writeJourney:
      kind === 'write-journey'
        ? {
            seed: outcome => fixture.seed(webActor, outcome),
            changeAccountState: () => fixture.changeAccountState(),
            plan: id => fixture.plan(webActor, id),
            transport: fixture.transport,
          }
        : undefined,
    spendPolicy:
      kind === 'spend-policy-edit'
        ? {reset: () => fixture.reset(webActor), stored: () => fixture.stored(webActor)}
        : undefined,
    exportOutcomes:
      kind === 'export-outcomes'
        ? {seed: () => fixture.seed(webActor), workOnce: () => fixture.workOnce(), tab: fixture.tab}
        : undefined,
    workerHealth,
    conditionalProgram: fixture.programGate,
    granular:
      kind === 'granular-reporting'
        ? {
            workOnce: () => fixture.worker.once(),
            tabs: fixture.tabs,
            requests: fixture.requests,
            store: fixture.store,
            tenant: fixture.actor.tenantId,
          }
        : undefined,
    wooConnection: kind.startsWith('woocommerce-connection')
      ? {
          input: wooConnectionInput(),
          setFault: fixture.setFault,
          connectionCounts: () => ({
            connections: fixture.store.listConnections(fixture.actor.tenantId).length,
            proofs: fixture.store.documents(fixture.actor.tenantId, 'website_connection').length,
          }),
        }
      : undefined,
    csv: kind.startsWith('x-catalog-inventory') ? fixture.csv : Buffer.from(csv),
    catalogInventory: kind.startsWith('x-catalog-inventory')
      ? {
          products: fixture.input.products,
          setFault: fixture.setFault,
          artifactCounts: () => ({
            drafts: fixture.store.documents(fixture.actor.tenantId, 'campaign_run').length,
            reviews: fixture.store.documents(fixture.actor.tenantId, 'write_review').length,
            removal_previews: fixture.store.documents(fixture.actor.tenantId, 'x_catalog_removal_preview').length,
          }),
        }
      : undefined,
    wooInventory: kind.startsWith('woocommerce-inventory')
      ? {
          setFault: fixture.setFault,
          artifactCounts: () => ({
            drafts: fixture.store.documents(fixture.actor.tenantId, 'campaign_run').length,
            reviews: fixture.store.documents(fixture.actor.tenantId, 'write_review').length,
            reports: fixture.store.documents(fixture.actor.tenantId, 'decision_report').length,
          }),
        }
      : undefined,
    supplierCSV: Buffer.from(
      'SKU,Title,Source price,Currency,Image,Parent group,Private notes\n' +
        catalogComparisonInput.products
          .map((product, i) =>
            [
              product.retailer_id,
              product.name,
              i === 0 ? '0012.34' : product.price,
              product.currency,
              product.image_url,
              'GROUP-' + String(i + 1).padStart(3, '0'),
              'UNSELECTED-PRIVATE-SUPPLIER',
            ].join(','),
          )
          .join('\n') +
        '\n',
    ),
    portfolioRefusal: kind.startsWith('portfolio-diagnostic-')
      ? {provider: fixture.provider, input: fixture.input, message: fixture.message, code: fixture.code}
      : undefined,
    portfolioComparison: fixture.comparison,
    captureRefusal: kind.startsWith('provider-refusal-')
      ? {
          provider: kind.slice('provider-refusal-'.length),
          input: fixture.input,
          message: providerRefusalMessages[kind.slice('provider-refusal-'.length)],
        }
      : undefined,
    conversionMetadata: kind.startsWith('conversion-metadata-')
      ? {
          scenario: kind.slice('conversion-metadata-'.length),
          input: fixture.input,
          reset: () => fixture.setRows(conversionMetadataRows(fixture.scenario)),
          recover: () => fixture.setRows(conversionMetadataRows('owned')),
        }
      : undefined,
    workspaceFormRefusal: kind.startsWith('workspace-form-')
      ? {kind: fixture.kind, input: fixture.input, message: fixture.message, code: fixture.code}
      : undefined,
    measurementNavigation: ['measurement-navigation', 'measurement-navigation-linked'].includes(kind)
      ? {input: fixture.input}
      : undefined,
    measurementReadRefusal:
      kind.startsWith('measurement-') &&
      !['measurement-events', 'measurement-trace'].includes(kind) &&
      !kind.startsWith('measurement-navigation')
        ? {kind: fixture.kind, input: fixture.input, message: fixture.message, code: fixture.code}
        : undefined,
    counts: () => ({
      nativeReads: fixture.requests?.length ?? fixture.calls?.length ?? native.length,
      refused,
      writes: kind.startsWith('x-catalog-inventory') || syntheticWriteKinds.includes(kind) ? fixture.writes() : writes,
      // The fixture's own synthetic mutations, never forwarded (QA-03): the write journeys' creates and the owned
      // synthetic Sheets batches. Provider writes stay in `writes`, which must remain zero.
      syntheticWrites: syntheticWriteKinds.includes(kind)
        ? fixture.syntheticWrites()
        : kind === 'granular-reporting'
          ? fixture.requests.filter(r => r.url.hostname === 'sheets.googleapis.com' && r.method === 'POST').length
          : 0,
    }),
    evidenceCounts: () => ({
      reports: fixture.store.documents(fixture.actor.tenantId, 'decision_report').length,
      plans: fixture.store.documents(fixture.actor.tenantId, 'campaign_plan').length,
      reviews: fixture.store.documents(fixture.actor.tenantId, 'write_review').length,
    }),
    close: async () => {
      listener.closeAllConnections();
      await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
      for (const callback of cleanup.reverse()) await callback();
    },
  };
}
