import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * LinkedIn sponsored lead gen forms (Lead Syncing and Lead Syncing Schema, li-lms-2026-09, checked 2026-09-26):
 * created in DRAFT for the selected ad account, answered with 201 and the form ID in x-restli-id, and read back
 * with server IDs and documented defaults added. Form IDs are 64-bit longs, beyond JavaScript's safe integers.
 */
const LI = '21212121-2121-4121-8121-212121212121',
  gateway = 'linkedin_native_action',
  account = '123',
  urn = 'urn:li:sponsoredAccount:123';
const actor = {tenantId: 'linkedin-lead-forms', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 70).toString('base64');
const big = '6851219773716516865';
const t = s => ({localized: {en_US: s}});
const form = () => ({
  owner: {sponsoredAccount: urn},
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
      {
        name: 'budget',
        question: t('What is your budget?'),
        responseRequired: false,
        questionDetails: {textQuestionDetails: {maxResponseLength: 120}},
      },
      {
        name: 'teamSize',
        question: t('Team size'),
        questionDetails: {
          multipleChoiceQuestionDetails: {
            options: [
              {id: 1, text: t('1-10')},
              {id: 2, text: t('11 or more'), label: 'large'},
            ],
            defaultSelectedOption: 1,
          },
        },
      },
    ],
    legalInfo: {
      privacyPolicyUrl: 'https://example.com/privacy',
      legalDisclaimer: t('We contact you only about this request.'),
      consents: [{id: 1, consent: t('Contact me by email'), checkRequired: true}],
    },
    postSubmissionInfo: {
      message: t('Thanks, we will be in touch.'),
      callToAction: {
        callToActionLabel: 'VISIT_COMPANY_WEBSITE',
        callToActionTarget: {landingPageUrl: 'https://example.com'},
      },
    },
  },
});
/** What LinkedIn stores and reads back: server IDs, versions, review data and documented defaults added. */
function served(f) {
  const c = structuredClone(f.content);
  c.questions = c.questions.map((q, i) => ({
    questionId: 10540 + i,
    responseEditable: true,
    responseRequired: true,
    ...q,
    questionDetails: q.questionDetails.textQuestionDetails
      ? {textQuestionDetails: {maxResponseLength: 300, ...q.questionDetails.textQuestionDetails}}
      : q.questionDetails,
  }));
  c.legalInfo = {legalInfoId: 5604, consents: [], ...c.legalInfo};
  return {
    ...structuredClone(f),
    content: c,
    versionId: 1,
    created: 1790000000000,
    lastModified: 1790000000000,
    reviewInfo: {reviewStatus: 'PENDING', lastUpdated: 1790000000000},
  };
}
// LinkedIn writes form IDs as bare JSON numbers; a 64-bit ID is only exact in the raw text.
const raw = (f, id) => JSON.stringify({...f, id: '@ID@'}).replace('"@ID@"', id);
function fixture({scopes = ['rw_ads'], drift} = {}) {
  const store = new Store(':memory:', key),
    connection = {
      id: LI,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic LinkedIn',
      scopes,
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const forms = new Map([
    ['5001', served({...form(), name: 'Existing form'})],
    ['5002', {...served(form()), owner: {sponsoredAccount: 'urn:li:sponsoredAccount:999'}}],
  ]);
  const accountRow = {
    id: 123,
    name: 'Synthetic account',
    currency: 'USD',
    status: 'ACTIVE',
    type: 'BUSINESS',
    reference: 'urn:li:organization:1',
  };
  const requests = [],
    writes = [];
  let mode = '',
    receiptId = big;
  const transport = new NativeTransport(async (url, init = {}) => {
    const u = new URL(String(url)),
      method = init.method ?? 'GET',
      path = u.pathname;
    requests.push({method, path, search: u.search, headers: init.headers});
    if (method === 'GET' && path === '/rest/adAccounts/123') return Response.json(accountRow);
    if (method === 'GET' && path === '/rest/leadForms')
      return new Response(
        '{"elements":[' +
          [...forms].map(([id, f]) => raw(f, id)).join(',') +
          '],"paging":{"start":0,"count":10,"links":[]}}',
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    if (method === 'GET' && path.startsWith('/rest/leadForms/')) {
      const id = path.split('/').at(-1),
        f = forms.get(id);
      if (!f) return Response.json({status: 404, serviceErrorCode: 100, message: 'Not found'}, {status: 404});
      return new Response(raw(drift ? drift(structuredClone(f)) : f, id), {
        status: 200,
        headers: {'content-type': 'application/json'},
      });
    }
    if (method === 'POST' && path === '/rest/leadForms') {
      const body = JSON.parse(init.body);
      writes.push({body, headers: init.headers});
      forms.set(big, served(body));
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      if (mode === 'error')
        return Response.json({status: 400, serviceErrorCode: 100, message: 'Synthetic invalid form'}, {status: 400});
      if (mode === 'noid') return new Response(null, {status: 201});
      return new Response(null, {status: 201, headers: {'x-restli-id': receiptId}});
    }
    throw new Error('Unexpected LinkedIn request ' + method + ' ' + path);
  });
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input) => service.call(tool, input, actor);
  const args = payload => ({action: 'linkedin_rest_lead_forms_post', account_id: account, payload});
  const prepare = (payload = form(), extra = {}) =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: LI, arguments: {...args(payload), ...extra}});
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  const get = id =>
    call(gateway, {
      action: 'linkedin_rest_lead_forms_lead_form_id_get',
      account_id: account,
      connection_id: LI,
      path_params: {lead_form_id: id},
    });
  const list = query =>
    call(gateway, {action: 'linkedin_rest_lead_forms_get', account_id: account, connection_id: LI, query});
  return {
    store,
    forms,
    accountRow,
    requests,
    writes,
    call,
    args,
    prepare,
    execute,
    verify,
    get,
    list,
    mode: v => {
      mode = v;
    },
    receipt: v => {
      receiptId = v;
    },
    restart: () => {
      service = start();
    },
  };
}

