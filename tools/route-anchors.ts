// Route anchors (ARC-03 Stage B): for every routed action of the ledger, the pinned vendor document, SDK request or
// dated documentation page its method and path rest on, or the capture file it comes from and why nothing else
// anchors it. tools/action-contracts.ts writes the result to generated/route-anchors.json and the per-gateway coverage
// report docs/implementation/ROUTE-ANCHOR-COVERAGE.md (`npm run contracts:actions`), and checks both
// (`npm run contracts:actions:check`). It reads committed files only and contacts nothing.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {Registry} from '../src/catalog.js';
import type {ActionContract} from '../src/action-contracts.js';
import type {JsonObject} from '../src/types.js';
import {pinnedJson} from '../src/pinned-json.js';
import {appleModelEvidence} from '../src/apple-entity-writes.js';
import {
  anchoredStatuses,
  routeAnchorKey,
  routeAnchorMeaning,
  routeAnchorReasons,
  type AnchorStatus,
  type RouteAnchor,
} from '../src/route-anchors.js';

export const routeAnchorDocumentsFile = 'tools/route-anchor-documents.json';
export const routeAnchorReportFile = 'docs/implementation/ROUTE-ANCHOR-COVERAGE.md';
export const metaSdkEvidenceFile = 'tests/fixtures/meta-sdk-changes-v26.json';
const evidenceFile = '.mirror/REPORTS/evidence-hashes.json';
/** Repository files are read from the checkout this module was built in, whatever the working directory. */
const repository = (file: string) => fileURLToPath(new URL('../../' + file, import.meta.url));
const readText = (file: string) => fs.readFileSync(repository(file), 'utf8');
const textDigest = (text: string) => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
const executable = new Set(['native_read', 'reviewed_write_family']);
/** How each gateway reaches the target "every executable route anchored", when it has not yet. */
const targetPaths: Record<string, string> = {
  meta_native_action:
    'Anchor the captured-only Meta routes to Python Business SDK 26.0.2 requests or dated documentation pages.',
  tiktok_native_action:
    'No pinned TikTok artifact yet: pin the official TikTok Business API SDK or record dated documentation pages.',
  snapchat_native_action: 'No pinned Snapchat artifact yet: record dated Marketing API documentation pages.',
  linkedin_native_action:
    'No pinned LinkedIn artifact yet: record dated Marketing API documentation pages of the reviewed version.',
  x_ads_native_action: 'No pinned X artifact yet: record dated X Ads API documentation pages of the version sent.',
};

interface VendorInventory {
  summary: JsonObject[];
  methods: JsonObject[];
}
interface DocumentedRoute {
  gateway: string;
  operation?: string;
  action: string;
  method: string;
  path: string;
  url: string;
  checked_at: string;
  note: string;
}
export interface RouteAnchorRecord {
  status: string;
  anchor_status: AnchorStatus;
  anchor?: RouteAnchor;
}

/** The documented routes table, refused when an entry is malformed. */
export function documentedRoutes(text = readText(routeAnchorDocumentsFile)): DocumentedRoute[] {
  const data = JSON.parse(text),
    routes: DocumentedRoute[] = data.routes ?? [];
  for (const r of routes)
    if (
      !r.gateway ||
      !r.action ||
      !r.method ||
      !r.path ||
      !/^https:\/\/[^\s]+$/.test(r.url) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(r.checked_at) ||
      !r.note
    )
      throw Error(
        routeAnchorDocumentsFile +
          ': each route needs gateway, action, method, path, an https url, checked_at and a note.',
      );
  return routes;
}

