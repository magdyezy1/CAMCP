// CMP-03: the Microsoft location lookup. Before it, the microsoft_search pack took location IDs with no way to find
// them by name ("AMCP has no name-to-ID lookup"), and a typed ID was checked only by the names activation preflight read
// back after the criteria existed. Synthetic Microsoft API and file download only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {CredentialProvider} from '../dist/src/auth.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';
import {microsoftScope} from '../dist/src/microsoft-native.js';
import {errorRemedy} from '../dist/src/errors.js';
import {
  clearMicrosoftLocationFile,
  geoLocationsRest,
  locationQuery,
  microsoftLocationLimits,
  microsoftLocationLookup,
  microsoftLocationLookupStatus,
} from '../dist/src/microsoft-locations.js';
import {
  locationCsv,
  locationGzip,
  locationHeader,
  locationRows,
  locationZip,
  pinnedGeoLocations,
  unpinnedGeoLocations,
  zipFile,
} from './fixtures/microsoft-locations-data.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const actor = {tenantId: 'ms-locations', userId: 'operator', role: 'operator'},
  committed = JSON.parse(fs.readFileSync('.mirror/VENDOR/microsoft-rest-v13.json', 'utf8')),
  // Whether the deployment operator has pinned the page yet (tools/microsoft-rest.mjs); the tests below hold for both.
  pinnedNow = !!committed.document.optional_operations?.GetGeoLocationsFileUrl,
  unpinned = unpinnedGeoLocations(committed),
  pinned = pinnedGeoLocations(committed),
  rest = geoLocationsRest(pinned),
  fileUrl = 'https://geo.files.example.test/GeoLocations.zip?sig=synthetic',
  microsoftLookupUrl = 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/GeoLocationsFileUrl/Query';

/** A Microsoft login (account 123 of customer 456), its API answers and the file it serves, with every request kept. */
function fixture(t, options = {}) {
  clearMicrosoftLocationFile();
  t.after(clearMicrosoftLocationFile);
  const store = new Store(':memory:', Buffer.alloc(32, 63).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'ms',
      tenantId: actor.tenantId,
      gateway: 'microsoft_ads_native_action',
      accounts: ['123'],
      writeAccounts: [],
      accountCustomers: {123: '456'},
      scopes: [microsoftScope],
      enabled: true,
      label: 'Synthetic Microsoft',
    },
    {accessToken: 'synthetic', developerToken: 'synthetic-developer'},
  );
  const f = {store, requests: [], downloads: [], modified: '2026-10-01T00:00:00Z', file: locationZip()};
  const api = async (url, init) => {
    const u = new URL(String(url)),
      headers = new Headers(init?.headers);
    f.requests.push({
      method: init?.method,
      path: u.pathname,
      body: JSON.parse(String(init?.body ?? 'null')),
      account: headers.get('CustomerAccountId'),
      customer: headers.get('CustomerId'),
      developer: headers.get('DeveloperToken'),
    });
    if (options.answer) return options.answer(f);
    return Response.json({
      FileUrl: fileUrl,
      FileUrlExpiryTimeUtc: new Date(Date.now() + 15 * 60000).toISOString(),
      LastModifiedTimeUtc: f.modified,
    });
  };
  f.fetcher = async (url, init) => {
    f.downloads.push({url: String(url), init});
    options.duringDownload?.(f);
    if (options.download) return options.download(f, url);
    return new Response(f.file, {status: 200, headers: {'content-length': String(f.file.length)}});
  };
  const transport = new NativeTransport(api, async () => {});
  f.service = new MirrorService(new Registry(), store, transport, undefined, undefined, f.fetcher);
  f.services = {
    store,
    registry: f.service.registry,
    transport,
    credentials: new CredentialProvider(store),
    fetcher: f.fetcher,
  };
  f.lookup = (query, extra = {}) =>
    microsoftLocationLookup(f.services, actor, {query, account_id: '123', connection_id: 'ms', ...extra}, rest);
  return f;
}
const ids = out => out.results.map(r => r.location_id);

