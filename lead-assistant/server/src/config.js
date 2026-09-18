import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Reads a .env file (if present) into process.env without overwriting
 * variables the host already set. Keeps the app dependency-free.
 */
export function loadEnv(dir) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function buildConfig(rootDir) {
  const dataDir = path.resolve(rootDir, process.env.DATA_DIR || './data');
  fs.mkdirSync(dataDir, { recursive: true });

  let secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    // Without a stable secret every restart would sign people out. Generate one
    // once and keep it next to the database so restarts are transparent.
    const secretFile = path.join(dataDir, 'session-secret');
    if (fs.existsSync(secretFile)) {
      secret = fs.readFileSync(secretFile, 'utf8').trim();
    } else {
      secret = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    }
  }

  return {
    port: Number(process.env.PORT || 8080),
    host: process.env.HOST || '0.0.0.0',
    dataDir,
    dbFile: path.join(dataDir, 'lead-assistant.db'),
    sessionSecret: secret,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-opus-5',
    signupsOpen: (process.env.SIGNUPS || 'open').toLowerCase() !== 'closed',
    webDist: path.resolve(rootDir, 'web/dist'),
  };
}
