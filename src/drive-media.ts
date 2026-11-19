import {
  declaredLength,
  mediaDeadlineMs,
  mediaTooLarge,
  readChunk,
  readMediaBody,
  type MediaDownloadLimits,
  type MediaSink,
} from './media-buffer.js';
import {MirrorError} from './errors.js';
const defaultMediaLimit = 128;
/**
 * AMCP_MAX_MEDIA_MB is optional, so a bad value must not stop the server from starting. This
 * threw at module load, which aborts the process before anything can report why — the same
 * failure that took a deployment down over an optional reviewer password. A rejected value
 * falls back to the safe default and is surfaced instead: loudly on stderr at startup, and as
 * `mediaLimitProblem` for the health surface to report.
 */
function configuredMediaLimit(raw = process.env.AMCP_MAX_MEDIA_MB) {
  if (raw === undefined || raw === '') return {limit: defaultMediaLimit};
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 32 || value > 512)
    return {
      limit: defaultMediaLimit,
      problem:
        'AMCP_MAX_MEDIA_MB must be an integer from 32 to 512; the configured value was ignored and the ' +
        defaultMediaLimit +
        ' MB default applies.',
    };
  return {limit: value};
}
const mediaLimit = configuredMediaLimit();
export const mediaLimitProblem = mediaLimit.problem;
if (mediaLimit.problem) process.stderr.write('AMCP: ' + mediaLimit.problem + '\n');
export const MAX_MEDIA_BYTES = mediaLimit.limit * 1024 * 1024;
const idPattern = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * Whether a link is a Google Drive or Docs address. Such a link is downloaded with the Drive helper (downloadDriveMedia, its
 * confirmation page and its refusals), never as a public link: the website's link import and amcp_media agree on it.
 */