test('without the GetGeoLocationsFileUrl page pinned the lookup refuses before anything is sent', async t => {
  assert.throws(
    () => geoLocationsRest(unpinned),
    e => e.code === 'MICROSOFT_LOCATIONS_UNPINNED' && e.details.operation === 'GetGeoLocationsFileUrl',
  );
  // The remedy says what works meanwhile and who turns the search on.
  assert.match(errorRemedy({code: 'MICROSOFT_LOCATIONS_UNPINNED', details: {}}).action, /Enter location IDs/);
  // Through the service, the committed pin decides. Until the deployment operator pins the page (it is not pinned when
  // this was written), nothing reaches Microsoft; once pinned, the synthetic-pin tests below cover the reads.
  if (pinnedNow) {
    assert.equal(geoLocationsRest(committed).url, microsoftLookupUrl);
    return;
  }
  const f = fixture(t);
  const out = await f.service.call(
    'amcp_campaign',
    {
      action: 'recipe_lookup',
      lookup_kind: 'microsoft_location',
      query: 'Cairo',
      account_id: '123',
      connection_id: 'ms',
    },
    actor,
  );
  assertRefused(out, 'MICROSOFT_LOCATIONS_UNPINNED');
  assert.equal(out.error.details.operation, 'GetGeoLocationsFileUrl');
  assert.equal(f.requests.length, 0, 'no Microsoft request');
  assert.equal(f.downloads.length, 0, 'no download');
});

test('recipe_context tells the website whether the lookup can be sent, from the committed pin alone', async t => {
  const f = fixture(t);
  assert.deepEqual(microsoftLocationLookupStatus(unpinned), {available: false, code: 'MICROSOFT_LOCATIONS_UNPINNED'});
  assert.deepEqual(microsoftLocationLookupStatus(pinned), {available: true});
  assert.deepEqual(microsoftLocationLookupStatus(pinnedGeoLocations(committed, op => ({...op, method: 'GET'}))), {
    available: false,
    code: 'VENDOR_SCHEMA_UNAVAILABLE',
  });
  const context = await f.service.call(
    'amcp_campaign',
    {action: 'recipe_context', recipe: 'microsoft_search'},
    {...actor, role: 'admin'},
  );
  assert.equal(context.success, true, JSON.stringify(context));
  assert.deepEqual(context.data.location_lookup, microsoftLocationLookupStatus(committed));
  assert.equal(context.data.location_lookup.available, pinnedNow);
  const google = await f.service.call(
    'amcp_campaign',
    {action: 'recipe_context', recipe: 'google_search'},
    {...actor, role: 'admin'},
  );
  assert.equal(google.data.location_lookup, undefined, 'only the Microsoft pack has the lookup');
  assert.equal(f.requests.length + f.downloads.length, 0);
});

test('only a pinned page that documents the exact method, URL and fields opens the lookup', () => {
  assert.deepEqual(rest, {
    method: 'POST',
    url: 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/GeoLocationsFileUrl/Query',
    page: 'https://learn.microsoft.com/en-us/advertising/campaign-management-service/getgeolocationsfileurl?view=bingads-13',
    source_sha256: pinned.document_sha256,
  });
  for (const change of [
    op => ({...op, method: 'GET'}),
    op => ({...op, url: op.url.replace('/Query', '')}),
    op => ({...op, page: op.page.replace('getgeolocationsfileurl', 'getcampaignsbyids')}),
    op => ({...op, request_json: '{"Version": "ValueHere"}'}),
    op => ({...op, response_json: '{"FileUrl": "ValueHere"}'}),
    op => ({...op, request_json: 'not a template'}),
  ])
    assert.throws(
      () => geoLocationsRest(pinnedGeoLocations(committed, change)),
      e => e.code === 'VENDOR_SCHEMA_UNAVAILABLE',
    );
});

