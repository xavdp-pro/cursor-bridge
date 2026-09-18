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
import { CursorBridge, REPLACE_NOTE, WITHDRAW_NOTE } from '../src/bridge.mjs';
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
    assert.equal(body.capabilities.attachments, true);
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
  const ws = { CURSOR_BRIDGE_WORKSPACE_ROOT: path.join(home, 'ws') };
  const a = await start(ws, { home });
  let sid;
  try {
    const ev = await a.events();
    const r = (await a.api('POST', '/api/inject', { conversation: 'keep', message: 'scenario:tools' })).body;
    sid = (await ev.until(done(r.run_id))).session_id;
  } finally { await a.stop(); }
  assert.equal((fs.statSync(path.join(home, 'sessions.json')).mode & 0o777), 0o600);
  const b = await start(ws, { home });
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
  const b = await start({ CURSOR_BRIDGE_APPROVAL: 'force', CURSOR_BRIDGE_SANDBOX: 'enabled', CURSOR_BRIDGE_APPROVE_MCPS: '1' });
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'flags', message: '--version scenario:plain', mode: 'ask', model: 'other-model' })).body;
    await ev.until(done(r.run_id));
    const call = b.argv()[0];
    const sep = call.indexOf('--');
    assert.equal(call[sep + 1], '--version scenario:plain');
    for (const flag of ['-p', '--trust', '--approve-mcps', '--stream-partial-output', '--force']) assert.ok(call.includes(flag), flag);
    assert.equal(call[call.indexOf('--model') + 1], 'other-model');
    assert.equal(call[call.indexOf('--mode') + 1], 'ask');
    assert.equal(call[call.indexOf('--sandbox') + 1], 'enabled');
    assert.equal(call[call.indexOf('--workspace') + 1], r.workspace);
  } finally { await b.stop(); }
});

test('by default the bridge runs free for web use: --trust and --approve-mcps always, no --force', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'safe', message: 'scenario:plain' })).body;
    await ev.until(done(r.run_id));
    assert.equal(b.argv()[0].includes('--force'), false);
    assert.equal(b.argv()[0].includes('--sandbox'), false);
    assert.ok(b.argv()[0].includes('--trust'), '--trust is always passed');
    assert.ok(b.argv()[0].includes('--approve-mcps'), '--approve-mcps is on by default');
  } finally { await b.stop(); }
});

test('CURSOR_BRIDGE_APPROVE_MCPS=0 stops approving MCP servers', async () => {
  const b = await start({ CURSOR_BRIDGE_APPROVE_MCPS: '0' });
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'no-mcp', message: 'scenario:plain' })).body;
    await ev.until(done(r.run_id));
    assert.equal(b.argv()[0].includes('--approve-mcps'), false);
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

const promptOf = (call) => call[call.indexOf('--') + 1];

test('the initial context frames the first turn, and is not repeated on a resumed turn', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const first = (await b.api('POST', '/api/inject', {
      conversation: 'ctx', context: 'You are the release assistant.', message: 'scenario:tools',
    })).body;
    assert.equal(first.context_applied, true);
    await ev.until(done(first.run_id));
    assert.equal(promptOf(b.argv()[0]), '[INSTRUCTIONS]\nYou are the release assistant.\n\n[USER REQUEST]\nscenario:tools');
    const second = (await b.api('POST', '/api/inject', { conversation: 'ctx', message: 'scenario:resume' })).body;
    assert.equal(second.resumed, true);
    assert.equal(second.context_applied, false);
    await ev.until(done(second.run_id));
    assert.equal(promptOf(b.argv()[1]), 'scenario:resume');
    const inject = ev.ofRun(first.run_id)[0];
    assert.equal(inject.context_applied, true);
  } finally { await b.stop(); }
});

test('create registers the context before any message; a reset sends it again', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const created = (await b.api('POST', '/api/conversations/create', { conversation: 'boot', context: 'Answer in English.' })).body;
    assert.equal(created.created, true);
    assert.equal(created.has_context, true);
    assert.equal(b.argv().length, 0, 'create runs nothing');
    const again = (await b.api('POST', '/api/conversations/create', { conversation: 'boot' })).body;
    assert.equal(again.created, false);
    assert.equal(again.has_context, true, 'a create without context keeps the one set before');

    const t1 = (await b.api('POST', '/api/inject', { conversation: 'boot', message: 'scenario:tools' })).body;
    await ev.until(done(t1.run_id));
    assert.match(promptOf(b.argv()[0]), /^\[INSTRUCTIONS\]\nAnswer in English\./);

    await b.api('POST', '/api/conversations/reset', { conversation: 'boot' });
    const t2 = (await b.api('POST', '/api/inject', { conversation: 'boot', message: 'scenario:tools' })).body;
    assert.equal(t2.resumed, false);
    assert.equal(t2.context_applied, true, 'a new session gets the context again');
    await ev.until(done(t2.run_id));
    assert.match(promptOf(b.argv()[1]), /^\[INSTRUCTIONS\]\nAnswer in English\./);
  } finally { await b.stop(); }
});

