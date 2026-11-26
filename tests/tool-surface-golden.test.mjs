// always-run: the golden of every tool of the surface and its schema
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
// First of the AMCP imports: it unsets the deployment's version settings before any dist module loads (Meta's is read
// at load), so the golden pins AMCP's defaults whatever settings the process starts with.
import './helpers/default-version-settings.mjs';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {Introspection} from '../dist/src/introspection.js';
import {
  amcpNote,
  delegatedWriteGateways,
  describedTool,
  describesOwnText,
  listedDescription,
  mediaListing,
  ownedDescription,
  providerJobQualifier,
  readOnlyQualifier,
  readOnlyTail,
  unavailableSentence,
  withoutExecutableActions,
} from '../dist/src/tool-notes.js';
import {effectiveProviderContract, providerContracts} from '../dist/src/provider-contracts.js';
import {providerContractReference, providerContractView} from '../dist/src/contract-evidence.js';
import {acceptedVersions, providerSunset, sentVersion, sunsetStatus} from '../dist/src/provider-sunsets.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

/**
 * ARC-01 wave 4c round 6 (w4c-arc6-versions) golden: what tools/list, amcp_tool_help, LIST_ACTIONS, DESCRIBE_ACTION and
 * the provider contracts say of every gateway, pinned before each provider's tool notes, catalog listing and API
 * version moved into its adapter's hooks (src/<provider>-adapter.ts). Text is pinned whole and larger answers by the
 * SHA-256 of their JSON, so a byte of difference fails. It reads only public functions, so it passes on the build
 * before and after the move. Regenerate only for a deliberate change:
 * AMCP_UPDATE_GOLDEN=1 node --test tests/tool-surface-golden.test.mjs
 */
const goldenFile = new URL('./fixtures/tool-surface-golden.json', import.meta.url);
// Every parked gateway is listed too: Criteo, WooCommerce and Amazon Ads.
offerParkedProviders('criteo', 'woocommerce', 'amazon');
const registry = new Registry(),
  definitions = [...registry.tools.values()],
  gateways = definitions.map(t => t.name);

const digest = value => {
  if (value === undefined) return {undefined: true};
  const text = JSON.stringify(value);
  return {sha256: crypto.createHash('sha256').update(text).digest('hex'), length: text.length};
};
/** A value as the golden keeps it: short text whole, anything else by digest. */
const pin = value =>
  value === undefined
    ? {undefined: true}
    : typeof value === 'boolean' || (typeof value === 'string' && value.length <= 800)
      ? value
      : digest(value);
/** A value kept whole, for an outcome a digest covers. */
const whole = value => (value === undefined ? {undefined: true} : value);
const outcome = (fn, keep = pin) => {
  try {
    return {returns: keep(fn())};
  } catch (error) {
    return {throws: {name: error.name, code: error.code, message: error.message, details: digest(error.details)}};
  }
};

const strict = {mode: 'strict', flags: {}};
const optionSets = {
  strict,
  enhanced: {mode: 'enhanced', flags: {}},
  enhanced_pagination: {mode: 'enhanced', flags: {catalogPagination: true}},
  enhanced_envelope: {mode: 'enhanced', flags: {catalogEnvelope: true}},
  enhanced_fields: {mode: 'enhanced', flags: {catalogFields: true, scopeMetadata: true, confirmationMetadata: true}},
  enhanced_all: {
    mode: 'enhanced',
    flags: {
      catalogEnvelope: true,
      catalogPagination: true,
      catalogFields: true,
      dryRunSchemaDefault: true,
      uniformIdempotency: true,
      scopeMetadata: true,
      confirmationMetadata: true,
      nativeRequests: true,
      compactSchemas: true,
    },
  },
};

