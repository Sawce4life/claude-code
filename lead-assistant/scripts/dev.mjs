/**
 * Runs the API and the web app together for local development.
 * The web app is served by Vite on 5173 and proxies /api to the server on 8080.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [];

function run(name, command, args, colour) {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${colour}m[${name}]\x1b[0m`;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(`${prefix} ${line}`);
    });
  }
  child.on('exit', (code) => {
    console.log(`${prefix} exited with code ${code}`);
    stop();
  });
  children.push(child);
  return child;
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run('api', process.execPath, ['--disable-warning=ExperimentalWarning', '--watch', 'server/src/index.js'], '36');
run('web', npm, ['run', 'dev', '--workspace', 'web'], '35');

console.log('\n  Open http://localhost:5173 -- the API runs on http://localhost:8080\n');
