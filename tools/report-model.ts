import type {ActionContract} from '../src/action-contracts.js';

/**
 * What tools/report.ts derives from the code for the implementation status report and .mirror/PARITY.md (DOC-01). Its
 * numbers were partly typed by hand: Reddit's reviewed mutations as a literal 8 beside 2 actions, Microsoft's "12
 * reviewed Search mutation routes" beside a computed 14, and the unfinished workflows by a classifier of its own, which
 * listed nine implemented local workflows and missed an operation the action ledger counts as unmapped. Every number now
 * comes from the code and the ledger's classification (src/action-contracts.ts), and the report and PARITY render the
 * same values. Pure functions, so tests/report-model.test.mjs checks them without writing any report.
 */

export interface WorkflowGap {
  gateway: string;
  operation: string;
  reason: string;
  /** The operation's actions the ledger classifies as `unmapped`: no provider request mapping exists for them. */
  unmapped_actions: string[];
  actions: number;
}

/**
 * The unfinished workflows: each delegated operation with at least one action the ledger classifies as `unmapped`
 * (advertised, but with no provider request mapping), sorted by gateway and operation. An operation whose actions are
 * all implemented (local workflows, native reads, reviewed writes) is not unfinished.
 */
export function unfinishedWorkflows(
  contracts: readonly ActionContract[],
  delegated: (gateway: string) => boolean,
): WorkflowGap[] {
  const operations = new Map<string, {gateway: string; operation: string; unmapped: string[]; actions: number}>();
  for (const c of contracts) {
    if (!c.operation || !delegated(c.gateway)) continue;
    const key = c.gateway + '/' + c.operation,
      entry = operations.get(key) ?? {gateway: c.gateway, operation: c.operation, unmapped: [], actions: 0};
    entry.actions++;
    if (c.status === 'unmapped') entry.unmapped.push(c.action);
    operations.set(key, entry);
  }
  return [...operations.values()]
    .filter(e => e.unmapped.length)
    .sort((a, b) => a.gateway.localeCompare(b.gateway) || a.operation.localeCompare(b.operation))
    .map(e => ({
      gateway: e.gateway,
      operation: e.operation,
      reason:
        e.unmapped.length === e.actions
          ? 'No provider request mapping for any of its actions (action ledger: unmapped)'
          : 'No provider request mapping for ' +
            e.unmapped.length +
            ' of its ' +
            e.actions +
            ' actions (action ledger: unmapped)',
      unmapped_actions: [...e.unmapped].sort(),
      actions: e.actions,
    }));
}

/** The ledger's count of a gateway's actions, in all and of one status. */
export function ledgerCount(contracts: readonly ActionContract[], gateway: string, status?: ActionContract['status']) {
  return contracts.filter(c => c.gateway === gateway && (status === undefined || c.status === status)).length;
}

export interface IndependentExtension {
  gateway: string;
  actions: number;
  reviewed_mutation_actions: number;
  write_scope: string;
  live_qualified: false;
  [key: string]: unknown;
}

/** Refuses an extension that claims more reviewed mutations than actions, the report's earlier Reddit entry. */
export function assertExtensions(extensions: readonly IndependentExtension[]): readonly IndependentExtension[] {
  for (const e of extensions)
    if (!(
      Number.isSafeInteger(e.actions) &&
      e.reviewed_mutation_actions >= 0 &&
      e.reviewed_mutation_actions <= e.actions
    ))
      throw new Error(
        e.gateway +
          ' claims ' +
          e.reviewed_mutation_actions +
          ' reviewed mutation actions of ' +
          e.actions +
          ' actions.',
      );
  return extensions;
}

/** The Markdown of .mirror/PARITY.md from the values the JSON report holds, so the two cannot disagree. */
export function parityMarkdown(input: {
  gateways: readonly {
    gateway: string;
    catalog_records: number;
    known_denominator: number | null;
    captured_http_routes: number;
    vendor_documented_routes: number;
  }[];
  legacyAdapters: number;
  extensions: readonly IndependentExtension[];
  guidanceResources: number;
  workflowGaps: readonly WorkflowGap[];
  limitations: readonly string[];
}): string {
  const microsoft = input.extensions.find(e => e.gateway === 'microsoft_ads_native_action');
  if (!microsoft) throw new Error('The report has no Microsoft Advertising extension.');
  const lines = [
    '# Implementation and verification status',
    '',
    'Production readiness: **not achieved**. Reviewed campaign-management writes are available when enabled; they remain disabled by default.',
    '',
    '| Gateway | Catalog records | Declared HTTP routes | Additional vendor routes | Full platform verified |',
    '|---|---:|---:|---:|---|',
    ...input.gateways.map(
      g =>
        `| ${g.gateway} | ${g.catalog_records}${g.known_denominator === null ? ' (denominator unknown)' : ''} | ${g.captured_http_routes} | ${g.vendor_documented_routes} | No |`,
    ),
    '',
    'Google has ' +
      input.legacyAdapters +
      ' independently specified legacy adapters. They preserve native responses; exact AMCP legacy behavior is unverified. One legacy update (UPDATE_CUSTOMIZER_ATTRIBUTE) has no supported vendor update operation and is rejected.',
    '',
    '## Independent extensions',
    '',
    'Microsoft Advertising: ' +
      microsoft.actions +
      ' actions, including ' +
      microsoft.reviewed_mutation_actions +
      ' reviewed mutation actions. Live qualification remains incomplete; these actions are not part of the captured AMCP denominator.',
    '',
    'Campaign guidance: ' +
      input.guidanceResources +
      ' MCP resources and the amcp_build_campaign prompt. amcp_write inspect checks local execution contracts without network calls.',
    '',
    '## Unfinished workflows',
    '',
    'Delegated operations with an action the action ledger classifies as unmapped (no provider request mapping):',
    '',
    ...input.workflowGaps.map(
      g =>
        '- ' +
        g.gateway +
        '/' +
        g.operation +
        (g.unmapped_actions.length === g.actions
          ? ''
          : ' (' + g.unmapped_actions.length + ' of ' + g.actions + ' actions)'),
    ),
    '',
    '## Limits',
    '',
    ...input.limitations.map(s => '- ' + s),
    '',
    'Detailed mapping and known vendor route gaps: REPORTS/implementation-status.json.',
  ];
  return lines.join('\n') + '\n';
}