test('a new context on a later turn replaces the old one; an empty one removes it', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const t1 = (await b.api('POST', '/api/inject', { conversation: 'swap', context: 'Old rules.', message: 'scenario:tools' })).body;
    await ev.until(done(t1.run_id));
    const t2 = (await b.api('POST', '/api/inject', { conversation: 'swap', context: 'New rules.', message: 'scenario:resume' })).body;
    assert.equal(t2.resumed, true);
    assert.equal(t2.context_applied, true);
    await ev.until(done(t2.run_id));
    assert.equal(promptOf(b.argv()[1]), `[INSTRUCTIONS]\n${REPLACE_NOTE}\n\nNew rules.\n\n[USER REQUEST]\nscenario:resume`);
    await b.api('POST', '/api/conversations/create', { conversation: 'swap', context: '' });
    await b.api('POST', '/api/conversations/reset', { conversation: 'swap' });
    const t3 = (await b.api('POST', '/api/inject', { conversation: 'swap', message: 'scenario:tools' })).body;
    assert.equal(t3.context_applied, false);
    await ev.until(done(t3.run_id));
    assert.equal(promptOf(b.argv()[2]), 'scenario:tools');
  } finally { await b.stop(); }
});

test('context must be inline text', async () => {
  const b = await start();
  try {
    const file = await b.api('POST', '/api/inject', { conversation: 'c', message: 'x', context_file: '/etc/hostname' });
    assert.equal(file.status, 400);
    assert.equal(file.body.code, 'INVALID_CONTEXT');
    const obj = await b.api('POST', '/api/conversations/create', { conversation: 'c', context: { a: 1 } });
    assert.equal(obj.status, 400);
    const big = await b.api('POST', '/api/inject', { conversation: 'c', message: 'x', context: 'y'.repeat(100_000) });
    assert.equal(big.status, 413);
    assert.equal(b.argv().length, 0);
  } finally { await b.stop(); }
});

test('the bridge refuses to start without a model, naming the variable', () => {
  assert.throws(() => loadConfig({}), /CURSOR_MODEL is not set/);
  assert.throws(() => loadConfig({ CURSOR_MODEL: 'm', CURSOR_BRIDGE_APPROVAL: 'yolo' }), /CURSOR_BRIDGE_APPROVAL/);
  assert.throws(() => loadConfig({ CURSOR_MODEL: 'm', CURSOR_BRIDGE_PORT: 'abc' }), /CURSOR_BRIDGE_PORT/);
});

test('conversations also come in the helm registered shape', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'helm', message: 'scenario:tools' })).body;
    assert.equal(r.chat_id, null, 'no session yet on the first turn');
    assert.equal(r.composer_id, null);
    await ev.until(done(r.run_id));
    const { body } = await b.api('GET', '/api/conversations');
    assert.ok(Array.isArray(body.registered), 'helm reads data.registered');
    assert.equal(body.registered.length, 1);
    const c = body.registered[0];
    assert.equal(c.name, 'helm');
    assert.equal(c.title, 'helm');
    assert.equal(c.chat_id.length, 36);
    assert.equal(c.resumed, true);
    assert.equal(c.cwd, r.workspace);
    assert.equal(c.workspace, r.workspace);
    const again = (await b.api('POST', '/api/inject', { conversation: 'helm', message: 'scenario:resume' })).body;
    assert.equal(again.chat_id, c.chat_id, 'the resumed session is exposed as chat_id/composer_id');
    assert.equal(again.composer_id, c.chat_id);
    await ev.until(done(again.run_id));
  } finally { await b.stop(); }
});

test('workspace binds a directory without running; a move starts a new session', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const target = path.join(b.config.workspaceRoot, 'picked');
    fs.mkdirSync(target);
    const bound = (await b.api('POST', '/api/conversations/workspace', { conversation: 'w', workspace: target })).body;
    assert.equal(bound.ok, true);
    assert.equal(bound.workspace, target);
    assert.equal(bound.cwd, target);
    assert.equal(bound.session_reset, false);
    assert.equal(b.argv().length, 0, 'binding runs nothing');
    const r = (await b.api('POST', '/api/inject', { conversation: 'w', message: 'scenario:tools' })).body;
    assert.equal(r.workspace, target);
    await ev.until(done(r.run_id));
    const other = path.join(b.config.workspaceRoot, 'picked-elsewhere');
    fs.mkdirSync(other);
    const moved = (await b.api('POST', '/api/conversations/workspace', { conversation: 'w', workspace: other })).body;
    assert.equal(moved.session_reset, true);
    assert.equal(moved.workspace, other);
    const next = (await b.api('POST', '/api/inject', { conversation: 'w', message: 'scenario:tools' })).body;
    assert.equal(next.resumed, false);
    await ev.until(done(next.run_id));
  } finally { await b.stop(); }
});

