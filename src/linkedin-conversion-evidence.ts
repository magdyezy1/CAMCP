import type {Store} from './store.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from './types.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {linkedinVersion} from './linkedin-version.js';
import {storedLogin} from './connection-authority.js';

const gateway = 'linkedin_native_action';
const invalid = (message: string): never => bad(message, 'MEASUREMENT_EVIDENCE_INVALID');
const id = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value))
    invalid('LinkedIn conversion evidence requires exact positive IDs; unsafe numbers are not accepted.');
  return value as string;
};
const permission = (c: Connection) => {
  if (!c.scopes.some(s => ['r_ads', 'rw_ads'].includes(s)))
    bad('Reading LinkedIn conversion settings requires r_ads or rw_ads.', 'INSUFFICIENT_SCOPE');
};

/** Official account finder, checked against LinkedIn Conversion Tracking, 202609, 2026-10-05.
 * This grants only the exact account-filtered GET collection, not global conversion objects or writes. */
export function authorizeLinkedInConversionEvidenceRead(p: CompiledRequest, c: Connection, account: string): boolean {
  if (p.gateway !== gateway || p.path !== '/rest/conversions' || p.method !== 'GET' || !p.readOnly) return false;
  if (
    p.specialTransport ||
    p.body !== undefined ||
    (p.origin && p.origin !== 'https://api.linkedin.com') ||
    p.query.q !== 'account' ||
    p.query.account !== 'urn:li:sponsoredAccount:' + account ||
    Object.keys(p.query).some(k => !['q', 'account', 'start', 'count'].includes(k)) ||
    (p.query.start !== undefined &&
      (!Number.isSafeInteger(p.query.start) || p.query.start < 0 || p.query.start > 100000)) ||
    (p.query.count !== undefined && (!Number.isSafeInteger(p.query.count) || p.query.count < 1 || p.query.count > 100))
  )
    return false;
  permission(c);
  return true;
}

function projectRule(row: unknown, account: string): JsonObject {
  if (
    !obj(row) ||
    row.account !== 'urn:li:sponsoredAccount:' + account ||
    row.error !== undefined ||
    row.errors !== undefined
  )
    invalid('LinkedIn returned a foreign or malformed conversion rule.');
  const r = row as JsonObject,
    selected = id(r.id);
  if (r.key !== undefined && (!obj(r.key) || id(r.key.id) !== selected || r.key.account !== r.account))
    invalid('LinkedIn returned conflicting conversion rule identity.');
  const text = (field: string, max: number, min = 0) => {
    const value = r[field];
    if (value === undefined) return null;
    if (
      typeof value !== 'string' ||
      value.length < min ||
      value.length > max ||
      (min > 0 && !value.trim()) ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      invalid('LinkedIn returned an invalid conversion label or setting.');
    return value;
  };
  const days = (field: string) => {
    const value = r[field];
    if (value === undefined) return null;
    if (!Number.isSafeInteger(value) || value < 0 || value > 365)
      invalid('LinkedIn returned an invalid conversion window.');
    return value;
  };
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean')
    invalid('LinkedIn returned an invalid conversion status.');
  let value = null;
  if (r.value !== undefined) {
    if (
      !obj(r.value) ||
      typeof r.value.amount !== 'string' ||
      !/^-?\d{1,30}(?:\.\d{1,18})?$/.test(r.value.amount) ||
      typeof r.value.currencyCode !== 'string' ||
      !/^[A-Z]{3}$/.test(r.value.currencyCode)
    )
      invalid('LinkedIn returned an imprecise or malformed configured conversion value.');
    value = {amount: r.value.amount, currency: r.value.currencyCode};
  }
  // Observed activity (MSR-04): LinkedIn's report of the last time a URL match rule fired (lastCallbackAt; LinkedIn
  // says it may take 20 minutes to update) and of the latest first-party callback. Epoch milliseconds; absent stays
  // null, which means unknown, never "never fired". These are observations: the write-state projection
  // (linkedinConversionConfiguration) strips them, so they never enter a write fingerprint.
  const observedAt = (field: string) => {
    const value = r[field];
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || value < 1) invalid('LinkedIn returned an invalid conversion callback time.');
    return value;
  };
  return {
    id: selected,
    urn: 'urn:lla:llaPartnerConversion:' + selected,
    name: text('name', 256),
    type: text('type', 100),
    conversion_method: text('conversionMethod', 100, 1),
    ownership_type: text('ownershipType', 100, 1),
    enabled: r.enabled ?? null,
    attribution_type: text('attributionType', 100),
    post_click_days: days('postClickAttributionWindowSize'),
    post_view_days: days('viewThroughAttributionWindowSize'),
    value_type: text('valueType', 100),
    value,
    last_callback_at: observedAt('lastCallbackAt'),
    latest_first_party_callback_at: observedAt('latestFirstPartyCallbackAt'),
  };
}

