import test from 'node:test';
import assert from 'node:assert/strict';
import { REST, Client, ClientUser, TextChannel, Message } from 'discord.js';
import { CLEAN_LANGUAGE_GUILD as guild, CLEAN_LANGUAGE_FALLBACK as fallback,
  withServerLanguage, serverLanguageInstructions, cleanServerText, containsProfanity,
  installServerLanguageGuard } from '../src/server-language.js';
import { withFullMode, FULL_MODE_OWNER } from '../src/full-mode.js';
import { AICore } from '../src/ai.js';
import { VoiceAPI } from '../src/voice.js';
import { createMessageHandler } from '../src/message-handler.js';
import { createCommandHandler } from '../src/command-handler.js';

test('server policy stays isolated across simultaneous requests and overrides full mode', async () => {
  await Promise.all([withServerLanguage(guild, async () => {
    await Promise.resolve();
    assert.match(serverLanguageInstructions(), /overrides all persona, full-mode/);
    await withFullMode(FULL_MODE_OWNER, true, () => assert.equal(cleanServerText('fuck this'), fallback));
  }), withServerLanguage('other', async () => {
    await Promise.resolve();
    assert.equal(serverLanguageInstructions(), '');
    assert.equal(cleanServerText('fuck this'), 'fuck this');
  })]);
});

test('common profanity and Unicode/Markdown/leet disguises are detected without substring matches', () => {
  for (const text of ['FUCK', 'fucking', 'bullshit', 'bitch', 'asshole', 'damn', 'hell', 'f.u.c.k', 's h i t',
    'f**uck', 'sh1t', 'ＦＵＣＫ', 'f\u200buck', 'kurva', 'bazdmeg', 'fasz']) assert.equal(containsProfanity(text), true, text);
  for (const text of ['Hello there', 'class assignment', 'Scunthorpe', 'Dickens', 'shellfish']) assert.equal(containsProfanity(text), false, text);
});

function fixture() {
  const rest = new REST();
  const sent = [];
  // Exercise discord.js post/patch serialization through the installed request boundary.
  rest.request = async options => { sent.push(options); return {}; };
  installServerLanguageGuard(rest, { guildIdForChannel: async id => ['1551577152393187408', '1550997447017238658', '1551262567857524878', '1564584063207997452'].includes(id) ? guild : null });
  return { rest, sent };
}

test('channel sends and edits are checked even without request context', async () => {
  const { rest, sent } = fixture();
  await rest.post(`/channels/1551577152393187408/messages`, { body: { content: 'fuck' } });
  await rest.patch(`/channels/1551577152393187408/messages/123`, { body: { embeds: [{ description: 'shit' }] } });
  await rest.post('/channels/999/messages', { body: { content: 'fuck' } });
  assert.equal(sent[0].body.content, fallback);
  assert.equal(sent[1].body.content, fallback);
  assert.deepEqual(sent[1].body.embeds, []);
  assert.equal(sent[2].body.content, 'fuck');
});

test('all channels and threads of the target server receive the rule, not a channel matching its server ID', async () => {
  const { rest, sent } = fixture();
  for (const id of ['1551577152393187408', '1550997447017238658', '1551262567857524878', '1564584063207997452']) {
    await withServerLanguage('other', () => rest.post(`/channels/${id}/messages`, { body: { content: "I'll tear that shit apart." } }));
  }
  assert.equal(sent.length, 4);
  for (const options of sent) assert.equal(options.body.content, fallback);
});

test('unresolved destinations fail closed without sending a message', async () => {
  const rest = new REST();
  let sent = 0;
  rest.request = async () => { sent++; };
  installServerLanguageGuard(rest, { guildIdForChannel: async () => { throw new Error('Unavailable'); } });
  await assert.rejects(rest.post('/channels/123/messages', { body: { content: 'shit' } }), /Unavailable/);
  assert.equal(sent, 0);
});

