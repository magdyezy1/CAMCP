import {MirrorError} from './errors.js';
import {parseLinkedInValue} from './linkedin-restli.js';
import type {Store} from './store.js';
import type {TransportResult} from './transport.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';

/**
 * LinkedIn sponsored lead gen forms, per Microsoft Learn "Lead Syncing" and "Lead Syncing Schema" (li-lms-2026-09,
 * checked 2026-09-26). rw_ads manages and reads ad forms; lead responses need the separate Lead Sync program and
 * stay outside this contract. Forms are created in DRAFT for the selected ad account. Publishing, edits,
 * archiving, organization-owned forms, work-email submission criteria and form responses are not qualified.
 */
export const linkedinLeadFormsPath = '/rest/leadForms';
export const linkedinLeadFormSource =
  'https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/leadsync?view=li-lms-2026-09';
type FormRead = CompiledRequest & {linkedinLeadFormRead?: true};
const marker = 'AMCP_LINKEDIN_LEAD_FORM_READ';
const predefined = [
  'FIRST_NAME',
  'LAST_NAME',
  'PHONE_NUMBER',
  'EMAIL',
  'CITY',
  'STATE',
  'COUNTRY',
  'ZIP_CODE',
  'JOB_TITLE',
  'JOB_FUNCTION',
  'SENIORITY',
  'COMPANY_NAME',
  'COMPANY_SIZE',
  'INDUSTRY',
  'DEGREE',
  'FIELD_OF_STUDY',
  'SCHOOL',
  'START_DATE',
  'GRADUATION_DATE',
  'GENDER',
  'WORK_EMAIL',
  'LINKEDIN_PROFILE_LINK',
  'WORK_PHONE_NUMBER',
];
// The schema also lists "DOWNLOAD_NoW"; its wire spelling is unclear, so it is not accepted.
const ctaLabels = ['VISIT_COMPANY_WEBSITE', 'LEARN_MORE', 'VIEW_NOW', 'TRY_NOW'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const formId = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n
    ? v
    : typeof v === 'number' && Number.isSafeInteger(v) && v > 0
      ? String(v)
      : undefined;
const int = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 2147483647;
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && !controls.test(v);
const webUrl = (v: unknown) => {
  if (typeof v !== 'string' || controls.test(v)) return false;
  try {
    const u = new URL(v);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
};
const accountUrn = (id: string) => 'urn:li:sponsoredAccount:' + id;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_LINKEDIN_LEAD_FORM', message, {field});
}
function only(v: JsonObject, keys: string[], path: string) {
  const extra = Object.keys(v).find(k => !keys.includes(k));
  if (extra) invalid(path + extra, '"' + path + extra + '" is outside the qualified lead form contract.');
}

export function linkedinLeadFormKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'linkedin_native_action' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://api.linkedin.com') &&
    p.method === 'POST' &&
    p.path === linkedinLeadFormsPath
  );
}

/** A MultiLocaleString with text for the creation locale; keys follow the documented language_COUNTRY_variant form. */
function localized(v: unknown, path: string, locale: string, max?: number) {
  if (!object(v)) invalid(path, path + ' must be a MultiLocaleString object.');
  only(v, ['localized'], path + '/');
  if (!object(v.localized) || !Object.keys(v.localized).length)
    invalid(path + '/localized', path + '.localized must map locales to text.');
  if (!Object.hasOwn(v.localized, locale))
    invalid(path + '/localized', path + ' needs text for the creation locale ' + locale + '.');
  for (const [key, value] of Object.entries(v.localized)) {
    if (!/^[a-z]{2}(?:_[A-Z]{2}(?:_[A-Za-z0-9]+)?|__[A-Za-z0-9]+)?$/.test(key) || !text(value))
      invalid(
        path + '/localized/' + key,
        path + ' entries need a locale key and nonempty text without control characters.',
      );
    if (max !== undefined && [...(value as string)].length > max)
      invalid(path + '/localized/' + key, path + ' has a documented maximum of ' + max + ' characters.');
  }
}
function unique(seen: Set<unknown>, value: unknown, field: string, message: string) {
  if (seen.has(value)) invalid(field, message);
  seen.add(value);
}

