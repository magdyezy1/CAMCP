// linkedin_lift_tests: POST /rest/adLiftTests/{id} PARTIAL_UPDATE setting userState READY (LinkedIn Lift Test
// Management API, li-lms-2026-09): READY "sends Lift Test for review and activates it on schedule.start date", so the
// decisive field is the test's `schedule`, the window in which the audience is split; a schedule moved in LinkedIn
// after the review would activate a window the owner never saw.
import {account, elements, empty, restliError} from './_linkedin.mjs';

const day = 86400000,
  start = Math.floor(Date.now() / day) * day + 3 * day;

export default {
  family: 'linkedin_lift_tests',
  risk: 'activation',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_ad_lift_tests_lift_test_id_post',
    restli_method: 'PARTIAL_UPDATE',
    path_params: {lift_test_id: '801'},
    payload: {patch: {$set: {userState: 'READY'}}},
  },
  seed: () => ({
    test: {
      id: 801,
      account,
      name: 'Brand lift',
      brandName: 'Brand',
      brandNameLocale: {language: 'en', country: 'US'},
      schedule: {start, end: start + 14 * day - 15 * 60000},
      userState: 'DRAFT',
      executionState: 'CREATED',
      liftEntity: {account},
    },
    surveys: [{id: 'AWARENESS'}],
    resumable: [],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, status: 'ACTIVE'}};
      if (path === '/rest/adLiftTests/801') return {json: state.test};
      if (path === '/rest/adLiftTests/801/adLiftTestSurveys') return elements(state.surveys);
      // The account's ENDED_RESUMABLE tests, which READY ends; another page leaves some unread.
      if (path === '/rest/adLiftTests' && url.searchParams.get('q') === 'criteria')
        return elements(state.resumable, mode.paginate);
      return restliError(404, 'Not found');
    }
    if (method === 'POST' && path === '/rest/adLiftTests/801') {
      if (mode.partial) return restliError(422, 'Lift test cannot be activated');
      Object.assign(state.test, body.patch.$set);
      return empty();
    }
  },
  partialCodes: ['UPSTREAM_ERROR', 'WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN'],
  decisive: {change: state => (state.test.schedule.end += 7 * day), field: /schedule/},
};
