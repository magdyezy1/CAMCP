import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseWsdl} from '../tools/microsoft-specs.mjs';
import {microsoftContracts, compileMicrosoft} from '../dist/src/microsoft-native.js';
import {contractShape} from '../dist/tools/provider-drift.js';
test('Microsoft six-service evidence resolves every implemented operation without claiming JSON parity', () => {
  const model = JSON.parse(fs.readFileSync('generated/microsoft-contracts.json', 'utf8'));
  assert.equal(Object.keys(model.services).length, 6);
  for (const [action, c] of microsoftContracts) {
    const services = Object.values(model.services).filter(s => s.operations[action]);
    assert.equal(services.length, 1, action);
    assert.match(services[0].wire_format, /SOAP/);
  }
  const plan = compileMicrosoft({
    action: 'AddCampaigns',
    account_id: '123',
    payload: {Campaigns: [{Name: 'Synthetic', Status: 'Paused'}]},
  });
  assert.equal(plan.contractEvidence?.vendor_method, 'AddCampaigns');
  assert.match(plan.contractEvidence.validation, /JSON/);
});
test('WSDL parser preserves namespaces, symbol spaces and rejects DTD/external includes', () => {
  assert.throws(() => parseWsdl('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]><x/>'));
  assert.throws(() =>
    parseWsdl(
      '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"><import location="https://example.invalid"/></definitions>',
    ),
  );
  assert.throws(() =>
    parseWsdl(
      '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:x="http://www.w3.org/2001/XMLSchema"><types><x:schema><x:import schemaLocation="https://example.invalid"/></x:schema></types></definitions>',
    ),
  );
  const e = JSON.parse(fs.readFileSync('.mirror/VENDOR/microsoft-bulk-v13.json', 'utf8')),
    d = parseWsdl(e.xml);
  assert.deepEqual(d, e.document);
  assert.ok(Object.keys(d.schemas).some(k => k.startsWith('element:')));
  assert.ok(Object.keys(d.schemas).some(k => k.startsWith('complexType:')));
  const altered = structuredClone(d),
    first = Object.keys(altered.methods)[0];
  altered.methods[first].soapActions = ['changed'];
  assert.notDeepEqual(contractShape(d), contractShape(altered));
  altered.methods = structuredClone(d.methods);
  altered.messages = {};
  assert.notDeepEqual(contractShape(d), contractShape(altered));
});
