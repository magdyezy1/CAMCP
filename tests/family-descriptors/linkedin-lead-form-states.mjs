// linkedin_lead_form_states: POST /rest/leadForms/{id} PARTIAL_UPDATE {patch: {$set: {state}}} (LinkedIn Lead Syncing,
// li-lms-2026-09). The decisive field is the form's current `state`: the documented transitions are DRAFT to PUBLISHED
// and PUBLISHED to ARCHIVED, and archiving stops the creatives that use the form; a form archived or reset in LinkedIn
// after the review must stop the reviewed change.
import {account, empty, restliError} from './_linkedin.mjs';

export default {
  family: 'linkedin_lead_form_states',
  risk: 'activation',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_lead_forms_lead_form_id_post',
    restli_method: 'PARTIAL_UPDATE',
    path_params: {lead_form_id: '702'},
    payload: {patch: {$set: {state: 'ARCHIVED'}}},
  },
  seed: () => ({form: {id: 702, owner: {sponsoredAccount: account}, name: 'Webinar', state: 'PUBLISHED'}}),
  unpaginated: 'GET /rest/leadForms/{id} returns one form entity; LinkedIn pages only finder collections',
  // LinkedIn refuses a status change with an HTTP error, which AMCP reports as the provider's own refusal; the review
  // is then spent, and executing it again is refused as already submitted.
  partialCodes: ['UPSTREAM_ERROR', 'WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN'],
  // A 5xx is reported as the provider error (never safe to retry); its replay is WRITE_OUTCOME_UNCERTAIN.
  uncertainCodes: ['UPSTREAM_ERROR', 'WRITE_OUTCOME_UNCERTAIN'],
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    if (path !== '/rest/leadForms/702') return method === 'GET' ? restliError(404, 'Not found') : undefined;
    if (method === 'GET') return {json: {...state.form, creationLocale: {country: 'US', language: 'en'}}};
    // A failed answer: LinkedIn refuses the status change.
    // An uncertain answer: LinkedIn fails with a 5xx, and the change may or may not have applied.
    if (mode.uncertain) return restliError(503, 'Service unavailable');
    if (mode.partial) return restliError(400, 'Form is not in an editable state');
    Object.assign(state.form, body.patch.$set);
    return empty();
  },
  // Every other state breaks the only documented transition to ARCHIVED, so the family's own prerequisite refuses it
  // as the form is read again at execute.
  decisive: {
    change: state => (state.form.state = 'DRAFT'),
    field: /state/,
    refusal: {code: 'INVALID_LINKEDIN_LEAD_FORM_STATE', message: /is DRAFT; only a PUBLISHED form/},
  },
};
