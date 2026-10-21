import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeCommand, handleKnowledgeCommand } from '../src/knowledge-command.js';
import { KnowledgeError } from '../src/knowledge.js';
import { conversationScope } from '../src/store.js';

const alice = '111111111111111111';
const scope = conversationScope('guild', 'channel', alice);
function event(action, values = {}) {
  const calls = [];
  return { user: { id: alice }, guildId: 'guild', channelId: 'channel', calls,
    options: { getSubcommand: () => action, getInteger: key => values[key], getAttachment: key => values[key] },
    reply: async value => calls.push(['reply', value]), deferReply: async value => calls.push(['defer', value]), editReply: async value => calls.push(['edit', value]) };
}
const text = e => e.calls.at(-1)[1].files?.[0]?.attachment.toString() ?? e.calls.at(-1)[1].content;
function store() {
  const calls = [];
  return { calls, list: selected => { calls.push(['list', selected]); return [{ id: 3, filename: '@everyone*private*.txt', bytes: 1024 }]; },
    isActive: () => false, add: async (selected, file) => { calls.push(['add', selected, file]); return { id: 3, filename: 'guide.txt', bytes: 5 }; },
    forget: async (selected, id) => { calls.push(['forget', selected, id]); return true; }, clear: async selected => { calls.push(['clear', selected]); return { deleted: 2, failed: 0 }; } };
}

test('command schema accepts resolved document attachments and no scope or URL parameters', () => {
  assert.deepEqual(knowledgeCommand.options.map(option => option.name), ['add', 'list', 'forget', 'clear']);
  const options = knowledgeCommand.options.flatMap(option => option.options ?? []);
  assert.deepEqual(options.map(option => option.name), ['file', 'id']);
  assert.equal(options[0].type, 11);
  assert.equal(options[0].required, true);
});

test('list remains private, escapes filenames, hides provider IDs and describes opt-in/scope/privacy', async () => {
  const library = store(), e = event('list');
  await handleKnowledgeCommand(e, library);
  assert.deepEqual(library.calls, [['list', scope]]);
  assert.equal(e.calls[0][1].flags, 64);
  assert.deepEqual(e.calls[0][1].allowedMentions.parse, []);
  assert.match(text(e), /_everyone\\_private\\_\.txt/);
  assert.doesNotMatch(text(e), /@everyone/);
  assert.match(text(e), /library:true/);
  assert.match(text(e), /answers are visible in the channel/);
});

test('mutations derive authenticated scope, defer privately and never accept forged target fields', async () => {
  const library = store(), file = { id: 'resolved-discord-attachment' };
  for (const action of ['add', 'forget', 'clear']) {
    const e = event(action, { file, id: 3, scope: 'forged', user: 'bob' });
    await handleKnowledgeCommand(e, library);
    assert.deepEqual(e.calls[0], ['defer', { flags: 64 }]);
    assert.deepEqual(e.calls.at(-1)[1].allowedMentions.parse, []);
    assert.equal(library.calls.at(-1)[1], scope);
  }
  assert.deepEqual(library.calls[0], ['add', scope, file]);
});

test('active inference or library operations and shutdown block mutations before deferral', async () => {
  for (const action of ['add', 'forget', 'clear']) {
    const library = store(), e = event(action);
    await handleKnowledgeCommand(e, library, { isActive: selected => selected === scope });
    assert.match(text(e), /wait for your current request/);
    assert.equal(e.calls[0][1].flags, 64);
    assert.deepEqual(library.calls, []);
    const e2 = event(action); library.isActive = () => true;
    await handleKnowledgeCommand(e2, library);
    assert.match(text(e2), /wait for your current request/);
  }
  for (const action of ['list', 'add', 'forget', 'clear']) {
    const library = store(), e = event(action);
    await handleKnowledgeCommand(e, library, { stopping: true });
    assert.match(text(e), /restarting/);
    assert.deepEqual(library.calls, []);
  }
});

test('provider failures never echo raw content and partial deletion stays accurately reported', async () => {
  const library = store();
  library.add = async () => { throw new Error('secret provider payload'); };
  const failed = event('add', { file: {} });
  await handleKnowledgeCommand(failed, library);
  assert.match(text(failed), /couldn’t finish/);
  assert.doesNotMatch(text(failed), /secret/);
  library.add = async () => { throw new KnowledgeError('Attach a PDF, text, or code document directly to Discord.'); };
  const invalid = event('add', { file: {} });
  await handleKnowledgeCommand(invalid, library);
  assert.match(text(invalid), /Attach a PDF/);
  library.clear = async () => ({ deleted: 1, failed: 2 });
  const partial = event('clear');
  await handleKnowledgeCommand(partial, library);
  assert.match(text(partial), /Deleted 1 documents\. 2 could not be deleted and remain listed/);
});

test('invalid IDs and absent attachments are rejected without library changes', async () => {
  const library = store();
  for (const id of [0, -1, '3', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const e = event('forget', { id });
    await handleKnowledgeCommand(e, library);
    assert.match(text(e), /valid document ID/);
  }
  const e = event('add');
  await handleKnowledgeCommand(e, library);
  assert.match(text(e), /Attach a PDF/);
  assert.deepEqual(library.calls, []);
});

test('mutation handlers propagate the root shutdown signal to every provider operation', async () => {
  const controller = new AbortController();
  const signals = [];
  const library = store();
  library.add = async (_scope, _attachment, { signal }) => { signals.push(signal); return { id: 1, filename: 'guide.txt', bytes: 5 }; };
  library.forget = async (_scope, _id, { signal }) => { signals.push(signal); return true; };
  library.clear = async (_scope, { signal }) => { signals.push(signal); return { deleted: 1, failed: 0 }; };
  for (const action of ['add', 'forget', 'clear']) await handleKnowledgeCommand(event(action, { file: {}, id: 1 }), library, { signal: controller.signal });
  assert.deepEqual(signals, [controller.signal, controller.signal, controller.signal]);
});
