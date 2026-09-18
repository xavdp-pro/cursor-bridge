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

/**
 * How long a run waits for its stdout/stderr to close once cursor-agent has
 * exited. `close` needs every holder of the pipes to let go; a tool process
 * that left the process group can hold them forever, and the run must still
 * end with exactly one terminal event.
 */
export const CLOSE_WAIT_MS = 2000;

export const REPLACE_NOTE = 'These instructions replace any earlier instructions in this conversation.';
export const WITHDRAW_NOTE = 'The earlier instructions of this conversation are withdrawn. Disregard them from now on.';
const FRAME_OVERHEAD_BYTES = Buffer.byteLength(`[INSTRUCTIONS]\n${REPLACE_NOTE}\n\n\n\n[USER REQUEST]\n`, 'utf8');

/** True when `child` is `parent` or lies under it (both real, absolute paths). */
export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

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
    this.pendingKills = new Set(); // promises of scheduled process-group SIGKILLs
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
      const conversations = raw && raw.conversations && typeof raw.conversations === 'object' ? raw.conversations : {};
      for (const entry of Object.values(conversations)) {
        entry.context ??= null;
        entry.context_pending ??= false;
        entry.context_rev ??= 0;
      }
      return conversations;
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

  /**
   * Helm-console shape (`{ registered: [...] }`): the fields the helm-v2
   * console reads — name, title, chat_id, cwd, timestamps. `chat_id` is the
   * cursor-agent session id; a null one means the next turn starts fresh.
   */
  registered() {
    return this.listConversations().map((c) => ({
      name: c.name,
      title: c.name,
      chat_id: c.session_id,
      resumed: Boolean(c.session_id),
      cwd: c.workspace,
      workspace: c.workspace,
      created_at: c.created_at,
      last_used_at: c.updated_at,
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

  /** Real paths of the allowed roots that exist on this host. */
  realRoots() {
    const out = [];
    for (const root of this.config.allowedRoots) {
      try { out.push(fs.realpathSync(root)); } catch { /* absent root */ }
    }
    return out;
  }

  insideRoots(real) {
    return this.realRoots().some((r) => isInside(real, r));
  }

  /** `<workspace root>/<conversation>`, whether or not it exists yet. */
  defaultWorkspacePath(name) {
    let root;
    try { root = fs.realpathSync(this.config.workspaceRoot); } catch { root = path.resolve(this.config.workspaceRoot); }
    return path.join(root, name);
  }

  /**
   * The default workspace of a conversation. Nothing is created here (a
   * refused request leaves no directory behind); `ensureWorkspaceDir` does it
   * when a run or an upload actually needs it. An existing entry must be a
   * plain directory, never a symlink.
   */
  defaultWorkspace(name) {
    const dir = this.defaultWorkspacePath(name);
    let st = null;
    try { st = fs.lstatSync(dir); } catch { /* created on first use */ }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      throw new BridgeError(409, 'WORKSPACE_CHANGED', `the default workspace ${dir} is not a plain directory (a symlink or a file)`);
    }
    return dir;
  }

  /** A workspace a caller asks for: absolute, existing, resolved, under an allowed root. */
  resolveWorkspace(name, requested) {
    if (!requested) return this.defaultWorkspace(name);
    const asked = String(requested);
    if (!path.isAbsolute(asked)) throw new BridgeError(400, 'INVALID_WORKSPACE', 'workspace must be an absolute path');
    let real;
    try {
      real = fs.realpathSync(asked);
    } catch {
      throw new BridgeError(400, 'INVALID_WORKSPACE', `workspace does not exist on this host: ${asked}`);
    }
    if (!fs.statSync(real).isDirectory()) throw new BridgeError(400, 'INVALID_WORKSPACE', `workspace is not a directory: ${asked}`);
    if (!this.insideRoots(real)) {
      throw new BridgeError(403, 'WORKSPACE_OUTSIDE_ROOTS',
        `workspace ${asked} is outside the allowed roots (CURSOR_BRIDGE_ALLOWED_ROOTS)`);
    }
    return real;
  }

  /**
   * Re-checks, at every run and upload, the workspace stored with a
   * conversation. It was a real path under an allowed root when it was bound;
   * since then it may have been removed, replaced by a symlink, or the roots
   * may have been narrowed. Any of these is refused by name instead of being
   * followed.
   */
  checkStoredWorkspace(name, stored) {
    if (stored === this.defaultWorkspacePath(name)) return this.defaultWorkspace(name);
    let real;
    try {
      real = fs.realpathSync(stored);
    } catch {
      throw new BridgeError(409, 'WORKSPACE_MISSING',
        `the bound workspace ${stored} no longer exists; bind one with /api/conversations/workspace`);
    }
    if (real !== stored || !fs.statSync(real).isDirectory()) {
      throw new BridgeError(409, 'WORKSPACE_CHANGED',
        `the bound workspace ${stored} is no longer a plain directory (now ${real}); bind it again explicitly`);
    }
    if (!this.insideRoots(real)) {
      throw new BridgeError(403, 'WORKSPACE_OUTSIDE_ROOTS',
        `the bound workspace ${stored} is outside the allowed roots (CURSOR_BRIDGE_ALLOWED_ROOTS)`);
    }
    return real;
  }

  /** Creates the default workspace when a run or an upload needs it, and checks it once more. */
  ensureWorkspaceDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || fs.realpathSync(dir) !== dir) {
      throw new BridgeError(409, 'WORKSPACE_CHANGED', `workspace ${dir} is not a plain directory`);
    }
    return dir;
  }

  // ------------------------------------------------------------- context

  /**
   * The context of a conversation: inline instruction text, stored with the
   * conversation, and placed in front of a message as
   * `[INSTRUCTIONS] ... [USER REQUEST] ...` whenever the session has not yet
   * received its current version:
   *
   * - on the first turn of every new session (first turn, after a reset,
   *   after a move to another workspace);
   * - on the next turn after the text changed (through `inject` or `create`),
   *   headed by REPLACE_NOTE when the session is resumed;
   * - after a removal (empty string) on a resumed session, a WITHDRAW_NOTE
   *   alone, since the old text stays in the session history.
   *
   * `context_pending` records that the session still has to receive it. It is
   * cleared only when a run that carried the current version completes
   * successfully, so a failed or stopped run sends it again next time.
   * Identical text is not a change and is not sent again.
   */
  contextLimit() {
    const max = this.config.maxPromptBytes;
    return Math.max(0, max - FRAME_OVERHEAD_BYTES - Math.min(1024, Math.floor(max / 4)));
  }

  checkContext(body) {
    if (body.context_file != null) {
      throw new BridgeError(400, 'INVALID_CONTEXT',
        'Send context as inline text; a caller-local context_file cannot be read by this bridge.');
    }
    if (body.context == null) return undefined;
    if (typeof body.context !== 'string') throw new BridgeError(400, 'INVALID_CONTEXT', 'context must be a string');
    if (body.context.includes('\0')) throw new BridgeError(400, 'INVALID_CONTEXT', 'context must not contain a NUL byte');
    const context = body.context.trim();
    const limit = this.contextLimit();
    if (Buffer.byteLength(context, 'utf8') > limit) {
      throw new BridgeError(413, 'CONTEXT_TOO_LARGE',
        `context exceeds ${limit} bytes (CURSOR_BRIDGE_MAX_PROMPT_BYTES minus the framing and room for a message)`);
    }
    return context;
  }

  /** Stores a new context text on the entry; identical text is no change. */
  static applyContext(entry, context) {
    if (context === undefined) return false;
    const next = context || null;
    if (next === (entry.context || null)) return false;
    entry.context = next;
    entry.context_rev = (entry.context_rev || 0) + 1;
    // A removal only has to be told to a session that may hold the old text.
    entry.context_pending = next ? true : Boolean(entry.session_id);
    return true;
  }

  /** Forgets the cursor-agent session; the next session needs the context again. */
  static dropSession(entry) {
    entry.session_id = null;
    entry.context_pending = Boolean(entry.context);
  }

  /** What the next turn must carry: the context, a withdrawal, or nothing. */
  static contextPlan(entry) {
    if (entry.context && (!entry.session_id || entry.context_pending)) {
      return { kind: 'frame', replace: Boolean(entry.session_id) };
    }
    if (!entry.context && entry.context_pending && entry.session_id) return { kind: 'withdraw' };
    return null;
  }

  static framePrompt(context, message, { replace = false } = {}) {
    if (!context) return message;
    const head = replace ? `${REPLACE_NOTE}\n\n${context}` : context;
    return `[INSTRUCTIONS]\n${head}\n\n[USER REQUEST]\n${message}`;
  }

  static promptFor(entry, plan, message) {
    if (plan?.kind === 'frame') return CursorBridge.framePrompt(entry.context, message, { replace: plan.replace });
    if (plan?.kind === 'withdraw') return `[INSTRUCTIONS]\n${WITHDRAW_NOTE}\n\n[USER REQUEST]\n${message}`;
    return message;
  }

  /**
   * Validates what a caller may set on a conversation and returns the entry it
   * would have, without saving it and without touching the disk. Shared by
   * create and inject.
   */
  prepareConversation(name, body) {
    let requestedModel = null;
    if (body.model != null && body.model !== '') {
      requestedModel = String(body.model).trim();
      if (!MODEL_RE.test(requestedModel)) throw new BridgeError(400, 'INVALID_MODEL', 'model is not a valid model id');
    }
    const context = this.checkContext(body);

    const existing = this.conversations[name];
    let workspace;
    if (body.workspace) {
      workspace = this.resolveWorkspace(name, body.workspace);
    } else if (existing?.workspace) {
      workspace = this.checkStoredWorkspace(name, existing.workspace);
    } else {
      workspace = this.defaultWorkspace(name);
    }

    const nowIso = new Date(this.now()).toISOString();
    const entry = existing ? { ...existing } : {
      name,
      session_id: null,
      workspace,
      model: null,
      context: null,
      context_pending: false,
      context_rev: 0,
      created_at: nowIso,
      last_run_id: null,
    };

    // A cursor-agent session belongs to the workspace it was opened in.
    const moved = Boolean(existing && existing.workspace !== workspace);
    let sessionReset = false;
    if (moved && entry.session_id) {
      sessionReset = true;
      CursorBridge.dropSession(entry);
    }
    entry.workspace = workspace;
    if (requestedModel) entry.model = requestedModel;
    CursorBridge.applyContext(entry, context);
    entry.updated_at = nowIso;
    return { entry, sessionReset, moved };
  }

  /** Registers a conversation (initial context, workspace, model) without running anything. */
  create(body = {}) {
    const name = this.checkName(body.conversation);
    if (body.attachments != null) {
      throw new BridgeError(400, 'INVALID_ATTACHMENT',
        'Send attachments with /api/inject or /api/upload, not with /api/conversations/create.');
    }
    const { entry, sessionReset, moved } = this.prepareConversation(name, body);
    // A move stops the live run, as a reset does: its session belongs to the old workspace.
    if (moved && this.runs.has(name)) this.abortRun(this.runs.get(name), 'moved');
    const created = !this.conversations[name];
    this.conversations[name] = entry;
    this.saveSessions();
    return {
      conversation: name,
      created,
      workspace: entry.workspace,
      model: entry.model || this.config.model,
      has_context: Boolean(entry.context),
      context_pending: Boolean(CursorBridge.contextPlan(entry)),
      session_id: entry.session_id,
      session_reset: sessionReset,
    };
  }

  // ----------------------------------------------------------------- runs

  inject(body = {}) {
    const name = this.checkName(body.conversation);
    const rawMessage = typeof body.message === 'string' ? body.message : '';
    let mode = null;
    if (body.mode != null && body.mode !== '') {
      mode = String(body.mode);
      if (!MODES.includes(mode)) throw new BridgeError(400, 'INVALID_MODE', `mode must be one of ${MODES.join(', ')}`);
    }
    const { entry, sessionReset } = this.prepareConversation(name, body);
    const attachments = this.resolveAttachments(entry.workspace, body.attachments);
    const message = attachments.length ? CursorBridge.withAttachments(rawMessage, attachments) : rawMessage;
    if (!message.trim()) throw new BridgeError(400, 'EMPTY_MESSAGE', 'message is empty');
    if (message.includes('\0')) throw new BridgeError(400, 'INVALID_MESSAGE', 'message must not contain a NUL byte');
    const sessionId = entry.session_id;
    const plan = CursorBridge.contextPlan(entry);
    const prompt = CursorBridge.promptFor(entry, plan, message);
    if (Buffer.byteLength(prompt, 'utf8') > this.config.maxPromptBytes) {
      throw new BridgeError(413, 'MESSAGE_TOO_LARGE', `message and context exceed ${this.config.maxPromptBytes} bytes`);
    }
    // Everything is valid: only now touch the disk and the live run.
    this.ensureWorkspaceDir(entry.workspace);

    if (this.runs.has(name)) this.abortRun(this.runs.get(name), 'replaced');
    const model = entry.model || this.config.model;
    const contextApplied = plan?.kind === 'frame';
    const contextWithdrawn = plan?.kind === 'withdraw';

    const run = {
      runId: crypto.randomUUID(),
      conversation: name,
      workspace: entry.workspace,
      contextRev: plan ? entry.context_rev : null,
      seq: 0,
      translator: createTranslator(),
      stdoutBuffer: '',
      stderr: '',
      startedAt: this.now(),
      abortReason: null,
      concluded: false,
      exited: null,
      proc: null,
      timers: [],
    };
    entry.last_run_id = run.runId;
    this.conversations[name] = entry;
    this.saveSessions();
    this.runs.set(name, run);
    this.metrics.runs_started += 1;

    this.emitRun(run, {
      type: 'inject', ok: true, model, mode,
      resumed: Boolean(sessionId), session_reset: sessionReset,
      context_applied: contextApplied, context_withdrawn: contextWithdrawn,
    });
    this.startProcess(run, { message: prompt, model, mode, sessionId, workspace: entry.workspace });

    return {
      run_id: run.runId,
      conversation: name,
      model,
      mode,
      workspace: entry.workspace,
      session_id: sessionId,
      chat_id: sessionId,
      composer_id: sessionId,
      resumed: Boolean(sessionId),
      session_reset: sessionReset,
      context_applied: contextApplied,
      context_withdrawn: contextWithdrawn,
    };
  }

  buildArgs({ message, model, mode, sessionId, workspace }) {
    // Headless HTTP bridge: nobody sits in front of the CLI to answer the
    // workspace-trust or MCP prompts, so every run passes --trust and
    // --approve-mcps (set CURSOR_BRIDGE_APPROVE_MCPS=0 to stop approving MCP
    // servers). The CLI still honours the workspace's own configuration
    // (.cursor/cli.json permissions, hooks.json commands, .cursor/mcp.json
    // servers): see "Tool approval" in the README.
    const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust'];
    if (this.config.approveMcps) args.push('--approve-mcps');
    args.push('--workspace', workspace, '--model', model);
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
    proc.on('exit', (code, signal) => {
      run.exited = { code, signal };
      // Normally `close` follows at once. If a descendant still holds the
      // pipes, end the run anyway after a bounded wait.
      const t = setTimeout(() => this.forceConclude(run), CLOSE_WAIT_MS);
      run.timers.push(t);
    });
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
    // An aborted run (stopped, replaced, reset, moved, deleted) never writes
    // its session back, whatever it still prints.
    if (run.abortReason) return;
    const sid = run.translator.state.sessionId;
    const entry = this.conversations[run.conversation];
    if (!sid || !entry || entry.last_run_id !== run.runId || entry.workspace !== run.workspace
      || entry.session_id === sid) return;
    entry.session_id = sid;
    entry.updated_at = new Date(this.now()).toISOString();
    this.saveSessions();
  }

  /**
   * Stops a run: SIGTERM to its process group now, SIGKILL to the group after
   * the grace period whatever happens meanwhile (the CLI dying first must not
   * spare a tool that ignores SIGTERM), and a terminal event no later than
   * grace + CLOSE_WAIT_MS even if the pipes never close.
   */
  abortRun(run, reason) {
    if (!run || run.concluded) return false;
    if (this.runs.get(run.conversation) === run) this.runs.delete(run.conversation);
    if (run.abortReason) return true; // already being stopped
    run.abortReason = reason;
    const proc = run.proc;
    if (!proc || proc.pid == null) {
      this.conclude(run, { code: null, signal: null });
      return true;
    }
    this.signal(proc, 'SIGTERM');
    this.scheduleGroupKill(proc.pid);
    if (run.exited) {
      // The CLI is already gone; only its pipes are left. Its output is discarded anyway.
      this.forceConclude(run);
      return true;
    }
    const t = setTimeout(() => this.forceConclude(run), this.config.killGraceMs + CLOSE_WAIT_MS);
    run.timers.push(t);
    return true;
  }

  /**
   * SIGKILL to the process group after the grace period. Not tied to the run,
   * so concluding the run does not cancel it. The timer keeps the process
   * alive, which is what a shutdown needs. A pgid is not reused while any
   * member of the group lives; once the group is empty the kill is ESRCH.
   */
  scheduleGroupKill(pgid) {
    let done;
    const p = new Promise((resolve) => { done = resolve; });
    setTimeout(() => {
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* group already empty */ }
      this.pendingKills.delete(p);
      done();
    }, this.config.killGraceMs);
    this.pendingKills.add(p);
  }

  signal(proc, sig) {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      try { proc.kill(sig); } catch { /* already gone */ }
    }
  }

  /** Ends a run whose pipes did not close: drop them, then conclude once. */
  forceConclude(run) {
    if (run.concluded) return;
    const proc = run.proc;
    try { proc?.stdout?.destroy(); } catch { /* ignore */ }
    try { proc?.stderr?.destroy(); } catch { /* ignore */ }
    this.conclude(run, run.exited || { code: null, signal: null });
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

    // The session has received the context version this run carried.
    if (ok && run.contextRev != null) {
      const entry = this.conversations[run.conversation];
      if (entry && entry.last_run_id === run.runId && entry.context_rev === run.contextRev && entry.context_pending) {
        entry.context_pending = false;
        this.saveSessions();
      }
    }

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
    CursorBridge.dropSession(entry);
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

  /**
   * Binds a working directory to a conversation without running anything
   * (helm-v2 `ensureSessionWorkspace`). Moving to another workspace drops
   * the cursor-agent session, which belongs to the workspace it was opened
   * in. A conversation that does not exist yet is registered.
   */
  setWorkspace(conversation, workspace) {
    const name = this.checkName(conversation);
    if (workspace == null || String(workspace).trim() === '') {
      throw new BridgeError(400, 'INVALID_WORKSPACE', 'workspace is required');
    }
    const real = this.resolveWorkspace(name, workspace);
    const nowIso = new Date(this.now()).toISOString();
    const existing = this.conversations[name];
    let sessionReset = false;
    let stopped = false;
    if (existing) {
      if (existing.workspace !== real) {
        // As a reset does: the live run's session belongs to the old workspace.
        const run = this.runs.get(name);
        if (run) stopped = this.abortRun(run, 'moved');
        if (existing.session_id) {
          sessionReset = true;
          CursorBridge.dropSession(existing);
        }
        existing.workspace = real;
      }
      existing.updated_at = nowIso;
    } else {
      this.conversations[name] = {
        name,
        session_id: null,
        workspace: real,
        model: null,
        context: null,
        context_pending: false,
        context_rev: 0,
        created_at: nowIso,
        updated_at: nowIso,
        last_run_id: null,
      };
    }
    this.saveSessions();
    return { conversation: name, workspace: real, cwd: real, session_reset: sessionReset, run_stopped: stopped };
  }

  // ---------------------------------------------------------- attachments

  /**
   * Resolves the `attachments` of an inject to workspace-relative (or
   * absolute) paths the agent can read. Items are absolute paths on this
   * host or paths relative to the conversation workspace; every file must
   * exist inside the allowed roots. Symlinks are resolved first, so a link
   * cannot smuggle a file in from outside.
   */
  resolveAttachments(workspace, raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) {
      throw new BridgeError(400, 'INVALID_ATTACHMENT', 'attachments must be an array of paths');
    }
    if (raw.length > 20) throw new BridgeError(400, 'INVALID_ATTACHMENT', 'at most 20 attachments per message');
    return raw.map((item) => {
      if (typeof item !== 'string' || !item.trim() || item.length > 1024) {
        throw new BridgeError(400, 'INVALID_ATTACHMENT', 'each attachment must be a path string');
      }
      const trimmed = item.trim();
      if (trimmed.includes('\0')) throw new BridgeError(400, 'INVALID_ATTACHMENT', 'attachment path must not contain a NUL byte');
      const abs = path.isAbsolute(trimmed) ? trimmed : path.join(workspace, trimmed);
      let real;
      try {
        real = fs.realpathSync(abs);
      } catch {
        throw new BridgeError(400, 'INVALID_ATTACHMENT', `attachment does not exist on this host: ${trimmed}`);
      }
      if (!fs.statSync(real).isFile()) {
        throw new BridgeError(400, 'INVALID_ATTACHMENT', `attachment is not a file: ${trimmed}`);
      }
      if (!this.insideRoots(real) && !isInside(real, workspace)) {
        throw new BridgeError(403, 'WORKSPACE_OUTSIDE_ROOTS',
          `attachment ${trimmed} is outside the allowed roots (CURSOR_BRIDGE_ALLOWED_ROOTS)`);
      }
      return isInside(real, workspace) && real !== workspace ? path.relative(workspace, real) : real;
    });
  }

  static withAttachments(message, attachments) {
    if (!attachments.length) return message;
    const list = attachments.map((a) => `- ${a}`).join('\n');
    const block = `Attachments (paths relative to the working directory unless absolute):\n${list}`;
    return message.trim() ? `${message.trim()}\n\n${block}` : block;
  }

  /**
   * Stores one base64 upload in `<workspace>/_attachments/` without running
   * anything. Returns both `rel` (portable, for prompts) and `abs` (for the
   * helm console on the same host). An existing name is never overwritten.
   */
  saveAttachment(body = {}) {
    const name = this.checkName(body.conversation);
    const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
    if (!filename) throw new BridgeError(400, 'INVALID_ATTACHMENT', 'filename is required');
    if (typeof body.data !== 'string' || !body.data.trim()) {
      throw new BridgeError(400, 'INVALID_ATTACHMENT', 'data (base64) is required');
    }
    const bytes = Buffer.from(body.data.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!bytes.length) throw new BridgeError(400, 'INVALID_ATTACHMENT', 'data is empty');
    if (bytes.length > this.config.maxUploadBytes) {
      throw new BridgeError(413, 'ATTACHMENT_TOO_LARGE', `attachment exceeds ${this.config.maxUploadBytes} bytes`);
    }
    const existing = this.conversations[name];
    const workspace = this.ensureWorkspaceDir(existing?.workspace
      ? this.checkStoredWorkspace(name, existing.workspace)
      : this.defaultWorkspace(name));
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'file';
    const dir = path.join(workspace, '_attachments');
    try { fs.mkdirSync(dir); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new BridgeError(409, 'ATTACHMENTS_DIR_INVALID', `${dir} is not a plain directory (a symlink or a file)`);
    }
    // `wx` = O_CREAT|O_EXCL: never overwrites, and never follows a symlink
    // (dangling or not) planted under the chosen name.
    const ext = path.extname(safe);
    let target = path.join(dir, safe);
    for (let i = 1; ; i++) {
      try {
        fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST' || i > 999) throw err;
        target = path.join(dir, `${path.basename(safe, ext)}-${i}${ext}`);
      }
    }
    return {
      conversation: name,
      filename: path.basename(target),
      rel: path.join('_attachments', path.basename(target)),
      abs: target,
    };
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

  /**
   * Stops every live run and resolves once the SIGKILL follow-ups to their
   * process groups have been sent, so the caller can exit without leaving a
   * tool that ignores SIGTERM behind.
   */
  shutdown() {
    for (const run of [...this.runs.values()]) this.abortRun(run, 'shutdown');
    return Promise.all([...this.pendingKills]);
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
