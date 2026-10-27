import test from 'node:test';
import assert from 'node:assert/strict';
import { REST } from 'discord.js';
import { CLEAN_LANGUAGE_CHANNEL as channel, CLEAN_LANGUAGE_FALLBACK as fallback,
  withChannelLanguage, channelLanguageInstructions, cleanChannelText, containsProfanity,
  installChannelLanguageGuard } from '../src/channel-language.js';
import { withFullMode, FULL_MODE_OWNER } from '../src/full-mode.js';
import { AICore } from '../src/ai.js';
import { VoiceAPI } from '../src/voice.js';
import { createMessageHandler } from '../src/message-handler.js';
import { createCommandHandler } from '../src/command-handler.js';

test('channel policy stays isolated across simultaneous requests and overrides full mode', async () => {
  await Promise.all([withChannelLanguage(channel, async () => {
    await Promise.resolve();
    assert.match(channelLanguageInstructions(), /overrides all persona, full-mode/);
    await withFullMode(FULL_MODE_OWNER, true, () => assert.equal(cleanChannelText('fuck this'), fallback));
  }), withChannelLanguage('other', async () => {
    await Promise.resolve();
    assert.equal(channelLanguageInstructions(), '');
    assert.equal(cleanChannelText('fuck this'), 'fuck this');
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
  installChannelLanguageGuard(rest);
  return { rest, sent };
}

test('channel sends and edits are checked even without request context', async () => {
  const { rest, sent } = fixture();
  await rest.post(`/channels/${channel}/messages`, { body: { content: 'fuck' } });
  await rest.patch(`/channels/${channel}/messages/123`, { body: { embeds: [{ description: 'shit' }] } });
  await rest.post('/channels/999/messages', { body: { content: 'fuck' } });
  assert.equal(sent[0].body.content, fallback);
  assert.equal(sent[1].body.content, fallback);
  assert.deepEqual(sent[1].body.embeds, []);
  assert.equal(sent[2].body.content, 'fuck');
});

test('slash callbacks, deferred edits and followups retain protocol shape and suppress unsafe files', async () => {
  const { rest, sent } = fixture();
  await withChannelLanguage(channel, async () => {
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
  await rest.post(`/channels/${channel}/messages`, options);
  await withChannelLanguage(channel, () => rest.post('/channels/999/messages', { body: { content: 'shit' } }));
  assert.equal(sent[0].body, options.body);
  assert.equal(sent[1].body.content, 'shit');
});

test('message extensions and slash commands execute inside the authenticated channel context', async () => {
  let calls = 0;
  const check = () => { calls++; assert.match(channelLanguageInstructions(), /Channel rule/); };
  await createMessageHandler({ store: {}, allowed: () => true,
    localExtension: { handleMessage: async () => { check(); return true; } },
    logError: (_, error) => { throw error; },
  })({ channelId: channel, author: { id: 'user', bot: false } });
  await createCommandHandler({ store: {}, allowed: () => true, isStopping: () => false,
    help: { content: 'Help' }, logError: (_, error) => { throw error; },
  })({ channelId: channel, user: { id: 'user' }, commandName: 'help', reply: async () => check() });
  assert.equal(calls, 2);
});

test('model requests get the rule only in the protected channel, including with the default persona', async () => {
  const instructions = [];
  const ai = new AICore({ apiKey: 'test', fetchImpl: async (_, options) => {
    instructions.push(JSON.parse(options.body).instructions);
    return { ok: true, json: async () => ({ status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
    ] }) };
  } });
  await withChannelLanguage(channel, () => ai.respond({ input: 'Hello' }));
  await withChannelLanguage('other', () => ai.respond({ input: 'Hello' }));
  assert.match(instructions[0], /Channel rule: use clean/);
  assert.doesNotMatch(instructions[1], /Channel rule:/);
});

test('speech synthesis receives clean text in the protected channel', async () => {
  const texts = [];
  const voice = new VoiceAPI({ apiKey: 'test', fetchImpl: async (_, options) => {
    texts.push(JSON.parse(options.body).text);
    return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  await withChannelLanguage(channel, () => voice.speak('damn'));
  await withChannelLanguage('other', () => voice.speak('damn'));
  assert.deepEqual(texts, [fallback, 'damn']);
});