/** Validates the create request before review; nothing here reads or contacts LinkedIn. */
export function assertLinkedInLeadForm(p: CompiledRequest): void {
  if (!formId(p.accountId)) invalid('account_id', 'Select one exact sponsored ad account.');
  if (
    Object.keys(p.headers).some(
      k => !['LinkedIn-Version', 'X-Restli-Protocol-Version', 'X-RestLi-Method'].includes(k),
    ) ||
    p.headers['X-Restli-Protocol-Version'] !== '2.0.0' ||
    !/^20\d{2}(?:0[1-9]|1[0-2])$/.test(p.headers['LinkedIn-Version'] ?? '')
  )
    invalid('headers', 'Use a monthly LinkedIn-Version and REST.li 2.0 without transport overrides.');
  const method = p.headers['X-RestLi-Method'];
  if (method !== undefined && method.toUpperCase() !== 'CREATE')
    invalid(
      'restli_method',
      'Lead form creation is a single CREATE; batch creation and partial updates are not qualified.',
    );
  if (Object.keys(p.query).length) invalid('query', 'Lead form creation takes no query parameters.');
  const body = p.body;
  if (!object(body)) invalid('', 'The request body must be a lead form object.');
  if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024)
    invalid('', 'Lead form requests are limited to 64 KiB for review.');
  only(body, ['owner', 'name', 'creationLocale', 'hiddenFields', 'content', 'state'], '');
  if (
    !object(body.owner) ||
    Object.keys(body.owner).join() !== 'sponsoredAccount' ||
    body.owner.sponsoredAccount !== accountUrn(p.accountId!)
  )
    invalid(
      'owner',
      'owner must be {sponsoredAccount} for the selected ad account; organization-owned forms are not qualified.',
    );
  if (!text(body.name)) invalid('name', 'name must be nonempty text without control characters.');
  if (body.state !== 'DRAFT')
    invalid(
      'state',
      'Send state DRAFT, as LinkedIn documents for creation; publishing happens when a reviewed ad uses the form.',
    );
  const loc = body.creationLocale;
  if (!object(loc)) invalid('creationLocale', 'creationLocale is required.');
  only(loc, ['country', 'language', 'variant'], 'creationLocale/');
  if (
    typeof loc.country !== 'string' ||
    !/^[A-Z]{2}$/.test(loc.country) ||
    typeof loc.language !== 'string' ||
    !/^[a-z]{2}$/.test(loc.language) ||
    (loc.variant !== undefined && (typeof loc.variant !== 'string' || !/^[A-Za-z0-9]{1,8}$/.test(loc.variant)))
  )
    invalid(
      'creationLocale',
      'creationLocale needs an uppercase ISO-3166 country, a lowercase ISO-639-1 language and an optional alphanumeric variant.',
    );
  const locale = loc.language + '_' + loc.country + (loc.variant ? '_' + loc.variant : '');
  const hidden = body.hiddenFields,
    hiddenNames = new Set<unknown>();
  if (!Array.isArray(hidden) || hidden.length > 20)
    invalid('hiddenFields', 'hiddenFields is required: an array of at most 20 fields (it may be empty).');
  hidden.forEach((h: unknown, i: number) => {
    if (!object(h)) invalid('hiddenFields/' + i, 'Each hidden field must be an object.');
    only(h, ['name', 'value'], 'hiddenFields/' + i + '/');
    if (!text(h.name) || !text(h.value)) invalid('hiddenFields/' + i, 'Hidden fields need a nonempty name and value.');
    unique(hiddenNames, h.name, 'hiddenFields/' + i + '/name', 'Hidden field names must be unique.');
  });
  const c = body.content;
  if (!object(c)) invalid('content', 'content is required.');
  only(c, ['headline', 'description', 'questions', 'legalInfo', 'postSubmissionInfo'], 'content/');
  localized(c.headline, 'content/headline', locale);
  if (c.description !== undefined) localized(c.description, 'content/description', locale);
  if (!Array.isArray(c.questions) || !c.questions.length)
    invalid('content/questions', 'At least one question is required.');
  const names = new Set<unknown>(),
    fields = new Set<unknown>(),
    questionLabels = new Set<unknown>(),
    optionLabels = new Set<unknown>();
  c.questions.forEach((q: unknown, i: number) => {
    const path = 'content/questions/' + i;
    if (!object(q)) invalid(path, 'Each question must be an object.');
    only(
      q,
      [
        'name',
        'question',
        'textPrompt',
        'predefinedField',
        'responseEditable',
        'responseRequired',
        'questionDetails',
        'label',
      ],
      path + '/',
    );
    if (!text(q.name)) invalid(path + '/name', 'Each question needs a nonempty name.');
    unique(names, q.name, path + '/name', 'Question names must be unique within the form.');
    localized(q.question, path + '/question', locale);
    if (q.textPrompt !== undefined) localized(q.textPrompt, path + '/textPrompt', locale);
    if (q.predefinedField !== undefined) {
      if (!predefined.includes(q.predefinedField))
        invalid(path + '/predefinedField', 'predefinedField must be one of ' + predefined.join(', ') + '.');
      unique(fields, q.predefinedField, path + '/predefinedField', 'Each predefined field may be requested once.');
    }
    for (const k of ['responseEditable', 'responseRequired'])
      if (q[k] !== undefined && typeof q[k] !== 'boolean') invalid(path + '/' + k, k + ' must be true or false.');
    if (q.label !== undefined) {
      if (!text(q.label)) invalid(path + '/label', 'Labels must be nonempty text.');
      unique(questionLabels, q.label, path + '/label', 'Question labels must be unique within the form.');
    }
    const d = q.questionDetails,
      kind = object(d) ? Object.keys(d) : [];
    if (kind.length !== 1 || !['textQuestionDetails', 'multipleChoiceQuestionDetails'].includes(kind[0]!))
      invalid(
        path + '/questionDetails',
        'questionDetails must be exactly one of textQuestionDetails and multipleChoiceQuestionDetails.',
      );
    const details = (d as JsonObject)[kind[0]!];
    if (!object(details)) invalid(path + '/questionDetails/' + kind[0], kind[0] + ' must be an object.');
    if (kind[0] === 'textQuestionDetails') {
      only(details, ['defaultResponse', 'maxResponseLength'], path + '/questionDetails/textQuestionDetails/');
      if (details.defaultResponse !== undefined && !text(details.defaultResponse))
        invalid(
          path + '/questionDetails/textQuestionDetails/defaultResponse',
          'defaultResponse must be nonempty text when set.',
        );
      if (
        details.maxResponseLength !== undefined &&
        (!Number.isSafeInteger(details.maxResponseLength) ||
          details.maxResponseLength < 1 ||
          details.maxResponseLength > 300)
      )
        invalid(
          path + '/questionDetails/textQuestionDetails/maxResponseLength',
          'maxResponseLength must be 1 to 300 characters.',
        );
    } else {
      const mc = path + '/questionDetails/multipleChoiceQuestionDetails';
      only(details, ['options', 'defaultSelectedOption'], mc + '/');
      if (!Array.isArray(details.options) || details.options.length < 2 || details.options.length > 15)
        invalid(mc + '/options', 'Multiple choice questions need 2 to 15 options.');
      const ids = new Set<unknown>();
      details.options.forEach((o: unknown, j: number) => {
        const op = mc + '/options/' + j;
        if (!object(o)) invalid(op, 'Each option must be an object.');
        only(o, ['id', 'text', 'label'], op + '/');
        if (!int(o.id)) invalid(op + '/id', 'Option ids are required integers.');
        unique(ids, o.id, op + '/id', 'Option ids must be unique within the question.');
        localized(o.text, op + '/text', locale);
        if (o.label !== undefined) {
          if (!text(o.label)) invalid(op + '/label', 'Labels must be nonempty text.');
          unique(optionLabels, o.label, op + '/label', 'Option labels must be unique within the form.');
        }
      });
      if (details.defaultSelectedOption !== undefined && !ids.has(details.defaultSelectedOption))
        invalid(mc + '/defaultSelectedOption', 'defaultSelectedOption must be one of the option ids.');
    }
  });
  const legal = c.legalInfo;
  if (!object(legal)) invalid('content/legalInfo', 'legalInfo is required.');
  only(legal, ['privacyPolicyUrl', 'legalDisclaimer', 'consents'], 'content/legalInfo/');
  if (legal.privacyPolicyUrl !== undefined && !webUrl(legal.privacyPolicyUrl))
    invalid(
      'content/legalInfo/privacyPolicyUrl',
      'privacyPolicyUrl must be an absolute http(s) URL without credentials.',
    );
  if (legal.legalDisclaimer !== undefined)
    localized(legal.legalDisclaimer, 'content/legalInfo/legalDisclaimer', locale, 2000);
  if (legal.consents !== undefined) {
    if (!Array.isArray(legal.consents)) invalid('content/legalInfo/consents', 'consents must be an array.');
    const ids = new Set<unknown>(),
      labels = new Set<unknown>();
    legal.consents.forEach((x: unknown, i: number) => {
      const cp = 'content/legalInfo/consents/' + i;
      if (!object(x)) invalid(cp, 'Each consent must be an object.');
      only(x, ['id', 'consent', 'checkRequired', 'label'], cp + '/');
      if (!int(x.id)) invalid(cp + '/id', 'Consent ids are required integers.');
      unique(ids, x.id, cp + '/id', 'Consent ids must be unique.');
      localized(x.consent, cp + '/consent', locale);
      if (typeof x.checkRequired !== 'boolean')
        invalid(cp + '/checkRequired', 'checkRequired is required and must be true or false.');
      if (x.label !== undefined) {
        if (!text(x.label)) invalid(cp + '/label', 'Labels must be nonempty text.');
        unique(labels, x.label, cp + '/label', 'Consent labels must be unique within the form.');
      }
    });
  }
  const post = c.postSubmissionInfo;
  if (post !== undefined) {
    if (!object(post)) invalid('content/postSubmissionInfo', 'postSubmissionInfo must be an object.');
    only(post, ['message', 'callToAction'], 'content/postSubmissionInfo/');
    localized(post.message, 'content/postSubmissionInfo/message', locale);
    const cta = post.callToAction;
    if (!object(cta))
      invalid('content/postSubmissionInfo/callToAction', 'callToAction is required with a post-submission message.');
    only(cta, ['callToActionLabel', 'callToActionTarget'], 'content/postSubmissionInfo/callToAction/');
    if (!ctaLabels.includes(cta.callToActionLabel))
      invalid(
        'content/postSubmissionInfo/callToAction/callToActionLabel',
        'callToActionLabel must be one of ' + ctaLabels.join(', ') + '.',
      );
    if (
      cta.callToActionTarget !== undefined &&
      (!object(cta.callToActionTarget) ||
        Object.keys(cta.callToActionTarget).join() !== 'landingPageUrl' ||
        !webUrl(cta.callToActionTarget.landingPageUrl))
    )
      invalid(
        'content/postSubmissionInfo/callToAction/callToActionTarget',
        'callToActionTarget must be {landingPageUrl} with an absolute http(s) URL.',
      );
  }
}

