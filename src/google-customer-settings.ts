import {MirrorError} from './errors.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Account settings of a Google Ads customer, API v23 (pinned Discovery document: CustomerService.MutateCustomer,
 * CustomerOperation, Customer and CallReportingSetting; checked 2026-09-27). An update changes auto-tagging, the account
 * tracking template and final URL suffix, the descriptive name, call reporting, or the video brand safety suitability,
 * which Google documents as "Only mutable in an update operation"; the time zone and currency are immutable.
 */
type Read = CompiledRequest & {googleCustomerSettingsState?: {conversionAction?: string}};
const fields = [
  'autoTaggingEnabled',
  'trackingUrlTemplate',
  'finalUrlSuffix',
  'descriptiveName',
  'videoBrandSafetySuitability',
  'callReportingSetting',
];
const callFields = ['callReportingEnabled', 'callConversionReportingEnabled', 'callConversionAction'];
/** Narrowest first: moving right widens where video ads may show. */
const suitability = ['LIMITED_INVENTORY', 'STANDARD_INVENTORY', 'EXPANDED_INVENTORY'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_GOOGLE_CUSTOMER_SETTING', message);
}
function unverified(message: string): never {
  return fail('CUSTOMER_SETTING_STATE_UNVERIFIED', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.');
  return id!;
};
export function googleCustomerSettingsKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v23\/customers\/\d+:mutate$/.test(p.path)
  );
}
/** The fields a mask names: whole top-level fields, or call reporting fields one by one. */
function masked(v: unknown): string[] {
  const mask =
    typeof v === 'string'
      ? v
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : [];
  if (
    !mask.length ||
    new Set(mask).size !== mask.length ||
    mask.some(f => !fields.includes(f) && !callFields.map(c => 'callReportingSetting.' + c).includes(f))
  )
    invalid(
      'updateMask lists fields among ' +
        fields.join(', ') +
        ' (or callReportingSetting.' +
        callFields.join(', callReportingSetting.') +
        '); the time zone, currency and output-only fields do not change.',
    );
  if (mask.includes('callReportingSetting') && mask.some(f => f.startsWith('callReportingSetting.')))
    invalid('Name callReportingSetting whole or field by field, not both.');
  return mask;
}
const operationOf = (p: CompiledRequest) => googleJson(p.body).operation as JsonObject;
/** Every setting the request writes, as dotted names with their values. */
function writes(p: CompiledRequest): Record<string, unknown> {
  const op = operationOf(p),
    u = op.update as JsonObject,
    out: Record<string, unknown> = {};
  for (const f of masked(op.updateMask)) {
    if (f === 'callReportingSetting') {
      for (const c of callFields)
        out['callReportingSetting.' + c] = object(u.callReportingSetting) ? u.callReportingSetting[c] : undefined;
      continue;
    }
    const [top, leaf] = f.split('.') as [string, string | undefined];
    out[f] = leaf ? (object(u[top]) ? u[top][leaf] : undefined) : u[top];
  }
  return out;
}
function url(v: unknown, label: string): void {
  if (typeof v !== 'string' || [...v].length > 2048 || /\s/.test(v))
    invalid(label + ' is text of up to 2048 characters without spaces; send "" to clear it.');
}
export function assertGoogleCustomerSettings(p: CompiledRequest): void {
  if (!googleCustomerSettingsKind(p)) return;
  const id = account(p);
  if (p.path.split('/')[3] !== id + ':mutate')
    fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected customer.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Account setting reviews take no query or header overrides.');
  const b = googleJson(p.body);
  if (!object(b) || Object.keys(b).some(k => !['operation', 'validateOnly', 'responseContentType'].includes(k)))
    invalid('Send {operation} with one update.');
  if (b.validateOnly !== undefined && b.validateOnly !== false)
    invalid('validateOnly must be false; inspect the review instead.');
  if (
    b.responseContentType !== undefined &&
    !['RESOURCE_NAME_ONLY', 'MUTABLE_RESOURCE'].includes(b.responseContentType)
  )
    invalid('responseContentType is RESOURCE_NAME_ONLY or MUTABLE_RESOURCE.');
  const op = b.operation;
  if (!object(op) || Object.keys(op).some(k => !['update', 'updateMask'].includes(k)) || !object(op.update))
    invalid('The operation is {update, updateMask}: customers are not created or removed here.');
  const u = op.update,
    mask = masked(op.updateMask);
  if (u.resourceName !== 'customers/' + id)
    invalid('update.resourceName is customers/' + id + ', the selected customer.');
  const tops = new Set(mask.map(f => f.split('.')[0]!));
  const extra = Object.keys(u).filter(k => k !== 'resourceName' && !tops.has(k));
  if (extra.length)
    invalid('The update carries exactly the fields in updateMask; not masked: ' + extra.join(', ') + '.');
  const w = writes(p);
  for (const [f, v] of Object.entries(w)) {
    if (v === undefined) invalid(f + ' is named in updateMask but not sent.');
    if (
      f === 'autoTaggingEnabled' ||
      f === 'callReportingSetting.callReportingEnabled' ||
      f === 'callReportingSetting.callConversionReportingEnabled'
    ) {
      if (typeof v !== 'boolean') invalid(f + ' is a boolean.');
      continue;
    }
    if (f === 'trackingUrlTemplate') {
      url(v, f);
      if (v !== '' && !/\{(?:lpurl|unescapedlpurl|escapedlpurl|lpurl\+2|lpurl\+3)\}/.test(String(v)))
        invalid(
          'trackingUrlTemplate includes {lpurl} (or {unescapedlpurl}, {escapedlpurl}, {lpurl+2}, {lpurl+3}) so the landing page is reached; send "" to clear it.',
        );
      if (v !== '' && !/^(?:https?:\/\/|\{)/.test(String(v)))
        invalid('trackingUrlTemplate starts with http://, https:// or a ValueTrack parameter.');
      continue;
    }
    if (f === 'finalUrlSuffix') {
      url(v, f);
      if (/^[?#&]/.test(String(v)))
        invalid('finalUrlSuffix is key=value pairs joined by &, without a leading ?, # or &.');
      continue;
    }
    if (f === 'descriptiveName') {
      if (typeof v !== 'string' || !v.trim() || v !== v.trim() || [...v].length > 255 || /[\u0000-\u001f]/.test(v))
        invalid('descriptiveName has 1–255 characters without surrounding spaces or control characters.');
      continue;
    }
    if (f === 'videoBrandSafetySuitability') {
      if (!suitability.includes(String(v))) invalid('videoBrandSafetySuitability is ' + suitability.join(', ') + '.');
      continue;
    }
    if (
      f === 'callReportingSetting.callConversionAction' &&
      (typeof v !== 'string' || !new RegExp('^customers/' + id + '/conversionActions/[1-9][0-9]*$').test(v))
    )
      invalid('callConversionAction is a conversion action of the selected customer.');
  }
  if (
    w['callReportingSetting.callConversionReportingEnabled'] === true &&
    w['callReportingSetting.callReportingEnabled'] === false
  )
    invalid('Call conversion reporting needs call reporting enabled.');
}

const settingsQuery =
  'SELECT customer.id, customer.manager, customer.auto_tagging_enabled, customer.tracking_url_template, customer.final_url_suffix, customer.descriptive_name, customer.video_brand_safety_suitability, customer.call_reporting_setting.call_reporting_enabled, customer.call_reporting_setting.call_conversion_reporting_enabled, customer.call_reporting_setting.call_conversion_action FROM customer LIMIT 1';
function read(p: CompiledRequest, query: string): Read {
  return {
    ...p,
    action: 'AMCP_GOOGLE_CUSTOMER_SETTINGS_READ',
    method: 'POST',
    path: '/v23/customers/' + account(p) + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    googleCustomerSettingsState: undefined,
  };
}
export function googleCustomerSettingsSnapshots(p: CompiledRequest): Read[] {
  const action = writes(p)['callReportingSetting.callConversionAction'];
  return [
    {
      ...read(p, settingsQuery),
      googleCustomerSettingsState: typeof action === 'string' ? {conversionAction: action} : {},
    },
  ];
}
export function isGoogleCustomerSettingsRead(p: CompiledRequest): p is Read {
  return !!(p as Read).googleCustomerSettingsState;
}
const rows = (r: TransportResult): JsonObject[] => {
  const d = r.data;
  if (r.status !== 200 || !object(d) || (d.results !== undefined && !Array.isArray(d.results)) || d.nextPageToken)
    unverified('Google returned a failed, paged or unrecognized search response.');
  const out = (d.results ?? []) as unknown[];
  if (out.some(v => !object(v))) unverified('A search row is malformed.');
  return out as JsonObject[];
};
/** The customer's settings and, when call conversions are pointed at one, that conversion action. */
export async function readGoogleCustomerSettings(
  p: CompiledRequest,
  send: (p: Read) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).googleCustomerSettingsState;
  if (!s) return send(p);
  const found = rows(await send({...(p as Read), googleCustomerSettingsState: undefined})),
    c = found[0]?.customer;
  if (found.length !== 1 || !object(c) || String(c.id) !== account(p)) unverified('Verify the selected customer.');
  const call = object(c.callReportingSetting) ? c.callReportingSetting : {};
  const settings: JsonObject = {
    manager: c.manager === true,
    autoTaggingEnabled: c.autoTaggingEnabled === true,
    trackingUrlTemplate: c.trackingUrlTemplate ?? '',
    finalUrlSuffix: c.finalUrlSuffix ?? '',
    descriptiveName: c.descriptiveName ?? null,
    videoBrandSafetySuitability: c.videoBrandSafetySuitability ?? null,
    'callReportingSetting.callReportingEnabled': call.callReportingEnabled === true,
    'callReportingSetting.callConversionReportingEnabled': call.callConversionReportingEnabled === true,
    'callReportingSetting.callConversionAction': call.callConversionAction ?? null,
  };
  let action: JsonObject | null = null;
  if (s.conversionAction) {
    const a = rows(
      await send(
        read(
          p,
          "SELECT conversion_action.resource_name, conversion_action.name, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.resource_name = '" +
            s.conversionAction +
            "'",
        ),
      ),
    );
    const v = a[0]?.conversionAction;
    if (a.length > 1) unverified('The conversion action read returned more than one row.');
    action =
      object(v) && v.resourceName === s.conversionAction
        ? {resourceName: v.resourceName, name: v.name ?? null, type: v.type ?? null, status: v.status ?? null}
        : null;
  }
  return {status: 200, headers: {}, data: {customer: {id: account(p)}, settings, conversionAction: action}};
}
export function validateGoogleCustomerSettingsState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data;
  if (
    !(p as Read).googleCustomerSettingsState ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.customer) ||
    d.customer.id !== account(p) ||
    !object(d.settings)
  )
    unverified('Complete account settings state is missing.');
}
export function googleCustomerSettingsPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!googleCustomerSettingsKind(p)) return;
  const s = states[0];
  if (!object(s) || !object(s.settings)) unverified('Complete account settings state is missing.');
  const w = writes(p);
  if (Object.entries(w).every(([f, v]) => s.settings[f] === v)) invalid('The customer already has these settings.');
  const action = w['callReportingSetting.callConversionAction'];
  if (typeof action === 'string') {
    const a = s.conversionAction;
    if (!object(a))
      fail(
        'STATE_TARGET_MISMATCH',
        'Conversion action ' + action + ' is not a conversion action of the selected customer.',
        {conversion_action: action},
        409,
      );
    if (a.status !== 'ENABLED')
      invalid(
        'Conversion action ' +
          action +
          ' is ' +
          String(a.status) +
          '; call conversions count only toward an enabled action.',
      );
  }
  const call = (f: string) => (f in w ? w[f] : s.settings[f]);
  if (
    call('callReportingSetting.callConversionReportingEnabled') === true &&
    call('callReportingSetting.callReportingEnabled') === false
  )
    invalid('Call conversion reporting needs call reporting enabled.');
}
/** A video suitability change moves where video ads may show. */
export function googleCustomerSettingsNeedsConfirmation(p: CompiledRequest): boolean {
  return googleCustomerSettingsKind(p) && 'videoBrandSafetySuitability' in writes(p);
}
/** A broader video suitability widens where ads may show; the owner rule counts that as activation. */
export function googleCustomerSettingsWidens(p: CompiledRequest, before: unknown): boolean {
  if (!googleCustomerSettingsKind(p)) return false;
  const next = writes(p).videoBrandSafetySuitability;
  if (typeof next !== 'string') return false;
  const s = Array.isArray(before) ? before[0] : before,
    now = object(s) && object(s.settings) ? String(s.settings.videoBrandSafetySuitability) : '';
  return suitability.indexOf(next) > suitability.indexOf(now);
}
export function googleCustomerSettingsImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!googleCustomerSettingsKind(p)) return;
  const first = state[0],
    s: JsonObject = object(first) && object(first.settings) ? first.settings : {},
    w = writes(p);
  const changes = Object.fromEntries(Object.entries(w).map(([f, v]) => [f, {from: s[f] ?? null, to: v}]));
  const tracking = ['autoTaggingEnabled', 'trackingUrlTemplate', 'finalUrlSuffix'].some(f => f in w);
  return {
    provider: 'google',
    scope: 'customer_settings',
    customer: account(p),
    changes,
    may_affect_serving: 'videoBrandSafetySuitability' in w,
    effect: [
      tracking
        ? 'Tracking settings apply to every ad click of the account' +
          (w.autoTaggingEnabled === false
            ? '; without auto-tagging, Google Analytics and offline conversion imports lose the gclid'
            : '') +
          '.'
        : '',
      'videoBrandSafetySuitability' in w
        ? 'Video brand safety suitability decides which YouTube and partner inventory video ads may use.'
        : '',
      'callReportingSetting.callReportingEnabled' in w ||
      'callReportingSetting.callConversionReportingEnabled' in w ||
      'callReportingSetting.callConversionAction' in w
        ? 'Call reporting settings decide how calls from ads are reported and counted as conversions.'
        : '',
      'descriptiveName' in w ? 'The descriptive name is what people see in account lists.' : '',
    ]
      .filter(Boolean)
      .join(' '),
    verification: 'Reads the customer settings again and compares every field written.',
    source: 'https://developers.google.com/google-ads/api/reference/rpc/v23/Customer',
  };
}
export function googleCustomerSettingsOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  return r.status === 200 && object(d) && object(d.result) && d.result.resourceName === 'customers/' + account(p);
}
export function googleCustomerSettingsVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const w = writes(p);
  return [
    {
      read: {...read(p, settingsQuery), googleCustomerSettingsState: {}} as Read,
      expected: {
        settings: Object.fromEntries(
          Object.entries(w).map(([f, v]) => [
            f,
            f === 'callReportingSetting.callConversionAction' && v === '' ? null : v,
          ]),
        ),
      },
      id: 'customers/' + account(p),
    },
  ];
}
export function googleCustomerSettingsObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {settings: object(data.settings) ? data.settings : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleCustomerSettingsFamily: ReviewedFamily = {
  name: 'google_customer_settings',
  files: ['src/google-customer-settings.ts', ['tests/google-customer-settings.test.mjs']],
  kind: googleCustomerSettingsKind,
  assert: assertGoogleCustomerSettings,
  scope: assertGoogleAdsScope,
  snapshots: googleCustomerSettingsSnapshots,
  isRead: isGoogleCustomerSettingsRead,
  reader: readGoogleCustomerSettings,
  validateState: validateGoogleCustomerSettingsState,
  prerequisites: googleCustomerSettingsPrerequisites,
  impact: googleCustomerSettingsImpact,
  outcome: googleCustomerSettingsOutcome,
  verification: googleCustomerSettingsVerification,
  observed: googleCustomerSettingsObserved,
  spendConfirmation: {
    needed: googleCustomerSettingsNeedsConfirmation,
    message:
      'Video brand safety suitability decides which inventory video ads may use. Review the change and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: googleCustomerSettingsWidens,
};