/** The tool notes of one definition, with the captured texts a caller can pass. */
function toolNotes(tool) {
  const captured = {
    own: undefined,
    help: typeof tool.help?.description === 'string' ? tool.help.description : undefined,
    other: 'A captured description that names amcp_write and amcp_write inspect.',
  };
  const out = {
    amcp_note: outcome(() => amcpNote(tool)),
    listed: outcome(() => listedDescription(tool)),
    listed_read_only: outcome(() => listedDescription(tool, true)),
    tail: outcome(() => readOnlyTail(listedDescription(tool))),
    tail_jobs: outcome(() => readOnlyTail(listedDescription(tool, true), true)),
    media: outcome(() => mediaListing(tool.name)),
    media_read_only: outcome(() => mediaListing(tool.name, true)),
    unavailable: outcome(() => unavailableSentence(tool.name)),
  };
  for (const [kind, text] of Object.entries(captured)) {
    if (kind === 'help' && text === undefined) continue;
    const args = kind === 'own' ? [tool] : [tool, text];
    out['described_' + kind] = outcome(() => describedTool(...args));
    out['owned_' + kind] = outcome(() => ownedDescription(...args));
    out['own_text_' + kind] = outcome(() => describesOwnText(...args));
  }
  return out;
}
/** Definitions no registry holds: each gateway as a direct and as a delegated tool, and AMCP's other tool names. */
function syntheticDefinitions() {
  const names = [
    ...gateways,
    'amcp_write',
    'amcp_campaign',
    'amcp_media',
    'amcp_reporting',
    'amcp_workspace',
    'unknown_native_action',
  ];
  return names.flatMap(name => [
    {
      name,
      mode: 'direct',
      description: 'Captured text of ' + name + '.',
      inputSchema: {type: 'object', properties: {action: {}, dry_run: {}, confirmed: {}, compact: {}}},
    },
    {
      name,
      mode: 'delegated',
      description: 'Captured text of ' + name + '.',
      inputSchema: {type: 'object', properties: {operation: {}, arguments: {}}},
    },
  ]);
}

