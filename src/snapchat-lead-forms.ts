import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Snapchat lead generation form creation (POST /v1/adaccounts/{id}/lead_generation_forms), per the official
 * Lead Generation Ads guide checked 2026-09-26. A form is a reusable question definition: creating one starts
 * no delivery and spends nothing. Submitted leads are personal data; lead reports and webhooks stay unqualified.
 */
const standardFields = [
  'FIRST_NAME',
  'LAST_NAME',
  'EMAIL',
  'PHONE_NUMBER',
  'ADDRESS',
  'POSTAL_CODE',
  'BIRTHDAY_DATE',
  'JOB_TITLE',
  'COMPANY_NAME',
];
const customTypes = ['TEXT', 'DATE', 'MULTIPLE_CHOICE_SINGLE_SELECTION', 'MULTIPLE_CHOICE_MULTI_SELECTION'];
const endPageActions = [
  'VIEW_WEBSITE',
  'BOOK_NOW',
  'LEARN_MORE',
  'DONATE',
  'SPECIAL_OFFER',
  'SCHEDULE_NOW',
  'BUY_TICKETS',
  'TEST_DRIVE',
  'APPLY_NOW',
  'GET_COUPON',
  'CLAIM_SAMPLE',
  'FREE_TRIAL',
];
const formKeys = [
  'ad_account_id',
  'name',
  'description',
  'title',
  'form_fields',
  'privacy_policy_url',
  'legal_disclosures',
  'banner_media_id',
  'end_page_properties',
];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const snapId = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
const webUrl = (v: unknown) => {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
};
const pick = (o: unknown, keys: string[]) =>
  obj(o) ? Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])) : o;

export const snapLeadFormKind = (p: CompiledRequest) =>
  p.gateway === 'snapchat_native_action' &&
  p.method === 'POST' &&
  /^\/v1\/adaccounts\/[^/]+\/lead_generation_forms$/.test(p.path);

function invalid(index: number, field: string, message: string): never {
  throw new MirrorError('INVALID_SNAPCHAT_LEAD_FORM', message, {record: index, field});
}
function text(v: unknown, index: number, field: string, max?: number) {
  if (typeof v !== 'string' || !v.trim()) invalid(index, field, field + ' must be nonempty text.');
  if (max !== undefined && [...v].length > max)
    invalid(index, field, field + ' has a documented maximum of ' + max + ' characters.');
}
function only(v: JsonObject, keys: string[], index: number, path: string) {
  const extra = Object.keys(v).find(k => !keys.includes(k));
  if (extra) invalid(index, path + extra, '"' + path + extra + '" is outside the qualified lead form contract.');
}

