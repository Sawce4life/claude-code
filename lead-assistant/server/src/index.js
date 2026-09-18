import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv, buildConfig } from './config.js';
import { openDatabase } from './db.js';
import { createAi } from './ai.js';
import { registerRoutes } from './routes.js';
import { createStaticHandler, securityHeaders, sendError } from './http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '../..');

loadEnv(rootDir);
const config = buildConfig(rootDir);
const db = openDatabase(config.dbFile);
const ai = createAi({ apiKey: config.anthropicApiKey, model: config.model });
const serveStatic = createStaticHandler(config.webDist);
const routes = registerRoutes({ db, config, ai });

const server = http.createServer(async (req, res) => {
  securityHeaders(res);

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendError(res, 400, 'Bad request URL');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      const handled = await routes.handle(req, res, url);
      if (!handled && !res.writableEnded) sendError(res, 404, 'No such endpoint');
    } catch (err) {
      if (!res.writableEnded) {
        const status = Number(err?.status) || 500;
        sendError(res, status, status === 500 ? 'Something went wrong on the server' : err.message);
      }
      if (!err?.status || err.status >= 500) console.error('[api]', err);
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Method not allowed');
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(config.port, config.host, () => {
  const where = `http://localhost:${config.port}`;
  console.log(`\n  Lead Assistant is running at ${where}`);
  console.log(`  Database: ${config.dbFile}`);
  console.log(`  AI features: ${ai.enabled ? `on (${config.model})` : 'off -- add ANTHROPIC_API_KEY to switch them on'}`);
  console.log(`  Sign-ups: ${config.signupsOpen ? 'open' : 'closed'}\n`);
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