function assertScope(c: Connection, write: boolean) {
  if (!c.scopes.some(s => (write ? s === 'rw_ads' : ['r_ads', 'rw_ads', 'r_marketing_leadgen_automation'].includes(s))))
    throw new MirrorError(
      'INSUFFICIENT_SCOPE',
      write
        ? 'Creating LinkedIn lead forms requires rw_ads.'
        : 'Reading LinkedIn lead forms requires r_ads, rw_ads or r_marketing_leadgen_automation.',
      {},
      403,
    );
}
/** The owner finder's owner value as a record, whether sent as a REST.li string or as JSON. */
function finderOwner(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return parseLinkedInValue(value);
  } catch {
    return undefined;
  }
}
const finder = (p: CompiledRequest) => p.path === linkedinLeadFormsPath && p.query.q === 'owner';
/**
 * Lead form routes sit at the API root: the account is the form's owner, not a path segment. Only the create
 * request, the selected account's owner finder, owned single reads and server-built verification reads pass.
 */
export function authorizeLinkedInLeadForm(p: CompiledRequest, c: Connection, store: Store, selected: string): boolean {
  if (p.gateway !== 'linkedin_native_action') return false;
  if (linkedinLeadFormKind(p)) {
    assertLinkedInLeadForm(p);
    assertScope(c, true);
    return true;
  }
  if (
    p.method !== 'GET' ||
    !p.readOnly ||
    (p.body !== undefined && p.body !== null) ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://api.linkedin.com')
  )
    return false;
  const single = /^\/rest\/leadForms\/([1-9][0-9]{0,18})$/.exec(p.path)?.[1];
  if ((p as FormRead).linkedinLeadFormRead === true && p.action === marker) {
    if (!single || Object.keys(p.query).length || p.accountId !== selected) return false;
    assertScope(c, false);
    return true;
  }
  if (finder(p)) {
    const owner = finderOwner(p.query.owner);
    if (
      Object.keys(p.query).some(k => !['q', 'owner', 'count', 'start'].includes(k)) ||
      !object(owner) ||
      Object.keys(owner).join() !== 'sponsoredAccount' ||
      owner.sponsoredAccount !== accountUrn(selected)
    )
      return false;
    if (['count', 'start'].some(k => p.query[k] !== undefined && !/^\d{1,6}$/.test(String(p.query[k])))) return false;
    assertScope(c, false);
    return true;
  }
  if (single && !Object.keys(p.query).length && store.ownsResource(c, selected, 'leadForms/' + single)) {
    assertScope(c, false);
    return true;
  }
  return false;
}
const ownedBy = (f: unknown, selected: string) =>
  object(f) &&
  object(f.owner) &&
  Object.keys(f.owner).join() === 'sponsoredAccount' &&
  f.owner.sponsoredAccount === accountUrn(selected);