/** Each catalog action of a LIST_ACTIONS gateway with the shipped catalog page that lists it. */
function capturePages(registry: Registry): Map<string, string> {
  const pages = new Map<string, string>();
  for (const catalog of registry.data.catalogs.filter(c => c.denominator_kind === 'LIST_ACTIONS')) {
    const directory = '.mirror/RAW/' + catalog.gateway;
    for (const file of fs
      .readdirSync(repository(directory))
      .filter(f => /^catalog-\d{4}\.json$/.test(f))
      .sort()) {
      const page = JSON.parse(readText(directory + '/' + file)),
        envelope = JSON.parse(page.response.content.find((c: JsonObject) => c.type === 'text').text),
        data = Array.isArray(envelope.actions) ? envelope : envelope.data;
      for (const raw of data.actions as JsonObject[])
        pages.set(catalog.gateway + '/' + (raw.name ?? raw.action ?? raw.canonical_action), directory + '/' + file);
    }
  }
  return pages;
}

/** The anchors of every routed ledger row, the sources they name, a per-gateway summary and the coverage report. */
export function routeAnchors(registry: Registry, rows: ActionContract[], inventory: VendorInventory) {
  const evidenceText = readText(evidenceFile),
    evidence: Record<string, string> = JSON.parse(evidenceText),
    metaText = readText(metaSdkEvidenceFile),
    meta = JSON.parse(metaText),
    documentsText = readText(routeAnchorDocumentsFile),
    documents = documentedRoutes(documentsText),
    apple = appleModelEvidence(),
    vendorRoutes = pinnedJson<{routes: JsonObject[]}>('generated/vendor-routes.json').routes,
    pages = capturePages(registry);
  const sources: Record<string, JsonObject> = {},
    captures: Record<string, JsonObject> = {};
  const appleSource = 'apple-ads-platform-api-node@' + apple.revision,
    metaSource = 'facebook-python-business-sdk@' + meta.to.sdk_tag;
  // Pinned vendor documents, by file name; Apple's SDK evidence is an SDK source.
  const documentId = (file: string) =>
    file === 'generated/apple-platform-v1-models.json'
      ? appleSource
      : file
          .split('/')
          .at(-1)!
          .replace(/\.json$/, '');
  const summaryOf = new Map(inventory.summary.map(s => [documentId(s.source_file), s]));
  const useDocument = (id: string) => {
    if (sources[id]) return id;
    const s = summaryOf.get(id);
    if (!s) throw Error('Route anchor names an unknown pinned document ' + id);
    sources[id] =
      id === appleSource
        ? {
            kind: 'sdk_method',
            sdk: 'apple-ads-platform-api-node',
            revision: apple.revision,
            url: apple.api_source,
            api_sha256: apple.api_canonical_sha256,
            evidence: 'generated/apple-platform-v1-models.json',
          }
        : {
            kind: 'vendor_spec',
            file: s.source_file,
            url: s.source_url,
            sha256: s.sha256,
            ...(s.captured_at ? {captured_at: s.captured_at} : {}),
          };
    return id;
  };
  const exactRoutes = new Map(
      vendorRoutes
        .filter(r => r.vendorMethod)
        .map(r => [[r.gateway, r.operation ?? '', r.action || r.operation].join('/'), r]),
    ),
    supplemental = new Map(registry.data.supplemental.map(a => [a.gateway + '/' + a.name, a])),
    mapped = new Map<string, JsonObject[]>();
  for (const m of inventory.methods)
    for (const a of m.mapped_actions as JsonObject[]) {
      const key = [m.gateway, a.operation ?? '', a.action].join('/');
      mapped.set(key, [...(mapped.get(key) ?? []), m]);
    }
  const pinnedGateways = new Set(inventory.summary.map(s => s.gateway as string));
  const methodIds = new Map<string, Set<string>>();
  for (const m of inventory.methods) {
    const id = documentId(m.source_file);
    if (!methodIds.has(id)) methodIds.set(id, new Set());
    methodIds.get(id)!.add(m.id);
  }
  const documented = new Map(documents.map(d => [routeAnchorKey(d), d]));
  const used = new Set<string>();

  function anchorOf(row: ActionContract): {anchor_status: AnchorStatus; anchor?: RouteAnchor} | undefined {
    const key = routeAnchorKey(row);
    // 1. The vendor method the route was generated from (delegated gateways, Google Ads RPCs bound to v25).
    const exact = exactRoutes.get(key);
    if (exact && exact.method === row.method)
      return {
        anchor_status: 'vendor_spec',
        anchor: {source: useDocument(exact.sourceFile), method: exact.vendorMethod},
      };
    // 2. A DV360 route generated from the pinned Discovery method of the same resource and RPC.
    const dv360 = row.gateway === 'dv360_native_action' ? supplemental.get(row.gateway + '/' + row.action) : undefined;
    if (dv360 && dv360.method === row.method) {
      const id = 'displayvideo.' + dv360.raw.resource + '.' + dv360.raw.rpc;
      if (methodIds.get('dv360-v4')?.has(id))
        return {anchor_status: 'vendor_spec', anchor: {source: useDocument('dv360-v4'), method: id}};
    }
    // 3. A request of Meta's SDK at the version AMCP sends.
    const request = row.gateway === 'meta_native_action' ? meta.catalog_requests[row.action] : undefined;
    if (typeof request === 'string') {
      if (!sources[metaSource])
        sources[metaSource] = {
          kind: 'sdk_method',
          sdk: 'facebook-python-business-sdk',
          version: meta.to.sdk_tag,
          api_version: meta.to.api_version,
          url: 'https://github.com/facebook/facebook-python-business-sdk/tree/' + meta.to.sdk_tag,
          evidence: metaSdkEvidenceFile,
          evidence_sha256: textDigest(metaText),
          checked_at: meta.checked_at,
        };
      const file = meta.sources[request.split('.')[0]!.toLowerCase()]?.to;
      return {
        anchor_status: 'sdk_method',
        anchor: {source: metaSource, method: request, ...(file ? {sha256: file} : {})},
      };
    }
    // 4. A dated documentation page recorded for exactly this method and path.
    const page = documented.get(key);
    if (page) {
      if (page.method !== row.method || page.path !== row.path)
        throw Error(
          routeAnchorDocumentsFile +
            ': ' +
            key +
            ' documents ' +
            page.method +
            ' ' +
            page.path +
            ', the route is now ' +
            row.method +
            ' ' +
            row.path +
            '.',
        );
      used.add(key);
      sources[page.url] ??= {kind: 'documented_url', url: page.url};
      return {anchor_status: 'documented_url', anchor: {source: page.url, checked_at: page.checked_at}};
    }
    // 5. A method of a pinned document (or of Apple's SDK) with the same method and path shape.
    const candidates = [...(mapped.get(key) ?? [])].sort((a, b) =>
      (a.source_file + ' ' + a.id).localeCompare(b.source_file + ' ' + b.id, 'en'),
    );
    if (candidates.length) {
      const first = candidates[0]!,
        id = useDocument(documentId(first.source_file)),
        isApple = id === appleSource;
      return {
        anchor_status: isApple ? 'sdk_method' : 'vendor_spec',
        anchor: {
          source: id,
          method: first.id,
          ...(candidates.length > 1 ? {alternatives: candidates.length - 1} : {}),
          ...(isApple ? {sha256: apple.api_canonical_sha256} : {}),
        },
      };
    }
    return undefined;
  }

  // Each captured action's route as the registry serves it (AMCP's version moves applied). A row rests on its capture
  // page only while it keeps exactly that method and path; a row whose evidence names a vendor page instead (a route
  // the provider retired, say) still rests on the capture when its route is the captured one.
  const capturedRoutes = new Map(
    [...registry.catalogs.values()].flatMap(c =>
      c.actions.map(a => [c.gateway + '/' + a.name, a.method + ' ' + a.path]),
    ),
  );
  const routes: Record<string, RouteAnchorRecord> = {};
  for (const row of rows) {
    if (!row.method || !row.path) continue;
    const key = routeAnchorKey(row),
      anchored = anchorOf(row);
    if (anchored) {
      routes[key] = {status: row.status, ...anchored};
      continue;
    }
    const capture =
      capturedRoutes.get(row.gateway + '/' + row.action) === row.method + ' ' + row.path
        ? pages.get(row.gateway + '/' + row.action)
        : undefined;
    if (capture) {
      captures[capture] ??= {sha256: evidence[capture] ?? null, shipped: fs.existsSync(repository(capture))};
      routes[key] = {
        status: row.status,
        anchor_status: 'captured_only',
        anchor: {
          capture,
          reason:
            row.gateway === 'meta_native_action'
              ? 'sdk_has_no_request'
              : pinnedGateways.has(row.gateway)
                ? 'not_in_pinned_document'
                : 'captured_catalog_only',
        },
      };
    } else
      routes[key] = {status: row.status, anchor_status: 'unanchored', anchor: {reason: 'independent_mapping_unpinned'}};
  }
  for (const key of documented.keys())
    if (!used.has(key)) throw Error(routeAnchorDocumentsFile + ': ' + key + ' anchors no routed ledger action.');

  const gateways = [...new Set(rows.map(r => r.gateway))].sort();
  const summary = gateways.map(gateway => {
    const entries = Object.entries(routes).filter(([key]) => key.startsWith(gateway + '/')),
      exec = entries.filter(([, r]) => executable.has(r.status)),
      count = (list: [string, RouteAnchorRecord][]) =>
        Object.fromEntries(
          [...new Set(list.map(([, r]) => r.anchor_status))]
            .sort()
            .map(s => [s, list.filter(([, r]) => r.anchor_status === s).length]),
        ),
      anchoredExecutable = exec.filter(([, r]) => anchoredStatuses.has(r.anchor_status)).length;
    return {
      gateway,
      routes: entries.length,
      executable: exec.length,
      anchored_executable: anchoredExecutable,
      read_unanchored: exec.filter(([, r]) => r.status === 'native_read' && !anchoredStatuses.has(r.anchor_status))
        .length,
      by_anchor_status: count(entries),
      executable_by_anchor_status: count(exec),
      // The target is every executable route anchored; the path names how a gateway that has not met it gets there.
      target: {anchored_executable: exec.length, met: anchoredExecutable === exec.length},
      ...(anchoredExecutable !== exec.length
        ? {target_path: targetPaths[gateway] ?? 'Pin the vendor document or record dated documentation pages.'}
        : {}),
    };
  });
  const inputs = Object.fromEntries(
    [
      'generated/registry.json',
      'generated/vendor-routes.json',
      'generated/apple-platform-v1-models.json',
      evidenceFile,
      metaSdkEvidenceFile,
      routeAnchorDocumentsFile,
    ]
      .sort()
      .map(file => [file, textDigest(readText(file))]),
  );
  const artifact = {
    format_version: 1,
    generator: 'tools/route-anchors.ts (run by tools/action-contracts.ts)',
    regenerate: 'npm run contracts:actions',
    check: 'npm run contracts:actions:check',
    meaning: routeAnchorMeaning,
    reasons: routeAnchorReasons,
    normalization: 'Input digests are the SHA-256 of each file text with CRLF line ends read as LF.',
    inputs,
    sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    captures: Object.fromEntries(Object.entries(captures).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    summary,
    routes,
  };
  return {artifact, report: coverageReport(summary, artifact.sources)};
}

/**
 * generated/route-anchors.json as committed: indented JSON, except that each route and each capture file is one line,
 * so a changed anchor is a one-line difference.
 */
export function serializeRouteAnchors(artifact: JsonObject): string {
  const {routes, captures, ...head} = artifact,
    lines = (map: JsonObject) =>
      Object.entries(map)
        .map(([key, value]) => '    ' + JSON.stringify(key) + ': ' + JSON.stringify(value))
        .join(',\n'),
    text = JSON.stringify(head, null, 2);
  return (
    text.slice(0, -2) +
    ',\n  "captures": {\n' +
    lines(captures) +
    '\n  },\n  "routes": {\n' +
    lines(routes) +
    '\n  }\n}\n'
  );
}

/** The committed per-gateway anchor coverage report (Markdown). */
function coverageReport(summary: JsonObject[], sources: Record<string, JsonObject>): string {
  const total = (key: string) => summary.reduce((n, s) => n + (s[key] as number), 0),
    statuses = ['vendor_spec', 'sdk_method', 'documented_url', 'captured_only', 'unanchored'],
    routed = summary.filter(s => s.routes > 0),
    unrouted = summary.filter(s => !s.routes).map(s => s.gateway);
  return [
    // DOC-03: the front matter every documentation page opens with (tools/docs-front-matter.mjs).
    '---',
    'status: reference',
    'tier: engineering',
    'generated: tools/route-anchors.ts',
    '---',
    '',
    '# Route anchor coverage',
    '',
    'Generated by `npm run contracts:actions` (`tools/route-anchors.ts`) from the action ledger, the pinned vendor documents and SDK evidence, and the captured catalog; `npm run contracts:actions:check` fails when it is stale. Do not edit it by hand (ARC-03).',
    '',
    routeAnchorMeaning,
    '',
    'The captured catalog stays the naming-compatibility surface and its frozen denominator (owner decision D17); routing truth is what each route is anchored to. The full list, with each anchor and capture file, is `generated/route-anchors.json`, and every ledger row carries `anchor_status` and `anchor` ([ACTION-CONTRACT-COVERAGE.csv](ACTION-CONTRACT-COVERAGE.csv), `amcp_workspace contracts`).',
    '',
    `Executable routes (native reads and reviewed write families): ${total('executable')}, of which ${total('anchored_executable')} are anchored and ${total('read_unanchored')} native reads carry the advisory \`read_unanchored\`. The target for every gateway is all executable routes anchored.`,
    '',
    '| Gateway | Routes | Executable | Anchored executable | Target met | ' + statuses.join(' | ') + ' |',
    '|---|---:|---:|---:|---|' + statuses.map(() => '---:').join('|') + '|',
    ...routed.map(
      s =>
        `| ${s.gateway} | ${s.routes} | ${s.executable} | ${s.anchored_executable} | ${s.target.met ? 'yes' : 'no'} | ` +
        statuses.map(k => String(s.executable_by_anchor_status[k] ?? 0)).join(' | ') +
        ' |',
    ),
    '',
    'The status columns count executable routes.' +
      (unrouted.length
        ? ' Gateways with no provider route to anchor (AMCP workflows and unmapped operations only): ' +
          unrouted.join(', ') +
          '.'
        : ''),
    '',
    'Gateways that have not met the target:',
    '',
    ...summary.filter(s => !s.target.met).map(s => `- ${s.gateway}: ${s.target_path}`),
    '',
    '## Anchoring sources',
    '',
    '| Source | Kind | Pinned as |',
    '|---|---|---|',
    ...Object.entries(sources).map(
      ([id, s]) =>
        `| ${id} | ${s.kind} | ${s.kind === 'vendor_spec' ? '`' + s.file + '` (SHA-256 ' + String(s.sha256).slice(0, 12) + '…)' : s.kind === 'documented_url' ? 'dated page, see each route' : '`' + s.evidence + '`'} |`,
    ),
    '',
    '## Adding an anchor',
    '',
    `Pin the vendor document (\`tools/fetch-vendor-specs.mjs\`) or SDK evidence, or record a page in \`${routeAnchorDocumentsFile}\` with the exact method and path it documents, the page URL, the date it was read and a note. The generator refuses an entry whose method and path no longer match its route. Then run \`npm run contracts:actions\` and review the difference.`,
    '',
  ].join('\n');
}
