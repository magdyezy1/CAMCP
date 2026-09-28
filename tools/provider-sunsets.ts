import {pathToFileURL} from 'node:url';
import {assertSunsetRegistry, sunsetStatus} from '../src/provider-sunsets.js';
import {providerMaintenance} from '../src/contract-evidence.js';
import {providerContracts} from '../src/provider-contracts.js';

// The provider versions AMCP sends and when each stops working (F-56). Without --alarm it checks the registry against
// the versions AMCP sends; that is part of `npm run check`, and its result does not depend on the date. With --alarm it
// also fails when a recorded sunset is 90 days away or less, or past: the weekly provider workflow runs it that way.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertSunsetRegistry();
  const documentation = new Map(providerContracts.map(c => [String(c.id), c.documentation])),
    versions = sunsetStatus().map(s => ({
      ...s,
      where:
        providerMaintenance[s.provider]?.lifecycle ??
        providerMaintenance[s.provider]?.changelog ??
        documentation.get(s.provider),
    })),
    alarms = versions.filter(s => s.alarm);
  console.log(
    JSON.stringify(
      {
        mode: process.argv.includes('--alarm') ? 'alarm' : 'registry',
        checked_at: new Date().toISOString(),
        providers: versions.length,
        dated: versions.filter(s => s.sunset).map(s => s.provider + ' ' + s.version + ': ' + s.sunset),
        alarms: alarms.map(s => ({provider: s.provider, version: s.version, sunset: s.sunset, days_left: s.days_left})),
        ...(process.argv.includes('--alarm') ? {versions} : {}),
      },
      null,
      2,
    ),
  );
  if (process.argv.includes('--alarm') && alarms.length) process.exitCode = 1;
}
