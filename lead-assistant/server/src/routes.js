import { readJsonBody, sendJson, sendError, openEventStream } from './http.js';
import {
  hashPassword, verifyPassword, issueToken, readToken,
  normalizeEmail, validateEmail, createThrottle,
} from './auth.js';
import { pull, push, loadAll } from './sync.js';
import { rankLeads, summarize } from '../../shared/priority.js';
import { buildBook, leadDossier, AiError } from './ai.js';
import { isValidTimezone } from '../../shared/timezone.js';
import { newId } from '../../shared/records.js';

export function registerRoutes({ db, config, ai }) {
  const loginThrottle = createThrottle({ limit: 12, windowMs: 10 * 60 * 1000 });
  const aiThrottle = createThrottle({ limit: 120, windowMs: 60 * 60 * 1000 });

  function publicUser(row) {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      timezone: row.timezone,
      prefs: safeJson(row.prefs),
      createdAt: row.created_at,
    };
  }

  function requireUser(req) {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const userId = readToken(token, config.sessionSecret);
    if (!userId) throw Object.assign(new Error('Please sign in again'), { status: 401 });
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row) throw Object.assign(new Error('Please sign in again'), { status: 401 });
    return row;
  }

  function clientKey(req) {
    return String(
      req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown',
    ).split(',')[0].trim();
  }

  const handlers = {
    'GET /api/health': (req, res) => {
      sendJson(res, 200, {
        ok: true,
        ai: ai.enabled,
        model: ai.enabled ? ai.model : null,
        signups: config.signupsOpen,
        time: Date.now(),
      });
    },

    'POST /api/auth/register': async (req, res) => {
      if (!config.signupsOpen) {
        const count = db.prepare('SELECT COUNT(*) AS n FROM users').get();
        if (Number(count.n) > 0) return sendError(res, 403, 'Sign-ups are closed on this server');
      }
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');

      if (!validateEmail(email)) return sendError(res, 400, 'That email address does not look right');
      if (password.length < 8) return sendError(res, 400, 'Use a password of at least 8 characters');

      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) return sendError(res, 409, 'An account with that email already exists');

      const timezone = isValidTimezone(body.timezone) ? body.timezone : 'UTC';
      const user = {
        id: newId(),
        email,
        name: String(body.name || '').slice(0, 120),
        password_hash: hashPassword(password),
        timezone,
        prefs: '{}',
        created_at: Date.now(),
      };
      db.prepare(
        `INSERT INTO users (id, email, name, password_hash, timezone, prefs, created_at, next_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(user.id, user.email, user.name, user.password_hash, user.timezone, user.prefs, user.created_at);

      sendJson(res, 201, {
        token: issueToken(user.id, config.sessionSecret),
        user: publicUser(user),
      });
    },

    'POST /api/auth/login': async (req, res) => {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const key = `${clientKey(req)}:${email}`;
      if (!loginThrottle.check(key)) {
        return sendError(res, 429, 'Too many attempts. Wait a few minutes and try again.');
      }

      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!row || !verifyPassword(String(body.password || ''), row.password_hash)) {
        return sendError(res, 401, 'That email and password do not match');
      }
      loginThrottle.clear(key);
      sendJson(res, 200, {
        token: issueToken(row.id, config.sessionSecret),
        user: publicUser(row),
      });
    },

    'GET /api/me': (req, res) => {
      const user = requireUser(req);
      sendJson(res, 200, { user: publicUser(user), ai: ai.enabled });
    },

    'PATCH /api/me': async (req, res) => {
      const user = requireUser(req);
      const body = await readJsonBody(req);
      const name = body.name === undefined ? user.name : String(body.name).slice(0, 120);
      const timezone = isValidTimezone(body.timezone) ? body.timezone : user.timezone;
      const prefs = body.prefs && typeof body.prefs === 'object'
        ? JSON.stringify(body.prefs).slice(0, 8000)
        : user.prefs;
      db.prepare('UPDATE users SET name = ?, timezone = ?, prefs = ? WHERE id = ?')
        .run(name, timezone, prefs, user.id);
      sendJson(res, 200, {
        user: publicUser({ ...user, name, timezone, prefs }),
      });
    },

    'POST /api/auth/password': async (req, res) => {
      const user = requireUser(req);
      const body = await readJsonBody(req);
      if (!verifyPassword(String(body.currentPassword || ''), user.password_hash)) {
        return sendError(res, 401, 'The current password is not right');
      }
      const next = String(body.newPassword || '');
      if (next.length < 8) return sendError(res, 400, 'Use a password of at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
      sendJson(res, 200, { ok: true, token: issueToken(user.id, config.sessionSecret) });
    },

    'GET /api/sync': (req, res, url) => {
      const user = requireUser(req);
      const result = pull(db, user.id, url.searchParams.get('since') || 0);
      sendJson(res, 200, { ...result, serverTime: Date.now() });
    },

    'POST /api/sync': async (req, res) => {
      const user = requireUser(req);
      const body = await readJsonBody(req);
      const now = Date.now();
      const written = push(db, user.id, body.changes || {}, now);
      const result = pull(db, user.id, body.since || 0);
      sendJson(res, 200, { ...result, written, serverTime: now });
    },

    'GET /api/today': (req, res) => {
      const user = requireUser(req);
      const data = loadAll(db, user.id);
      const ranked = rankLeads({ ...data, now: Date.now(), timezone: user.timezone });
      sendJson(res, 200, {
        counts: summarize(ranked),
        entries: ranked.slice(0, 100).map((entry) => ({
          leadId: entry.leadId,
          bucket: entry.bucket,
          bucketLabel: entry.bucketLabel,
          score: entry.score,
          reason: entry.reason,
          dueAt: entry.dueAt,
          lastContactAt: entry.lastContactAt,
        })),
      });
    },

    'POST /api/ai/parse': async (req, res) => {
      const user = requireUser(req);
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendError(res, 400, 'Nothing to read');
      guardAi(req, user);

      const data = loadAll(db, user.id);
      const draft = await ai.parseLogEntry({
        text,
        leads: data.leads,
        now: Date.now(),
        timezone: user.timezone,
      });
      sendJson(res, 200, { draft, aiEnabled: ai.enabled });
    },

    'POST /api/ai/brief': async (req, res) => {
      const user = requireUser(req);
      requireAi();
      guardAi(req, user);
      const data = loadAll(db, user.id);
      const ranked = rankLeads({ ...data, now: Date.now(), timezone: user.timezone })
        .filter((e) => ['overdue', 'today', 'new', 'due'].includes(e.bucket));
      const text = await ai.dailyBrief({
        ranked, now: Date.now(), timezone: user.timezone, name: user.name,
      });
      sendJson(res, 200, { brief: text, count: ranked.length });
    },

    'POST /api/ai/suggest': async (req, res) => {
      const user = requireUser(req);
      requireAi();
      guardAi(req, user);
      const body = await readJsonBody(req);
      const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?')
        .get(String(body.leadId || ''), user.id);
      if (!lead) return sendError(res, 404, 'That lead is not here');
      const interactions = db.prepare(
        'SELECT * FROM interactions WHERE user_id = ? AND lead_id = ? AND deleted = 0',
      ).all(user.id, lead.id);
      const text = await ai.suggestNextStep({
        lead, interactions, now: Date.now(), timezone: user.timezone,
      });
      sendJson(res, 200, { suggestion: text });
    },

    'POST /api/ai/ask': async (req, res) => {
      const user = requireUser(req);
      requireAi();
      guardAi(req, user);
      const body = await readJsonBody(req);
      const question = String(body.question || '').trim();
      if (!question) return sendError(res, 400, 'Ask me something');

      const data = loadAll(db, user.id);
      const book = buildBook({ ...data, timezone: user.timezone, now: Date.now() });
      const stream = openEventStream(res);
      req.on('close', () => stream.close());

      try {
        const answer = await ai.answerQuestion({
          question,
          book,
          history: Array.isArray(body.history) ? body.history : [],
          now: Date.now(),
          timezone: user.timezone,
          onDelta: (text) => stream.send('delta', text),
        });
        stream.send('done', { answer });
      } catch (err) {
        stream.send('failed', { message: err?.message || 'The assistant could not answer' });
      } finally {
        stream.close();
      }
    },

    'GET /api/lead-context': (req, res, url) => {
      const user = requireUser(req);
      const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?')
        .get(String(url.searchParams.get('leadId') || ''), user.id);
      if (!lead) return sendError(res, 404, 'That lead is not here');
      const interactions = db.prepare(
        'SELECT * FROM interactions WHERE user_id = ? AND lead_id = ? AND deleted = 0',
      ).all(user.id, lead.id);
      sendJson(res, 200, {
        dossier: leadDossier(lead, interactions, user.timezone, Date.now()),
      });
    },
  };

  function requireAi() {
    if (!ai.enabled) {
      throw new AiError(
        'No Anthropic API key is set on the server, so the AI features are off. Everything else still works.',
        503,
      );
    }
  }

  function guardAi(req, user) {
    if (!aiThrottle.check(`ai:${user.id}`)) {
      throw new AiError('That is a lot of AI requests in one hour. Try again later.', 429);
    }
  }

  return {
    async handle(req, res, url) {
      const key = `${req.method} ${url.pathname}`;
      const handler = handlers[key];
      if (!handler) return false;
      await handler(req, res, url);
      return true;
    },
  };
}

function safeJson(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