test('names and ID lists are checked before any access check or read', async t => {
  const f = fixture(t);
  for (const query of [
    '',
    'x',
    '<script>',
    'a'.repeat(81),
    '1,1',
    '0',
    '1;2',
    Array(101)
      .fill(0)
      .map((_, i) => i + 1)
      .join(','),
  ])
    assert.throws(
      () => locationQuery(query),
      e => e.code === 'INVALID_LOOKUP',
      JSON.stringify(query),
    );
  assert.deepEqual(locationQuery(' 190, 68\n151261 '), {mode: 'resolve', ids: ['190', '68', '151261']});
  assert.deepEqual(locationQuery('São Paulo'), {mode: 'search', text: 'São Paulo', folded: 'sao paulo'});
  await assert.rejects(f.lookup('x'), e => e.code === 'INVALID_LOOKUP');
  await assert.rejects(f.lookup('Cairo', {account_id: 'abc'}), e => e.code === 'INVALID_LOOKUP');
  // An account the login does not hold, and one without its verified parent customer, are refused unread.
  await assert.rejects(f.lookup('Cairo', {account_id: '999'}), e => e.code !== 'INVALID_LOOKUP' && e.status === 403);
  f.store.putConnection(
    {...actor, role: 'admin'},
    {...f.store.listConnections(actor.tenantId).find(c => c.id === 'ms'), accountCustomers: {}},
    {accessToken: 'synthetic', developerToken: 'synthetic-developer'},
  );
  await assert.rejects(f.lookup('Cairo'), e => e.code === 'MICROSOFT_CUSTOMER_REQUIRED');
  assert.equal(f.requests.length + f.downloads.length, 0);
});

test('a search reads the file URL under the account, downloads the file once and ranks names', async t => {
  const f = fixture(t),
    out = await f.lookup('cairo');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0], {
    method: 'POST',
    path: '/CampaignManagement/v13/GeoLocationsFileUrl/Query',
    body: {Version: '2.0', LanguageLocale: 'en', CompressionType: 'GZip'},
    account: '123',
    customer: '456',
    developer: 'synthetic-developer',
  });
  // The file URL is downloaded without credentials or redirects.
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].url, fileUrl);
  assert.equal(f.downloads[0].init.credentials, 'omit');
  assert.equal(f.downloads[0].init.redirect, 'error');
  assert.equal(out.kind, 'microsoft_location');
  assert.equal(out.mode, 'search');
  assert.equal(out.match_count, 5);
  // Exact or leading matches first, Active ones before the rest, then the shorter name; a word inside a name last.
  assert.deepEqual(ids(out), ['151261', '151262', '151263', '151265', '151264']);
  assert.deepEqual(out.results[0], {
    location_id: '151261',
    display_name: 'Cairo, Cairo, Egypt',
    location_type: 'City',
    status: 'Active',
    selectable: true,
  });
  assert.deepEqual(
    out.results.filter(r => !r.selectable).map(r => [r.location_id, r.status, r.reason]),
    [
      ['151263', 'Pending Deprecation', 'pending_deprecation'],
      ['151265', 'Deprecated', 'deprecated'],
    ],
  );
  assert.deepEqual(out.file.columns, locationHeader.split(','));
  assert.deepEqual(out.file.interpreted, {
    location_id: 'Location Id',
    display_name: 'Bing Display Name',
    location_type: 'Location Type',
    status: 'Status',
  });
  assert.equal(out.file.rows, locationRows.length);
  assert.equal(out.file.last_modified, '2026-10-01T00:00:00Z');
  assert.equal(out.file.kept_copy, false);
  assert.equal(out.provider_requests, 1);
  assert.equal(out.file_downloads, 1);
  assert.equal(out.provider_mutations, 0);
  assert.doesNotMatch(JSON.stringify(out), /sig=synthetic/, 'the signed file URL is never returned');
  // Accents and case are ignored for matching only; names stay exactly as the file has them.
  const accents = await f.lookup('sao paulo');
  assert.deepEqual(
    accents.results.map(r => r.display_name),
    ['São Paulo, Sao Paulo, Brazil'],
  );
  // A quoted field keeps its commas and escaped quotes; several IDs can share a name, told apart by type.
  assert.equal((await f.lookup('quoted')).results[0].display_name, 'The "Quoted" Place, Somewhere');
  assert.deepEqual(
    (await f.lookup('Springfield')).results.map(r => [r.location_id, r.location_type]),
    [
      ['151269', 'City'],
      ['151270', 'County'],
    ],
  );
  assert.deepEqual((await f.lookup('Atlantis')).results, []);
});

test('ID lists resolve in the order given and name the IDs the file does not list', async t => {
  const f = fixture(t),
    out = await f.lookup('151263, 999999\n190');
  assert.equal(out.mode, 'resolve');
  assert.deepEqual(out.location_ids, ['151263', '999999', '190']);
  assert.deepEqual(ids(out), ['151263', '190']);
  assert.deepEqual(out.missing_ids, ['999999']);
  assert.equal(out.results[0].selectable, false);
  assert.equal(out.results[1].display_name, 'United States');
});

