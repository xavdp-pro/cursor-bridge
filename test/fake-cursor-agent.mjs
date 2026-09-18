#!/usr/bin/env node
/**
 * A stand-in for cursor-agent that replays real captures (test/fixtures).
 * The scenario is chosen by a keyword in the prompt, so the bridge under test
 * runs exactly the code path it runs in production: spawn, stdout lines,
 * stderr, exit code, signals.
 *
 *   scenario:tools      tools-partial.jsonl (thinking, read + shell tools, deltas)
 *   scenario:resume     resume-ask.jsonl
 *   scenario:plain      whole-text assistant lines only (no --stream-partial-output)
 *   scenario:bad-model  stderr message, exit 1, no JSON (what the real CLI does)
 *   scenario:silent     exit 0 with no output at all
 *   scenario:is-error   a result line with is_error: true
 *   scenario:slow       init line, a grandchild `sleep`, then waits to be killed
 *   scenario:drip       init line, then one delta and a result 700 ms later
 *   scenario:trap       init line, a grandchild shell that ignores SIGTERM
 *   scenario:escape     init line, a grandchild in its own session that keeps stdout open
 *
 * FAKE_ARGV_LOG     append each argv as one JSON line
 * FAKE_CHILD_PID    write the grandchild pid here (scenario:slow)
 * FAKE_LOGGED_OUT   `status` reports no login
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('2026.08.25-fake\n');
  process.exit(0);
}
if (args[0] === 'status') {
  process.stdout.write(process.env.FAKE_LOGGED_OUT ? 'Not logged in\n' : '[32m✓[0m Logged in as someone@example.invalid\n');
  process.exit(0);
}

if (process.env.FAKE_ARGV_LOG) fs.appendFileSync(process.env.FAKE_ARGV_LOG, `${JSON.stringify(args)}\n`);

const sep = args.indexOf('--');
const message = sep >= 0 ? args.slice(sep + 1).join(' ') : '';
const resumeIdx = args.indexOf('--resume');
const sessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : crypto.randomUUID();
const scenario = (message.match(/scenario:([a-z-]+)/) || [])[1] || 'tools';

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function replay(file) {
  const lines = fs.readFileSync(path.join(here, 'fixtures', file), 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    const ev = JSON.parse(line);
    if (ev.session_id) ev.session_id = sessionId;
    out(ev);
  }
}

const init = { type: 'system', subtype: 'init', apiKeySource: 'env', cwd: process.cwd(), session_id: sessionId, model: 'Fake', permissionMode: 'default' };

switch (scenario) {
  case 'tools':
    replay('tools-partial.jsonl');
    break;
  case 'resume':
    replay('resume-ask.jsonl');
    break;
  case 'plain':
    out(init);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'First part.' }] }, session_id: sessionId });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ' Second part.' }] }, session_id: sessionId });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'First part. Second part.', session_id: sessionId, duration_ms: 5 });
    break;
  case 'bad-model':
    process.stderr.write(fs.readFileSync(path.join(here, 'fixtures', 'bad-model.stderr'), 'utf8'));
    process.exit(1);
    break;
  case 'silent':
    process.exit(0);
    break;
  case 'is-error':
    out(init);
    out({ type: 'result', subtype: 'error', is_error: true, result: 'The model refused the request.', session_id: sessionId, duration_ms: 5 });
    break;
  case 'slow': {
    out(init);
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    if (process.env.FAKE_CHILD_PID) fs.writeFileSync(process.env.FAKE_CHILD_PID, String(child.pid));
    setInterval(() => {}, 1000);
    break;
  }
  case 'drip':
    out(init);
    setTimeout(() => {
      out({ type: 'assistant', timestamp_ms: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] }, session_id: sessionId });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'late', session_id: sessionId, duration_ms: 5 });
    }, 700);
    break;
  case 'trap': {
    out(init);
    const child = spawn('sh', ['-c', 'trap "" TERM; sleep 60 & wait'], { stdio: 'ignore' });
    if (process.env.FAKE_CHILD_PID) fs.writeFileSync(process.env.FAKE_CHILD_PID, String(child.pid));
    setInterval(() => {}, 1000);
    break;
  }
  case 'escape': {
    out(init);
    const child = spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    if (process.env.FAKE_CHILD_PID) fs.writeFileSync(process.env.FAKE_CHILD_PID, String(child.pid));
    child.unref();
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exit(2);
}
