#!/usr/bin/env node
/**
 * Live test: starts the real bridge in front of the real cursor-agent and
 * checks the contract end to end. It spends a little model quota.
 *
 *   CURSOR_MODEL=<id from `cursor-agent models`> npm run test:cli
 *
 * Authentication is whatever cursor-agent already uses on this host
 * (CURSOR_API_KEY in the environment, or `cursor-agent login`).
 * Everything is created in a throwaway directory and removed at the end.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBridgeStatus } from '../src/contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = (process.env.CURSOR_MODEL || '').trim();
if (!model) {
  console.error('CURSOR_MODEL is not set. Pick one from `cursor-agent models` and run again.');
  process.exit(78);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-live-'));
const token = 'live-test-token-0123456789abcdef';
const results = [];
let bridge;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;

async function api(method, p, body, tok = token) {
  const res = await fetch(base + p, {
    method,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function openEvents() {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
  const list = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('data: ')) list.push(JSON.parse(chunk.slice(6)));
        }
      }
    } catch { /* closed */ }
  })();
  const until = async (pred, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = list.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  return { list, until, close: () => ctrl.abort(), ofRun: (id) => list.filter((e) => e.run_id === id) };
}

const ended = (id) => (e) => e.run_id === id && (e.type === 'run_complete' || e.type === 'run_aborted');

try {
  fs.writeFileSync(path.join(dir, 'token'), `${token}\n`, { mode: 0o600 });
  const wsRoot = path.join(dir, 'ws');
  fs.mkdirSync(path.join(wsRoot, 'live'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'live', 'note.txt'), 'amber falcon 42\n');

  bridge = spawn(process.execPath, [path.join(root, 'bin', 'cursor-bridge.mjs')], {
    env: {
      ...process.env,
      CURSOR_BRIDGE_PORT: String(port),
      CURSOR_BRIDGE_HOME: path.join(dir, 'home'),
      CURSOR_BRIDGE_TOKEN_FILE: path.join(dir, 'token'),
      CURSOR_BRIDGE_WORKSPACE_ROOT: wsRoot,
      CURSOR_MODEL: model,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
  }
  check('bridge starts and answers /api/health', up);
  if (!up) throw new Error('bridge did not start');

  check('the API refuses a wrong token', (await api('GET', '/api/status', null, 'wrong')).status === 401);

  const status = (await api('GET', '/api/status')).body;
  const faults = validateBridgeStatus(status);
  check('status follows shaper-bridge/v1', faults.length === 0, faults.join('; '));
  check('status is ready (CLI runs and is authenticated)', status.ready === true,
    status.ready ? `cursor-agent ${status.cli.version}` : status.reasons.join('; '));

  const ev = await openEvents();

  // Turn 1: a file read, so that tool events are exercised.
  const t1 = (await api('POST', '/api/inject', {
    conversation: 'live',
    message: 'Use your file-reading tool to read note.txt in the current workspace, then reply with its exact content and nothing else.',
  })).body;
  const end1 = await ev.until(ended(t1.run_id), 180_000);
  const run1 = ev.ofRun(t1.run_id);
  const seqOk = run1.every((e, i) => e.seq === i + 1);
  const complete1 = run1.find((e) => e.type === 'response_complete');
  check('turn 1 completes', end1?.type === 'run_complete' && end1.ok === true, end1?.error || '');
  check('turn 1 events carry run_id and a contiguous seq', run1.length > 3 && seqOk, `${run1.length} events`);
  check('turn 1 reports the tool call and its result',
    run1.some((e) => e.type === 'tool') && run1.some((e) => e.type === 'tool_complete' && e.ok));
  check('turn 1 streams the answer in several deltas', run1.filter((e) => e.type === 'response').length > 1);
  check('turn 1 answer contains the file content', /amber falcon 42/.test(complete1?.text || ''), JSON.stringify(complete1?.text));
  check('turn 1 answer is sent once (no duplicated text)',
    (complete1?.text || '').split('amber falcon 42').length === 2);

  // Turn 2: memory of turn 1, through --resume.
  const t2 = (await api('POST', '/api/inject', {
    conversation: 'live',
    mode: 'ask',
    message: 'Without using any tool: what were the three words of the file you read in the previous turn? Reply with them only.',
  })).body;
  const end2 = await ev.until(ended(t2.run_id), 120_000);
  const complete2 = ev.ofRun(t2.run_id).find((e) => e.type === 'response_complete');
  check('turn 2 is sent as a resumed session', t2.resumed === true);
  check('turn 2 keeps the same cursor-agent session', end2?.session_id && end2.session_id === end1?.session_id);
  check('turn 2 remembers turn 1', /amber falcon 42/.test(complete2?.text || ''), JSON.stringify(complete2?.text));

  // Stop: a long answer, stopped right after it starts.
  const t3 = (await api('POST', '/api/inject', {
    conversation: 'live-stop',
    mode: 'ask',
    message: 'Write a detailed 1500-word essay on the history of lighthouses.',
  })).body;
  await ev.until((e) => e.run_id === t3.run_id && e.seq >= 2, 60_000);
  const stopped = (await api('POST', '/api/conversations/stop', { conversation: 'live-stop' })).body;
  const end3 = await ev.until(ended(t3.run_id), 30_000);
  check('stop ends a live run with run_aborted', stopped.stopped?.[0] === 'live-stop' && end3?.type === 'run_aborted' && end3.reason === 'stopped');
  check('no run is left alive after stop', (await api('GET', '/api/status')).body.runs_active === 0);

  // Reset: the next turn opens a new session.
  await api('POST', '/api/conversations/reset', { conversation: 'live' });
  const t4 = (await api('POST', '/api/inject', { conversation: 'live', mode: 'ask', message: 'Reply with the single word READY.' })).body;
  const end4 = await ev.until(ended(t4.run_id), 120_000);
  check('after reset the turn is not resumed', t4.resumed === false);
  check('after reset a new session is opened', end4?.ok === true && end4.session_id !== end1?.session_id);

  // A CLI error is surfaced, not swallowed.
  const t5 = (await api('POST', '/api/inject', { conversation: 'live-err', model: 'no-such-model', message: 'hi' })).body;
  const end5 = await ev.until(ended(t5.run_id), 60_000);
  check('an invalid model fails the run and says why', end5?.ok === false && /model/i.test(end5.error || ''), (end5?.error || '').slice(0, 80));

  const metrics = (await api('GET', '/api/metrics')).body;
  check('metrics count the runs', metrics.runs_started === 5 && metrics.runs_aborted === 1, JSON.stringify({
    started: metrics.runs_started, ok: metrics.runs_ok, failed: metrics.runs_failed, aborted: metrics.runs_aborted,
  }));
  ev.close();
} catch (err) {
  check('live test ran to the end', false, err.message);
} finally {
  if (bridge && bridge.exitCode == null) {
    bridge.kill('SIGTERM');
    await new Promise((r) => bridge.once('exit', r));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
