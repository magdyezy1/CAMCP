import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {compileMicrosoft, microsoftActions, microsoftContracts} from '../dist/src/microsoft-native.js';
import {microsoftEvidence} from '../dist/src/microsoft-evidence.js';

/**
 * F-50: AMCP sends Microsoft Advertising v13 REST requests, and Microsoft retires v13's SOAP endpoints on 2027-01-31.
 * Each operation's REST method, URL and JSON templates are pinned from Microsoft Learn; every request is held to them.
 */
const envelope = JSON.parse(fs.readFileSync('.mirror/VENDOR/microsoft-rest-v13.json', 'utf8')),
  operations = envelope.document.operations,
  fields = template => Object.keys(JSON.parse(template.replace(/:\s*[A-Za-z]+ValueHere\b/g, ': null')));

test('the REST evidence is sealed, from Microsoft Learn, and covers exactly the operations AMCP sends', () => {
  assert.equal(envelope.source, 'https://learn.microsoft.com/en-us/advertising/');
  assert.equal(envelope.evidence, 'VENDOR_DOCUMENTED_NOT_AMCP_OBSERVED');
  assert.equal(envelope.document_sha256, createHash('sha256').update(JSON.stringify(envelope.document)).digest('hex'));
  assert.deepEqual(Object.keys(operations).sort(), microsoftActions.map(a => a.name).sort());
  execFileSync(process.execPath, ['tools/microsoft-rest.mjs', '--check'], {stdio: 'pipe'});
});

test('every operation is sent with the documented REST method and URL, and only documented fields', () => {
  for (const a of microsoftActions) {
    const op = operations[a.name],
      c = microsoftContracts.get(a.name);
    assert.equal(a.method, op.method, a.name);
    assert.equal(a.path, op.url, a.name);
    assert.equal(op.page, a.raw.source, a.name);
    for (const f of a.raw.payload_fields) assert.ok(fields(op.request_json).includes(f), a.name + ' ' + f);
    assert.ok(fields(op.response_json).includes(c.result), a.name + ' returns ' + c.result);
    const e = microsoftEvidence(a.name, a.raw.payload_fields, {method: a.method, url: a.path});
    assert.deepEqual(e.rest, {method: op.method, url: op.url, page: op.page, source_sha256: envelope.document_sha256});
  }
});

test('a request that differs from the REST documentation is refused before it is sent', () => {
  const route = {method: 'POST', url: 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns'};
  assert.equal(microsoftEvidence('AddCampaigns', ['AccountId', 'Campaigns'], route).rest.method, 'POST');
  for (const [name, fieldsSent, r] of [
    ['AddCampaigns', ['AccountId', 'Campaigns'], {...route, method: 'PUT'}],
    ['AddCampaigns', ['AccountId', 'Campaigns'], {...route, url: route.url + '/Add'}],
    ['AddCampaigns', ['AccountId', 'Campaigns'], {...route, url: route.url.replace('campaign.api', 'soap.api')}],
    ['AddCampaigns', ['AccountId', 'Campaigns', 'Undocumented'], route],
  ])
    assert.throws(
      () => microsoftEvidence(name, fieldsSent, r),
      e => e.code === 'VENDOR_SCHEMA_UNAVAILABLE',
    );
});

test('compiled requests carry the REST evidence of their operation', () => {
  const p = compileMicrosoft({action: 'GetCampaignsByAccountId', account_id: '123'}),
    op = operations.GetCampaignsByAccountId;
  assert.equal(p.origin + p.path, op.url);
  assert.equal(p.contractEvidence.rest.method, 'POST');
  assert.equal(p.contractEvidence.rest.url, op.url);
  assert.match(p.contractEvidence.validation, /REST/);
});
