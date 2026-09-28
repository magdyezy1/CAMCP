import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import {Readable} from 'node:stream';
import {MirrorError} from './errors.js';
import {MAX_MEDIA_BYTES, mediaType} from './drive-media.js';
import {readMediaBody, type MediaSink} from './media-buffer.js';

/**
 * Media imported from a public HTTPS link (amcp_media `source_url`, the website's "import from a link"). The server
 * fetches a URL a user typed, so the link may only lead to the public internet: every address the host name resolves
 * to must be public, the connection goes to the address that was checked (no second lookup to rebind), and each of at
 * most three redirects is checked again the same way. No cookie, credential or advertising token is ever sent.
 */

/** Special-purpose IPv4 ranges (IANA registry): none of them is a public host. */
const reservedV4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
/** Special-purpose ranges inside IPv6 global unicast: protocol assignments (Teredo among them), 6to4, documentation. */
const reservedV6: [string, number][] = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];
const reserved = new net.BlockList(),
  globalUnicast = new net.BlockList();
for (const [network, prefix] of reservedV4) reserved.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of reservedV6) reserved.addSubnet(network, prefix, 'ipv6');
globalUnicast.addSubnet('2000::', 3, 'ipv6');

/** Whether an address is a public host: IPv4 outside every special-purpose range, IPv6 global unicast outside them. */
export function publicAddress(address: string): boolean {
  switch (net.isIP(address)) {
    case 4:
      return !reserved.check(address, 'ipv4');
    case 6:
      return globalUnicast.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
    default:
      return false;
  }
}

export type Resolver = (hostname: string) => Promise<dns.LookupAddress[]>;
const systemResolver: Resolver = hostname => dns.promises.lookup(hostname, {all: true, verbatim: true});
const blocked = () =>
  new MirrorError('MEDIA_LINK_BLOCKED', 'This link does not lead to a public internet address.', {}, 400);

/**
 * A connection lookup that resolves every address of the host and refuses the host unless all of them are public.
 * The socket connects to the addresses this returns, so the address checked is the address used.
 */
export function guardedLookup(resolve: Resolver = systemResolver): net.LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      addresses => {
        if (!addresses.length || !addresses.every(a => publicAddress(a.address))) return callback(blocked(), '', 0);
        const usable = addresses.filter(a => !options.family || a.family === options.family);
        if (!usable.length) return callback(blocked(), '', 0);
        if (options.all) return (callback as any)(null, usable);
        callback(null, usable[0]!.address, usable[0]!.family);
      },
      () => callback(new MirrorError('MEDIA_LINK_UNAVAILABLE', 'The link’s host name could not be found.'), '', 0),
    );
  };
}

/** A public HTTPS link to one file: no user name or password, no port but 443, a host name rather than an address. */
export function mediaLinkUrl(input: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new MirrorError('INVALID_MEDIA_LINK', 'Provide an HTTPS link to a PNG, JPEG, MP4 or MOV file.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new MirrorError('INVALID_MEDIA_LINK', 'Use an HTTPS link without a user name, password or port.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host) || !host.includes('.') || host.endsWith('.'))
    throw new MirrorError('INVALID_MEDIA_LINK', 'Use a link with a public host name, not an address or a local name.');
  if (/(^|\.)(drive|docs)\.google\.com$/.test(host))
    throw new MirrorError(
      'INVALID_MEDIA_LINK',
      'This is a Google Drive link: pass it as drive_url, which also reaches files shared only with you.',
    );
  url.hash = '';
  return url;
}

export type LinkRequest = (url: URL, options: {signal: AbortSignal; lookup: net.LookupFunction}) => Promise<Response>;

/** One HTTPS GET on a fresh connection (no pooled socket skips the lookup), as a fetch Response. */
export const linkRequest: LinkRequest = (url, {signal, lookup}) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup,
        signal,
        headers: {Accept: 'image/png,image/jpeg,video/mp4,video/quicktime', 'User-Agent': 'AMCP media import'},
      },
      response => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (typeof value === 'string') headers.set(name, value);
        const status = response.statusCode ?? 502,
          empty = [204, 205, 304].includes(status);
        if (empty) response.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {status, headers}),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });

/**
 * Downloads one PNG, JPEG, MP4 or MOV file from a public HTTPS link, at most the media limit, into `sink` when given.
 * Returns the bytes, their type and the host they finally came from (never the full link, which may carry a token).
 */
export async function downloadMediaLink(
  input: unknown,
  options: {request?: LinkRequest; resolve?: Resolver; sink?: MediaSink} = {},
) {
  let url = mediaLinkUrl(input);
  const request = options.request ?? linkRequest,
    lookup = guardedLookup(options.resolve),
    signal = AbortSignal.timeout(45000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response: Response;
    try {
      response = await request(url, {signal, lookup});
    } catch (e) {
      if (e instanceof MirrorError) throw e;
      if ((e as {cause?: unknown}).cause instanceof MirrorError) throw (e as {cause: MirrorError}).cause;
      throw new MirrorError('MEDIA_DOWNLOAD_FAILED', 'The link could not be downloaded, or it timed out.', {}, 502);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      let next: URL;
      try {
        next = new URL(location ?? '', url);
      } catch {
        throw new MirrorError('MEDIA_DOWNLOAD_FAILED', 'The link returned an invalid redirect.');
      }
      if (!location) throw new MirrorError('MEDIA_DOWNLOAD_FAILED', 'The link returned an invalid redirect.');
      url = mediaLinkUrl(next.href);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new MirrorError(
        'MEDIA_LINK_UNAVAILABLE',
        'The link did not return the file (HTTP ' + response.status + '). Use a link anyone can open.',
        {http_status: response.status},
      );
    }
    if (Number(response.headers.get('content-length')) > MAX_MEDIA_BYTES) {
      await response.body?.cancel();
      throw new MirrorError('MEDIA_TOO_LARGE', 'Media must be at most the configured media limit.');
    }
    let bytes: Buffer;
    try {
      bytes = await readMediaBody(response, MAX_MEDIA_BYTES, options.sink);
    } catch (e) {
      if (e instanceof MirrorError) throw e;
      throw new MirrorError('MEDIA_DOWNLOAD_FAILED', 'The link could not be downloaded, or it timed out.', {}, 502);
    }
    return {
      bytes,
      ...mediaType(
        bytes,
        'The link did not return a PNG, JPEG, MP4 or MOV file. Use a direct link to the file itself.',
      ),
      host: url.hostname,
    };
  }
  throw new MirrorError('MEDIA_DOWNLOAD_FAILED', 'The link redirected more than three times.');
}