/** The selected account's owner finder is ownership evidence; an owned single read keeps it fresh. Nothing else is learned. */
export function observeLinkedInLeadForms(
  p: CompiledRequest,
  c: Connection,
  store: Store,
  selected: string,
  data: unknown,
): void {
  if (p.gateway !== 'linkedin_native_action' || !p.readOnly || p.method !== 'GET' || !object(data)) return;
  if (finder(p) && Array.isArray(data.elements)) {
    for (const f of data.elements) {
      const id = formId(object(f) ? f.id : undefined);
      if (id && ownedBy(f, selected)) store.rememberResource(c, selected, 'leadForms/' + id);
    }
    return;
  }
  const single = /^\/rest\/leadForms\/([1-9][0-9]{0,18})$/.exec(p.path)?.[1];
  if (single && (p as FormRead).linkedinLeadFormRead !== true && formId(data.id) === single && ownedBy(data, selected))
    store.rememberResource(c, selected, 'leadForms/' + single);
}

/** The created form's numeric ID from x-restli-id, sent as a bare ID or a leadGenForm URN. */
export function createdLinkedInLeadFormId(r: {headers?: Record<string, string>}): string | undefined {
  const raw = r.headers?.['x-restli-id'];
  return typeof raw === 'string' ? formId(/^(?:urn:li:leadGenForm:)?([1-9][0-9]{0,18})$/.exec(raw)?.[1]) : undefined;
}
/** LinkedIn documents 201 Created with the form ID in x-restli-id and no body. */
export function linkedinLeadFormOutcome(p: CompiledRequest, r: TransportResult): boolean {
  return (
    linkedinLeadFormKind(p) &&
    r.status === 201 &&
    !!createdLinkedInLeadFormId(r) &&
    (r.data === null || r.data === undefined || (object(r.data) && Object.keys(r.data).length === 0))
  );
}
export function rememberLinkedInLeadForm(store: Store, c: Connection, p: CompiledRequest, r: TransportResult) {
  const id = createdLinkedInLeadFormId(r);
  if (id && linkedinLeadFormOutcome(p, r)) store.rememberResource(c, p.accountId!, 'leadForms/' + id);
}