test('lead form creation is a reviewed LinkedIn family; status changes are reviewed by their own family and content edits stay blocked', async () => {
  const f = fixture();
  try {
    const inspected = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: LI,
      arguments: f.args(form()),
    });
    assert.equal(inspected.data.review_contract_supported, true, JSON.stringify(inspected));
    const edit = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: LI,
      arguments: {
        action: 'linkedin_rest_lead_forms_lead_form_id_post',
        account_id: account,
        path_params: {lead_form_id: '5001'},
        restli_method: 'PARTIAL_UPDATE',
        payload: {patch: {$set: {state: 'ARCHIVED'}}},
      },
    });
    assert.equal(edit.data?.review_contract_supported, true, JSON.stringify(edit));
    const content = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: LI,
      arguments: {
        action: 'linkedin_rest_lead_forms_lead_form_id_post',
        account_id: account,
        path_params: {lead_form_id: '5001'},
        restli_method: 'PARTIAL_UPDATE',
        payload: {patch: {$set: {name: 'Renamed'}}},
      },
    });
    assert.notEqual(content.data?.review_contract_supported, true, JSON.stringify(content));
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only documented DRAFT forms owned by the selected account are accepted, before any request', async () => {
  const f = fixture();
  try {
    const change = fn => {
        const v = form();
        fn(v);
        return v;
      },
      q = i => v => v.content.questions[i];
    const cases = {
      'foreign owner': change(v => {
        v.owner.sponsoredAccount = 'urn:li:sponsoredAccount:999';
      }),
      'organization owner': change(v => {
        v.owner = {organization: 'urn:li:organization:1'};
      }),
      'no state': change(v => {
        delete v.state;
      }),
      'published': change(v => {
        v.state = 'PUBLISHED';
      }),
      'read-only id': change(v => {
        v.id = 1;
      }),
      'version': change(v => {
        v.versionId = 1;
      }),
      'no locale': change(v => {
        delete v.creationLocale;
      }),
      'lowercase country': change(v => {
        v.creationLocale.country = 'us';
      }),
      'name control character': change(v => {
        v.name = 'Demo\u0001';
      }),
      'locale text missing': change(v => {
        v.content.headline = {localized: {fr_FR: 'Réserver'}};
      }),
      'preferredLocale': change(v => {
        v.content.headline.preferredLocale = {country: 'US', language: 'en'};
      }),
      'no hidden fields': change(v => {
        delete v.hiddenFields;
      }),
      '21 hidden fields': change(v => {
        v.hiddenFields = Array.from({length: 21}, (_, i) => ({name: 'h' + i, value: 'v'}));
      }),
      'duplicate hidden names': change(v => {
        v.hiddenFields.push({name: 'source', value: 'other'});
      }),
      'no questions': change(v => {
        v.content.questions = [];
      }),
      'duplicate question names': change(v => {
        v.content.questions[1].name = 'firstName';
      }),
      'unknown predefined field': change(v => {
        q(0)(v).predefinedField = 'SALARY';
      }),
      'repeated predefined field': change(v => {
        q(1)(v).predefinedField = 'FIRST_NAME';
      }),
      'two detail kinds': change(v => {
        q(0)(v).questionDetails.multipleChoiceQuestionDetails = {options: []};
      }),
      'long responses': change(v => {
        q(1)(v).questionDetails.textQuestionDetails.maxResponseLength = 301;
      }),
      'one option': change(v => {
        q(2)(v).questionDetails.multipleChoiceQuestionDetails.options.pop();
      }),
      'sixteen options': change(v => {
        q(2)(v).questionDetails.multipleChoiceQuestionDetails.options = Array.from({length: 16}, (_, i) => ({
          id: i,
          text: t('o' + i),
        }));
      }),
      'option without id': change(v => {
        delete q(2)(v).questionDetails.multipleChoiceQuestionDetails.options[1].id;
      }),
      'duplicate option ids': change(v => {
        q(2)(v).questionDetails.multipleChoiceQuestionDetails.options[1].id = 1;
      }),
      'unknown default option': change(v => {
        q(2)(v).questionDetails.multipleChoiceQuestionDetails.defaultSelectedOption = 9;
      }),
      'duplicate question labels': change(v => {
        q(0)(v).label = 'x';
        q(1)(v).label = 'x';
      }),
      'work email criteria': change(v => {
        q(0)(v).predefinedField = 'WORK_EMAIL';
        q(0)(v).questionSubmissionCriteria = {workEmailSubmissionCriteria: {freemiumEmailAllowed: false}};
      }),
      'no legal info': change(v => {
        delete v.content.legalInfo;
      }),
      'long disclaimer': change(v => {
        v.content.legalInfo.legalDisclaimer = t('x'.repeat(2001));
      }),
      'consent without checkRequired': change(v => {
        delete v.content.legalInfo.consents[0].checkRequired;
      }),
      'duplicate consent ids': change(v => {
        v.content.legalInfo.consents.push({id: 1, consent: t('Again'), checkRequired: false});
      }),
      'script privacy URL': change(v => {
        v.content.legalInfo.privacyPolicyUrl = 'javascript:alert(1)';
      }),
      'download CTA': change(v => {
        v.content.postSubmissionInfo.callToAction.callToActionLabel = 'DOWNLOAD_NoW';
      }),
      'CTA target shape': change(v => {
        v.content.postSubmissionInfo.callToAction.callToActionTarget = {url: 'https://example.com'};
      }),
    };
    for (const [name, payload] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_LINKEDIN_LEAD_FORM',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
    }
    for (const extra of [{restli_method: 'BATCH_CREATE'}, {restli_method: 'PARTIAL_UPDATE'}, {query: {account: urn}}]) {
      const r = await f.prepare(form(), extra);
      assert.equal(r.error?.code, 'INVALID_LINKEDIN_LEAD_FORM', JSON.stringify(extra));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a DRAFT form is created once, verifies by its exact 64-bit ID and becomes readable', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {scope: 'workspace', confirmed: true, policy: {allow_activation: false}});
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/rest/adAccounts/123'],
    );
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'lead_forms');
    assert.equal(impact.may_affect_serving, false);
    assert.deepEqual(impact.form.predefined_fields, ['FIRST_NAME']);
    assert.deepEqual(impact.form.custom_questions, ['budget', 'teamSize']);
    assert.equal(impact.form.required_consents, 1);
    assert.equal(impact.account.status, 'ACTIVE');
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, 'a question about budgets is not a spending change: ' + JSON.stringify(done));
    assert.equal(done.data.created_id, big);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].body, form());
    assert.equal(f.writes[0].headers['LinkedIn-Version'], '202609');
    assert.equal(f.writes[0].headers['X-Restli-Protocol-Version'], '2.0.0');
    assert.equal(f.writes[0].headers['X-RestLi-Method'], undefined);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.equal(verified.data.checks[0].resource_id, big);
    assert.ok(f.requests.some(r => r.method === 'GET' && r.path === '/rest/leadForms/' + big));
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
    const read = await f.get(big);
    assert.equal(read.success, true, JSON.stringify(read));
    assert.equal(read.data.data.id, big, 'the 64-bit ID is exact');
  } finally {
    f.store.close();
  }
});