/** Validates every record before review; nothing here reads or contacts Snapchat. */
export function assertSnapLeadForms(plan: CompiledRequest, rows: unknown[]): void {
  const account = /^\/v1\/adaccounts\/([^/]+)\//.exec(plan.path)?.[1];
  rows.forEach((row, index) => {
    if (!obj(row)) invalid(index, '', 'Each lead form must be an object.');
    only(row, formKeys, index, '');
    if (row.ad_account_id !== undefined && row.ad_account_id !== account)
      invalid(index, 'ad_account_id', 'ad_account_id must equal the selected ad account.');
    text(row.name, index, 'name');
    text(row.description, index, 'description', 180);
    text(row.title, index, 'title', 25);
    if (!Array.isArray(row.form_fields) || !row.form_fields.length)
      invalid(index, 'form_fields', 'form_fields must list the questions.');
    let preferredQuestions = 0;
    (row.form_fields as unknown[]).forEach((field, i) => {
      const path = 'form_fields/' + i + '/';
      if (!obj(field)) invalid(index, path, 'Each form field must be an object.');
      only(field, ['type', 'custom_form_field_properties'], index, path);
      if (field.type === 'CUSTOM') {
        const custom = field.custom_form_field_properties;
        if (!obj(custom))
          invalid(index, path + 'custom_form_field_properties', 'A CUSTOM field needs custom_form_field_properties.');
        only(custom, ['type', 'description', 'multiple_choice_options'], index, path + 'custom_form_field_properties/');
        if (!customTypes.includes(custom.type))
          invalid(
            index,
            path + 'custom_form_field_properties/type',
            'Custom type must be one of ' + customTypes.join(', ') + '.',
          );
        text(custom.description, index, path + 'custom_form_field_properties/description');
        const choices = custom.multiple_choice_options;
        if (String(custom.type).startsWith('MULTIPLE_CHOICE')) {
          if (!Array.isArray(choices) || !choices.length)
            invalid(
              index,
              path + 'custom_form_field_properties/multiple_choice_options',
              'Multiple-choice questions need multiple_choice_options.',
            );
          const statuses = choices.map((c, j) => {
            if (!obj(c)) invalid(index, path + 'multiple_choice_options/' + j, 'Each option must be an object.');
            only(
              c,
              ['choice_description', 'option_preferred_status'],
              index,
              path + 'multiple_choice_options/' + j + '/',
            );
            text(c.choice_description, index, path + 'multiple_choice_options/' + j + '/choice_description');
            return c.option_preferred_status;
          });
          if (statuses.some(s => s !== undefined)) {
            if (custom.type !== 'MULTIPLE_CHOICE_SINGLE_SELECTION')
              invalid(
                index,
                path + 'custom_form_field_properties/type',
                'Preferred options are only documented for MULTIPLE_CHOICE_SINGLE_SELECTION.',
              );
            if (
              statuses.some(s => s !== 'PREFERRED' && s !== 'NOT_PREFERRED') ||
              !statuses.includes('PREFERRED') ||
              !statuses.includes('NOT_PREFERRED')
            )
              invalid(
                index,
                path + 'custom_form_field_properties/multiple_choice_options',
                'Mark every option PREFERRED or NOT_PREFERRED, with at least one of each.',
              );
            preferredQuestions++;
          }
        } else if (choices !== undefined)
          invalid(
            index,
            path + 'custom_form_field_properties/multiple_choice_options',
            'Only multiple-choice questions take options.',
          );
      } else {
        if (!standardFields.includes(field.type))
          invalid(index, path + 'type', 'Field type must be CUSTOM or one of ' + standardFields.join(', ') + '.');
        if (field.custom_form_field_properties !== undefined)
          invalid(
            index,
            path + 'custom_form_field_properties',
            'Only CUSTOM fields take custom_form_field_properties.',
          );
      }
    });
    if (preferredQuestions > 1) invalid(index, 'form_fields', 'Only one question per form can use preferred options.');
    const types = new Set((row.form_fields as JsonObject[]).map(f => f.type));
    if (!types.has('FIRST_NAME') || !types.has('LAST_NAME'))
      invalid(index, 'form_fields', 'Snapchat requires FIRST_NAME and LAST_NAME fields.');
    if (!types.has('EMAIL') && !types.has('PHONE_NUMBER'))
      invalid(index, 'form_fields', 'Snapchat requires an EMAIL or PHONE_NUMBER field.');
    if (types.has('ADDRESS') && types.has('POSTAL_CODE'))
      invalid(index, 'form_fields', 'ADDRESS and POSTAL_CODE cannot both be included.');
    if (row.privacy_policy_url !== undefined && !webUrl(row.privacy_policy_url))
      invalid(index, 'privacy_policy_url', 'privacy_policy_url must be an absolute http(s) URL.');
    if (row.banner_media_id !== undefined && !snapId(row.banner_media_id))
      invalid(index, 'banner_media_id', 'banner_media_id must be a Snapchat media ID.');
    const legal = row.legal_disclosures;
    if (legal !== undefined) {
      if (!obj(legal)) invalid(index, 'legal_disclosures', 'legal_disclosures must be an object.');
      only(legal, ['title', 'description', 'consent_form_fields'], index, 'legal_disclosures/');
      text(legal.title, index, 'legal_disclosures/title', 35);
      text(legal.description, index, 'legal_disclosures/description', 80);
      const consents = legal.consent_form_fields;
      if (consents !== undefined) {
        if (!Array.isArray(consents) || !consents.length || consents.length > 2)
          invalid(index, 'legal_disclosures/consent_form_fields', 'consent_form_fields holds one or two consents.');
        consents.forEach((c, j) => {
          if (!obj(c)) invalid(index, 'legal_disclosures/consent_form_fields/' + j, 'Each consent must be an object.');
          only(c, ['consent_description', 'required'], index, 'legal_disclosures/consent_form_fields/' + j + '/');
          text(c.consent_description, index, 'legal_disclosures/consent_form_fields/' + j + '/consent_description');
          if (typeof c.required !== 'boolean')
            invalid(
              index,
              'legal_disclosures/consent_form_fields/' + j + '/required',
              'required must be true or false.',
            );
        });
      }
    }
    const end = row.end_page_properties;
    if (end !== undefined) {
      if (!obj(end)) invalid(index, 'end_page_properties', 'end_page_properties must be an object.');
      only(end, ['call_to_action', 'url'], index, 'end_page_properties/');
      if (!endPageActions.includes(end.call_to_action))
        invalid(
          index,
          'end_page_properties/call_to_action',
          'call_to_action must be one of ' + endPageActions.join(', ') + '.',
        );
      if (!webUrl(end.url))
        invalid(index, 'end_page_properties/url', 'end_page_properties.url must be an absolute http(s) URL.');
    }
  });
}

/** A creative's form is read for ownership, so an ID that cannot be read must not skip that read. */
export function assertSnapLeadCreativeRefs(rows: unknown[]): void {
  rows.forEach((row, index) => {
    if (obj(row) && row.lead_generation_form_id !== undefined && !snapId(row.lead_generation_form_id))
      invalid(index, 'lead_generation_form_id', 'lead_generation_form_id must be a Snapchat lead form ID.');
  });
}

