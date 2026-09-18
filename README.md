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
| `GET  /api/conversations` | | Known conversations, their session and workspace (`conversations` plus the helm-console `registered` shape) |
| `POST /api/inject` | `{ conversation, message, context?, model?, mode?, workspace?, attachments? }` | Starts a run, returns `run_id` |
| `GET  /api/events` | `?conversation=` | SSE stream, all conversations or one |
| `POST /api/conversations/create` | `{ conversation, context?, model?, workspace? }` | Registers or updates the context, model, workspace without running anything (a workspace move stops the live run) |
| `POST /api/conversations/stop` | `{ conversation }` or `{ all: true }` | Stops the live run |
| `POST /api/conversations/reset` | `{ conversation }` | Next turn starts a new session |
| `POST /api/conversations/delete` | `{ conversation }` | Forgets the conversation (its files stay) |
| `POST /api/conversations/workspace` | `{ conversation, workspace }` | Binds a working directory without running (helm console); a move stops the live run and starts a new session |
| `POST /api/upload` | `{ conversation, filename, data }` | Stores one base64 file in `<workspace>/_attachments/`, returns `rel` and `abs` |
| `GET  /api/fs/list` | `?path=/abs/dir`, or nothing for the roots | Subdirectory listing for a workspace picker, inside the allowed roots only |

Every route except `/api/health` needs `Authorization: Bearer <token>`.

- `conversation`: 1 to 64 characters, letters, digits, `.`, `-`, `_`.
- `context`: inline instruction text for this conversation (one web chat = one
  conversation), at most `CURSOR_BRIDGE_MAX_PROMPT_BYTES` minus the framing and
  1 KiB kept for the message (98 869 bytes with the defaults); no NUL byte. It is
  stored with the conversation (and survives a restart) and framed in front of a
  message as `[INSTRUCTIONS] ... [USER REQUEST] ...` whenever the current
  session has not received its current version yet:
  - the first turn of every new session: first turn, after a reset, after a
    workspace move;
  - the next turn after the text changed, whether it was changed with `inject`
    or with `create`. On a resumed session the block starts with
    *"These instructions replace any earlier instructions in this conversation."*;
  - after a removal (`context: ""`) on a resumed session, the next turn carries
    only *"The earlier instructions of this conversation are withdrawn.
    Disregard them from now on."* (`context_withdrawn: true`).

  The same text sent again (surrounding whitespace ignored) is no change and is
  not repeated. A pending context stays pending until a run that carried it
  completes with `ok: true`; a failed or stopped run sends it again next turn.
  Replacing or withdrawing does not erase what the session already read: the
  old text stays in the cursor-agent history, and only `reset` starts from a
  clean slate. There is no `context_file`: a caller-local path cannot be read
  by this bridge.
- `message`: required unless `attachments` is given; no NUL byte. With the
  framing and the attachment list, the whole prompt is at most
  `CURSOR_BRIDGE_MAX_PROMPT_BYTES`.
- `mode`: `ask` (read-only questions) or `plan` (read-only planning). Omitted: normal agent.
- `model`: overrides `CURSOR_MODEL` for this conversation from now on.
- `workspace`: an absolute directory under one of `CURSOR_BRIDGE_ALLOWED_ROOTS`
  (symlinks are resolved first; the resolved path is stored). Omitted:
  `<CURSOR_BRIDGE_WORKSPACE_ROOT>/<conversation>`, created on the first run and
  created again if it was deleted. Moving a conversation to another workspace
  stops its live run (`run_aborted { reason: "moved" }`) and starts a new
  session, because a cursor-agent session belongs to the workspace it was
  opened in. The helm console binds the directory separately through
  `POST /api/conversations/workspace` before its first inject.

  The stored workspace is checked again before every run and upload. If it no
  longer exists (`409 WORKSPACE_MISSING`), is no longer a plain directory at
  the same real path, for instance replaced by a symlink (`409 WORKSPACE_CHANGED`),
  or is outside the allowed roots after they were narrowed (`403 WORKSPACE_OUTSIDE_ROOTS`),
  the run is refused. Bind a workspace again to continue.
