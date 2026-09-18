import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTranslator, MAX_TOOL_RESULT_CHARS } from '../src/translate.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function replay(file) {
  const t = createTranslator();
  const events = [];
  for (const line of fs.readFileSync(path.join(fixtures, file), 'utf8').split('\n').filter(Boolean)) {
    events.push(...t.translate(JSON.parse(line)));
  }
  return { events, state: t.state };
}

const byType = (events, type) => events.filter((e) => e.type === type);

test('real tool run: the answer is streamed once, never twice', () => {
  const { events, state } = replay('tools-partial.jsonl');
  const final = 'Le fichier `note.txt` contient **2 mots** et **11 octets** (d’après `wc -c`).';
  const responses = byType(events, 'response');
  assert.equal(responses.length, 29, 'one response event per streamed delta, the whole-text repeat dropped');
  assert.equal(responses.map((r) => r.delta).join(''), final);
  assert.equal(responses.at(-1).text, final);
  const done = byType(events, 'response_complete');
  assert.equal(done.length, 1);
  assert.equal(done[0].text, final);
  assert.equal(done[0].error, undefined);
  assert.equal(state.result.ok, true);
  assert.equal(state.sessionId, '8a230f3f-0817-4025-81a1-fe05855b5db4');
});

test('real tool run: tools are named, correlated and reported', () => {
  const { events } = replay('tools-partial.jsonl');
  const started = byType(events, 'tool');
  const completed = byType(events, 'tool_complete');
  assert.deepEqual(started.map((e) => e.tool).sort(), ['read', 'shell']);
  assert.equal(completed.length, 2);
  for (const c of completed) {
    assert.ok(started.some((s) => s.call_id === c.call_id), 'tool_complete matches a started tool');
    assert.equal(c.ok, true);
  }
  const shell = started.find((e) => e.tool === 'shell');
  assert.match(shell.command, /^wc -c /);
  assert.equal(shell.input.parsingResult, undefined, 'the command parse tree is not forwarded');
  const shellDone = completed.find((e) => e.tool === 'shell');
  assert.equal(shellDone.result.success.exitCode, 0);
});

test('real tool run: thinking deltas and their end are forwarded', () => {
  const { events } = replay('tools-partial.jsonl');
  const thinking = byType(events, 'thinking');
  assert.equal(thinking.filter((e) => e.delta).length, 9);
  assert.equal(thinking.filter((e) => e.subtype === 'completed').length, 2);
});

test('real resumed turn keeps the session and answers', () => {
  const { events, state } = replay('resume-ask.jsonl');
  assert.equal(state.sessionId, '8a230f3f-0817-4025-81a1-fe05855b5db4');
  assert.equal(byType(events, 'response_complete')[0].text, '11');
});

test('real shell run without --force still reports the tool', () => {
  const { events } = replay('shell-default-approval.jsonl');
  const shellDone = byType(events, 'tool_complete').find((e) => e.tool === 'shell');
  assert.equal(shellDone.ok, true);
  assert.equal(shellDone.result.success.stdout, '2026\n');
});

test('without partial output, whole-text lines are the answer', () => {
  const t = createTranslator();
  const msg = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const a = t.translate(msg('First.'));
  const b = t.translate(msg(' Second.'));
  assert.equal(a[0].delta, 'First.');
  assert.equal(b[0].text, 'First. Second.');
});

test('an error result says why', () => {
  const t = createTranslator();
  const [done] = t.translate({ type: 'result', subtype: 'error', is_error: true, result: 'quota exhausted' });
  assert.equal(done.type, 'response_complete');
  assert.equal(done.error, 'quota exhausted');
  assert.equal(t.state.result.ok, false);
});

test('an error result with no text still carries an error', () => {
  const t = createTranslator();
  const [done] = t.translate({ type: 'result', subtype: 'error_max_turns', is_error: true });
  assert.match(done.error, /error_max_turns/);
});

test('a huge tool result is truncated, not forwarded whole', () => {
  const t = createTranslator();
  t.translate({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { readToolCall: { args: { path: '/x' } } } });
  const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS * 2);
  const [done] = t.translate({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { readToolCall: { args: {}, result: { success: { content: big } } } } });
  assert.equal(done.tool, 'read');
  assert.equal(done.result.truncated, true);
  assert.equal(done.result.preview.length, MAX_TOOL_RESULT_CHARS);
});

test('a failed tool is reported as not ok', () => {
  const t = createTranslator();
  const [done] = t.translate({ type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: { shellToolCall: { args: {}, result: { rejected: { reason: 'denied' } } } } });
  assert.equal(done.ok, false);
  assert.equal(done.tool, 'shell');
});

test('unknown and malformed lines produce nothing', () => {
  const t = createTranslator();
  assert.deepEqual(t.translate({ type: 'something_new' }), []);
  assert.deepEqual(t.translate(null), []);
  assert.deepEqual(t.translate({ type: 'tool_call', subtype: 'started', tool_call: {} })[0].tool, 'tool');
});