test('workspace binding is validated like an inject workspace', async () => {
  const b = await start();
  try {
    const missing = await b.api('POST', '/api/conversations/workspace', { conversation: 'w' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'INVALID_WORKSPACE');
    const nope = await b.api('POST', '/api/conversations/workspace', { conversation: 'w', workspace: '/definitely/not/here' });
    assert.equal(nope.status, 400);
    const outside = await b.api('POST', '/api/conversations/workspace', { conversation: 'w', workspace: os.homedir() });
    assert.equal(outside.status, 403);
    assert.equal(b.argv().length, 0);
  } finally { await b.stop(); }
});

test('fs/list shows subdirectories for a workspace picker', async () => {
  const b = await start();
  try {
    const sub = path.join(b.config.workspaceRoot, 'proj');
    fs.mkdirSync(path.join(sub, 'app'), { recursive: true });
    fs.mkdirSync(path.join(sub, '.hidden'));
    fs.writeFileSync(path.join(sub, 'note.txt'), 'x');
    const { status, body } = await b.api('GET', `/api/fs/list?path=${encodeURIComponent(sub)}`);
    assert.equal(status, 200);
    assert.deepEqual(body.entries, [{ name: 'app', path: `${sub}/app`, dir: true }]);
    assert.equal((await b.api('GET', '/api/fs/list?path=relative')).status, 400);
    assert.equal((await b.api('GET', `/api/fs/list?path=${encodeURIComponent(path.join(sub, 'missing'))}`)).status, 404);
    assert.equal((await b.api('GET', '/api/fs/list?path=/definitely/not/here')).status, 403, 'outside the roots, existing or not');
    assert.equal((await b.api('GET', `/api/fs/list?path=${encodeURIComponent(path.join(sub, 'note.txt'))}`)).status, 400);
  } finally { await b.stop(); }
});

test('upload stores base64 in _attachments without overwriting', async () => {
  const b = await start();
  try {
    const data = Buffer.from('hello attachment').toString('base64');
    const first = (await b.api('POST', '/api/upload', { conversation: 'up', filename: '../../evil.txt', data })).body;
    assert.equal(first.ok, true);
    assert.equal(first.filename, '.._.._evil.txt');
    assert.equal(first.rel, path.join('_attachments', '.._.._evil.txt'));
    assert.equal(fs.readFileSync(first.abs, 'utf8'), 'hello attachment');
    assert.equal((fs.statSync(first.abs).mode & 0o777) & 0o077, 0, 'no group/other access');
    const second = (await b.api('POST', '/api/upload', { conversation: 'up', filename: '../../evil.txt', data })).body;
    assert.equal(second.filename, '.._.._evil-1.txt');
    const bad = await b.api('POST', '/api/upload', { conversation: 'up', filename: 'x.txt' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_ATTACHMENT');
    const empty = await b.api('POST', '/api/upload', { conversation: 'up', filename: '', data });
    assert.equal(empty.status, 400);
  } finally { await b.stop(); }
});

test('inject resolves attachments against the workspace and names them in the prompt', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const dir = path.join(b.config.workspaceRoot, 'shot');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'plan.md'), '# plan');
    const r = (await b.api('POST', '/api/inject', {
      conversation: 'shot', workspace: dir, message: 'scenario:plain', attachments: ['plan.md'],
    })).body;
    await ev.until(done(r.run_id));
    const prompt = promptOf(b.argv()[0]);
    assert.match(prompt, /^scenario:plain\n\nAttachments \(paths relative to the working directory unless absolute\):\n- plan\.md$/);
    const end = ev.ofRun(r.run_id).at(-1);
    assert.equal(end.ok, true);
  } finally { await b.stop(); }
});

test('an empty message with attachments still runs; bad attachments are refused', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const dir = path.join(b.config.workspaceRoot, 'img');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.png'), 'png');
    const r = (await b.api('POST', '/api/inject', { conversation: 'img', workspace: dir, message: '  ', attachments: ['a.png'] })).body;
    await ev.until(done(r.run_id));
    assert.match(promptOf(b.argv()[0]), /^- a\.png$/m);
    const bad = async (attachments, status, code) => {
      const res = await b.api('POST', '/api/inject', { conversation: 'img', message: 'x', attachments });
      assert.equal(res.status, status, JSON.stringify(res.body));
      assert.equal(res.body.code, code);
    };
    await bad('nope.png', 400, 'INVALID_ATTACHMENT');
    await bad(['missing.png'], 400, 'INVALID_ATTACHMENT');
    const outside = path.join(os.tmpdir(), `cursor-bridge-outside-${process.pid}.txt`);
    fs.writeFileSync(outside, 'x');
    try {
      await bad([outside], 403, 'WORKSPACE_OUTSIDE_ROOTS');
    } finally { fs.rmSync(outside, { force: true }); }
    await bad({ conversation: 'img', message: 'x' }, 400, 'INVALID_ATTACHMENT');
    const viaCreate = await b.api('POST', '/api/conversations/create', { conversation: 'img', attachments: ['a.png'] });
    assert.equal(viaCreate.status, 400);
    assert.equal(viaCreate.body.code, 'INVALID_ATTACHMENT');
  } finally { await b.stop(); }
});