- `attachments`: an array of paths to files the agent must read — absolute
  paths on this host, or paths relative to the conversation workspace. Every
  file must exist inside the allowed roots or the workspace (symlinks resolved
  first). They are named at the end of the prompt as workspace-relative paths,
  or absolute when they live outside the workspace. Files can also be stored
  first with `POST /api/upload` and then referenced by their `rel` path:
  `data` is base64 (a `data:` URL prefix is accepted), the decoded file is at
  most `CURSOR_BRIDGE_MAX_UPLOAD_BYTES`, `filename` is sanitised, and an
  existing name, or a symlink planted under that name, is never written
  through: the file gets the next free `name-N.ext`. A symlinked `_attachments`
  directory is refused (`409 ATTACHMENTS_DIR_INVALID`).
- `GET /api/fs/list` without `path` returns the allowed roots
  (`{ path: null, roots, entries }`). With a `path`, the directory must resolve
  inside an allowed root (`403` otherwise, whether it exists or not). Only real
  subdirectories are listed: no symlinks, no dotfiles, at most 500.

`/api/status` declares `stopRun`, `resetSession`, `bindWorkspace`,
`attachments` and `modelSelection`, and reports `approval`, `sandbox` and
`approve_mcps`.

### Errors

Every error is `{ ok: false, error, code }` with an HTTP status:

| Status | `code` |
|--------|--------|
| 400 | `INVALID_JSON`, `INVALID_CONVERSATION`, `EMPTY_MESSAGE`, `INVALID_MESSAGE`, `INVALID_MODE`, `INVALID_MODEL`, `INVALID_CONTEXT`, `INVALID_WORKSPACE`, `INVALID_ATTACHMENT`, `ABSOLUTE_PATH_REQUIRED`, `INVALID_PATH`, `NOT_A_DIRECTORY` |
| 401 | `UNAUTHORIZED` |
| 403 | `WORKSPACE_OUTSIDE_ROOTS` |
| 404 | `NOT_FOUND` |
| 409 | `WORKSPACE_MISSING`, `WORKSPACE_CHANGED`, `ATTACHMENTS_DIR_INVALID` |
| 413 | `BODY_TOO_LARGE`, `MESSAGE_TOO_LARGE`, `CONTEXT_TOO_LARGE`, `ATTACHMENT_TOO_LARGE` |
| 500 | `INTERNAL` |

A body over its limit (1 MiB, or the upload limit for `/api/upload`) is read
to the end and answered with 413, so the client sees the error and not a
connection reset.

The helm console additionally reads `registered` (next to `conversations` on
`GET /api/conversations`) and `chat_id` / `composer_id` (next to `session_id`
on `/api/inject`): same conversations, same sessions, older field names.

`ready: true` is proven, not assumed: the bridge runs `cursor-agent --version`
and `cursor-agent status` and requires a login. The account name is never
returned.

## Events

Each event of a run carries `conversation`, `run_id`, a `seq` that starts at 1
and grows by one, and `ts`.

| Type | When | Fields |
|------|------|--------|
| `connected` | SSE opened | `conversation` filter |
| `inject` | Run accepted | `model`, `mode`, `resumed`, `session_reset`, `context_applied`, `context_withdrawn` |
| `thinking` | Reasoning delta, then its end | `delta`, or `subtype: "completed"` |
| `tool` | Tool started | `call_id`, `tool`, `input`, `command`, `cwd`, `description` |
| `tool_complete` | Tool finished | `call_id`, `tool`, `ok`, `result` (capped at 16 000 characters) |
| `response` | Answer delta | `delta`, `text` (cumulative) |
| `response_complete` | Final answer | `text`, `error` when the run failed |
| `run_complete` | Process ended | `ok`, `exit_code`, `session_id`, `duration_ms`, `usage`, `error` |
| `run_aborted` | `reason`: `stopped`, `replaced`, `reset`, `moved`, `deleted`, `timeout`, `shutdown` | `reason`, `text` so far |
| `log` | A non-JSON line on the CLI's stdout | `stream`, `text` |
| `ping` | Every 25 s | |

A run ends with exactly one `run_complete` or one `run_aborted`. It ends
when cursor-agent exits, even if a process it started keeps the output pipes
open (after at most 2 s of waiting for them), and a stopped or timed-out run
ends no later than `CURSOR_BRIDGE_KILL_GRACE_MS` + 2 s after the stop.

