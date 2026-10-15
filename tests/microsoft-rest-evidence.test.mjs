import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('CMP-03: the location-criterion operations and the data-object pages and guides their rules rest on are pinned', () => {
  // Before CMP-03 none of these was pinned, so AMCP could neither add nor read a campaign location criterion.
  assert.equal(operations.AddCampaignCriterions.method, 'POST');
  assert.equal(operations.DeleteCampaignCriterions.method, 'DELETE');
  assert.match(operations.GetCampaignCriterionsByIds.url, /\/CampaignCriterions\/QueryByIds$/);
  assert.ok(fields(operations.AddCampaignCriterions.response_json).includes('NestedPartialErrors'));
  const references = envelope.document.references;
  assert.deepEqual(Object.keys(references).sort(), [
    'BidMultiplier',
    'BiddableCampaignCriterion',
    'CampaignCriterionType',
    'GeographicalLocationCodes',
    'LocationCriterion',
    'LocationIntentCriterion',
    'NegativeCampaignCriterion',
    'ShowAdsToYourTargetAudience',
  ]);
  // The two guides: the targeting guide states the premise of owner decision P7, the location codes guide where
  // location IDs come from. The tool is not imported here: run without --check, it reads Microsoft Learn.
  const guides = {
    ShowAdsToYourTargetAudience: ['show-ads-target-audience', 'Show Ads to Your Target Audience'],
    GeographicalLocationCodes: ['geographical-location-codes', 'Geographical Location Codes'],
  };
  for (const [name, ref] of Object.entries(references)) {
    const [guide, title] = guides[name] ?? [];
    assert.equal(
      ref.page,
      'https://learn.microsoft.com/en-us/advertising/' +
        (guide ? 'guides/' + guide : 'campaign-management-service/' + name.toLowerCase()) +
        '?view=bingads-13',
    );
    assert.match(ref.content_sha256, /^[0-9a-f]{64}$/);
    assert.ok(guide ? ref.title === title : ref.title.startsWith(name + ' '), ref.title);
  }
  // Provenance: every page says when it was read, and each page the location rules come from says which rules
  // (tools/microsoft-rest.mjs --check also holds them equal to the tool's reliesOn list).
  const pinned = {...operations, ...references};
  for (const [name, entry] of Object.entries(pinned))
    assert.ok(!Number.isNaN(Date.parse(entry.read_at)) && entry.read_at.endsWith('Z'), name + ' read_at');
  const ruled = Object.keys(pinned)
    .filter(name => pinned[name].relies_on)
    .sort();
  assert.deepEqual(ruled, [
    'AddCampaignCriterions',
    'BidMultiplier',
    'BiddableCampaignCriterion',
    'CampaignCriterionType',
    'DeleteCampaignCriterions',
    'GeographicalLocationCodes',
    'GetCampaignCriterionsByIds',
    'LocationCriterion',
    'LocationIntentCriterion',
    'NegativeCampaignCriterion',
    'ShowAdsToYourTargetAudience',
  ]);
  for (const name of ruled) {
    assert.ok(pinned[name].relies_on.length && pinned[name].relies_on.every(r => typeof r === 'string' && r), name);
    // A page is read again when its rules change, so its rules were read no earlier than the criterion family.
    assert.ok(pinned[name].read_at >= '2026-10-11', name + ' ' + pinned[name].read_at);
  }
  assert.match(operations.GetCampaignCriterionsByIds.relies_on.join(' '), /CriterionType Location/);
  assert.match(references.LocationIntentCriterion.relies_on.join(' '), /PeopleInOrSearchingForOrViewingPages/);
  // P7's premise, read from Microsoft's own guide (the review had it only from a search result): a campaign created
  // through the API has no criteria and targets every location until a location criterion is added.
  assert.match(
    references.ShowAdsToYourTargetAudience.relies_on[0],
    /no criteria, and effectively targets all locations/,
  );
  // Microsoft's two pages disagree on when a deprecating location stops targeting; the pin records both.
  assert.match(references.GeographicalLocationCodes.relies_on.join(' '), /Pending Deprecation .* PendingDeprecation/);
});

test('CMP-03: the pin check refuses a page without a read time or with rules other than the tool’s', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-ms-rest-')),
    copy = path.join(dir, 'microsoft-rest-v13.json');
  // A resealed copy of the pin with one change, checked offline by the tool (its seal alone cannot catch these).
  const check = mutate => {
    const changed = structuredClone(envelope);
    mutate(changed.document);
    changed.document_sha256 = createHash('sha256').update(JSON.stringify(changed.document)).digest('hex');
    fs.writeFileSync(copy, JSON.stringify(changed));
    return () =>
      execFileSync(process.execPath, ['tools/microsoft-rest.mjs', '--check', '--file=' + copy], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
  };
  try {
    check(() => {})();
    assert.throws(
      check(d => delete d.operations.AddCampaigns.read_at),
      /AddCampaigns: no read time/,
    );
    assert.throws(
      check(d => d.references.LocationCriterion.relies_on.pop()),
      /LocationCriterion: the pinned rules differ from reliesOn/,
    );
    assert.throws(
      check(d => (d.operations.AddCampaigns.relies_on = ['Invented'])),
      /AddCampaigns: the pinned rules differ/,
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
