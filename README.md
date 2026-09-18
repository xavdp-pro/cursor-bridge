# cursor-bridge

An HTTP + SSE bridge in front of the [Cursor Agent CLI](https://cursor.com/docs/cli/overview)
(`cursor-agent`). A console or an orchestrator can then drive Cursor's agent
like any other agent CLI: send a message, follow the answer as it streams,
stop it, and pick the conversation up on the next turn.

It speaks the shared agent-bridge contract (`shaper-bridge/v1`): the same
routes and the same events as the other bridges of the family
([opencode-bridge](https://github.com/xavdp-pro/opencode-bridge) among them).
A caller that works with one works with all of them.

```
console ──HTTP──> cursor-bridge :4310 ──spawn──> cursor-agent -p --output-format stream-json
        <──SSE───                     <──stdout── one JSON event per line
```

No dependencies. Node.js 22.9 or later.

> Version 2 is a rewrite. Version 1 was a Cursor IDE extension that typed into
> the editor window (`xdotool`, the clipboard, reads of `state.vscdb`). It needed
> a visible desktop, one window per conversation, and broke with each Cursor
> update. Version 2 drives the headless CLI and needs none of that.

## Quick start

```bash
cursor-agent models                 # pick a model available to your account
cp .env.example .env && chmod 600 .env
# set CURSOR_MODEL, and CURSOR_API_KEY unless `cursor-agent login` was done
npm start
```

The bearer token is created on first start in `~/.config/cursor-bridge/token`
(mode 600).

```bash
T=$(cat ~/.config/cursor-bridge/token)
curl -s localhost:4310/api/health
curl -s -H "Authorization: Bearer $T" localhost:4310/api/status

curl -sN -H "Authorization: Bearer $T" "localhost:4310/api/events?conversation=demo" &
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"conversation":"demo","message":"List the files here"}' localhost:4310/api/inject
```

## API

| Route | Body / query | Effect |
|-------|--------------|--------|
| `GET  /api/health` | | Public liveness probe (no token) |
| `GET  /api/status` | `?refresh=1` | Contract status: `protocol`, `ready`, `capabilities`, CLI version, model |
| `GET  /api/metrics` | | Run counters and durations |
| `GET  /api/conversations` | | Known conversations, their session and workspace |
| `POST /api/inject` | `{ conversation, message, model?, mode?, workspace? }` | Starts a run, returns `run_id` |
| `GET  /api/events` | `?conversation=` | SSE stream, all conversations or one |
| `POST /api/conversations/stop` | `{ conversation }` or `{ all: true }` | Stops the live run |
| `POST /api/conversations/reset` | `{ conversation }` | Next turn starts a new session |
| `POST /api/conversations/delete` | `{ conversation }` | Forgets the conversation (its files stay) |

Every route except `/api/health` needs `Authorization: Bearer <token>`.

- `conversation`: 1 to 64 characters, letters, digits, `.`, `-`, `_`.
- `mode`: `ask` (read-only questions) or `plan` (read-only planning). Omitted: normal agent.
- `model`: overrides `CURSOR_MODEL` for this conversation from now on.
- `workspace`: an absolute directory under one of `CURSOR_BRIDGE_ALLOWED_ROOTS`
  (symlinks are resolved first). Omitted: `<CURSOR_BRIDGE_WORKSPACE_ROOT>/<conversation>`.
  Moving a conversation to another workspace starts a new session, because a
  cursor-agent session belongs to the workspace it was opened in.

`/api/status` declares `stopRun`, `resetSession`, `bindWorkspace` and
`modelSelection`. It does not declare `attachments`: there is no upload route yet.

`ready: true` is proven, not assumed: the bridge runs `cursor-agent --version`
and `cursor-agent status` and requires a login. The account name is never
returned.

## Events

Each event of a run carries `conversation`, `run_id`, a `seq` that starts at 1
and grows by one, and `ts`.

| Type | When | Fields |
|------|------|--------|
| `connected` | SSE opened | `conversation` filter |
| `inject` | Run accepted | `model`, `mode`, `resumed`, `session_reset` |
| `thinking` | Reasoning delta, then its end | `delta`, or `subtype: "completed"` |
| `tool` | Tool started | `call_id`, `tool`, `input`, `command`, `cwd`, `description` |
| `tool_complete` | Tool finished | `call_id`, `tool`, `ok`, `result` (capped at 16 000 characters) |
| `response` | Answer delta | `delta`, `text` (cumulative) |
| `response_complete` | Final answer | `text`, `error` when the run failed |
| `run_complete` | Process ended | `ok`, `exit_code`, `session_id`, `duration_ms`, `usage`, `error` |
| `run_aborted` | Stopped, replaced, reset, deleted, timed out | `reason`, `text` so far |
| `log` | A non-JSON line on the CLI's stdout | `stream`, `text` |
| `ping` | Every 25 s | |

A run ends with exactly one `run_complete` or one `run_aborted`.

## Behaviour worth knowing

- **One process per turn, one session per conversation.** The first turn
  records the `session_id` cursor-agent reports. Each next turn passes
  `--resume <session_id>`. Sessions are kept in `~/.config/cursor-bridge/sessions.json`
  and survive a restart.
- **A new message replaces a live run.** The old run ends with
  `run_aborted { reason: "replaced" }` and none of its later output reaches
  the new run.
- **Stop ends the whole process group**, so the commands the agent started go too.
- **The exit code is not trusted.** cursor-agent can exit 0 without doing the
  work. A run is `ok` only if the CLI's own `result` line says so. No `result`
  line means failure.
- **Never silent.** A failed run always ends with a `response_complete` whose
  text says why: the CLI's stderr (an invalid model, for instance), the CLI's
  error result, or the exit code.
- **A missing CLI is a state, not a crash.** The run ends with `exit_code: 127`
  and the bridge keeps serving other conversations.
- **The answer is sent once.** With `--stream-partial-output`, cursor-agent
  streams deltas and then repeats the whole text in a final line. The bridge
  drops that repeat.
- **The message is passed after `--`**, so a message that starts with a dash is
  never read as a flag.
- **No default model.** The bridge refuses to start without `CURSOR_MODEL` and
  names the variable. A model id pinned in code ages with its vendor.

## Tool approval

cursor-agent runs tools (shell, file edits) in print mode. What it may run is
decided by one setting:

| `CURSOR_BRIDGE_APPROVAL` | Flags passed | Who decides |
|--------------------------|--------------|-------------|
| `config` (default) | none | cursor-agent's own permission settings on the host (`~/.cursor/cli-config.json`, `~/.cursor/permissions.json`) |
| `force` | `--force` | Every command is allowed unless explicitly denied |

`CURSOR_BRIDGE_SANDBOX=enabled|disabled` passes `--sandbox`. Left empty, the
CLI's configured sandbox mode applies.

`force` gives the agent the rights of the user running the bridge. Use it on a
dedicated host or container, not on a workstation. What a fresh host without
any permission settings does with a tool call under `config` has not been
measured yet.

## Configuration

| Variable | Default | |
|----------|---------|---|
| `CURSOR_MODEL` | none, required | Model id from `cursor-agent models` |
| `CURSOR_API_KEY` | | Read by cursor-agent itself |
| `CURSOR_BRIDGE_PORT` | `4310` | |
| `CURSOR_BRIDGE_BIND` | `127.0.0.1` | Put a TLS proxy in front before exposing it |
| `CURSOR_BRIDGE_HOME` | `~/.config/cursor-bridge` | Token and sessions |
| `CURSOR_BRIDGE_TOKEN_FILE` | `<home>/token` | |
| `CURSOR_BRIDGE_WORKSPACE_ROOT` | `~/cursor-bridge-ws` | Default workspaces, one per conversation |
| `CURSOR_BRIDGE_ALLOWED_ROOTS` | the workspace root | `:`-separated roots a `workspace` may be under |
| `CURSOR_BRIDGE_APPROVAL` | `config` | `config` or `force` |
| `CURSOR_BRIDGE_SANDBOX` | empty | `enabled` or `disabled` |
| `CURSOR_BRIDGE_RUN_TIMEOUT_MS` | `1800000` | 0 disables |
| `CURSOR_BRIDGE_MAX_PROMPT_BYTES` | `100000` | |
| `CURSOR_AGENT_BIN` | `cursor-agent` | |

## Tests

```bash
npm test                                  # 34 tests, no network, no quota
CURSOR_MODEL=<model> npm run test:cli     # 19 checks against the real CLI
```

`npm test` replays real cursor-agent captures (`test/fixtures`, recorded with
cursor-agent 2026.09.15) through the pure translation module, and drives the
real HTTP server with a stand-in CLI (`test/fake-cursor-agent.mjs`). The
stand-in covers the paths that are hard to provoke on demand: a missing
binary, exit 0 without a result, an error result, a run that must be stopped
along with its child processes, a replaced run, a timeout.

`npm run test:cli` starts the bridge in front of the installed cursor-agent in
a throwaway directory and checks:

- a tool call;
- streaming;
- memory across two turns through `--resume`;
- stop;
- reset;
- an invalid model;
- the metrics.

It spends a little quota.

## License

[CC BY-SA 4.0](LICENSE). Credits in [AUTHORS.md](AUTHORS.md).