test('the kept file serves the next hour without a request, then only a changed modification time downloads it', async t => {
  const f = fixture(t);
  await f.lookup('cairo');
  const kept = await f.lookup('egypt');
  assert.equal(kept.provider_requests, 0);
  assert.equal(kept.file_downloads, 0);
  assert.equal(kept.file.kept_copy, true);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(ids(kept), ['68', '151261', '151264']);
  const now = Date.now;
  t.after(() => (Date.now = now));
  Date.now = () => now() + microsoftLocationLimits.fresh_ms + 1000;
  const checked = await f.lookup('egypt');
  assert.equal(checked.provider_requests, 1, 'the URL is read again');
  assert.equal(checked.file_downloads, 0, 'an unchanged file is not downloaded again');
  assert.equal(f.downloads.length, 1);
  Date.now = () => now() + 2 * microsoftLocationLimits.fresh_ms + 2000;
  f.modified = '2026-10-15T00:00:00Z';
  f.file = locationZip(locationCsv([...locationRows, '151271,"Giza, Giza, Egypt",City,,Active,']));
  const changed = await f.lookup('egypt');
  assert.equal(changed.file_downloads, 1);
  assert.equal(changed.file.last_modified, '2026-10-15T00:00:00Z');
  assert.ok(ids(changed).includes('151271'));
});

test('a GZip archive, a stored ZIP member and a file without a status column are read; unknown status stays unknown', async t => {
  for (const file of [locationGzip(), zipFile('GeoLocations.csv', locationCsv(), {method: 0})]) {
    const f = fixture(t);
    f.file = file;
    assert.deepEqual(ids(await f.lookup('cairo')), ['151261', '151262', '151263', '151265', '151264']);
  }
  const f = fixture(t);
  f.file = locationZip(
    locationCsv(['190,United States', '"151261","Cairo, Cairo, Egypt"'], 'Location Id,Bing Display Name'),
  );
  const out = await f.lookup('cairo');
  assert.deepEqual(out.results, [
    {
      location_id: '151261',
      display_name: 'Cairo, Cairo, Egypt',
      location_type: null,
      status: null,
      selectable: true,
      reason: 'status_not_in_file',
    },
  ]);
  assert.deepEqual(out.file.interpreted, {
    location_id: 'Location Id',
    display_name: 'Bing Display Name',
    location_type: null,
    status: null,
  });
  const odd = fixture(t);
  odd.file = locationZip(locationCsv(['151261,"Cairo, Cairo, Egypt",City,,Retired,']));
  assert.deepEqual(
    (await odd.lookup('cairo')).results.map(r => [r.selectable, r.reason]),
    [[false, 'status_unknown']],
  );
});

test('a malformed, foreign, oversized or lying file is refused whole, and nothing of it is kept', async t => {
  const csv = locationCsv(),
    zip = locationZip(),
    cases = [
      ['not an archive', Buffer.from(csv), 'not_an_archive'],
      ['wrong CRC', zipFile('GeoLocations.csv', csv, {crc: 1}), 'crc_or_size'],
      ['wrong size', zipFile('GeoLocations.csv', csv, {size: 10}), 'crc_or_size'],
      [
        'declared expansion over the bound',
        zipFile('GeoLocations.csv', csv, {size: microsoftLocationLimits.text_bytes + 1}),
        'zip_member',
      ],
      ['unexpected member', zipFile('../GeoLocations.exe', csv), 'zip_member'],
      ['truncated archive', zip.subarray(0, zip.length - 30), 'zip_not_single_file'],
      [
        'no documented columns',
        locationZip(locationCsv(locationRows, 'Id,Name,Type,Replaces,Status,Other')),
        'documented_columns',
      ],
      [
        'repeated column',
        locationZip(
          locationCsv(['190,United States,United States'], 'Location Id,Bing Display Name,Bing Display Name'),
        ),
        'repeated_column',
      ],
      ['repeated ID', locationZip(locationCsv([...locationRows, '190,Duplicate,Country,,Active,'])), 'repeated_id'],
      ['malformed ID', locationZip(locationCsv(['abc,Nowhere,City,,Active,'])), 'id_or_name'],
      ['unsafe ID', locationZip(locationCsv(['9223372036854775808,Nowhere,City,,Active,'])), 'id_or_name'],
      ['short row', locationZip(locationCsv(['190,United States'])), 'row_shape'],
      ['unclosed quote', locationZip(locationCsv(['190,"United States,Country,,Active,'])), 'unclosed_quote'],
      ['quote inside a field', locationZip(locationCsv(['190,United "States",Country,,Active,'])), 'quote_in_field'],
      ['text after a quote', locationZip(locationCsv(['190,"United" States,Country,,Active,'])), 'text_after_quote'],
      ['control character', locationZip(locationCsv(['190,United\u0007States,Country,,Active,'])), 'id_or_name'],
      ['no header', locationZip(''), 'no_header'],
      [
        'invalid UTF-8',
        zipFile(
          'GeoLocations.csv',
          Buffer.concat([
            Buffer.from(locationHeader + '\n190,'),
            Buffer.from([0xc3, 0x28]),
            Buffer.from(',City,,Active,\n'),
          ]),
        ),
        'encoding',
      ],
    ];
  for (const [name, file, problem] of cases) {
    const f = fixture(t);
    f.file = file;
    await assert.rejects(
      f.lookup('cairo'),
      e => e.code === 'MICROSOFT_LOCATIONS_FILE_INVALID' && e.details.problem === problem,
      name,
    );
    // Nothing was kept: the next lookup reads the URL and downloads again.
    f.file = zip;
    assert.equal((await f.lookup('cairo')).file_downloads, 1, name);
  }
});

