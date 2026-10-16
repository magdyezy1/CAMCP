// Synthetic Microsoft geographical locations files (CMP-03). The IDs and names are test data, not Microsoft's file.
import {crc32, deflateRawSync, gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

export const locationHeader = 'Location Id,Bing Display Name,Location Type,Replaces,Status,AdWords Location Id';
export const locationRows = [
  '190,United States,Country,,Active,2840',
  '68,Egypt,Country,,Active,2818',
  '151261,"Cairo, Cairo, Egypt",City,,Active,1005386',
  '151262,"Cairo, Georgia, United States",City,,Active,1015209',
  '151263,"Cairo, Illinois, United States",City,,Pending Deprecation,',
  '151264,"New Cairo, Cairo, Egypt",City,,Active,',
  '151265,"Cairo Montenotte, Liguria, Italy",City,,Deprecated,',
  '151266,"São Paulo, Sao Paulo, Brazil",City,,Active,',
  '151267,"Washington, D.C., United States",MetroArea,,Active,',
  '151268,"The ""Quoted"" Place, Somewhere",City,,Active,',
  '151269,Springfield,City,,Active,',
  '151270,Springfield,County,,Active,',
];
/** The file's text: a UTF-8 byte order mark, CRLF line ends and the synthetic rows. */
export const locationCsv = (rows = locationRows, header = locationHeader) =>
  '﻿' + [header, ...rows].join('\r\n') + '\r\n';

/** A single-file ZIP archive, deflated (method 8) or stored (0); crc and size may be overridden to forge one. */
export function zipFile(name, content, {method = 8, crc, size} = {}) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    packed = method === 8 ? deflateRawSync(data) : data,
    file = Buffer.from(name, 'utf8'),
    sum = crc ?? crc32(data),
    length = size ?? data.length;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(sum, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(length, 24);
  central.writeUInt16LE(file.length, 28);
  central.writeUInt32LE(0, 42);
  const at = 30 + file.length + packed.length,
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + file.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([local, file, packed, central, file, end]);
}
export const locationZip = (csv = locationCsv()) => zipFile('GeoLocations.csv', csv);
export const locationGzip = (csv = locationCsv()) => gzipSync(Buffer.from(csv, 'utf8'));

/** The REST evidence as the owner's run of tools/microsoft-rest.mjs would add it, resealed (synthetic templates). */
export function pinnedGeoLocations(envelope, change = op => op) {
  const copy = structuredClone(envelope);
  copy.document.optional_operations = {
    GetGeoLocationsFileUrl: change({
      page: 'https://learn.microsoft.com/en-us/advertising/campaign-management-service/getgeolocationsfileurl?view=bingads-13',
      read_at: '2026-10-16T00:00:00.000Z',
      relies_on: [
        'Version 2.0 is the file version AMCP requests, LanguageLocale en gives its display names in English, and CompressionType Zip a single-file ZIP archive.',
        'FileUrl is valid until FileUrlExpiryTimeUtc, and LastModifiedTimeUtc tells whether the file changed since an earlier download.',
      ],
      method: 'POST',
      url: 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/GeoLocationsFileUrl/Query',
      sandbox_url:
        'https://campaign.api.sandbox.bingads.microsoft.com/CampaignManagement/v13/GeoLocationsFileUrl/Query',
      request_json:
        '{\n  "Version": "ValueHere",\n  "LanguageLocale": "ValueHere",\n  "CompressionType": "ValueHere"\n}',
      response_json:
        '{\n  "FileUrl": "ValueHere",\n  "FileUrlExpiryTimeUtc": "ValueHere",\n  "LastModifiedTimeUtc": "ValueHere"\n}',
    }),
  };
  copy.document_sha256 = createHash('sha256').update(JSON.stringify(copy.document)).digest('hex');
  return copy;
}
