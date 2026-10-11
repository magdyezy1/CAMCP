'use strict';
// MSR-03 slice A: browser-local converters from a dataLayer export or a HAR file to a sanitized version 2 trace for
// Inspect a sanitized event trace. Nothing is uploaded, stored or sent: the chosen file is read in this page, and only
// an allowlist reaches the output — consent commands with the four Google consent types, exact event names, times
// derived from the original order and, for a purchase, an HMAC-SHA-256 of its transaction ID under a random key that
// exists only in this page's memory. URLs, cookies, user and client IDs, raw transaction IDs and every other parameter
// are dropped. GA4 does not document the gcs and gcd request parameters, so a HAR import never derives consent.
const measurementTraceImportLimits = Object.freeze({
  datalayer_bytes: 2 * 1024 * 1024,
  har_bytes: 16 * 1024 * 1024,
  steps: 1000,
  trace_bytes: 131072,
});
const measurementTraceImportConsent = ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization'];
const measurementTraceImportEvent = name => typeof name === 'string' && /^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(name);
const measurementTraceImportRegion = v => typeof v === 'string' && /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(v);
// One key per page session, generated on first use, never exported, stored or sent.
let measurementTraceImportKey = null;
async function measurementTraceImportHash(value) {
  if (!measurementTraceImportKey)
    measurementTraceImportKey = await crypto.subtle.generateKey({name: 'HMAC', hash: 'SHA-256', length: 256}, false, [
      'sign',
    ]);
  const signature = await crypto.subtle.sign('HMAC', measurementTraceImportKey, new TextEncoder().encode(value));
  return (
    'opaque-' +
    Array.from(new Uint8Array(signature))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')
  );
}
function measurementTraceImportTestId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return (
    'amcp-test-import-' +
    Array.from(bytes)
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')
  );
}
const measurementTraceImportObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// gtag() pushes an arguments object, which JSON.stringify writes as {"0":…,"1":…}; some exports write arrays.
function measurementTraceImportCommand(entry) {
  if (Array.isArray(entry)) return entry;
  if (!measurementTraceImportObject(entry) || !Object.hasOwn(entry, '0')) return null;
  const keys = Object.keys(entry);
  if (!keys.every(key => /^(?:0|[1-9][0-9]?)$/.test(key))) return null;
  return keys.map((_, index) => entry[String(index)]);
}
async function measurementTraceImportPurchase(step, id, counts) {
  if (step.event_name !== 'purchase' || id === undefined || id === null) return;
  if (id === '') {
    step.transaction_id_empty = true;
    counts.empty_transaction_ids++;
  } else if (typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))) {
    step.transaction_key = await measurementTraceImportHash(String(id));
    counts.hashed_purchase_keys++;
  }
}
/** dataLayer: consent commands, gtag events and pushed events, in order. Everything else is counted and dropped. */
async function measurementTraceFromDataLayer(entries, testId) {
  if (!Array.isArray(entries)) throw Error(uiText('A dataLayer export is a JSON array of dataLayer entries.'));
  const steps = [],
    counts = {consent: 0, events: 0, dropped: 0, hashed_purchase_keys: 0, empty_transaction_ids: 0, other_types: 0};
  for (const entry of entries) {
    if (steps.length >= measurementTraceImportLimits.steps) break;
    const command = measurementTraceImportCommand(entry);
    if (command?.[0] === 'consent' && ['default', 'update'].includes(command[1])) {
      const params = measurementTraceImportObject(command[2]) ? command[2] : {},
        consent = {};
      for (const [key, value] of Object.entries(params)) {
        if (measurementTraceImportConsent.includes(key) && ['granted', 'denied'].includes(value)) consent[key] = value;
        else if (!['region', 'wait_for_update'].includes(key)) counts.other_types++;
      }
      if (!Object.keys(consent).length) {
        counts.dropped++;
        continue;
      }
      const step = {kind: command[1] === 'default' ? 'consent_default' : 'consent_update', consent};
      if (command[1] === 'default') {
        const regions = params.region;
        if (
          Array.isArray(regions) &&
          regions.length >= 1 &&
          regions.length <= 50 &&
          regions.every(measurementTraceImportRegion) &&
          new Set(regions).size === regions.length
        )
          step.region = [...regions];
        else if (regions !== undefined) {
          // A region list that cannot be read exactly is not guessed: the default is left out.
          counts.dropped++;
          continue;
        }
        if (
          Number.isSafeInteger(params.wait_for_update) &&
          params.wait_for_update >= 0 &&
          params.wait_for_update <= 60000
        )
          step.wait_for_update_ms = params.wait_for_update;
        else if (params.wait_for_update !== undefined) {
          counts.dropped++;
          continue;
        }
      }
      steps.push(step);
      counts.consent++;
      continue;
    }
    let name, id;
    if (command?.[0] === 'event') {
      name = command[1];
      id = measurementTraceImportObject(command[2]) ? command[2].transaction_id : undefined;
    } else if (!command && measurementTraceImportObject(entry) && typeof entry.event === 'string') {
      name = entry.event;
      id = measurementTraceImportObject(entry.ecommerce) ? entry.ecommerce.transaction_id : undefined;
    }
    if (!measurementTraceImportEvent(name)) {
      counts.dropped++;
      continue;
    }
    const step = {kind: 'event', event_name: name, test_id: testId};
    await measurementTraceImportPurchase(step, id, counts);
    steps.push(step);
    counts.events++;
  }
  return {steps, counts, truncated: entries.length > 0 && steps.length >= measurementTraceImportLimits.steps};
}
/** HAR: only GA4 /g/collect requests of the selected measurement ID, and only their event name (en). */
function measurementTraceFromHar(har, testId, measurementId) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw Error(uiText('A HAR file is JSON with log.entries.'));
  const steps = [],
    counts = {consent: 0, events: 0, dropped: 0, other_streams: 0, hashed_purchase_keys: 0, empty_transaction_ids: 0};
  for (const entry of entries) {
    if (steps.length >= measurementTraceImportLimits.steps) break;
    let url;
    try {
      url = new URL(String(entry?.request?.url ?? ''));
    } catch {
      counts.dropped++;
      continue;
    }
    if (!['https:', 'http:'].includes(url.protocol) || !url.pathname.endsWith('/g/collect')) {
      counts.dropped++;
      continue;
    }
    const tid = url.searchParams.get('tid');
    if (measurementId && tid !== measurementId) {
      counts.other_streams++;
      continue;
    }
    // A batched POST carries one event per body line; the shared parameters stay in the URL.
    const body = typeof entry.request.postData?.text === 'string' ? entry.request.postData.text : '',
      lines = body.split(/\r?\n/).filter(line => line.trim()),
      names = lines.length ? lines.map(line => new URLSearchParams(line).get('en')) : [url.searchParams.get('en')];
    for (const name of names) {
      if (steps.length >= measurementTraceImportLimits.steps) break;
      if (!measurementTraceImportEvent(name)) {
        counts.dropped++;
        continue;
      }
      steps.push({kind: 'event', event_name: name, test_id: testId});
      counts.events++;
    }
  }
  return {
    steps,
    counts: {...counts, stream_filter: measurementId ? 'measurement_id' : 'none'},
    truncated: steps.length >= measurementTraceImportLimits.steps,
  };
}
/**
 * Converts the text of a chosen file into the JSON of a version 2 trace for one property and stream. The result also
 * says what was kept and dropped. Times follow the original order (one millisecond apart); real timing is unknown.
 */