## Behaviour worth knowing

- **One process per turn, one session per conversation.** The first turn
  records the `session_id` cursor-agent reports. Each next turn passes
  `--resume <session_id>`. Sessions and contexts are kept in
  `~/.config/cursor-bridge/sessions.json` (mode 600) and survive a restart.
  The file holds one entry per conversation, full context included, and is
  rewritten on every change. Nothing expires on its own: delete the
  conversations you no longer need (`/api/conversations/delete`), for instance
  when a web chat is closed.
- **A new message replaces a live run.** The old run ends with
  `run_aborted { reason: "replaced" }` and none of its later output reaches
  the new run.
- **Stop ends the whole process group**, so the commands the agent started go
  too: SIGTERM at once, then SIGKILL to the group after
  `CURSOR_BRIDGE_KILL_GRACE_MS`, even if cursor-agent itself exited first, so a
  tool that ignores SIGTERM does not survive. The same applies to replace,
  reset, move, delete, timeout and shutdown; the bridge exits only after these
  SIGKILLs are sent. A process that left the group on purpose (`setsid`) is out
  of reach. The background processes of a run that ended normally are left
  running.
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

> **Required mode for the helm-v2 web interface.** The bridge must run with
> `CURSOR_BRIDGE_APPROVAL=force`, no CLI sandbox, and MCP servers
> auto-approved. This is how it has to work: anything stricter leaves tool and
> MCP prompts with nobody to answer them, and the web chat cannot work. The
> price is below: run the bridge as a dedicated OS user or in a container
> holding nothing else, never on a workstation.

cursor-agent runs tools (shell, file edits) in print mode. Every run passes
`--trust` and `--approve-mcps`: the bridge is headless HTTP, and nobody sits
in front of the CLI to answer the workspace-trust or MCP prompts.
`CURSOR_BRIDGE_APPROVE_MCPS=0` stops approving MCP servers. What shell
commands may run is decided by `CURSOR_BRIDGE_APPROVAL`, **within the limits
of the next section**:

| `CURSOR_BRIDGE_APPROVAL` | Flags passed | Who decides |
|--------------------------|--------------|-------------|
| `config` (default) | `--trust --approve-mcps` | cursor-agent's own permission settings: `~/.cursor/cli-config.json`, `~/.cursor/permissions.json`, **and the workspace's `.cursor/cli.json`** |
| `force` | `--trust --approve-mcps --force` | Every command is allowed unless explicitly denied. **Required for helm-v2 web** |

### A trusted workspace brings its own configuration

With `--trust`, cursor-agent reads configuration from the workspace itself,
not only from the host (seen in the cursor-agent 2026.09.15 code, not yet
measured on a run):

- `.cursor/cli.json`: project permissions, merged with the host's. A
  repository can allow commands the host's `config` does not;
- `.cursor/hooks.json`: hook commands run on agent events (session start,
  before a prompt, at the end);
- `.cursor/mcp.json`: MCP servers, which are local commands. They start
  without approval (`--approve-mcps` is on unless `CURSOR_BRIDGE_APPROVE_MCPS=0`).

So `config` mode does not hold what a repository's own configuration permits.
Every directory under `CURSOR_BRIDGE_ALLOWED_ROOTS` must be trusted as much as
the host's own settings: do not put third-party clones there, and keep in mind
that an agent allowed to edit files can write these files for its next turn.

To measure it on a host where cursor-agent is logged in (three short runs,
a little quota):

```bash
CURSOR_MODEL=<model> npm run bench:workspace-config
```

The table says, for a workspace carrying such files, which hook and MCP
commands ran with and without `--approve-mcps`, and whether a project
`.cursor/cli.json` let a shell command run under `config`.

### `force`

`force` gives the agent the rights of the user running the bridge, for anyone
who can send it a message. The bridge prints a warning at every start when
`force` runs without the CLI sandbox. This unsandboxed `force` mode is the
required mode for the helm-v2 web interface: without it, tool and MCP prompts
have nobody to answer them and the web chat cannot work. Use `force` only as a
dedicated OS user or in a container that holds nothing else, never on a
workstation. What a fresh host without any permission settings does with a
tool call under `config` has not been measured yet.

## Web chat usage (one page, no questions asked)