const loc = (v: unknown) => (object(v) && object(v.localized) ? {localized: v.localized} : v);
const list = (v: unknown): JsonObject[] => (Array.isArray(v) ? v.filter(object) : []);
/**
 * The configuration LinkedIn reads back for what was sent: server IDs (questionId, legalInfoId), review data,
 * versions and timestamps dropped; MultiLocaleStrings reduced to localized text; documented defaults
 * (responseEditable and responseRequired true, maxResponseLength 300, checkRequired false, no consents) applied.
 */
export function linkedinLeadFormProjection(form: unknown): JsonObject {
  if (!object(form)) return {};
  const c = object(form.content) ? form.content : {},
    legal = object(c.legalInfo) ? c.legalInfo : {},
    post = object(c.postSubmissionInfo) ? c.postSubmissionInfo : undefined;
  const question = (q: JsonObject) => {
    const d = object(q.questionDetails) ? q.questionDetails : {},
      textDetails = object(d.textQuestionDetails) ? d.textQuestionDetails : undefined,
      mc = object(d.multipleChoiceQuestionDetails) ? d.multipleChoiceQuestionDetails : undefined;
    const details = textDetails
      ? {
          textQuestionDetails: {
            maxResponseLength: textDetails.maxResponseLength ?? 300,
            ...(typeof textDetails.defaultResponse === 'string' && textDetails.defaultResponse !== ''
              ? {defaultResponse: textDetails.defaultResponse}
              : {}),
          },
        }
      : mc
        ? {
            multipleChoiceQuestionDetails: {
              options: list(mc.options).map(o => ({
                id: o.id,
                text: loc(o.text),
                ...(o.label !== undefined ? {label: o.label} : {}),
              })),
              ...(mc.defaultSelectedOption !== undefined ? {defaultSelectedOption: mc.defaultSelectedOption} : {}),
            },
          }
        : d;
    return {
      name: q.name,
      question: loc(q.question),
      ...(q.textPrompt !== undefined ? {textPrompt: loc(q.textPrompt)} : {}),
      ...(q.predefinedField !== undefined ? {predefinedField: q.predefinedField} : {}),
      responseEditable: q.responseEditable ?? true,
      responseRequired: q.responseRequired ?? true,
      questionDetails: details,
      ...(q.label !== undefined ? {label: q.label} : {}),
    };
  };
  return {
    owner: form.owner,
    name: form.name,
    state: form.state,
    creationLocale: form.creationLocale,
    hiddenFields: form.hiddenFields ?? [],
    content: {
      headline: loc(c.headline),
      ...(c.description !== undefined ? {description: loc(c.description)} : {}),
      questions: list(c.questions).map(question),
      legalInfo: {
        ...(legal.privacyPolicyUrl !== undefined ? {privacyPolicyUrl: legal.privacyPolicyUrl} : {}),
        ...(legal.legalDisclaimer !== undefined ? {legalDisclaimer: loc(legal.legalDisclaimer)} : {}),
        consents: list(legal.consents).map(x => ({
          id: x.id,
          consent: loc(x.consent),
          checkRequired: x.checkRequired ?? false,
          ...(x.label !== undefined ? {label: x.label} : {}),
        })),
      },
      ...(post ? {postSubmissionInfo: {message: loc(post.message), callToAction: post.callToAction}} : {}),
    },
  };
}