async function measurementTraceImport(text, options) {
  const {format, property_id, stream_id, test_id, measurement_id} = options,
    limit = format === 'har' ? measurementTraceImportLimits.har_bytes : measurementTraceImportLimits.datalayer_bytes;
  if (!['datalayer', 'har'].includes(format)) throw Error(uiText('Choose a dataLayer export or a HAR file.'));
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > limit)
    throw Error(
      uiText(format === 'har' ? 'Choose a HAR file of at most 16 MiB.' : 'Choose a dataLayer export of at most 2 MiB.'),
    );
  if (
    typeof property_id !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(property_id) ||
    typeof stream_id !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(stream_id)
  )
    throw Error(uiText('Choose the GA4 property and enter its exact numeric data stream ID.'));
  if (typeof test_id !== 'string' || !/^amcp-test-[A-Za-z0-9-]{8,64}$/.test(test_id))
    throw Error(
      uiText(
        'Use a synthetic test identifier that starts with amcp-test- followed by 8–64 letters, digits or hyphens.',
      ),
    );
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Error(
      uiText(
        format === 'har'
          ? 'A HAR file is JSON with log.entries.'
          : 'A dataLayer export is a JSON array of dataLayer entries.',
      ),
    );
  }
  const converted =
    format === 'har'
      ? measurementTraceFromHar(parsed, test_id, measurement_id)
      : await measurementTraceFromDataLayer(parsed, test_id);
  if (!converted.steps.length)
    throw Error(uiText('The file contains no consent command or event that a trace can use.'));
  let steps = converted.steps,
    truncated = converted.truncated,
    json;
  // The inspector accepts at most 128 KiB; a longer session keeps its first steps and is labelled shortened.
  for (;;) {
    json = JSON.stringify({
      version: 2,
      scope: {property_id, stream_id, test_id, visitor_region: null},
      coverage: 'partial',
      steps: steps.map((step, index) => ({sequence: index + 1, at_ms: index, ...step})),
    });
    if (new TextEncoder().encode(json).length <= measurementTraceImportLimits.trace_bytes) break;
    steps = steps.slice(0, Math.floor(steps.length * 0.9));
    truncated = true;
  }
  return {
    json,
    summary: {
      format,
      steps: steps.length,
      ...converted.counts,
      truncated,
      network_requests: 0,
      stored: false,
    },
  };
}