A web page driving one chat opens one conversation, registers its context
once, then sends one `inject` per user message and reads the SSE stream.
Nothing ever prompts: workspace trust and MCP approval are automatic, and the
model is told in the context to act instead of asking. This is the required
mode for the helm-v2 web interface: without it the web chat cannot work.

```bash
T=$(cat ~/.config/cursor-bridge/token)

# 1. Register the page context once (no run, no quota).
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"conversation":"shop-chat-7","context":"You are the shop assistant. Answer in French. Never ask a clarifying question: act on the request, use the tools, and say what you did."}' \
  localhost:4310/api/conversations/create

# 2. Each user message is one inject; follow the answer on SSE.
curl -sN -H "Authorization: Bearer $T" "localhost:4310/api/events?conversation=shop-chat-7" &
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"conversation":"shop-chat-7","message":"Add a red scarf to the cart"}' \
  localhost:4310/api/inject
```

Rules for the caller:

- Pass the full page context as `context` on `create` (or on the first
  `inject`). Sending the same text again is harmless (it is not repeated);
  a different text is delivered on the next turn.
- After a `reset` or a workspace move the stored context is sent again
  automatically (`context_applied: true` in the `inject` event and reply).
- Put the "never ask, always act" rule inside the context text itself; the
  bridge guarantees the CLI never blocks, but only the context tells the
  model not to answer with a question.
- Server deployment for the helm-v2 web page (`/opt/bridge/cursor/.env`,
  required): `CURSOR_BRIDGE_APPROVAL=force`, no `CURSOR_BRIDGE_SANDBOX`
  (leave it empty), `CURSOR_BRIDGE_APPROVE_MCPS` left on, the bridge running
  as a dedicated OS user or in its own container, and
  `CURSOR_BRIDGE_ALLOWED_ROOTS` limited to the chats' workspaces. Tool calls
  then never wait for an approval nobody will give.
- **Warning.** With `force`, whoever can type into the page can make the agent
  run commands, directly or through text the agent reads (prompt injection).
  The dedicated user or container is what bounds the damage; the context
  text does not. Delete a chat's conversation when the chat ends.

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
| `CURSOR_BRIDGE_APPROVAL` | `config` | `config` or `force` (helm-v2 web requires `force`, see Tool approval) |
| `CURSOR_BRIDGE_SANDBOX` | empty | `enabled` or `disabled`; leave empty for helm-v2 web |
| `CURSOR_BRIDGE_ALLOW_UNSANDBOXED_FORCE` | `0` | Legacy: kept for old deployments, no longer required |
| `CURSOR_BRIDGE_APPROVE_MCPS` | `1` | `0` stops passing `--approve-mcps` |
| `CURSOR_BRIDGE_RUN_TIMEOUT_MS` | `1800000` | 0 disables |
| `CURSOR_BRIDGE_KILL_GRACE_MS` | `5000` | SIGTERM to SIGKILL delay for a run's process group |
| `CURSOR_BRIDGE_MAX_PROMPT_BYTES` | `100000` | Whole prompt: context framing + message + attachment list. At most 131071 (one command-line argument) |
| `CURSOR_BRIDGE_MAX_UPLOAD_BYTES` | `8388608` | One `/api/upload` file, decoded size |
| `CURSOR_BRIDGE_READINESS_TTL_MS` | `60000` | How long `/api/status` reuses its CLI check (`?refresh=1` forces one) |
| `CURSOR_AGENT_BIN` | `cursor-agent` | |

## Tests

```bash
npm test                                  # 67 tests, no network, no quota
CURSOR_MODEL=<model> npm run test:cli     # 19 checks against the real CLI
CURSOR_MODEL=<model> npm run bench:workspace-config   # measures workspace config under --trust
```

`npm test` replays real cursor-agent captures (`test/fixtures`, recorded with
cursor-agent 2026.09.15) through the pure translation module, and drives the
real HTTP server with a stand-in CLI (`test/fake-cursor-agent.mjs`). The
stand-in covers the paths that are hard to provoke on demand: a missing
binary, exit 0 without a result, an error result, a run that must be stopped
along with its child processes (including one that ignores SIGTERM, and one
that holds the output pipes from outside the group), a replaced run, a run
still printing while its workspace moves, a timeout.

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