// ------------------------------------------------ counter-review regressions
// P1-P13 from operator-deliverables/cursor-bridge-counter-review-2026-09-18.md,
// each asserting the fixed behaviour.

const NUL = String.fromCharCode(0);
const terminals = (list) => list.filter((e) => e.type === 'run_complete' || e.type === 'run_aborted');
const contiguous = (list) => list.every((e, i) => e.seq === i + 1);
const waitPid = async (file) => {
  for (let i = 0; i < 60 && !fs.existsSync(file); i++) await new Promise((res) => setTimeout(res, 50));
  return Number(fs.readFileSync(file, 'utf8'));
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('P1 a workspace move during a live run stops it (moved) and its session never comes back', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const t1 = (await b.api('POST', '/api/inject', { conversation: 'mv', context: 'Rules.', message: 'scenario:tools' })).body;
    await ev.until(done(t1.run_id));
    const t2 = (await b.api('POST', '/api/inject', { conversation: 'mv', message: 'scenario:drip' })).body;
    assert.equal(t2.resumed, true);
    await ev.until((e) => e.run_id === t2.run_id && e.seq === 1);
    const other = path.join(b.config.workspaceRoot, 'B');
    fs.mkdirSync(other);
    const moved = (await b.api('POST', '/api/conversations/workspace', { conversation: 'mv', workspace: other })).body;
    assert.equal(moved.session_reset, true);
    assert.equal(moved.run_stopped, true);
    const end = await ev.until(done(t2.run_id));
    assert.equal(end.type, 'run_aborted');
    assert.equal(end.reason, 'moved');
    await new Promise((res) => setTimeout(res, 1000)); // past the drip scenario's late lines
    const run2 = ev.ofRun(t2.run_id);
    assert.equal(terminals(run2).length, 1);
    assert.ok(contiguous(run2));
    const conv = (await b.api('GET', '/api/conversations')).body.conversations[0];
    assert.equal(conv.workspace, other);
    assert.equal(conv.session_id, null, 'the old session is not written back');
    const t3 = (await b.api('POST', '/api/inject', { conversation: 'mv', message: 'scenario:plain' })).body;
    assert.equal(t3.resumed, false);
    assert.equal(t3.context_applied, true, 'a new session gets the context again');
    await ev.until(done(t3.run_id));
    const call = b.argv().at(-1);
    assert.equal(call.includes('--resume'), false);
    assert.equal(call[call.indexOf('--workspace') + 1], other);
  } finally { await b.stop(); }
});

test('P1 a create that moves the workspace also stops the live run', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'cm', message: 'scenario:slow' })).body;
    await ev.until((e) => e.run_id === r.run_id && e.seq === 1);
    const other = path.join(b.config.workspaceRoot, 'cm-elsewhere');
    fs.mkdirSync(other);
    await b.api('POST', '/api/conversations/create', { conversation: 'cm', workspace: other });
    const end = await ev.until(done(r.run_id));
    assert.equal(end.reason, 'moved');
    assert.equal(b.bridge.conversations.cm.session_id, null);
  } finally { await b.stop(); }
});

test('P2 a context replaced through create reaches the resumed session on the next turn, once', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const t1 = (await b.api('POST', '/api/inject', { conversation: 'c', context: 'Old rules.', message: 'scenario:tools' })).body;
    await ev.until(done(t1.run_id));
    const cr = (await b.api('POST', '/api/conversations/create', { conversation: 'c', context: 'New rules.' })).body;
    assert.equal(cr.context_pending, true);
    const t2 = (await b.api('POST', '/api/inject', { conversation: 'c', message: 'scenario:resume' })).body;
    assert.equal(t2.resumed, true);
    assert.equal(t2.context_applied, true);
    await ev.until(done(t2.run_id));
    assert.equal(ev.ofRun(t2.run_id)[0].context_applied, true, 'the inject event says so too');
    assert.equal(promptOf(b.argv()[1]), `[INSTRUCTIONS]\n${REPLACE_NOTE}\n\nNew rules.\n\n[USER REQUEST]\nscenario:resume`);
    const t3 = (await b.api('POST', '/api/inject', { conversation: 'c', message: 'scenario:resume' })).body;
    assert.equal(t3.context_applied, false, 'delivered once, not repeated');
    await ev.until(done(t3.run_id));
    assert.equal(promptOf(b.argv()[2]), 'scenario:resume');
  } finally { await b.stop(); }
});

