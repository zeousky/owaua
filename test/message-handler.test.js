import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../src/message-handler.js';
import { createCommandHandler } from '../src/command-handler.js';
import { helpCard } from '../src/ui.js';
import { musicHelp } from '../src/music.js';

const botId = '1442127404607737999';
const help = helpCard(musicHelp);

function fixture(content, { guildId = 'server', dmBlocked = false, mentioned = true,
  reference, attachments = new Map(), sendTyping = async () => {}, answerWait } = {}) {
  const publicReplies = [], privateReplies = [], answers = [], errors = [], resets = [];
  const message = { content, guildId, channelId: 'channel', attachments,
    author: { id: 'user', bot: false, send: async payload => {
      if (dmBlocked) throw new Error('DMs disabled');
      privateReplies.push(payload);
    } },
    mentions: { users: new Map(mentioned ? [[botId, {}]] : []) },
    reference: reference ? { messageId: 'previous' } : undefined,
    fetchReference: async () => reference,
    channel: { sendTyping },
    reply: async payload => { publicReplies.push(payload); },
  };
  const deps = { allowed: () => true, isStopping: () => false, help,
    client: { user: { id: botId } }, active: new Set(),
    store: { reset: scope => resets.push(scope) },
    answer: async request => { answers.push(request); await answerWait; await request.send({ content: 'chat answer' }); },
    logError: (...args) => errors.push(args),
  };
  const handler = createMessageHandler({ ...deps, handleCommand: createCommandHandler(deps) });
  return { run: () => handler(message), publicReplies, privateReplies, answers, errors, resets };
}

for (const content of [`<@${botId}>`, `<@!${botId}>   `, '']) {
  test(`empty chat input gives a short reply without the guide: ${JSON.stringify(content)}`, async () => {
    const f = fixture(content, { guildId: content ? 'server' : null });
    await f.run();
    assert.equal(f.publicReplies.length, 1);
    const reply = f.publicReplies[0];
    assert.ok(reply.content.length < 120);
    assert.match(reply.content, /Ask me something/);
    assert.equal(reply.files, undefined);
    assert.deepEqual(reply.allowedMentions, { parse: [], repliedUser: false });
    assert.deepEqual(f.privateReplies, []);
    assert.deepEqual(f.answers, []);
    assert.deepEqual(f.errors, []);
  });
}

for (const content of [`<@${botId}> help`, `<@!${botId}> !HELP`, '.help']) {
  test(`explicit server help stays in DMs: ${content}`, async () => {
    const f = fixture(content);
    await f.run();
    assert.deepEqual(f.publicReplies, []);
    assert.equal(f.privateReplies.length, 1);
    assert.equal(f.privateReplies[0].content, help.content);
    assert.equal(f.privateReplies[0].files[0].name, 'owaua-guide.md');
    assert.equal(f.privateReplies[0].flags, undefined);
    assert.deepEqual(f.errors, []);
  });

  test(`blocked DMs never publish the guide: ${content}`, async () => {
    const f = fixture(content, { dmBlocked: true });
    await f.run();
    assert.equal(f.publicReplies.length, 1);
    assert.match(f.publicReplies[0].content, /Enable DMs or use the slash command/);
    assert.equal(f.publicReplies[0].files, undefined);
    assert.deepEqual(f.privateReplies, []);
    assert.deepEqual(f.errors, []);
  });
}

test('explicit help in DMs still returns the full guide', async () => {
  const f = fixture('help', { guildId: null });
  await f.run();
  assert.equal(f.publicReplies[0].content, help.content);
  assert.equal(f.publicReplies[0].files[0].name, 'owaua-guide.md');
  assert.deepEqual(f.errors, []);
});

test('empty reply to the bot also stays short', async () => {
  const f = fixture('', { mentioned: false,
    reference: { author: { id: botId }, attachments: new Map(), embeds: [] } });
  await f.run();
  assert.equal(f.publicReplies.length, 1);
  assert.ok(f.publicReplies[0].content.length < 120);
  assert.equal(f.publicReplies[0].files, undefined);
  assert.deepEqual(f.errors, []);
});

test('ordinary server messages are ignored', async () => {
  const f = fixture('help', { mentioned: false });
  await f.run();
  assert.deepEqual(f.publicReplies, []);
  assert.deepEqual(f.privateReplies, []);
  assert.deepEqual(f.answers, []);
});

test('a mentioned question continues to the chat answer', async () => {
  const f = fixture(`<@${botId}> What is 2 + 2?`);
  await f.run();
  assert.equal(f.answers[0].text, 'What is 2 + 2?');
  assert.equal(f.publicReplies[0].content, 'chat answer');
  assert.deepEqual(f.errors, []);
});

test('a slow Discord typing request does not delay the answer', async () => {
  let finishTyping;
  const pendingTyping = new Promise(resolve => { finishTyping = resolve; });
  const f = fixture(`<@${botId}> Hello`, { sendTyping: () => pendingTyping });
  const running = f.run();
  await new Promise(setImmediate);
  try {
    assert.equal(f.answers.length, 1);
    assert.equal(f.publicReplies[0]?.content, 'chat answer');
    assert.deepEqual(f.errors, []);
  } finally { finishTyping(); await running; }
});

for (const failure of ['throw', 'reject']) {
  test(`typing ${failure} does not prevent the answer or escape an interval callback`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let calls = 0, finishAnswer;
    const answerWait = new Promise(resolve => { finishAnswer = resolve; });
    const sendTyping = () => {
      calls++;
      if (failure === 'throw') throw new Error('Discord unavailable');
      return Promise.reject(new Error('Discord unavailable'));
    };
    const f = fixture(`<@${botId}> Hello`, { sendTyping, answerWait });
    const running = f.run();
    await new Promise(setImmediate);
    try {
      assert.equal(f.answers.length, 1);
      assert.equal(calls, 1);
      t.mock.timers.tick(8000);
      await new Promise(setImmediate);
      assert.equal(calls, 2);
    } finally { finishAnswer(); await running; }
    assert.equal(f.publicReplies[0]?.content, 'chat answer');
    assert.deepEqual(f.errors, []);
    t.mock.timers.tick(8000);
    assert.equal(calls, 2, 'typing stops after the answer');
  });
}

test('a mention with an attachment still sends it to the answer handler', async () => {
  const file = { name: 'note.txt', contentType: 'text/plain', size: 12,
    url: 'https://cdn.discordapp.com/attachments/1/2/note.txt' };
  const f = fixture(`<@${botId}>`, { attachments: new Map([['file', file]]) });
  await f.run();
  assert.equal(f.answers.length, 1);
  assert.deepEqual(f.answers[0].documents, [file]);
  assert.equal(f.publicReplies[0].content, 'chat answer');
  assert.deepEqual(f.errors, []);
});

test('mentioned reset still clears the conversation', async () => {
  const f = fixture(`<@${botId}> reset`);
  await f.run();
  assert.equal(f.resets.length, 1);
  assert.match(f.publicReplies[0].content, /Fresh start/);
  assert.deepEqual(f.privateReplies, []);
  assert.deepEqual(f.errors, []);
});
