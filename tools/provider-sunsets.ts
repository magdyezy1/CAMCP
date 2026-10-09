import {pathToFileURL} from 'node:url';
import {assertSunsetRegistry, staleSunsetChecks, sunsetStatus} from '../src/provider-sunsets.js';
import {assertDeprecationRegistry, deprecationStatus} from '../src/provider-deprecations.js';
import {providerMaintenance} from '../src/contract-evidence.js';
import {providerContracts} from '../src/provider-contracts.js';

// The provider versions AMCP sends and when each stops working (F-56), plus the dated deprecations inside a version
// (PRV-04). Without --alarm it checks both registries against the versions AMCP sends or can be configured to send;
// that is part of `npm run check`, and its result does not depend on the date. With --alarm it also fails when a
// recorded sunset is 90 days away or less, or past, when a dated deprecation takes effect within 90 days, or when a
// version's recorded check is more than 45 days old (stale_check). `--now YYYY-MM-DD` evaluates the alarms at another
// day; the local qualification runner (tools/qualify.mjs) records them without failing a build.
export function sunsetReport(args: string[], now = Date.now()) {
  assertSunsetRegistry();
  assertDeprecationRegistry();
  const index = args.indexOf('--now');
  if (index >= 0) {
    const value = args[index + 1] ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')))
      throw Error('--now takes a day as YYYY-MM-DD.');
    now = Date.parse(value + 'T00:00:00Z');
  }
  const alarm = args.includes('--alarm'),
    documentation = new Map(providerContracts.map(c => [String(c.id), c.documentation])),
    versions = sunsetStatus(now).map(s => ({
      ...s,
      where:
        providerMaintenance[s.provider]?.lifecycle ??
        providerMaintenance[s.provider]?.changelog ??
        documentation.get(s.provider),
    })),
    deprecations = deprecationStatus(now),
    stale = staleSunsetChecks(now);
  const alarms = [
    ...versions
      .filter(s => s.alarm)
      .map(s => ({
        kind: 'sunset',
        provider: s.provider,
        version: s.version,
        active: s.active,
        sunset: s.sunset,
        days_left: s.days_left,
      })),
    ...deprecations
      .filter(d => d.alarm)
      .map(d => ({
        kind: 'deprecation',
        provider: d.provider,
        deprecation: d.id,
        effective_date: d.effective_date,
        days_left: d.days_until_effective,
      })),
    ...stale.map(s => ({
      kind: 'stale_check',
      provider: s.provider,
      version: s.version,
      checked: s.checked,
      age_days: s.age_days,
    })),
  ];
  return {
    report: {
      mode: alarm ? 'alarm' : 'registry',
      checked_at: new Date(now).toISOString(),
      providers: new Set(versions.map(s => s.provider)).size,
      dated: versions
        .filter(s => s.sunset)
        .map(s => s.provider + ' ' + s.version + ': ' + s.sunset + (s.active ? '' : ' (accepted, not sent)')),
      // Providers with more than one version AMCP can be configured to send (the Meta rollback): each one's status.
      configurable_versions: versions
        .filter(s => versions.filter(v => v.provider === s.provider).length > 1)
        .map(
          s =>
            s.provider +
            ' ' +
            s.version +
            ': ' +
            (s.active ? 'sent' : 'accepted, not sent') +
            ', ' +
            (s.sunset ? 'ends ' + s.sunset : 'no published end') +
            ' (checked ' +
            s.checked +
            ')',
        ),
      deprecations: deprecations.map(
        d => d.provider + ' ' + d.id + ': ' + d.effective_date + (d.effective ? ' (in effect)' : ''),
      ),
      alarms: alarm ? alarms : alarms.filter(a => a.kind === 'sunset'),
      ...(alarm ? {versions, deprecation_status: deprecations} : {}),
    },
    failed: alarm && alarms.length > 0,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {report, failed} = sunsetReport(process.argv.slice(2));
  console.log(JSON.stringify(report, null, 2));
  if (failed) process.exitCode = 1;
}