test("the selected account's owner finder establishes ownership of its own forms only", async () => {
  const f = fixture();
  try {
    const before = f.requests.length;
    assert.equal((await f.get('5001')).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(f.requests.length, before);
    const listed = await f.list({
      q: 'owner',
      owner: '(sponsoredAccount:urn%3Ali%3AsponsoredAccount%3A123)',
      count: 10,
      start: 0,
    });
    assert.equal(listed.success, true, JSON.stringify(listed));
    assert.match(f.requests.at(-1).search, /owner=\(sponsoredAccount:urn%3Ali%3AsponsoredAccount%3A123\)/);
    assert.equal((await f.get('5001')).success, true);
    assert.equal(
      (await f.get('5002')).error?.code,
      'RESOURCE_SCOPE_REQUIRED',
      'a form owned elsewhere is never learned',
    );
    assert.equal((await f.list({q: 'owner', owner: {sponsoredAccount: urn}})).success, true);
    const count = f.requests.length;
    for (const query of [
      {q: 'owner', owner: '(sponsoredAccount:urn%3Ali%3AsponsoredAccount%3A999)'},
      {q: 'owner', owner: {organization: 'urn:li:organization:1'}},
      {q: 'owner', owner: {sponsoredAccount: urn}, fields: 'id'},
      {ids: ['5001']},
    ]) {
      const r = await f.list(query);
      assert.ok(
        ['RESOURCE_SCOPE_REQUIRED', 'ACCOUNT_SCOPE_MISMATCH'].includes(r.error?.code),
        JSON.stringify(query) + ' ' + JSON.stringify(r).slice(0, 300),
      );
    }
    assert.equal(f.requests.length, count);
  } finally {
    f.store.close();
  }
});

test('creation needs rw_ads; reading forms accepts r_ads', async () => {
  const f = fixture({scopes: ['r_ads']});
  try {
    const r = await f.prepare();
    assert.equal(r.error?.code, 'INSUFFICIENT_SCOPE', JSON.stringify(r));
    assert.equal(f.requests.length, 0);
    assert.equal((await f.list({q: 'owner', owner: {sponsoredAccount: urn}})).success, true);
  } finally {
    f.store.close();
  }
  const g = fixture({scopes: ['r_basicprofile']});
  try {
    assert.equal((await g.list({q: 'owner', owner: {sponsoredAccount: urn}})).error?.code, 'INSUFFICIENT_SCOPE');
    assert.equal(g.requests.length, 0);
  } finally {
    g.store.close();
  }
});

test('a form that reads back differently, or under another owner, is not verified', async () => {
  for (const [name, drift, field] of [
    [
      'renamed',
      v => {
        v.name = 'Other';
        return v;
      },
      '/name',
    ],
    [
      'published',
      v => {
        v.state = 'PUBLISHED';
        return v;
      },
      '/state',
    ],
    [
      'reordered',
      v => {
        v.content.questions.reverse();
        return v;
      },
      '/content',
    ],
    [
      'default changed',
      v => {
        v.content.questions[0].responseEditable = false;
        return v;
      },
      '/content',
    ],
  ]) {
    const f = fixture({drift});
    try {
      const p = await f.prepare();
      await f.execute(p.data.review_id);
      const verified = await f.verify(p.data.review_id);
      assert.equal(verified.data.status, 'inconclusive', name + ' ' + JSON.stringify(verified));
      assert.ok(
        verified.data.checks[0].changed_fields.some(c => c.startsWith(field)),
        name + ' ' + JSON.stringify(verified.data.checks[0].changed_fields),
      );
    } finally {
      f.store.close();
    }
  }
  const f = fixture({drift: v => ({...v, owner: {sponsoredAccount: 'urn:li:sponsoredAccount:999'}})});
  try {
    const p = await f.prepare();
    await f.execute(p.data.review_id);
    const verified = await f.verify(p.data.review_id);
    assert.notEqual(verified.data.status, 'verified', JSON.stringify(verified));
    assert.equal(verified.data.checks[0].code, 'RESOURCE_SCOPE_REQUIRED', JSON.stringify(verified));
  } finally {
    f.store.close();
  }
});

test('the account is read again before execution, and a changed account stops the write', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    f.accountRow.status = 'CANCELED';
    const r = await f.execute(p.data.review_id);
    assert.equal(r.error?.code, 'STATE_CHANGED', JSON.stringify(r));
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('rejected, empty or lost receipts never submit a second form, across restart and concurrency', async () => {
  for (const mode of ['error', 'lost', 'noid']) {
    const f = fixture();
    try {
      const p = await f.prepare();
      f.mode(mode);
      const first = await f.execute(p.data.review_id);
      assert.equal(first.success, false, mode + ' ' + JSON.stringify(first));
      f.mode('');
      f.restart();
      assert.equal((await f.execute(p.data.review_id)).error?.code, 'WRITE_OUTCOME_UNCERTAIN', mode);
      assert.equal(f.writes.length, 1, mode);
    } finally {
      f.store.close();
    }
  }
  const bad = fixture();
  try {
    bad.receipt('urn:li:unknown:42');
    const p = await bad.prepare();
    const r = await bad.execute(p.data.review_id);
    assert.notEqual(r.data?.success, true, JSON.stringify(r));
    assert.equal(
      (await bad.get(big)).error?.code,
      'RESOURCE_SCOPE_REQUIRED',
      'an unrecognized receipt grants no ownership',
    );
    assert.equal(bad.writes.length, 1);
  } finally {
    bad.store.close();
  }
  const g = fixture();
  try {
    const p = await g.prepare();
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});
