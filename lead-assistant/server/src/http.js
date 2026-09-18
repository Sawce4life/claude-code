import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Body was not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Opens a server-sent-events stream for token-by-token AI replies. */
export function openEventStream(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': open\n\n');
  let closed = false;
  return {
    send(event, data) {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed || res.writableEnded) return;
      closed = true;
      res.end();
    },
  };
}

const compressible = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/;

/**
 * Serves the built web app. Hashed asset filenames are cached hard; anything
 * else is revalidated so a deploy reaches devices immediately.
 */
export function createStaticHandler(rootDir) {
  return function serveStatic(req, res, urlPath) {
    if (!fs.existsSync(rootDir)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('The web app has not been built yet. Run: npm run build');
      return true;
    }

    let relative = decodeURIComponent(urlPath.replace(/^\/+/, ''));
    if (relative.includes('\0')) { res.writeHead(400); res.end(); return true; }

    let filePath = path.join(rootDir, relative);
    // Never serve anything outside the build directory.
    if (!filePath.startsWith(path.resolve(rootDir) + path.sep) && filePath !== path.resolve(rootDir)) {
      filePath = path.join(rootDir, 'index.html');
    }
    if (!relative || (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory())) {
      filePath = path.join(rootDir, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      // Unknown paths fall back to the app shell so client-side routes work.
      filePath = path.join(rootDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);
    const isHashed = /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(path.basename(filePath));
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      res.end();
      return true;
    }

    const headers = {
      'content-type': type,
      etag,
      'cache-control': isHashed
        ? 'public, max-age=31536000, immutable'
        : 'no-cache, must-revalidate',
    };

    let body = fs.readFileSync(filePath);
    const accepts = String(req.headers['accept-encoding'] || '');
    if (compressible.test(type) && body.length > 1024 && /\bgzip\b/.test(accepts)) {
      body = zlib.gzipSync(body);
      headers['content-encoding'] = 'gzip';
      headers.vary = 'Accept-Encoding';
    }
    headers['content-length'] = body.length;

    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(body);
    return true;
  };
}

export function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
}