function read(p: CompiledRequest, id: string): FormRead {
  return {
    ...p,
    action: marker,
    method: 'GET',
    path: linkedinLeadFormsPath + '/' + id,
    query: {},
    body: undefined,
    headers: {'LinkedIn-Version': p.headers['LinkedIn-Version']!, 'X-Restli-Protocol-Version': '2.0.0'},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    linkedinLeadFormRead: true,
  };
}
export const isLinkedInLeadFormRead = (p: CompiledRequest): p is FormRead =>
  (p as FormRead).linkedinLeadFormRead === true;
/** A server-built form read is valid only for the exact ID it asked for, owned by the selected account. */
export function validateLinkedInLeadFormState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data,
    id = p.path.split('/').at(-1);
  if (
    r.status !== 200 ||
    !object(d) ||
    d.error !== undefined ||
    d.errors !== undefined ||
    d.serviceErrorCode !== undefined ||
    typeof d.status === 'number'
  )
    throw new MirrorError('STATE_READ_FAILED', 'The lead form read failed or returned an error envelope.');
  if (formId(d.id) !== id) throw new MirrorError('STATE_TARGET_MISMATCH', 'LinkedIn returned a different lead form.');
  if (!ownedBy(d, String(p.accountId)))
    throw new MirrorError('RESOURCE_SCOPE_REQUIRED', 'The lead form is not owned by the selected ad account.', {}, 403);
}
/** One server-built read of the created form, compared with what was sent after documented defaults. */
export function linkedinLeadFormVerification(p: CompiledRequest, result: JsonObject) {
  const id = createdLinkedInLeadFormId({headers: result.headers});
  if (!id) throw new MirrorError('VERIFICATION_UNSUPPORTED', 'The creation receipt has no lead form ID.');
  return [{read: read(p, id) as CompiledRequest, expected: linkedinLeadFormProjection(p.body), id}];
}

