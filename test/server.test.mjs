/**
 * End-to-end tests of the HTTP server and the run manager, with the real
 * spawn path and a fake CLI (test/fake-cursor-agent.mjs) replaying real
 * captures. No network, no model quota.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CursorBridge } from '../src/bridge.mjs';
import { loadConfig } from '../src/config.mjs';
import { validateBridgeStatus } from '../src/contract.mjs';
import { createServer } from '../src/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-cursor-agent.mjs');
const TOKEN = 'test-token-0123456789';
const FINAL = 'Le fichier `note.txt` contient **2 mots** et **11 octets** (d’après `wc -c`).';

async function start(overrides = {}, { home } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-test-'));
  const argvLog = path.join(dir, 'argv.jsonl');
  process.env.FAKE_ARGV_LOG = argvLog;
  const config = loadConfig({
    CURSOR_MODEL: 'fake-model',
    CURSOR_AGENT_BIN: FAKE,
    CURSOR_BRIDGE_HOME: home || path.join(dir, 'home'),
    CURSOR_BRIDGE_WORKSPACE_ROOT: path.join(dir, 'ws'),
    CURSOR_BRIDGE_KILL_GRACE_MS: '500',
    ...overrides,
  });
  const bridge = new CursorBridge(config);
  const server = createServer({ bridge, token: TOKEN });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const streams = [];

  const api = async (method, p, body, token = TOKEN) => {
    const res = await fetch(base + p, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  /** Opens an SSE stream and collects its events. */
  const events = async (conversation) => {
    const ctrl = new AbortController();
    const q = conversation ? `?conversation=${encodeURIComponent(conversation)}` : '';
    const res = await fetch(`${base}/api/events${q}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal });
    const list = [];
    const waiters = [];
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
            if (chunk.startsWith('data: ')) {
              list.push(JSON.parse(chunk.slice(6)));
              for (const w of [...waiters]) w();
            }
          }
        }
      } catch { /* aborted */ }
    })();
    const until = (pred, ms = 8000) => new Promise((resolve, reject) => {
      const check = () => {
        const hit = list.find(pred);
        if (hit) { waiters.splice(waiters.indexOf(check), 1); clearTimeout(timer); resolve(hit); }
      };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error(`timeout waiting for event; got ${JSON.stringify(list.map((e) => e.type))}`)); }, ms);
      waiters.push(check);
      check();
    });
    await until((e) => e.type === 'connected');
    streams.push(ctrl);
    return { list, until, ofRun: (runId) => list.filter((e) => e.run_id === runId) };
  };

  const argv = () => fs.existsSync(argvLog)
    ? fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

  const stop = async () => {
    for (const s of streams) s.abort();
    bridge.shutdown();
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  };

  return { api, events, argv, stop, bridge, config, dir, base };
}

const done = (runId) => (e) => e.run_id === runId && (e.type === 'run_complete' || e.type === 'run_aborted');

test('health is public; everything else needs the token', async () => {
  const b = await start();
  try {
    const h = await fetch(`${b.base}/api/health`);
    assert.equal(h.status, 200);
    assert.equal((await b.api('GET', '/api/status', null, '')).status, 401);
    assert.equal((await b.api('GET', '/api/status', null, 'wrong-token-0123456789')).status, 401);
    assert.equal((await b.api('POST', '/api/inject', { conversation: 'a', message: 'x' }, 'nope')).status, 401);
  } finally { await b.stop(); }
});

test('status follows shaper-bridge/v1 and proves readiness by running the CLI', async () => {
  const b = await start();
  try {
    const { status, body } = await b.api('GET', '/api/status');
    assert.equal(status, 200);
    assert.deepEqual(validateBridgeStatus(body), []);
    assert.equal(body.ready, true);
    assert.equal(body.cli.version, '2026.08.25-fake');
    assert.equal(body.cli.authenticated, true);
    assert.equal(JSON.stringify(body).includes('example.invalid'), false, 'the account is never exposed');
    assert.equal(body.capabilities.stopRun, true);
    assert.equal(body.capabilities.attachments, false);
  } finally { await b.stop(); }
});

test('status is not ready when the CLI is not logged in', async () => {
  const b = await start();
  process.env.FAKE_LOGGED_OUT = '1';
  try {
    const { body } = await b.api('GET', '/api/status?refresh=1');
    assert.equal(body.ready, false);
    assert.match(body.reasons[0], /not authenticated/);
  } finally {
    delete process.env.FAKE_LOGGED_OUT;
    await b.stop();
  }
});

test('a run streams the contract events, stamped with run_id and a contiguous seq', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const { status, body } = await b.api('POST', '/api/inject', { conversation: 'demo', message: 'scenario:tools' });
    assert.equal(status, 200);
    assert.equal(body.resumed, false);
    await ev.until(done(body.run_id));
    const run = ev.ofRun(body.run_id);
    assert.deepEqual(run.map((e) => e.seq), run.map((_, i) => i + 1));
    assert.ok(run.every((e) => e.conversation === 'demo'));
    assert.equal(run[0].type, 'inject');
    const types = new Set(run.map((e) => e.type));
    for (const t of ['thinking', 'tool', 'tool_complete', 'response', 'response_complete', 'run_complete']) {
      assert.ok(types.has(t), `missing ${t}`);
    }
    const completes = run.filter((e) => e.type === 'response_complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].text, FINAL);
    const end = run.at(-1);
    assert.equal(end.type, 'run_complete');
    assert.equal(end.ok, true);
    assert.equal(end.session_id.length, 36);
  } finally { await b.stop(); }
});

test('the next turn resumes the same session', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const first = (await b.api('POST', '/api/inject', { conversation: 'demo', message: 'scenario:tools' })).body;
    const firstEnd = await ev.until(done(first.run_id));
    const second = (await b.api('POST', '/api/inject', { conversation: 'demo', message: 'scenario:resume' })).body;
    assert.equal(second.resumed, true);
    const secondEnd = await ev.until(done(second.run_id));
    assert.equal(secondEnd.session_id, firstEnd.session_id);
    const calls = b.argv();
    assert.equal(calls[0].includes('--resume'), false);
    assert.equal(calls[1][calls[1].indexOf('--resume') + 1], firstEnd.session_id);
    const list = (await b.api('GET', '/api/conversations')).body.conversations;
    assert.equal(list[0].session_id, firstEnd.session_id);
  } finally { await b.stop(); }
});

test('sessions survive a restart of the bridge', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-home-'));
  const a = await start({}, { home });
  let sid;
  try {
    const ev = await a.events();
    const r = (await a.api('POST', '/api/inject', { conversation: 'keep', message: 'scenario:tools' })).body;
    sid = (await ev.until(done(r.run_id))).session_id;
  } finally { await a.stop(); }
  assert.equal((fs.statSync(path.join(home, 'sessions.json')).mode & 0o777), 0o600);
  const b = await start({}, { home });
  try {
    const ev = await b.events('keep');
    const r = (await b.api('POST', '/api/inject', { conversation: 'keep', message: 'scenario:resume' })).body;
    assert.equal(r.resumed, true);
    await ev.until(done(r.run_id));
    const call = b.argv().at(-1);
    assert.equal(call[call.indexOf('--resume') + 1], sid);
  } finally { await b.stop(); }
});

test('without partial output the whole-text lines are streamed', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'plain', message: 'scenario:plain' })).body;
    await ev.until(done(r.run_id));
    const complete = ev.ofRun(r.run_id).find((e) => e.type === 'response_complete');
    assert.equal(complete.text, 'First part. Second part.');
  } finally { await b.stop(); }
});

test('a CLI error on stderr is surfaced, never an empty answer', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'err', message: 'scenario:bad-model' })).body;
    const end = await ev.until(done(r.run_id));
    assert.equal(end.ok, false);
    assert.equal(end.exit_code, 1);
    assert.match(end.error, /Cannot use this model/);
    const complete = ev.ofRun(r.run_id).find((e) => e.type === 'response_complete');
    assert.match(complete.text, /Cannot use this model/);
  } finally { await b.stop(); }
});

test('exit 0 without a result is a failure, not a success', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'silent', message: 'scenario:silent' })).body;
    const end = await ev.until(done(r.run_id));
    assert.equal(end.exit_code, 0);
    assert.equal(end.ok, false);
    assert.match(end.error, /without a result/);
  } finally { await b.stop(); }
});

test('an is_error result fails the run even with exit 0', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'refused', message: 'scenario:is-error' })).body;
    const end = await ev.until(done(r.run_id));
    assert.equal(end.ok, false);
    assert.equal(end.error, 'The model refused the request.');
  } finally { await b.stop(); }
});

test('a missing CLI ends the run with 127 and the bridge stays up', async () => {
  const b = await start({ CURSOR_AGENT_BIN: '/nonexistent/cursor-agent' });
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'nocli', message: 'hello' })).body;
    const end = await ev.until(done(r.run_id));
    assert.equal(end.exit_code, 127);
    assert.match(end.error, /cannot start \/nonexistent\/cursor-agent: ENOENT/);
    assert.equal(ev.ofRun(r.run_id).filter((e) => e.type === 'run_complete').length, 1, 'concluded once');
    assert.equal(b.bridge.metrics.spawn_errors, 1);
    const status = (await b.api('GET', '/api/status')).body;
    assert.equal(status.ready, false);
  } finally { await b.stop(); }
});

test('stop ends the run and the tools it started', async () => {
  const b = await start();
  const pidFile = path.join(b.dir, 'child.pid');
  process.env.FAKE_CHILD_PID = pidFile;
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'slow', message: 'scenario:slow' })).body;
    await ev.until((e) => e.run_id === r.run_id && e.seq === 1);
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((res) => setTimeout(res, 50));
    const child = Number(fs.readFileSync(pidFile, 'utf8'));
    const stopped = (await b.api('POST', '/api/conversations/stop', { conversation: 'slow' })).body;
    assert.deepEqual(stopped.stopped, ['slow']);
    const end = await ev.until(done(r.run_id));
    assert.equal(end.type, 'run_aborted');
    assert.equal(end.reason, 'stopped');
    await new Promise((res) => setTimeout(res, 200));
    assert.throws(() => process.kill(child, 0), 'the grandchild process is gone too');
  } finally {
    delete process.env.FAKE_CHILD_PID;
    await b.stop();
  }
});

test('a new message replaces a live run without touching the new one', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const old = (await b.api('POST', '/api/inject', { conversation: 'busy', message: 'scenario:slow' })).body;
    await ev.until((e) => e.run_id === old.run_id && e.seq === 1);
    const next = (await b.api('POST', '/api/inject', { conversation: 'busy', message: 'scenario:tools' })).body;
    const oldEnd = await ev.until(done(old.run_id));
    const nextEnd = await ev.until(done(next.run_id));
    assert.equal(oldEnd.type, 'run_aborted');
    assert.equal(oldEnd.reason, 'replaced');
    assert.equal(nextEnd.type, 'run_complete');
    assert.equal(nextEnd.ok, true);
    assert.equal(ev.ofRun(next.run_id).some((e) => e.type === 'run_aborted'), false);
  } finally { await b.stop(); }
});

test('a run that exceeds the timeout is aborted', async () => {
  const b = await start({ CURSOR_BRIDGE_RUN_TIMEOUT_MS: '300' });
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'long', message: 'scenario:slow' })).body;
    const end = await ev.until(done(r.run_id));
    assert.equal(end.reason, 'timeout');
  } finally { await b.stop(); }
});

test('stop all stops every live run', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const x = (await b.api('POST', '/api/inject', { conversation: 'x', message: 'scenario:slow' })).body;
    const y = (await b.api('POST', '/api/inject', { conversation: 'y', message: 'scenario:slow' })).body;
    const { body } = await b.api('POST', '/api/conversations/stop', { all: true });
    assert.deepEqual(body.stopped.sort(), ['x', 'y']);
    await ev.until(done(x.run_id));
    await ev.until(done(y.run_id));
  } finally { await b.stop(); }
});

test('reset starts the next turn in a fresh session; delete forgets the conversation', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'r', message: 'scenario:tools' })).body;
    await ev.until(done(r.run_id));
    assert.equal((await b.api('POST', '/api/conversations/reset', { conversation: 'r' })).body.reset, true);
    const again = (await b.api('POST', '/api/inject', { conversation: 'r', message: 'scenario:tools' })).body;
    assert.equal(again.resumed, false);
    await ev.until(done(again.run_id));
    assert.equal(b.argv().at(-1).includes('--resume'), false);
    assert.equal((await b.api('POST', '/api/conversations/delete', { conversation: 'r' })).body.deleted, true);
    assert.deepEqual((await b.api('GET', '/api/conversations')).body.conversations, []);
  } finally { await b.stop(); }
});

test('events can be filtered by conversation', async () => {
  const b = await start();
  try {
    const onlyA = await b.events('A');
    const all = await b.events();
    const rb = (await b.api('POST', '/api/inject', { conversation: 'B', message: 'scenario:tools' })).body;
    const ra = (await b.api('POST', '/api/inject', { conversation: 'A', message: 'scenario:tools' })).body;
    await all.until(done(rb.run_id));
    await onlyA.until(done(ra.run_id));
    assert.equal(onlyA.list.some((e) => e.conversation === 'B'), false);
  } finally { await b.stop(); }
});

test('input is validated before anything is spawned', async () => {
  const b = await start();
  try {
    const bad = async (body, status, code) => {
      const r = await b.api('POST', '/api/inject', body);
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.equal(r.body.code, code);
    };
    await bad({ conversation: '../etc', message: 'x' }, 400, 'INVALID_CONVERSATION');
    await bad({ conversation: '', message: 'x' }, 400, 'INVALID_CONVERSATION');
    await bad({ conversation: 'a', message: '   ' }, 400, 'EMPTY_MESSAGE');
    await bad({ conversation: 'a', message: 'x', mode: 'yolo' }, 400, 'INVALID_MODE');
    await bad({ conversation: 'a', message: 'x', model: '--force' }, 400, 'INVALID_MODEL');
    await bad({ conversation: 'a', message: 'x', workspace: 'relative/dir' }, 400, 'INVALID_WORKSPACE');
    await bad({ conversation: 'a', message: 'x', workspace: '/definitely/not/here' }, 400, 'INVALID_WORKSPACE');
    await bad({ conversation: 'a', message: 'x', workspace: os.homedir() }, 403, 'WORKSPACE_OUTSIDE_ROOTS');
    await bad({ conversation: 'a', message: 'x'.repeat(100_001) }, 413, 'MESSAGE_TOO_LARGE');
    const raw = await fetch(`${b.base}/api/inject`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{nope' });
    assert.equal(raw.status, 400);
    assert.equal(b.argv().length, 0, 'nothing was spawned');
  } finally { await b.stop(); }
});

test('a symlink cannot lead a workspace outside the allowed roots', async () => {
  const b = await start();
  try {
    const link = path.join(b.config.workspaceRoot, 'escape');
    fs.symlinkSync(os.homedir(), link);
    const r = await b.api('POST', '/api/inject', { conversation: 'a', message: 'x', workspace: link });
    assert.equal(r.status, 403);
  } finally { await b.stop(); }
});

test('the CLI receives the message after --, with the chosen flags', async () => {
  const b = await start({ CURSOR_BRIDGE_APPROVAL: 'force', CURSOR_BRIDGE_SANDBOX: 'enabled' });
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'flags', message: '--version scenario:plain', mode: 'ask', model: 'other-model' })).body;
    await ev.until(done(r.run_id));
    const call = b.argv()[0];
    const sep = call.indexOf('--');
    assert.equal(call[sep + 1], '--version scenario:plain');
    for (const flag of ['-p', '--trust', '--stream-partial-output', '--force']) assert.ok(call.includes(flag), flag);
    assert.equal(call[call.indexOf('--model') + 1], 'other-model');
    assert.equal(call[call.indexOf('--mode') + 1], 'ask');
    assert.equal(call[call.indexOf('--sandbox') + 1], 'enabled');
    assert.equal(call[call.indexOf('--workspace') + 1], r.workspace);
  } finally { await b.stop(); }
});

test('by default the CLI permission config decides: no --force', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'safe', message: 'scenario:plain' })).body;
    await ev.until(done(r.run_id));
    assert.equal(b.argv()[0].includes('--force'), false);
    assert.equal(b.argv()[0].includes('--sandbox'), false);
  } finally { await b.stop(); }
});

test('moving a conversation to another workspace starts a new session', async () => {
  const b = await start({}, {});
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'mv', message: 'scenario:tools' })).body;
    await ev.until(done(r.run_id));
    const other = path.join(b.config.workspaceRoot, 'elsewhere');
    fs.mkdirSync(other);
    const moved = (await b.api('POST', '/api/inject', { conversation: 'mv', message: 'scenario:tools', workspace: other })).body;
    assert.equal(moved.session_reset, true);
    assert.equal(moved.resumed, false);
    await ev.until(done(moved.run_id));
  } finally { await b.stop(); }
});

test('the bridge refuses to start without a model, naming the variable', () => {
  assert.throws(() => loadConfig({}), /CURSOR_MODEL is not set/);
  assert.throws(() => loadConfig({ CURSOR_MODEL: 'm', CURSOR_BRIDGE_APPROVAL: 'yolo' }), /CURSOR_BRIDGE_APPROVAL/);
  assert.throws(() => loadConfig({ CURSOR_MODEL: 'm', CURSOR_BRIDGE_PORT: 'abc' }), /CURSOR_BRIDGE_PORT/);
});
