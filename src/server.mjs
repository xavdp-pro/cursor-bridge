import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeStatus } from './contract.mjs';
import { BridgeError } from './bridge.mjs';

export const SERVICE = 'cursor-bridge';
export const VERSION = '2.0.0';
const MAX_BODY_BYTES = 1024 * 1024;
const PING_MS = 25_000;

/** Reads the bearer token, creating it (0600) on first start. */
export function ensureToken(tokenFile) {
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first start */ }
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BridgeError(413, 'BODY_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new BridgeError(400, 'INVALID_JSON', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ bridge, token }) {
  const capabilities = {
    inject: true,
    events: true,
    status: true,
    stopRun: true,
    resetSession: true,
    bindWorkspace: true,
    attachments: false,
    modelSelection: true,
  };

  async function route(req, res) {
    const url = new URL(req.url, 'http://bridge.local');
    const p = url.pathname;

    if (p === '/api/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, service: SERVICE, version: VERSION });
    }

    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) {
      return send(res, 401, { ok: false, error: 'unauthorized', code: 'UNAUTHORIZED' });
    }

    if (p === '/api/status' && req.method === 'GET') {
      const r = await bridge.readiness({ force: url.searchParams.get('refresh') === '1' });
      const cfg = bridge.config;
      return send(res, 200, bridgeStatus({
        service: SERVICE,
        ready: r.ready,
        capabilities,
        version: VERSION,
        reasons: r.reasons,
        cli: { bin: cfg.agentBin, version: r.cli_version, authenticated: r.authenticated },
        model: cfg.model,
        approval: cfg.approval,
        sandbox: cfg.sandbox || 'cli-default',
        runs_active: bridge.runs.size,
        conversations: Object.keys(bridge.conversations).length,
      }));
    }

    if (p === '/api/metrics' && req.method === 'GET') {
      const m = bridge.metrics;
      const finished = m.runs_ok + m.runs_failed + m.runs_aborted;
      return send(res, 200, {
        ok: true,
        ...m,
        uptime_s: Math.round((Date.now() - m.started_at) / 1000),
        runs_active: bridge.runs.size,
        avg_run_ms: finished ? Math.round(m.total_run_ms / finished) : null,
      });
    }

    if (p === '/api/conversations' && req.method === 'GET') {
      return send(res, 200, { ok: true, conversations: bridge.listConversations() });
    }

    if (p === '/api/events' && req.method === 'GET') {
      const filter = url.searchParams.get('conversation') || null;
      if (filter) bridge.checkName(filter);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const write = (ev) => {
        try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ }
      };
      write({ type: 'connected', service: SERVICE, conversation: filter });
      const unsubscribe = bridge.subscribe(filter, write);
      const ping = setInterval(() => write({ type: 'ping', ts: Date.now() }), PING_MS);
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
      return undefined;
    }

    if (req.method !== 'POST') {
      return send(res, 404, { ok: false, error: `no route ${req.method} ${p}`, code: 'NOT_FOUND' });
    }

    const body = await readJson(req);

    if (p === '/api/inject') {
      const result = bridge.inject(body);
      return send(res, 200, { ok: true, ...result });
    }
    if (p === '/api/conversations/stop') {
      const stopped = bridge.stop({ conversation: body.conversation, all: body.all === true });
      return send(res, 200, { ok: true, stopped });
    }
    if (p === '/api/conversations/reset') {
      const known = bridge.reset(body.conversation);
      return send(res, 200, { ok: true, reset: known });
    }
    if (p === '/api/conversations/delete') {
      const known = bridge.delete(body.conversation);
      return send(res, 200, { ok: true, deleted: known });
    }
    return send(res, 404, { ok: false, error: `no route POST ${p}`, code: 'NOT_FOUND' });
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof BridgeError) return send(res, err.status, { ok: false, error: err.message, code: err.code });
      console.error(`[${SERVICE}] ${req.method} ${req.url}:`, err);
      return send(res, 500, { ok: false, error: 'internal error', code: 'INTERNAL' });
    });
  });
}