test('an identical context is no change: not re-framed on a resumed turn', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const t1 = (await b.api('POST', '/api/inject', { conversation: 'same', context: 'Rules.', message: 'scenario:tools' })).body;
    await ev.until(done(t1.run_id));
    const t2 = (await b.api('POST', '/api/inject', { conversation: 'same', context: '  Rules.  ', message: 'scenario:resume' })).body;
    assert.equal(t2.resumed, true);
    assert.equal(t2.context_applied, false);
    await ev.until(done(t2.run_id));
    assert.equal(promptOf(b.argv()[1]), 'scenario:resume');
    assert.equal((await b.api('POST', '/api/conversations/create', { conversation: 'same', context: 'Rules.' })).body.context_pending, false);
  } finally { await b.stop(); }
});

test('the context stays pending until a run that carried it succeeds', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const t1 = (await b.api('POST', '/api/inject', { conversation: 'retry', context: 'Rules.', message: 'scenario:is-error' })).body;
    assert.equal(t1.context_applied, true);
    const end1 = await ev.until(done(t1.run_id));
    assert.equal(end1.ok, false);
    const t2 = (await b.api('POST', '/api/inject', { conversation: 'retry', message: 'scenario:resume' })).body;
    assert.equal(t2.resumed, true, 'the failed run left a session');
    assert.equal(t2.context_applied, true, 'but it never completed with the context, so it goes again');
    await ev.until(done(t2.run_id));
    assert.match(promptOf(b.argv()[1]), /^\[INSTRUCTIONS\]\n/);
    const t3 = (await b.api('POST', '/api/inject', { conversation: 'retry', message: 'scenario:resume' })).body;
    assert.equal(t3.context_applied, false);
    await ev.until(done(t3.run_id));
  } finally { await b.stop(); }
});

test('removing the context tells a resumed session it is withdrawn, once', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const t1 = (await b.api('POST', '/api/inject', { conversation: 'wd', context: 'Speak like a pirate.', message: 'scenario:tools' })).body;
    await ev.until(done(t1.run_id));
    await b.api('POST', '/api/conversations/create', { conversation: 'wd', context: '' });
    const t2 = (await b.api('POST', '/api/inject', { conversation: 'wd', message: 'scenario:resume' })).body;
    assert.equal(t2.context_applied, false);
    assert.equal(t2.context_withdrawn, true);
    await ev.until(done(t2.run_id));
    assert.equal(promptOf(b.argv()[1]), `[INSTRUCTIONS]\n${WITHDRAW_NOTE}\n\n[USER REQUEST]\nscenario:resume`);
    const t3 = (await b.api('POST', '/api/inject', { conversation: 'wd', message: 'scenario:resume' })).body;
    assert.equal(t3.context_withdrawn, false);
    await ev.until(done(t3.run_id));
    assert.equal(promptOf(b.argv()[2]), 'scenario:resume');
  } finally { await b.stop(); }
});

test('the context and its pending state survive a restart', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-home-'));
  const ws = { CURSOR_BRIDGE_WORKSPACE_ROOT: path.join(home, 'ws') };
  const a = await start(ws, { home });
  try {
    const ev = await a.events();
    assert.equal((await a.api('POST', '/api/conversations/create', { conversation: 'k', context: 'Persisted rules.' })).status, 200);
    const r = (await a.api('POST', '/api/inject', { conversation: 'fresh', context: 'First.', message: 'scenario:tools' })).body;
    await ev.until(done(r.run_id));
    await a.api('POST', '/api/conversations/create', { conversation: 'fresh', context: 'Second.' });
  } finally { await a.stop(); }
  const b = await start(ws, { home });
  try {
    const ev = await b.events();
    const k = (await b.api('POST', '/api/inject', { conversation: 'k', message: 'scenario:plain' })).body;
    assert.equal(k.context_applied, true);
    await ev.until(done(k.run_id));
    assert.match(promptOf(b.argv().at(-1)), /^\[INSTRUCTIONS\]\nPersisted rules\./);
    const f = (await b.api('POST', '/api/inject', { conversation: 'fresh', message: 'scenario:resume' })).body;
    assert.equal(f.resumed, true);
    assert.equal(f.context_applied, true, 'the replacement made before the restart is still owed');
    await ev.until(done(f.run_id));
    assert.match(promptOf(b.argv().at(-1)), /Second\./);
  } finally { await b.stop(); }
});

