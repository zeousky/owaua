import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMemoryCommand, memoryCommand } from '../src/memory-command.js';
import { conversationScope } from '../src/store.js';

const alice = '111111111111111111';
const bob = '222222222222222222';
const scopeA = conversationScope('guild', 'channel', alice);

function interaction(action, values = {}, { userId = alice, guildId = 'guild', channelId = 'channel' } = {}) {
  const replies = [];
  return { user: { id: userId }, guildId, channelId, replies, options: {
    getSubcommand: () => action,
    getString: key => values[key] ?? null,
    getInteger: key => values[key] ?? null,
  }, reply: async payload => { replies.push(payload); } };
}

function memoryStore() {
  const entries = new Map();
  const paused = new Set();
  const counts = new Map();
  const calls = [];
  let id = 0;
  return {
    entries, paused, counts, calls,
    memoryStatus(scope) {
      calls.push(['status', scope]);
      return { paused: paused.has(scope), notes: entries.get(scope)?.length ?? 0, turns: counts.get(scope) ?? 0 };
    },
    listMemories(scope) { calls.push(['list', scope]); return entries.get(scope) ?? []; },
    remember(scope, userId, data) {
      calls.push(['remember', scope, userId, data]);
      if (paused.has(scope)) throw new Error('Memory is paused');
      const notes = entries.get(scope) ?? [];
      const note = notes.find(note => note.key === data.key);
      if (note) Object.assign(note, { text: data.text, updated_at: Date.now() });
      else notes.push({ id: ++id, key: data.key, text: data.text, updated_at: Date.now() });
      entries.set(scope, notes);
      return note ?? notes.at(-1);
    },
    forgetMemory(scope, noteId) {
      calls.push(['forget', scope, noteId]);
      const notes = entries.get(scope) ?? [];
      const index = notes.findIndex(note => note.id === noteId);
      if (index < 0) return false;
      notes.splice(index, 1); return true;
    },
    clearMemory(scope) { calls.push(['clear', scope]); entries.delete(scope); counts.delete(scope); },
    pauseMemory(scope, value) { calls.push(['pause', scope, value]); if (value) paused.add(scope); else paused.delete(scope); },
  };
}

function replyText(event) {
  const payload = event.replies[0];
  return payload.files?.[0]?.attachment.toString() ?? payload.content;
}

test('schema exposes bounded actor-only memory controls', () => {
  assert.deepEqual(memoryCommand.options.map(option => option.name), ['view', 'remember', 'forget', 'clear', 'pause', 'resume']);
  const remember = memoryCommand.options.find(option => option.name === 'remember');
  assert.deepEqual(remember.options.map(option => [option.name, option.max_length]), [['key', 80], ['text', 1000]]);
  assert.ok(remember.options.every(option => option.required && option.min_length === 1));
  const view = memoryCommand.options.find(option => option.name === 'view').options;
  assert.deepEqual(view.map(option => option.name), ['page']);
  assert.equal(view[0].type, 4);
  assert.equal(view[0].required, undefined);
  assert.equal(view[0].min_value, 1);
  assert.equal(view[0].max_value, 10);
  const forget = memoryCommand.options.find(option => option.name === 'forget').options;
  assert.deepEqual(forget.map(option => option.name), ['id']);
  assert.equal(forget[0].type, 4);
  assert.equal(forget[0].min_value, 1);
  for (const option of memoryCommand.options) assert.ok(!(option.options ?? []).some(field => /user|scope|channel|guild|target/i.test(field.name)));
});

