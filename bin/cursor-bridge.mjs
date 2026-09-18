#!/usr/bin/env node
import { loadConfig, ConfigError } from '../src/config.mjs';
import { CursorBridge } from '../src/bridge.mjs';
import { createServer, ensureToken, SERVICE, VERSION } from '../src/server.mjs';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[${SERVICE}] cannot start: ${err.message}`);
    process.exit(78); // EX_CONFIG
  }
  throw err;
}

const token = ensureToken(config.tokenFile);
const bridge = new CursorBridge(config);
const server = createServer({ bridge, token });

server.on('error', (err) => {
  console.error(`[${SERVICE}] listen on ${config.bind}:${config.port} failed: ${err.message}`);
  process.exit(1);
});

server.listen(config.port, config.bind, async () => {
  console.log(`[${SERVICE}] ${VERSION} listening on http://${config.bind}:${config.port}`);
  console.log(`[${SERVICE}] model=${config.model} approval=${config.approval} workspaces=${config.workspaceRoot}`);
  const r = await bridge.readiness({ force: true });
  if (r.ready) console.log(`[${SERVICE}] ready: cursor-agent ${r.cli_version}`);
  else console.warn(`[${SERVICE}] not ready: ${r.reasons.join('; ')}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    bridge.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), config.killGraceMs + 1000).unref();
  });
}
