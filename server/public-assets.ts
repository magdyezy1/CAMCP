import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {brotliCompressSync, constants, gzipSync} from 'node:zlib';
import type {NextFunction, Request, Response} from 'express';
import {assetEncoding} from './compressed-assets.js';

const textTypes = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt']);
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const unavailable = (): never => {
  throw new Error('PUBLIC_ASSETS_UNAVAILABLE');
};

/** Crawlers may read the public pages; the API, authorization flows and protocol endpoints are not pages. */
export const robotsTxt =
  'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /mcp\nDisallow: /authorize\nDisallow: /oauth/\nDisallow: /assets/v/*.html\n';
/**
 * RFC 9116 security contact. The owner sets AMCP_SECURITY_CONTACT (a mailto: or https: URI); until then it is the
 * contact the privacy policy already publishes. The expiry is recomputed for each response, 90 days ahead.
 */
export function securityTxt(origin: string, env: NodeJS.ProcessEnv, now = Date.now()) {
  const configured = env.AMCP_SECURITY_CONTACT?.trim(),
    contact =
      configured && /^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(configured) && configured.length <= 256
        ? configured
        : 'mailto:privacy@amcp.shop',
    expires = new Date(now + 90 * 86400000);
  expires.setUTCHours(0, 0, 0, 0);
  return (
    'Contact: ' +
    contact +
    '\nExpires: ' +
    expires.toISOString() +
    '\nPreferred-Languages: en, ar\nCanonical: ' +
    origin +
    '/.well-known/security.txt\n'
  );
}
/** The HTML documents the website serves at their own addresses; each is bound to the snapshot when served. */
export type PublicPage =
  | 'index.html'
  | 'about.html'
  | 'privacy.html'
  | 'privacy-ar.html'
  | 'terms.html'
  | 'terms-ar.html'
  | 'data-deletion.html'
  | 'data-deletion-ar.html'
  | '404.html'
  | '404-ar.html';
/** One bounded, immutable public-file snapshot per website process. No private state is part of its identity. */
export function createPublicAssets(directory: string) {
  const root = path.resolve(directory);
  let snapshot: {version: string; files: Map<string, {body: Buffer; hash: string}>} | undefined;
  const compressed = new Map<string, Buffer>();
  function current() {
    if (snapshot) return snapshot;
    const files = new Map<string, {body: Buffer; hash: string}>();
    let total = 0;
    function visit(relative: string) {
      const absolute = path.resolve(root, relative),
        info = fs.lstatSync(absolute);
      if (info.isSymbolicLink() || !info.isDirectory()) unavailable();
      for (const entry of fs.readdirSync(absolute, {withFileTypes: true})) {
        if (entry.name.startsWith('.')) continue;
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.name) || entry.isSymbolicLink()) unavailable();
        const name = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (name.split('/').length > 4) unavailable();
          visit(name);
          continue;
        }
        const filename = path.resolve(root, name),
          before = fs.lstatSync(filename);
        if (
          !filename.startsWith(root + path.sep) ||
          before.isSymbolicLink() ||
          !before.isFile() ||
          before.size > 8 * 1024 * 1024 ||
          files.size >= 256 ||
          (total += before.size) > 64 * 1024 * 1024
        )
          unavailable();
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        let body: Buffer;
        try {
          const opened = fs.fstatSync(fd);
          if (
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== before.size ||
            opened.mtimeMs !== before.mtimeMs
          )
            unavailable();
          body = Buffer.allocUnsafe(before.size);
          let offset = 0;
          while (offset < body.length) {
            const count = fs.readSync(fd, body, offset, body.length - offset, null);
            if (!count) unavailable();
            offset += count;
          }
          if (fs.readSync(fd, Buffer.allocUnsafe(1), 0, 1, null)) unavailable();
          const after = fs.fstatSync(fd);
          if (
            body.length !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          )
            unavailable();
        } finally {
          fs.closeSync(fd);
        }
        files.set(name, {body, hash: sha(body)});
      }
    }
    visit('');
    if (!files.size) unavailable();
    const records = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    snapshot = {
      version: sha('AMCP_PUBLIC_ASSETS_V1\0' + records.map(([name, value]) => name + '\0' + value.hash).join('\n')),
      files,
    };
    return snapshot;
  }
  return {
    get version() {
      return current().version;
    },
    /** The bytes of one snapshot file, for the few root addresses (such as /favicon.ico) that serve an asset. */
    file(name: string) {
      return current().files.get(name)?.body ?? unavailable();
    },
    html(name: PublicPage) {
      const {version, files} = current(),
        body = files.get(name)?.body.toString('utf8');
      if (!body) return unavailable();
      return body.replace(
        /\b(src|href)=(['"])(\/assets\/([A-Za-z0-9_./-]+))\2/g,
        (original, attr, quote, url, file) => {
          if (!files.has(file)) unavailable();
          return attr + '=' + quote + '/assets/v/' + version + '/' + file + quote;
        },
      );
    },
    middleware(req: Request, res: Response, next: NextFunction) {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.path.startsWith('/v/')) return next();
      const matchVersion = /^\/v\/([0-9a-f]{64})\/(.+)$/.exec(req.path),
        version = matchVersion?.[1],
        relative = matchVersion?.[2];
      if (!matchVersion || !version || !relative)
        return void res
          .status(400)
          .setHeader('Cache-Control', 'no-store')
          .type('text/plain')
          .send('INVALID_ASSET_VERSION');
      try {
        const active = current();
        if (version !== active.version)
          return void res
            .status(409)
            .setHeader('Cache-Control', 'no-store')
            .type('text/plain')
            .send('ASSET_VERSION_CHANGED');
        let file: string;
        try {
          file = decodeURIComponent(relative);
        } catch {
          return void res.status(400).setHeader('Cache-Control', 'no-store').end();
        }
        const source = active.files.get(file);
        if (!source) return void res.status(404).setHeader('Cache-Control', 'no-store').end();
        const encoding = textTypes.has(path.extname(file)) ? assetEncoding(req.headers['accept-encoding']) : undefined,
          etag = '"' + source.hash + (encoding ? '-' + encoding : '') + '"';
        let body = source.body;
        if (encoding) {
          const key = file + ':' + encoding;
          let cached = compressed.get(key);
          if (!cached) {
            cached =
              encoding === 'br'
                ? brotliCompressSync(body, {params: {[constants.BROTLI_PARAM_QUALITY]: 5}})
                : gzipSync(body, {level: 9});
            compressed.set(key, cached);
          }
          body = cached;
          res.setHeader('Content-Encoding', encoding);
        }
        res.type(path.extname(file));
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('ETag', etag);
        const match = req.headers['if-none-match'];
        if (match && match.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag))
          return void res.status(304).end();
        res.setHeader('Content-Length', body.length);
        if (req.method === 'HEAD') return void res.end();
        res.end(body);
      } catch (error) {
        next(error);
      }
    },
  };
}