export function isDriveLink(input: unknown): boolean {
  try {
    return /(^|\.)(drive|docs)\.google\.com$/.test(new URL(String(input)).hostname);
  } catch {
    return false;
  }
}
/** A file share link is an identifier, never an arbitrary download destination. */
export function driveDownloadUrl(input: string): URL {
  let source: URL;
  try {
    source = new URL(input);
  } catch {
    throw new MirrorError('INVALID_DRIVE_LINK', 'Provide a Google Drive file share link.');
  }
  if (source.origin !== 'https://drive.google.com' || source.username || source.password || source.hash)
    throw new MirrorError('INVALID_DRIVE_LINK', 'Use an HTTPS drive.google.com file share link.');
  const match = /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/view|\/preview|\/edit)?\/?$/.exec(source.pathname);
  const id = match?.[1] ?? (/^\/(?:open|uc)$/.test(source.pathname) ? source.searchParams.get('id') : null);
  if (!id || !idPattern.test(id))
    throw new MirrorError('INVALID_DRIVE_LINK', 'Link must identify one Drive file, not a folder or Google document.');
  const url = new URL('https://drive.usercontent.google.com/download');
  url.searchParams.set('id', id);
  url.searchParams.set('export', 'download');
  const resourceKey = source.searchParams.get('resourcekey');
  if (resourceKey) {
    if (!idPattern.test(resourceKey)) throw new MirrorError('INVALID_DRIVE_LINK', 'Invalid Drive resource key.');
    url.searchParams.set('resourcekey', resourceKey);
  }
  return url;
}
function allowedDownload(url: URL) {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.hash &&
    ((url.hostname === 'drive.usercontent.google.com' && url.pathname === '/download') ||
      (/^[a-z0-9-]+-docs\.googleusercontent\.com$/.test(url.hostname) && url.pathname.startsWith('/docs/')))
  );
}
export function mediaType(
  bytes: Buffer,
  notMedia = 'The download is not PNG, JPEG, MP4 or MOV. Private Drive links and download confirmation pages cannot be uploaded.',
): {mime: string; kind: 'image' | 'video'; extension: string} {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return {mime: 'image/png', kind: 'image', extension: 'png'};
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return {mime: 'image/jpeg', kind: 'image', extension: 'jpg'};
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1'].includes(brand))
      throw new MirrorError('MEDIA_TYPE_UNSUPPORTED', 'Convert HEIC/AVIF images to PNG or JPEG.');
    if (!['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'MSNV', 'qt  '].includes(brand))
      throw new MirrorError('MEDIA_TYPE_UNSUPPORTED', 'Use PNG, JPEG, MP4 or MOV media.');
    return {
      mime: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4',
      kind: 'video',
      extension: brand === 'qt  ' ? 'mov' : 'mp4',
    };
  }
  throw new MirrorError('MEDIA_TYPE_UNSUPPORTED', notMedia);
}
/**
 * Google Drive's confirmation page for a large public file (R2.5 field fix r25-media-drive-large, lead decision
 * 2026-11-19, option A).
 *
 * A public file too large for Google to scan for viruses is not sent: Drive's download host answers 200 with an HTML
 * page ("can't scan this file for viruses") whose form asks for the same download once more with `confirm` (and `uuid`).
 * Google does not document this page, so AMCP recognizes it strictly and trusts none of it beyond two short values:
 *
 * - the page is read in full within 64 KiB, or refused;
 * - exactly one form, a GET to Drive's own download endpoint, holding only the hidden fields id, export, confirm and
 *   uuid, with the id AMCP asked for, a confirm value of letters, digits, hyphen and underscore, and a uuid that is one;
 * - no link, frame or refresh on the page may lead outside Google's own hosts.
 *
 * The next request is then built by AMCP alone (confirmationUrl): its host and path are constants, its id and resource
 * key are the validated ones of the link the caller gave, and only `confirm` and `uuid` come from the page. No URL the
 * page names is ever requested, so the page cannot move a request to another host, whatever it says.
 */
const driveDownloadEndpoint = 'https://drive.usercontent.google.com/download';
/** The most bytes of a page AMCP reads: a real confirmation page is a few kilobytes, so a longer page is not one. */
const confirmationPageLimit = 64 * 1024;
const confirmToken = /^[A-Za-z0-9_-]{1,64}$/,
  confirmUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /** The hosts of Google's own pages and assets: where the links of a real page may lead. */
  googleHost = /(^|\.)(google\.com|gstatic\.com|googleusercontent\.com|googleapis\.com)$/;

/**
 * A page's text, when the whole body is at most `limit` bytes. A longer body is cancelled as soon as it passes the limit
 * and gives undefined, so the rest of it is never read.
 */
async function readPage(
  response: Response,
  limits: {idleMs?: number; signal?: AbortSignal} = {},
  limit = confirmationPageLimit,
): Promise<string | undefined> {
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  if (!reader) return '';
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await readChunk(reader, limits.idleMs, limits.signal);
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch (e) {
    try {
      await reader.cancel();
    } catch {}
    throw e;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface Tag {
  name: string;
  closing: boolean;
  attributes: Map<string, string>;
}
const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  ndash: '-',
  mdash: '-',
};
/** The character references of an attribute value; one AMCP does not know stays as written, and then fails every check. */
function decode(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (reference, decimal, hex, name) => {
    if (name) return entities[name.toLowerCase()] ?? reference;
    const code = decimal ? Number(decimal) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : String.fromCodePoint(0xfffd);
  });
}
/**
 * The tags of a page in document order, without comments and without the text of scripts and styles (which a browser
 * does not read as tags). An attribute given twice keeps its first value, as a browser does; names are lower case and
 * values have their character references decoded, so a value is judged as it would be read.
 *
 * The page is the one a stranger's file host may have written, and it is read on the event loop that serves every
 * workspace, so the patterns here take time in step with the page, never with its square (lead review S2-1, 2026-11-20):
 * a tag name is as long as its letters (the lookahead leaves no shorter name to try), and no part of a tag, nor of an
 * opening script or style tag, crosses a `<`, so a tag that is never closed costs only the text up to the next `<`.
 *
 * The same patterns read less than a browser might: a quote that holds a `<` or `>` ends a tag. So every `<` that opens
 * a tag must have been read as one, and a page where one was not (a tag cut off, a quote that never closes) is undefined:
 * it is not read in part.
 */
function tagsOf(page: string): Tag[] | undefined {
  const text = page
      .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
      .replace(
        /<(script|style)(\s[^<>]*)?>[\s\S]*?(?:<\/\1\s*>|$)/gi,
        (_all, name: string, attributes: string | undefined) => '<' + name + (attributes ?? '') + '></' + name + '>',
      ),
    tags: Tag[] = [];
  for (const match of text.matchAll(
    /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?![a-zA-Z0-9:-])((?:[^<>"']|"[^"<>]*"|'[^'<>]*')*)>/g,
  )) {
    const attributes = new Map<string, string>();
    for (const a of match[3]!.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = a[1]!.toLowerCase();
      if (!attributes.has(name)) attributes.set(name, decode(a[2] ?? a[3] ?? a[4] ?? ''));
    }
    tags.push({name: match[2]!.toLowerCase(), closing: match[1] === '/', attributes});
  }
  return (text.match(/<\/?[a-zA-Z]/g) ?? []).length === tags.length ? tags : undefined;
}
/** Whether a link leads only to Google's own hosts (https, no credentials, no port), or stays on the page. */
function googleReference(value: string): boolean {
  if (value.startsWith('#')) return true;
  let url: URL;
  try {
    url = new URL(value, driveDownloadEndpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && googleHost.test(url.hostname);
}
/** The elements that send a reader elsewhere, with the attribute that holds where. */
const destinations: Record<string, string> = {
  a: 'href',
  area: 'href',
  iframe: 'src',
  frame: 'src',
  embed: 'src',
  object: 'data',
};

/** What a confirmation page asks Drive for: the `confirm` value, and the `uuid` when the page has one. */
interface DriveConfirmation {
  confirm: string;
  uuid?: string;
}
/**
 * The confirmation a page makes for file `fileId`, or undefined unless the page is exactly what the comment above
 * describes. Any doubt (a second form, a field of another name, a link off Google, a value out of its alphabet, a tag
 * that could not be read) is undefined: such a page is refused, and nothing it says is used.
 */
export function driveConfirmation(page: string, fileId: string): DriveConfirmation | undefined {
  const tags = tagsOf(page);
  if (!tags) return;
  const forms = tags.flatMap((tag, index) => (tag.name === 'form' && !tag.closing ? [index] : [])),
    form = forms.length === 1 ? tags[forms[0]!]! : undefined;
  if (!form || form.attributes.get('action') !== driveDownloadEndpoint) return;
  const method = form.attributes.get('method');
  if (method !== undefined && method.toLowerCase() !== 'get') return;
  const end = tags.findIndex((tag, index) => index > forms[0]! && tag.name === 'form' && tag.closing);
  if (end < 0 || tags.slice(end + 1).some(tag => tag.name === 'form' && tag.closing)) return;
  const fields = new Map<string, string>();
  for (const [index, tag] of tags.entries()) {
    if (tag.closing) continue;
    const inside = index > forms[0]! && index < end;
    // Nothing may redirect the reader: no base, no refresh, no button that submits somewhere else.
    if (tag.name === 'base' || tag.attributes.has('formaction')) return;
    if (tag.name === 'meta' && /refresh/i.test(tag.attributes.get('http-equiv') ?? '')) return;
    const link = destinations[tag.name];
    if (link && tag.attributes.has(link) && !googleReference(tag.attributes.get(link)!)) return;
    if (inside && ['select', 'textarea', 'object', 'embed', 'iframe', 'frame'].includes(tag.name)) return;
    if (tag.name === 'input' && tag.attributes.has('form')) return;
    if (!['input', 'button'].includes(tag.name) || !tag.attributes.has('name')) continue;
    // A field outside the form, a field typed in by a person, a field of another name or one given twice is not the page.
    const name = tag.attributes.get('name')!;
    if (!inside || tag.name !== 'input' || tag.attributes.get('type')?.toLowerCase() !== 'hidden') return;
    if (!['id', 'export', 'confirm', 'uuid'].includes(name) || fields.has(name)) return;
    fields.set(name, tag.attributes.get('value') ?? '');
  }
  const confirm = fields.get('confirm'),
    uuid = fields.get('uuid');
  if (fields.get('id') !== fileId || (fields.has('export') && fields.get('export') !== 'download')) return;
  if (confirm === undefined || !confirmToken.test(confirm) || (uuid !== undefined && !confirmUuid.test(uuid))) return;
  return {confirm, ...(uuid !== undefined ? {uuid} : {})};
}

/**
 * The one further request a confirmation makes: Drive's download endpoint with the file's id and resource key from the
 * link the caller gave (already validated by driveDownloadUrl), and the page's `confirm` and `uuid`.
 */
export function confirmationUrl(link: URL, confirmation: DriveConfirmation): URL {
  const url = new URL(driveDownloadEndpoint);
  url.searchParams.set('id', link.searchParams.get('id')!);
  url.searchParams.set('export', 'download');
  url.searchParams.set('confirm', confirmation.confirm);
  if (confirmation.uuid !== undefined) url.searchParams.set('uuid', confirmation.uuid);
  const resourceKey = link.searchParams.get('resourcekey');
  if (resourceKey) url.searchParams.set('resourcekey', resourceKey);
  return url;
}

/** Why Drive did not send a public file: a closed set, the `reason` of the refusal and the key of its remedy (errors.ts). */
type DriveReason = 'not_shared' | 'download_quota' | 'flagged' | 'unrecognized_page';
/**
 * The refusal for a public file Drive did not send (lead decision 2026-11-19, r25-media-drive-large): one sentence for each
 * reason, so the person or the agent knows what to change. A quota refusal may be tried again later; a flagged file is
 * never downloaded another way (AMCP does not acknowledge abuse, and nothing here asks again); the sentence of an
 * unrecognized page is the one this refusal always had.
 */
function driveUnavailable(reason: DriveReason, httpStatus?: number): MirrorError {
  const details = {reason, ...(httpStatus === undefined ? {} : {http_status: httpStatus})};
  if (reason === 'not_shared')
    return new MirrorError(
      'DRIVE_FILE_UNAVAILABLE',
      'Drive did not give out this file: it is private, or the link is wrong or was removed. Share it with anyone who has the link, or select it in a Drive connection, then prepare again.',
      details,
    );
  if (reason === 'download_quota')
    return new MirrorError(
      'DRIVE_FILE_UNAVAILABLE',
      'Google is limiting downloads of this Drive file for now because it was downloaded too often. Try again later, or select the file in a Drive connection.',
      details,
      429,
      true,
    );
  if (reason === 'flagged')
    return new MirrorError(
      'DRIVE_FILE_UNAVAILABLE',
      'Google Drive flagged this file (malware, spam or abuse) and does not let anyone download it. AMCP does not bypass that: use a different file.',
      details,
    );
  return new MirrorError(
    'DRIVE_FILE_UNAVAILABLE',
    'Drive returned a permission or download confirmation page. Use a directly downloadable shared file.',
    details,
  );
}
/**
 * The words of a page: comments, scripts, styles and tags removed, character references decoded, case folded. A tag
 * does not cross a `<` here either (see tagsOf), so a `<` that opens nothing hides no words after it.
 */
function visibleText(page: string): string {
  return decode(
    page
      .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
      .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
      .replace(/<[^<>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
/**
 * What a page that is not the confirmation page says went wrong, from its words alone. A page that reads like the
 * confirmation page (one AMCP did not accept, so it may be Drive's page in a shape that changed) and a page that says
 * nothing known are unrecognized: no reason is guessed from a word that any Google page has, such as a "Sign in" link.
 */
function pageReason(page: string | undefined): DriveReason {
  if (page === undefined) return 'unrecognized_page';
  const text = visibleText(page);
  if (/scan (?:this file )?for viruses|download anyway/.test(text)) return 'unrecognized_page';
  if (
    /malware or spam|identified as (?:malware|spam|abusive)|flagged (?:as|for) [^.]{0,60}(?:malware|spam|abus|violat)/.test(
      text,
    )
  )
    return 'flagged';
  if (/quota exceeded|too many users|(?:viewed|downloaded) this file recently|download quota/.test(text))
    return 'download_quota';
  if (
    /(?:you need|request|ask for|ask the owner for) (?:access|permission)|(?:don.?t|do not) have (?:access|permission)|sign in to (?:continue|view|access|download)|file you have requested does not exist|(?:page|file) not found|access denied/.test(
      text,
    )
  )
    return 'not_shared';
  return 'unrecognized_page';
}
/** A page's text for a refusal, or undefined when it is long; a body that fails to arrive is a failed download. */
async function pageOf(
  response: Response,
  limits: {idleMs?: number; signal?: AbortSignal},
): Promise<string | undefined> {
  try {
    return await readPage(response, limits);
  } catch (e) {
    if (e instanceof MirrorError) throw e;
    throw new MirrorError('MEDIA_DOWNLOAD_FAILED', 'The Drive download failed or timed out.', {}, 502);
  }
}

/**
 * Downloads one public Drive file, at most the media limit, into `sink` when given. The file is asked for at Drive's
 * download endpoint, and for a file too large for Google to scan the answer is a confirmation page instead (see the
 * comment on driveDownloadEndpoint): that page is followed once, by a request AMCP builds itself, and a second page is
 * refused. Every request, and every redirect, is checked against the approved Drive download hosts before it is made.
 * The whole download is bounded by what the media limit gives (mediaDeadlineMs), and a body that stops sending data is
 * given up on after the idle time (MEDIA_IDLE_MS); `limits` replaces either, for a test.
 */
export async function downloadDriveMedia(
  source: string,
  fetcher: typeof fetch = fetch,
  sink?: MediaSink,
  limits: MediaDownloadLimits = {},
) {
  const link = driveDownloadUrl(source),
    fileId = link.searchParams.get('id')!,
    signal = AbortSignal.timeout(limits.overallMs ?? mediaDeadlineMs(MAX_MEDIA_BYTES)),
    reading = {idleMs: limits.idleMs, signal};
  let url = link,
    confirmed = false,
    redirects = 0;
  for (;;) {
    if (!allowedDownload(url))
      throw new MirrorError('UNAPPROVED_MEDIA_SOURCE', 'Drive redirected outside its approved download hosts.');
    let response: Response;
    try {
      response = await fetcher(url, {
        redirect: 'manual',
        signal,
        credentials: 'omit',
        headers: {Accept: 'application/octet-stream'},
      });
    } catch {
      throw new MirrorError('MEDIA_DOWNLOAD_FAILED', 'The Drive download failed or timed out.', {}, 502);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new MirrorError('MEDIA_DOWNLOAD_FAILED', 'Drive returned an invalid redirect.');
      try {
        url = new URL(location, url);
      } catch {
        throw new MirrorError('MEDIA_DOWNLOAD_FAILED', 'Drive returned an invalid redirect.');
      }
      // Drive sends a file that is not shared with everyone to its sign-in page, and AMCP never follows that.
      if (url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.port)
        throw driveUnavailable('not_shared');
      // Three redirects in all, across the confirmation too.
      if (++redirects > 3)
        throw new MirrorError('MEDIA_DOWNLOAD_FAILED', 'Drive exceeded the download redirect limit.');
      continue;
    }
    if (!response.ok) {
      // A 403 may say why in its page (a quota, a flag); the other statuses say it themselves.
      let reason: DriveReason | undefined;
      if (response.status === 403) {
        const said = pageReason(await pageOf(response, reading));
        reason = said === 'unrecognized_page' ? 'not_shared' : said;
      } else {
        await response.body?.cancel();
        reason = [401, 404, 410].includes(response.status)
          ? 'not_shared'
          : response.status === 429
            ? 'download_quota'
            : undefined;
      }
      if (reason) throw driveUnavailable(reason, response.status);
      throw new MirrorError(
        'DRIVE_FILE_UNAVAILABLE',
        'Make this Drive file downloadable by anyone with the link, then prepare again.',
        {http_status: response.status},
      );
    }
    const declared = declaredLength(response);
    if (declared !== undefined && declared > MAX_MEDIA_BYTES) {
      await response.body?.cancel();
      throw mediaTooLarge(MAX_MEDIA_BYTES, declared);
    }
    if (/text\/html|application\/json/i.test(response.headers.get('content-type') ?? '')) {
      // Only the endpoint's own first answer can be the confirmation page, and only once: no loop, and a page that a
      // file host served (a file that is itself HTML) is never taken for one.
      const page = await pageOf(response, reading),
        confirmation =
          !confirmed && page !== undefined && url.origin + url.pathname === driveDownloadEndpoint
            ? driveConfirmation(page, fileId)
            : undefined;
      if (!confirmation) throw driveUnavailable(pageReason(page));
      url = confirmationUrl(link, confirmation);
      confirmed = true;
      continue;
    }
    const bytes = await readMediaBody(response, MAX_MEDIA_BYTES, sink, reading);
    return {bytes, ...mediaType(bytes)};
  }
}
