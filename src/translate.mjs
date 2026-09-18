/**
 * Translation of the cursor-agent `stream-json` output into the shared bridge
 * event contract.
 *
 * Pure: no I/O, no clock, no process. It receives one parsed line of the CLI
 * output and returns the canonical events to broadcast. The server stamps
 * `conversation`, `run_id` and `seq` on top. Keeping this module pure is what
 * lets the tests replay real captures without spending any model quota.
 *
 * Shapes observed on cursor-agent 2026.09.15 with `--stream-partial-output`:
 *
 *   system/init                  session_id, model, cwd
 *   user                         the prompt, echoed back
 *   thinking/delta               text
 *   thinking/completed
 *   tool_call/started            tool_call.<name>ToolCall.args
 *   tool_call/completed          tool_call.<name>ToolCall.result.{success|...}
 *   assistant (with timestamp_ms)     one text delta
 *   assistant (without timestamp_ms)  the whole text again, once, at the end
 *   result/success               result, is_error, duration_ms, usage
 *
 * The last `assistant` line repeats text that was already streamed. Forwarding
 * it would send the answer twice, so once a delta has been seen, whole-text
 * lines are ignored. Without `--stream-partial-output` there are no deltas and
 * the whole-text lines are the answer.
 */

export const MAX_TOOL_RESULT_CHARS = 16_000;

export function createTranslator() {
  const state = {
    sessionId: null,
    model: null,
    text: '',
    sawDelta: false,
    result: null,
    responseCompleted: false,
    tools: new Map(), // call_id -> tool name
  };

  function translate(ev) {
    if (!ev || typeof ev !== 'object') return [];
    if (ev.session_id && !state.sessionId) state.sessionId = String(ev.session_id);

    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && ev.model) state.model = String(ev.model);
        return [];

      case 'user':
        return [];

      case 'thinking':
        if (ev.subtype === 'completed') return [{ type: 'thinking', subtype: 'completed' }];
        if (ev.text) return [{ type: 'thinking', delta: String(ev.text) }];
        return [];

      case 'tool_call':
        return translateToolCall(ev);

      case 'assistant':
        return translateAssistant(ev);

      case 'result':
        return translateResult(ev);

      default:
        return [];
    }
  }

  function translateToolCall(ev) {
    const { name, body } = toolBody(ev.tool_call);
    const callId = String(ev.call_id || ev.tool_call?.toolCallId || '');
    const args = body?.args || {};

    if (ev.subtype === 'started') {
      state.tools.set(callId, name);
      const out = { type: 'tool', call_id: callId, tool: name, input: compactArgs(args) };
      if (typeof args.command === 'string') out.command = args.command;
      if (args.workingDirectory) out.cwd = String(args.workingDirectory);
      const description = body?.description || args.description;
      if (description) out.description = String(description);
      return [out];
    }

    if (ev.subtype === 'completed') {
      const result = body?.result || {};
      const ok = Object.prototype.hasOwnProperty.call(result, 'success');
      return [{
        type: 'tool_complete',
        call_id: callId,
        tool: state.tools.get(callId) || name,
        ok,
        result: capResult(result),
      }];
    }

    return [];
  }

  function translateAssistant(ev) {
    const text = messageText(ev.message);
    if (!text) return [];
    const isDelta = ev.timestamp_ms != null;
    if (isDelta) {
      state.sawDelta = true;
    } else if (state.sawDelta) {
      return []; // whole-text repeat of what was already streamed
    }
    state.text += text;
    return [{ type: 'response', delta: text, text: state.text }];
  }

  function translateResult(ev) {
    const isError = Boolean(ev.is_error) || (ev.subtype && ev.subtype !== 'success');
    const resultText = typeof ev.result === 'string' ? ev.result : '';
    state.result = {
      ok: !isError,
      text: resultText,
      duration_ms: ev.duration_ms,
      usage: ev.usage,
      subtype: ev.subtype,
    };
    const finalText = state.text || resultText;
    state.responseCompleted = true;
    const out = { type: 'response_complete', text: finalText };
    if (isError) out.error = resultText || `cursor-agent reported an error (${ev.subtype || 'unknown'})`;
    return [out];
  }

  return { translate, state };
}

/** `{ readToolCall: {...} }` -> `{ name: 'read', body: {...} }` */
export function toolBody(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return { name: 'tool', body: null };
  for (const [key, value] of Object.entries(toolCall)) {
    if (key.endsWith('ToolCall') && value && typeof value === 'object') {
      return { name: key.slice(0, -'ToolCall'.length) || 'tool', body: value };
    }
  }
  return { name: 'tool', body: null };
}

/** The shell tool carries a full parse tree of the command; keep what a reader needs. */
function compactArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (key === 'parsingResult' || key === 'toolCallId' || key === 'adminCommandDenylist') continue;
    out[key] = value;
  }
  return out;
}

function capResult(result) {
  const raw = JSON.stringify(result);
  if (raw.length <= MAX_TOOL_RESULT_CHARS) return result;
  return { truncated: true, size: raw.length, preview: raw.slice(0, MAX_TOOL_RESULT_CHARS) };
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}
