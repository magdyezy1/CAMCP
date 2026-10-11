// linkedin_lead_forms: POST /rest/leadForms (LinkedIn Lead Syncing, li-lms-2026-09) creating a DRAFT lead gen form owned
// by the ad account. The form belongs to the account it names, so the decisive field is the account's `status`: an
// account whose status changed in Campaign Manager after the review is no longer the account the owner chose to own the
// form.
import {account, restliError} from './_linkedin.mjs';

const t = s => ({localized: {en_US: s}});
const form = {
  owner: {sponsoredAccount: account},
  name: 'Synthetic demo form',
  state: 'DRAFT',
  creationLocale: {country: 'US', language: 'en'},
  hiddenFields: [{name: 'source', value: 'amcp'}],
  content: {
    headline: t('Book a demo'),
    description: t('Tell us how to reach you.'),
    questions: [
      {
        name: 'firstName',
        question: t('First name'),
        predefinedField: 'FIRST_NAME',
        questionDetails: {textQuestionDetails: {}},
      },
    ],
    legalInfo: {
      privacyPolicyUrl: 'https://example.com/privacy',
      legalDisclaimer: t('We contact you only about this request.'),
      consents: [{id: 1, consent: t('Contact me by email'), checkRequired: true}],
    },
  },
};

export default {
  family: 'linkedin_lead_forms',
  risk: 'settings',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {action: 'linkedin_rest_lead_forms_post', payload: form},
  seed: () => ({
    account: {id: 507, name: 'Brand KSA', currency: 'SAR', status: 'ACTIVE', type: 'BUSINESS'},
    forms: {},
  }),
  unpaginated: 'GET /rest/adAccounts/{id} and GET /rest/leadForms/{id} return one entity each',
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: structuredClone(state.account)};
      const f = state.forms[path.slice('/rest/leadForms/'.length)];
      return f ? {json: structuredClone(f)} : restliError(404, 'Not found');
    }
    if (method === 'POST' && path === '/rest/leadForms') {
      // What LinkedIn stores: server IDs and the documented defaults added.
      const c = structuredClone(body.content);
      c.questions = c.questions.map((q, i) => ({
        questionId: 10540 + i,
        responseEditable: true,
        responseRequired: true,
        ...q,
        questionDetails: {textQuestionDetails: {maxResponseLength: 300, ...q.questionDetails.textQuestionDetails}},
      }));
      state.forms['5101'] = {...structuredClone(body), id: 5101, content: c, versionId: 1};
      // A partial answer: LinkedIn answers 201 with a body, which the documented contract does not have.
      if (mode.partial) return {json: {id: 5101, status: 'PENDING'}, status: 201};
      return new Response(null, {status: 201, headers: {'x-restli-id': 'urn:li:leadGenForm:5101'}});
    }
  },
  decisive: {change: state => (state.account.status = 'CANCELED'), field: /status/},
};