test('the file text and the archive are bounded before they are read whole', async t => {
  const big = fixture(t, {
    download: () =>
      new Response(new Uint8Array(1), {status: 200, headers: {'content-length': String(33 * 1024 * 1024)}}),
  });
  await assert.rejects(big.lookup('cairo'), e => e.code === 'MICROSOFT_LOCATIONS_FILE_UNAVAILABLE');
  // An archive that expands past 128 MiB is stopped while it inflates. Its text is blank lines, which no other bound
  // refuses, so only the text bound can stop it.
  const bomb = fixture(t),
    gzip = createGzip({level: 1}),
    packed = [],
    line = Buffer.from(' '.repeat(1000) + '\n'),
    lines = Buffer.concat(Array(1024).fill(line));
  gzip.on('data', chunk => packed.push(chunk));
  const ended = new Promise((resolve, reject) => gzip.on('end', resolve).on('error', reject));
  gzip.write(locationHeader + '\n');
  for (let written = 0; written <= microsoftLocationLimits.text_bytes; written += lines.length)
    if (!gzip.write(lines)) await new Promise(resolve => gzip.once('drain', resolve));
  gzip.end();
  await ended;
  bomb.file = Buffer.concat(packed);
  assert.ok(bomb.file.length < microsoftLocationLimits.archive_bytes);
  await assert.rejects(
    bomb.lookup('cairo'),
    e =>
      e.code === 'MICROSOFT_LOCATIONS_FILE_INVALID' && e.details.problem === 'text_bytes' && /128 MiB/.test(e.message),
  );
  const missing = fixture(t, {download: () => new Response('gone', {status: 404})});
  await assert.rejects(
    missing.lookup('cairo'),
    e => e.code === 'MICROSOFT_LOCATIONS_FILE_UNAVAILABLE' && e.details.http_status === 404,
  );
});

test('Microsoft’s answer must name a usable public HTTPS file URL that has not expired', async t => {
  const answers = [
    ['no URL', () => Response.json({LastModifiedTimeUtc: '2026-10-01T00:00:00Z'}), 'UPSTREAM_RESPONSE_INVALID'],
    [
      'operation errors',
      () => Response.json({FileUrl: fileUrl, OperationErrors: [{Code: 1, Message: 'x'}]}),
      'UPSTREAM_RESPONSE_INVALID',
    ],
    [
      'expired',
      () => Response.json({FileUrl: fileUrl, FileUrlExpiryTimeUtc: '2026-01-01T00:00:00Z'}),
      'UPSTREAM_RESPONSE_INVALID',
    ],
    [
      'plain HTTP',
      () => Response.json({FileUrl: 'http://geo.files.example.test/x.zip'}),
      'MICROSOFT_LOCATIONS_FILE_INVALID',
    ],
    [
      'credentials in the URL',
      () => Response.json({FileUrl: 'https://user:secret@geo.files.example.test/x.zip'}),
      'MICROSOFT_LOCATIONS_FILE_INVALID',
    ],
    ['private address', () => Response.json({FileUrl: 'https://10.0.0.8/x.zip'}), 'MICROSOFT_LOCATIONS_FILE_INVALID'],
    [
      'provider refusal',
      () => Response.json({Code: 105, Message: 'Synthetic refusal'}, {status: 400}),
      'UPSTREAM_ERROR',
    ],
  ];
  for (const [name, answer, code] of answers) {
    const f = fixture(t, {answer});
    await assert.rejects(f.lookup('cairo'), e => e.code === code, name);
    assert.equal(f.downloads.length, 0, name + ': nothing downloaded');
  }
});