test('P9 a context is refused at create unless it leaves room for the framing and a message', async () => {
  const b = await start({ CURSOR_BRIDGE_MAX_PROMPT_BYTES: '4000' });
  try {
    const limit = b.bridge.contextLimit();
    assert.ok(limit > 0 && limit < 4000);
    const over = await b.api('POST', '/api/conversations/create', { conversation: 'big', context: 'y'.repeat(limit + 1) });
    assert.equal(over.status, 413);
    assert.equal(over.body.code, 'CONTEXT_TOO_LARGE');
    const atLimit = await b.api('POST', '/api/conversations/create', { conversation: 'big', context: 'y'.repeat(limit) });
    assert.equal(atLimit.status, 200);
    const ev = await b.events();
    const r = await b.api('POST', '/api/inject', { conversation: 'big', message: 'scenario:plain' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await ev.until(done(r.body.run_id));
  } finally { await b.stop(); }
});

test('P3 stop kills a tool that ignores SIGTERM once the grace has passed', async () => {
  const b = await start();
  const pidFile = path.join(b.dir, 'child.pid');
  process.env.FAKE_CHILD_PID = pidFile;
  let child;
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'trap', message: 'scenario:trap' })).body;
    await ev.until((e) => e.run_id === r.run_id && e.seq === 1);
    child = await waitPid(pidFile);
    await b.api('POST', '/api/conversations/stop', { conversation: 'trap' });
    const end = await ev.until(done(r.run_id));
    assert.equal(end.reason, 'stopped');
    await new Promise((res) => setTimeout(res, b.config.killGraceMs + 500));
    assert.equal(alive(child), false, 'the SIGTERM-ignoring child is gone');
  } finally {
    delete process.env.FAKE_CHILD_PID;
    if (child && alive(child)) process.kill(child, 'SIGKILL');
    await b.stop();
  }
});

test('P3 shutdown resolves only after the process groups got SIGKILL', async () => {
  const b = await start();
  const pidFile = path.join(b.dir, 'child.pid');
  process.env.FAKE_CHILD_PID = pidFile;
  let child;
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'down', message: 'scenario:trap' })).body;
    await ev.until((e) => e.run_id === r.run_id && e.seq === 1);
    child = await waitPid(pidFile);
    await b.bridge.shutdown();
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(alive(child), false);
  } finally {
    delete process.env.FAKE_CHILD_PID;
    if (child && alive(child)) process.kill(child, 'SIGKILL');
    await b.stop();
  }
});

test('P4 a descendant holding stdout outside the group cannot block the terminal event (stop and timeout)', async () => {
  const b = await start({ CURSOR_BRIDGE_RUN_TIMEOUT_MS: '600' });
  const pidFile = path.join(b.dir, 'child.pid');
  const kids = [];
  process.env.FAKE_CHILD_PID = pidFile;
  try {
    const ev = await b.events();
    const r = (await b.api('POST', '/api/inject', { conversation: 'esc', message: 'scenario:escape' })).body;
    await ev.until((e) => e.run_id === r.run_id && e.seq === 1);
    kids.push(await waitPid(pidFile));
    fs.rmSync(pidFile);
    await b.api('POST', '/api/conversations/stop', { conversation: 'esc' });
    const end = await ev.until(done(r.run_id), 6000);
    assert.equal(end.reason, 'stopped');

    const t = (await b.api('POST', '/api/inject', { conversation: 'esc2', message: 'scenario:escape' })).body;
    kids.push(await waitPid(pidFile));
    const tend = await ev.until(done(t.run_id), 6000);
    assert.equal(tend.reason, 'timeout');
    await new Promise((res) => setTimeout(res, 300));
    for (const id of [r.run_id, t.run_id]) {
      assert.equal(terminals(ev.ofRun(id)).length, 1);
      assert.ok(contiguous(ev.ofRun(id)));
    }
  } finally {
    delete process.env.FAKE_CHILD_PID;
    for (const k of kids) if (alive(k)) process.kill(k, 'SIGKILL');
    await b.stop();
  }
});

test('P5 upload: a file of exactly CURSOR_BRIDGE_MAX_UPLOAD_BYTES passes; larger ones get 413, never a reset', async () => {
  const b = await start();
  try {
    const max = b.config.maxUploadBytes;
    assert.equal(max, 8 * 1024 * 1024);
    const ok = await b.api('POST', '/api/upload', { conversation: 'up', filename: 'eight.bin', data: Buffer.alloc(max, 1).toString('base64') });
    assert.equal(ok.status, 200);
    assert.equal(fs.statSync(ok.body.abs).size, max);
    const one = await b.api('POST', '/api/upload', { conversation: 'up', filename: 'nine.bin', data: Buffer.alloc(max + 1, 1).toString('base64') });
    assert.equal(one.status, 413);
    assert.equal(one.body.code, 'ATTACHMENT_TOO_LARGE');
    const huge = await b.api('POST', '/api/upload', { conversation: 'up', filename: 'huge.bin', data: Buffer.alloc(12 * 1024 * 1024, 1).toString('base64') });
    assert.equal(huge.status, 413);
    assert.equal(huge.body.code, 'BODY_TOO_LARGE');
  } finally { await b.stop(); }
});

