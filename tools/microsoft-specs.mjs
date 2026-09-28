import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const microsoftSources = {
  'campaign-management':
    'https://campaign.api.bingads.microsoft.com/Api/Advertiser/CampaignManagement/v13/CampaignManagementService.svc?singleWsdl',
  bulk: 'https://bulk.api.bingads.microsoft.com/Api/Advertiser/CampaignManagement/v13/BulkService.svc?singleWsdl',
  reporting: 'https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc?singleWsdl',
  'ad-insight':
    'https://adinsight.api.bingads.microsoft.com/Api/Advertiser/AdInsight/v13/AdInsightService.svc?singleWsdl',
  'customer-management':
    'https://clientcenter.api.bingads.microsoft.com/Api/CustomerManagement/v13/CustomerManagementService.svc?singleWsdl',
  'customer-billing':
    'https://clientcenter.api.bingads.microsoft.com/Api/Billing/v13/CustomerBillingService.svc?singleWsdl',
};
const hash = v => createHash('sha256').update(v).digest('hex');
export function parseWsdl(xml) {
  return JSON.parse(
    execFileSync(
      process.env.AMCP_SCHEMA_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
      [fileURLToPath(new URL('wsdl-model.py', import.meta.url))],
      {
        input: xml,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30000,
        windowsHide: true,
      },
    ),
  );
}
async function main() {
  const check = process.argv.includes('--check'),
    offline = process.argv.includes('--generate-only') || check,
    contracts = {formatVersion: 1, evidence: 'VENDOR_DOCUMENTED_WSDL_NOT_JSON_PARITY', services: {}};
  for (const [service, source] of Object.entries(microsoftSources)) {
    const file = '.mirror/VENDOR/microsoft-' + service + '-v13.json';
    let envelope;
    if (fs.existsSync(file) && !process.argv.includes('--refresh'))
      envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      if (offline) throw Error('Missing Microsoft WSDL snapshot: ' + file);
      const response = await fetch(source, {redirect: 'error', signal: AbortSignal.timeout(30000)});
      if (!response.ok) throw Error(service + ' HTTP ' + response.status);
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 16 * 1024 * 1024) {
            await reader.cancel();
            throw Error('WSDL exceeds 16 MiB');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const xml = Buffer.concat(chunks).toString('utf8');
      const document = parseWsdl(xml);
      envelope = {
        source,
        captured_at: new Date().toISOString(),
        evidence: contracts.evidence,
        xml_sha256: hash(xml),
        xml,
        document_sha256: hash(JSON.stringify(document)),
        document,
      };
      fs.writeFileSync(file, JSON.stringify(envelope, null, 2) + '\n');
    }
    if (envelope.source !== source || envelope.xml_sha256 !== hash(envelope.xml))
      throw Error('WSDL provenance/integrity mismatch: ' + service);
    const document = parseWsdl(envelope.xml);
    if (
      envelope.document_sha256 !== hash(JSON.stringify(document)) ||
      JSON.stringify(document) !== JSON.stringify(envelope.document)
    )
      throw Error('WSDL normalized model is stale: ' + service);
    contracts.services[service] = {
      source,
      xml_sha256: envelope.xml_sha256,
      document_sha256: envelope.document_sha256,
      namespace: document.namespace,
      wire_format: document.wire_format,
      operations: document.methods,
      schemas: document.schemas,
      messages: document.messages,
    };
    console.log(
      service +
        ': ' +
        Object.keys(document.methods).length +
        ' operations, ' +
        Object.keys(document.schemas).length +
        ' declarations',
    );
  }
  const output = 'generated/microsoft-contracts.json',
    content = JSON.stringify(contracts, null, 2) + '\n';
  if (check) {
    if (fs.readFileSync(output, 'utf8') !== content) throw Error('Microsoft generated contracts are stale.');
  } else fs.writeFileSync(output, content);
  const summary = {
    formatVersion: 1,
    evidence: contracts.evidence,
    services: Object.fromEntries(
      Object.entries(contracts.services).map(([name, s]) => [
        name,
        {
          source: s.source,
          xml_sha256: s.xml_sha256,
          document_sha256: s.document_sha256,
          namespace: s.namespace,
          wire_format: s.wire_format,
          operations: Object.fromEntries(
            Object.entries(s.operations).map(([name, op]) => {
              const part = s.messages[op.request.attributes.message]?.children.find(
                  c => c.attributes.name === 'parameters',
                ),
                declaration = s.schemas['element:' + part?.attributes.element];
              const fields = [];
              function visit(n) {
                if (!n) return;
                for (const c of n.children) {
                  if (c.kind.endsWith('}element')) fields.push(c.attributes.name);
                  else visit(c);
                }
              }
              visit(declaration);
              return [name, {soap_actions: op.soapActions, request_fields: fields}];
            }),
          ),
        },
      ]),
    ),
  };
  const summaryPath = 'generated/microsoft-summary.json',
    summaryText = JSON.stringify(summary, null, 2) + '\n';
  if (check) {
    if (fs.readFileSync(summaryPath, 'utf8') !== summaryText) throw Error('Microsoft summary is stale.');
  } else fs.writeFileSync(summaryPath, summaryText);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) await main();
