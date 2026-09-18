import os from 'node:os';
import path from 'node:path';

export const APPROVAL_MODES = ['config', 'force'];
export const SANDBOX_MODES = ['', 'enabled', 'disabled'];

function expandHome(p) {
  if (!p) return p;
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function intEnv(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export class ConfigError extends Error {}

/**
 * Reads the whole configuration from the environment. Anything missing or
 * malformed is refused here, with the name of the variable to fix, rather
 * than discovered later in the middle of a run.
 */
export function loadConfig(env = process.env) {
  const home = path.resolve(expandHome(env.CURSOR_BRIDGE_HOME || '~/.config/cursor-bridge'));
  const workspaceRoot = path.resolve(expandHome(env.CURSOR_BRIDGE_WORKSPACE_ROOT || '~/cursor-bridge-ws'));
  const allowedRoots = (env.CURSOR_BRIDGE_ALLOWED_ROOTS || '')
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(expandHome(p)));

  const approval = (env.CURSOR_BRIDGE_APPROVAL || 'config').trim();
  if (!APPROVAL_MODES.includes(approval)) {
    throw new ConfigError(`CURSOR_BRIDGE_APPROVAL must be one of ${APPROVAL_MODES.join(', ')}, got "${approval}"`);
  }
  const sandbox = (env.CURSOR_BRIDGE_SANDBOX || '').trim();
  if (!SANDBOX_MODES.includes(sandbox)) {
    throw new ConfigError(`CURSOR_BRIDGE_SANDBOX must be empty, enabled or disabled, got "${sandbox}"`);
  }

  // No default model. A pinned model id ages with its vendor while every test
  // asserting it stays green; the model is a deployment value, measured on the
  // host with `cursor-agent models`.
  const model = (env.CURSOR_MODEL || '').trim();
  if (!model) {
    throw new ConfigError('CURSOR_MODEL is not set. Pick one from `cursor-agent models` on this host and set it.');
  }

  return {
    port: intEnv(env, 'CURSOR_BRIDGE_PORT', 4310),
    bind: (env.CURSOR_BRIDGE_BIND || '127.0.0.1').trim(),
    home,
    tokenFile: path.resolve(expandHome(env.CURSOR_BRIDGE_TOKEN_FILE || path.join(home, 'token'))),
    sessionsFile: path.join(home, 'sessions.json'),
    agentBin: (env.CURSOR_AGENT_BIN || 'cursor-agent').trim(),
    model,
    workspaceRoot,
    allowedRoots: allowedRoots.length ? allowedRoots : [workspaceRoot],
    approval,
    sandbox,
    runTimeoutMs: intEnv(env, 'CURSOR_BRIDGE_RUN_TIMEOUT_MS', 30 * 60 * 1000),
    maxPromptBytes: intEnv(env, 'CURSOR_BRIDGE_MAX_PROMPT_BYTES', 100_000),
    killGraceMs: intEnv(env, 'CURSOR_BRIDGE_KILL_GRACE_MS', 5000),
    readinessTtlMs: intEnv(env, 'CURSOR_BRIDGE_READINESS_TTL_MS', 60_000),
  };
}