test('real discord.js Message.reply and edit serialize only clean content to HTTP', async t => {
  const client = new Client({ intents: [] });
  client.user = new ClientUser(client, { id: '1442127404607737999', username: 'Owaua', discriminator: '0' });
  t.after(() => client.destroy());
  const channel = new TextChannel(null, { id: '1551577152393187408', guild_id: guild, name: 'test', type: 0 }, client);
  client.channels.cache.set(channel.id, channel);
  const sent = [];
  client.rest.setToken('test');
  client.rest.options.makeRequest = async (_, init) => {
    const body = JSON.parse(init.body); sent.push(body);
    return new Response(JSON.stringify({ id: '1564584063207997453', channel_id: channel.id,
      author: { id: '1442127404607737999', username: 'Owaua', discriminator: '0' }, content: body.content,
      timestamp: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } });
  };
  installServerLanguageGuard(client.rest, { guildIdForChannel: async id => client.channels.cache.get(id)?.guildId ?? null });
  const message = new Message(client, { id: '1564584063207997452', channel_id: channel.id, guild_id: guild,
    author: { id: FULL_MODE_OWNER, username: 'Test', discriminator: '0' }, content: 'get a job', timestamp: new Date().toISOString() });
  const response = await message.reply("I'll tear that shit apart and make it slap.");
  await response.edit('hows ur ass doin tho');
  assert.equal(sent.length, 2);
  for (const body of sent) assert.equal(body.content, fallback);
});

test('slash callbacks, deferred edits and followups retain protocol shape and suppress unsafe files', async () => {
  const { rest, sent } = fixture();
  await withServerLanguage(guild, async () => {
    await rest.post('/interactions/123/token/callback', { body: { type: 4, data: { content: 'shit', flags: 64 } } });
    await rest.post('/interactions/123/token/callback', { body: { type: 5, data: { flags: 64 } } });
    await rest.patch('/webhooks/123/token/messages/@original', { body: { content: 'Your file' }, files: [{ name: 'answer.json', data: Buffer.from('{"answer":"fuck"}') }] });
    await rest.post('/webhooks/123/token', { body: { components: [{ label: 'shit' }] } });
  });
  assert.equal(sent[0].body.type, 4);
  assert.equal(sent[0].body.data.content, fallback);
  assert.equal(sent[0].body.data.flags, 64);
  assert.deepEqual(sent[1].body, { type: 5, data: { flags: 64 } });
  assert.equal(sent[2].body.content, fallback);
  assert.deepEqual(sent[2].files, []);
  assert.equal(sent[3].body.content, fallback);
});

test('safe content passes unchanged and explicit destination takes priority over request context', async () => {
  const { rest, sent } = fixture();
  const options = { body: { content: 'Hello there', embeds: [{ description: 'All good' }] } };
  await rest.post(`/channels/1551577152393187408/messages`, options);
  await withServerLanguage(guild, () => rest.post('/channels/999/messages', { body: { content: 'shit' } }));
  assert.equal(sent[0].body, options.body);
  assert.equal(sent[1].body.content, 'shit');
});

test('message extensions and slash commands execute inside the authenticated channel context', async () => {
  let calls = 0;
  const check = () => { calls++; assert.match(serverLanguageInstructions(), /Server rule/); };
  await createMessageHandler({ store: {}, allowed: () => true,
    localExtension: { handleMessage: async () => { check(); return true; } },
    logError: (_, error) => { throw error; },
  })({ channelId: '1551577152393187408', guildId: guild, author: { id: 'user', bot: false } });
  await createCommandHandler({ store: {}, allowed: () => true, isStopping: () => false,
    help: { content: 'Help' }, logError: (_, error) => { throw error; },
  })({ channelId: '1551577152393187408', guildId: guild, user: { id: 'user' }, commandName: 'help', reply: async () => check() });
  assert.equal(calls, 2);
});

test('model requests get the rule only in the protected server, including with the default persona', async () => {
  const instructions = [];
  const ai = new AICore({ apiKey: 'test', fetchImpl: async (_, options) => {
    instructions.push(JSON.parse(options.body).instructions);
    return { ok: true, json: async () => ({ status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
    ] }) };
  } });
  await withServerLanguage(guild, () => ai.respond({ input: 'Hello' }));
  await withServerLanguage('other', () => ai.respond({ input: 'Hello' }));
  assert.match(instructions[0], /Server rule: use clean/);
  assert.doesNotMatch(instructions[0], /act gen z ish, swear alot/);
  assert.doesNotMatch(instructions[1], /Server rule:/);
  assert.match(instructions[1], /act gen z ish, swear alot/);
});

test('speech synthesis receives clean text in the protected server', async () => {
  const texts = [];
  const voice = new VoiceAPI({ apiKey: 'test', fetchImpl: async (_, options) => {
    texts.push(JSON.parse(options.body).text);
    return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  await withServerLanguage(guild, () => voice.speak('damn'));
  await withServerLanguage('other', () => voice.speak('damn'));
  assert.deepEqual(texts, [fallback, 'damn']);
});