/** Current configuration only. No event observations, historical attribution or campaign membership are inferred. */
export async function linkedInConversionEvidence(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  if (input.gateway !== gateway)
    bad('Conversion configuration discovery currently supports LinkedIn.', 'MEASUREMENT_CONVERSIONS_UNQUALIFIED');
  if (typeof input.account_id !== 'string') invalid('Select the exact LinkedIn advertising account ID.');
  const account = id(input.account_id);
  validate(input.requirements ?? {}, []);
  store.assertActorActive(actor);
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id),
    authorization = fingerprint({
      login: storedLogin(store, connection),
      scopes: [...connection.scopes].sort(),
    }),
    scope = {gateway, account_id: account, connection_id: connection.id, api_version: linkedinVersion()},
    budget = new ReportCollectionBudget(undefined, fingerprint(scope), () => {}, {
      requests: 30,
      rows: 1000,
      bytes: 8 * 1024 * 1024,
      elapsed_ms: 60000,
    });
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    permission(c);
    if (fingerprint({login: storedLogin(store, c), scopes: [...c.scopes].sort()}) !== authorization)
      bad(
        'The LinkedIn login or permissions changed. Read current conversion settings again.',
        'CONNECTION_AUTHORITY_CHANGED',
      );
    budget.check();
  };
  const read = async (args: JsonObject) => {
    current();
    const request = {
        ...args,
        account_id: account,
        connection_id: connection.id,
        api_version: scope.api_version,
        aggregate_pages: false,
        dry_run: false,
      },
      result = await call(gateway, request, actor);
    current();
    if (result.success !== true)
      bad(
        result.error?.message ?? 'Conversion configuration could not be read.',
        result.error?.code ?? 'MEASUREMENT_EVIDENCE_INVALID',
      );
    const data = result.data?.data;
    if (
      !obj(data) ||
      result.data?.dry_run ||
      result.data?.executed === false ||
      [result.data, data].some(
        v =>
          v.error !== undefined ||
          v.errors !== undefined ||
          v.truncated === true ||
          v.serviceErrorCode !== undefined ||
          ['nextPageToken', 'next_page_token', 'has_more', 'hasMore', 'pagination'].some(k => v[k] !== undefined),
      )
    )
      invalid('LinkedIn did not return complete conversion configuration evidence.');
    return {
      data: data as JsonObject,
      evidence: {source_request: request, source_hash: fingerprint(result.data), captured_at: Date.now()},
    };
  };
  try {
    return await budget.run(async () => {
      const checks: JsonObject[] = [];
      let currency: string | undefined;
      const verifyAccount = async () => {
        const {data, evidence} = await read({
          action: 'linkedin_rest_ad_accounts_ad_account_id_get',
          path_params: {ad_account_id: account},
        });
        if (
          id(data.id) !== account ||
          typeof data.currency !== 'string' ||
          !/^[A-Z]{3}$/.test(data.currency) ||
          (currency !== undefined && currency !== data.currency) ||
          ['elements', 'paging', 'metadata', 'data'].some(k => data[k] !== undefined)
        )
          invalid('LinkedIn account identity or currency changed or could not be established.');
        currency = data.currency;
        checks.push(evidence);
      };
      await verifyAccount();
      const rules: JsonObject[] = [],
        pages: JsonObject[] = [],
        seen = new Set<string>();
      let start = 0,
        total: number | undefined,
        totalPresent: boolean | undefined,
        complete = false;
      for (let page = 1; page <= 25; page++) {
        const {data, evidence} = await read({
            action: 'linkedin_rest_conversions_get',
            query: {q: 'account', account: 'urn:li:sponsoredAccount:' + account, start, count: 100},
          }),
          paging = data.paging;
        if (
          !Array.isArray(data.elements) ||
          !obj(paging) ||
          paging.start !== start ||
          !Number.isSafeInteger(paging.count) ||
          paging.count < 1 ||
          paging.count > 100 ||
          data.elements.length > paging.count ||
          !Array.isArray(paging.links) ||
          (data.metadata !== undefined && (!obj(data.metadata) || Object.keys(data.metadata).length)) ||
          Object.keys(paging).some(k => !['start', 'count', 'total', 'links'].includes(k))
        )
          invalid('LinkedIn returned incomplete or unrecognized conversion collection paging.');
        const hasTotal = paging.total !== undefined;
        if (totalPresent !== undefined && hasTotal !== totalPresent)
          invalid('LinkedIn changed conversion count metadata.');
        totalPresent = hasTotal;
        if (hasTotal) {
          if (
            !Number.isSafeInteger(paging.total) ||
            paging.total < 0 ||
            paging.total > 1000 ||
            (total !== undefined && total !== paging.total)
          )
            invalid('LinkedIn conversion counts changed or exceed 1000 rules.');
          total = paging.total;
        }
        let next = false;
        for (const link of paging.links) {
          if (
            !obj(link) ||
            !['next', 'prev'].includes(link.rel) ||
            typeof link.href !== 'string' ||
            link.href.length > 8192
          )
            invalid('LinkedIn returned an unknown conversion continuation link.');
          if (link.rel !== 'next') continue;
          if (next) invalid('LinkedIn returned duplicate conversion continuation links.');
          next = true;
          let url: URL;
          try {
            url = new URL(link.href, 'https://api.linkedin.com');
          } catch {
            return invalid('LinkedIn returned a malformed conversion continuation link.');
          }
          if (
            url.origin !== 'https://api.linkedin.com' ||
            url.pathname !== '/rest/conversions' ||
            url.username ||
            url.password ||
            url.hash ||
            ['start', 'count', 'q', 'account'].some(k => url.searchParams.getAll(k).length > 1) ||
            (url.searchParams.has('start') && url.searchParams.get('start') !== String(start + paging.count)) ||
            (url.searchParams.has('count') && url.searchParams.get('count') !== String(paging.count)) ||
            (url.searchParams.has('q') && url.searchParams.get('q') !== 'account') ||
            (url.searchParams.has('account') &&
              url.searchParams.get('account') !== 'urn:li:sponsoredAccount:' + account)
          )
            invalid('LinkedIn conversion continuation changed account, route, offset or page size.');
        }
        for (const raw of data.elements) {
          const row = projectRule(raw, account);
          if (seen.has(row.id)) invalid('LinkedIn returned duplicate conversion rules.');
          seen.add(row.id);
          rules.push(row);
        }
        if (rules.length > 1000) invalid('Narrow conversion configuration to at most 1000 rules.');
        budget.rows('conversion_rules', rules.length);
        pages.push({...evidence, page, row_count: data.elements.length});
        if (total !== undefined) {
          if (
            rules.length > total ||
            (rules.length === total && next) ||
            (rules.length < total && data.elements.length < paging.count)
          )
            invalid('LinkedIn conversion pages disagree with the declared count.');
          if (rules.length === total) {
            complete = true;
            break;
          }
        } else if (!next && data.elements.length < paging.count) {
          complete = true;
          break;
        }
        if (!data.elements.length || (next && data.elements.length < paging.count))
          invalid('LinkedIn conversion paging ended prematurely.');
        start += paging.count;
      }
      if (!complete) invalid('LinkedIn conversion configuration exceeds 25 pages.');
      await verifyAccount();
      current();
      return {
        record_kind: 'conversion_rules',
        scope,
        collection_request: {
          finder: 'account',
          ownership_selection: 'provider_default_owned',
          shared_rules_requested: false,
        },
        captured_at: Date.now(),
        complete: true,
        rules,
        rule_count: rules.length,
        account_evidence: {currency, checks},
        source_pages: pages,
        source_hash: fingerprint({
          scope,
          accounts: checks.map(c => c.source_hash),
          pages: pages.map(p => p.source_hash),
        }),
        checks: {
          configuration: 'observed',
          // Provider-reported last callback times per rule (MSR-04); null rules stay unknown. Not delivery proof.
          observed_activity: rules.some(r => r.last_callback_at !== null || r.latest_first_party_callback_at !== null)
            ? 'provider_reported'
            : 'not_reported',
          event_delivery: 'unverified',
          deduplication: 'unverified',
          consent: 'unverified',
          historical_attribution: 'unverified',
          campaign_membership: 'not_collected',
        },
        advertising_writes: 0,
        retained_snapshot: false,
        meaning:
          "The account finder requests LinkedIn's default owned-rule selection; shared rules were not requested. Current LinkedIn conversion rule settings only. Missing native fields stay unknown. last_callback_at and latest_first_party_callback_at are LinkedIn's own last-fired observations (epoch milliseconds; LinkedIn notes up to about 20 minutes of lag); null is unknown, not 'never fired'. Campaign membership, event delivery, deduplication, consent and historical report attribution are not established. No event was sent, rule changed or snapshot saved.",
      };
    });
  } finally {
    budget.close();
  }
}
