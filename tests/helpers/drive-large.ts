import type {MediaSink} from '../../src/media-buffer.js';

/**
 * Hand-written, synthetic stand-ins for Google Drive's public download host, shared by the r25-media-drive-large tests
 * (2026-11-19). Nothing here was copied from Drive or from a field report: every id, page and body is made up, and no
 * test that uses them touches the network.
 */
export const FILE_ID = 'synFileIdAbcdefghij1';
export const OTHER_ID = 'synOtherIdAbcdefghij2';
export const UUID = '0b6f2c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e';
export const endpoint = 'https://drive.usercontent.google.com/download';
export const share = 'https://drive.google.com/file/d/' + FILE_ID + '/view?usp=sharing';
export const html = {headers: {'Content-Type': 'text/html; charset=utf-8'}};
export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

export interface PageParts {
  action?: string;
  method?: string;
  id?: string;
  exportValue?: string;
  confirm?: string;
  uuid?: string | null;
  inside?: string;
  after?: string;
  title?: string;
}
/** A confirmation page in the shape Drive serves it (a GET form of hidden fields), with synthetic text. */
export function page(over: PageParts = {}): string {
  return (
    '<!DOCTYPE html><html><head><title>' +
    (over.title ?? 'Synthetic scan warning') +
    '</title></head><body><p class="warning">This synthetic file is too large to scan for viruses.</p>' +
    '<form id="download-form" action="' +
    (over.action ?? endpoint) +
    '" method="' +
    (over.method ?? 'get') +
    '"><input type="submit" id="download-anyway" value="Download anyway">' +
    '<input type="hidden" name="id" value="' +
    (over.id ?? FILE_ID) +
    '"><input type="hidden" name="export" value="' +
    (over.exportValue ?? 'download') +
    '"><input type="hidden" name="confirm" value="' +
    (over.confirm ?? 't') +
    '">' +
    (over.uuid === null ? '' : '<input type="hidden" name="uuid" value="' + (over.uuid ?? UUID) + '">') +
    (over.inside ?? '') +
    '</form>' +
    (over.after ?? '') +
    '</body></html>'
  );
}
export type Reply = (url: URL, count: number) => Response;
/** A stand-in for Drive's host: it records every request, and answers each with the next reply (the last repeats). */
export function drive(...replies: Reply[]) {
  const requests: {url: URL; init: RequestInit | undefined}[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({url, init});
    return replies[Math.min(requests.length, replies.length) - 1]!(url, requests.length);
  };
  return {fetcher, requests};
}
export const confirmationPage: Reply = () => new Response(page(), html);
export const file: Reply = () =>
  new Response(new Uint8Array(png), {headers: {'Content-Type': 'application/octet-stream'}});
/** A sink that keeps only what the tests count: how many bytes were written, and the file's first bytes. */
export function counting() {
  let size = 0;
  const head: Buffer[] = [];
  const sink: MediaSink = {
    write(bytes) {
      size += bytes.length;
      if (head.reduce((n, b) => n + b.length, 0) < 64) head.push(Buffer.from(bytes.subarray(0, 64)));
    },
    finish: () => Buffer.concat(head),
  };
  return {sink, written: () => size};
}
export const hosts = (requests: {url: URL}[]) => requests.map(r => r.url.origin);