test('a login replaced during the download refuses the lookup and keeps nothing', async t => {
  let replaced = false;
  const f = fixture(t, {
    duringDownload: f => {
      if (replaced) return;
      replaced = true;
      f.store.putConnection(
        {...actor, role: 'admin'},
        f.store.listConnections(actor.tenantId).find(c => c.id === 'ms'),
        {accessToken: 'another-login', developerToken: 'synthetic-developer'},
      );
    },
  });
  await assert.rejects(f.lookup('cairo'), e => e.code === 'CONNECTION_AUTHORITY_CHANGED');
  const again = await f.lookup('cairo');
  assert.equal(again.file_downloads, 1, 'the refused download was not kept');
});

test('recipe_lookup routes microsoft_location to the lookup and keeps the Google lookup unchanged', async t => {
  const f = fixture(t),
    runner = new CampaignRunner(
      f.store,
      async () => {
        throw Error('no native call');
      },
      async () => ({}),
      async () => ({}),
      undefined,
      () => true,
      undefined,
      (a, input) => microsoftLocationLookup(f.services, a, input, rest),
    );
  const out = await runner.handle(
    {action: 'recipe_lookup', lookup_kind: 'microsoft_location', query: '190', account_id: '123', connection_id: 'ms'},
    actor,
  );
  assert.deepEqual(ids(out), ['190']);
  await assert.rejects(
    runner.handle({action: 'recipe_lookup', lookup_kind: 'city', query: 'Cairo', account_id: '123'}, actor),
    e => e.code === 'INVALID_ARGUMENT' || e.code === 'INVALID_LOOKUP',
  );
  // A runner built without the lookup refuses it as unavailable.
  const bare = new CampaignRunner(
    f.store,
    async () => ({}),
    async () => ({}),
    async () => ({}),
  );
  await assert.rejects(
    bare.handle(
      {
        action: 'recipe_lookup',
        lookup_kind: 'microsoft_location',
        query: '190',
        account_id: '123',
        connection_id: 'ms',
      },
      actor,
    ),
    e => e.code === 'MICROSOFT_LOCATIONS_UNPINNED',
  );
});

test('the pin check accepts the optional page once pinned with its rules, and refuses a foreign or rule-less one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-ms-geo-')),
    copy = path.join(dir, 'microsoft-rest-v13.json');
  const check = envelope => {
    fs.writeFileSync(copy, JSON.stringify(envelope));
    return () =>
      execFileSync(process.execPath, ['tools/microsoft-rest.mjs', '--check', '--file=' + copy], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
  };
  try {
    // Unpinned, the check passes and names the operation whose feature refuses.
    assert.match(check(unpinned)(), /optional_not_pinned.*GetGeoLocationsFileUrl/);
    assert.doesNotMatch(check(pinned)(), /optional_not_pinned/);
    assert.throws(
      check(pinnedGeoLocations(committed, op => ({...op, page: op.page.replace('getgeo', 'getgeo2')}))),
      /pinned from another page/,
    );
    assert.throws(
      check(pinnedGeoLocations(committed, op => ({...op, relies_on: ['Invented']}))),
      /pinned rules differ/,
    );
    assert.throws(check(pinnedGeoLocations(committed, ({read_at, ...op}) => op)), /no read time/);
    const foreign = pinnedGeoLocations(committed);
    foreign.document.optional_operations.AddCampaigns = foreign.document.optional_operations.GetGeoLocationsFileUrl;
    foreign.document_sha256 = createHash('sha256').update(JSON.stringify(foreign.document)).digest('hex');
    assert.throws(check(foreign), /AddCampaigns: not an optional operation/);
  } finally {
    removeTestDirectory(dir, 'amcp-ms-geo-');
  }
});
