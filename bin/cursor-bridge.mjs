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
  console.log(`[${SERVICE}] model=${config.model} approval=${config.approval} sandbox=${config.sandbox || 'cli-default'} approve_mcps=${config.approveMcps} workspaces=${config.workspaceRoot}`);
  if (config.approval === 'force' && config.sandbox !== 'enabled') {
    console.warn(`[${SERVICE}] WARNING: approval=force without the CLI sandbox.`
      + ' This is the required mode for the helm-v2 web interface: whoever can send a message runs any command as this OS user.'
      + ' Run this bridge only as a dedicated user or in a container.');
  }
  const r = await bridge.readiness({ force: true });
  if (r.ready) console.log(`[${SERVICE}] ready: cursor-agent ${r.cli_version}`);
  else console.warn(`[${SERVICE}] not ready: ${r.reasons.join('; ')}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    server.closeAllConnections?.();
    // Resolves once the SIGKILL follow-ups to every run's process group are sent.
    bridge.shutdown().then(() => process.exit(0));
    setTimeout(() => process.exit(0), config.killGraceMs + 3000).unref();
  });
}