/**
 * Creative PUT/PATCH can repoint a creative to another lead form or top-snap media. An unchanged reference is
 * already part of the creative; a changed one must be owned by this login, as creation requires. Checked against
 * the frozen state at review and the fresh state at execution.
 */
export function assertSnapCreativeReferences(
  plan: CompiledRequest,
  state: unknown[],
  owns: (resource: string) => boolean,
): void {
  if (plan.gateway !== 'snapchat_native_action' || !['PUT', 'PATCH'].includes(plan.method)) return;
  const route = /^\/v1\/adaccounts\/[^/]+\/creatives(?:\/([^/]+))?$/.exec(plan.path);
  if (!route) return;
  const current = state
    .flatMap(s => (obj(s) && Array.isArray(s.creatives) ? s.creatives : []))
    .map((r: JsonObject) => r?.creative)
    .filter(obj) as JsonObject[];
  const updates: {id: string; values: JsonObject}[] =
    plan.method === 'PUT'
      ? (obj(plan.body) && Array.isArray(plan.body.creatives) ? plan.body.creatives : []).map((r: JsonObject) => ({
          id: String(r?.id),
          values: obj(r) ? r : {},
        }))
      : [
          {
            id: String(route[1]),
            values: Object.fromEntries(
              (Array.isArray(plan.body) ? plan.body : [])
                .filter((op: JsonObject) => ['add', 'replace'].includes(op?.op) && typeof op.path === 'string')
                .map((op: JsonObject) => [op.path.slice(1), op.value]),
            ),
          },
        ];
  for (const {id, values} of updates) {
    const before = current.find(c => String(c.id) === id);
    for (const [field, collection] of [
      ['lead_generation_form_id', 'lead_generation_forms'],
      ['top_snap_media_id', 'media'],
    ] as const) {
      const next = values[field];
      if (next === undefined || (before !== undefined && next === before[field])) continue;
      if (!snapId(next))
        throw new MirrorError('INVALID_ARGUMENT', field + ' must be a Snapchat ID.', {creative_id: id, field});
      if (!owns(collection + '/' + next))
        throw new MirrorError(
          'RESOURCE_SCOPE_REQUIRED',
          'A changed ' +
            field +
            ' must reference a resource this login owns. Read its account-scoped collection first.',
          {
            gateway: plan.gateway,
            path: '/v1/' + collection + '/' + next,
            account_id: plan.accountId,
            creative_id: id,
            field,
          },
          403,
        );
    }
  }
}

/**
 * Account-owned dependencies read before review and again before execution: a form's banner media, and the
 * form behind a LEAD_GENERATION creative. Each read requires existing ownership of that global Snapchat ID.
 */
export function snapLeadDependencyPaths(plan: CompiledRequest): string[] {
  if (plan.gateway !== 'snapchat_native_action' || plan.method !== 'POST') return [];
  const body = obj(plan.body) ? plan.body : {},
    kind = plan.path.split('/').at(-1);
  const ids =
    kind === 'lead_generation_forms'
      ? (body.lead_generation_forms ?? [])
          .map((r: JsonObject) => r?.banner_media_id)
          .filter(snapId)
          .map((id: string) => '/v1/media/' + id)
      : kind === 'creatives'
        ? (body.creatives ?? [])
            .map((r: JsonObject) => r?.lead_generation_form_id)
            .filter(snapId)
            .map((id: string) => '/v1/lead_generation_forms/' + id)
        : [];
  return [...new Set<string>(ids)];
}

/** Configuration Snapchat echoes for a form, without provider-added fields such as is_required or strategy_type. */
export function snapLeadFormProjection(form: unknown): unknown {
  if (!obj(form)) return form;
  const out: JsonObject = pick(form, [
    'ad_account_id',
    'name',
    'description',
    'title',
    'privacy_policy_url',
    'banner_media_id',
  ]) as JsonObject;
  const legal = form.legal_disclosures;
  if (obj(legal))
    out.legal_disclosures = {
      ...(pick(legal, ['title', 'description']) as JsonObject),
      ...(Array.isArray(legal.consent_form_fields)
        ? {consent_form_fields: legal.consent_form_fields.map(c => pick(c, ['consent_description', 'required']))}
        : {}),
    };
  if (form.end_page_properties !== undefined)
    out.end_page_properties = pick(form.end_page_properties, ['call_to_action', 'url']);
  if (Array.isArray(form.form_fields))
    out.form_fields = form.form_fields.map(f => {
      if (!obj(f)) return f;
      const custom = f.custom_form_field_properties;
      return {
        type: f.type,
        ...(obj(custom)
          ? {
              custom_form_field_properties: {
                ...(pick(custom, ['type', 'description']) as JsonObject),
                ...(Array.isArray(custom.multiple_choice_options)
                  ? {
                      multiple_choice_options: custom.multiple_choice_options.map(o =>
                        pick(o, ['choice_description', 'option_preferred_status']),
                      ),
                    }
                  : {}),
              },
            }
          : {}),
      };
    });
  return out;
}