test('P12 an oversized JSON body is answered with 413', async () => {
  const b = await start();
  try {
    const r = await b.api('POST', '/api/inject', { conversation: 'x', message: 'z'.repeat(2 * 1024 * 1024) });
    assert.equal(r.status, 413);
    assert.equal(r.body.code, 'BODY_TOO_LARGE');
    assert.equal(b.argv().length, 0);
  } finally { await b.stop(); }
});

test('P6 a stored workspace outside the (narrowed) allowed roots is refused at the next run', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-home-'));
  const wsRoot = path.join(home, 'ws');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-outside-'));
  const a = await start({ CURSOR_BRIDGE_WORKSPACE_ROOT: wsRoot, CURSOR_BRIDGE_ALLOWED_ROOTS: `${wsRoot}:${outside}` }, { home });
  try {
    assert.equal((await a.api('POST', '/api/conversations/workspace', { conversation: 'w', workspace: outside })).status, 200);
  } finally { await a.stop(); }
  const b = await start({ CURSOR_BRIDGE_WORKSPACE_ROOT: wsRoot }, { home });
  try {
    const r = await b.api('POST', '/api/inject', { conversation: 'w', message: 'scenario:plain' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'WORKSPACE_OUTSIDE_ROOTS');
    const up = await b.api('POST', '/api/upload', { conversation: 'w', filename: 'a.txt', data: 'eA==' });
    assert.equal(up.status, 403);
    assert.equal(b.argv().length, 0);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    await b.stop();
  }
});

test('P7 a stored workspace swapped for a symlink, or removed, is refused by name', async () => {
  const b = await start();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-target-'));
  try {
    const proj = path.join(b.config.workspaceRoot, 'proj');
    fs.mkdirSync(proj);
    assert.equal((await b.api('POST', '/api/conversations/workspace', { conversation: 's', workspace: proj })).status, 200);
    fs.rmdirSync(proj);
    fs.symlinkSync(target, proj);
    const swapped = await b.api('POST', '/api/inject', { conversation: 's', message: 'scenario:plain' });
    assert.equal(swapped.status, 409);
    assert.equal(swapped.body.code, 'WORKSPACE_CHANGED');
    fs.rmSync(proj);
    const gone = await b.api('POST', '/api/inject', { conversation: 's', message: 'scenario:plain' });
    assert.equal(gone.status, 409);
    assert.equal(gone.body.code, 'WORKSPACE_MISSING');
    // The default workspace is not a symlink either.
    fs.symlinkSync(target, path.join(b.config.workspaceRoot, 'd'));
    const def = await b.api('POST', '/api/inject', { conversation: 'd', message: 'scenario:plain' });
    assert.equal(def.status, 409);
    assert.equal(def.body.code, 'WORKSPACE_CHANGED');
    assert.equal(b.argv().length, 0);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    await b.stop();
  }
});

test('a deleted default workspace is created again at the next run', async () => {
  const b = await start();
  try {
    const ev = await b.events();
    const r1 = (await b.api('POST', '/api/inject', { conversation: 'again', message: 'scenario:tools' })).body;
    await ev.until(done(r1.run_id));
    fs.rmSync(r1.workspace, { recursive: true });
    const r2 = await b.api('POST', '/api/inject', { conversation: 'again', message: 'scenario:resume' });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.resumed, true);
    await ev.until(done(r2.body.run_id));
    assert.ok(fs.statSync(r1.workspace).isDirectory());
  } finally { await b.stop(); }
});

test('P8 a NUL byte is refused with 400, not reported as a missing CLI', async () => {
  const b = await start();
  try {
    const m = await b.api('POST', '/api/inject', { conversation: 'nul', message: `hello${NUL}world` });
    assert.equal(m.status, 400);
    assert.equal(m.body.code, 'INVALID_MESSAGE');
    const c = await b.api('POST', '/api/conversations/create', { conversation: 'nul', context: `a${NUL}b` });
    assert.equal(c.status, 400);
    assert.equal(c.body.code, 'INVALID_CONTEXT');
    assert.equal(b.bridge.metrics.spawn_errors, 0);
    assert.equal(b.argv().length, 0);
  } finally { await b.stop(); }
});