function serviceListings() {
  const policies = {
    read_only: undefined,
    writes: {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
    provider_jobs: {allowWrites: false, maxBudgetChange: 0, requireBeforeState: true, providerJobs: true},
  };
  const out = {};
  for (const [policyName, policy] of Object.entries(policies))
    for (const [optionsName, options] of Object.entries({
      strict,
      full_descriptions: {mode: 'strict', flags: {compactDescriptions: false}},
      enhanced_all: optionSets.enhanced_all,
    })) {
      const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64'));
      try {
        const transport = new NativeTransport(async () => {
            throw new Error('no provider request is expected');
          }),
          service = new MirrorService(registry, store, transport, options, policy),
          tools = service.listTools();
        // The listed text whole for the default options; the other options by digest.
        out[policyName + '/' + optionsName] = {
          names: tools.map(t => t.name),
          ...(options === strict
            ? {descriptions: Object.fromEntries(tools.map(t => [t.name, pin(t.description)]))}
            : {descriptions: digest(tools.map(t => t.description))}),
          whole: digest(tools),
        };
      } finally {
        store.close();
      }
    }
  return out;
}

function introspection() {
  const intro = new Introspection(registry),
    inputs = {
      none: {},
      limit: {limit: 3},
      offset: {limit: 2, offset: 5},
      cursor: {limit: 2, cursor: 4},
      both: {limit: 2, offset: 3, cursor: 6},
      search: {search: 'campaign', limit: 2},
      category: {category: 'a', limit: 2},
      read_only: {read_only: true, limit: 2},
      service: {service: 'CampaignService', limit: 2},
      rpc: {surface: 'rpc', limit: 1},
      legacy: {surface: 'legacy', limit: 1},
      all: {surface: 'all', limit: 1},
      wide: {limit: 1000},
      past_end: {offset: 100000, cursor: 100000},
      zero: {limit: 0},
    };
  const out = {list: {}, describe: {}, catalog: {}};
  // One digest per gateway and options of every input's whole answer.
  for (const gateway of [...gateways, 'unknown_native_action'])
    for (const [optionsName, options] of Object.entries(optionSets))
      out.list[gateway + '/' + optionsName] = digest(
        Object.fromEntries(
          Object.entries(inputs).map(([inputName, input]) => [
            inputName,
            outcome(() => intro.list(gateway, structuredClone(input), options), whole),
          ]),
        ),
      );
  const targets = gateway => {
    const actions = registry.catalogs.get(gateway)?.actions ?? [];
    return [
      ...actions.slice(0, 3).map(a => a.name),
      ...actions.slice(0, 2).flatMap(a => a.aliases.filter(alias => alias !== a.name).slice(0, 1)),
      ...Object.keys(registry.data.descriptions)
        .filter(key => key.startsWith(gateway + '/'))
        .map(key => key.slice(gateway.length + 1)),
      'meta_ad_account_id_adlabels_get',
      'NO_SUCH_ACTION',
    ];
  };
  for (const gateway of [...gateways, 'unknown_native_action']) {
    for (const target of new Set(targets(gateway)))
      out.describe[gateway + '/' + target] = outcome(() => intro.describe(gateway, {target_action: target}));
    out.describe[gateway + '/(missing)'] = outcome(() => intro.describe(gateway, {}));
    const catalogInputs = {
      list: {action: 'LIST_ACTIONS'},
      page: {action: 'LIST_ACTIONS', limit: 5, offset: 7},
      search: {action: 'LIST_ACTIONS', search: 'campaign', limit: 3},
      reads: {action: 'LIST_ACTIONS', read_only: true, limit: 3},
      writes: {action: 'LIST_ACTIONS', read_only: false, limit: 3},
      unknown_key: {action: 'LIST_ACTIONS', cursor: 1},
      bad_limit: {action: 'LIST_ACTIONS', limit: 0},
      bad_search: {action: 'LIST_ACTIONS', search: 7},
      bad_read_only: {action: 'LIST_ACTIONS', read_only: 'yes'},
      describe_missing: {action: 'DESCRIBE_ACTION'},
      ...Object.fromEntries(
        targets(gateway)
          .slice(0, 3)
          .map((target, i) => ['describe_' + i, {action: 'DESCRIBE_ACTION', target_action: target}]),
      ),
    };
    out.catalog[gateway] = digest(
      Object.fromEntries(
        Object.entries(catalogInputs).map(([inputName, input]) => [
          inputName,
          outcome(() => intro.catalogRequest(gateway, structuredClone(input)), whole),
        ]),
      ),
    );
  }
  return out;
}

function catalogAnswers() {
  const out = {list_tools: {}, help: {}};
  for (const [optionsName, options] of Object.entries(optionSets)) {
    const tools = registry.listTools(options);
    out.list_tools[optionsName] = {descriptions: digest(tools.map(t => t.description)), whole: digest(tools)};
  }
  out.help.discovery = outcome(() => registry.help({}, strict));
  for (const gateway of [...gateways, 'unknown_native_action'])
    for (const [optionsName, options] of Object.entries({strict, enhanced_all: optionSets.enhanced_all}))
      out.help[gateway + '/' + optionsName] = outcome(() => registry.help({gateway}, options), digest);
  return out;
}

function contracts() {
  const ids = providerContracts.map(c => String(c.id)),
    // A fixed clock: the sunset alarms are a function of the day.
    now = Date.parse('2026-10-30T00:00:00Z'),
    plans = {
      none: undefined,
      linkedin_sent: {gateway: 'linkedin_native_action', headers: {'LinkedIn-Version': '202609'}},
      linkedin_other: {gateway: 'linkedin_native_action', headers: {'LinkedIn-Version': '202605'}},
      no_header: {gateway: 'linkedin_native_action', headers: {}},
    };
  const out = {table: digest(providerContracts), effective: {}, view: {}, reference: {}, sunsets: {}};
  for (const id of [...ids, 'unknown'])
    for (const sent of [undefined, '202609', '202605'])
      out.effective[id + '/' + (sent ?? 'none')] = outcome(() => effectiveProviderContract(id, sent));
  for (const gateway of [...gateways, 'google_drive_native_action', 'google_sheets_native_action', 'unknown'])
    for (const [planName, plan] of Object.entries(plans)) {
      out.view[gateway + '/' + planName] = outcome(() => providerContractView(gateway, plan), digest);
      out.reference[gateway + '/' + planName] = outcome(() => providerContractReference(gateway, plan), digest);
    }
  for (const id of [...ids, 'unknown'])
    out.sunsets[id] = {
      sent: outcome(() => sentVersion(id)),
      accepted: outcome(() => acceptedVersions(id), digest),
      entry: outcome(() => providerSunset(id), digest),
    };
  out.sunset_status = digest(sunsetStatus(now));
  return out;
}

function surface() {
  return {
    gateways,
    without_executable_actions: [...withoutExecutableActions],
    delegated_write_gateways: [...delegatedWriteGateways],
    qualifiers: {read_only: readOnlyQualifier, provider_jobs: providerJobQualifier},
    notes: Object.fromEntries(definitions.map(t => [t.name, toolNotes(t)])),
    synthetic_notes: Object.fromEntries(syntheticDefinitions().map(t => [t.mode + '/' + t.name, digest(toolNotes(t))])),
    catalog: catalogAnswers(),
    service: serviceListings(),
    introspection: introspection(),
    contracts: contracts(),
  };
}

test('tools/list, gateway help, LIST_ACTIONS, DESCRIBE_ACTION and the provider contracts answer as pinned for every gateway', () => {
  const actual = JSON.parse(JSON.stringify(surface()));
  if (process.env.AMCP_UPDATE_GOLDEN === '1') {
    fs.mkdirSync(new URL('./fixtures/', import.meta.url), {recursive: true});
    fs.writeFileSync(goldenFile, JSON.stringify(actual, null, 1) + '\n');
  }
  const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
  // Section by section, so a failure names what moved.
  for (const key of Object.keys(golden)) assert.deepEqual(actual[key], golden[key], key);
  assert.deepEqual(Object.keys(actual), Object.keys(golden));
});