/** What the reviewer approves: a DRAFT form definition, its questions and the account it belongs to. */
export function linkedinLeadFormImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const b = p.body as JsonObject,
    c = b.content as JsonObject,
    questions = list(c.questions),
    account = object(state[0]) ? state[0] : {},
    legal = object(c.legalInfo) ? c.legalInfo : {};
  return {
    provider: 'linkedin',
    scope: 'lead_forms',
    may_affect_serving: false,
    effect:
      'Creates a DRAFT lead gen form owned by the selected ad account. Nothing serves and no campaign or creative changes; using the form in an ad, publishing, editing and archiving need their own reviews.',
    account: {
      id: p.accountId,
      ...(account.status !== undefined ? {status: account.status} : {}),
      ...(account.name !== undefined ? {name: account.name} : {}),
    },
    form: {
      name: b.name,
      creation_locale: (b.creationLocale as JsonObject).language + '_' + (b.creationLocale as JsonObject).country,
      questions: questions.length,
      predefined_fields: questions.map(q => q.predefinedField).filter(Boolean),
      custom_questions: questions.filter(q => q.predefinedField === undefined).map(q => q.name),
      required_consents: list(legal.consents).filter(x => x.checkRequired === true).length,
      privacy_policy_url: legal.privacyPolicyUrl ?? null,
      hidden_fields: list(b.hiddenFields).map(h => h.name),
    },
    data_collection:
      'When a live ad uses this form, LinkedIn asks members for the listed fields. Lead responses are only available through the separate Lead Sync API, which AMCP does not qualify.',
    verification:
      'Reads the created form by the x-restli-id receipt and compares owner, name, DRAFT state, locale, hidden fields and content after documented defaults. LinkedIn content review status is reported by LinkedIn, not compared.',
    recovery:
      "A lost or ambiguous receipt keeps the original claim. List the account's forms (q=owner) to find the form; never resubmit an uncertain create.",
    source: linkedinLeadFormSource,
  };
}