test('minor 9: a refused inject leaves no directory behind', async () => {
  const b = await start();
  try {
    assert.equal((await b.api('POST', '/api/inject', { conversation: 'ghost', message: '   ' })).status, 400);
    assert.equal((await b.api('POST', '/api/inject', { conversation: 'ghost2', message: 'x'.repeat(100_001) })).status, 413);
    assert.equal(fs.existsSync(path.join(b.config.workspaceRoot, 'ghost')), false);
    assert.equal(fs.existsSync(path.join(b.config.workspaceRoot, 'ghost2')), false);
  } finally { await b.stop(); }
});

test('P10 CURSOR_BRIDGE_ALLOWED_ROOTS=/ admits any directory', async () => {
  const b = await start({ CURSOR_BRIDGE_ALLOWED_ROOTS: '/' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-anywhere-'));
  try {
    const r = await b.api('POST', '/api/conversations/workspace', { conversation: 'root', workspace: dir });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await b.stop();
  }
});

test('P11 fs/list stays inside the allowed roots and accepts names containing ..', async () => {
  const b = await start();
  try {
    const roots = (await b.api('GET', '/api/fs/list')).body;
    assert.deepEqual(roots.roots, [fs.realpathSync(b.config.workspaceRoot)]);
    assert.equal(roots.entries.length, 1);
    assert.equal((await b.api('GET', '/api/fs/list?path=/etc')).status, 403);
    const dots = path.join(b.config.workspaceRoot, 'a..b');
    fs.mkdirSync(path.join(dots, 'inner'), { recursive: true });
    const d = await b.api('GET', `/api/fs/list?path=${encodeURIComponent(dots)}`);
    assert.equal(d.status, 200);
    assert.deepEqual(d.body.entries.map((e) => e.name), ['inner']);
    const up = await b.api('GET', `/api/fs/list?path=${encodeURIComponent(`${b.config.workspaceRoot}/../..`)}`);
    assert.equal(up.status, 403, '.. segments cannot climb out');
    const link = path.join(b.config.workspaceRoot, 'to-etc');
    fs.symlinkSync('/etc', link);
    assert.equal((await b.api('GET', `/api/fs/list?path=${encodeURIComponent(link)}`)).status, 403);
  } finally { await b.stop(); }
});

test('P13 upload never writes through a symlink planted in _attachments', async () => {
  const b = await start();
  const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-victim-'));
  try {
    const outsideFile = path.join(victimDir, 'planted.txt');
    const ws = path.join(b.config.workspaceRoot, 'up');
    fs.mkdirSync(path.join(ws, '_attachments'), { recursive: true });
    fs.symlinkSync(outsideFile, path.join(ws, '_attachments', 'note.txt'));
    const r = await b.api('POST', '/api/upload', { conversation: 'up', filename: 'note.txt', data: Buffer.from('owned').toString('base64') });
    assert.equal(r.status, 200);
    assert.equal(r.body.filename, 'note-1.txt');
    assert.equal(fs.existsSync(outsideFile), false);
    const ws2 = path.join(b.config.workspaceRoot, 'up2');
    fs.mkdirSync(ws2);
    fs.symlinkSync(victimDir, path.join(ws2, '_attachments'));
    const r2 = await b.api('POST', '/api/upload', { conversation: 'up2', filename: 'x.txt', data: 'eA==' });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.code, 'ATTACHMENTS_DIR_INVALID');
    assert.deepEqual(fs.readdirSync(victimDir), []);
  } finally {
    fs.rmSync(victimDir, { recursive: true, force: true });
    await b.stop();
  }
});

test('configuration: force runs without the sandbox, --approve-mcps is on by default, the prompt limit has a ceiling', async () => {
  // Operator decision: the helm-v2 web interface requires force without the
  // sandbox, so startup must not refuse it.
  assert.equal(loadConfig({ CURSOR_MODEL: 'm', CURSOR_BRIDGE_APPROVAL: 'force' }).approval, 'force');
  assert.equal(loadConfig({ CURSOR_MODEL: 'm', CURSOR_BRIDGE_APPROVAL: 'force', CURSOR_BRIDGE_SANDBOX: 'disabled' }).sandbox, 'disabled');
  assert.equal(loadConfig({ CURSOR_MODEL: 'm' }).approveMcps, true);
  assert.equal(loadConfig({ CURSOR_MODEL: 'm', CURSOR_BRIDGE_APPROVE_MCPS: '0' }).approveMcps, false);
  assert.throws(() => loadConfig({ CURSOR_MODEL: 'm', CURSOR_BRIDGE_APPROVE_MCPS: 'yes' }), /CURSOR_BRIDGE_APPROVE_MCPS/);
  assert.throws(() => loadConfig({ CURSOR_MODEL: 'm', CURSOR_BRIDGE_MAX_PROMPT_BYTES: '200000' }), /at most 131071/);
  const b = await start();
  try {
    assert.equal((await b.api('GET', '/api/status')).body.approve_mcps, true);
  } finally { await b.stop(); }
});
