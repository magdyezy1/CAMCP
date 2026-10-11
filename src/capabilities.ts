import {providerContracts, effectiveProviderContract} from './provider-contracts.js';
import {gatewayOffered} from './provider-offering.js';
import {Store} from './store.js';
import {serverIdentity} from './server-identity.js';
import type {Actor, JsonObject} from './types.js';
export function workspaceCapabilities(store: Store, actor: Actor) {
  const checks = store.documents(actor.tenantId, 'readiness'),
    validations = store.documents(actor.tenantId, 'provider_validation'),
    writes = store.documents(actor.tenantId, 'write_verification');
  const features = [
    [
      'campaign_builder',
      'Durable campaign plans',
      'amcp_campaign',
      'Dependency references, frozen reviews, restart recovery and verification',
    ],
    [
      'readiness',
      'Account readiness',
      'amcp_workspace',
      'Current grants, recorded scopes, exact account read and requested asset checks',
    ],
    [
      'media_library',
      'Media library',
      'amcp_media',
      'Selected private Drive files, receipt reuse, explicit format variants and seven upload adapters',
    ],
    [
      'write_verification',
      'Write verification',
      'amcp_campaign',
      'Background configuration read-back; unsupported and uncertain outcomes remain explicit',
    ],
    [
      'reporting',
      'Source-linked reports',
      'amcp_reporting',
      'Native source hashes, declared attribution, exact decimal totals and reconciliation',
    ],
    [
      'optimization',
      'Evidence-based suggestions',
      'amcp_reporting',
      'Pacing, sample thresholds, conversion lag warnings and comparable baselines',
    ],
    [
      'profiles',
      'Approved client profiles',
      'amcp_workspace',
      'Revisioned naming, UTMs, account bindings and reusable native templates',
    ],
    [
      'capabilities',
      'Capability evidence',
      'amcp_workspace',
      'Separate local implementation, provider reads, validation and verified writes',
    ],
  ].map(([id, name, tool, coverage]) => ({
    id,
    name,
    tool,
    coverage,
    implementation: 'implemented_unverified',
    // Hosted CI is waived by the owner, so the evidence is the build's qualification record, named once below (MCP-10).
    local_test_evidence: 'tests/workspace-operations.test.ts and tests/private-media.test.ts; see qualification',
    live_qualification: 'per account and action evidence below',
  }));
  // A workspace's live evidence is its own: the reviewed writes it verified by reading them back from the provider.
  const gatewayOf = new Map(store.listConnections(actor.tenantId).map(c => [c.id, c.gateway]));
  // A provider this deployment does not offer is not shown (CON-06, src/provider-offering.ts).
  const offered = providerContracts.filter(c => gatewayOffered(c.gateway));
  return {
    contract_version: 1,
    providers: offered.map(c => ({
      ...effectiveProviderContract(c.id),
      live_verified: writes
        .filter(w => w.status === 'verified' && gatewayOf.get(w.connection_id) === c.gateway)
        .map(w => ({
          action: w.action,
          account_id: w.account_id,
          verified_at: new Date(w.checked_at).toISOString(),
          review_id: w.review_id,
        })),
    })),
    features,
    evidence: store.listConnections(actor.tenantId).flatMap(c =>
      c.accounts.map(account => ({
        gateway: c.gateway,
        connection_id: c.id,
        account_id: account,
        read: checks
          .filter(r => r.connection_id === c.id && r.account_id === account && r.live_read)
          // Shared account-read evidence; caller-specific requirements are not stored (CON-03).
          .map(r => ({at: r.checked_at})),
        provider_validation: validations
          .filter(r => r.connection_id === c.id && r.account_id === account)
          .map(({actor, ...r}: JsonObject) => r),
        writes: writes
          .filter(r => r.connection_id === c.id && r.account_id === account)
          .map(r => ({
            review_id: r.review_id,
            action: r.action,
            status: r.status,
            at: r.checked_at,
            checks: r.checks,
          })),
      })),
    ),
    // Where this build's tests were recorded (QA-01, MCP-10): the qualification record of its source tree, which the
    // build identity at /versionz identifies. There is no hosted CI result to consult.
    qualification: {
      build: serverIdentity().version,
      status_url: '/versionz',
      record:
        'npm run qualify records the tested source tree in .runtime/qualifications/<source_tree_hash>.json; the operator keeps it (it is not committed) and release notes cite its source_tree_hash.',
    },
    meaning:
      'Implemented and fixture-tested are not live qualification. Evidence is timestamped and applies only to the listed account, action and fields.',
  };
}
