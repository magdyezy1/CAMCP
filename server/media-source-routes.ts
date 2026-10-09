import express, {type Request} from 'express';
import {MirrorError} from '../src/errors.js';
import type {MediaSources} from '../src/media-sources.js';
import type {Store} from '../src/store.js';
import type {WebStore} from './web-store.js';

/** Upload parts read at once across the whole server; each is at most 1 MiB. */
const partsInFlight = 16;

/**
 * Website routes that bring a media file into AMCP without Google Drive: start an upload, send it in parts, see which
 * parts arrived (to resume), complete it, import one from a public link, list, preview and remove (an unfinished
 * upload is discarded the same way). Every change needs the signed-in session, its CSRF
 * token and the site's own origin; a part's body is read only after those checks and the part's exact length are
 * known, so a request that is refused never costs the server its body. Reviewer test accounts do not reach these
 * routes (see the allow-list in website.ts).
 */
export function mediaSourceRoutes(web: WebStore, store: Store, sources: () => MediaSources) {
  // Express 5 passes a thrown error or a rejected promise of a handler on to the error handler.
  const router = express.Router({caseSensitive: true});
  let reading = 0;
  // A long step (a download, an inspection) stops when the session ends or its CSRF token changes meanwhile.
  const mutation = (req: Request) => {
    const actor = {...web.requireMutation(req).actor};
    store.bindActorCheck(actor, () => {
      web.requireMutation(req);
    });
    return actor;
  };
  // server_time lets the page count down to each upload's deadline on the server's clock, not the device's.
  router.get('/api/media/sources', (req, res) => {
    res.json({sources: sources().list(web.requireSession(req).actor), server_time: new Date().toISOString()});
  });
  router.post('/api/media/sources', express.json({limit: '4kb'}), (req, res) => {
    res
      .status(201)
      .json({...sources().begin(web.requireMutation(req).actor, req.body ?? {}), server_time: new Date().toISOString()});
  });
  // An unfinished upload's received parts, to resume it after a lost connection or a reload.
  router.get('/api/media/sources/:id', (req, res) => {
    res.json({...sources().status(web.requireSession(req).actor, req.params.id), server_time: new Date().toISOString()});
  });
  router.post('/api/media/sources/:id/retain', express.json({limit: '4kb'}), (req, res) => {
    res.json(sources().retain(mutation(req), req.params.id, req.body ?? {}));
  });
  router.post('/api/media/sources/link', express.json({limit: '8kb'}), async (req, res) => {
    res
      .status(201)
      .json({...(await sources().importLink(mutation(req), req.body?.url)), server_time: new Date().toISOString()});
  });
  // Private Drive: list a folder selected in a Drive login, and import a file (selected, or inside such a folder). Both
  // make Drive requests with the stored login, so both need the same CSRF and origin checks as a change.
  router.post('/api/media/drive/folder', express.json({limit: '4kb'}), async (req, res) => {
    res.json(await sources().driveFolder(mutation(req), req.body ?? {}));
  });
  router.post('/api/media/sources/drive', express.json({limit: '4kb'}), async (req, res) => {
    res
      .status(201)
      .json({...(await sources().importDrive(mutation(req), req.body ?? {})), server_time: new Date().toISOString()});
  });
  router.put('/api/media/sources/:id/parts/:index', async (req, res) => {
    const session = web.requireMutation(req),
      media = sources(),
      index = /^\d{1,6}$/.test(String(req.params.index)) ? Number(req.params.index) : -1,
      length = media.partLength(session.actor, req.params.id, index);
    if (!/^application\/octet-stream\s*(;|$)/i.test(req.headers['content-type'] ?? ''))
      throw new MirrorError('INVALID_MEDIA_UPLOAD', 'Send each part as application/octet-stream.', {}, 415);
    if (req.headers['content-length'] !== String(length))
      throw new MirrorError('INVALID_MEDIA_UPLOAD', 'Part ' + index + ' must be exactly ' + length + ' bytes.', {
        expected_bytes: length,
      });
    if (reading >= partsInFlight)
      throw new MirrorError(
        'MEDIA_PARTS_BUSY',
        'AMCP is receiving many uploads right now. Send this part again in a moment.',
        {retry_after_ms: 1000},
        429,
        true,
      );
    reading++;
    let body: Buffer;
    try {
      body = await readBody(req, length);
    } finally {
      reading--;
    }
    res.json(media.put(session.actor, req.params.id, index, body));
  });
  router.post('/api/media/sources/:id/complete', async (req, res) => {
    res.json({...(await sources().complete(mutation(req), req.params.id)), server_time: new Date().toISOString()});
  });
  router.get('/api/media/sources/:id/thumbnail', (req, res) => {
    const jpeg = sources().thumbnail(web.requireSession(req).actor, req.params.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('image/jpeg').send(jpeg);
  });
  router.delete('/api/media/sources/:id', express.json({limit: '4kb'}), (req, res) => {
    res.json(sources().remove(mutation(req), req.params.id, req.body ?? {}));
  });
  return router;
}

/** Reads a request body of exactly `length` bytes, refusing more. */
function readBody(req: Request, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const body = Buffer.alloc(length);
    let offset = 0;
    const fail = (e: Error) => {
      req.removeAllListeners('data');
      reject(e);
    };
    req.on('data', (part: Buffer) => {
      if (offset + part.length > length) {
        req.destroy();
        return fail(new MirrorError('INVALID_MEDIA_UPLOAD', 'The part is longer than it said.'));
      }
      part.copy(body, offset);
      offset += part.length;
    });
    req.on('end', () =>
      offset === length
        ? resolve(body)
        : fail(new MirrorError('INVALID_MEDIA_UPLOAD', 'The part ended before all of it arrived.')),
    );
    req.on('error', () => fail(new MirrorError('INVALID_MEDIA_UPLOAD', 'The part did not arrive.')));
    req.on('aborted', () => fail(new MirrorError('INVALID_MEDIA_UPLOAD', 'The part did not arrive.')));
  });
}
