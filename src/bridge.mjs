import { spawn as nodeSpawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createTranslator } from './translate.mjs';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:,=\[\]-]{0,127}$/;
export const MODES = ['ask', 'plan'];
const STDERR_TAIL_BYTES = 8192;

export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Runs cursor-agent, one process per turn, and keeps each conversation's
 * session id so that the next turn resumes it (`--resume`).
 *
 * One conversation has at most one live run. A new message while a run is
 * live replaces it: the old run ends with `run_aborted { reason: 'replaced' }`
 * and never touches the new one.
 */
export class CursorBridge {
  constructor(config, { spawn = nodeSpawn, now = Date.now } = {}) {
    this.config = config;
    this.spawn = spawn;
    this.now = now;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(0);
    this.runs = new Map(); // conversation -> live run
    this.metrics = {
      started_at: now(),
      runs_started: 0,
      runs_ok: 0,
      runs_failed: 0,
      runs_aborted: 0,
      spawn_errors: 0,
      last_run_ms: null,
      total_run_ms: 0,
    };
    this.readinessCache = null;
    fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.workspaceRoot, { recursive: true });
    this.conversations = this.loadSessions();
  }

  // ---------------------------------------------------------------- events

  subscribe(conversation, listener) {
    const handler = (ev) => {
      if (!conversation || ev.conversation === conversation) listener(ev);
    };
    this.bus.on('event', handler);
    return () => this.bus.off('event', handler);
  }

  emitRun(run, ev) {
    run.seq += 1;
    this.bus.emit('event', {
      ...ev,
      conversation: run.conversation,
      run_id: run.runId,
      seq: run.seq,
      ts: this.now(),
    });
  }

  // ------------------------------------------------------------ sessions

  loadSessions() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.sessionsFile, 'utf8'));
      return raw && typeof raw.conversations === 'object' ? raw.conversations : {};
    } catch {
      return {};
    }
  }

  saveSessions() {
    const file = this.config.sessionsFile;
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, conversations: this.conversations }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  listConversations() {
    return Object.values(this.conversations).map((c) => ({
      ...c,
      running: this.runs.has(c.name),
      run_id: this.runs.get(c.name)?.runId || null,
    }));
  }

  // ----------------------------------------------------------- validation

  checkName(raw) {
    const name = String(raw ?? '').trim();
    if (!NAME_RE.test(name)) {
      throw new BridgeError(400, 'INVALID_CONVERSATION',
        'conversation must be 1-64 characters: letters, digits, dot, dash, underscore, starting with a letter or digit');
    }
    return name;
  }

  resolveWorkspace(name, requested) {
    if (!requested) {
      const dir = path.join(this.config.workspaceRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      return fs.realpathSync(dir);
    }
    const asked = String(requested);
    if (!path.isAbsolute(asked)) throw new BridgeError(400, 'INVALID_WORKSPACE', 'workspace must be an absolute path');
    let real;
    try {
      real = fs.realpathSync(asked);
    } catch {
      throw new BridgeError(400, 'INVALID_WORKSPACE', `workspace does not exist on this host: ${asked}`);
    }
    if (!fs.statSync(real).isDirectory()) throw new BridgeError(400, 'INVALID_WORKSPACE', `workspace is not a directory: ${asked}`);
    const inside = this.config.allowedRoots.some((root) => {
      let r;
      try { r = fs.realpathSync(root); } catch { return false; }
      return real === r || real.startsWith(r + path.sep);
    });
    if (!inside) {
      throw new BridgeError(403, 'WORKSPACE_OUTSIDE_ROOTS',
        `workspace ${asked} is outside the allowed roots (CURSOR_BRIDGE_ALLOWED_ROOTS)`);
    }
    return real;
  }

  // ----------------------------------------------------------------- runs

  inject(body = {}) {
    const name = this.checkName(body.conversation);
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) throw new BridgeError(400, 'EMPTY_MESSAGE', 'message is empty');
    if (Buffer.byteLength(message, 'utf8') > this.config.maxPromptBytes) {
      throw new BridgeError(413, 'MESSAGE_TOO_LARGE', `message exceeds ${this.config.maxPromptBytes} bytes`);
    }
    let requestedModel = null;
    if (body.model != null && body.model !== '') {
      requestedModel = String(body.model).trim();
      if (!MODEL_RE.test(requestedModel)) throw new BridgeError(400, 'INVALID_MODEL', 'model is not a valid model id');
    }
    let mode = null;
    if (body.mode != null && body.mode !== '') {
      mode = String(body.mode);
      if (!MODES.includes(mode)) throw new BridgeError(400, 'INVALID_MODE', `mode must be one of ${MODES.join(', ')}`);
    }

    const existing = this.conversations[name];
    let workspace;
    if (body.workspace) {
      workspace = this.resolveWorkspace(name, body.workspace);
    } else if (existing?.workspace && fs.existsSync(existing.workspace)) {
      workspace = existing.workspace;
    } else {
      workspace = this.resolveWorkspace(name);
    }

    // A cursor-agent session belongs to the workspace it was opened in.
    let sessionId = existing?.session_id || null;
    let sessionReset = false;
    if (existing && existing.workspace && existing.workspace !== workspace && sessionId) {
      sessionId = null;
      sessionReset = true;
    }

    if (this.runs.has(name)) this.abortRun(this.runs.get(name), 'replaced');

    const nowIso = new Date(this.now()).toISOString();
    const entry = {
      name,
      session_id: sessionId,
      workspace,
      model: requestedModel || existing?.model || null,
      created_at: existing?.created_at || nowIso,
      updated_at: nowIso,
      last_run_id: null,
    };
    const model = entry.model || this.config.model;

    const run = {
      runId: crypto.randomUUID(),
      conversation: name,
      seq: 0,
      translator: createTranslator(),
      stdoutBuffer: '',
      stderr: '',
      startedAt: this.now(),
      abortReason: null,
      concluded: false,
      proc: null,
      timers: [],
    };
    entry.last_run_id = run.runId;
    this.conversations[name] = entry;
    this.saveSessions();
    this.runs.set(name, run);
    this.metrics.runs_started += 1;

    this.emitRun(run, { type: 'inject', ok: true, model, mode, resumed: Boolean(sessionId), session_reset: sessionReset });
    this.startProcess(run, { message, model, mode, sessionId, workspace });

    return {
      run_id: run.runId,
      conversation: name,
      model,
      mode,
      workspace,
      resumed: Boolean(sessionId),
      session_reset: sessionReset,
    };
  }

  buildArgs({ message, model, mode, sessionId, workspace }) {
    const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust',
      '--workspace', workspace, '--model', model];
    if (mode) args.push('--mode', mode);
    if (this.config.approval === 'force') args.push('--force');
    if (this.config.sandbox) args.push('--sandbox', this.config.sandbox);
    if (sessionId) args.push('--resume', sessionId);
    // `--` so that a message starting with a dash is never read as a flag.
    args.push('--', message);
    return args;
  }

  startProcess(run, opts) {
    const args = this.buildArgs(opts);
    let proc;
    try {
      proc = this.spawn(this.config.agentBin, args, {
        cwd: opts.workspace,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // own process group, so a stop also ends the tools the agent started
      });
    } catch (err) {
      this.conclude(run, { spawnError: err });
      return;
    }
    run.proc = proc;

    // A CLI that cannot start is a state, not a crash: Node emits 'error'
    // (then sometimes 'close'); the run is concluded once, on the same channel
    // as any other outcome, and the bridge keeps serving other conversations.
    proc.on('error', (err) => this.conclude(run, { spawnError: err }));
    proc.on('close', (code, signal) => this.conclude(run, { code, signal }));

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      run.stdoutBuffer += chunk;
      const lines = run.stdoutBuffer.split('\n');
      run.stdoutBuffer = lines.pop() || '';
      for (const line of lines) this.handleLine(run, line);
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      run.stderr = (run.stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });

    if (this.config.runTimeoutMs > 0) {
      const t = setTimeout(() => this.abortRun(run, 'timeout'), this.config.runTimeoutMs);
      t.unref?.();
      run.timers.push(t);
    }
  }

  handleLine(run, line) {
    // Once a run is aborted, whatever it still prints belongs to nobody: a
    // reset must not see its session id written back by the run it stopped.
    if (run.concluded || run.abortReason || !line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitRun(run, { type: 'log', stream: 'stdout', text: line });
      return;
    }
    for (const ev of run.translator.translate(parsed)) this.emitRun(run, ev);
    this.recordSession(run);
  }

  recordSession(run) {
    const sid = run.translator.state.sessionId;
    const entry = this.conversations[run.conversation];
    if (!sid || !entry || entry.last_run_id !== run.runId || entry.session_id === sid) return;
    entry.session_id = sid;
    entry.updated_at = new Date(this.now()).toISOString();
    this.saveSessions();
  }

  abortRun(run, reason) {
    if (!run || run.concluded) return false;
    if (!run.abortReason) run.abortReason = reason;
    if (this.runs.get(run.conversation) === run) this.runs.delete(run.conversation);
    const proc = run.proc;
    if (!proc || proc.pid == null || proc.exitCode != null) {
      this.conclude(run, { code: null, signal: null });
      return true;
    }
    this.signal(proc, 'SIGTERM');
    const t = setTimeout(() => this.signal(proc, 'SIGKILL'), this.config.killGraceMs);
    t.unref?.();
    run.timers.push(t);
    return true;
  }

  signal(proc, sig) {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      try { proc.kill(sig); } catch { /* already gone */ }
    }
  }

  conclude(run, { code = null, signal = null, spawnError = null }) {
    if (run.concluded) return;
    if (run.stdoutBuffer) {
      const rest = run.stdoutBuffer;
      run.stdoutBuffer = '';
      this.handleLine(run, rest);
    }
    run.concluded = true;
    for (const t of run.timers) clearTimeout(t);
    if (this.runs.get(run.conversation) === run) this.runs.delete(run.conversation);

    const durationMs = this.now() - run.startedAt;
    this.metrics.last_run_ms = durationMs;
    this.metrics.total_run_ms += durationMs;
    const st = run.translator.state;

    if (run.abortReason) {
      this.metrics.runs_aborted += 1;
      this.emitRun(run, { type: 'run_aborted', reason: run.abortReason, text: st.text, duration_ms: durationMs });
      return;
    }

    let ok;
    let error;
    let exitCode = code;
    if (spawnError) {
      ok = false;
      exitCode = 127;
      error = `cannot start ${this.config.agentBin}: ${spawnError.code || spawnError.message}`;
      this.metrics.spawn_errors += 1;
    } else if (st.result) {
      // The CLI's own verdict, not its exit code: it can exit 0 while refusing to work.
      ok = st.result.ok;
      if (!ok) error = st.result.text || run.stderr.trim() || 'cursor-agent reported an error';
    } else {
      ok = false;
      const tail = run.stderr.trim();
      error = tail || `cursor-agent exited with code ${code}${signal ? ` (${signal})` : ''} without a result`;
    }

    // Never silent: a failed run always ends with text that says why.
    if (!st.responseCompleted) {
      const out = { type: 'response_complete', text: ok ? st.text : (st.text ? `${st.text}\n\n${error}` : error) };
      if (!ok) out.error = error;
      this.emitRun(run, out);
    }

    if (ok) this.metrics.runs_ok += 1;
    else this.metrics.runs_failed += 1;

    const done = {
      type: 'run_complete',
      ok,
      exit_code: exitCode,
      session_id: st.sessionId,
      duration_ms: durationMs,
    };
    if (signal) done.signal = signal;
    if (st.result?.usage) done.usage = st.result.usage;
    if (error) done.error = error;
    this.emitRun(run, done);
  }

  stop({ conversation, all } = {}) {
    if (all) {
      const stopped = [];
      for (const run of [...this.runs.values()]) {
        if (this.abortRun(run, 'stopped')) stopped.push(run.conversation);
      }
      return stopped;
    }
    const name = this.checkName(conversation);
    const run = this.runs.get(name);
    return run && this.abortRun(run, 'stopped') ? [name] : [];
  }

  reset(conversation) {
    const name = this.checkName(conversation);
    const run = this.runs.get(name);
    if (run) this.abortRun(run, 'reset');
    const entry = this.conversations[name];
    if (!entry) return false;
    entry.session_id = null;
    entry.updated_at = new Date(this.now()).toISOString();
    this.saveSessions();
    return true;
  }

  delete(conversation) {
    const name = this.checkName(conversation);
    const run = this.runs.get(name);
    if (run) this.abortRun(run, 'deleted');
    if (!this.conversations[name]) return false;
    delete this.conversations[name];
    this.saveSessions();
    return true;
  }

  // ------------------------------------------------------------ readiness

  /**
   * `ready` is proven by running the CLI, not by finding it on disk: the
   * binary must answer `--version` and `status` must report a login (the
   * CURSOR_API_KEY in the environment counts). The account name is never
   * exposed.
   */
  async readiness({ force = false } = {}) {
    const cached = this.readinessCache;
    if (!force && cached && this.now() - cached.checkedAt < this.config.readinessTtlMs) return cached;
    const version = await runQuiet(this.config.agentBin, ['--version']);
    const status = version.ok ? await runQuiet(this.config.agentBin, ['status']) : { ok: false, out: '' };
    const plainStatus = stripAnsi(status.out);
    const loggedIn = status.ok && /logged in/i.test(plainStatus) && !/not logged in/i.test(plainStatus);
    const reasons = [];
    if (!version.ok) reasons.push(`${this.config.agentBin} --version failed: ${version.error || 'no output'}`);
    else if (!loggedIn) reasons.push('cursor-agent is not authenticated: set CURSOR_API_KEY or run `cursor-agent login`');
    this.readinessCache = {
      checkedAt: this.now(),
      ready: version.ok && loggedIn,
      cli_version: version.ok ? version.out.trim().split('\n')[0] : null,
      authenticated: loggedIn,
      reasons,
    };
    return this.readinessCache;
  }

  shutdown() {
    for (const run of [...this.runs.values()]) this.abortRun(run, 'shutdown');
  }
}

function runQuiet(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 20_000, env: process.env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: String(stdout || ''), error: err.code || String(stderr || err.message).trim() });
      else resolve({ ok: true, out: String(stdout || '') });
    });
  });
}

function stripAnsi(s) {
  return String(s || '').replace(/\[[0-9;?]*[A-Za-z]/g, '');
}