test('save and correction use authenticated scope and explicit command provenance', async () => {
  const store = memoryStore();
  const forged = { userId: bob, user: bob, target: bob, scope: 'other', channel: 'other' };
  const first = interaction('remember', { key: 'hosting', text: ' Temporarily on my Mac. ', ...forged });
  await handleMemoryCommand(first, store);
  const second = interaction('remember', { key: 'hosting', text: 'Back on Railway.', ...forged });
  await handleMemoryCommand(second, store);
  assert.deepEqual(store.calls[0], ['remember', scopeA, alice, {
    key: 'hosting', text: 'Temporarily on my Mac.', source: 'command', explicit: true,
  }]);
  assert.equal(store.entries.get(scopeA).length, 1);
  assert.equal(store.entries.get(scopeA)[0].text, 'Back on Railway.');
  assert.match(replyText(second), /Saved memory #1/);
  for (const event of [first, second]) {
    assert.equal(event.replies[0].flags, 64);
    assert.deepEqual(event.replies[0].allowedMentions.parse, []);
  }
});

test('view shows only current actor and channel, dates, and counts privately', async () => {
  const store = memoryStore();
  store.entries.set(scopeA, [{ id: 1, key: 'hosting', text: 'Mac now, Railway later.', updated_at: Date.UTC(2026, 9, 21) }]);
  store.entries.set(conversationScope('guild', 'channel', bob), [{ id: 2, key: 'secret', text: 'Bob private fact', updated_at: Date.now() }]);
  store.entries.set(conversationScope('guild', 'elsewhere', alice), [{ id: 3, key: 'other', text: 'Alice other channel', updated_at: Date.now() }]);
  store.counts.set(scopeA, 42);
  const event = interaction('view', { user: bob, channel: 'elsewhere' });
  await handleMemoryCommand(event, store);
  const text = replyText(event);
  assert.match(text, /Saved facts: 1\. Archived exchanges: 42/);
  assert.match(text, /2026-10-21 UTC/);
  assert.match(text, /Mac now, Railway later/);
  assert.doesNotMatch(text, /Bob private|Alice other/);
  assert.equal(event.replies[0].flags, 64);
});

test('large views are bounded, escaped attachments and show at most 20 facts', async () => {
  const store = memoryStore();
  store.entries.set(scopeA, Array.from({ length: 30 }, (_, index) => ({
    id: index + 1, key: `topic-${index + 1}`, text: '*'.repeat(1000), updated_at: Date.now(),
  })));
  const event = interaction('view');
  await handleMemoryCommand(event, store);
  const text = replyText(event);
  assert.ok(event.replies[0].files?.length);
  assert.ok(text.length <= 30000);
  assert.match(text, /Showing \d+ of 30/);
  assert.equal((text.match(/· updated /g) ?? []).length, 20);
  assert.match(text, /Page 1 of 2/);
  assert.match(text, /facts 1–20/);
  assert.match(text, /\\\*/);
  assert.equal(event.replies[0].flags, 64);
  assert.deepEqual(event.replies[0].allowedMentions.parse, []);
});

test('view pagination exposes every saved fact with accurate ranges and private replies', async () => {
  const store = memoryStore();
  store.entries.set(scopeA, Array.from({ length: 45 }, (_, index) => ({
    id: index + 1, key: `topic-${index + 1}`, text: `Fact ${index + 1}`, updated_at: Date.now(),
  })));
  for (const [page, first, last] of [[1, 1, 20], [2, 21, 40], [3, 41, 45]]) {
    const event = interaction('view', { page, user: bob, channel: 'elsewhere' });
    await handleMemoryCommand(event, store);
    const text = replyText(event);
    const ids = [...text.matchAll(/#(\d+) ·/g)].map(match => Number(match[1]));
    assert.deepEqual(ids, Array.from({ length: last - first + 1 }, (_, index) => first + index));
    assert.ok(text.includes(`Page ${page} of 3.`));
    assert.ok(text.includes(`facts ${first}–${last}`));
    assert.equal(event.replies[0].flags, 64);
    assert.deepEqual(event.replies[0].allowedMentions.parse, []);
  }
  assert.ok(store.calls.every(([, scope]) => scope === scopeA));
});

test('page ten reaches the oldest saved facts while keeping expanded text bounded', async () => {
  const store = memoryStore();
  store.entries.set(scopeA, Array.from({ length: 200 }, (_, index) => ({
    id: index + 1, key: '_'.repeat(80), text: '*'.repeat(1000), updated_at: Date.now(),
  })));
  const event = interaction('view', { page: 10 });
  await handleMemoryCommand(event, store);
  const text = replyText(event);
  assert.match(text, /Page 10 of 10/);
  assert.match(text, /facts 181–200/);
  assert.deepEqual([...text.matchAll(/#(\d+) ·/g)].map(match => Number(match[1])),
    Array.from({ length: 20 }, (_, index) => index + 181));
  assert.ok(text.length <= 30000);
  assert.match(text, /Fact text shortened/);
  assert.equal(event.replies[0].flags, 64);
});

test('invalid and unavailable pages return a generic private reply without listing facts', async () => {
  const store = memoryStore();
  store.entries.set(scopeA, [{ id: 1, key: 'private', text: 'Private fact', updated_at: Date.now() }]);
  for (const page of [0, -1, 1.1, '2', 2, 11, Number.MAX_SAFE_INTEGER + 1]) {
    const event = interaction('view', { page });
    await handleMemoryCommand(event, store);
    assert.equal(replyText(event), 'Choose a valid memory page from /memory view.');
    assert.doesNotMatch(replyText(event), /Private fact/);
    assert.equal(event.replies[0].flags, 64);
  }
  assert.ok(!store.calls.some(([operation]) => operation === 'list'));
});

test('empty memory and interactions without an integer accessor default to page one', async () => {
  const store = memoryStore();
  const event = interaction('view', { page: 1 });
  await handleMemoryCommand(event, store);
  assert.match(replyText(event), /No saved facts/);
  assert.match(replyText(event), /Page 1 of 1\. Showing 0 of 0 saved facts\./);
  const legacy = interaction('view');
  delete legacy.options.getInteger;
  await handleMemoryCommand(legacy, store);
  assert.match(replyText(legacy), /Page 1 of 1/);
  assert.equal(legacy.replies[0].flags, 64);
});

test('forget cannot delete another scope and clear leaves the pause setting intact', async () => {
  const store = memoryStore();
  const scopeB = conversationScope('guild', 'channel', bob);
  store.entries.set(scopeA, [{ id: 1, key: 'hosting', text: 'Mac', updated_at: Date.now() }]);
  store.entries.set(scopeB, [{ id: 2, key: 'hosting', text: 'Railway', updated_at: Date.now() }]);
  const missing = interaction('forget', { id: 2, user: bob });
  await handleMemoryCommand(missing, store);
  assert.match(replyText(missing), /not found/);
  assert.equal(store.entries.get(scopeB).length, 1);
  const forget = interaction('forget', { id: 1 });
  await handleMemoryCommand(forget, store);
  assert.match(replyText(forget), /Earlier conversations may still mention it/);
  store.counts.set(scopeA, 50); store.paused.add(scopeA);
  const clear = interaction('clear');
  await handleMemoryCommand(clear, store);
  assert.equal(store.entries.has(scopeA), false);
  assert.equal(store.counts.has(scopeA), false);
  assert.equal(store.paused.has(scopeA), true);
  assert.equal(store.entries.get(scopeB).length, 1);
  assert.match(replyText(clear), /recent history, archived exchanges, and saved facts/);
  assert.match(replyText(clear), /persona and memory on\/off setting are unchanged/);
});

test('pause, refused save while paused, and resume require no provider', async () => {
  const store = memoryStore();
  const pause = interaction('pause');
  await handleMemoryCommand(pause, store);
  assert.equal(store.paused.has(scopeA), true);
  const save = interaction('remember', { key: 'hosting', text: 'Mac' });
  await handleMemoryCommand(save, store);
  assert.match(replyText(save), /Use \/memory resume/);
  assert.equal(store.entries.has(scopeA), false);
  const view = interaction('view');
  await handleMemoryCommand(view, store);
  assert.match(replyText(view), /paused/);
  const resume = interaction('resume');
  await handleMemoryCommand(resume, store);
  assert.equal(store.paused.has(scopeA), false);
  assert.match(replyText(resume), /back on/);
});

test('active requests block mutations, view remains available, and shutdown blocks all commands', async () => {
  const store = memoryStore();
  for (const action of ['remember', 'forget', 'clear', 'pause', 'resume']) {
    const event = interaction(action, { key: 'hosting', text: 'Mac', id: 1 });
    await handleMemoryCommand(event, store, { isActive: scope => scope === scopeA });
    assert.match(replyText(event), /wait for your current request/);
    assert.equal(event.replies[0].flags, 64);
  }
  assert.deepEqual(store.calls, []);
  const view = interaction('view');
  await handleMemoryCommand(view, store, { isActive: () => true });
  assert.match(replyText(view), /No saved facts/);
  store.calls.length = 0;
  for (const action of ['view', 'remember', 'forget', 'clear', 'pause', 'resume']) {
    const event = interaction(action);
    await handleMemoryCommand(event, store, { stopping: true });
    assert.match(replyText(event), /restarting/);
  }
  assert.deepEqual(store.calls, []);
});

test('invalid arguments and rejected writes never echo input or mutate memory', async () => {
  const store = memoryStore();
  for (const [key, text] of [['', 'fact'], [' ', 'fact'], ['a'.repeat(81), 'fact'], ['hosting', ''], ['hosting', 'a'.repeat(1001)], [1, 'fact']]) {
    const event = interaction('remember', { key, text });
    await handleMemoryCommand(event, store);
    assert.match(replyText(event), /was not changed/);
  }
  for (const id of [0, -1, 1.1, '1', Number.MAX_SAFE_INTEGER + 1, null]) {
    const event = interaction('forget', { id });
    await handleMemoryCommand(event, store);
    assert.match(replyText(event), /valid positive memory ID/);
  }
  assert.deepEqual(store.calls, []);
  store.remember = () => { throw new Error('Rejected super-secret-value'); };
  const event = interaction('remember', { key: 'api-key', text: 'super-secret-value' });
  await handleMemoryCommand(event, store);
  assert.match(replyText(event), /couldn’t save/);
  assert.doesNotMatch(replyText(event), /super-secret-value/);
});

test('DM commands derive a distinct authenticated scope', async () => {
  const store = memoryStore();
  const event = interaction('remember', { key: 'name', text: 'Alice' }, { guildId: null, channelId: 'dm-channel' });
  await handleMemoryCommand(event, store);
  assert.equal(store.calls[0][1], conversationScope(null, 'dm-channel', alice));
  assert.equal(store.entries.has(scopeA), false);
});
