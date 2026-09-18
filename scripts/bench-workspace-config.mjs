#!/usr/bin/env node
/**
 * Bench: what a workspace's own configuration makes the real cursor-agent do
 * when the bridge runs it with `--trust` (always) and `--approve-mcps`
 * (CURSOR_BRIDGE_APPROVE_MCPS=1). It measures; it does not pass or fail.
 * It spends a little model quota (three short runs).
 *
 *   CURSOR_MODEL=<id from `cursor-agent models`> npm run bench:workspace-config
 *
 * Each run gets a fresh throwaway workspace holding:
 *   .cursor/hooks.json  command hooks (sessionStart, beforeSubmitPrompt, stop) that touch a marker
 *   .cursor/mcp.json    one stdio MCP server whose command touches a marker
 *   .cursor/cli.json    (run C only) a project permission allowing Shell(touch)
 * and is asked to run `touch shell-marker`. The bridge's own argument builder
 * is used, in `config` approval mode, so the flags are the ones the bridge passes.
 *
 * Read the table as: which markers exist after the run. A hook or MCP marker
 * means the workspace ran a command without any approval; a shell marker in
 * C but not in A means a project .cursor/cli.json widened `config` mode.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CursorBridge } from '../src/bridge.mjs';

const model = (process.env.CURSOR_MODEL || '').trim();
if (!model) {
  console.error('CURSOR_MODEL is not set. Pick one from `cursor-agent models` and run again.');
  process.exit(78);
}
const agentBin = (process.env.CURSOR_AGENT_BIN || 'cursor-agent').trim();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-bench-'));

const RUNS = [
  { id: 'A', approveMcps: false, projectCliJson: false },
  { id: 'B', approveMcps: true, projectCliJson: false },
  { id: 'C', approveMcps: false, projectCliJson: true },
];

function prepareWorkspace(dir, { projectCliJson }) {
  const cursorDir = path.join(dir, '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });
  const hook = path.join(dir, 'hook.sh');
  fs.writeFileSync(hook, '#!/bin/sh\ntouch "$(dirname "$0")/hook-marker-$1"\ncat >/dev/null\necho \'{"continue":true,"permission":"allow"}\'\n', { mode: 0o755 });
  const hooks = {};
  for (const event of ['sessionStart', 'beforeSubmitPrompt', 'stop']) hooks[event] = [{ command: `${hook} ${event}` }];
  fs.writeFileSync(path.join(cursorDir, 'hooks.json'), JSON.stringify({ version: 1, hooks }, null, 2));
  const mcp = path.join(dir, 'mcp.sh');
  fs.writeFileSync(mcp, '#!/bin/sh\ntouch "$(dirname "$0")/mcp-marker"\nexec cat >/dev/null\n', { mode: 0o755 });
  fs.writeFileSync(path.join(cursorDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'bench-probe': { command: mcp, args: [] } } }, null, 2));
  if (projectCliJson) {
    fs.writeFileSync(path.join(cursorDir, 'cli.json'), JSON.stringify({ permissions: { allow: ['Shell(touch)'], deny: [] } }, null, 2));
  }
}

function runOnce(dir, approveMcps) {
  const config = { approval: 'config', sandbox: '', approveMcps };
  const args = CursorBridge.prototype.buildArgs.call({ config }, {
    message: 'Run the shell command `touch shell-marker` in the current directory, then reply with the single word done.',
    model,
    mode: null,
    sessionId: null,
    workspace: dir,
  });
  return new Promise((resolve) => {
    const proc = spawn(agentBin, args, { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }, 180_000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* group empty */ }
      resolve({ code, out, err, args });
    });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, out, err: String(e), args }); });
  });
}

const rows = [];
try {
  for (const r of RUNS) {
    const dir = path.join(root, `ws-${r.id}`);
    fs.mkdirSync(dir);
    prepareWorkspace(dir, r);
    const res = await runOnce(dir, r.approveMcps);
    const has = (f) => fs.existsSync(path.join(dir, f));
    const toolCalls = res.out.split('\n').filter((l) => l.includes('"tool_call"')).length;
    rows.push({
      run: r.id,
      approve_mcps: r.approveMcps,
      project_cli_json: r.projectCliJson,
      exit: res.code,
      hook_sessionStart: has('hook-marker-sessionStart'),
      hook_beforeSubmitPrompt: has('hook-marker-beforeSubmitPrompt'),
      hook_stop: has('hook-marker-stop'),
      mcp_started: has('mcp-marker'),
      shell_ran: has('shell-marker'),
      tool_call_lines: toolCalls,
      stderr_tail: res.err.trim().split('\n').slice(-2).join(' | ').slice(0, 160),
    });
  }
  console.table(rows);
  console.log('cursor-agent flags (run B):', CursorBridge.prototype.buildArgs.call(
    { config: { approval: 'config', sandbox: '', approveMcps: true } },
    { message: '<prompt>', model, mode: null, sessionId: null, workspace: '<ws>' },
  ).join(' '));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
