import {randomUUID} from 'node:crypto';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {fingerprint, obj, validate, writer, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';
import {familyErrors, type ReasonFirstRefusal} from './family-kit.js';

const gateway = 'google_ads_native_action',
  day = 86400000;
const fail: ReasonFirstRefusal = familyErrors('SEARCH_EXCLUSION_EVIDENCE_REQUIRED');
const keyText = (value: string) => value.trim().replace(/\s+/gu, ' ').toLowerCase();
const dateValue = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    fail('Use exact retained reporting dates.');
  return Date.parse(v as string);
};
function optionsOf(input: JsonObject = {}) {
  validate(input, ['minimum_clicks', 'maximum_age_days']);
  const minimum_clicks = input.minimum_clicks ?? 30,
    maximum_age_days = input.maximum_age_days ?? 7;
  if (
    !Number.isSafeInteger(minimum_clicks) ||
    minimum_clicks < 1 ||
    minimum_clicks > 1000000 ||
    !Number.isSafeInteger(maximum_age_days) ||
    maximum_age_days < 1 ||
    maximum_age_days > 90
  )
    fail('Use minimum_clicks 1–1000000 and maximum_age_days 1–90.');
  return {minimum_clicks, maximum_age_days};
}
function evidence(report: JsonObject, options: JsonObject) {
  const sem = report.semantics,
    now = Date.now();
  if (
    report.gateway !== gateway ||
    report.preset !== 'google_search_terms' ||
    report.source !== 'provider_read' ||
    report.source_collection !== 'google_search_pages' ||
    report.grain !== 'campaign × ad group × search term' ||
    !Array.isArray(report.rows) ||
    report.rows.length > 10000 ||
    typeof report.account_id !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(report.account_id) ||
    !/^[a-f0-9]{64}$/.test(report.source_hash) ||
    !sem ||
    sem.complete !== true ||
    sem.conversion_definition !== 'metrics.conversions' ||
    typeof sem.attribution !== 'string' ||
    ['', 'unknown', 'unverified', 'unspecified'].includes(sem.attribution.trim().toLowerCase()) ||
    typeof sem.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(sem.currency) ||
    typeof sem.timezone !== 'string' ||
    !Number.isSafeInteger(report.captured_at) ||
    report.captured_at > now ||
    now - report.captured_at > options.maximum_age_days * day
  )
    fail(
      'Capture recent complete Google search-term evidence with exact native identities and declared attribution before preparing exclusions.',
    );
  const start = dateValue(sem.date_from),
    end = dateValue(sem.date_to);
  let today: number;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en', {timeZone: sem.timezone, year: 'numeric', month: '2-digit', day: '2-digit'})
        .formatToParts(now)
        .map(p => [p.type, p.value]),
    );
    today = dateValue(parts.year + '-' + parts.month + '-' + parts.day);
  } catch {
    return fail('Use the native reporting timezone.');
  }
  if (end < start || end >= today || today - end > options.maximum_age_days * day)
    fail(
      'Use a closed reporting period within the selected evidence-age limit. A fresh capture does not make old dates recent.',
    );
  const seen = new Set<string>(),
    rows: JsonObject[] = [];
  for (const r of report.rows) {
    if (!obj(r) || typeof r.search_term !== 'string' || !r.search_term || typeof r.entity_id !== 'string')
      fail('Retain exact search-term text and resource identity.');
    const match = new RegExp(
        '^customers/' +
          report.account_id +
          '/searchTermViews/([1-9][0-9]{0,19})~([1-9][0-9]{0,19})~([A-Za-z0-9_-]+={0,2})$',
      ).exec(r.entity_id),
      encoded = Buffer.from(r.search_term, 'utf8').toString('base64url');
    if (!match || (match[3] !== encoded && match[3] !== encoded + '='.repeat((4 - (encoded.length % 4)) % 4)))
      fail('Search-term text no longer matches its exact selected-account resource.');
    const grain = match[1] + '~' + match[2] + '~' + encoded;
    if (seen.has(grain)) fail('Retained search-term evidence contains duplicate native grain.');
    seen.add(grain);
    // A conservative literal subset avoids provider operators or silently rewritten punctuation.
    const literal =
      r.search_term === r.search_term.trim() &&
      r.search_term.length <= 80 &&
      r.search_term.split(/\s+/u).length <= 10 &&
      /^[\p{L}\p{M}\p{N} '’]+$/u.test(r.search_term);
    if (
      !literal ||
      typeof r.clicks !== 'string' ||
      !/^\d+$/.test(r.clicks) ||
      BigInt(r.clicks) < BigInt(options.minimum_clicks) ||
      r.conversions !== '0' ||
      typeof r.spend !== 'string' ||
      !/^\d{1,30}(?:\.\d{1,9})?$/.test(r.spend)
    )
      continue;
    rows.push({
      entity_id: r.entity_id,
      campaign_id: match[1],
      ad_group_id: match[2],
      ad_group_resource: 'customers/' + report.account_id + '/adGroups/' + match[2],
      search_term: r.search_term,
      observed_clicks: r.clicks,
      observed_spend: r.spend,
      observed_conversions: '0',
      match_type: 'EXACT',
    });
  }
  return rows;
}
export function searchExclusionCandidates(report: JsonObject, input: JsonObject) {
  const options = optionsOf(input.options),
    rows = evidence(report, options),
    offset = input.offset ?? 0,
    limit = input.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    fail('Use a nonnegative offset and page size 1–100.');
  return {
    record_kind: 'search_exclusion_candidates',
    report_id: report.id,
    report_revision: report.revision,
    source_hash: report.source_hash,
    gateway,
    account_id: report.account_id,
    connection_id: report.connection_id,
    currency: report.semantics.currency,
    options,
    candidate_count: rows.length,
    candidates: rows.slice(offset, offset + limit),
    // The paging fields every AMCP list carries (MCP-07): total, has_more, and next_offset while it is true.
    total: rows.length,
    has_more: offset + limit < rows.length,
    next_offset: offset + limit < rows.length ? offset + limit : null,
    network_requests: 0,
    meaning:
      'Possible exclusions from retained evidence, not instructions to block useful traffic. Only literal terms with known zero conversions and sufficient clicks are included. Review relevance and conversion lag; missing metrics are not zero. Other terms remain in the original report.',
  };
}
function selection(report: JsonObject, options: JsonObject, ids: unknown) {
  const candidates = evidence(report, options);
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 20 ||
    new Set(ids).size !== ids.length ||
    ids.some(id => typeof id !== 'string')
  )
    fail('Select 1–20 distinct search-term resource IDs from this retained report.');
  const seen = new Set<string>();
  return ids.map(id => {
    const r = candidates.find(r => r.entity_id === id);
    if (!r) return fail('The selected term no longer meets the retained evidence and literal-keyword requirements.');
    const key = r.ad_group_id + '/' + keyText(r.search_term);
    if (seen.has(key)) fail('Choose only one spelling of an exact term per ad group.');
    seen.add(key);
    return r;
  });
}
function authority(store: Store, actor: Actor, source: JsonObject) {
  store.assertActorActive(actor);
  const c = store.resolveConnection(actor, gateway, source.account_id, source.connection_id);
  return fingerprint({login: storedLogin(store, c), scopes: [...c.scopes].sort()});
}
function sourceCurrent(store: Store, actor: Actor, b: JsonObject) {
  const report = store.document(actor.tenantId, 'decision_report', b.report_id);
  if (
    authority(store, actor, b) !== b.authorization_hash ||
    report.revision !== b.report_revision ||
    report.source_hash !== b.source_hash ||
    report.account_id !== b.account_id ||
    report.connection_id !== b.connection_id ||
    fingerprint(
      selection(
        report,
        b.options,
        b.targets.map((t: JsonObject) => t.entity_id),
      ),
    ) !== b.selection_hash
  )
    fail('The report, selection or login changed. Prepare a new exclusion preview.', 'SEARCH_EXCLUSION_SOURCE_CHANGED');
}
async function nativeState(store: Store, call: ToolCall, actor: Actor, source: JsonObject, targets: JsonObject[]) {
  const expected = source.authorization_hash ?? authority(store, actor, source),
    budget = new ReportCollectionBudget(undefined, fingerprint({account: source.account_id, targets}), () => {}, {
      requests: 6,
      rows: 1040,
      bytes: 2 * 1024 * 1024,
      elapsed_ms: 60000,
    }),
    native_reads: JsonObject[] = [];
  const current = () => {
    if (authority(store, actor, source) !== expected)
      fail('The selected login or permissions changed during inspection.', 'CONNECTION_AUTHORITY_CHANGED');
    budget.check();
  };
  const read = async (query: string, limit: number) => {
    current();
    const request = {
        action: 'google_ads_v23_google_ads_search',
        account_id: source.account_id,
        connection_id: source.connection_id,
        payload: {query, search_settings: {return_total_results_count: true}},
        aggregate_pages: false,
        dry_run: false,
      },
      result = await call(gateway, request, actor);
    current();
    if (!result.success)
      fail(
        result.error?.message ?? 'Current keyword context could not be read.',
        result.error?.code ?? 'SEARCH_EXCLUSION_NATIVE_CHANGED',
      );
    const wrapper = result.data,
      data = wrapper?.data,
      rows = data?.results ?? [];
    if (
      !obj(wrapper) ||
      !obj(data) ||
      wrapper.dry_run ||
      wrapper.executed === false ||
      (data.results !== undefined && !Array.isArray(data.results)) ||
      !Array.isArray(rows) ||
      rows.length > limit ||
      [wrapper, data].some(
        v =>
          v.error !== undefined ||
          v.errors !== undefined ||
          v.partialFailureError !== undefined ||
          v.truncated === true ||
          v.has_more === true ||
          v.nextPageToken ||
          v.next_page_token,
      ) ||
      (data.totalResultsCount ?? (rows.length === 0 ? '0' : null)) !== String(rows.length)
    )
      fail(
        'Current Google context is partial or inconsistent. Narrow the selection.',
        'SEARCH_EXCLUSION_NATIVE_CHANGED',
      );
    budget.rows(query.includes(' FROM ad_group_criterion') ? 'criteria' : 'parents', rows.length);
    native_reads.push({source_request: request, source_hash: fingerprint(wrapper), captured_at: Date.now()});
    return rows as JsonObject[];
  };
  const ids = [...new Set(targets.map(t => t.ad_group_id))].sort();
  const parentQuery =
    'SELECT customer.id, customer.currency_code, customer.time_zone, campaign.id, campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type, ad_group.id, ad_group.resource_name, ad_group.campaign, ad_group.name, ad_group.status, ad_group.type FROM ad_group WHERE ad_group.id IN (' +
    ids.join(',') +
    ') ORDER BY ad_group.id';
  const parents = async () => {
    const rows = await read(parentQuery, 20),
      seen = new Set<string>();
    if (rows.length !== ids.length)
      fail('Every selected ad group must still be available.', 'SEARCH_EXCLUSION_NATIVE_CHANGED');
    return rows
      .map(row => {
        const c = row.campaign,
          g = row.adGroup,
          u = row.customer;
        if (
          !obj(c) ||
          !obj(g) ||
          !obj(u) ||
          !ids.includes(g.id) ||
          seen.has(g.id) ||
          u.id !== source.account_id ||
          u.currencyCode !== source.currency ||
          u.timeZone !== source.timezone ||
          c.resourceName !== 'customers/' + source.account_id + '/campaigns/' + c.id ||
          g.resourceName !== 'customers/' + source.account_id + '/adGroups/' + g.id ||
          g.campaign !== c.resourceName ||
          targets.some(t => t.ad_group_id === g.id && t.campaign_id !== c.id) ||
          !['ENABLED', 'PAUSED'].includes(c.status) ||
          !['ENABLED', 'PAUSED'].includes(g.status) ||
          c.advertisingChannelType !== 'SEARCH' ||
          g.type !== 'SEARCH_STANDARD'
        )
          fail(
            'Use currently available standard Search ad groups under their original campaign, account, currency and timezone.',
            'SEARCH_EXCLUSION_NATIVE_CHANGED',
          );
        seen.add(g.id);
        const name = (value: unknown) => (typeof value === 'string' && value.length <= 256 ? value : null);
        return {
          ad_group_id: g.id,
          campaign_id: c.id,
          ad_group_resource: g.resourceName,
          campaign_resource: c.resourceName,
          ad_group_status: g.status,
          campaign_status: c.status,
          ad_group_type: g.type,
          channel: c.advertisingChannelType,
          ad_group_name: name(g.name),
          campaign_name: name(c.name),
        };
      })
      .sort((a, b) => a.ad_group_id.localeCompare(b.ad_group_id));
  };
  try {
    return await budget.run(async () => {
      const before = await parents();
      // Inspect all exact keywords in these groups, avoiding assumptions about GAQL text-filter case semantics.
      const rows = await read(
        'SELECT ad_group.id, ad_group.resource_name, ad_group_criterion.resource_name, ad_group_criterion.ad_group, ad_group_criterion.status, ad_group_criterion.type, ad_group_criterion.negative, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group.id IN (' +
          ids.join(',') +
          ') AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.status != REMOVED AND ad_group_criterion.keyword.match_type = EXACT',
        1000,
      );
      const seen = new Set();
      for (const row of rows) {
        const g = row.adGroup,
          k = row.adGroupCriterion;
        if (
          !obj(g) ||
          !obj(k) ||
          !ids.includes(g.id) ||
          g.resourceName !== 'customers/' + source.account_id + '/adGroups/' + g.id ||
          k.adGroup !== g.resourceName ||
          typeof k.resourceName !== 'string' ||
          !new RegExp('^customers/' + source.account_id + '/adGroupCriteria/' + g.id + '~[1-9][0-9]{0,19}$').test(
            k.resourceName,
          ) ||
          seen.has(k.resourceName) ||
          !['ENABLED', 'PAUSED'].includes(k.status) ||
          k.type !== 'KEYWORD' ||
          (k.negative !== undefined && typeof k.negative !== 'boolean') ||
          k.keyword?.matchType !== 'EXACT' ||
          typeof k.keyword.text !== 'string' ||
          !k.keyword.text.trim() ||
          k.keyword.text.length > 80 ||
          /[\x00-\x1f\x7f]/.test(k.keyword.text)
        )
          fail('Google returned unrecognized current keyword evidence.', 'SEARCH_EXCLUSION_NATIVE_CHANGED');
        seen.add(k.resourceName);
        if (targets.some(t => t.ad_group_id === g.id && keyText(t.search_term) === keyText(k.keyword.text)))
          fail(
            k.negative === true
              ? 'An exact negative keyword already exists in the selected ad group. Remove that term from this draft.'
              : 'A selected term is already an exact positive keyword. Review that targeting separately before excluding it.',
            'SEARCH_EXCLUSION_KEYWORD_CONFLICT',
          );
      }
      const after = await parents();
      if (fingerprint(before) !== fingerprint(after))
        fail('The selected ad group context changed during inspection.', 'SEARCH_EXCLUSION_NATIVE_CHANGED');
      current();
      return {parents: before, native_reads, native_hash: fingerprint(before)};
    });
  } finally {
    budget.close();
  }
}
function draft(b: JsonObject, previewId: string): JsonObject {
  return {
    action: 'create',
    name: 'Search term exclusion draft',
    idempotency_key: 'search-exclusion-' + previewId,
    search_exclusion_preview_id: previewId,
    search_exclusion_preview_hash: fingerprint(b),
    confirmed: true,
    brief:
      'Source report ' +
      b.report_id +
      '. Proposed exact negative keywords in their original ad groups only. Review business relevance and conversion lag. Broader, campaign and shared exclusions are not assessed. Every native step needs its own approval and read-back.',
    steps: b.targets.map((t: JsonObject, i: number) => ({
      id: 'exclude-' + (i + 1),
      kind: 'write',
      gateway,
      account_id: b.account_id,
      connection_id: b.connection_id,
      expected_currency: b.currency,
      depends_on: [],
      description: 'Proposed exact exclusion in ad group ' + t.ad_group_id + ': ' + t.search_term,
      arguments: {
        action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
        payload: {
          operations: [
            {
              create: {
                ad_group: t.ad_group_resource,
                negative: true,
                keyword: {text: t.search_term, match_type: 'EXACT'},
              },
            },
          ],
          partial_failure: false,
        },
      },
    })),
  };
}
export function searchExclusionCreationBinding(store: Store, actor: Actor, input: JsonObject, steps: JsonObject[]) {
  if (input.search_exclusion_preview_id === undefined && input.search_exclusion_preview_hash === undefined)
    return undefined;
  const p = store.document(actor.tenantId, 'search_exclusion_preview', String(input.search_exclusion_preview_id)),
    b = p.binding;
  if (
    input.allocation_preview_id !== undefined ||
    input.confirmed !== true ||
    p.user_id !== actor.userId ||
    p.session_id !== (store.sessionIdentity(actor) ?? null) ||
    p.expires_at <= Date.now() ||
    p.preview_hash !== input.search_exclusion_preview_hash ||
    p.preview_hash !== fingerprint(b)
  )
    fail("Use this session's exact current exclusion preview.", 'SEARCH_EXCLUSION_PREVIEW_CHANGED');
  sourceCurrent(store, actor, b);
  const expected = draft(b, p.id),
    clean = (s: JsonObject) =>
      Object.fromEntries(
        [
          'id',
          'kind',
          'gateway',
          'account_id',
          'connection_id',
          'expected_currency',
          'depends_on',
          'description',
          'arguments',
        ].map(k => [k, s[k]]),
      );
  if (
    input.idempotency_key !== expected.idempotency_key ||
    input.name !== expected.name ||
    input.brief !== expected.brief ||
    fingerprint(steps.map(clean)) !== fingerprint(expected.steps.map(clean))
  )
    fail('The draft differs from its exact source-bound preview.', 'SEARCH_EXCLUSION_PLAN_CHANGED');
  return {...b, preview_id: p.id};
}
export async function previewSearchExclusions(
  store: Store,
  call: ToolCall,
  actor: Actor,
  report: JsonObject,
  input: JsonObject,
) {
  writer(store, actor);
  const options = optionsOf(input.options),
    targets = selection(report, options, input.ids),
    b = {
      gateway,
      report_id: report.id,
      report_revision: report.revision,
      source_hash: report.source_hash,
      account_id: report.account_id,
      connection_id: report.connection_id,
      currency: report.semantics.currency,
      timezone: report.semantics.timezone,
      options,
      targets,
      selection_hash: fingerprint(targets),
      authorization_hash: authority(store, actor, report),
    },
    native = await nativeState(store, call, actor, b, targets),
    binding = {...b, ...native};
  sourceCurrent(store, actor, b);
  return store.transaction(() => {
    // Expired previews go first (their declared expiry, src/document-kinds.ts).
    store.repo('search_exclusion_preview', actor.tenantId).purgeExpired(Date.now());
    if (store.documents(actor.tenantId, 'search_exclusion_preview').length >= 100)
      fail('At most 100 current exclusion previews may be retained.', 'SEARCH_EXCLUSION_PREVIEW_LIMIT');
    const id = randomUUID(),
      preview_hash = fingerprint(binding),
      expires_at = Date.now() + 10 * 60000;
    store.putDocument(actor.tenantId, 'search_exclusion_preview', id, {
      binding,
      preview_hash,
      expires_at,
      user_id: actor.userId,
      session_id: store.sessionIdentity(actor) ?? null,
    });
    return {
      record_kind: 'search_exclusion_preview',
      preview_id: id,
      preview_hash,
      expires_at,
      ...binding,
      advertising_writes: 0,
      meaning:
        'Preview only. Review relevance and conversion lag before saving an unapproved draft. Proposed exact negative keywords affect only their original ad groups. Current exact ad-group keywords were checked; broader, campaign and shared exclusions were not assessed. Historical attribution remains declared. No advertising change occurred.',
    };
  });
}
export async function createSearchExclusionPlan(
  store: Store,
  call: ToolCall,
  actor: Actor,
  report: JsonObject,
  input: JsonObject,
  createDraft?: (plan: JsonObject, actor: Actor) => Promise<JsonObject>,
) {
  writer(store, actor);
  if (input.confirmed !== true)
    fail('Confirm this exact preview to save an unapproved draft.', 'CONFIRMATION_REQUIRED');
  const p = store.document(actor.tenantId, 'search_exclusion_preview', String(input.preview_id)),
    b = p.binding;
  if (
    p.user_id !== actor.userId ||
    p.session_id !== (store.sessionIdentity(actor) ?? null) ||
    p.preview_hash !== input.preview_hash ||
    p.preview_hash !== fingerprint(b) ||
    b.report_id !== report.id
  )
    fail("Use this session's exact exclusion preview.", 'SEARCH_EXCLUSION_PREVIEW_CHANGED');
  sourceCurrent(store, actor, b);
  const result = (id: string) => ({
    record_kind: 'search_exclusion_plan',
    id,
    state: store.document(actor.tenantId, 'campaign_run', id).state,
    website_path: '/campaigns?id=' + encodeURIComponent(id),
    next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id}},
    advertising_writes: 0,
    approval_required: true,
  });
  if (p.plan_id) return result(p.plan_id);
  if (p.expires_at <= Date.now())
    fail('The exclusion preview expired. Inspect a new preview.', 'SEARCH_EXCLUSION_PREVIEW_EXPIRED');
  const key = 'search-exclusion-plan:' + actor.tenantId + ':' + p.id,
    owner = randomUUID();
  if (!store.acquireLock(key, owner, 90000))
    fail('This draft is already being saved. Reuse its original preview.', 'SEARCH_EXCLUSION_PLAN_BUSY');
  try {
    const current = await nativeState(store, call, actor, b, b.targets);
    sourceCurrent(store, actor, b);
    if (current.native_hash !== b.native_hash)
      fail('Current ad group context changed after preview. Inspect a new preview.', 'SEARCH_EXCLUSION_NATIVE_CHANGED');
    if (p.expires_at <= Date.now() || !store.renewLock(key, owner, 90000))
      fail('The exclusion preview expired.', 'SEARCH_EXCLUSION_PREVIEW_EXPIRED');
    if (!createDraft) fail('The campaign draft engine is unavailable.');
    const created = await createDraft(draft(b, p.id), actor);
    if (!created.success) fail(created.error?.message ?? 'The draft could not be saved.', created.error?.code);
    const run = store.document(actor.tenantId, 'campaign_run', created.data.id);
    if (run.search_exclusions?.preview_id !== p.id)
      fail('The draft lost its source binding.', 'SEARCH_EXCLUSION_PLAN_CHANGED');
    store.putDocument(actor.tenantId, 'search_exclusion_preview', p.id, {...p, plan_id: run.id});
    sourceCurrent(store, actor, b);
    store.appendAudit(actor.tenantId, 'search-exclusions/' + p.id, {
      event: 'search_exclusion_draft_created',
      report_id: report.id,
      plan_id: run.id,
      selected_terms: b.targets.length,
    });
    return result(run.id);
  } finally {
    store.releaseLock(key, owner);
  }
}
function unchangedStep(b: JsonObject, run: JsonObject, step: JsonObject) {
  const index = run.steps.findIndex((s: JsonObject) => s.id === step.id),
    original = draft(b, b.preview_id).steps[index],
    target = b.targets[index];
  if (
    !original ||
    !target ||
    original.id !== step.id ||
    fingerprint(step.arguments) !== fingerprint(original.arguments) ||
    step.gateway !== gateway ||
    step.account_id !== b.account_id ||
    step.connection_id !== b.connection_id ||
    step.expected_currency !== b.currency
  )
    fail(
      'This step differs from the source-bound exclusion preview. Prepare a new draft.',
      'SEARCH_EXCLUSION_PLAN_CHANGED',
    );
  return target;
}
/** Reject an altered new draft before its automatic prerequisite reads. */
export function assertNewSearchExclusionDraft(store: Store, actor: Actor, run: JsonObject) {
  if (!run.search_exclusions || !run.steps.every((s: JsonObject) => s.status === 'pending')) return;
  sourceCurrent(store, actor, run.search_exclusions);
  for (const step of run.steps) unchangedStep(run.search_exclusions, run, step);
}
/** Accepted or uncertain receipts retain their original recovery; these checks apply only before unsent changes. */
export async function assertSearchExclusionStep(
  store: Store,
  call: ToolCall,
  actor: Actor,
  run: JsonObject,
  step: JsonObject,
) {
  const b = run.search_exclusions;
  if (!b || step.status === 'executing') return;
  sourceCurrent(store, actor, b);
  const target = unchangedStep(b, run, step);
  const current = await nativeState(store, call, actor, b, [target]);
  sourceCurrent(store, actor, b);
  const latest = store.document(actor.tenantId, 'campaign_run', run.id);
  if (latest.revision !== run.revision || latest.state === 'cancelled')
    fail('The campaign plan changed during inspection.', 'REVISION_CONFLICT');
  if (
    fingerprint(current.parents) !==
    fingerprint(b.parents.filter((p: JsonObject) => p.ad_group_id === target.ad_group_id))
  )
    fail('The ad group context changed after preview. Prepare a new draft.', 'SEARCH_EXCLUSION_NATIVE_CHANGED');
}
